"""sfo-deploy 项目提供的敏感输入绑定与文件私钥投递准备。"""

from __future__ import annotations

import inspect
import os
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import TypeAlias

from .errors import ConfigurationError, PreflightError
from .models import FileSecretTarget

SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
ACCOUNT_NAME_RE = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_.-]*|[0-9]+)$")

ConfigSecretProvider: TypeAlias = str | Callable[[], str]


def validate_secret_name(name: str) -> str:
    """返回合法的公开秘密名称，否则失败关闭。"""

    if not isinstance(name, str) or not SECRET_NAME_RE.fullmatch(name):
        raise ConfigurationError(f"敏感输入名称不合法: {name!r}")
    return name


def _validate_provider(name: str, provider: object) -> ConfigSecretProvider:
    if isinstance(provider, str):
        return provider
    if not callable(provider):
        raise ConfigurationError(f"配置密钥 {name} 必须是字符串或零参数函数")
    try:
        inspect.signature(provider).bind()
    except (TypeError, ValueError) as error:
        raise ConfigurationError(f"配置密钥 {name} 的延迟函数必须可用零参数调用") from error
    return provider


@dataclass(frozen=True, init=False)
class ProjectBindings:
    """一个项目实例拥有的隔离绑定；构造时复制，之后只读。"""

    file_secrets: Mapping[str, Path]
    config_secrets: Mapping[str, ConfigSecretProvider]

    def __init__(
        self,
        *,
        file_secrets: Mapping[str, Path] | None = None,
        config_secrets: Mapping[str, ConfigSecretProvider] | None = None,
    ) -> None:
        file_values: dict[str, Path] = {}
        for raw_name, raw_path in (file_secrets or {}).items():
            name = validate_secret_name(raw_name)
            if not isinstance(raw_path, Path):
                raise ConfigurationError(f"文件私钥 {name} 的来源必须是 pathlib.Path")
            file_values[name] = raw_path.expanduser()

        config_values: dict[str, ConfigSecretProvider] = {}
        for raw_name, provider in (config_secrets or {}).items():
            name = validate_secret_name(raw_name)
            config_values[name] = _validate_provider(name, provider)

        object.__setattr__(self, "file_secrets", MappingProxyType(file_values))
        object.__setattr__(self, "config_secrets", MappingProxyType(config_values))

    def select_config_secrets(self, names: Iterable[str]) -> Mapping[str, str]:
        """只解析并返回当前脚本显式声明的配置密钥。"""

        selected: dict[str, str] = {}
        for raw_name in names:
            name = validate_secret_name(raw_name)
            if name in selected:
                raise ConfigurationError(f"配置密钥选择包含重复名称: {name}")
            try:
                provider = self.config_secrets[name]
            except KeyError as error:
                raise PreflightError(f"项目未绑定配置密钥: {name}") from error
            try:
                value = provider() if callable(provider) else provider
            except Exception as error:
                raise PreflightError(f"读取配置密钥 {name} 失败") from error
            if not isinstance(value, str) or not value:
                raise PreflightError(f"配置密钥 {name} 必须解析为非空字符串")
            selected[name] = value
        return MappingProxyType(selected)

    def resolve_file_secret(self, raw_name: str) -> Path:
        """解析一个已绑定且当前可读取的本地文件私钥。"""

        name = validate_secret_name(raw_name)
        try:
            source = self.file_secrets[name]
        except KeyError as error:
            raise PreflightError(f"项目未绑定文件私钥: {name}") from error
        try:
            resolved = source.resolve(strict=True)
        except OSError as error:
            raise PreflightError(f"文件私钥 {name} 的来源不存在或不可访问") from error
        if not resolved.is_file() or not os.access(resolved, os.R_OK):
            raise PreflightError(f"文件私钥 {name} 的来源不是可读普通文件")
        return resolved


@dataclass(frozen=True)
class FileSecretDeployment:
    """供执行器交给传输层的无内容投递描述。"""

    name: str
    source: Path
    destination: PurePosixPath
    mode: int
    owner: str | None
    group: str | None
    overwrite: bool


def _safe_remote_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        raise PreflightError(f"文件私钥目标路径不合法: {value!r}")
    path = PurePosixPath(value)
    if not path.is_absolute() or path == PurePosixPath("/") or ".." in path.parts:
        raise PreflightError(f"文件私钥目标必须是安全绝对路径: {value!r}")
    if str(path) != value:
        raise PreflightError(f"文件私钥目标路径必须使用规范 POSIX 形式: {value!r}")
    return path


def _safe_mode(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 0o777:
        raise PreflightError(f"文件私钥 mode 不合法: {value!r}")
    if value & 0o077:
        raise PreflightError(f"文件私钥 mode 不得授予 group/other 权限: {value:04o}")
    return value


def _safe_account(value: str | None, label: str) -> str | None:
    if value is not None and (not isinstance(value, str) or not ACCOUNT_NAME_RE.fullmatch(value)):
        raise PreflightError(f"文件私钥 {label} 不合法: {value!r}")
    return value


def prepare_file_secret_deployments(
    targets: Iterable[FileSecretTarget], bindings: ProjectBindings
) -> tuple[FileSecretDeployment, ...]:
    """在任何远端副作用前校验来源和目标并生成稳定投递序列。"""

    deployments: list[FileSecretDeployment] = []
    destinations: set[PurePosixPath] = set()
    for target in targets:
        name = validate_secret_name(target.name)
        destination = _safe_remote_path(target.path)
        if destination in destinations:
            raise PreflightError(f"文件私钥目标路径重复: {destination}")
        destinations.add(destination)
        if not isinstance(target.overwrite, bool):
            raise PreflightError(f"文件私钥 {name} 的 overwrite 必须是布尔值")
        deployments.append(
            FileSecretDeployment(
                name=name,
                source=bindings.resolve_file_secret(name),
                destination=destination,
                mode=_safe_mode(target.mode),
                owner=_safe_account(target.owner, "owner"),
                group=_safe_account(target.group, "group"),
                overwrite=target.overwrite,
            )
        )
    return tuple(deployments)


class Redactor:
    """对已解析秘密执行最长优先的纯文本脱敏。"""

    def __init__(self, values: Iterable[str] = ()) -> None:
        unique: set[str] = set()
        for value in values:
            if not isinstance(value, str):
                raise TypeError("脱敏值必须是字符串")
            if value:
                unique.add(value)
        self._values = tuple(sorted(unique, key=lambda item: (-len(item), item)))

    @classmethod
    def from_mapping(cls, values: Mapping[str, str]) -> "Redactor":
        return cls(values.values())

    def redact(self, text: str) -> str:
        if not isinstance(text, str):
            raise TypeError("待脱敏内容必须是字符串")
        for value in self._values:
            text = text.replace(value, "[REDACTED]")
        return text
