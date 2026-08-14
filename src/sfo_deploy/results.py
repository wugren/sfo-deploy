"""sfo-deploy 命令、步骤和目标的结构化结果。"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum


class StepStatus(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: str = ""
    stderr: str = ""


@dataclass(frozen=True)
class StepResult:
    step_id: str
    machine: str
    kind: str
    resource: str
    action: str
    status: StepStatus
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    message: str | None = None
    error_category: str | None = None
    skip_reason: str | None = None
    cleanup_errors: tuple[str, ...] = ()

    @property
    def satisfies_dependency(self) -> bool:
        return self.status is StepStatus.SUCCEEDED or (
            self.status is StepStatus.SKIPPED
            and self.skip_reason == "check-satisfied"
        )

    def with_cleanup_error(self, message: str) -> StepResult:
        """附加清理错误，并把原本成功的步骤升级为失败。"""

        status = self.status
        if status in {StepStatus.SUCCEEDED, StepStatus.SKIPPED}:
            status = StepStatus.FAILED
        return replace(
            self,
            status=status,
            cleanup_errors=(*self.cleanup_errors, message),
        )


@dataclass(frozen=True)
class TargetResult:
    machine: str
    steps: tuple[StepResult, ...]
    cleanup_errors: tuple[str, ...] = ()

    @property
    def status(self) -> StepStatus:
        if self.cleanup_errors or any(step.status is StepStatus.FAILED for step in self.steps):
            return StepStatus.FAILED
        if any(step.status is StepStatus.CANCELLED for step in self.steps):
            return StepStatus.CANCELLED
        if any(step.status is StepStatus.BLOCKED for step in self.steps):
            return StepStatus.BLOCKED
        if self.steps and all(step.status is StepStatus.SKIPPED for step in self.steps):
            return StepStatus.SKIPPED
        return StepStatus.SUCCEEDED


@dataclass(frozen=True)
class DeploymentResult:
    cluster: str
    requested_action: str
    steps: tuple[StepResult, ...]
    targets: tuple[TargetResult, ...] = field(init=False)

    def __post_init__(self) -> None:
        machine_order: list[str] = []
        grouped: dict[str, list[StepResult]] = {}
        for step in self.steps:
            if step.machine not in grouped:
                grouped[step.machine] = []
                machine_order.append(step.machine)
            grouped[step.machine].append(step)
        object.__setattr__(
            self,
            "targets",
            tuple(TargetResult(machine, tuple(grouped[machine])) for machine in machine_order),
        )

    @property
    def succeeded(self) -> bool:
        return all(target.status in {StepStatus.SUCCEEDED, StepStatus.SKIPPED} for target in self.targets)

    @property
    def exit_code(self) -> int:
        if any(target.status is StepStatus.CANCELLED for target in self.targets):
            return 130
        if any(
            step.status is StepStatus.FAILED and step.error_category == "preflight"
            for step in self.steps
        ):
            return 3
        return 0 if self.succeeded else 4


__all__ = [
    "CommandResult",
    "DeploymentResult",
    "StepResult",
    "StepStatus",
    "TargetResult",
]
