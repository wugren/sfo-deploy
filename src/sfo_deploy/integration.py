"""sfo-deploy public project-binding API and side-effect orchestration."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias

from .config import NAME_RE, load_cluster
from .downloads import DownloadProvider, DownloadProviderRegistry
from .errors import ConfigurationError, PreflightError
from .execution import execute_plan
from .models import ClusterConfig, ExecutionPlan
from .planning import build_plan
from .results import DeploymentResult
from .secrets import ConfigSecretProvider, ProjectBindings, prepare_file_secret_deployments
from .transport import ParamikoTransport, SSHTransport


CLI_ACTIONS = (
    "validate",
    "plan",
    "check",
    "install",
    "configure",
    "deploy",
    "start",
    "stop",
    "restart",
)
_EXECUTION_ACTIONS = frozenset(CLI_ACTIONS) - {"validate", "plan"}


@dataclass(frozen=True)
class RunOptions:
    """Validated, CWD-independent inputs for one framework invocation."""

    config_root: Path
    cluster: str
    action: str
    machines: tuple[str, ...] = ()
    apps: tuple[str, ...] = ()
    environments: tuple[str, ...] = ()
    executor_region: str | None = None
    address_kind: str | None = None
    with_dependencies: bool = False

    def __post_init__(self) -> None:
        root = Path(self.config_root).expanduser().resolve()
        if not root.is_dir():
            raise ConfigurationError(f"配置根目录不存在: {root}")
        if not isinstance(self.cluster, str) or not NAME_RE.fullmatch(self.cluster):
            raise ConfigurationError(f"集群选择名称不合法: {self.cluster!r}")
        if self.action not in CLI_ACTIONS:
            raise ConfigurationError(f"不支持的 CLI 动作: {self.action!r}")
        if self.address_kind not in {None, "private", "public"}:
            raise ConfigurationError(f"地址类型只支持 private/public: {self.address_kind!r}")
        machines = _unique_strings(self.machines, "machine")
        apps = _unique_strings(self.apps, "app")
        environments = _unique_strings(
            self.environments, "environment", allow_qualified=True
        )
        if self.action in {"check", "install"}:
            if not environments:
                raise ConfigurationError(
                    f"环境动作 {self.action} 必须至少指定一个 --environment"
                )
            if apps:
                raise ConfigurationError(
                    f"环境动作 {self.action} 不能与 --app 同时使用"
                )
        object.__setattr__(self, "config_root", root)
        object.__setattr__(self, "machines", machines)
        object.__setattr__(self, "apps", apps)
        object.__setattr__(self, "environments", environments)

    @property
    def cluster_directory(self) -> Path:
        candidate = (self.config_root / self.cluster).resolve()
        try:
            relative = candidate.relative_to(self.config_root)
        except ValueError as error:
            raise ConfigurationError(f"集群目录逃逸配置根目录: {self.cluster}") from error
        if len(relative.parts) != 1 or not candidate.is_dir():
            raise ConfigurationError(f"配置根目录下不存在集群: {self.cluster}")
        return candidate


@dataclass(frozen=True)
class ValidationResult:
    """A secret-free summary returned by the validate action."""

    cluster: str
    directory: Path
    machines: tuple[str, ...]
    environments: tuple[str, ...]
    apps: tuple[str, ...]

    @property
    def succeeded(self) -> bool:
        return True

    @property
    def exit_code(self) -> int:
        return 0


RunResult: TypeAlias = ValidationResult | ExecutionPlan | DeploymentResult


def run(
    options: RunOptions,
    bindings: ProjectBindings | None = None,
    *,
    download_providers: DownloadProviderRegistry | Mapping[str, DownloadProvider] | None = None,
    transport: SSHTransport | None = None,
) -> RunResult:
    """Load, plan, and optionally execute one invocation without global state."""

    if not isinstance(options, RunOptions):
        raise TypeError("options 必须是 RunOptions")
    project_bindings = bindings or ProjectBindings()
    registry = _provider_registry(download_providers)
    cluster = load_cluster(options.cluster_directory)
    if options.action == "validate":
        return _validation_result(cluster)

    requested_action = "deploy" if options.action == "plan" else options.action
    plan = build_plan(
        cluster,
        requested_action,
        machines=options.machines or None,
        apps=options.apps or None,
        environments=options.environments or None,
        executor_region=options.executor_region,
        address_kind=options.address_kind,
        with_dependencies=options.with_dependencies,
    )
    if options.action == "plan":
        return plan

    _preflight_local_bindings(plan, project_bindings, registry)
    return execute_plan(
        plan,
        transport or ParamikoTransport(),
        bindings=project_bindings,
        download_providers=registry,
    )


def create_cli(
    *,
    config_root: Path,
    download_providers: Mapping[str, DownloadProvider] | None = None,
    file_secrets: Mapping[str, Path] | None = None,
    config_secrets: Mapping[str, ConfigSecretProvider] | None = None,
    transport: SSHTransport | None = None,
) -> Callable[[Sequence[str] | None], int]:
    """Bind one project to an absolute root and return its zero-glue CLI."""

    root = Path(config_root).expanduser().resolve()
    if not root.is_dir():
        raise ConfigurationError(f"配置根目录不存在: {root}")
    bindings = ProjectBindings(
        file_secrets=file_secrets,
        config_secrets=config_secrets,
    )
    registry = DownloadProviderRegistry(download_providers)

    # Import lazily so the public integration API does not depend on argparse setup.
    from .cli import make_entrypoint

    entrypoint = make_entrypoint(
        config_root=root,
        bindings=bindings,
        download_providers=registry,
        transport=transport,
    )
    entrypoint.__name__ = "main"
    entrypoint.__qualname__ = "main"
    return entrypoint


def _provider_registry(
    providers: DownloadProviderRegistry | Mapping[str, DownloadProvider] | None,
) -> DownloadProviderRegistry:
    if providers is None:
        return DownloadProviderRegistry()
    if isinstance(providers, DownloadProviderRegistry):
        return providers
    return DownloadProviderRegistry(providers)


def _preflight_local_bindings(
    plan: ExecutionPlan,
    bindings: ProjectBindings,
    registry: DownloadProviderRegistry,
) -> None:
    """Reject missing local integrations before the first SSH connection."""

    for step in plan.steps:
        needs_package = step.package is not None and (
            (step.kind == "environment" and step.action == "install")
            or (step.kind == "app" and step.action == "deploy")
        )
        if needs_package:
            registry.resolve(step.package.provider)
        if step.action == "configure":
            missing_config = sorted(set(step.config_secrets) - set(bindings.config_secrets))
            if missing_config:
                raise PreflightError(
                    f"项目未绑定配置密钥: {', '.join(missing_config)}"
                )
            if step.file_secrets:
                prepare_file_secret_deployments(step.file_secrets, bindings)


def _validation_result(cluster: ClusterConfig) -> ValidationResult:
    environment_ids = tuple(
        sorted(
            f"{machine.name}/{environment.name}"
            for machine in cluster.machines.values()
            for environment in machine.environments
        )
    )
    return ValidationResult(
        cluster=cluster.name,
        directory=cluster.directory,
        machines=tuple(sorted(cluster.machines)),
        environments=environment_ids,
        apps=tuple(sorted(cluster.apps)),
    )


def _unique_strings(
    values: Sequence[str],
    label: str,
    *,
    allow_qualified: bool = False,
) -> tuple[str, ...]:
    result: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise ConfigurationError(f"{label} 过滤器必须是字符串")
        parts = value.split("/")
        valid = (
            len(parts) == 2
            and allow_qualified
            and all(NAME_RE.fullmatch(part) for part in parts)
        ) or (len(parts) == 1 and bool(NAME_RE.fullmatch(value)))
        if not valid:
            raise ConfigurationError(f"{label} 过滤器名称不合法: {value!r}")
        if value in result:
            raise ConfigurationError(f"{label} 过滤器重复: {value}")
        result.append(value)
    return tuple(result)


__all__ = [
    "CLI_ACTIONS",
    "RunOptions",
    "RunResult",
    "ValidationResult",
    "create_cli",
    "run",
]
