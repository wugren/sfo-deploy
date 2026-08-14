"""sfo-deploy 环境实例解析和生命周期执行决策。

本模块只描述可复用的纯逻辑；远端脚本如何执行、结果如何采集由执行器负责。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from .errors import PlanningError
from .models import EnvironmentDefinition, EnvironmentInstance, PackageSpec


class EnvironmentCheckResult(str, Enum):
    """执行器对环境 ``check`` 动作的归一化结果。"""

    SATISFIED = "satisfied"
    UNSATISFIED = "unsatisfied"
    FAILED = "failed"


class ExecutionOutcome(str, Enum):
    """可作为依赖门输入的资源执行结果。"""

    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


class ActionCondition(str, Enum):
    """环境动作进入执行器前需要满足的条件。"""

    ALWAYS = "always"
    CHECK_UNSATISFIED = "check-unsatisfied"


class ActionDisposition(str, Enum):
    """执行器对一个动作应采取的处理。"""

    RUN = "run"
    WAIT = "wait"
    SKIP = "skip"
    BLOCKED = "blocked"


class DependencyDisposition(str, Enum):
    """当前资源相对于其依赖的可执行状态。"""

    READY = "ready"
    WAIT = "wait"
    BLOCKED = "blocked"


@dataclass(frozen=True)
class ResolvedEnvironment:
    """一个环境定义在一台机器上的完整、稳定实例。"""

    instance_id: str
    machine_name: str
    instance_name: str
    definition_name: str
    parameters: Mapping[str, Any]
    requires_privilege: bool
    depends_on: tuple[str, ...]
    package: PackageSpec | None


@dataclass(frozen=True)
class EnvironmentAction:
    """一个环境动作及其有序脚本和运行条件。"""

    name: str
    scripts: tuple[Path, ...]
    condition: ActionCondition = ActionCondition.ALWAYS


@dataclass(frozen=True)
class DependencyGate:
    """依赖评估结果；阻断原因和等待对象按身份稳定排序。"""

    disposition: DependencyDisposition
    blocked_by: tuple[str, ...] = ()
    waiting_for: tuple[str, ...] = ()


@dataclass(frozen=True)
class ActionDecision:
    """一个动作在当前执行状态下的确定决策。"""

    disposition: ActionDisposition
    blocked_by: tuple[str, ...] = ()
    waiting_for: tuple[str, ...] = ()


def resolve_environment(
    machine_name: str,
    instance: EnvironmentInstance,
    definition: EnvironmentDefinition,
) -> ResolvedEnvironment:
    """将可复用定义与机器级实例覆盖合并。

    ``version`` 和最终权限要求是框架保留参数，始终由机器实例与定义规则
    决定，避免模板默认值或普通参数覆盖改变执行含义。
    """

    if instance.definition != definition.name:
        raise PlanningError(
            f"环境实例 {machine_name}/{instance.name} 引用 {instance.definition}，"
            f"不能用定义 {definition.name} 解析"
        )

    requires_privilege = (
        instance.requires_privilege
        if instance.requires_privilege is not None
        else definition.requires_privilege
    )
    parameters = dict(definition.defaults)
    parameters.update(instance.parameters)
    parameters["version"] = instance.version
    parameters["requires_privilege"] = requires_privilege

    instance_id = f"{machine_name}/{instance.name}"
    dependencies = tuple(
        dependency if "/" in dependency else f"{machine_name}/{dependency}"
        for dependency in instance.depends_on
    )
    return ResolvedEnvironment(
        instance_id=instance_id,
        machine_name=machine_name,
        instance_name=instance.name,
        definition_name=definition.name,
        parameters=MappingProxyType(parameters),
        requires_privilege=requires_privilege,
        depends_on=dependencies,
        package=definition.package,
    )


def plan_environment_actions(
    requested_action: str,
    definition: EnvironmentDefinition,
) -> tuple[EnvironmentAction, ...]:
    """生成环境生命周期的潜在动作序列。

    ``deploy`` 和 ``configure`` 都先检查环境。存在 ``check`` 时，安装动作
    由检查结果动态决定；没有 ``check`` 时直接安装。所有实际软件操作仍
    由定义中的 Python 脚本完成。
    """

    scripts = definition.scripts.actions
    if requested_action in {"deploy", "configure"}:
        sequence: list[EnvironmentAction] = []
        has_check = bool(scripts.get("check"))
        if has_check:
            sequence.append(EnvironmentAction("check", scripts["check"]))
        sequence.append(
            EnvironmentAction(
                "install",
                _required_scripts(definition, "install"),
                ActionCondition.CHECK_UNSATISFIED if has_check else ActionCondition.ALWAYS,
            )
        )
        sequence.append(
            EnvironmentAction(
                "configure",
                _required_scripts(definition, "configure"),
            )
        )
        return tuple(sequence)

    if requested_action not in {"check", "install", "start", "stop", "restart"}:
        raise PlanningError(f"未知环境动作: {requested_action}")
    return (
        EnvironmentAction(
            requested_action,
            _required_scripts(definition, requested_action),
        ),
    )


def _required_scripts(
    definition: EnvironmentDefinition,
    action: str,
) -> tuple[Path, ...]:
    paths = definition.scripts.actions.get(action, ())
    if not paths:
        raise PlanningError(f"环境定义 {definition.name} 未定义动作脚本: {action}")
    return tuple(paths)


def evaluate_dependencies(
    dependencies: Iterable[str],
    outcomes: Mapping[str, ExecutionOutcome],
) -> DependencyGate:
    """在不执行副作用的情况下判断依赖是就绪、等待还是已阻断。

    缺失的结果按尚未完成处理。只有全部依赖成功才允许资源运行；失败、
    已阻断或取消的依赖都会阻断下游环境或 App。
    """

    dependency_ids = tuple(sorted(set(dependencies)))
    blocked = tuple(
        dependency
        for dependency in dependency_ids
        if outcomes.get(dependency) in {
            ExecutionOutcome.FAILED,
            ExecutionOutcome.BLOCKED,
            ExecutionOutcome.CANCELLED,
        }
    )
    if blocked:
        return DependencyGate(DependencyDisposition.BLOCKED, blocked_by=blocked)

    waiting = tuple(
        dependency
        for dependency in dependency_ids
        if outcomes.get(dependency, ExecutionOutcome.PENDING)
        is ExecutionOutcome.PENDING
    )
    if waiting:
        return DependencyGate(DependencyDisposition.WAIT, waiting_for=waiting)
    return DependencyGate(DependencyDisposition.READY)


def decide_environment_action(
    action: EnvironmentAction,
    *,
    dependency_gate: DependencyGate | None = None,
    check_result: EnvironmentCheckResult | None = None,
) -> ActionDecision:
    """结合依赖和 ``check`` 结果决定运行、等待、跳过或阻断动作。"""

    gate = dependency_gate or DependencyGate(DependencyDisposition.READY)
    if gate.disposition is DependencyDisposition.BLOCKED:
        return ActionDecision(
            ActionDisposition.BLOCKED,
            blocked_by=gate.blocked_by,
        )
    if gate.disposition is DependencyDisposition.WAIT:
        return ActionDecision(
            ActionDisposition.WAIT,
            waiting_for=gate.waiting_for,
        )

    if action.condition is ActionCondition.ALWAYS:
        return ActionDecision(ActionDisposition.RUN)
    if check_result is None:
        return ActionDecision(ActionDisposition.WAIT, waiting_for=("check",))
    if check_result is EnvironmentCheckResult.SATISFIED:
        return ActionDecision(ActionDisposition.SKIP)
    if check_result is EnvironmentCheckResult.UNSATISFIED:
        return ActionDecision(ActionDisposition.RUN)
    return ActionDecision(ActionDisposition.BLOCKED, blocked_by=("check",))


__all__ = [
    "ActionCondition",
    "ActionDecision",
    "ActionDisposition",
    "DependencyDisposition",
    "DependencyGate",
    "EnvironmentAction",
    "EnvironmentCheckResult",
    "ExecutionOutcome",
    "ResolvedEnvironment",
    "decide_environment_action",
    "evaluate_dependencies",
    "plan_environment_actions",
    "resolve_environment",
]
