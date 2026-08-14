"""上传到远端工作区的 sfo-deploy 零依赖 DeploymentContext 运行时。"""

from __future__ import annotations

from pathlib import Path


REMOTE_RUNTIME_SOURCE = r'''"""sfo-deploy 远端脚本运行时；仅依赖 Python 标准库。"""
import json
import os
import re
import tempfile
from pathlib import Path
from types import MappingProxyType

CONTEXT_SCHEMA_VERSION = 1
CONTEXT_ENVIRONMENT_VARIABLE = "DEPLOYMENT_CONTEXT_PATH"
_CONTEXT_FIELDS = {"schema_version", "metadata", "config_secrets"}
_SECRET_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
_TEMPLATE_NAME = re.compile(r"[A-Z][A-Z0-9_]*")

class ConfigurationError(Exception):
    pass

def _mapping(value, label):
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ConfigurationError(f"{label} 必须是字符串键对象")
    return value

def _secret_name(name):
    if not isinstance(name, str) or not _SECRET_NAME.fullmatch(name):
        raise ConfigurationError(f"敏感输入名称不合法: {name!r}")
    return name

class DeploymentContext:
    def __init__(self, *, config_secrets, metadata):
        self._config_secrets = MappingProxyType(dict(config_secrets))
        self._metadata = MappingProxyType(dict(metadata))

    @classmethod
    def from_path(cls, path):
        try:
            with Path(path).open("r", encoding="utf-8") as stream:
                raw = json.load(stream)
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ConfigurationError(f"无法读取部署上下文: {path}") from error
        data = _mapping(raw, "部署上下文")
        if set(data) != _CONTEXT_FIELDS:
            raise ConfigurationError("部署上下文结构不合法")
        if data["schema_version"] != CONTEXT_SCHEMA_VERSION:
            raise ConfigurationError(f"不支持的部署上下文版本: {data['schema_version']!r}")
        metadata = _mapping(data["metadata"], "部署上下文 metadata")
        raw_secrets = _mapping(data["config_secrets"], "部署上下文 config_secrets")
        secrets = {}
        for raw_name, value in raw_secrets.items():
            name = _secret_name(raw_name)
            if not isinstance(value, str) or not value:
                raise ConfigurationError(f"部署上下文配置密钥 {name} 必须是非空字符串")
            secrets[name] = value
        return cls(config_secrets=secrets, metadata=metadata)

    @classmethod
    def from_environment(cls):
        raw_path = os.environ.get(CONTEXT_ENVIRONMENT_VARIABLE)
        if not raw_path:
            raise ConfigurationError(f"缺少环境变量 {CONTEXT_ENVIRONMENT_VARIABLE}")
        return cls.from_path(Path(raw_path))

    @property
    def metadata(self):
        return self._metadata

    def config_secret(self, name):
        name = _secret_name(name)
        try:
            return self._config_secrets[name]
        except KeyError as error:
            raise ConfigurationError(f"当前脚本未声明或未收到配置密钥: {name}") from error

    def render(self, template):
        if not isinstance(template, str):
            raise TypeError("模板必须是字符串")
        output = []
        index = 0
        while index < len(template):
            if template[index] != "$":
                output.append(template[index]); index += 1; continue
            if index + 1 >= len(template):
                raise ConfigurationError("模板包含不完整的 `$` 占位符")
            following = template[index + 1]
            if following == "$":
                output.append("$"); index += 2; continue
            if following == "{":
                end = template.find("}", index + 2)
                if end < 0:
                    raise ConfigurationError("模板包含未闭合的配置密钥占位符")
                name = template[index + 2:end]
                if not _TEMPLATE_NAME.fullmatch(name):
                    raise ConfigurationError(f"模板配置密钥占位符不合法: {name!r}")
                index = end + 1
            else:
                match = _TEMPLATE_NAME.match(template, index + 1)
                if match is None:
                    raise ConfigurationError(f"模板包含不支持的 `$` 表达式，位置: {index}")
                name = match.group(0); index = match.end()
            output.append(self.config_secret(name))
        return "".join(output)

    def render_template(self, source, destination):
        source = Path(source); destination = Path(destination)
        try:
            rendered = self.render(source.read_text(encoding="utf-8"))
            destination.parent.mkdir(parents=True, exist_ok=True)
            descriptor, raw_path = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
            temporary = Path(raw_path)
            try:
                os.chmod(temporary, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
                    descriptor = -1; stream.write(rendered); stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, destination)
            finally:
                if descriptor >= 0: os.close(descriptor)
                try: temporary.unlink(missing_ok=True)
                except OSError: pass
        except (OSError, UnicodeError) as error:
            raise ConfigurationError(f"无法生成应用配置: {destination}") from error
'''


def write_remote_runtime(path: Path) -> Path:
    """将固定运行时写入一个仅供本次上传使用的本地临时路径。"""

    path.write_text(REMOTE_RUNTIME_SOURCE, encoding="utf-8", newline="\n")
    path.chmod(0o600)
    return path


__all__ = ["REMOTE_RUNTIME_SOURCE", "write_remote_runtime"]
