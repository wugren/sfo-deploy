"""sfo-deploy 确定性串行执行计划，并保持目标内 fail-fast 与跨目标隔离。"""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path, PurePosixPath
from typing import Mapping

from .downloads import DownloadProviderRegistry, VerifiedArtifact
from .environment import EnvironmentCheckResult
from .errors import PreflightError
from .models import ExecutionPlan, PlanStep
from .remote_context import temporary_context_file
from .remote_runtime import write_remote_runtime
from .results import CommandResult, DeploymentResult, StepResult, StepStatus
from .secrets import ProjectBindings, Redactor, prepare_file_secret_deployments
from .transport import RemoteSession, SSHTransport


class DeploymentExecutor:
    """消费不可变计划的 v0.1 串行执行器。"""

    def __init__(
        self,
        transport: SSHTransport,
        *,
        bindings: ProjectBindings | None = None,
        download_providers: DownloadProviderRegistry | None = None,
    ) -> None:
        self.transport = transport
        self.bindings = bindings or ProjectBindings()
        self.download_providers = download_providers or DownloadProviderRegistry()

    def execute(self, plan: ExecutionPlan) -> DeploymentResult:
        results: list[StepResult] = []
        by_step: dict[str, StepResult] = {}
        sessions: dict[str, RemoteSession] = {}
        workspaces: dict[str, PurePosixPath] = {}
        failed_machines: set[str] = set()
        python_checked: set[str] = set()
        check_results: dict[tuple[str, str], EnvironmentCheckResult] = {}
        install_check_ids = {
            dependency
            for candidate in plan.steps
            if candidate.kind == "environment" and candidate.action == "install"
            for dependency in candidate.depends_on
        }
        cancelled = False

        with tempfile.TemporaryDirectory(prefix="sfo-deploy-") as raw_temp:
            local_temp = Path(raw_temp)
            try:
                for index, step in enumerate(plan.steps):
                    machine_name = step.machine.machine.name
                    if cancelled:
                        result = self._skipped(step, "cancelled", StepStatus.CANCELLED)
                    else:
                        blocked_by = tuple(
                            dependency
                            for dependency in step.depends_on
                            if dependency not in by_step
                            or not by_step[dependency].satisfies_dependency
                        )
                        dependency_blockers = tuple(
                            dependency
                            for dependency in blocked_by
                            if dependency not in by_step
                            or by_step[dependency].machine != machine_name
                            or by_step[dependency].kind != step.kind
                            or by_step[dependency].resource != step.resource
                        )
                        if dependency_blockers:
                            result = self._skipped(
                                step,
                                "dependency-failed",
                                StepStatus.BLOCKED,
                                message=f"依赖未成功: {', '.join(dependency_blockers)}",
                            )
                        elif machine_name in failed_machines:
                            result = self._skipped(step, "target-fail-fast")
                        elif blocked_by:
                            result = self._skipped(
                                step,
                                "dependency-failed",
                                StepStatus.BLOCKED,
                                message=f"依赖未成功: {', '.join(blocked_by)}",
                            )
                        elif (
                            step.kind == "environment"
                            and step.action == "install"
                            and check_results.get((machine_name, step.resource))
                            is EnvironmentCheckResult.SATISFIED
                        ):
                            result = self._skipped(step, "check-satisfied")
                        else:
                            try:
                                session = sessions.get(machine_name)
                                if session is None:
                                    session = self.transport.connect(step.machine)
                                    sessions[machine_name] = session
                                    workspaces[machine_name] = session.create_workspace()
                                    local_runtime = write_remote_runtime(
                                        local_temp / f"remote-runtime-{machine_name}.py"
                                    )
                                    session.upload_file(
                                        local_runtime,
                                        workspaces[machine_name] / "sfo_deploy.py",
                                        mode=0o600,
                                    )
                                if machine_name not in python_checked:
                                    session.preflight_python(step.machine.machine.python)
                                    python_checked.add(machine_name)
                                result = self._execute_step(
                                    step,
                                    index=index,
                                    session=session,
                                    workspace=workspaces[machine_name],
                                    local_temp=local_temp,
                                    check_results=check_results,
                                    check_can_install=step.id in install_check_ids,
                                )
                            except KeyboardInterrupt:
                                cancelled = True
                                result = self._skipped(
                                    step,
                                    "cancelled",
                                    StepStatus.CANCELLED,
                                    message="用户取消",
                                )
                            except PreflightError as error:
                                result = self._failed(step, str(error), error_category="preflight")
                            except Exception as error:
                                result = self._failed(step, str(error))
                            if result.status is StepStatus.FAILED:
                                failed_machines.add(machine_name)
                    results.append(result)
                    by_step[step.id] = result
            finally:
                for machine_name, session in sessions.items():
                    workspace = workspaces.get(machine_name)
                    if workspace is not None:
                        try:
                            session.cleanup_workspace(workspace)
                        except Exception as error:
                            self._append_cleanup_error(results, by_step, machine_name, str(error))
                    try:
                        session.close()
                    except Exception as error:
                        self._append_cleanup_error(results, by_step, machine_name, str(error))

        return DeploymentResult(
            cluster=plan.cluster,
            requested_action=plan.requested_action,
            steps=tuple(results),
        )

    def _execute_step(
        self,
        step: PlanStep,
        *,
        index: int,
        session: RemoteSession,
        workspace: PurePosixPath,
        local_temp: Path,
        check_results: dict[tuple[str, str], EnvironmentCheckResult],
        check_can_install: bool,
    ) -> StepResult:
        machine_name = step.machine.machine.name
        config_values: Mapping[str, str] = (
            self.bindings.select_config_secrets(step.config_secrets)
            if step.action == "configure"
            else {}
        )
        file_deployments = (
            prepare_file_secret_deployments(step.file_secrets, self.bindings)
            if step.action == "configure"
            else ()
        )
        redaction_values = list(config_values.values())
        for deployment in file_deployments:
            try:
                redaction_values.append(deployment.source.read_text(encoding="utf-8"))
            except (OSError, UnicodeError):
                pass
        redactor = Redactor(redaction_values)

        artifact: VerifiedArtifact | None = None
        context_remote = workspace / f"context-{index}.json"
        cleanup_errors: list[str] = []
        outputs: list[CommandResult] = []
        status = StepStatus.SUCCEEDED
        message: str | None = None
        error_category: str | None = None
        exit_code: int | None = 0
        try:
            metadata = {
                "machine": machine_name,
                "kind": step.kind,
                "resource": step.resource,
                "action": step.action,
                "parameters": dict(step.parameters),
            }
            if self._needs_package(step):
                local_package = local_temp / f"package-{index}.bin"
                artifact = self.download_providers.fetch_package(step.package, local_package)  # type: ignore[arg-type]
                remote_package = workspace / f"package-{index}.bin"
                session.upload_file(artifact.path, remote_package, mode=0o600)
                metadata["package_path"] = str(remote_package)

            for deployment in file_deployments:
                session.deploy_file_secret(deployment, workspace=workspace)

            if step.action == "configure":
                remote_templates: dict[str, str] = {}
                for template in step.templates:
                    digest = hashlib.sha256(template.relative_path.encode("utf-8")).hexdigest()[:16]
                    remote_template = workspace / f"template-{index}-{digest}"
                    session.upload_file(template.source, remote_template, mode=0o600)
                    remote_templates[template.relative_path] = str(remote_template)
                metadata["templates"] = remote_templates

            with temporary_context_file(config_values, metadata=metadata, directory=local_temp) as local_context:
                session.upload_file(local_context, context_remote, mode=0o600)
                if bool(step.parameters.get("requires_privilege", False)):
                    session.preflight_privilege()
                for script_index, local_script in enumerate(step.scripts):
                    remote_script = workspace / f"script-{index}-{script_index}.py"
                    session.upload_file(local_script, remote_script, mode=0o700)
                    command = session.execute_python(
                        step.machine.machine.python,
                        remote_script,
                        context_path=context_remote,
                        privileged=bool(step.parameters.get("requires_privilege", False)),
                    )
                    outputs.append(command)
                    exit_code = command.exit_code
                    if step.kind == "environment" and step.action == "check":
                        if command.exit_code != 0:
                            check_results[(machine_name, step.resource)] = EnvironmentCheckResult.UNSATISFIED
                            if check_can_install:
                                message = "环境检查未满足，将执行 install"
                            else:
                                status = StepStatus.FAILED
                                message = "环境依赖检查未满足；定向部署不会自动安装依赖"
                            break
                    elif command.exit_code != 0:
                        status = StepStatus.FAILED
                        message = f"脚本退出码为 {command.exit_code}"
                        break
                else:
                    if step.kind == "environment" and step.action == "check":
                        check_results[(machine_name, step.resource)] = EnvironmentCheckResult.SATISFIED
                        message = "环境检查已满足"
        except PreflightError as error:
            status = StepStatus.FAILED
            message = redactor.redact(str(error))
            error_category = "preflight"
            if step.kind == "environment" and step.action == "check":
                check_results[(machine_name, step.resource)] = EnvironmentCheckResult.FAILED
        except Exception as error:
            status = StepStatus.FAILED
            message = redactor.redact(str(error))
            error_category = None
            if step.kind == "environment" and step.action == "check":
                check_results[(machine_name, step.resource)] = EnvironmentCheckResult.FAILED
        finally:
            try:
                session.remove_file(context_remote)
            except Exception as error:
                cleanup_errors.append(redactor.redact(str(error)))
            if artifact is not None:
                try:
                    artifact.cleanup()
                except Exception as error:
                    cleanup_errors.append(redactor.redact(str(error)))

        if cleanup_errors and status is StepStatus.SUCCEEDED:
            status = StepStatus.FAILED
        stdout = redactor.redact("".join(output.stdout for output in outputs))
        stderr = redactor.redact("".join(output.stderr for output in outputs))
        return StepResult(
            step_id=step.id,
            machine=machine_name,
            kind=step.kind,
            resource=step.resource,
            action=step.action,
            status=status,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            message=message,
            error_category=error_category,
            cleanup_errors=tuple(cleanup_errors),
        )

    @staticmethod
    def _needs_package(step: PlanStep) -> bool:
        return step.package is not None and (
            (step.kind == "environment" and step.action == "install")
            or (step.kind == "app" and step.action == "deploy")
        )

    @staticmethod
    def _skipped(
        step: PlanStep,
        reason: str,
        status: StepStatus = StepStatus.SKIPPED,
        *,
        message: str | None = None,
    ) -> StepResult:
        return StepResult(
            step_id=step.id,
            machine=step.machine.machine.name,
            kind=step.kind,
            resource=step.resource,
            action=step.action,
            status=status,
            message=message,
            skip_reason=reason,
        )

    @staticmethod
    def _failed(
        step: PlanStep,
        message: str,
        *,
        error_category: str | None = None,
    ) -> StepResult:
        return StepResult(
            step_id=step.id,
            machine=step.machine.machine.name,
            kind=step.kind,
            resource=step.resource,
            action=step.action,
            status=StepStatus.FAILED,
            message=message,
            error_category=error_category,
        )

    @staticmethod
    def _append_cleanup_error(
        results: list[StepResult],
        by_step: dict[str, StepResult],
        machine_name: str,
        message: str,
    ) -> None:
        for index in range(len(results) - 1, -1, -1):
            result = results[index]
            if result.machine == machine_name:
                updated = result.with_cleanup_error(message)
                results[index] = updated
                by_step[updated.step_id] = updated
                return


def execute_plan(
    plan: ExecutionPlan,
    transport: SSHTransport,
    *,
    bindings: ProjectBindings | None = None,
    download_providers: DownloadProviderRegistry | None = None,
) -> DeploymentResult:
    return DeploymentExecutor(
        transport,
        bindings=bindings,
        download_providers=download_providers,
    ).execute(plan)


__all__ = ["DeploymentExecutor", "execute_plan"]
