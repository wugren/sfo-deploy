/** 将完整集群配置转换为稳定、可审查的串行执行计划。 */

import { PlanningError } from "./errors.ts";
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
  ScriptInvocation,
} from "./types.ts";
import { freezeArray, freezeRecord } from "./types.ts";

export function resolveMachine(
  cluster: ClusterConfig,
  machineName: string,
  options: { readonly executorRegion?: string; readonly addressKind?: AddressKind } = {},
): ResolvedMachine {
  const machine = cluster.machines.get(machineName);
  if (!machine) throw new PlanningError(`Unknown machine: ${machineName}`);
  const region = options.executorRegion ?? cluster.executorRegion;
  const kind = options.addressKind ?? (machine.region === region ? "private" : "public");
  if (kind !== "private" && kind !== "public") {
    throw new PlanningError(`Address kind supports only private/public: ${kind}`);
  }
  const addresses = kind === "private" ? machine.privateIp : machine.publicIp;
  if (addresses.length === 0) {
    throw new PlanningError(`Machine ${machineName} has no required ${kind} IP`);
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
      throw new PlanningError(
        `${node} references dependencies outside the plan: ${unknown.join(", ")}`,
      );
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
    throw new PlanningError(`Environment/App dependency cycle: ${cyclic.join(", ")}`);
  }
  return order;
}

type EnvironmentNode = readonly ["environment", string, EnvironmentInstance];
type AppNode = readonly ["app", string, AppDefinition];
type ResourceNode = EnvironmentNode | AppNode;

function materialize(values: Iterable<string> | undefined): string[] | undefined {
  return values === undefined ? undefined : Array.from(values);
}

/** 汇总 App 配置脚本和 script manager 脚本，供重打包使用。 */
function bundleAppScripts(
  management?: AppManagementDefinition,
): readonly ScriptInvocation[] {
  const seen = new Set<string>();
  const result: ScriptInvocation[] = [];
  const groups: readonly (readonly ScriptInvocation[])[] = [
    ...(management === undefined ? [] : [management.configScripts]),
    ...(management?.manager?.kind === "script"
      ? [[management.manager.start, management.manager.stop, management.manager.restart]]
      : []),
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
      (management?.configScripts.length ?? 0) > 0 ||
      (management?.manager?.kind === "service" &&
        management.manager.unitConfig !== undefined);
  }
  return management?.manager !== undefined &&
    (action === "start" || action === "stop" || action === "restart");
}

/** start/stop/restart 只管理服务，不发布受管配置，因此不携带 config/config_scripts。 */
function lifecycleAppManagement(
  management: AppManagementDefinition | undefined,
): AppManagementDefinition | undefined {
  if (management === undefined) return undefined;
  return Object.freeze({
    manager: management.manager,
    configs: freezeArray([]),
    configScripts: freezeArray([]),
  });
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
  const activatePhase = request.activate ?? true;
  const machineValues = materialize(request.machines);
  const selectedMachines = new Set(
    machineValues && machineValues.length > 0 ? machineValues : cluster.machines.keys(),
  );
  const unknownMachines = [...selectedMachines].filter((machine) => !cluster.machines.has(machine))
    .sort();
  if (unknownMachines.length > 0) {
    throw new PlanningError(`Unknown machine filter: ${unknownMachines.join(", ")}`);
  }

  const appValues = materialize(request.apps);
  const environmentValues = materialize(request.environments);
  const selectedApps = new Set<string>();
  const stopEnvironmentOnly = action === "stop" && (environmentValues?.length ?? 0) > 0;
  if (action !== "check" && action !== "install" && action !== "prepare" && !stopEnvironmentOnly) {
    for (const app of appValues && appValues.length > 0 ? appValues : cluster.apps.keys()) {
      selectedApps.add(app);
    }
  }
  const unknownApps = [...selectedApps].filter((app) => !cluster.apps.has(app)).sort();
  if (unknownApps.length > 0) {
    throw new PlanningError(`Unknown App filter: ${unknownApps.join(", ")}`);
  }
  const environmentFilter = new Set(environmentValues ?? []);
  const appsOnlyLifecycle = (action === "start" || action === "stop" || action === "restart") &&
    environmentFilter.size === 0;

  let nodes = new Map<string, ResourceNode>();
  let dependencies = new Map<string, readonly string[]>();
  for (const machineName of [...selectedMachines].sort()) {
    const machine = cluster.machines.get(machineName)!;
    for (const environment of machine.environments) {
      if (deployAppsOnly || appsOnlyLifecycle) continue;
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
          deployAppsOnly || appsOnlyLifecycle
            ? []
            : app.dependsOn.map((dependency) =>
              `env:${dependency.includes("/") ? dependency : `${machineName}/${dependency}`}`
            ),
        ),
      );
    }
  }
  if (nodes.size === 0) throw new PlanningError("The filter selected no deployment targets");

  const checkOnlyEnvironmentNodes = new Set<string>();
  if (
    !deployAppsOnly && !appsOnlyLifecycle && !request.withDependencies && request.apps !== undefined
  ) {
    const appNodes = new Set([...nodes.keys()].filter((node) => node.startsWith("app:")));
    const pending = new Set([...appNodes].flatMap((node) => dependencies.get(node) ?? []));
    while (pending.size > 0) {
      const dependency = pending.values().next().value as string;
      pending.delete(dependency);
      if (checkOnlyEnvironmentNodes.has(dependency)) continue;
      if (!nodes.has(dependency) || !dependency.startsWith("env:")) {
        throw new PlanningError(
          `Targeted App references an environment dependency outside the plan: ${dependency}`,
        );
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
  } else if (!deployAppsOnly && !appsOnlyLifecycle) {
    const required = new Set([...dependencies.values()].flat());
    const missing = [...required].filter((dependency) => !nodes.has(dependency)).sort();
    if (missing.length > 0) {
      throw new PlanningError(`The filter excluded required dependencies: ${missing.join(", ")}`);
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
      if (!definition) {
        throw new PlanningError(
          `${node} references an unknown environment definition: ${resource.definition}`,
        );
      }
      parameters = freezeRecord({
        ...definition.defaults,
        ...resource.parameters,
        version: resource.version,
        requires_privilege: resource.requiresPrivilege ?? definition.requiresPrivilege,
      });
      const builtinEnvironment = definition.install !== undefined;
      if (checkOnlyEnvironmentNodes.has(node)) {
        actionSequence = ["check"];
      } else if (builtinEnvironment) {
        if (action === "prepare") {
          const preparesService = definition.manager === undefined ||
            definition.manager.kind !== "system" || definition.manager.startAfterInstall;
          const enablesService = definition.manager !== undefined &&
            definition.manager.kind === "system" && !definition.manager.startAfterInstall;
          const beforeStart = definition.init?.beforeStart ?? [];
          const afterStart = definition.init?.afterStart ?? [];
          actionSequence = [
            "install",
            ...(beforeStart.length > 0 ? ["before-start"] : []),
            ...(enablesService ? ["enable"] : []),
            ...(definition.manager && preparesService ? ["start", "restart"] : []),
            ...(afterStart.length > 0 ? ["after-start"] : []),
          ];
        } else if (action === "deploy" || action === "configure") {
          actionSequence = ["install"];
        } else {
          actionSequence = [action];
        }
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
      parameters = resource.packageless
        ? freezeRecord({})
        : freezeRecord({ version: resource.version });
      const configStep = (resource.management?.configScripts.length ?? 0) > 0;
      const scriptRestart = resource.management?.manager?.kind === "script";
      actionSequence = action === "deploy"
        ? resource.packageless ? ["configure"] : [
          ...(configStep ? ["configure"] : []),
          "stage",
          ...(activatePhase ? ["activate", ...(scriptRestart ? ["restart"] : [])] : []),
        ]
        : [action];
      resourceName = resource.name;
    }
    const environmentDefinition = kind === "environment"
      ? cluster.environments.get(resource.definition)!
      : undefined;
    const environmentScripts = kind === "environment" ? environmentDefinition!.scripts : undefined;
    const management = kind === "app" ? resource.management : undefined;
    const nodeStepIds = stepIdsByNode.get(node) ?? [];
    stepIdsByNode.set(node, nodeStepIds);
    for (const currentAction of actionSequence) {
      const packageValue = kind === "app" &&
          (currentAction === "activate" || currentAction === "restart")
        ? undefined
        : kind === "app"
        ? resource.package
        : environmentDefinition?.package;
      const lifecycleAppAction = kind === "app" &&
        ["start", "stop", "restart"].includes(currentAction);
      const stepManagement = lifecycleAppAction ? lifecycleAppManagement(management) : management;
      const stepAppScripts = kind === "app" ? bundleAppScripts(stepManagement) : undefined;
      let invocations = environmentScripts?.actions.get(currentAction) ?? [];
      if (kind === "environment" && currentAction === "before-start") {
        invocations = environmentDefinition?.init?.beforeStart ?? [];
      }
      if (kind === "environment" && currentAction === "after-start") {
        invocations = environmentDefinition?.init?.afterStart ?? [];
      }
      const environmentInstallValue = kind === "environment" &&
          currentAction === "install" &&
          environmentDefinition?.install !== undefined
        ? environmentDefinition.install
        : undefined;
      const environmentManagerValue = kind === "environment" &&
          environmentDefinition?.manager !== undefined &&
          (currentAction === "start" || currentAction === "restart" ||
            currentAction === "enable" ||
            (currentAction === "stop" && environmentDefinition.manager.kind === "script"))
        ? environmentDefinition.manager
        : undefined;
      if (environmentInstallValue?.kind === "script") {
        invocations = [environmentInstallValue.invocation];
      }
      if (environmentManagerValue?.kind === "script") {
        const invocation = currentAction === "start"
          ? environmentManagerValue.start
          : currentAction === "stop"
          ? environmentManagerValue.stop
          : environmentManagerValue.restart;
        if (!invocation) {
          throw new PlanningError(
            `The environment script manager snapshot for ${node} is missing the ${currentAction} call`,
          );
        }
        invocations = [invocation];
      }
      if (
        kind === "app" && currentAction !== "configure" &&
        ["start", "stop", "restart"].includes(currentAction) &&
        stepManagement?.manager?.kind === "script"
      ) {
        invocations = currentAction === "start"
          ? [stepManagement.manager.start]
          : currentAction === "stop"
          ? [stepManagement.manager.stop]
          : [stepManagement.manager.restart];
      }
      if (kind === "app" && currentAction === "configure" && invocations.length === 0) {
        invocations = stepManagement?.configScripts ?? [];
      }
      if (
        kind === "environment" && environmentDefinition?.install !== undefined &&
        currentAction === "check"
      ) {
        throw new PlanningError(
          `${node} uses the install/manager lifecycle and does not support a check step`,
        );
      }
      if (invocations.length === 0) {
        if (
          kind === "environment" && currentAction === "check" &&
          !checkOnlyEnvironmentNodes.has(node)
        ) {
          continue;
        }
        if (
          environmentInstallValue === undefined && environmentManagerValue === undefined &&
          !managedOwnsAction(stepManagement, currentAction) &&
          !(kind === "app" && resource.deployment?.kind === "versioned" &&
            (currentAction === "stage" || currentAction === "activate"))
        ) {
          throw new PlanningError(`${node} has no action script: ${currentAction}`);
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
        (currentAction === "deploy" || currentAction === "activate" || currentAction === "stage");
      const builtinPhasedStep = kind === "app" &&
        resource.deployment?.kind === "versioned" &&
        (currentAction === "stage" || currentAction === "activate");
      const managedConfiguring = kind === "app" && (configuring || appDeploy) &&
        ((stepManagement?.configs.length ?? 0) > 0 ||
          (stepManagement?.manager?.kind === "service" &&
            stepManagement.manager.unitConfig !== undefined));
      const configScriptRuns = kind === "app" && configuring &&
        (stepManagement?.configScripts.length ?? 0) > 0;
      const appScriptManagerAction = kind === "app" &&
        ["start", "stop", "restart"].includes(currentAction) &&
        stepManagement?.manager?.kind === "script";
      const builtinAppDeploy = appDeploy && resource.deployment?.kind === "versioned";
      const exposesScriptSecrets = configuring ||
        configScriptRuns ||
        (appDeploy && !builtinAppDeploy) ||
        (!builtinAppDeploy && !builtinPhasedStep && invocations.length > 0);
      const stepSecrets = exposesScriptSecrets || managedConfiguring
        ? machineScopedSecrets(cluster, machineName)
        : Object.freeze({ values: freezeArray([]), files: freezeArray([]) });
      const deliveryInputs = kind === "app" &&
          (appDeploy || builtinPhasedStep || managedConfiguring || configScriptRuns ||
            appScriptManagerAction)
        ? Object.freeze({
          scripts: stepAppScripts!,
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
        mode: kind === "app" ? resource.mode : undefined,
        deployment: kind === "app" &&
            ["deploy", "stage", "activate"].includes(currentAction)
          ? resource.deployment
          : undefined,
        management: stepManagement,
        deliveryInputs,
        bundleScripts: appDeploy || builtinPhasedStep ? stepAppScripts : undefined,
        environmentInstall: environmentInstallValue,
        environmentManager: environmentManagerValue,
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
  const isStage = (step: PlanStep) => phasedStageIds.has(step.id);
  const isActivate = (step: PlanStep) =>
    step.kind === "app" &&
    step.action === "activate" && step.deployment?.kind === "versioned";
  const byId = new Map(steps.map((step) => [step.id, step]));
  const preparedDependency = (id: string): string => {
    const dependency = byId.get(id);
    return dependency !== undefined && isActivate(dependency)
      ? `${id.slice(0, id.lastIndexOf(":"))}:stage`
      : id;
  };
  const phasedSteps = [
    ...steps.filter(isStage).map((step) =>
      Object.freeze({
        ...step,
        dependsOn: freezeArray([...new Set(step.dependsOn.map(preparedDependency))].sort()),
      })
    ),
    ...steps.filter((step) => !isStage(step) && !isActivate(step)),
    ...steps.filter(isActivate).map((step) =>
      Object.freeze({
        ...step,
        dependsOn: freezeArray([...new Set([...step.dependsOn, ...phasedStageIds])].sort()),
      })
    ),
  ];
  return Object.freeze({
    schemaVersion: 4,
    cluster: cluster.name,
    requestedAction: action,
    ...(action === "deploy" && !activatePhase ? { activate: false as const } : {}),
    steps: freezeArray(
      topological(
        phasedSteps.map((step) => step.id),
        new Map(phasedSteps.map((step) => [step.id, step.dependsOn])),
      ).map((id) => phasedSteps.find((step) => step.id === id)!),
    ),
  });
}
