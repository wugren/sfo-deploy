"""将完整配置转换为稳定、可审查的 sfo-deploy 串行执行计划。"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable, Mapping

from .errors import PlanningError
from .models import ClusterConfig, ExecutionPlan, PlanStep, ResolvedMachine


def resolve_machine(cluster: ClusterConfig, machine_name: str, *, executor_region: str | None = None, address_kind: str | None = None) -> ResolvedMachine:
    try:
        machine = cluster.machines[machine_name]
    except KeyError as exc:
        raise PlanningError(f"未知机器: {machine_name}") from exc
    region = executor_region or cluster.executor_region
    kind = address_kind or ("private" if machine.region == region else "public")
    if kind not in {"private", "public"}:
        raise PlanningError(f"地址类型只支持 private/public: {kind}")
    address = machine.private_ip if kind == "private" else machine.public_ip
    if not address:
        raise PlanningError(f"机器 {machine_name} 缺少要求的 {kind} IP")
    return ResolvedMachine(machine=machine, address=address, address_kind=kind)


def _topological(nodes: Iterable[str], dependencies: Mapping[str, tuple[str, ...]]) -> list[str]:
    node_set = set(nodes)
    incoming = {node: set(dependencies.get(node, ())) for node in node_set}
    for node, deps in incoming.items():
        unknown = deps - node_set
        if unknown:
            raise PlanningError(f"{node} 引用计划外依赖: {', '.join(sorted(unknown))}")
    order: list[str] = []
    ready = sorted(node for node, deps in incoming.items() if not deps)
    while ready:
        node = ready.pop(0)
        order.append(node)
        for other in sorted(incoming):
            if node in incoming[other]:
                incoming[other].remove(node)
                if not incoming[other] and other not in order and other not in ready:
                    ready.append(other)
                    ready.sort()
    if len(order) != len(node_set):
        cyclic = sorted(node_set - set(order))
        raise PlanningError(f"环境/App 依赖存在循环: {', '.join(cyclic)}")
    return order


def build_plan(
    cluster: ClusterConfig,
    action: str,
    *,
    machines: Iterable[str] | None = None,
    apps: Iterable[str] | None = None,
    environments: Iterable[str] | None = None,
    executor_region: str | None = None,
    address_kind: str | None = None,
    with_dependencies: bool = False,
) -> ExecutionPlan:
    selected_machines = set(machines or cluster.machines)
    unknown_machines = selected_machines - set(cluster.machines)
    if unknown_machines:
        raise PlanningError(f"未知机器过滤器: {', '.join(sorted(unknown_machines))}")
    # check/install are environment-only actions.  Their caller must provide an
    # environment filter; never let an omitted App filter silently select Apps.
    selected_apps = set() if action in {"check", "install"} else set(apps or cluster.apps)
    unknown_apps = selected_apps - set(cluster.apps)
    if unknown_apps:
        raise PlanningError(f"未知 App 过滤器: {', '.join(sorted(unknown_apps))}")
    env_filter = set(environments or ())

    nodes: dict[str, tuple[str, str, object]] = {}
    dependencies: dict[str, tuple[str, ...]] = {}
    for machine_name in sorted(selected_machines):
        machine = cluster.machines[machine_name]
        for env in machine.environments:
            node = f"env:{machine_name}/{env.name}"
            if env_filter and env.name not in env_filter and f"{machine_name}/{env.name}" not in env_filter:
                continue
            nodes[node] = ("environment", machine_name, env)
            dependencies[node] = tuple(
                f"env:{dep if '/' in dep else machine_name + '/' + dep}" for dep in env.depends_on
            )

    for app_name in sorted(selected_apps):
        app = cluster.apps[app_name]
        for machine_name in cluster.placements[app_name]:
            if machine_name not in selected_machines:
                continue
            node = f"app:{machine_name}/{app_name}"
            nodes[node] = ("app", machine_name, app)
            dependencies[node] = tuple(
                f"env:{dep if '/' in dep else machine_name + '/' + dep}" for dep in app.depends_on
            )

    if not nodes:
        raise PlanningError("过滤条件没有选择任何部署对象")

    check_only_environment_nodes: set[str] = set()
    if not with_dependencies and apps is not None:
        # 定向 App 默认不修改环境；保留传递依赖，并且只运行它们的 check。
        app_nodes = {key for key in nodes if key.startswith("app:")}
        pending = {
            dependency
            for node in app_nodes
            for dependency in dependencies.get(node, ())
        }
        while pending:
            dependency = pending.pop()
            if dependency in check_only_environment_nodes:
                continue
            if dependency not in nodes or not dependency.startswith("env:"):
                raise PlanningError(f"定向 App 引用计划外环境依赖: {dependency}")
            check_only_environment_nodes.add(dependency)
            pending.update(dependencies.get(dependency, ()))
        retained = app_nodes | check_only_environment_nodes
        nodes = {key: value for key, value in nodes.items() if key in retained}
        dependencies = {
            key: tuple(dependency for dependency in dependencies.get(key, ()) if dependency in retained)
            for key in nodes
        }
    else:
        required = {dep for deps in dependencies.values() for dep in deps}
        missing = required - set(nodes)
        if missing:
            raise PlanningError(f"过滤条件排除了必需依赖: {', '.join(sorted(missing))}")

    steps: list[PlanStep] = []
    step_ids_by_node: dict[str, list[str]] = defaultdict(list)
    for node in _topological(nodes, dependencies):
        kind, machine_name, resource = nodes[node]
        resolved = resolve_machine(cluster, machine_name, executor_region=executor_region, address_kind=address_kind)
        if kind == "environment":
            env = resource
            definition = cluster.environments[env.definition]
            parameters = {**definition.defaults, **env.parameters, "version": env.version, "requires_privilege": env.requires_privilege if env.requires_privilege is not None else definition.requires_privilege}
            action_sequence = (
                ("check",)
                if node in check_only_environment_nodes
                else (("check", "install", "configure") if action in {"deploy", "configure"} else (action,))
            )
            scripts = definition.scripts
            package = definition.package
            name = env.name
        else:
            app = resource
            parameters = {"version": app.version}
            action_sequence = ("configure", "deploy") if action == "deploy" else (action,)
            scripts = app.scripts
            package = app.package
            name = app.name
        for current_action in action_sequence:
            paths = scripts.actions.get(current_action, ())
            if not paths:
                if (
                    kind == "environment"
                    and current_action == "check"
                    and node not in check_only_environment_nodes
                ):
                    continue
                raise PlanningError(f"{node} 未定义动作脚本: {current_action}")
            step_id = f"{node}:{current_action}"
            prior = tuple(step_ids_by_node[node][-1:])
            dependency_steps = tuple(step_ids_by_node[dep][-1] for dep in dependencies.get(node, ()) if step_ids_by_node[dep])
            steps.append(PlanStep(
                id=step_id,
                machine=resolved,
                kind=kind,
                resource=name,
                action=current_action,
                scripts=paths,
                parameters=parameters,
                package=package,
                config_secrets=scripts.config_secrets if current_action == "configure" else (),
                file_secrets=scripts.file_secrets if current_action == "configure" else (),
                templates=scripts.templates if current_action == "configure" else (),
                depends_on=tuple(sorted({*prior, *dependency_steps})),
            ))
            step_ids_by_node[node].append(step_id)
    return ExecutionPlan(cluster=cluster.name, requested_action=action, steps=tuple(steps))
