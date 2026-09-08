/** 命令、步骤、目标和整次部署的稳定结构化结果。 */

import type { ResourceKind } from "./types.ts";

export enum StepStatus {
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  SKIPPED = "skipped",
  BLOCKED = "blocked",
  CANCELLED = "cancelled",
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 部署包在目标节点完成校验后的无路径结果。 */
export interface StepBundleResult {
  readonly sha256: string;
  readonly size: number;
  readonly reused: boolean;
}

export interface StepServiceState {
  readonly enabled: boolean;
  readonly active: boolean;
}

/** systemd 收敛的可观察摘要；不包含命令输出或目标端路径。 */
export interface StepServiceResult {
  readonly unit: string;
  readonly action: "none" | "start" | "stop" | "reload" | "restart";
  readonly daemonReloaded: boolean;
  readonly enableAction: "none" | "enable" | "disable";
  readonly before: StepServiceState;
  readonly after: StepServiceState;
}

/** managed 失败后的有界补偿摘要。 */
export interface StepRecoveryResult {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly configAttempted: boolean;
  readonly serviceAttempted: boolean;
}

export interface StepResultOptions {
  readonly stepId: string;
  readonly machine: string;
  readonly kind: ResourceKind;
  readonly resource: string;
  readonly action: string;
  readonly status: StepStatus;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
  readonly errorCategory?: string;
  readonly skipReason?: string;
  readonly cleanupErrors?: readonly string[];
  /** 仅 managed 配置步骤存在；false 明确表示配置内容未变。 */
  readonly changed?: boolean;
  readonly service?: StepServiceResult;
  readonly recovery?: StepRecoveryResult;
  readonly bundle?: StepBundleResult;
}

export class StepResult {
  readonly stepId: string;
  readonly machine: string;
  readonly kind: ResourceKind;
  readonly resource: string;
  readonly action: string;
  readonly status: StepStatus;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message?: string;
  readonly errorCategory?: string;
  readonly skipReason?: string;
  readonly cleanupErrors: readonly string[];
  readonly changed?: boolean;
  readonly service?: StepServiceResult;
  readonly recovery?: StepRecoveryResult;
  readonly bundle?: StepBundleResult;

  constructor(options: StepResultOptions) {
    this.stepId = options.stepId;
    this.machine = options.machine;
    this.kind = options.kind;
    this.resource = options.resource;
    this.action = options.action;
    this.status = options.status;
    this.exitCode = options.exitCode;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.message = options.message;
    this.errorCategory = options.errorCategory;
    this.skipReason = options.skipReason;
    this.cleanupErrors = Object.freeze([...(options.cleanupErrors ?? [])]);
    this.changed = options.changed;
    this.service = options.service === undefined ? undefined : Object.freeze({
      ...options.service,
      before: Object.freeze({ ...options.service.before }),
      after: Object.freeze({ ...options.service.after }),
    });
    this.recovery = options.recovery === undefined
      ? undefined
      : Object.freeze({ ...options.recovery });
    this.bundle = options.bundle === undefined ? undefined : Object.freeze({ ...options.bundle });
    Object.freeze(this);
  }

  get satisfiesDependency(): boolean {
    return this.status === StepStatus.SUCCEEDED ||
      (this.status === StepStatus.SKIPPED &&
        (this.skipReason === "check-satisfied" || this.skipReason === "up-to-date" ||
          this.skipReason === "using-start" || this.skipReason === "using-restart"));
  }

  withCleanupError(message: string): StepResult {
    return new StepResult({
      ...this,
      status: this.status === StepStatus.SUCCEEDED || this.status === StepStatus.SKIPPED
        ? StepStatus.FAILED
        : this.status,
      cleanupErrors: [...this.cleanupErrors, message],
    });
  }
}

export class TargetResult {
  readonly machine: string;
  readonly steps: readonly StepResult[];
  readonly cleanupErrors: readonly string[];

  constructor(machine: string, steps: Iterable<StepResult>, cleanupErrors: Iterable<string> = []) {
    this.machine = machine;
    this.steps = Object.freeze([...steps]);
    this.cleanupErrors = Object.freeze([...cleanupErrors]);
    Object.freeze(this);
  }

  get status(): StepStatus {
    if (
      this.cleanupErrors.length > 0 || this.steps.some((step) => step.status === StepStatus.FAILED)
    ) {
      return StepStatus.FAILED;
    }
    if (this.steps.some((step) => step.status === StepStatus.CANCELLED)) {
      return StepStatus.CANCELLED;
    }
    if (this.steps.some((step) => step.status === StepStatus.BLOCKED)) return StepStatus.BLOCKED;
    if (this.steps.length > 0 && this.steps.every((step) => step.status === StepStatus.SKIPPED)) {
      return StepStatus.SKIPPED;
    }
    return StepStatus.SUCCEEDED;
  }
}

export interface DeploymentResultOptions {
  readonly cluster: string;
  readonly requestedAction: string;
  readonly steps: Iterable<StepResult>;
  readonly releaseId?: string;
  readonly sourceReleaseId?: string;
}

export class DeploymentResult {
  readonly cluster: string;
  readonly requestedAction: string;
  readonly steps: readonly StepResult[];
  readonly releaseId?: string;
  readonly sourceReleaseId?: string;
  readonly targets: readonly TargetResult[];

  constructor(options: DeploymentResultOptions) {
    this.cluster = options.cluster;
    this.requestedAction = options.requestedAction;
    this.steps = Object.freeze([...options.steps]);
    this.releaseId = options.releaseId;
    this.sourceReleaseId = options.sourceReleaseId;
    const order: string[] = [];
    const grouped = new Map<string, StepResult[]>();
    for (const step of this.steps) {
      if (!grouped.has(step.machine)) {
        order.push(step.machine);
        grouped.set(step.machine, []);
      }
      grouped.get(step.machine)!.push(step);
    }
    this.targets = Object.freeze(
      order.map((machine) => new TargetResult(machine, grouped.get(machine)!)),
    );
    Object.freeze(this);
  }

  get succeeded(): boolean {
    return this.targets.every((target) =>
      target.status === StepStatus.SUCCEEDED || target.status === StepStatus.SKIPPED
    );
  }

  get exitCode(): number {
    if (this.targets.some((target) => target.status === StepStatus.CANCELLED)) return 130;
    if (
      this.steps.some((step) =>
        step.status === StepStatus.FAILED && step.errorCategory === "preflight"
      )
    ) return 3;
    return this.succeeded ? 0 : 4;
  }
}

export interface FetchPackageResult {
  readonly app: string;
  readonly version: string;
  readonly provider: string;
  readonly status: "downloaded" | "cached";
  readonly path: string;
  readonly hashAlgorithm: string;
  readonly hashValue: string;
  readonly size: number;
}

/** fetch 动作的稳定结构化结果。 */
export class FetchResult {
  readonly cluster: string;
  readonly apps: readonly string[];
  readonly packages: readonly FetchPackageResult[];
  readonly appsWithoutPackage: readonly string[];
  readonly succeeded = true;
  readonly exitCode = 0;

  constructor(options: {
    readonly cluster: string;
    readonly apps: Iterable<string>;
    readonly packages: Iterable<FetchPackageResult>;
    readonly appsWithoutPackage: Iterable<string>;
  }) {
    this.cluster = options.cluster;
    this.apps = Object.freeze([...options.apps]);
    this.packages = Object.freeze(
      [...options.packages].map((item) => Object.freeze({ ...item })),
    );
    this.appsWithoutPackage = Object.freeze([...options.appsWithoutPackage]);
    Object.freeze(this);
  }
}

export interface MachineDenoOutcome {
  readonly machine: string;
  readonly status: "present" | "installed" | "failed";
  readonly denoPath: string;
  readonly version?: string;
  readonly errorCategory?: string;
  readonly message?: string;
  readonly cleanupErrors: readonly string[];
}

/** install-deno 动作的稳定结构化结果。 */
export class InstallDenoResult {
  readonly cluster: string;
  readonly machines: readonly MachineDenoOutcome[];
  readonly succeeded: boolean;
  readonly exitCode: number;

  constructor(options: {
    readonly cluster: string;
    readonly machines: Iterable<MachineDenoOutcome>;
  }) {
    this.cluster = options.cluster;
    this.machines = Object.freeze(
      [...options.machines].map((item) => Object.freeze({ ...item })),
    );
    const failed = this.machines.some(
      (item) => item.status === "failed" || item.cleanupErrors.length > 0,
    );
    this.succeeded = !failed;
    const preflight = this.machines.some(
      (item) => item.errorCategory === "preflight" && item.status === "failed",
    );
    this.exitCode = failed ? (preflight ? 3 : 4) : 0;
    Object.freeze(this);
  }
}

export type SecretCheckIssueKind = "missing" | "drifted" | "extra" | "bad-mode";

export interface SecretCheckIssue {
  readonly name: string;
  readonly kind: SecretCheckIssueKind;
  readonly detail?: string;
}

export interface SecretsMachineOutcome {
  readonly machine: string;
  readonly status: "succeeded" | "failed";
  readonly operation: "deploy" | "remove" | "check";
  readonly entries?: readonly { name: string; kind: string; status: "written" | "unchanged" }[];
  readonly issues?: readonly SecretCheckIssue[];
  readonly message?: string;
  readonly errorCategory?: string;
  readonly cleanupErrors: readonly string[];
}

/** secrets-deploy / secrets-check / 密钥移除动作的稳定结构化结果。 */
export class SecretsDeployResult {
  readonly cluster: string;
  readonly operation: "deploy" | "remove" | "check";
  readonly machines: readonly SecretsMachineOutcome[];
  readonly succeeded: boolean;
  readonly exitCode: number;

  constructor(options: {
    readonly cluster: string;
    readonly operation: "deploy" | "remove" | "check";
    readonly machines: Iterable<SecretsMachineOutcome>;
  }) {
    this.cluster = options.cluster;
    this.operation = options.operation;
    this.machines = Object.freeze(
      [...options.machines].map((item) => Object.freeze({ ...item })),
    );
    const failed = this.machines.some(
      (item) => item.status === "failed" || item.cleanupErrors.length > 0,
    );
    const preflight = this.machines.some(
      (item) => item.errorCategory === "preflight",
    );
    this.succeeded = !failed;
    this.exitCode = failed ? (preflight ? 3 : 4) : 0;
    Object.freeze(this);
  }
}

export function commandResult(
  exitCode: number,
  stdout = "",
  stderr = "",
): CommandResult {
  return Object.freeze({ exitCode, stdout, stderr });
}
