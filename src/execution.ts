/** 稳定准备本地输入，并按目标 fail-fast、跨目标隔离执行不可变计划。 */

import { join } from "jsr:@std/path@1.1.6";
import { buildDeploymentBundle, type BuiltDeploymentBundle } from "./deployment_bundle.ts";
import { assertGzipTar, DownloadProviderRegistry, type VerifiedArtifact } from "./downloads.ts";
import { EnvironmentCheckResult } from "./environment.ts";
import { convergeEnvironmentService, installEnvironmentPackages } from "./environment_runtime.ts";
import { CancelledError, PreflightError, TransportError } from "./errors.ts";
import { generateConfigSkeleton } from "./config_generation.ts";
import type { CachePolicy, PackageCache, PackageMetadata } from "./package_cache.ts";
import {
  type ManagedConfigPublication,
  ManagedConfigPublicationError,
  REMOTE_CONFIG_UPDATER_BUNDLE_PATH,
  REMOTE_CONFIG_UPDATER_SOURCE,
  type RemoteOperationLease,
  type ScopedSecretCopy,
  type StagedDeploymentBundle,
} from "./remote_deployment.ts";
import { REMOTE_VERSIONED_RELEASE_BUNDLE_PATH } from "./remote_runtime/artifact.ts";
import { DEFAULT_KEEP_VERSIONS, MAX_KEEP_VERSIONS } from "./user_config.ts";
import {
  type CommandResult,
  DeploymentResult,
  type StepBundleResult,
  type StepRecoveryResult,
  StepResult,
  type StepServiceResult,
  StepStatus,
} from "./results.ts";
import { DEFAULT_SECRETS_DIR, ProjectBindings, Redactor } from "./secrets.ts";
import {
  convergeSystemd,
  executePreparedSystemd,
  inspectSystemd,
  type PreparedSystemdConvergence,
  prepareSystemd,
  restoreSystemd,
  type SystemdState,
} from "./service_management.ts";
import {
  cleanupVersionedRelease,
  finalizeVersionedRelease,
  type PreparedVersionedRelease,
  prepareVersionedRelease,
  restoreVersionedRelease,
  switchVersionedRelease,
} from "./versioned_release_management.ts";
import { generateSystemdUnitSkeleton, serviceUnitManagedConfig } from "./systemd_unit.ts";
import { OpenSshTransport, type RemoteSession, type Transport } from "./transport.ts";
import type {
  ExecutionPlan,
  ManagedConfigChangeAction,
  ManagedConfigFile,
  ManagedConfigTargetRoot,
  PlanStep,
  ScriptInvocation,
} from "./types.ts";

const DENO_LOADER_SOURCE = new URL("./secret_loader/deno.ts", import.meta.url).pathname;
const DENO_LOADER_REMOTE_NAME = "sfo-secret-loader.ts";
const UNSAFE_REDACTORS = new WeakSet<Redactor>();

export interface PreparedStep {
  readonly step: PlanStep;
  readonly artifact?: VerifiedArtifact;
  readonly deliveryBundle?: BuiltDeploymentBundle;
  readonly redactor: Redactor;
}

/** 一步计划步骤完成后的流式进度事件。 */
export interface StepProgress {
  readonly step: StepResult;
  readonly index: number;
  readonly total: number;
}

export type StepProgressListener = (progress: StepProgress) => void | Promise<void>;

interface PreparedDeployment {
  readonly step: PlanStep;
  readonly session: RemoteSession;
  readonly workspace: string;
  readonly lease: RemoteOperationLease;
  publications: readonly ManagedConfigPublication[];
  release?: PreparedVersionedRelease;
  systemdBefore?: SystemdState;
  systemd?: PreparedSystemdConvergence;
  systemdAttempted: boolean;
  serviceAttempted: boolean;
  ready: boolean;
  committed: boolean;
  recovered: boolean;
  recoveryFailed: boolean;
}

interface PrepareState {
  readonly resource: string;
  previousVersion?: string;
  versionRead?: boolean;
  upToDate: boolean;
  action?: "start" | "restart";
}

export class PreparedExecution implements AsyncDisposable {
  readonly plan: ExecutionPlan;
  readonly steps: ReadonlyMap<string, PreparedStep>;
  readonly localDirectory: string;
  #closed = false;

  constructor(
    plan: ExecutionPlan,
    steps: ReadonlyMap<string, PreparedStep>,
    localDirectory: string,
  ) {
    this.plan = plan;
    this.steps = new Map(steps);
    this.localDirectory = localDirectory;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async close(primary?: unknown): Promise<readonly string[]> {
    if (this.#closed) return [];
    const errors: string[] = [];
    for (const prepared of this.steps.values()) {
      if (!prepared.artifact) continue;
      try {
        await prepared.artifact.cleanup();
      } catch (cause) {
        errors.push(errorText(cause));
      }
    }
    try {
      await Deno.remove(this.localDirectory, { recursive: true });
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) errors.push(errorText(cause));
    }
    this.#closed = true;
    if (primary === undefined && errors.length > 0) {
      throw new PreflightError(`Local preparation resource cleanup failed: ${errors[0]}`);
    }
    return Object.freeze(errors);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export interface PrepareOptions {
  readonly bindings?: ProjectBindings;
  readonly downloadProviders?: DownloadProviderRegistry;
  readonly packageCache?: PackageCache;
  readonly signal?: AbortSignal;
}

/** 在首次 SSH 连接前解析并固定脚本、模板、私钥、秘密和下载工件。 */
export async function prepareExecution(
  plan: ExecutionPlan,
  options: PrepareOptions = {},
): Promise<PreparedExecution> {
  validatePlanShape(plan);
  throwIfAborted(options.signal);
  if (plan.steps.some(legacySingleVersionedDeploy)) {
    throw new PreflightError(
      "Legacy single-step versioned deploy plans cannot be replayed safely; regenerate a stage/activate plan",
    );
  }
  const downloads = options.downloadProviders ?? new DownloadProviderRegistry();
  const bindings = options.bindings ?? new ProjectBindings();
  const directory = await Deno.makeTempDir({ prefix: "sfo-deploy-prepared-" });
  await Deno.chmod(directory, 0o700);
  const prepared = new Map<string, PreparedStep>();
  const privateKeys = new Map<string, string>();
  const artifacts: VerifiedArtifact[] = [];
  const planSteps: PlanStep[] = [];
  const redactor = await operationRedactor(plan.steps, bindings);
  try {
    for (const [index, original] of normalizeVersionedSteps(plan.steps).entries()) {
      throwIfAborted(options.signal);
      if (prepared.has(original.id)) {
        throw new PreflightError(`Execution plan contains a duplicate step ID: ${original.id}`);
      }
      let stagedKey: string | undefined;
      const key = original.machine.machine.sshPrivateKey;
      if (key !== undefined) {
        stagedKey = privateKeys.get(key);
        if (!stagedKey) {
          stagedKey = join(directory, `ssh-key-${privateKeys.size}`);
          await copyStableLocalInput(key, stagedKey, "SSH private key");
          privateKeys.set(key, stagedKey);
        }
      }
      const scripts: ScriptInvocation[] = [];
      for (const [scriptIndex, invocation] of original.scripts.entries()) {
        const path = join(directory, `step-${index}-script-${scriptIndex}`);
        await copyStableLocalInput(invocation.source, path, `script for step ${original.id}`);
        scripts.push(Object.freeze({ ...invocation, source: path }));
      }
      const templates = [];
      for (const [templateIndex, template] of original.templates.entries()) {
        const path = join(directory, `step-${index}-template-${templateIndex}`);
        await copyStableLocalInput(template.source, path, `template for step ${original.id}`);
        templates.push(Object.freeze({ ...template, source: path }));
      }
      const deliveryScripts: ScriptInvocation[] = [];
      const rawDeliveryScripts = original.deliveryInputs?.scripts ?? original.bundleScripts ?? [];
      for (const [scriptIndex, invocation] of rawDeliveryScripts.entries()) {
        const path = join(directory, `step-${index}-delivery-script-${scriptIndex}`);
        await copyStableLocalInput(
          invocation.source,
          path,
          `deployment bundle script for step ${original.id}`,
        );
        deliveryScripts.push(Object.freeze({ ...invocation, source: path }));
      }
      const deliveryFiles = [];
      const rawDeliveryFiles = original.deliveryInputs?.files ??
        (original.bundleScripts === undefined ? [] : original.templates);
      for (const [fileIndex, file] of rawDeliveryFiles.entries()) {
        const path = join(directory, `step-${index}-delivery-file-${fileIndex}`);
        await copyStableLocalInput(
          file.source,
          path,
          `deployment bundle plain file for step ${original.id}`,
        );
        deliveryFiles.push(Object.freeze({ ...file, source: path }));
      }
      const machine = Object.freeze({ ...original.machine.machine, sshPrivateKey: stagedKey });
      const target = Object.freeze({ ...original.machine, machine });
      const step: PlanStep = Object.freeze({
        ...original,
        machine: target,
        scripts: Object.freeze(scripts),
        templates: Object.freeze(templates),
        deliveryInputs:
          original.deliveryInputs === undefined && original.bundleScripts === undefined
            ? undefined
            : Object.freeze({
              scripts: Object.freeze(deliveryScripts),
              files: Object.freeze(deliveryFiles),
            }),
        bundleScripts: original.bundleScripts === undefined
          ? undefined
          : Object.freeze(deliveryScripts),
        parameters: Object.freeze(structuredClone(original.parameters)),
      });
      let artifact: VerifiedArtifact | undefined;
      if (needsPackage(step)) {
        const packagePath = join(directory, `package-${index}.bin`);
        const packageValue = step.package!;
        if (options.packageCache) {
          const policy: CachePolicy = plan.requestedAction === "deploy"
            ? "local-only"
            : "remote-fallback";
          const metadata: PackageMetadata = {
            kind: step.kind,
            name: step.resource,
            version: parameterVersion(step.parameters),
            cluster: plan.cluster,
          };
          artifact = await options.packageCache.prepare(
            packageValue,
            packagePath,
            policy,
            metadata,
            options.signal,
          );
        } else {
          artifact = await downloads.fetchPackage(packageValue, packagePath, {}, options.signal);
        }
        if (step.kind === "app") {
          await assertGzipTar(artifact.path, `installer package for step ${step.id}`);
        }
        artifacts.push(artifact);
      }
      let deliveryBundle: BuiltDeploymentBundle | undefined;
      if (step.kind === "app" && step.deliveryInputs !== undefined) {
        const configs = [];
        for (const config of step.management?.configs ?? []) {
          configs.push(Object.freeze({
            skeleton: await generateConfigSkeleton(config, step.parameters),
            relativePath: configSkeletonKey(config),
            mode: 0o600,
          }));
        }
        const service = step.management?.manager?.kind === "service"
          ? step.management.manager
          : undefined;
        const unitConfig = service === undefined ? undefined : serviceUnitManagedConfig(service);
        if (unitConfig !== undefined) {
          configs.push(Object.freeze({
            skeleton: generateSystemdUnitSkeleton(
              unitConfig,
              service!,
              requiredManagedRunAs(step),
            ),
            relativePath: configSkeletonKey(unitConfig),
            mode: 0o600,
          }));
        }
        const bundleScripts = step.deliveryInputs.scripts.map((invocation) =>
          Object.freeze({
            source: invocation.source,
            relativePath: invocation.relativePath,
            mode: 0o700,
          })
        );
        if (configs.some((config) => config.skeleton.format !== "systemd")) {
          bundleScripts.push(Object.freeze({
            source: REMOTE_CONFIG_UPDATER_SOURCE,
            relativePath: REMOTE_CONFIG_UPDATER_BUNDLE_PATH,
            mode: 0o700,
          }));
        }
        deliveryBundle = await buildDeploymentBundle({
          destination: join(directory, `bundle-${index}.tar.gz`),
          package: artifact === undefined ? undefined : Object.freeze({
            source: artifact.path,
            expectedSha256: artifact.hashAlgorithm === "sha256" ? artifact.hashValue : undefined,
          }),
          scripts: bundleScripts,
          configs,
          ordinaryFiles: step.deliveryInputs.files.map((file) =>
            Object.freeze({
              source: file.source,
              relativePath: file.relativePath,
              mode: 0o600,
            })
          ),
          signal: options.signal,
        });
      }
      const runtime = step.machine.machine.scriptRuntime;
      if (runtime.kind !== "deno") {
        throw new PreflightError(
          `Step ${step.id} uses an unsupported script runtime: ${runtime.kind}`,
        );
      }
      prepared.set(
        step.id,
        Object.freeze({
          step,
          artifact,
          deliveryBundle,
          redactor,
        }),
      );
      planSteps.push(step);
    }
    const preparedPlan = Object.freeze({ ...plan, steps: Object.freeze(planSteps) });
    return new PreparedExecution(preparedPlan, prepared, directory);
  } catch (cause) {
    for (const artifact of artifacts) await artifact.cleanup().catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    throw cause;
  }
}

function environmentPrepareState(
  states: Map<string, PrepareState>,
  key: string,
  resource: string,
): PrepareState {
  let state = states.get(key);
  if (state === undefined) {
    state = { resource, upToDate: false };
    states.set(key, state);
  }
  return state;
}

export interface ExecuteOptions extends PrepareOptions {
  readonly transport?: Transport;
  readonly knownHosts?: string;
  readonly keepVersions?: number;
  readonly onStep?: StepProgressListener;
}

export class DeploymentExecutor {
  readonly transport: Transport;
  readonly bindings: ProjectBindings;
  readonly downloadProviders: DownloadProviderRegistry;
  readonly packageCache?: PackageCache;
  readonly keepVersions: number;
  readonly onStep?: StepProgressListener;

  constructor(
    transport: Transport,
    options: Omit<PrepareOptions, "signal"> & {
      readonly keepVersions?: number;
      readonly onStep?: StepProgressListener;
    } = {},
  ) {
    this.transport = transport;
    this.bindings = options.bindings ?? new ProjectBindings();
    this.downloadProviders = options.downloadProviders ?? new DownloadProviderRegistry();
    this.packageCache = options.packageCache;
    const keepVersions = options.keepVersions ?? DEFAULT_KEEP_VERSIONS;
    if (!Number.isInteger(keepVersions) || keepVersions < 1 || keepVersions > MAX_KEEP_VERSIONS) {
      throw new PreflightError(
        `keep_versions must be an integer between 1 and ${MAX_KEEP_VERSIONS}`,
      );
    }
    this.keepVersions = keepVersions;
    this.onStep = options.onStep;
  }

  async execute(plan: ExecutionPlan, signal?: AbortSignal): Promise<DeploymentResult> {
    const prepared = await prepareExecution(plan, {
      bindings: this.bindings,
      downloadProviders: this.downloadProviders,
      packageCache: this.packageCache,
      signal,
    });
    try {
      const result = await this.executePrepared(prepared, signal);
      try {
        await prepared.close();
        return result;
      } catch (cause) {
        const steps = [...result.steps];
        const byStep = new Map(steps.map((step) => [step.stepId, step]));
        if (steps.length > 0) {
          appendCleanupError(steps, byStep, steps.at(-1)!.machine, errorText(cause));
        }
        return new DeploymentResult({
          cluster: result.cluster,
          requestedAction: result.requestedAction,
          steps,
          releaseId: result.releaseId,
          sourceReleaseId: result.sourceReleaseId,
        });
      }
    } catch (cause) {
      await prepared.close(cause);
      throw cause;
    }
  }

  async executePrepared(
    prepared: PreparedExecution,
    signal?: AbortSignal,
  ): Promise<DeploymentResult> {
    if (!(prepared instanceof PreparedExecution) || prepared.closed) {
      throw new PreflightError("PreparedExecution is invalid or already closed");
    }
    const plan = prepared.plan;
    const results: StepResult[] = [];
    const byStep = new Map<string, StepResult>();
    const sessions = new Map<string, RemoteSession>();
    const sessionsWithRecoveryData = new Set<RemoteSession>();
    const failedMachines = new Set<string>();
    const runtimeChecked = new Set<string>();
    const checks = new Map<string, EnvironmentCheckResult>();
    const deployments = new Map<string, PreparedDeployment>();
    const prepareStates = new Map<string, PrepareState>();
    const prepareLastStepIndex = new Map<string, number>();
    const installCheckIds = new Set(
      plan.steps
        .filter((step) => step.kind === "environment" && step.action === "install")
        .flatMap((step) => [...step.dependsOn]),
    );
    if (plan.requestedAction === "prepare") {
      plan.steps.forEach((step, index) => {
        if (step.kind === "environment") {
          prepareLastStepIndex.set(
            `${step.machine.machine.name}\0${step.resource}`,
            index,
          );
        }
      });
    }
    let cancelled = signal?.aborted ?? false;

    try {
      for (const [index, step] of plan.steps.entries()) {
        const machineName = step.machine.machine.name;
        const prepareKey = `${machineName}\0${step.resource}`;
        const prepareState = plan.requestedAction === "prepare" &&
            step.kind === "environment"
          ? environmentPrepareState(prepareStates, prepareKey, step.resource)
          : undefined;
        const deployment = deployments.get(prepareKey);
        let result: StepResult | undefined;
        if (cancelled || signal?.aborted) {
          cancelled = true;
          result = skipped(step, "cancelled", StepStatus.CANCELLED, "User cancelled");
        } else {
          const blocked = step.dependsOn.filter((dependency) =>
            !byStep.get(dependency)?.satisfiesDependency
          );
          const externalBlockers = blocked.filter((dependency) => {
            const value = byStep.get(dependency);
            return !value || value.machine !== machineName || value.kind !== step.kind ||
              value.resource !== step.resource;
          });
          if (externalBlockers.length > 0) {
            result = skipped(
              step,
              "dependency-failed",
              StepStatus.BLOCKED,
              `Dependencies did not succeed: ${externalBlockers.join(", ")}`,
            );
          } else if (failedMachines.has(machineName)) {
            result = skipped(step, "target-fail-fast");
          } else if (blocked.length > 0) {
            result = skipped(
              step,
              "dependency-failed",
              StepStatus.BLOCKED,
              `Dependencies did not succeed: ${blocked.join(", ")}`,
            );
          } else if (
            step.kind === "environment" && step.action === "install" &&
            (checks.get(prepareKey) === EnvironmentCheckResult.SATISFIED ||
              (prepareState?.upToDate ?? false))
          ) {
            result = skipped(step, prepareState?.upToDate ? "up-to-date" : "check-satisfied");
          } else if (
            step.kind === "environment" && plan.requestedAction === "prepare" &&
            step.action === "configure" && prepareState?.upToDate
          ) {
            result = skipped(step, "up-to-date");
          } else if (
            plan.requestedAction === "prepare" && step.kind === "environment" &&
            (step.action === "start" || step.action === "restart")
          ) {
            if (prepareState?.upToDate) result = skipped(step, "up-to-date");
            else if (step.action === "start" && prepareState?.action !== "start") {
              result = skipped(step, "using-restart");
            } else if (step.action === "restart" && prepareState?.action !== "restart") {
              result = skipped(step, "using-start");
            }
          }
          if (
            result === undefined && step.action === "restart" && deployment?.committed &&
            step.management?.manager?.kind === "service"
          ) {
            result = skipped(step, "using-start");
          }
          if (result === undefined && isVersionedPhase(step, "activate")) {
            result = await activateDeployment(
              step,
              deployment,
              prepared.steps.get(step.id)!.redactor,
              signal,
            );
          }
          if (result === undefined) {
            let session = sessions.get(machineName);
            try {
              if (!session) {
                session = await this.transport.connect(step.machine, signal);
                sessions.set(machineName, session);
              }
              const acquireLock = session.acquireOperationLock;
              const releaseLock = session.releaseOperationLock;
              let operationLease: Awaited<ReturnType<NonNullable<typeof acquireLock>>> | undefined;
              try {
                if (managedLifecycleStep(step)) {
                  if (acquireLock === undefined || releaseLock === undefined) {
                    throw new PreflightError(
                      "Remote session does not support managed App target operation locks",
                    );
                  }
                  operationLease = await acquireLock.call(session, {
                    app: step.resource,
                    target: machineName,
                    timeoutMs: step.management?.manager?.kind === "service"
                      ? step.management.manager.timeoutMs
                      : 300_000,
                  }, signal);
                }
                const workspace = await session.createWorkspace(signal);
                let stagedDeployment: PreparedDeployment | undefined;
                if (isVersionedPhase(step, "stage")) {
                  stagedDeployment = {
                    step: prepared.steps.get(step.id)!.step,
                    session,
                    workspace,
                    lease: operationLease!,
                    publications: [],
                    systemdAttempted: false,
                    serviceAttempted: false,
                    ready: false,
                    committed: false,
                    recovered: false,
                    recoveryFailed: false,
                  };
                  deployments.set(prepareKey, stagedDeployment);
                  operationLease = undefined;
                }
                if (
                  prepareState !== undefined && step.action === "check" &&
                  prepareState.previousVersion === undefined
                ) {
                  prepareState.previousVersion = await session.readEnvironmentVersion(
                    step.resource,
                    signal,
                  );
                }
                if (
                  prepareState !== undefined && step.action === "install" &&
                  prepareState.versionRead !== true
                ) {
                  prepareState.previousVersion = await session.readEnvironmentVersion(
                    step.resource,
                    signal,
                  );
                  prepareState.versionRead = true;
                }
                let executionError: unknown;
                try {
                  result = await this.#executeStep(prepared.steps.get(step.id)!, {
                    index,
                    session,
                    workspace,
                    localDirectory: prepared.localDirectory,
                    runtimeChecked,
                    checks,
                    checkCanInstall: installCheckIds.has(step.id),
                    deployment: stagedDeployment,
                    signal,
                  });
                } catch (cause) {
                  executionError = cause;
                }
                try {
                  if (stagedDeployment === undefined) {
                    await session.cleanupWorkspace(workspace, signal?.aborted ? undefined : signal);
                  } else {
                    stagedDeployment.ready = result?.status === StepStatus.SUCCEEDED;
                  }
                } catch (cause) {
                  const cleanup = safeRedact(
                    prepared.steps.get(step.id)!.redactor,
                    errorText(cause),
                  );
                  if (result) result = result.withCleanupError(cleanup);
                  else if (executionError instanceof CancelledError) {
                    executionError = new CancelledError(
                      `${executionError.message}; remote workspace cleanup failed: ${cleanup}`,
                      { cause: executionError },
                    );
                  } else if (executionError !== undefined) {
                    executionError = new Error(
                      `${
                        safeRedact(prepared.steps.get(step.id)!.redactor, errorText(executionError))
                      }; ` +
                        `Remote workspace cleanup failed: ${cleanup}`,
                      { cause: executionError },
                    );
                  } else executionError = cause;
                }
                if (executionError !== undefined) throw executionError;
              } finally {
                if (operationLease !== undefined) {
                  await releaseLock!.call(session, operationLease);
                }
              }
            } catch (cause) {
              const redactor = prepared.steps.get(step.id)!.redactor;
              const safeMessage = safeRedact(redactor, errorText(cause));
              if (cause instanceof CancelledError || signal?.aborted) {
                cancelled = true;
                result = skipped(step, "cancelled", StepStatus.CANCELLED, "User cancelled");
              } else if (cause instanceof PreflightError) {
                result = failed(step, safeMessage, "preflight");
              } else {
                result = failed(step, safeMessage);
              }
            }
            if (result?.status === StepStatus.FAILED) failedMachines.add(machineName);
          }
        }
        if (!result) result = failed(step, "Executor produced no step result");
        if (prepareState !== undefined && plan.requestedAction === "prepare") {
          if (
            step.action === "install" && result.status === StepStatus.SUCCEEDED &&
            prepareState.versionRead === true
          ) {
            prepareState.action = prepareState.previousVersion === undefined ? "start" : "restart";
          }
          if (step.action === "check" && result.status === StepStatus.SUCCEEDED) {
            const currentVersion = parameterVersion(step.parameters);
            const satisfied = result.exitCode === 0;
            prepareState.upToDate = satisfied && currentVersion !== undefined &&
              prepareState.previousVersion !== undefined &&
              prepareState.previousVersion === currentVersion;
            prepareState.action = prepareState.previousVersion === undefined ? "start" : "restart";
          }
          if (
            prepareLastStepIndex.get(prepareKey) === index && !prepareState.upToDate &&
            (result.status === StepStatus.SUCCEEDED ||
              (result.status === StepStatus.SKIPPED && result.skipReason !== "up-to-date"))
          ) {
            const currentVersion = parameterVersion(step.parameters);
            const session = sessions.get(machineName);
            if (currentVersion !== undefined && session !== undefined) {
              try {
                await session.writeEnvironmentVersion(step.resource, currentVersion, signal);
              } catch (cause) {
                result = failed(
                  step,
                  `Failed to write the environment app version marker: ${errorText(cause)}`,
                  "preflight",
                );
              }
            }
          }
        }
        if (result.status === StepStatus.FAILED) failedMachines.add(machineName);
        results.push(result);
        byStep.set(step.id, result);
        if (this.onStep !== undefined) {
          await this.onStep({ step: result, index, total: plan.steps.length });
        }
      }
    } finally {
      for (const deployment of deployments.values()) {
        const recovery = !deployment.committed && !deployment.recovered
          ? await recoverDeployment(deployment)
          : undefined;
        const errors = [...recovery?.errors ?? []];
        if (deployment.recoveryFailed) {
          errors.push(`Recovery is incomplete; recovery material kept at ${deployment.workspace}`);
          try {
            if (deployment.session.preserveWorkspace === undefined) {
              sessionsWithRecoveryData.add(deployment.session);
              errors.push(
                "Remote session does not support keeping the workspace; skipping automatic session cleanup",
              );
            } else {
              deployment.session.preserveWorkspace(deployment.workspace);
            }
          } catch (cause) {
            sessionsWithRecoveryData.add(deployment.session);
            errors.push(errorText(cause));
          }
        }
        for (
          const cleanup of [
            async () => {
              if (deployment.release && !deployment.recoveryFailed) {
                await cleanupVersionedRelease(deployment.session, deployment.release);
              }
            },
            async () => {
              if (deployment.committed && deployment.publications.length) {
                await deployment.session.commitManagedConfigs!(deployment.publications);
              }
            },
            async () => {
              if (!deployment.recoveryFailed) {
                await deployment.session.cleanupWorkspace(deployment.workspace);
              }
            },
            () => deployment.session.releaseOperationLock!(deployment.lease),
          ]
        ) {
          try {
            await cleanup();
          } catch (cause) {
            errors.push(errorText(cause));
          }
        }
        const index = results.findLastIndex((result) =>
          result.machine === deployment.step.machine.machine.name &&
          result.resource === deployment.step.resource
        );
        if (index >= 0) {
          let result = results[index];
          if (recovery) result = new StepResult({ ...result, recovery: recovery.result });
          for (const error of errors) {
            result = result.withCleanupError(
              safeRedact(prepared.steps.get(deployment.step.id)!.redactor, error),
            );
          }
          results[index] = result;
          byStep.set(result.stepId, result);
        }
      }
      for (const [machineName, session] of sessions) {
        if (sessionsWithRecoveryData.has(session)) continue;
        try {
          await session.close();
        } catch (cause) {
          appendCleanupError(results, byStep, machineName, errorText(cause));
        }
      }
    }
    return new DeploymentResult({
      cluster: plan.cluster,
      requestedAction: plan.requestedAction,
      steps: results,
    });
  }

  async #executeStep(
    prepared: PreparedStep,
    options: {
      readonly index: number;
      readonly session: RemoteSession;
      readonly workspace: string;
      readonly localDirectory: string;
      readonly runtimeChecked: Set<string>;
      readonly checks: Map<string, EnvironmentCheckResult>;
      readonly checkCanInstall: boolean;
      readonly deployment?: PreparedDeployment;
      readonly signal?: AbortSignal;
    },
  ): Promise<StepResult> {
    const step = prepared.step;
    const machine = step.machine.machine;
    const runtime = machine.scriptRuntime;
    const runtimeKey = `${machine.name}\0${runtime.kind}\0${runtime.executable}`;
    const metadataRemote = `${options.workspace}/metadata-${options.index}.json`;
    if (legacySingleVersionedDeploy(step)) {
      return failed(
        step,
        "Legacy single-step versioned deploy plans cannot be replayed safely; regenerate a stage/activate plan",
        "preflight",
      );
    }
    const cleanupErrors: string[] = [];
    const outputs: CommandResult[] = [];
    const service = step.kind === "app" &&
        ["deploy", "stage", "activate", "configure", "start", "stop", "restart"].includes(
          step.action,
        )
      ? step.management?.manager?.kind === "service" ? step.management.manager : undefined
      : undefined;
    const systemService = service?.kind === "service" ? service : undefined;
    const serviceUnit = systemService === undefined
      ? undefined
      : serviceUnitManagedConfig(systemService);
    const managedConfigs = step.kind === "app" &&
        (step.action === "deploy" || step.action === "configure" || step.action === "stage" ||
          step.action === "activate")
      ? [...step.management?.configs ?? [], ...(serviceUnit ? [serviceUnit] : [])]
      : [];
    const runAs = step.kind === "app" &&
        (step.management !== undefined || step.deployment?.kind === "versioned")
      ? requiredManagedRunAs(step)
      : undefined;
    const secretNames = [...new Set([...step.secretValues, ...step.secretFiles])];
    const lifecycleSecretNames = runAs === undefined ? secretNames : [
      ...new Set([
        ...(step.lifecycleSecretValues ?? secretNames),
        ...(step.lifecycleSecretFiles ?? []),
      ]),
    ];
    const needsLegacySecrets = runAs === undefined && secretNames.length > 0;
    let secretCopyDir: string | undefined;
    let staged: StagedDeploymentBundle | undefined;
    let status = StepStatus.SUCCEEDED;
    let message: string | undefined;
    let errorCategory: string | undefined;
    let exitCode: number | undefined = 0;
    let changed: boolean | undefined;
    let serviceResult: StepServiceResult | undefined;
    let recoveryResult: StepRecoveryResult | undefined;
    let bundleResult: StepBundleResult | undefined;
    const staticCandidates: string[] = [];
    try {
      const stageBundle = options.session.stageDeploymentBundle;
      const createBuiltinCandidate = options.session.createManagedConfigCandidate;
      const publishConfigs = options.session.publishManagedConfigs;
      const restoreConfigs = options.session.restoreManagedConfigs;
      const commitConfigs = options.session.commitManagedConfigs;
      const validateIdentity = options.session.validateManagedIdentity;
      const createScopedSecrets = options.session.createScopedSecretCopy;
      const cleanupScopedSecrets = options.session.cleanupScopedSecretCopy;
      const extractAppPackage = options.session.extractAppPackage;
      if (runAs !== undefined) {
        if (
          validateIdentity === undefined || createScopedSecrets === undefined ||
          cleanupScopedSecrets === undefined
        ) {
          throw new PreflightError(
            "Remote session does not support managed App identity or per-consumer secret primitives",
          );
        }
        await validateIdentity.call(options.session, runAs, options.signal);
      }
      if (prepared.deliveryBundle !== undefined && stageBundle === undefined) {
        throw new PreflightError(
          "Remote session does not support single deployment bundle staging",
        );
      }
      if (managedConfigs.length > 0) {
        if (
          createBuiltinCandidate === undefined || publishConfigs === undefined ||
          restoreConfigs === undefined || commitConfigs === undefined
        ) {
          throw new PreflightError(
            "Remote session does not support full managed config transactions",
          );
        }
      }
      if (prepared.deliveryBundle !== undefined) {
        staged = await stageBundle!.call(options.session, prepared.deliveryBundle, {
          workspace: options.workspace,
          signal: options.signal,
        });
        bundleResult = Object.freeze({
          sha256: staged.sha256,
          size: prepared.deliveryBundle.size,
          reused: staged.reused,
        });
      }
      let extractedPackageRoot: string | undefined;
      if (
        runAs !== undefined &&
        (step.action === "deploy" || step.action === "stage") &&
        staged?.packagePath !== undefined
      ) {
        if (extractAppPackage === undefined) {
          throw new PreflightError(
            "Remote session does not support safe unpacking of the inner App package",
          );
        }
        extractedPackageRoot = (await extractAppPackage.call(options.session, {
          workspace: options.workspace,
          packagePath: staged.packagePath,
          runAs,
          signal: options.signal,
        })).root;
      }
      if (
        step.kind === "app" &&
        (step.action === "deploy" || step.action === "stage" || step.action === "activate") &&
        step.deployment?.kind === "versioned"
      ) {
        if (runAs === undefined) {
          throw new PreflightError("versioned App release is missing run_as");
        }
        if (step.installDirectory === undefined) {
          throw new PreflightError("versioned App release is missing install_directory");
        }
        await options.session.run(
          ["/usr/bin/install", "-d", "-m", "0750", "-o", runAs, "--", step.installDirectory],
          { signal: options.signal, privileged: true },
        );
      }
      if (!options.runtimeChecked.has(runtimeKey)) {
        await options.session.preflightDeno(runtime.executable, options.signal, 2);
        options.runtimeChecked.add(runtimeKey);
      }
      if (
        step.kind === "environment" && step.action === "install" &&
        step.environmentInstall?.kind === "package"
      ) {
        try {
          outputs.push(
            await installEnvironmentPackages(
              options.session,
              step.environmentInstall,
              options.signal,
            ),
          );
        } catch (cause) {
          status = StepStatus.FAILED;
          message = cause instanceof Error ? cause.message : String(cause);
          errorCategory = cause instanceof PreflightError ? "preflight" : "runtime";
        }
      }
      if (
        status === StepStatus.SUCCEEDED && step.kind === "environment" &&
        (step.action === "start" || step.action === "restart") &&
        step.environmentManager?.kind === "system"
      ) {
        try {
          await convergeEnvironmentService(
            options.session,
            step.environmentManager,
            step.action,
            options.signal,
          );
        } catch (cause) {
          status = StepStatus.FAILED;
          message = cause instanceof Error ? cause.message : String(cause);
          errorCategory = cause instanceof PreflightError ? "preflight" : "runtime";
        }
      }
      if (needsLegacySecrets) {
        const secretsDir = machine.secretsDir ?? DEFAULT_SECRETS_DIR;
        secretCopyDir = await options.session.exposeStepSecrets(
          secretNames,
          secretsDir,
          options.workspace,
          options.signal,
        );
      }
      if (lifecycleSecretNames.length > 0) {
        await options.session.uploadFile(
          DENO_LOADER_SOURCE,
          `${options.workspace}/${DENO_LOADER_REMOTE_NAME}`,
          {
            signal: options.signal,
            mode: 0o600,
          },
        );
      }
      const metadata: Record<string, unknown> = {
        machine: machine.name,
        kind: step.kind,
        resource: step.resource,
        action: step.action,
        parameters: structuredClone(step.parameters),
      };
      if (step.deployment !== undefined) metadata.deployment = step.deployment;
      if (needsPackage(step)) {
        if (!prepared.artifact) {
          throw new PreflightError(`Step ${step.id} is missing a prepared download artifact`);
        }
        const remotePackage = staged?.packagePath ??
          `${options.workspace}/package-${options.index}.bin`;
        if (staged === undefined) {
          await options.session.uploadFile(prepared.artifact.path, remotePackage, {
            signal: options.signal,
          });
        }
        metadata.package_path = extractedPackageRoot ?? remotePackage;
        if (step.package) {
          metadata.package_hash = Object.freeze({
            algorithm: step.package.hashAlgorithm,
            value: step.package.hashValue,
          });
        }
      }
      if (step.kind === "app" && step.installDirectory !== undefined) {
        metadata.install_directory = step.installDirectory;
      }
      if (step.kind === "app" && (step.action === "deploy" || step.action === "stage")) {
        if (extractedPackageRoot !== undefined) metadata.package_kind = "validated-directory";
      }
      if (step.kind === "app" && (step.action === "deploy" || step.action === "activate")) {
        metadata.keep_versions = this.keepVersions;
      }
      if (
        step.action === "configure" ||
        (step.kind === "app" && (step.action === "deploy" || step.action === "activate"))
      ) {
        const remoteTemplates: Record<string, string> = {};
        for (const [templateIndex, template] of step.templates.entries()) {
          const remote = staged?.files.get(bundleFileKey(template.relativePath)) ??
            `${options.workspace}/template-${options.index}-${templateIndex}`;
          if (staged !== undefined && !staged.files.has(bundleFileKey(template.relativePath))) {
            throw new PreflightError(
              `Deployment bundle is missing template member: ${template.relativePath}`,
            );
          }
          if (staged === undefined) {
            await options.session.uploadFile(template.source, remote, { signal: options.signal });
          }
          remoteTemplates[template.relativePath] = remote;
        }
        metadata.templates = remoteTemplates;
      }
      if (
        step.kind === "app" &&
        (step.action === "deploy" || step.action === "activate") &&
        step.bundleScripts !== undefined
      ) {
        const remoteScripts: Record<string, string> = {};
        for (const invocation of step.bundleScripts) {
          const remote = staged?.scripts.get(bundleScriptKey(invocation.relativePath));
          if (remote === undefined) {
            throw new PreflightError(
              `Deployment bundle is missing App script member: ${invocation.relativePath}`,
            );
          }
          remoteScripts[invocation.relativePath] = remote;
        }
        metadata.scripts = remoteScripts;
      }
      const metadataLocal = await Deno.makeTempFile({
        dir: options.localDirectory,
        prefix: "step-metadata-",
        suffix: ".json",
      });
      await Deno.chmod(metadataLocal, 0o600);
      await Deno.writeTextFile(metadataLocal, JSON.stringify(metadata));
      try {
        await options.session.uploadFile(metadataLocal, metadataRemote, {
          signal: options.signal,
        });
        const privileged = step.parameters.requires_privilege === true;
        if (privileged) await options.session.preflightPrivilege(options.signal);
        let invocationIndex = 0;
        const executeInvocation = async (invocation: ScriptInvocation): Promise<CommandResult> => {
          const member = staged?.scripts.get(bundleScriptKey(invocation.relativePath));
          if (staged !== undefined && member === undefined) {
            throw new PreflightError(
              `Deployment bundle is missing execution script member: ${invocation.relativePath}`,
            );
          }
          const remoteScript = member ??
            `${options.workspace}/script-${options.index}-${invocationIndex++}.ts`;
          if (member === undefined) {
            await options.session.uploadFile(invocation.source, remoteScript, {
              signal: options.signal,
              mode: 0o700,
            });
          }
          let invocationSecrets: ScopedSecretCopy | undefined;
          let command: CommandResult | undefined;
          let invocationError: unknown;
          try {
            if (runAs !== undefined && lifecycleSecretNames.length > 0) {
              invocationSecrets = await createScopedSecrets!.call(options.session, {
                workspace: options.workspace,
                sourceDirectory: machine.secretsDir ?? DEFAULT_SECRETS_DIR,
                names: lifecycleSecretNames,
                runAs,
              }, options.signal);
            }
            const invocationSecretDir = invocationSecrets?.path ?? secretCopyDir;
            command = await options.session.executeDeno(runtime.executable, remoteScript, {
              workspace: options.workspace,
              metadataPath: metadataRemote,
              secretDir: invocationSecretDir,
              permissions: invocation.permissions,
              privileged: runAs === undefined ? privileged : undefined,
              runAs,
              signal: options.signal,
            });
          } catch (cause) {
            invocationError = cause;
          }
          if (invocationSecrets !== undefined) {
            try {
              await cleanupScopedSecrets!.call(options.session, invocationSecrets);
            } catch (cleanupCause) {
              throw new TransportError("Failed to clean up App lifecycle script secret copies", {
                cause: invocationError === undefined
                  ? cleanupCause
                  : new AggregateError([invocationError, cleanupCause]),
              });
            }
          }
          if (invocationError !== undefined) throw invocationError;
          outputs.push(command!);
          exitCode = command!.exitCode;
          return command!;
        };
        for (const invocation of step.scripts) {
          const command = await executeInvocation(invocation);
          if (step.kind === "environment" && step.action === "check" && command.exitCode !== 0) {
            options.checks.set(
              `${machine.name}\0${step.resource}`,
              EnvironmentCheckResult.UNSATISFIED,
            );
            if (options.checkCanInstall) {
              message = "Environment check not satisfied; running install";
            } else {
              status = StepStatus.FAILED;
              message =
                "Environment dependency check not satisfied; targeted deployment does not install dependencies automatically, run sfo-deploy prepare first";
            }
            break;
          }
          if (command.exitCode !== 0) {
            status = StepStatus.FAILED;
            message = `Script exit code is ${command.exitCode}`;
            break;
          }
        }
        if (status === StepStatus.SUCCEEDED && step.kind === "app") {
          let publications: readonly ManagedConfigPublication[] = Object.freeze([]);
          let systemdBefore: SystemdState | undefined;
          let systemdAttempted = false;
          try {
            if (options.deployment !== undefined) {
              options.deployment.release = await prepareVersionedRelease(options.session, {
                installDirectory: step.installDirectory!,
                runAs: requiredManagedRunAs(step),
                resource: step.resource,
                version: parameterVersion(step.parameters)!,
                keepVersions: this.keepVersions,
              }, options.signal);
            }
            if (systemService !== undefined) {
              systemdBefore = await inspectSystemd(options.session, systemService, options.signal);
              if (options.deployment) options.deployment.systemdBefore = systemdBefore;
            }
            if (managedConfigs.length > 0) {
              if (staged === undefined || runAs === undefined) {
                throw new PreflightError(
                  "managed config is missing the deployment bundle or run_as",
                );
              }
              const needsUpdater = managedConfigs.some((config) => config.format !== "systemd");
              const updaterScript = needsUpdater
                ? staged.scripts.get(REMOTE_CONFIG_UPDATER_BUNDLE_PATH)
                : undefined;
              if (needsUpdater && updaterScript === undefined) {
                throw new PreflightError(
                  "Deployment bundle is missing the framework config updater",
                );
              }
              const candidates = [];
              for (const config of managedConfigs) {
                const skeletonKey = configSkeletonKey(config);
                const skeleton = staged.configSkeletons.get(skeletonKey);
                const bindings = staged.configBindings.get(`${skeletonKey}.bindings.json`);
                if (skeleton === undefined || bindings === undefined) {
                  throw new PreflightError(
                    `Deployment bundle is missing the config skeleton or bindings: ${config.name}`,
                  );
                }
                let candidate;
                if (config.format === "systemd") {
                  const candidatePath =
                    `${options.workspace}/managed-unit-candidate-${crypto.randomUUID()}`;
                  staticCandidates.push(candidatePath);
                  const copied = await options.session.run(
                    ["cp", "--", skeleton, candidatePath],
                    { signal: options.signal },
                  );
                  if (copied.exitCode !== 0) {
                    await options.session.run(["rm", "-f", "--", candidatePath]).catch(() =>
                      undefined
                    );
                    throw new TransportError(`Failed to create the ${config.name} candidate`);
                  }
                  candidate = Object.freeze({
                    name: config.name,
                    workspace: options.workspace,
                    path: candidatePath,
                  });
                } else {
                  const configSecrets = managedConfigValueSecretNames(config);
                  const scopedSecrets = await createScopedSecrets!.call(options.session, {
                    workspace: options.workspace,
                    sourceDirectory: machine.secretsDir ?? DEFAULT_SECRETS_DIR,
                    names: configSecrets,
                    runAs,
                  }, options.signal);
                  let candidateError: unknown;
                  try {
                    candidate = await createBuiltinCandidate!.call(options.session, {
                      name: config.name,
                      workspace: options.workspace,
                      updaterScript: updaterScript!,
                      denoExecutable: runtime.kind === "deno" ? runtime.executable : "deno",
                      format: config.format,
                      skeleton,
                      bindings,
                      secretDir: scopedSecrets.path,
                      secretRoot: machine.secretsDir ?? DEFAULT_SECRETS_DIR,
                      fileSecrets: managedConfigFileSecretNames(config),
                      runAs,
                      timeoutMs: systemService?.timeoutMs,
                    }, options.signal);
                  } catch (cause) {
                    candidateError = cause;
                  }
                  try {
                    await cleanupScopedSecrets!.call(options.session, scopedSecrets);
                  } catch (cleanupCause) {
                    throw new TransportError(
                      `Failed to clean up secret copies for config ${config.name}`,
                      {
                        cause: candidateError === undefined
                          ? cleanupCause
                          : new AggregateError([candidateError, cleanupCause]),
                      },
                    );
                  }
                  if (candidateError !== undefined) throw candidateError;
                }
                candidates.push(Object.freeze({
                  candidate: candidate!,
                  ...deploymentConfigTarget(
                    config.target,
                    options.deployment?.release,
                    config.targetRoot,
                  ),
                  mode: config.mode,
                  owner: config.owner,
                  group: config.group,
                  validator: config.validator,
                  runAs,
                  secretRoot: machine.secretsDir ?? DEFAULT_SECRETS_DIR,
                  secretFiles: managedConfigFileSecretNames(config),
                }));
              }
              try {
                publications = await publishConfigs!.call(
                  options.session,
                  candidates,
                  options.signal,
                );
              } catch (cause) {
                if (cause instanceof ManagedConfigPublicationError) {
                  publications = cause.publications;
                  if (options.deployment) options.deployment.publications = publications;
                }
                throw cause;
              }
              if (options.deployment) options.deployment.publications = publications;
            }
            if (managedConfigs.length > 0) {
              changed = publications.some((publication) =>
                publication.changed || publication.serviceChange
              );
            }
            if (systemService !== undefined && systemdBefore !== undefined) {
              systemdAttempted = true;
              if (options.deployment) {
                options.deployment.systemdAttempted = true;
                options.deployment.systemd = await prepareSystemd(
                  options.session,
                  systemService,
                  {
                    operation: "deploy",
                    changed: changed ?? false,
                    configAction: mergedConfigAction(managedConfigs, publications),
                    actionOverride: systemService.enabled
                      ? systemdBefore.active ? "restart" : "start"
                      : undefined,
                  },
                  systemdBefore,
                  options.signal,
                );
              } else {
                const convergence = await convergeSystemd(
                  options.session,
                  systemService,
                  {
                    operation: (step.action === "activate" ? "deploy" : step.action) as
                      | "deploy"
                      | "configure"
                      | "start"
                      | "stop"
                      | "restart",
                    changed: changed ?? false,
                    configAction: mergedConfigAction(managedConfigs, publications),
                  },
                  systemdBefore,
                  options.signal,
                );
                serviceResult = Object.freeze({
                  unit: systemService.unit,
                  action: convergence.action,
                  daemonReloaded: convergence.daemonReloaded,
                  enableAction: convergence.enableAction,
                  before: Object.freeze({
                    enabled: convergence.before.enabled,
                    active: convergence.before.active,
                  }),
                  after: Object.freeze({
                    enabled: convergence.after.enabled,
                    active: convergence.after.active,
                  }),
                });
              }
            }
          } catch (cause) {
            if (options.deployment) throw cause;
            const recoveryErrors: unknown[] = [];
            const configRecoveryAttempted = publications.some((publication) => publication.changed);
            for (const candidate of staticCandidates) {
              await options.session.run(["rm", "-f", "--", candidate], {
                signal: options.signal,
              }).catch(() => undefined);
            }
            if (configRecoveryAttempted) {
              try {
                await restoreConfigs!.call(options.session, publications);
              } catch (recovery) {
                recoveryErrors.push(recovery);
              }
            }
            if (
              systemdAttempted && systemService !== undefined && systemdBefore !== undefined
            ) {
              try {
                await restoreSystemd(
                  options.session,
                  systemService,
                  systemdBefore,
                  systemService.daemonReload,
                );
              } catch (recovery) {
                recoveryErrors.push(recovery);
              }
            }
            recoveryResult = Object.freeze({
              attempted: configRecoveryAttempted || systemdAttempted,
              succeeded: recoveryErrors.length === 0,
              configAttempted: configRecoveryAttempted,
              serviceAttempted: systemdAttempted,
            });
            if (recoveryErrors.length > 0) {
              throw new TransportError("managed App execution failed and recovery is incomplete", {
                cause: new AggregateError([cause, ...recoveryErrors]),
              });
            }
            throw cause;
          }
          if (publications.length > 0 && options.deployment === undefined) {
            try {
              await commitConfigs!.call(options.session, publications, options.signal);
            } catch (cause) {
              cleanupErrors.push(
                safeRedact(prepared.redactor, `Config backup cleanup failed: ${errorText(cause)}`),
              );
            }
            message = publications.some((publication) => publication.changed)
              ? "managed config updated"
              : "managed config unchanged";
          }
        }
        if (
          step.kind === "environment" && step.action === "check" &&
          status === StepStatus.SUCCEEDED &&
          outputs.every((output) => output.exitCode === 0)
        ) {
          options.checks.set(`${machine.name}\0${step.resource}`, EnvironmentCheckResult.SATISFIED);
          message = "Environment check satisfied";
        }
      } finally {
        try {
          await Deno.remove(metadataLocal);
        } catch (cause) {
          cleanupErrors.push(safeRedact(prepared.redactor, errorText(cause)));
        }
      }
    } catch (cause) {
      if (cause instanceof CancelledError) throw cause;
      status = StepStatus.FAILED;
      message = safeRedact(prepared.redactor, errorText(cause));
      errorCategory = cause instanceof PreflightError ? "preflight" : undefined;
      if (step.kind === "environment" && step.action === "check") {
        options.checks.set(`${machine.name}\0${step.resource}`, EnvironmentCheckResult.FAILED);
      }
    } finally {
      try {
        await options.session.removeFile(
          metadataRemote,
          options.signal?.aborted ? undefined : options.signal,
        );
      } catch (cause) {
        cleanupErrors.push(safeRedact(prepared.redactor, errorText(cause)));
      }
    }
    if (cleanupErrors.length > 0 && status === StepStatus.SUCCEEDED) status = StepStatus.FAILED;
    return new StepResult({
      stepId: step.id,
      machine: machine.name,
      kind: step.kind,
      resource: step.resource,
      action: step.action,
      status,
      exitCode,
      stdout: safeOutput(prepared.redactor, outputs.map((output) => output.stdout).join("")),
      stderr: safeOutput(prepared.redactor, outputs.map((output) => output.stderr).join("")),
      message,
      errorCategory,
      cleanupErrors,
      changed,
      service: serviceResult,
      recovery: recoveryResult,
      bundle: bundleResult,
    });
  }
}

/** Old snapshots retain their step IDs, but move preparation into stage before replay. */
function normalizeVersionedSteps(steps: readonly PlanStep[]): readonly PlanStep[] {
  const stages = new Map(
    steps.filter((step) => isVersionedPhase(step, "stage"))
      .map((step) => [`${step.machine.machine.name}\0${step.resource}`, step]),
  );
  const activations = new Map(
    steps.filter((step) => isVersionedPhase(step, "activate"))
      .map((step) => [`${step.machine.machine.name}\0${step.resource}`, step]),
  );
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps.map((step) => {
    const stage = isVersionedPhase(step, "stage");
    const activate = isVersionedPhase(step, "activate");
    if (!stage && !activate) return step;
    const peer = activations.get(`${step.machine.machine.name}\0${step.resource}`);
    const inherited = stage && step.management === undefined && peer?.management !== undefined
      ? {
        management: peer.management,
        deliveryInputs: peer.deliveryInputs,
        secretValues: peer.secretValues,
        secretFiles: peer.secretFiles,
        lifecycleSecretValues: peer.lifecycleSecretValues,
        lifecycleSecretFiles: peer.lifecycleSecretFiles,
      }
      : {};
    const dependencies = step.dependsOn.map((id) => {
      const dependency = byId.get(id);
      if (dependency === undefined) return id;
      const key = `${dependency.machine.machine.name}\0${dependency.resource}`;
      if (stage && stages.has(key)) return stages.get(key)!.id;
      if (activate && dependency.action === "restart" && activations.has(key)) {
        return activations.get(key)!.id;
      }
      return id;
    }).filter((id) => id !== step.id);
    if (activate) dependencies.push(...[...stages.values()].map((value) => value.id));
    return Object.freeze({
      ...step,
      ...inherited,
      dependsOn: Object.freeze([...new Set(dependencies)].sort()),
    });
  });
}

function legacySingleVersionedDeploy(step: PlanStep): boolean {
  return step.kind === "app" && step.action === "deploy" && step.deployment?.kind === "versioned" &&
    step.scripts.some((script) => script.relativePath === REMOTE_VERSIONED_RELEASE_BUNDLE_PATH);
}

function isVersionedPhase(step: PlanStep, action: "stage" | "activate"): boolean {
  return step.kind === "app" && step.deployment?.kind === "versioned" && step.action === action;
}

function deploymentConfigTarget(
  target: string,
  release?: PreparedVersionedRelease,
  targetRoot: ManagedConfigTargetRoot = "absolute",
): {
  readonly target: string;
  readonly releaseRoot?: string;
} {
  if (release === undefined) return { target };
  const prefix = `${release.latestPath}/`;
  const relocate = targetRoot === "current" ||
    (targetRoot === "absolute" && target.startsWith(prefix));
  if (relocate) {
    return {
      target: `${release.releasePath}/${target.slice(prefix.length)}`,
      releaseRoot: release.releasePath,
    };
  }
  return {
    target,
    ...(target.startsWith(`${release.releasePath}/`) ? { releaseRoot: release.releasePath } : {}),
  };
}

async function recoverDeployment(deployment: PreparedDeployment): Promise<{
  readonly result: StepRecoveryResult;
  readonly errors: string[];
}> {
  const errors: string[] = [];
  const configAttempted = deployment.publications.some((publication) => publication.changed);
  const releaseAttempted = deployment.release?.switched === true;
  const service = deployment.step.management?.manager?.kind === "service"
    ? deployment.step.management.manager
    : undefined;
  const serviceAttempted = deployment.systemdAttempted && service !== undefined &&
    deployment.systemdBefore !== undefined;
  for (
    const restore of [
      async () => {
        if (configAttempted) {
          await deployment.session.restoreManagedConfigs!(deployment.publications);
        }
      },
      async () => {
        if (deployment.release) {
          await restoreVersionedRelease(deployment.session, deployment.release);
        }
      },
      async () => {
        if (serviceAttempted) {
          await restoreSystemd(
            deployment.session,
            service!,
            deployment.systemdBefore!,
            service!.daemonReload,
            undefined,
            deployment.serviceAttempted && deployment.systemdBefore!.active,
          );
        }
      },
    ]
  ) {
    try {
      await restore();
    } catch (cause) {
      errors.push(errorText(cause));
    }
  }
  deployment.recovered = true;
  deployment.recoveryFailed = errors.length > 0;
  return {
    result: Object.freeze({
      attempted: configAttempted || serviceAttempted || releaseAttempted,
      succeeded: errors.length === 0,
      configAttempted,
      serviceAttempted,
    }),
    errors,
  };
}

async function activateDeployment(
  step: PlanStep,
  deployment: PreparedDeployment | undefined,
  redactor: Redactor,
  signal?: AbortSignal,
): Promise<StepResult> {
  if (deployment === undefined || !deployment.ready || deployment.release === undefined) {
    return failed(
      step,
      "versioned activate is missing a fully prepared stage transaction",
      "preflight",
    );
  }
  let serviceResult: StepServiceResult | undefined;
  try {
    throwIfAborted(signal);
    // Every remote prerequisite was completed during stage. Do not insert a remote call here.
    await switchVersionedRelease(deployment.session, deployment.release, signal);
    if (deployment.systemd !== undefined) {
      deployment.serviceAttempted = true;
      const service = deployment.step.management?.manager?.kind === "service"
        ? deployment.step.management.manager
        : undefined;
      if (service === undefined) {
        throw new PreflightError("versioned activate is missing the system service declaration");
      }
      const convergence = await executePreparedSystemd(
        deployment.session,
        service,
        deployment.systemd,
        signal,
      );
      serviceResult = Object.freeze({
        unit: service.unit,
        action: convergence.action,
        daemonReloaded: convergence.daemonReloaded,
        enableAction: convergence.enableAction,
        before: { enabled: convergence.before.enabled, active: convergence.before.active },
        after: { enabled: convergence.after.enabled, active: convergence.after.active },
      });
    }
    await finalizeVersionedRelease(deployment.session, deployment.release, signal);
    deployment.committed = true;
    return new StepResult({
      stepId: step.id,
      machine: step.machine.machine.name,
      kind: step.kind,
      resource: step.resource,
      action: step.action,
      status: StepStatus.SUCCEEDED,
      exitCode: 0,
      service: serviceResult,
      changed: deployment.publications.some((publication) =>
        publication.changed || publication.serviceChange
      ),
    });
  } catch (cause) {
    const recovery = await recoverDeployment(deployment);
    return new StepResult({
      ...failed(
        step,
        safeRedact(redactor, errorText(cause)),
        cause instanceof PreflightError ? "preflight" : undefined,
      ),
      status: cause instanceof CancelledError || signal?.aborted
        ? StepStatus.CANCELLED
        : StepStatus.FAILED,
      service: serviceResult,
      recovery: recovery.result,
      cleanupErrors: recovery.errors.map((error) => safeRedact(redactor, error)),
    });
  }
}

export async function executePlan(
  plan: ExecutionPlan,
  options: ExecuteOptions = {},
): Promise<DeploymentResult> {
  const transport = options.transport ?? new OpenSshTransport({ knownHosts: options.knownHosts });
  return await new DeploymentExecutor(transport, options).execute(plan, options.signal);
}

export async function executePrepared(
  prepared: PreparedExecution,
  transport: Transport,
  signal?: AbortSignal,
  onStep?: StepProgressListener,
): Promise<DeploymentResult> {
  return await new DeploymentExecutor(transport, { onStep }).executePrepared(prepared, signal);
}

export function needsPackage(step: PlanStep): boolean {
  return step.package !== undefined &&
    ((step.kind === "environment" && step.action === "install") ||
      (step.kind === "app" && (step.action === "deploy" || step.action === "stage")));
}

function parameterVersion(
  parameters: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = parameters.version;
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

async function operationRedactor(
  steps: readonly PlanStep[],
  bindings: ProjectBindings,
): Promise<Redactor> {
  try {
    const valueNames = [...new Set(steps.flatMap((step) => [...step.secretValues]))].sort();
    const fileNames = [...new Set(steps.flatMap((step) => [...step.secretFiles]))].sort();
    const values = await bindings.selectConfigSecrets(valueNames);
    const sensitive = Object.values(values);
    const decoder = new TextDecoder();
    for (const name of fileNames) {
      const bytes = await bindings.fileSecret(name);
      if (bytes.byteLength > 0) sensitive.push(decoder.decode(bytes));
    }
    return new Redactor(sensitive);
  } catch {
    const redactor = new Redactor();
    UNSAFE_REDACTORS.add(redactor);
    return redactor;
  }
}

function safeRedact(redactor: Redactor, text: string): string {
  try {
    return redactor.redact(text);
  } catch {
    return "";
  }
}

function safeOutput(redactor: Redactor, text: string): string {
  return UNSAFE_REDACTORS.has(redactor) ? "" : safeRedact(redactor, text);
}

function configSkeletonKey(config: ManagedConfigFile): string {
  return `${config.name}.skeleton`;
}

function bundleScriptKey(path: string): string {
  return path.startsWith("scripts/") ? path.slice("scripts/".length) : path;
}

function bundleFileKey(path: string): string {
  return path.startsWith("files/") ? path.slice("files/".length) : path;
}

function managedLifecycleStep(step: PlanStep): boolean {
  return step.kind === "app" &&
    (
      (step.management !== undefined &&
        ["deploy", "configure", "start", "stop", "restart", "rollback", "activate"].includes(
          step.action,
        )) ||
      (step.deployment?.kind === "versioned" && ["stage", "activate"].includes(step.action))
    );
}

function requiredManagedRunAs(step: PlanStep): string {
  const declared = step.management?.runAs;
  const value = step.runAs ?? declared;
  if (
    typeof value !== "string" || value === "root" ||
    !/^[a-z_][a-z0-9_-]{0,31}\$?$/u.test(value) ||
    (declared !== undefined && declared !== value)
  ) {
    throw new PreflightError(
      `managed App ${step.resource} is missing run_as or contains an inconsistent value`,
    );
  }
  return value;
}

function managedConfigValueSecretNames(config: ManagedConfigFile): readonly string[] {
  return Object.freeze(
    [...config.secretReferences.entries()]
      .filter(([, reference]) => reference.kind === "value")
      .map(([name]) => name)
      .sort(),
  );
}

function managedConfigFileSecretNames(config: ManagedConfigFile): readonly string[] {
  return Object.freeze(
    [...config.secretReferences.entries()]
      .filter(([, reference]) => reference.kind === "file")
      .map(([name]) => name)
      .sort(),
  );
}

function mergedConfigAction(
  configs: readonly ManagedConfigFile[],
  publications: readonly ManagedConfigPublication[],
): ManagedConfigChangeAction {
  const changed = new Set(
    publications.filter((publication) => publication.changed || publication.serviceChange)
      .map((publication) => publication.name),
  );
  const actions = configs.filter((config) => changed.has(config.name)).map((config) =>
    config.onChange
  );
  if (actions.includes("restart")) return "restart";
  if (actions.includes("reload")) return "reload";
  return "none";
}

async function copyStableLocalInput(
  source: string,
  destination: string,
  label: string,
): Promise<void> {
  let input: Deno.FsFile | undefined;
  let output: Deno.FsFile | undefined;
  try {
    const beforePath = await Deno.lstat(source);
    if (
      !beforePath.isFile || beforePath.isSymlink ||
      (beforePath.nlink !== null && beforePath.nlink !== 1)
    ) {
      throw new PreflightError(`${label} must be a non-symlink regular file`);
    }
    input = await Deno.open(source, { read: true });
    const before = await input.stat();
    if (!sameSnapshot(beforePath, before)) throw new PreflightError(`${label} changed while open`);
    output = await Deno.open(destination, { write: true, createNew: true, mode: 0o600 });
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const count = await input.read(buffer);
      if (count === null) break;
      let offset = 0;
      while (offset < count) offset += await output.write(buffer.subarray(offset, count));
    }
    await output.sync();
    const after = await input.stat();
    const afterPath = await Deno.lstat(source);
    if (!sameSnapshot(before, after) || !sameSnapshot(after, afterPath)) {
      throw new PreflightError(`${label} changed while pinned`);
    }
    await Deno.chmod(destination, 0o600);
  } catch (cause) {
    output?.close();
    output = undefined;
    input?.close();
    input = undefined;
    await Deno.remove(destination).catch(() => undefined);
    if (cause instanceof PreflightError) throw cause;
    throw new PreflightError(`Failed to pin ${label}`, { cause });
  } finally {
    output?.close();
    input?.close();
  }
}

function sameSnapshot(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtime?.getTime() === right.mtime?.getTime() &&
    left.ctime?.getTime() === right.ctime?.getTime();
}

function validatePlanShape(plan: ExecutionPlan): void {
  if (
    !plan || typeof plan !== "object" ||
    (plan.schemaVersion !== 3 && plan.schemaVersion !== 4) || !Array.isArray(plan.steps)
  ) {
    throw new TypeError("plan must be an ExecutionPlan with schemaVersion=3/4");
  }
}

function skipped(
  step: PlanStep,
  skipReason: string,
  status = StepStatus.SKIPPED,
  message?: string,
): StepResult {
  return new StepResult({
    stepId: step.id,
    machine: step.machine.machine.name,
    kind: step.kind,
    resource: step.resource,
    action: step.action,
    status,
    skipReason,
    message,
  });
}

function failed(step: PlanStep, message: string, errorCategory?: string): StepResult {
  return new StepResult({
    stepId: step.id,
    machine: step.machine.machine.name,
    kind: step.kind,
    resource: step.resource,
    action: step.action,
    status: StepStatus.FAILED,
    message,
    errorCategory,
  });
}

function appendCleanupError(
  results: StepResult[],
  byStep: Map<string, StepResult>,
  machine: string,
  message: string,
): void {
  for (let index = results.length - 1; index >= 0; index--) {
    if (results[index].machine !== machine) continue;
    const updated = results[index].withCleanupError(message);
    results[index] = updated;
    byStep.set(updated.stepId, updated);
    return;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError("Deployment cancelled");
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
