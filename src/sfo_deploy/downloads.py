"""sfo-deploy package download providers and temporary artifact ownership."""

from __future__ import annotations

import hashlib
import hmac
import http.client
import math
import os
import re
import socket
import ssl
import stat
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Protocol, runtime_checkable
from urllib.parse import SplitResult, urljoin, urlsplit

from .errors import DownloadError
from .models import PackageSpec


DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_READ_TIMEOUT = 30.0
DEFAULT_MAX_REDIRECTS = 5
DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
DEFAULT_CHUNK_SIZE = 64 * 1024

_PROVIDER_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]*$")
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_ALLOWED_SCHEMES = frozenset({"http", "https"})


@dataclass(frozen=True)
class DownloadRequest:
    """A provider request with framework-owned integrity and resource limits."""

    source: Mapping[str, Any]
    hash_algorithm: str
    expected_hash: str
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT
    read_timeout: float = DEFAULT_READ_TIMEOUT
    max_redirects: int = DEFAULT_MAX_REDIRECTS
    max_bytes: int = DEFAULT_MAX_BYTES
    chunk_size: int = DEFAULT_CHUNK_SIZE

    def __post_init__(self) -> None:
        object.__setattr__(self, "source", MappingProxyType(dict(self.source)))

    @classmethod
    def from_package(cls, package: PackageSpec, **limits: Any) -> DownloadRequest:
        return cls(
            source=package.source,
            hash_algorithm=package.hash_algorithm,
            expected_hash=package.hash_value,
            **limits,
        )


@dataclass
class VerifiedArtifact:
    """A verified local artifact whose lifetime is bounded by a context manager."""

    path: Path
    hash_algorithm: str
    hash_value: str
    size: int
    _cleaned: bool = field(default=False, init=False, repr=False)

    def __enter__(self) -> VerifiedArtifact:
        if self._cleaned or not self.path.is_file():
            raise DownloadError(f"已验证工件不再可用: {self.path}")
        return self

    def __exit__(self, exc_type: object, exc: BaseException | None, traceback: object) -> bool:
        try:
            self.cleanup()
        except DownloadError as cleanup_error:
            if exc is None:
                raise
            exc.add_note(str(cleanup_error))
        return False

    def cleanup(self) -> None:
        """Delete the artifact. Repeated cleanup is safe."""

        if self._cleaned:
            return
        try:
            self.path.unlink(missing_ok=True)
        except OSError as exc:
            raise DownloadError(f"无法清理已验证工件 {self.path}: {exc}") from exc
        self._cleaned = True


@runtime_checkable
class DownloadProvider(Protocol):
    """Extension boundary implemented by package source providers."""

    def fetch(self, request: DownloadRequest, destination: Path) -> VerifiedArtifact:
        """Fetch and verify an artifact at ``destination``."""


class HttpDownloadProvider:
    """Bounded streaming downloader for direct HTTP and HTTPS URLs."""

    def fetch(self, request: DownloadRequest, destination: Path) -> VerifiedArtifact:
        digest = _validate_request(request)
        url = _source_url(request.source)
        destination = Path(destination)
        parent = destination.parent
        if not parent.is_dir():
            raise DownloadError(f"下载目标目录不存在: {parent}")
        if destination.exists():
            raise DownloadError(f"下载目标已存在，拒绝覆盖: {destination}")

        temporary_path: Path | None = None
        try:
            handle, temporary_name = tempfile.mkstemp(
                dir=parent,
                prefix=f".{destination.name}.",
                suffix=".part",
            )
            os.close(handle)
            temporary_path = Path(temporary_name)
            size = self._stream(url, request, temporary_path, digest)
            actual_hash = digest.hexdigest().lower()
            if not _constant_time_equal(actual_hash, request.expected_hash.lower()):
                raise DownloadError(
                    f"下载工件哈希不匹配: expected={request.expected_hash.lower()} actual={actual_hash}"
                )
            os.replace(temporary_path, destination)
            temporary_path = None
            return VerifiedArtifact(
                path=destination,
                hash_algorithm=request.hash_algorithm.lower(),
                hash_value=actual_hash,
                size=size,
            )
        except DownloadError as exc:
            _cleanup_after_failure(temporary_path, exc)
            raise
        except (OSError, ValueError, http.client.HTTPException, ssl.SSLError) as exc:
            error = DownloadError(f"下载失败: {exc}")
            _cleanup_after_failure(temporary_path, error)
            raise error from exc
        except BaseException as exc:
            _cleanup_after_failure(temporary_path, exc)
            raise

    def _stream(
        self,
        initial_url: str,
        request: DownloadRequest,
        destination: Path,
        digest: Any,
    ) -> int:
        current_url = initial_url
        redirects = 0

        while True:
            parsed = _parse_http_url(current_url)
            connection = _connection(parsed, request.connect_timeout)
            response: http.client.HTTPResponse | None = None
            try:
                connection.connect()
                if connection.sock is None:
                    raise DownloadError("HTTP 连接未建立套接字")
                connection.sock.settimeout(request.read_timeout)
                connection.request(
                    "GET",
                    _request_target(parsed),
                    headers={
                        "Accept-Encoding": "identity",
                        "User-Agent": "sfo-deploy/0.1",
                    },
                )
                response = connection.getresponse()

                if response.status in _REDIRECT_STATUSES:
                    location = response.getheader("Location")
                    if not location:
                        raise DownloadError(f"HTTP {response.status} 重定向缺少 Location")
                    if redirects >= request.max_redirects:
                        raise DownloadError(f"HTTP 重定向超过限制 {request.max_redirects}")
                    current_url = urljoin(current_url, location)
                    _parse_http_url(current_url)
                    redirects += 1
                    continue

                if not 200 <= response.status < 300:
                    raise DownloadError(f"HTTP 下载失败: status={response.status} reason={response.reason}")

                content_length = _content_length(response)
                if content_length is not None and content_length > request.max_bytes:
                    raise DownloadError(
                        f"下载工件超过最大字节数: declared={content_length} max={request.max_bytes}"
                    )
                return _copy_response(response, destination, request, digest)
            except (socket.timeout, TimeoutError) as exc:
                raise DownloadError("HTTP 下载超时") from exc
            except (OSError, http.client.HTTPException, ssl.SSLError) as exc:
                raise DownloadError(f"HTTP 下载失败: {exc}") from exc
            finally:
                if response is not None:
                    response.close()
                connection.close()


# Keep the conventional acronym spelling available to callers without a second type.
HTTPDownloadProvider = HttpDownloadProvider


class DownloadProviderRegistry:
    """An instance-local provider registry with replaceable built-ins."""

    def __init__(self, providers: Mapping[str, DownloadProvider] | None = None) -> None:
        http_provider = HttpDownloadProvider()
        self._providers: dict[str, DownloadProvider] = {
            "http": http_provider,
            "https": http_provider,
        }
        for name, provider in (providers or {}).items():
            self.register(name, provider, replace=True)

    @property
    def providers(self) -> Mapping[str, DownloadProvider]:
        return MappingProxyType(dict(self._providers))

    def register(self, name: str, provider: DownloadProvider, *, replace: bool = False) -> None:
        normalized = _provider_name(name)
        if not isinstance(provider, DownloadProvider):
            raise TypeError("下载提供方必须实现 fetch(request, destination)")
        if normalized in self._providers and not replace:
            raise DownloadError(f"下载提供方已经注册: {normalized}")
        self._providers[normalized] = provider

    def resolve(self, name: str) -> DownloadProvider:
        normalized = _provider_name(name)
        try:
            return self._providers[normalized]
        except KeyError as exc:
            raise DownloadError(f"未知下载提供方: {normalized}") from exc

    def fetch(
        self,
        provider_name: str,
        request: DownloadRequest,
        destination: Path,
    ) -> VerifiedArtifact:
        """Fetch through a provider, then independently enforce the hash contract."""

        _validate_request(request)
        destination = Path(destination)
        if destination.exists():
            raise DownloadError(f"下载目标已存在，拒绝覆盖: {destination}")
        provider = self.resolve(provider_name)
        artifact = provider.fetch(request, destination)
        if not isinstance(artifact, VerifiedArtifact):
            _cleanup_unexpected_destination(destination)
            raise DownloadError("下载提供方没有返回 VerifiedArtifact")
        try:
            _verify_artifact(artifact, request)
        except BaseException as exc:
            try:
                artifact.cleanup()
            except DownloadError as cleanup_error:
                exc.add_note(str(cleanup_error))
            raise
        return artifact

    def fetch_package(
        self,
        package: PackageSpec,
        destination: Path,
        **limits: Any,
    ) -> VerifiedArtifact:
        return self.fetch(
            package.provider,
            DownloadRequest.from_package(package, **limits),
            destination,
        )


def _provider_name(name: str) -> str:
    if not isinstance(name, str) or not _PROVIDER_NAME_RE.fullmatch(name):
        raise DownloadError(f"下载提供方名称不合法: {name!r}")
    return name.lower()


def _validate_request(request: DownloadRequest) -> Any:
    if not isinstance(request.source, Mapping):
        raise DownloadError("下载 source 必须是映射")
    algorithm = request.hash_algorithm.lower()
    if not algorithm or algorithm.startswith("shake"):
        raise DownloadError(f"不支持的哈希算法: {request.hash_algorithm!r}")
    try:
        digest = hashlib.new(algorithm)
    except (TypeError, ValueError) as exc:
        raise DownloadError(f"不支持的哈希算法: {request.hash_algorithm!r}") from exc
    expected_hash = request.expected_hash.lower()
    if (
        len(expected_hash) != digest.digest_size * 2
        or any(character not in "0123456789abcdef" for character in expected_hash)
    ):
        raise DownloadError("预期哈希缺失或格式不合法")
    _positive_number(request.connect_timeout, "connect_timeout")
    _positive_number(request.read_timeout, "read_timeout")
    _positive_integer(request.max_bytes, "max_bytes")
    _positive_integer(request.chunk_size, "chunk_size")
    if isinstance(request.max_redirects, bool) or not isinstance(request.max_redirects, int):
        raise DownloadError("max_redirects 必须是非负整数")
    if request.max_redirects < 0:
        raise DownloadError("max_redirects 必须是非负整数")
    return digest


def _positive_number(value: object, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DownloadError(f"{label} 必须是正数")
    if not math.isfinite(float(value)) or value <= 0:
        raise DownloadError(f"{label} 必须是有限正数")


def _positive_integer(value: object, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise DownloadError(f"{label} 必须是正整数")


def _source_url(source: Mapping[str, Any]) -> str:
    unknown = sorted(set(source) - {"url"})
    if unknown:
        raise DownloadError(f"HTTP 下载 source 包含未知字段: {', '.join(unknown)}")
    url = source.get("url")
    if not isinstance(url, str) or not url.strip():
        raise DownloadError("HTTP 下载 source.url 必须是非空字符串")
    normalized = url.strip()
    _parse_http_url(normalized)
    return normalized


def _parse_http_url(url: str) -> SplitResult:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise DownloadError(f"HTTP URL 不合法: {url!r}") from exc
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        raise DownloadError(f"仅允许 http/https URL: {url!r}")
    if not parsed.hostname:
        raise DownloadError(f"HTTP URL 缺少主机名: {url!r}")
    if parsed.username is not None or parsed.password is not None:
        raise DownloadError("HTTP URL 不允许包含用户凭据")
    if port is not None and not 1 <= port <= 65535:
        raise DownloadError(f"HTTP URL 端口不合法: {url!r}")
    return parsed


def _connection(parsed: SplitResult, timeout: float) -> http.client.HTTPConnection:
    connection_type = http.client.HTTPSConnection if parsed.scheme.lower() == "https" else http.client.HTTPConnection
    return connection_type(parsed.hostname, parsed.port, timeout=float(timeout))


def _request_target(parsed: SplitResult) -> str:
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    return target


def _content_length(response: http.client.HTTPResponse) -> int | None:
    value = response.getheader("Content-Length")
    if value is None:
        return None
    try:
        length = int(value, 10)
    except ValueError as exc:
        raise DownloadError(f"HTTP Content-Length 不合法: {value!r}") from exc
    if length < 0:
        raise DownloadError(f"HTTP Content-Length 不合法: {value!r}")
    return length


def _copy_response(
    response: http.client.HTTPResponse,
    destination: Path,
    request: DownloadRequest,
    digest: Any,
) -> int:
    size = 0
    with destination.open("wb") as output:
        while True:
            chunk = response.read(request.chunk_size)
            if not chunk:
                break
            size += len(chunk)
            if size > request.max_bytes:
                raise DownloadError(
                    f"下载工件超过最大字节数: received={size} max={request.max_bytes}"
                )
            output.write(chunk)
            digest.update(chunk)
    return size


def _verify_artifact(artifact: VerifiedArtifact, request: DownloadRequest) -> None:
    path = Path(artifact.path)
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise DownloadError(f"下载提供方返回的工件不可读: {path}") from exc
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise DownloadError(f"下载提供方返回的工件不是普通文件: {path}")
    if metadata.st_size > request.max_bytes:
        raise DownloadError(
            f"下载工件超过最大字节数: received={metadata.st_size} max={request.max_bytes}"
        )
    digest = hashlib.new(request.hash_algorithm.lower())
    size = 0
    try:
        with path.open("rb") as source:
            while True:
                chunk = source.read(request.chunk_size)
                if not chunk:
                    break
                size += len(chunk)
                if size > request.max_bytes:
                    raise DownloadError(
                        f"下载工件超过最大字节数: received={size} max={request.max_bytes}"
                    )
                digest.update(chunk)
    except OSError as exc:
        raise DownloadError(f"无法校验下载工件 {path}: {exc}") from exc
    actual_hash = digest.hexdigest().lower()
    if not _constant_time_equal(actual_hash, request.expected_hash.lower()):
        raise DownloadError(
            f"下载工件哈希不匹配: expected={request.expected_hash.lower()} actual={actual_hash}"
        )
    artifact.hash_algorithm = request.hash_algorithm.lower()
    artifact.hash_value = actual_hash
    artifact.size = size


def _constant_time_equal(left: str, right: str) -> bool:
    return len(left) == len(right) and hmac.compare_digest(left, right)


def _cleanup_after_failure(path: Path | None, primary: BaseException) -> None:
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError as cleanup_error:
        primary.add_note(f"临时下载文件清理失败 {path}: {cleanup_error}")


def _cleanup_unexpected_destination(destination: Path) -> None:
    try:
        if destination.is_file() and not destination.is_symlink():
            destination.unlink()
    except OSError:
        pass


__all__ = [
    "DEFAULT_CHUNK_SIZE",
    "DEFAULT_CONNECT_TIMEOUT",
    "DEFAULT_MAX_BYTES",
    "DEFAULT_MAX_REDIRECTS",
    "DEFAULT_READ_TIMEOUT",
    "DownloadProvider",
    "DownloadProviderRegistry",
    "DownloadRequest",
    "HTTPDownloadProvider",
    "HttpDownloadProvider",
    "VerifiedArtifact",
]
