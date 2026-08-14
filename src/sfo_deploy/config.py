"""严格加载一个 sfo-deploy 自包含集群目录。"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

import yaml

from .errors import ConfigurationError
from .models import (
    AppDefinition,
    ClusterConfig,
    ConfigTemplate,
    EnvironmentDefinition,
    EnvironmentInstance,
    FileSecretTarget,
    Machine,
    PackageSpec,
    ScriptDefinition,
)

NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]*$")
SECRET_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
ACTIONS = {"check", "install", "configure", "deploy", "start", "stop", "restart"}


class _StrictLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader: _StrictLoader, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
    result: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ConfigurationError(f"YAML 存在重复键: {key!r}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


_StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ConfigurationError(f"缺少配置文件: {path}")
    try:
        value = yaml.load(path.read_text(encoding="utf-8"), Loader=_StrictLoader)
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise ConfigurationError(f"无法读取 YAML {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ConfigurationError(f"YAML 顶层必须是映射: {path}")
    return value


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(k, str) for k in value):
        raise ConfigurationError(f"{label} 必须是字符串键映射")
    return value


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ConfigurationError(f"{label} 必须是列表")
    return value


def _fields(data: Mapping[str, Any], allowed: set[str], required: set[str], label: str) -> None:
    unknown = sorted(set(data) - allowed)
    missing = sorted(required - set(data))
    if unknown:
        raise ConfigurationError(f"{label} 包含未知字段: {', '.join(unknown)}")
    if missing:
        raise ConfigurationError(f"{label} 缺少字段: {', '.join(missing)}")


def _name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not NAME_RE.fullmatch(value):
        raise ConfigurationError(f"{label} 不是合法名称: {value!r}")
    return value


def _string(value: Any, label: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ConfigurationError(f"{label} 必须是字符串")
    return value.strip()


def _version(data: Mapping[str, Any], label: str) -> None:
    if data.get("schema_version") != 1:
        raise ConfigurationError(f"{label}.schema_version 只支持 1")


def _contained(base: Path, relative: Any, label: str, suffix: str | None = None) -> Path:
    text = _string(relative, label)
    candidate = Path(text)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ConfigurationError(f"{label} 必须位于资源目录内: {text}")
    resolved = (base / candidate).resolve()
    try:
        resolved.relative_to(base.resolve())
    except ValueError as exc:
        raise ConfigurationError(f"{label} 逃逸资源目录: {text}") from exc
    if suffix and resolved.suffix != suffix:
        raise ConfigurationError(f"{label} 必须是 {suffix} 文件: {text}")
    if not resolved.is_file():
        raise ConfigurationError(f"{label} 文件不存在: {resolved}")
    return resolved


def _string_list(value: Any, label: str, validator: re.Pattern[str] | None = None) -> tuple[str, ...]:
    values = _list(value, label)
    result: list[str] = []
    for index, item in enumerate(values):
        text = _string(item, f"{label}[{index}]")
        if validator and not validator.fullmatch(text):
            raise ConfigurationError(f"{label}[{index}] 名称不合法: {text}")
        if text in result:
            raise ConfigurationError(f"{label} 包含重复值: {text}")
        result.append(text)
    return tuple(result)


def _package(value: Any, label: str) -> PackageSpec:
    data = _mapping(value, label)
    _fields(data, {"provider", "source", "hash"}, {"provider", "source", "hash"}, label)
    hash_data = _mapping(data["hash"], f"{label}.hash")
    _fields(hash_data, {"algorithm", "value"}, {"algorithm", "value"}, f"{label}.hash")
    algorithm = _string(hash_data["algorithm"], f"{label}.hash.algorithm").lower()
    if algorithm not in hashlib.algorithms_available or algorithm.startswith("shake"):
        raise ConfigurationError(f"{label} 使用不支持的哈希算法: {algorithm}")
    digest = _string(hash_data["value"], f"{label}.hash.value").lower()
    try:
        expected_len = hashlib.new(algorithm).digest_size * 2
    except ValueError as exc:
        raise ConfigurationError(f"{label} 使用不支持的哈希算法: {algorithm}") from exc
    if len(digest) != expected_len or any(ch not in "0123456789abcdef" for ch in digest):
        raise ConfigurationError(f"{label}.hash.value 长度或格式不合法")
    return PackageSpec(
        provider=_name(data["provider"], f"{label}.provider"),
        source=_mapping(data["source"], f"{label}.source"),
        hash_algorithm=algorithm,
        hash_value=digest,
    )


def _scripts(data: Mapping[str, Any], directory: Path, label: str) -> ScriptDefinition:
    actions_data = _mapping(data.get("scripts", {}), f"{label}.scripts")
    unknown_actions = sorted(set(actions_data) - ACTIONS)
    if unknown_actions:
        raise ConfigurationError(f"{label}.scripts 包含未知动作: {', '.join(unknown_actions)}")
    actions: dict[str, tuple[Path, ...]] = {}
    for action, raw_paths in actions_data.items():
        paths = _list(raw_paths, f"{label}.scripts.{action}")
        actions[action] = tuple(
            _contained(directory, value, f"{label}.scripts.{action}[{index}]", ".py")
            for index, value in enumerate(paths)
        )
    config_secrets = _string_list(data.get("config_secrets", []), f"{label}.config_secrets", SECRET_RE)
    templates: list[ConfigTemplate] = []
    seen_templates: set[str] = set()
    for index, raw in enumerate(_list(data.get("templates", []), f"{label}.templates")):
        template_label = f"{label}.templates[{index}]"
        text = _string(raw, template_label)
        relative = PurePosixPath(text)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or "\\" in text
            or str(relative) != text
            or text in {"", "."}
        ):
            raise ConfigurationError(f"{template_label} 必须是规范的资源目录相对 POSIX 路径: {text!r}")
        if text in seen_templates:
            raise ConfigurationError(f"{label}.templates 包含重复路径: {text}")
        seen_templates.add(text)
        templates.append(
            ConfigTemplate(
                relative_path=text,
                source=_contained(directory, text, template_label),
            )
        )
    file_targets: list[FileSecretTarget] = []
    for index, raw in enumerate(_list(data.get("file_secrets", []), f"{label}.file_secrets")):
        item = _mapping(raw, f"{label}.file_secrets[{index}]")
        _fields(
            item,
            {"name", "path", "mode", "owner", "group", "overwrite"},
            {"name", "path"},
            f"{label}.file_secrets[{index}]",
        )
        target_path = _string(item["path"], f"{label}.file_secrets[{index}].path")
        if not target_path.startswith("/") or ".." in Path(target_path).parts:
            raise ConfigurationError(f"文件私钥目标必须是安全绝对路径: {target_path}")
        mode_raw = item.get("mode", "0600")
        if isinstance(mode_raw, int):
            mode = mode_raw
        elif isinstance(mode_raw, str) and re.fullmatch(r"0?[0-7]{3}", mode_raw):
            mode = int(mode_raw, 8)
        else:
            raise ConfigurationError(f"文件私钥 mode 不合法: {mode_raw!r}")
        if mode & 0o077:
            raise ConfigurationError(f"文件私钥 mode 必须禁止 group/other 访问: {mode_raw!r}")
        overwrite = item.get("overwrite", True)
        if not isinstance(overwrite, bool):
            raise ConfigurationError("文件私钥 overwrite 必须是布尔值")
        file_targets.append(
            FileSecretTarget(
                name=_name(item["name"], f"{label}.file_secrets[{index}].name"),
                path=target_path,
                mode=mode,
                owner=item.get("owner"),
                group=item.get("group"),
                overwrite=overwrite,
            )
        )
    return ScriptDefinition(
        actions=actions,
        config_secrets=config_secrets,
        file_secrets=tuple(file_targets),
        templates=tuple(templates),
    )


def _load_machines(path: Path, root: Path) -> dict[str, Machine]:
    data = _load_yaml(path)
    _version(data, "machines.yaml")
    _fields(data, {"schema_version", "machines"}, {"schema_version", "machines"}, "machines.yaml")
    machines: dict[str, Machine] = {}
    for index, raw in enumerate(_list(data["machines"], "machines.yaml.machines")):
        label = f"machines[{index}]"
        item = _mapping(raw, label)
        _fields(
            item,
            {"name", "domains", "private_ip", "public_ip", "region", "ssh_user", "ssh_port", "ssh_private_key", "python", "environments"},
            {"name", "region", "ssh_user"},
            label,
        )
        name = _name(item["name"], f"{label}.name")
        if name in machines:
            raise ConfigurationError(f"重复机器名称: {name}")
        private_ip = item.get("private_ip")
        public_ip = item.get("public_ip")
        for field_name, value in (("private_ip", private_ip), ("public_ip", public_ip)):
            if value is not None:
                try:
                    ipaddress.ip_address(value)
                except (ValueError, TypeError) as exc:
                    raise ConfigurationError(f"{label}.{field_name} 不是合法 IP") from exc
        port = item.get("ssh_port", 22)
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ConfigurationError(f"{label}.ssh_port 不合法")
        key = item.get("ssh_private_key")
        key_path = _contained(root, key, f"{label}.ssh_private_key") if key else None
        envs: list[EnvironmentInstance] = []
        seen_envs: set[str] = set()
        for env_index, raw_env in enumerate(_list(item.get("environments", []), f"{label}.environments")):
            env_label = f"{label}.environments[{env_index}]"
            env = _mapping(raw_env, env_label)
            _fields(env, {"name", "definition", "version", "parameters", "depends_on", "requires_privilege"}, {"name", "definition", "version"}, env_label)
            env_name = _name(env["name"], f"{env_label}.name")
            if env_name in seen_envs:
                raise ConfigurationError(f"机器 {name} 包含重复环境实例: {env_name}")
            seen_envs.add(env_name)
            privilege = env.get("requires_privilege")
            if privilege is not None and not isinstance(privilege, bool):
                raise ConfigurationError(f"{env_label}.requires_privilege 必须是布尔值")
            envs.append(EnvironmentInstance(
                name=env_name,
                definition=_name(env["definition"], f"{env_label}.definition"),
                version=_string(env["version"], f"{env_label}.version"),
                parameters=_mapping(env.get("parameters", {}), f"{env_label}.parameters"),
                depends_on=_string_list(env.get("depends_on", []), f"{env_label}.depends_on"),
                requires_privilege=privilege,
            ))
        machines[name] = Machine(
            name=name,
            domains=_string_list(item.get("domains", []), f"{label}.domains"),
            private_ip=private_ip,
            public_ip=public_ip,
            region=_name(item["region"], f"{label}.region"),
            ssh_user=_string(item["ssh_user"], f"{label}.ssh_user"),
            ssh_port=port,
            ssh_private_key=key_path,
            python=_string(item.get("python", "python3"), f"{label}.python"),
            environments=tuple(envs),
        )
    return machines


def _load_definitions(root: Path) -> dict[str, EnvironmentDefinition]:
    definitions: dict[str, EnvironmentDefinition] = {}
    parent = root / "environments"
    if not parent.exists():
        return definitions
    for directory in sorted(path for path in parent.iterdir() if path.is_dir()):
        data = _load_yaml(directory / "environment.yaml")
        label = f"environment[{directory.name}]"
        _version(data, label)
        _fields(data, {"schema_version", "name", "defaults", "requires_privilege", "package", "scripts", "config_secrets", "file_secrets", "templates"}, {"schema_version", "name", "scripts"}, label)
        name = _name(data["name"], f"{label}.name")
        if name != directory.name:
            raise ConfigurationError(f"环境名称 {name} 必须与目录 {directory.name} 相同")
        definitions[name] = EnvironmentDefinition(
            name=name,
            directory=directory.resolve(),
            scripts=_scripts(data, directory, label),
            defaults=_mapping(data.get("defaults", {}), f"{label}.defaults"),
            package=_package(data["package"], f"{label}.package") if data.get("package") is not None else None,
            requires_privilege=bool(data.get("requires_privilege", False)),
        )
    return definitions


def _load_apps(root: Path) -> dict[str, AppDefinition]:
    apps: dict[str, AppDefinition] = {}
    parent = root / "apps"
    if not parent.exists():
        return apps
    for directory in sorted(path for path in parent.iterdir() if path.is_dir()):
        data = _load_yaml(directory / "app.yaml")
        label = f"app[{directory.name}]"
        _version(data, label)
        _fields(data, {"schema_version", "name", "version", "package", "depends_on", "scripts", "config_secrets", "file_secrets", "templates"}, {"schema_version", "name", "version", "package", "scripts"}, label)
        name = _name(data["name"], f"{label}.name")
        if name != directory.name:
            raise ConfigurationError(f"App 名称 {name} 必须与目录 {directory.name} 相同")
        apps[name] = AppDefinition(
            name=name,
            directory=directory.resolve(),
            version=_string(data["version"], f"{label}.version"),
            package=_package(data["package"], f"{label}.package"),
            scripts=_scripts(data, directory, label),
            depends_on=_string_list(data.get("depends_on", []), f"{label}.depends_on"),
        )
    return apps


def _validate_dependencies(machines: Mapping[str, Machine], definitions: Mapping[str, EnvironmentDefinition], apps: Mapping[str, AppDefinition], placements: Mapping[str, tuple[str, ...]]) -> None:
    env_ids = {f"{machine.name}/{env.name}" for machine in machines.values() for env in machine.environments}
    for machine in machines.values():
        local = {env.name for env in machine.environments}
        for env in machine.environments:
            if env.definition not in definitions:
                raise ConfigurationError(f"{machine.name}/{env.name} 引用未知环境定义: {env.definition}")
            for dep in env.depends_on:
                target = dep if "/" in dep else f"{machine.name}/{dep}"
                if target not in env_ids:
                    raise ConfigurationError(f"{machine.name}/{env.name} 引用未知环境实例: {dep}")
                if "/" not in dep and dep not in local:
                    raise ConfigurationError(f"{machine.name}/{env.name} 引用未知本机环境实例: {dep}")
    for app_name, app in apps.items():
        for machine_name in placements[app_name]:
            for dep in app.depends_on:
                target = dep if "/" in dep else f"{machine_name}/{dep}"
                if target not in env_ids:
                    raise ConfigurationError(f"App {app_name} 在 {machine_name} 引用未知环境实例: {dep}")


def load_cluster(directory: str | Path) -> ClusterConfig:
    root = Path(directory).resolve()
    if not root.is_dir():
        raise ConfigurationError(f"集群目录不存在: {root}")
    cluster_data = _load_yaml(root / "cluster.yaml")
    _version(cluster_data, "cluster.yaml")
    _fields(cluster_data, {"schema_version", "name", "executor_region", "apps"}, {"schema_version", "name", "executor_region", "apps"}, "cluster.yaml")
    machines = _load_machines(root / "machines.yaml", root)
    definitions = _load_definitions(root)
    apps = _load_apps(root)
    placements_raw = _mapping(cluster_data["apps"], "cluster.yaml.apps")
    if set(placements_raw) != set(apps):
        missing = sorted(set(apps) - set(placements_raw))
        unknown = sorted(set(placements_raw) - set(apps))
        raise ConfigurationError(f"cluster.yaml App 映射不一致；缺失={missing} 未知={unknown}")
    placements: dict[str, tuple[str, ...]] = {}
    for app_name, raw_machines in placements_raw.items():
        assigned = _string_list(raw_machines, f"cluster.yaml.apps.{app_name}")
        if not assigned:
            raise ConfigurationError(f"App {app_name} 至少需要一台目标机器")
        unknown = sorted(set(assigned) - set(machines))
        if unknown:
            raise ConfigurationError(f"App {app_name} 引用未知机器: {', '.join(unknown)}")
        placements[app_name] = assigned
    _validate_dependencies(machines, definitions, apps, placements)
    return ClusterConfig(
        name=_name(cluster_data["name"], "cluster.yaml.name"),
        directory=root,
        executor_region=_name(cluster_data["executor_region"], "cluster.yaml.executor_region"),
        machines=machines,
        environments=definitions,
        apps=apps,
        placements=placements,
    )
