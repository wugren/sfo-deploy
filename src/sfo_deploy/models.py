"""sfo-deploy 不可变领域模型；配置加载后不再携带未经校验的字典。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class PackageSpec:
    provider: str
    source: Mapping[str, Any]
    hash_algorithm: str
    hash_value: str


@dataclass(frozen=True)
class FileSecretTarget:
    name: str
    path: str
    mode: int = 0o600
    owner: str | None = None
    group: str | None = None
    overwrite: bool = True


@dataclass(frozen=True)
class ConfigTemplate:
    """配置脚本声明的、位于资源目录内的模板文件。"""

    relative_path: str
    source: Path


@dataclass(frozen=True)
class ScriptDefinition:
    actions: Mapping[str, tuple[Path, ...]]
    config_secrets: tuple[str, ...] = ()
    file_secrets: tuple[FileSecretTarget, ...] = ()
    templates: tuple[ConfigTemplate, ...] = ()


@dataclass(frozen=True)
class EnvironmentInstance:
    name: str
    definition: str
    version: str
    parameters: Mapping[str, Any] = field(default_factory=dict)
    depends_on: tuple[str, ...] = ()
    requires_privilege: bool | None = None


@dataclass(frozen=True)
class Machine:
    name: str
    domains: tuple[str, ...]
    private_ip: str | None
    public_ip: str | None
    region: str
    ssh_user: str
    ssh_port: int = 22
    ssh_private_key: Path | None = None
    python: str = "python3"
    environments: tuple[EnvironmentInstance, ...] = ()


@dataclass(frozen=True)
class EnvironmentDefinition:
    name: str
    directory: Path
    scripts: ScriptDefinition
    defaults: Mapping[str, Any] = field(default_factory=dict)
    package: PackageSpec | None = None
    requires_privilege: bool = False


@dataclass(frozen=True)
class AppDefinition:
    name: str
    directory: Path
    version: str
    package: PackageSpec
    scripts: ScriptDefinition
    depends_on: tuple[str, ...] = ()


@dataclass(frozen=True)
class ClusterConfig:
    name: str
    directory: Path
    executor_region: str
    machines: Mapping[str, Machine]
    environments: Mapping[str, EnvironmentDefinition]
    apps: Mapping[str, AppDefinition]
    placements: Mapping[str, tuple[str, ...]]


@dataclass(frozen=True)
class ResolvedMachine:
    machine: Machine
    address: str
    address_kind: str


@dataclass(frozen=True)
class PlanStep:
    id: str
    machine: ResolvedMachine
    kind: str
    resource: str
    action: str
    scripts: tuple[Path, ...]
    parameters: Mapping[str, Any]
    package: PackageSpec | None
    config_secrets: tuple[str, ...]
    file_secrets: tuple[FileSecretTarget, ...]
    templates: tuple[ConfigTemplate, ...] = ()
    depends_on: tuple[str, ...] = ()


@dataclass(frozen=True)
class ExecutionPlan:
    cluster: str
    requested_action: str
    steps: tuple[PlanStep, ...]
