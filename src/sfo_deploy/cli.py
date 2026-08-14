"""sfo-deploy generic and project-bound command-line entrypoints."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from .downloads import DownloadProviderRegistry
from .errors import (
    ConfigurationError,
    DeploymentError,
    DownloadError,
    ExecutionError,
    PlanningError,
    PreflightError,
    TransportError,
)
from .integration import CLI_ACTIONS, RunOptions, ValidationResult, run
from .models import ExecutionPlan
from .results import DeploymentResult
from .secrets import ProjectBindings, Redactor
from .transport import SSHTransport


def make_entrypoint(
    *,
    config_root: Path | None,
    bindings: ProjectBindings,
    download_providers: DownloadProviderRegistry,
    transport: SSHTransport | None = None,
) -> Callable[[Sequence[str] | None], int]:
    """Create an isolated CLI; ``None`` config root produces the generic form."""

    fixed_root = None if config_root is None else Path(config_root).resolve()

    def entrypoint(argv: Sequence[str] | None = None) -> int:
        parser = _parser(generic=fixed_root is None)
        try:
            namespace = parser.parse_args(argv)
        except SystemExit as exit_signal:
            return int(exit_signal.code or 0)

        try:
            options = RunOptions(
                config_root=Path(namespace.config_root) if fixed_root is None else fixed_root,
                cluster=namespace.cluster,
                action=namespace.action,
                machines=tuple(namespace.machine),
                apps=tuple(namespace.app),
                environments=tuple(namespace.environment),
                executor_region=namespace.executor_region,
                address_kind=namespace.address_kind,
                with_dependencies=namespace.with_dependencies,
            )
            result = run(
                options,
                bindings,
                download_providers=download_providers,
                transport=transport,
            )
            _write_json(_serialize_result(result), stream=sys.stdout)
            return result.exit_code if isinstance(result, DeploymentResult) else 0
        except KeyboardInterrupt:
            _write_json(
                {"error": {"category": "cancelled", "message": "用户取消"}},
                stream=sys.stderr,
            )
            return 130
        except DeploymentError as error:
            message = _redact_error(str(error), bindings)
            _write_json(
                {
                    "error": {
                        "category": _error_category(error),
                        "message": message,
                    }
                },
                stream=sys.stderr,
            )
            return _error_exit_code(error)

    return entrypoint


def main(argv: Sequence[str] | None = None) -> int:
    """Generic CLI; unlike project-bound entrypoints it requires --config-root."""

    return make_entrypoint(
        config_root=None,
        bindings=ProjectBindings(),
        download_providers=DownloadProviderRegistry(),
    )(argv)


def _parser(*, generic: bool) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sfo-deploy",
        description="校验、规划或串行执行一个自包含集群部署。",
    )
    parser.add_argument("action", choices=CLI_ACTIONS, help="要执行的框架动作")
    if generic:
        parser.add_argument(
            "--config-root",
            type=Path,
            required=True,
            help="包含一个或多个集群目录的配置根目录",
        )
    parser.add_argument("--cluster", required=True, help="配置根目录下的集群目录名")
    parser.add_argument(
        "--machine",
        action="append",
        default=[],
        metavar="NAME",
        help="仅选择指定机器；可重复",
    )
    parser.add_argument(
        "--app",
        action="append",
        default=[],
        metavar="NAME",
        help="仅选择指定 App；可重复",
    )
    parser.add_argument(
        "--environment",
        action="append",
        default=[],
        metavar="[MACHINE/]NAME",
        help="仅选择指定环境实例；可重复",
    )
    parser.add_argument("--executor-region", help="覆盖部署执行器区域")
    parser.add_argument(
        "--address-kind",
        choices=("private", "public"),
        help="显式选择机器地址类型",
    )
    parser.add_argument(
        "--with-dependencies",
        action="store_true",
        help="定向 App 时同时规划并执行环境依赖",
    )
    return parser


def _serialize_result(result: ValidationResult | ExecutionPlan | DeploymentResult) -> dict[str, Any]:
    if isinstance(result, ValidationResult):
        return {
            "kind": "validation",
            "status": "succeeded",
            "cluster": result.cluster,
            "directory": str(result.directory),
            "machines": list(result.machines),
            "environments": list(result.environments),
            "apps": list(result.apps),
        }
    if isinstance(result, ExecutionPlan):
        return {
            "kind": "plan",
            "cluster": result.cluster,
            "requested_action": result.requested_action,
            "steps": [
                {
                    "id": step.id,
                    "machine": step.machine.machine.name,
                    "address": step.machine.address,
                    "address_kind": step.machine.address_kind,
                    "resource_kind": step.kind,
                    "resource": step.resource,
                    "action": step.action,
                    "scripts": [str(path) for path in step.scripts],
                    "package_provider": (
                        step.package.provider if step.package is not None else None
                    ),
                    "config_secrets": list(step.config_secrets),
                    "file_secrets": [
                        {
                            "name": target.name,
                            "path": target.path,
                            "mode": f"{target.mode:04o}",
                            "owner": target.owner,
                            "group": target.group,
                            "overwrite": target.overwrite,
                        }
                        for target in step.file_secrets
                    ],
                    "depends_on": list(step.depends_on),
                }
                for step in result.steps
            ],
        }
    return {
        "kind": "result",
        "cluster": result.cluster,
        "requested_action": result.requested_action,
        "status": "succeeded" if result.succeeded else "failed",
        "exit_code": result.exit_code,
        "targets": [
            {
                "machine": target.machine,
                "status": target.status.value,
                "cleanup_errors": list(target.cleanup_errors),
                "steps": [
                    {
                        "id": step.step_id,
                        "resource_kind": step.kind,
                        "resource": step.resource,
                        "action": step.action,
                        "status": step.status.value,
                        "exit_code": step.exit_code,
                        "message": step.message,
                        "error_category": step.error_category,
                        "skip_reason": step.skip_reason,
                        "cleanup_errors": list(step.cleanup_errors),
                    }
                    for step in target.steps
                ],
            }
            for target in result.targets
        ],
    }


def _error_exit_code(error: DeploymentError) -> int:
    if isinstance(error, (ConfigurationError, PlanningError)):
        return 2
    if isinstance(error, PreflightError):
        return 3
    if isinstance(error, (DownloadError, TransportError, ExecutionError)):
        return 4
    return 4


def _error_category(error: DeploymentError) -> str:
    if isinstance(error, (ConfigurationError, PlanningError)):
        return "configuration"
    if isinstance(error, PreflightError):
        return "preflight"
    if isinstance(error, DownloadError):
        return "download"
    if isinstance(error, TransportError):
        return "transport"
    return "execution"


def _redact_error(message: str, bindings: ProjectBindings) -> str:
    static_values = (
        value
        for value in bindings.config_secrets.values()
        if isinstance(value, str)
    )
    return Redactor(static_values).redact(message)


def _write_json(value: dict[str, Any], *, stream: Any) -> None:
    json.dump(value, stream, ensure_ascii=False, sort_keys=True)
    stream.write("\n")


__all__ = ["main", "make_entrypoint"]
