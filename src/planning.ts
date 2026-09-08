/** 将完整集群配置转换为稳定、可审查的串行执行计划。 */

import { PlanningError } from "./errors.ts";
import {
  REMOTE_VERSIONED_RELEASE_BUNDLE_PATH,
  REMOTE_VERSIONED_RELEASE_SOURCE,
  VERSIONED_RELEASE_PERMISSIONS,
} from "./remote_runtime/artifact.ts";
import type {
  AddressKind,
  AppDefinition,
  AppManagementDefinition,
  ClusterConfig,
  EnvironmentInstance,
  ExecutionPlan,
  PlanRequest,
  PlanStep,
  ResolvedMachine,
  ResourceKind,
  ScriptDefinition,
  ScriptInvocation,
} from "./types.ts";
import { freezeArray, freezeRecord, immutableMap } from "./types.ts";

export function resolveMachine(
  cluster: ClusterConfig,
  machineName: string,
  options: { readonly executorRegion?: string; readonly addressKind?: AddressKind } = {},
): ResolvedMachine {
  const machine = cluster.machines.get(machineName);
  if (!machine) throw new PlanningError(`未知机器: ${machineName}`);
  const region = options.executorRegion ?? cluster.executorRegion;
  const kind = options.addressKind ?? (machine.region === region ? "private" : "public");
  if (kind !== "private" && kind !== "public") {
    throw new PlanningError(`地址类型只支持 private/public: ${kind}`);
  }
  const addresses = kind === "private" ? machine.privateIp : machine.publicIp;
  if (addresses.length === 0) {
    throw new PlanningError(`机器 ${machineName} 缺少要求的 ${kind} IP`);
  }
  return Object.freeze({
    machine,
    address: addresses[0],
    addressKind: kind,
    addresses: freezeArray(addresses),
  });
}

function topological(
  nodes: Iterable<string>,
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[] {
  const nodeSet = new Set(nodes);
  const incoming = new Map<string, Set<string>>();
  for (const node of nodeSet) {
    const dependencySet = new Set(dependencies.get(node) ?? []);
    const unknown = [...dependencySet].filter((dependency) => !nodeSet.has(dependency)).sort();
    if (unknown.length > 0) {
      throw new PlanningError(`${node} 引用计划外依赖: ${unknown.join(", ")}`);
    }
    incoming.set(node, dependencySet);
  }
  const order: string[] = [];
  const ready = [...incoming].filter(([, dependencies]) => dependencies.size === 0)
    .map(([node]) => node).sort();
  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);
    for (const other of [...incoming.keys()].sort()) {
      const otherIncoming = incoming.get(other)!;
      if (!otherIncoming.delete(node)) continue;
      if (otherIncoming.size === 0 && !order.includes(other) && !ready.includes(other)) {
        ready.push(other);
        ready.sort();
      }
    }
  }
  if (order.length !== nodeSet.size) {
    const cyclic = [...nodeSet].filter((node) => !order.includes(node)).sort();
    throw new PlanningError(`环境/App 依赖存在循环: ${cyclic.join(", ")}`);
  }
  return order;
}

type EnvironmentNode = readonly ["environment", string, EnvironmentInstance];
type AppNode = readonly ["app", string, AppDefinition];
type ResourceNode = EnvironmentNode | AppNode;

function materialize(values: Iterable<string> | undefined): string[] | undefined {
  return values === undefined ? undefined : Array.from(values);
}

/** 汇总 App 在 app.yaml scripts 中声明的全部脚本调用（按相对路径去重），供重打包使用。 */
function bundleScripts(
  scripts: ScriptDefinition,
  management?: AppManagementDefinition,
): readonly ScriptInvocation[] {
  const seen = new Set<string>();
  const result: ScriptInvocation[] = [];
  const groups: readonly (readonly ScriptInvocation[])[] = [
    ...scripts.actions.values(),
    ...(management === undefined ? [] : [...management.hooks.values()]),
  ];
  for (const invocations of groups) {
    for (const invocation of invocations) {
      if (seen.has(invocation.relativePath)) continue;
      seen.add(invocation.relativePath);
      result.push(invocation);
    }
  }
  return freezeArray(result);
}

function builtinDeploymentScripts(): readonly ScriptInvocation[] {
  return freezeArray([
    Object.freeze({
      source: REMOTE_VERSIONED_RELEASE_SOURCE,
      relativePath: REMOTE_VERSIONED_RELEASE_BUNDLE_PATH,
      permissions: VERSIONED_RELEASE_PERMISSIONS,
    }),
  ]);
}

function effectiveAppScripts(resource: AppDefinition): ScriptDefinition {
  if (resource.deployment?.kind !== "versioned" || resource.scripts.actions.has("deploy")) {
    return resource.scripts;
  }
  return Object.freeze({
    actions: immutableMap(
      new Map([
        ...resource.scripts.actions,
        ["stage", builtinDeploymentScripts()] as const,
        ["activate", builtinDeploymentScripts()] as const,
      ]),
    ),
  });
}

/** 方案 A：步骤秘密集合按机器范围推导——本机 cluster.yaml 声明的全部秘密。 */
function machineScopedSecrets(
  cluster: ClusterConfig,
  machineName: string,
): { readonly values: readonly string[]; readonly files: readonly string[] } {
  const values: string[] = [];
  const files: string[] = [];
  for (const declaration of cluster.secrets.values()) {
    if (!declaration.machines.includes(machineName)) continue;
    (declaration.kind === "file" ? files : values).push(declaration.name);
  }
  return Object.freeze({
    values: freezeArray(values.sort()),
    files: freezeArray(files.sort()),
  });
}

function managedOwnsAction(
  management: AppManagementDefinition | undefined,
  action: string,
): boolean {
  if (action === "configure") {
    return (management?.configs.length ?? 0) > 0 ||
      management?.service?.unitConfig !== undefined;
  }
  return management?.service !== undefined &&
    (action === "start" || action === "stop" || action === "restart");
}

function managedHooksForAction(
  management: AppManagementDefinition | undefined,
  action: string,
  configures: boolean,
): readonly ScriptInvocation[] {
  if (management === undefined) return [];
  const hooks: ScriptInvocation[] = [];
  const before = `before_${action}`;
  const after = `after_${action}`;
  for (const [name, invocations] of management.hooks) {
    if (name === before || name === after) hooks.push(...invocations);
    if (
      configures && action === "deploy" &&
      (name === "before_configure" || name === "after_configure")
    ) hooks.push(...invocations);
  }
  return hooks;
}

export function buildPlan(cluster: ClusterConfig, request: PlanRequest): ExecutionPlan;
export function buildPlan(
  cluster: ClusterConfig,
  action: string,
  options?: Omit<PlanRequest, "action">,
): ExecutionPlan;
export function buildPlan(
  cluster: ClusterConfig,
  actionOrRequest: string | PlanRequest,
  options: Omit<PlanRequest, "action"> = {},
): ExecutionPlan {
  const request: PlanRequest = typeof actionOrRequest === "string"
    ? { ...options, action: actionOrRequest }
    : actionOrRequest;
  const action = request.action;
  const deployAppsOnly = action === "deploy";
  const machineValues = materialize(request.machines);
  const selectedMachines = new Set(
    machineValues && machineValues.length > 0 ? machineValues : cluster.machines.keys(),
  );
  const unknownMachines = [...selectedMachines].filter((machine) => !cluster.machines.has(machine))
    .sort();
  if (unknownMachines.length > 0) {
    throw new PlanningError(`未知机器过滤器: ${unknownMachines.join(", ")}`);
  }

  const appValues = materialize(request.apps);
  const selectedApps = new Set<string>();
  if (action !== "check" && action !== "install" && action !== "prepare") {
    for (const app of appValues && appValues.length > 0 ? appValues : cluster.apps.keys()) {
      selectedApps.add(app);
    }
  }
  const unknownApps = [...selectedApps].filter((app) => !cluster.apps.has(app)).sort();
  if (unknownApps.length > 0) throw new PlanningError(`未知 App 过滤器: ${unknownApps.join(", ")}`);
  const environmentFilter = new Set(materialize(request.environments) ?? []);

  let nodes = new Map<string, ResourceNode>();
  let dependencies = new Map<string, readonly string[]>();
  for (const machineName of [...selectedMachines].sort()) {
    const machine = cluster.machines.get(machineName)!;
    for (const environment of machine.environments) {
      if (deployAppsOnly) continue;
      const node = `env:${machineName}/${environment.name}`;
      if (
        environmentFilter.size > 0 && !environmentFilter.has(environment.name) &&
        !environmentFilter.has(`${machineName}/${environment.name}`)
      ) continue;
      nodes.set(node, ["environment", machineName, environment]);
      dependencies.set(
        node,
        freezeArray(
          environment.dependsOn.map((dependency) =>
            `env:${dependency.includes("/") ? dependency : `${machineName}/${dependency}`}`
          ),
        ),
      );
    }
  }
  for (const appName of [...selectedApps].sort()) {
    const app = cluster.apps.get(appName)!;
    for (const machineName of cluster.placements.get(appName) ?? []) {
      if (!selectedMachines.has(machineName)) continue;
      const node = `app:${machineName}/${appName}`;
      nodes.set(node, ["app", machineName, app]);
      dependencies.set(
        node,
        freezeArray(
          deployAppsOnly
            ? []
            : app.dependsOn.map((dependency) =>
              `env:${dependency.includes("/") ? dependency : `${machineName}/${dependency}`}`
            ),
        ),
      );
    }
  }
  if (nodes.size === 0) throw new PlanningError("过滤条件没有选择任何部署对象");

  const checkOnlyEnvironmentNodes = new Set<string>();
  if (!deployAppsOnly && !request.withDependencies && request.apps !== undefined) {
    const appNodes = new Set([...nodes.keys()].filter((node) => node.startsWith("app:")));
    const pending = new Set([...appNodes].flatMap((node) => dependencies.get(node) ?? []));
    while (pending.size > 0) {
      const dependency = pending.values().next().value as string;
      pending.delete(dependency);
      if (checkOnlyEnvironmentNodes.has(dependency)) continue;
      if (!nodes.has(dependency) || !dependency.startsWith("env:")) {
        throw new PlanningError(`定向 App 引用计划外环境依赖: ${dependency}`);
      }
      checkOnlyEnvironmentNodes.add(dependency);
      for (const transitive of dependencies.get(dependency) ?? []) pending.add(transitive);
    }
    const retained = new Set([...appNodes, ...checkOnlyEnvironmentNodes]);
    nodes = new Map([...nodes].filter(([key]) => retained.has(key)));
    dependencies = new Map([...nodes.keys()].map((key) => [
      key,
      freezeArray((dependencies.get(key) ?? []).filter((dependency) => retained.has(dependency))),
    ]));
  } else if (!deployAppsOnly) {
    const required = new Set([...dependencies.values()].flat());
    const missing = [...required].filter((dependency) => !nodes.has(dependency)).sort();
    if (missing.length > 0) {
      throw new PlanningError(`过滤条件排除了必需依赖: ${missing.join(", ")}`);
    }
  }

  const steps: PlanStep[] = [];
  const stepIdsByNode = new Map<string, string[]>();
  for (const node of topological(nodes.keys(), dependencies)) {
    const [kind, machineName, resource] = nodes.get(node)!;
    const resolved = resolveMachine(cluster, machineName, {
      executorRegion: request.executorRegion,
      addressKind: request.addressKind,
    });
    let parameters: Readonly<Record<string, unknown>>;
    let actionSequence: readonly string[];
    let resourceName: string;
    if (kind === "environment") {
      const definition = cluster.environments.get(resource.definition);
      if (!definition) throw new PlanningError(`${node} 引用未知环境定义: ${resource.definition}`);
      parameters = freezeRecord({
        ...definition.defaults,
        ...resource.parameters,
        version: resource.version,
        requires_privilege: resource.requiresPrivilege ?? definition.requiresPrivilege,
      });
      if (checkOnlyEnvironmentNodes.has(node)) {
        actionSequence = ["check"];
      } else if (action === "deploy" || action === "configure") {
        actionSequence = [
          "check",
          "install",
          ...(cluster.environments.get(resource.definition)?.scripts.actions.get("configure")
              ?.length
            ? ["configure"]
            : []),
        ];
      } else if (action === "prepare") {
        actionSequence = [
          "check",
          "install",
          ...(definition.scripts.actions.get("configure")?.length ? ["configure"] : []),
        ];
        if ((definition.scripts.actions.get("start")?.length ?? 0) > 0) {
          actionSequence = [...actionSequence, "start"];
        }
        if ((definition.scripts.actions.get("restart")?.length ?? 0) > 0) {
          actionSequence = [...actionSequence, "restart"];
        }
      } else {
        actionSequence = [action];
      }
      resourceName = resource.name;
    } else {
      const builtinPhased = action === "deploy" &&
        resource.deployment?.kind === "versioned" &&
        !resource.scripts.actions.has("deploy");
      parameters = resource.packageless
        ? freezeRecord({})
        : freezeRecord({ version: resource.version });
      actionSequence = action === "deploy"
        ? resource.packageless ? ["check", "configure"] : builtinPhased
          ? [
            "stage",
            "activate",
            ...(resource.management?.service !== undefined ? ["restart"] : []),
          ]
          : [
            ...(resource.scripts.actions.get("configure")?.length ? ["configure"] : []),
            "deploy",
          ]
        : [action];
      resourceName = resource.name;
    }
    const definition = kind === "environment"
      ? cluster.environments.get(resource.definition)!
      : resource;
    const scriptDefinition = kind === "app" ? effectiveAppScripts(resource) : definition.scripts;
    const management = kind === "app" ? resource.management : undefined;
    const allAppScripts = kind === "app" ? bundleScripts(scriptDefinition, management) : undefined;
    const nodeStepIds = stepIdsByNode.get(node) ?? [];
    stepIdsByNode.set(node, nodeStepIds);
    for (const currentAction of actionSequence) {
      const packageValue = kind === "app" &&
          (currentAction === "activate" || currentAction === "restart")
        ? undefined
        : definition.package;
      const stepManagement = kind === "app" && currentAction === "stage" ? undefined : management;
      const invocations = scriptDefinition.actions.get(currentAction) ?? [];
      if (invocations.length === 0) {
        if (
          kind === "environment" && currentAction === "check" &&
          !checkOnlyEnvironmentNodes.has(node)
        ) {
          continue;
        }
        if (!managedOwnsAction(stepManagement, currentAction)) {
          throw new PlanningError(`${node} 未定义动作脚本: ${currentAction}`);
        }
      }
      const stepId = `${node}:${currentAction}`;
      const prior = nodeStepIds.slice(-1);
      const dependencySteps = (dependencies.get(node) ?? []).flatMap((dependency) => {
        const values = stepIdsByNode.get(dependency) ?? [];
        return values.slice(-1);
      });
      const configuring = currentAction === "configure";
      const appDeploy = kind === "app" &&
        (currentAction === "deploy" || currentAction === "activate");
      const builtinPhasedStep = kind === "app" &&
        resource.deployment?.kind === "versioned" &&
        (currentAction === "stage" || currentAction === "activate");
      const managedConfiguring = kind === "app" && (configuring || appDeploy) &&
        ((stepManagement?.configs.length ?? 0) > 0 ||
          stepManagement?.service?.unitConfig !== undefined);
      const managedHookActions = kind === "app"
        ? managedHooksForAction(management, currentAction, managedConfiguring)
        : [];
      const builtinAppDeploy = appDeploy && resource.deployment?.kind === "versioned";
      const exposesScriptSecrets = configuring ||
        (appDeploy && !builtinAppDeploy) ||
        (!builtinAppDeploy && !builtinPhasedStep && invocations.length > 0) ||
        managedHookActions.length > 0;
      const stepSecrets = exposesScriptSecrets || managedConfiguring
        ? machineScopedSecrets(cluster, machineName)
        : Object.freeze({ values: freezeArray([]), files: freezeArray([]) });
      const deliveryInputs = kind === "app" &&
          (appDeploy || builtinPhasedStep || managedConfiguring ||
            (stepManagement?.hooks.size ?? 0) > 0)
        ? Object.freeze({
          scripts: allAppScripts!,
          files: freezeArray([]),
        })
        : undefined;
      steps.push(Object.freeze({
        id: stepId,
        machine: resolved,
        kind: kind as ResourceKind,
        resource: resourceName,
        action: currentAction,
        scripts: freezeArray(invocations),
        parameters,
        package: packageValue,
        secretValues: stepSecrets.values,
        secretFiles: stepSecrets.files,
        lifecycleSecretValues: stepManagement === undefined
          ? undefined
          : freezeArray(exposesScriptSecrets ? stepSecrets.values : []),
        lifecycleSecretFiles: stepManagement === undefined
          ? undefined
          : freezeArray(exposesScriptSecrets ? stepSecrets.files : []),
        templates: freezeArray([]),
        installDirectory: kind === "app" && currentAction !== "restart"
          ? resource.installDirectory
          : undefined,
        runAs: kind === "app" ? resource.management?.runAs : undefined,
        deployment: kind === "app" && currentAction !== "restart" ? resource.deployment : undefined,
        management: stepManagement,
        deliveryInputs,
        bundleScripts: appDeploy || builtinPhasedStep ? allAppScripts : undefined,
        dependsOn: freezeArray([...new Set([...prior, ...dependencySteps])].sort()),
      }));
      nodeStepIds.push(stepId);
    }
  }
  const phasedStageIds = new Set(
    steps.filter((step) =>
      step.kind === "app" && step.action === "stage" &&
      step.deployment?.kind === "versioned"
    ).map((step) => step.id),
  );
  const phasedActivateIds = new Set(
    steps.filter((step) =>
      step.kind === "app" && step.action === "activate" &&
      step.deployment?.kind === "versioned"
    ).map((step) => step.id),
  );
  const phasedSteps = [
    ...steps.filter((step) =>
      step.kind === "app" && step.action === "stage" && step.deployment?.kind === "versioned"
    ),
    ...steps.filter((step) =>
      !(step.kind === "app" &&
        (step.action === "stage" || step.action === "activate" ||
          (step.action === "restart" && step.management?.service !== undefined)))
    ),
    ...steps.filter((step) =>
      step.kind === "app" && step.action === "activate" &&
      step.deployment?.kind === "versioned"
    ).map((step) =>
      Object.freeze({
        ...step,
        dependsOn: freezeArray([...new Set([...step.dependsOn, ...phasedStageIds])].sort()),
      })
    ),
    ...steps.filter((step) =>
      step.kind === "app" && step.action === "restart" &&
      step.management?.service !== undefined
    ).map((step) =>
      Object.freeze({
        ...step,
        dependsOn: freezeArray([
          ...new Set([...step.dependsOn, ...phasedActivateIds]),
        ].sort()),
      })
    ),
  ];
  return Object.freeze({
    schemaVersion: 4,
    cluster: cluster.name,
    requestedAction: action,
    steps: freezeArray(phasedSteps),
  });
}
