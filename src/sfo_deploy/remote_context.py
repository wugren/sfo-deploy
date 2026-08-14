"""sfo-deploy 权限受限的脚本上下文文件与远端脚本读取 API。"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from types import MappingProxyType
from typing import Any

from .errors import ConfigurationError, PreflightError
from .secrets import validate_secret_name

CONTEXT_SCHEMA_VERSION = 1
CONTEXT_ENVIRONMENT_VARIABLE = "DEPLOYMENT_CONTEXT_PATH"
_CONTEXT_FIELDS = {"schema_version", "metadata", "config_secrets"}
_TEMPLATE_NAME = re.compile(r"[A-Z][A-Z0-9_]*")


def _json_mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ConfigurationError(f"{label} 必须是字符串键对象")
    return value


def _freeze_json(value: Any) -> Any:
    """递归冻结上下文元数据，避免脚本意外修改共享视图。"""

    if isinstance(value, dict):
        return MappingProxyType({key: _freeze_json(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze_json(item) for item in value)
    return value


def _context_payload(
    config_secrets: Mapping[str, str], metadata: Mapping[str, Any] | None
) -> dict[str, Any]:
    selected: dict[str, str] = {}
    for raw_name, value in config_secrets.items():
        name = validate_secret_name(raw_name)
        if not isinstance(value, str) or not value:
            raise PreflightError(f"配置密钥 {name} 必须是非空字符串")
        selected[name] = value
    ordinary = dict(metadata or {})
    if any(not isinstance(key, str) for key in ordinary):
        raise ConfigurationError("远端上下文 metadata 必须使用字符串键")
    try:
        json.dumps(ordinary, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ConfigurationError("远端上下文 metadata 必须可安全序列化为 JSON") from error
    return {
        "schema_version": CONTEXT_SCHEMA_VERSION,
        "metadata": ordinary,
        "config_secrets": selected,
    }


@contextmanager
def temporary_context_file(
    config_secrets: Mapping[str, str],
    *,
    metadata: Mapping[str, Any] | None = None,
    directory: Path | None = None,
) -> Iterator[Path]:
    """创建 mode 0600 的 v1 JSON，上下文退出时尽力删除。"""

    payload = _context_payload(config_secrets, metadata)
    try:
        parent = None if directory is None else directory.resolve(strict=True)
    except OSError as error:
        raise PreflightError(f"临时上下文目录不存在或不可访问: {directory}") from error
    if parent is not None and not parent.is_dir():
        raise PreflightError(f"临时上下文目录不是目录: {parent}")
    descriptor, raw_path = tempfile.mkstemp(prefix="deployment-context-", suffix=".json", dir=parent)
    path = Path(raw_path)
    try:
        os.chmod(path, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            descriptor = -1
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        yield path
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # 执行器负责把清理失败附加到主结果；此处不能遮蔽脚本主异常。
            pass


class DeploymentContext:
    """项目 Python 配置脚本读取最小配置密钥上下文的稳定接口。"""

    def __init__(self, *, config_secrets: Mapping[str, str], metadata: Mapping[str, Any]) -> None:
        self._config_secrets = MappingProxyType(dict(config_secrets))
        self._metadata = _freeze_json(dict(metadata))

    @classmethod
    def from_path(cls, path: Path) -> "DeploymentContext":
        try:
            with path.open("r", encoding="utf-8") as stream:
                raw = json.load(stream)
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ConfigurationError(f"无法读取部署上下文: {path}") from error
        data = _json_mapping(raw, "部署上下文")
        unknown = sorted(set(data) - _CONTEXT_FIELDS)
        missing = sorted(_CONTEXT_FIELDS - set(data))
        if unknown or missing:
            details = []
            if unknown:
                details.append(f"未知字段 {', '.join(unknown)}")
            if missing:
                details.append(f"缺少字段 {', '.join(missing)}")
            raise ConfigurationError(f"部署上下文结构不合法: {'; '.join(details)}")
        if data["schema_version"] != CONTEXT_SCHEMA_VERSION:
            raise ConfigurationError(f"不支持的部署上下文版本: {data['schema_version']!r}")
        metadata = _json_mapping(data["metadata"], "部署上下文 metadata")
        raw_secrets = _json_mapping(data["config_secrets"], "部署上下文 config_secrets")
        secrets: dict[str, str] = {}
        for raw_name, value in raw_secrets.items():
            name = validate_secret_name(raw_name)
            if not isinstance(value, str) or not value:
                raise ConfigurationError(f"部署上下文配置密钥 {name} 必须是非空字符串")
            secrets[name] = value
        return cls(config_secrets=secrets, metadata=metadata)

    @classmethod
    def from_environment(cls) -> "DeploymentContext":
        raw_path = os.environ.get(CONTEXT_ENVIRONMENT_VARIABLE)
        if not raw_path:
            raise ConfigurationError(f"缺少环境变量 {CONTEXT_ENVIRONMENT_VARIABLE}")
        return cls.from_path(Path(raw_path))

    @property
    def metadata(self) -> Mapping[str, Any]:
        return self._metadata

    def config_secret(self, name: str) -> str:
        name = validate_secret_name(name)
        try:
            return self._config_secrets[name]
        except KeyError as error:
            raise ConfigurationError(f"当前脚本未声明或未收到配置密钥: {name}") from error

    def render(self, template: str) -> str:
        """仅替换 $NAME、${NAME} 和 $$；拒绝所有其他 `$` 表达式。"""

        if not isinstance(template, str):
            raise TypeError("模板必须是字符串")
        output: list[str] = []
        index = 0
        while index < len(template):
            if template[index] != "$":
                output.append(template[index])
                index += 1
                continue
            if index + 1 >= len(template):
                raise ConfigurationError("模板包含不完整的 `$` 占位符")
            following = template[index + 1]
            if following == "$":
                output.append("$")
                index += 2
                continue
            if following == "{":
                end = template.find("}", index + 2)
                if end < 0:
                    raise ConfigurationError("模板包含未闭合的配置密钥占位符")
                name = template[index + 2 : end]
                if not _TEMPLATE_NAME.fullmatch(name):
                    raise ConfigurationError(f"模板配置密钥占位符不合法: {name!r}")
                index = end + 1
            else:
                match = _TEMPLATE_NAME.match(template, index + 1)
                if match is None:
                    raise ConfigurationError(f"模板包含不支持的 `$` 表达式，位置: {index}")
                name = match.group(0)
                index = match.end()
            output.append(self.config_secret(name))
        return "".join(output)

    def render_template(self, source: Path, destination: Path) -> None:
        """读取 UTF-8 模板并以同目录临时文件原子生成 mode 0600 配置。"""

        try:
            template = source.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise ConfigurationError(f"无法读取配置模板: {source}") from error
        rendered = self.render(template)
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, raw_path = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
        temporary = Path(raw_path)
        try:
            os.chmod(temporary, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
                descriptor = -1
                stream.write(rendered)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        except OSError as error:
            raise PreflightError(f"无法生成应用配置: {destination}") from error
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
