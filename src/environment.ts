/** 环境实例解析和生命周期执行决策；本模块不执行副作用。 */

import { PlanningError } from "./errors.ts";
import type {
  EnvironmentDefinition,
  EnvironmentInstance,
  PackageSpec,
  ScriptInvocation,
} from "./types.ts";
import { freezeArray, freezeRecord } from "./types.ts";

export enum EnvironmentCheckResult {
  SATISFIED = "satisfied",
  UNSATISFIED = "unsatisfied",
  FAILED = "failed",
}

export enum ExecutionOutcome {
  PENDING = "pending",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  BLOCKED = "blocked",
  CANCELLED = "cancelled",
}

export enum ActionCondition {
  ALWAYS = "always",
  CHECK_UNSATISFIED = "check-unsatisfied",
}

export enum ActionDisposition {
  RUN = "run",
  WAIT = "wait",
  SKIP = "skip",
  BLOCKED = "blocked",
}

export enum DependencyDisposition {
  READY = "ready",
  WAIT = "wait",
  BLOCKED = "blocked",
}

export interface ResolvedEnvironment {
  readonly instanceId: string;
  readonly machineName: string;
  readonly instanceName: string;
  readonly definitionName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly requiresPrivilege: boolean;
  readonly dependsOn: readonly string[];
  readonly package?: PackageSpec;
}

export interface EnvironmentAction {
  readonly name: string;
  readonly scripts: readonly ScriptInvocation[];
  readonly condition: ActionCondition;
}

export interface DependencyGate {
  readonly disposition: DependencyDisposition;
  readonly blockedBy: readonly string[];
  readonly waitingFor: readonly string[];
}

export interface ActionDecision {
  readonly disposition: ActionDisposition;
  readonly blockedBy: readonly string[];
  readonly waitingFor: readonly string[];
}

const EMPTY = Object.freeze([] as string[]);
const EMPTY_SCRIPTS = Object.freeze([] as ScriptInvocation[]);

function dependencyGate(
  disposition: DependencyDisposition,
  blockedBy: readonly string[] = EMPTY,
  waitingFor: readonly string[] = EMPTY,
): DependencyGate {
  return Object.freeze({ disposition, blockedBy, waitingFor });
}

function actionDecision(
  disposition: ActionDisposition,
  blockedBy: readonly string[] = EMPTY,
  waitingFor: readonly string[] = EMPTY,
): ActionDecision {
  return Object.freeze({ disposition, blockedBy, waitingFor });
}

/** 将环境定义默认值与机器级实例覆盖合并为稳定值对象。 */
export function resolveEnvironment(
  machineName: string,
  instance: EnvironmentInstance,
  definition: EnvironmentDefinition,
): ResolvedEnvironment {
  if (instance.definition !== definition.name) {
    throw new PlanningError(
      `Environment instance ${machineName}/${instance.name} references ${instance.definition}, ` +
        `which cannot be resolved with definition ${definition.name}`,
    );
  }
  const requiresPrivilege = instance.requiresPrivilege ?? definition.requiresPrivilege;
  const parameters = freezeRecord({
    ...definition.defaults,
    ...instance.parameters,
    version: instance.version,
    requires_privilege: requiresPrivilege,
  });
  return Object.freeze({
    instanceId: `${machineName}/${instance.name}`,
    machineName,
    instanceName: instance.name,
    definitionName: definition.name,
    parameters,
    requiresPrivilege,
    dependsOn: freezeArray(
      instance.dependsOn.map((dependency) =>
        dependency.includes("/") ? dependency : `${machineName}/${dependency}`
      ),
    ),
    package: definition.package,
  });
}

function requiredScripts(
  definition: EnvironmentDefinition,
  action: string,
): readonly ScriptInvocation[] {
  const scripts = definition.scripts.actions.get(action) ?? EMPTY_SCRIPTS;
  if (scripts.length === 0) {
    throw new PlanningError(
      `Environment definition ${definition.name} has no action script: ${action}`,
    );
  }
  return freezeArray(scripts);
}

/** 生成环境动作的潜在有序序列，check 结果由执行器稍后决定。 */
export function planEnvironmentActions(
  requestedAction: string,
  definition: EnvironmentDefinition,
): readonly EnvironmentAction[] {
  const scripts = definition.scripts.actions;
  if (requestedAction === "deploy" || requestedAction === "configure") {
    const sequence: EnvironmentAction[] = [];
    const checkScripts = scripts.get("check") ?? EMPTY_SCRIPTS;
    const configureScripts = scripts.get("configure") ?? EMPTY_SCRIPTS;
    const hasCheck = checkScripts.length > 0;
    if (hasCheck) {
      sequence.push(Object.freeze({
        name: "check",
        scripts: freezeArray(checkScripts),
        condition: ActionCondition.ALWAYS,
      }));
    }
    sequence.push(Object.freeze({
      name: "install",
      scripts: requiredScripts(definition, "install"),
      condition: hasCheck ? ActionCondition.CHECK_UNSATISFIED : ActionCondition.ALWAYS,
    }));
    if (configureScripts.length > 0) {
      sequence.push(Object.freeze({
        name: "configure",
        scripts: freezeArray(configureScripts),
        condition: ActionCondition.ALWAYS,
      }));
    }
    return freezeArray(sequence);
  }
  if (!["check", "install", "start", "stop", "restart"].includes(requestedAction)) {
    throw new PlanningError(`Unknown environment action: ${requestedAction}`);
  }
  return freezeArray([Object.freeze({
    name: requestedAction,
    scripts: requiredScripts(definition, requestedAction),
    condition: ActionCondition.ALWAYS,
  })]);
}

type OutcomeCollection =
  | ReadonlyMap<string, ExecutionOutcome>
  | Readonly<Record<string, ExecutionOutcome>>;

function outcomeFor(outcomes: OutcomeCollection, dependency: string): ExecutionOutcome | undefined {
  if ("get" in outcomes && typeof outcomes.get === "function") {
    return outcomes.get(dependency);
  }
  return (outcomes as Readonly<Record<string, ExecutionOutcome>>)[dependency];
}

/** 纯函数判断依赖就绪、等待或阻断；身份排序确保结果确定。 */
export function evaluateDependencies(
  dependencies: Iterable<string>,
  outcomes: OutcomeCollection,
): DependencyGate {
  const dependencyIds = [...new Set(dependencies)].sort();
  const blocked = freezeArray(dependencyIds.filter((dependency) => {
    const outcome = outcomeFor(outcomes, dependency);
    return outcome === ExecutionOutcome.FAILED ||
      outcome === ExecutionOutcome.BLOCKED ||
      outcome === ExecutionOutcome.CANCELLED;
  }));
  if (blocked.length > 0) return dependencyGate(DependencyDisposition.BLOCKED, blocked);
  const waiting = freezeArray(
    dependencyIds.filter((dependency) =>
      (outcomeFor(outcomes, dependency) ?? ExecutionOutcome.PENDING) === ExecutionOutcome.PENDING
    ),
  );
  if (waiting.length > 0) return dependencyGate(DependencyDisposition.WAIT, EMPTY, waiting);
  return dependencyGate(DependencyDisposition.READY);
}

/** 结合依赖门和 check 结果决定一个环境动作的确定处置。 */
export function decideEnvironmentAction(
  action: EnvironmentAction,
  options: {
    readonly dependencyGate?: DependencyGate;
    readonly checkResult?: EnvironmentCheckResult;
  } = {},
): ActionDecision {
  const gate = options.dependencyGate ?? dependencyGate(DependencyDisposition.READY);
  if (gate.disposition === DependencyDisposition.BLOCKED) {
    return actionDecision(ActionDisposition.BLOCKED, gate.blockedBy);
  }
  if (gate.disposition === DependencyDisposition.WAIT) {
    return actionDecision(ActionDisposition.WAIT, EMPTY, gate.waitingFor);
  }
  if (action.condition === ActionCondition.ALWAYS) return actionDecision(ActionDisposition.RUN);
  if (options.checkResult === undefined) {
    return actionDecision(ActionDisposition.WAIT, EMPTY, freezeArray(["check"]));
  }
  if (options.checkResult === EnvironmentCheckResult.SATISFIED) {
    return actionDecision(ActionDisposition.SKIP);
  }
  if (options.checkResult === EnvironmentCheckResult.UNSATISFIED) {
    return actionDecision(ActionDisposition.RUN);
  }
  return actionDecision(ActionDisposition.BLOCKED, freezeArray(["check"]));
}
