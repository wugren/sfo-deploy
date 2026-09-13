/** sfo-deploy public project-binding API and side-effect orchestration. */

import { join, resolve } from "jsr:@std/path@1.1.6";
import { loadCluster, NAME_RE } from "./config.ts";
import { assertGzipTar, type DownloadProvider, DownloadProviderRegistry } from "./downloads.ts";
import {
  CancelledError,
  ConfigurationError,
  DownloadError,
  ExecutionError,
  PlanningError,
  PreflightError,
  TransportError,
} from "./errors.ts";
import {
  executePlan,
  executePrepared,
  needsPackage,
  prepareExecution,
  type StepProgress,
} from "./execution.ts";
import {
  deriveRollbackPlan,
  type PendingRelease,
  ReleaseHistoryResult,
  type ReleaseOperation,
  type ReleaseRecord,
  ReleaseSelection,
  ReleaseStore,
} from "./history.ts";
import { PackageCache } from "./package_cache.ts";
import { DEFAULT_KEEP_VERSIONS, MAX_KEEP_VERSIONS } from "./user_config.ts";
import { buildPlan, resolveMachine } from "./planning.ts";
import {
  DeploymentResult,
  type FetchPackageResult,
  FetchResult,
  InstallDenoResult,
  type MachineDenoOutcome,
  type SecretCheckIssue,
  SecretsDeployResult,
  type SecretsMachineOutcome,
  type StepResult,
} from "./results.ts";
import {
  DEFAULT_DENO_INSTALL_ROOT,
  installDenoOnMachine,
  normalizeDenoVersion,
  validateInstallTo,
} from "./ssh_install.ts";
import {
  declaredSecretNamesForMachine,
  DEFAULT_SECRETS_DIR,
  loadClusterSecretSource,
  prepareSecretDeployments,
  ProjectBindings,
  SECRET_NAME_RE,
} from "./secrets.ts";
import {
  OpenSshTransport,
  type RemoteSecretState,
  type RemoteSession,
  type Transport,
} from "./transport.ts";
import type { AddressKind, ClusterConfig, ExecutionPlan } from "./types.ts";

export async function discoverClusterKnownHosts(
  clusterDirectory: string,
): Promise<string | undefined> {
  const path = join(clusterDirectory, "known_hosts");
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return undefined;
    throw new PreflightError(`Failed to read cluster known_hosts ${path}`, { cause });
  }
  if (!info.isFile || info.isSymlink) {
    throw new PreflightError(`Cluster known_hosts must be a regular file: ${path}`);
  }
  return path;
}

export const CLI_ACTIONS: readonly [
  "validate",
  "plan",
  "check",
  "install",
  "configure",
  "prepare",
  "deploy",
  "fetch",
  "start",
  "stop",
  "restart",
  "history",
  "rollback",
  "install-deno",
  "secrets-deploy",
] = Object.freeze(
  [
    "validate",
    "plan",
    "check",
    "install",
    "configure",
    "prepare",
    "deploy",
    "fetch",
    "start",
    "stop",
    "restart",
    "history",
    "rollback",
    "install-deno",
    "secrets-deploy",
  ] as const,
);

export type CliAction = typeof CLI_ACTIONS[number];

const HISTORY_ACTIONS = new Set<CliAction>(["history", "rollback"]);
const RECORDED_LIFECYCLE_ACTIONS = new Set<CliAction>([
  "configure",
  "start",
  "stop",
  "restart",
]);

export interface RunOptionsInit {
  readonly configRoot: string | URL;
  readonly cluster: string;
  readonly action: CliAction;
  readonly machines?: Iterable<string>;
  readonly apps?: Iterable<string>;
  readonly environments?: Iterable<string>;
  readonly executorRegion?: string;
  readonly addressKind?: AddressKind;
  readonly withDependencies?: boolean;
  readonly releaseId?: string;
  readonly denoVersion?: string;
  readonly installTo?: string;
  readonly removeNames?: Iterable<string>;
  readonly check?: boolean;
}

/** Validated, CWD-independent inputs for one framework invocation. */
export class RunOptions {
  readonly configRoot: string;
  readonly cluster: string;
  readonly action: CliAction;
  readonly machines: readonly string[];
  readonly apps: readonly string[];
  readonly environments: readonly string[];
  readonly executorRegion?: string;
  readonly addressKind?: AddressKind;
  readonly withDependencies: boolean;
  readonly releaseId?: string;
  readonly denoVersion?: string;
  readonly installTo?: string;
  readonly removeNames: readonly string[];
  readonly check: boolean;

  constructor(options: RunOptionsInit) {
    const rawRoot = options.configRoot instanceof URL
      ? fileUrlPath(options.configRoot, "config root")
      : options.configRoot;
    if (typeof rawRoot !== "string" || rawRoot.length === 0) {
      throw new ConfigurationError("Config root must be a non-empty path");
    }
    if (typeof options.cluster !== "string" || !NAME_RE.test(options.cluster)) {
      throw new ConfigurationError(
        `Invalid cluster selection name: ${JSON.stringify(options.cluster)}`,
      );
    }
    if (!(CLI_ACTIONS as readonly string[]).includes(options.action)) {
      throw new ConfigurationError(`Unsupported CLI action: ${JSON.stringify(options.action)}`);
    }
    if (
      options.addressKind !== undefined && options.addressKind !== "private" &&
      options.addressKind !== "public"
    ) {
      throw new ConfigurationError(
        `Address kind supports only private/public: ${JSON.stringify(options.addressKind)}`,
      );
    }
    const machines = uniqueNames(options.machines ?? [], "machine");
    const apps = uniqueNames(options.apps ?? [], "app");
    const environments = uniqueNames(options.environments ?? [], "environment", true);
    const withDependencies = options.withDependencies ?? false;
    const removeNames: string[] = [];
    for (const rawName of options.removeNames ?? []) {
      if (typeof rawName !== "string" || rawName.length === 0) {
        throw new ConfigurationError("--remove requires a non-empty secret name");
      }
      if (removeNames.includes(rawName)) {
        throw new ConfigurationError(`--remove secret name is duplicated: ${rawName}`);
      }
      const name = rawName;
      if (!SECRET_NAME_RE.test(name)) {
        throw new ConfigurationError(`Invalid --remove secret name: ${JSON.stringify(name)}`);
      }
      removeNames.push(name);
    }
    const check = options.check ?? false;
    if (typeof check !== "boolean") throw new ConfigurationError("check must be a boolean");
    if (options.action === "secrets-deploy" && check && removeNames.length > 0) {
      throw new ConfigurationError("secrets-deploy --check cannot be combined with --remove");
    }
    if (typeof withDependencies !== "boolean") {
      throw new ConfigurationError("withDependencies must be a boolean");
    }
    if (HISTORY_ACTIONS.has(options.action)) {
      if (
        machines.length > 0 || apps.length > 0 || environments.length > 0 ||
        options.executorRegion !== undefined || options.addressKind !== undefined ||
        withDependencies
      ) {
        throw new ConfigurationError(
          `${options.action} cannot be combined with machine, App, environment, executor region, address kind, or dependency filters`,
        );
      }
      if (
        options.releaseId !== undefined &&
        (typeof options.releaseId !== "string" || options.releaseId.length === 0)
      ) {
        throw new ConfigurationError("Release ID must be a non-empty string");
      }
      if (options.action === "rollback" && options.releaseId === undefined) {
        throw new ConfigurationError("rollback requires a release ID");
      }
    } else if (options.releaseId !== undefined) {
      throw new ConfigurationError(`Action ${options.action} does not support a release ID`);
    }
    if (options.action === "fetch") {
      if (
        machines.length > 0 || environments.length > 0 ||
        options.executorRegion !== undefined || options.addressKind !== undefined ||
        withDependencies
      ) {
        throw new ConfigurationError(
          "fetch supports only --app filtering and cannot be combined with machine, environment, region, address, or dependency filters",
        );
      }
    }
    if (
      (options.action === "check" || options.action === "install" ||
        options.action === "prepare") && apps.length > 0
    ) {
      throw new ConfigurationError(
        `Environment action ${options.action} cannot be combined with --app`,
      );
    }
    if (options.action === "install-deno") {
      if (apps.length > 0 || environments.length > 0 || withDependencies) {
        throw new ConfigurationError(
          "install-deno supports only --machine filtering and cannot be combined with --app, --environment, or --with-dependencies",
        );
      }
      if (
        options.denoVersion !== undefined &&
        (typeof options.denoVersion !== "string" || options.denoVersion.length === 0)
      ) {
        throw new ConfigurationError("--deno-version must be a non-empty string");
      }
      if (
        options.installTo !== undefined &&
        (typeof options.installTo !== "string" || options.installTo.length === 0)
      ) {
        throw new ConfigurationError("--install-to must be a non-empty string");
      }
    } else if (options.denoVersion !== undefined || options.installTo !== undefined) {
      throw new ConfigurationError("--deno-version/--install-to apply only to install-deno");
    }
    if (options.action === "deploy" || options.action === "plan") {
      if (environments.length > 0 || withDependencies) {
        throw new ConfigurationError(
          "deploy/plan handle only Apps; prepare environments first and do not combine with --environment/--with-dependencies",
        );
      }
    }
    if (options.action === "secrets-deploy") {
      if (apps.length > 0 || environments.length > 0 || withDependencies) {
        throw new ConfigurationError(
          "secrets-deploy does not support --app/--environment/--with-dependencies",
        );
      }
    }
    this.configRoot = resolve(rawRoot);
    this.cluster = options.cluster;
    this.action = options.action;
    this.machines = Object.freeze(machines);
    this.apps = Object.freeze(apps);
    this.environments = Object.freeze(environments);
    this.executorRegion = options.executorRegion;
    this.addressKind = options.addressKind;
    this.withDependencies = withDependencies;
    this.releaseId = options.releaseId;
    this.denoVersion = options.denoVersion;
    this.installTo = options.installTo;
    this.removeNames = Object.freeze(removeNames);
    this.check = check;
    Object.freeze(this);
  }

  get clusterDirectory(): string {
    return resolve(this.configRoot, this.cluster);
  }
}

export class ValidationResult {
  readonly cluster: string;
  readonly directory: string;
  readonly machines: readonly string[];
  readonly environments: readonly string[];
  readonly apps: readonly string[];
  readonly succeeded = true;
  readonly exitCode = 0;

  constructor(options: {
    readonly cluster: string;
    readonly directory: string;
    readonly machines: Iterable<string>;
    readonly environments: Iterable<string>;
    readonly apps: Iterable<string>;
  }) {
    this.cluster = options.cluster;
    this.directory = options.directory;
    this.machines = Object.freeze([...options.machines]);
    this.environments = Object.freeze([...options.environments]);
    this.apps = Object.freeze([...options.apps]);
    Object.freeze(this);
  }
}

export type RunResult =
  | ValidationResult
  | ExecutionPlan
  | DeploymentResult
  | FetchResult
  | ReleaseHistoryResult
  | InstallDenoResult
  | SecretsDeployResult;

/** 执行过程中逐步完成的可读进度事件。 */
export type ProgressEvent =
  | {
    readonly kind: "step-result";
    readonly index: number;
    readonly total: number;
    readonly step: StepResult;
  }
  | {
    readonly kind: "machine-result";
    readonly index: number;
    readonly total: number;
    readonly machine: MachineDenoOutcome;
  }
  | {
    readonly kind: "package-result";
    readonly index: number;
    readonly total: number;
    readonly package: FetchPackageResult;
  };

export type ProgressListener = (event: ProgressEvent) => void | Promise<void>;

export interface RunDependencies {
  readonly bindings?: ProjectBindings;
  readonly downloadProviders?:
    | DownloadProviderRegistry
    | Readonly<Record<string, DownloadProvider>>
    | ReadonlyMap<string, DownloadProvider>;
  readonly transport?: Transport;
  readonly knownHosts?: string;
  readonly packagesDir?: string;
  readonly keepVersions?: number;
  readonly confirmPlan?: (plan: ExecutionPlan) => boolean | Promise<boolean>;
  readonly confirmMachines?: (machines: readonly string[]) => boolean | Promise<boolean>;
  readonly signal?: AbortSignal;
  /** 可选进度事件监听；缺省时不产生任何进度输出。 */
  readonly onProgress?: ProgressListener;
}

function stepListener(
  onProgress?: ProgressListener,
): ((progress: StepProgress) => void | Promise<void>) | undefined {
  if (onProgress === undefined) return undefined;
  return (progress) => onProgress({ kind: "step-result", ...progress });
}

/** Load, plan, and optionally execute one invocation without global state. */
export async function run(
  options: RunOptions | RunOptionsInit,
  dependencies: RunDependencies = {},
): Promise<RunResult> {
  const request = options instanceof RunOptions ? options : new RunOptions(options);
  await requireDirectory(request.configRoot, "config root");
  await requireDirectory(request.clusterDirectory, "No cluster exists under the config root");
  throwIfAborted(dependencies.signal);

  const discoveredKnownHosts = dependencies.knownHosts ??
    await discoverClusterKnownHosts(request.clusterDirectory);
  const bindings = dependencies.bindings ?? new ProjectBindings();
  const providers = providerRegistry(dependencies.downloadProviders);
  const transport = dependencies.transport ??
    new OpenSshTransport({ knownHosts: discoveredKnownHosts });
  const cache = dependencies.packagesDir === undefined
    ? undefined
    : new PackageCache({ packagesDir: dependencies.packagesDir, registry: providers });
  const keepVersions = dependencies.keepVersions ?? DEFAULT_KEEP_VERSIONS;
  if (!Number.isInteger(keepVersions) || keepVersions < 1 || keepVersions > MAX_KEEP_VERSIONS) {
    throw new ConfigurationError(
      `keep_versions must be an integer between 1 and ${MAX_KEEP_VERSIONS}`,
    );
  }

  if (HISTORY_ACTIONS.has(request.action)) {
    const store = releaseStore(request, providers);
    if (request.action === "history") {
      const releases = request.releaseId === undefined
        ? await store.list()
        : [await store.get(request.releaseId)];
      return new ReleaseHistoryResult(store.cluster, releases);
    }
    return await runRollback(
      request,
      store,
      bindings,
      providers,
      cache,
      transport,
      keepVersions,
      dependencies.onProgress,
      dependencies.signal,
    );
  }

  if (request.action === "fetch") {
    return await runFetch(request, cache, dependencies.onProgress, dependencies.signal);
  }

  if (request.action === "deploy") {
    return await runDeploy(
      request,
      bindings,
      providers,
      cache,
      transport,
      keepVersions,
      dependencies.confirmPlan,
      dependencies.onProgress,
      dependencies.signal,
    );
  }

  if (request.action === "install-deno") {
    return await runInstallDeno(
      request,
      transport,
      dependencies.confirmMachines,
      dependencies.onProgress,
      dependencies.signal,
    );
  }

  if (request.action === "secrets-deploy") {
    return await runSecretsDeploy(
      request,
      transport,
      dependencies.confirmMachines,
      dependencies.signal,
    );
  }

  const cluster = await loadCluster(request.clusterDirectory);
  if (request.action === "validate") return validationResult(cluster);

  const requestedAction = request.action === "plan" ? "deploy" : request.action;
  const plan = buildRequestedPlan(cluster, request, requestedAction);
  if (request.action === "plan") return plan;

  if (
    (request.action === "install" || request.action === "prepare") &&
    request.environments.length === 0 && dependencies.confirmPlan
  ) {
    const prepared = await prepareExecution(plan, {
      bindings,
      downloadProviders: providers,
      packageCache: cache,
      signal: dependencies.signal,
    });
    let primary: unknown;
    try {
      if (!(await dependencies.confirmPlan(plan))) {
        throw new CancelledError("Cancelled: default full install was not confirmed");
      }
      return await executePrepared(
        prepared,
        transport,
        dependencies.signal,
        stepListener(dependencies.onProgress),
      );
    } catch (cause) {
      primary = cause;
      throw cause;
    } finally {
      await prepared.close(primary);
    }
  }

  if (RECORDED_LIFECYCLE_ACTIONS.has(request.action)) {
    return await runLifecycleAttempt(
      request,
      plan,
      bindings,
      providers,
      cache,
      transport,
      keepVersions,
      dependencies.onProgress,
      dependencies.signal,
    );
  }

  return await executePlan(plan, {
    bindings,
    downloadProviders: providers,
    packageCache: cache,
    transport,
    knownHosts: dependencies.knownHosts,
    keepVersions,
    onStep: stepListener(dependencies.onProgress),
    signal: dependencies.signal,
  });
}

async function runLifecycleAttempt(
  options: RunOptions,
  plan: ExecutionPlan,
  bindings: ProjectBindings,
  providers: DownloadProviderRegistry,
  cache: PackageCache | undefined,
  transport: Transport,
  keepVersions: number,
  onProgress?: ProgressListener,
  signal?: AbortSignal,
): Promise<DeploymentResult> {
  const operation = options.action as ReleaseOperation;
  if (!RECORDED_LIFECYCLE_ACTIONS.has(operation)) {
    throw new ConfigurationError(`Not a recordable lifecycle action: ${operation}`);
  }
  const pending = await releaseStore(options, providers).beginAttempt({
    operation,
    selection: releaseSelection(options),
  });
  try {
    const archived = await pending.archiveAttemptPlan(plan);
    const result = await executePlan(archived, {
      bindings,
      downloadProviders: providers,
      packageCache: cache,
      transport,
      keepVersions,
      onStep: stepListener(onProgress),
      signal,
    });
    const record = await finishAttemptResult(pending, result);
    return withRelease(result, record.releaseId);
  } catch (cause) {
    await finishAttemptError(pending, cause);
    throw cause;
  }
}

/** Public design name retained alongside `run`. */
export const runAction = run;

async function runSecretsDeploy(
  options: RunOptions,
  transport: Transport,
  confirmMachines?: (machines: readonly string[]) => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<SecretsDeployResult> {
  const cluster = await loadCluster(options.clusterDirectory);
  const declaredMachines = new Set<string>();
  for (const declaration of cluster.secrets.values()) {
    for (const machineName of declaration.machines) declaredMachines.add(machineName);
  }
  const requested = options.machines.length > 0 ? [...options.machines] : [];
  const unknown = requested.filter((machine) => !cluster.machines.has(machine)).sort();
  if (unknown.length > 0) throw new PlanningError(`Unknown machine filter: ${unknown.join(", ")}`);
  const targets = requested.length > 0
    ? [...new Set(requested)].sort().filter((machine) => declaredMachines.has(machine))
    : [...declaredMachines].sort();
  if (targets.length === 0) {
    throw new PlanningError("Cluster declares no machines for secret placement");
  }
  const operation = options.check ? "check" : options.removeNames.length > 0 ? "remove" : "deploy";
  const deploymentBindings = operation === "deploy"
    ? await loadClusterSecretSource(cluster, options.clusterDirectory)
    : undefined;
  if (
    !options.check && options.machines.length === 0 && confirmMachines !== undefined &&
    !(await confirmMachines(targets))
  ) {
    throw new CancelledError("Cancelled: default full secret deployment was not confirmed");
  }
  const directory = await Deno.makeTempDir({ prefix: "sfo-secrets-deploy-" });
  await Deno.chmod(directory, 0o700);
  const outcomes: SecretsMachineOutcome[] = [];
  try {
    for (const [index, machineName] of targets.entries()) {
      throwIfAborted(signal);
      const machine = cluster.machines.get(machineName)!;
      const secretsDir = machine.secretsDir ?? DEFAULT_SECRETS_DIR;
      let session: RemoteSession | undefined;
      try {
        const resolved = resolveMachine(cluster, machineName, {
          executorRegion: options.executorRegion,
          addressKind: options.addressKind,
        });
        session = await transport.connect(resolved, signal);
        if (operation === "check") {
          const state = await session.checkSecrets(secretsDir, signal);
          const issues = buildSecretCheckIssues(cluster, machineName, state);
          outcomes.push(Object.freeze({
            machine: machineName,
            status: issues.length > 0 ? "failed" : "succeeded",
            operation,
            issues,
            errorCategory: issues.length > 0 ? "preflight" : undefined,
            cleanupErrors: Object.freeze([]),
          }));
          continue;
        }
        if (operation === "remove") {
          for (const name of options.removeNames) {
            await session.removeSecret(name, secretsDir, signal);
          }
          outcomes.push(Object.freeze({
            machine: machineName,
            status: "succeeded",
            operation,
            cleanupErrors: Object.freeze([]),
          }));
          continue;
        }
        if (deploymentBindings === undefined) {
          throw new PreflightError("Missing cluster secret source");
        }
        const files = await prepareSecretDeployments(
          cluster.secrets,
          machineName,
          deploymentBindings,
          directory,
          { prefix: `machine-${index}` },
        );
        const results = await session.deploySecrets(files, secretsDir, signal);
        outcomes.push(Object.freeze({
          machine: machineName,
          status: "succeeded",
          operation,
          entries: Object.freeze(
            results.map((entry) =>
              Object.freeze({
                name: entry.name,
                kind: entry.kind,
                status: entry.status,
              })
            ),
          ),
          cleanupErrors: Object.freeze([]),
        }));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        outcomes.push(Object.freeze({
          machine: machineName,
          status: "failed",
          operation,
          errorCategory: errorCategory(cause),
          message,
          cleanupErrors: Object.freeze([]),
        }));
      } finally {
        if (session !== undefined) {
          try {
            await session.close();
          } catch (closeCause) {
            const previous = outcomes.pop();
            if (previous !== undefined) {
              const message = closeCause instanceof Error ? closeCause.message : String(closeCause);
              outcomes.push(Object.freeze({
                ...previous,
                status: "failed",
                cleanupErrors: Object.freeze([...previous.cleanupErrors, message]),
              }));
            }
          }
        }
      }
    }
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
  return new SecretsDeployResult({ cluster: cluster.name, operation, machines: outcomes });
}

function buildSecretCheckIssues(
  cluster: ClusterConfig,
  machineName: string,
  state: RemoteSecretState,
): readonly SecretCheckIssue[] {
  const issues: SecretCheckIssue[] = [];
  if (state.dirMode !== "700" && state.dirMode !== "missing") {
    issues.push(Object.freeze({
      name: "directory",
      kind: "bad-mode",
      detail: `Secure directory permissions must be 0700; actual ${state.dirMode}`,
    }));
  }
  const expected = declaredSecretNamesForMachine(cluster.secrets, machineName);
  const manifestByName = new Map(state.manifest.map((entry) => [entry.name, entry]));
  for (const name of expected) {
    const declaration = cluster.secrets.get(name);
    const entry = manifestByName.get(name);
    const remoteSha = state.sha256[name];
    if (entry === undefined || remoteSha === undefined) {
      issues.push(
        Object.freeze({ name, kind: "missing", detail: "Secret is not deployed on the node" }),
      );
      continue;
    }
    if (entry.kind !== declaration!.kind) {
      issues.push(Object.freeze({
        name,
        kind: "drifted",
        detail: `Type drift: manifest ${entry.kind}, declaration ${declaration!.kind}`,
      }));
    }
    if (entry.sha256 !== remoteSha) {
      issues.push(
        Object.freeze({ name, kind: "drifted", detail: "File hash does not match the manifest" }),
      );
    }
  }
  const expectedNames = new Set(expected);
  for (const name of state.entries) {
    if (!expectedNames.has(name)) {
      issues.push(
        Object.freeze({ name, kind: "extra", detail: "Secret remains outside the declaration" }),
      );
    }
  }
  return Object.freeze(issues);
}

async function runDeploy(
  options: RunOptions,
  bindings: ProjectBindings,
  providers: DownloadProviderRegistry,
  cache: PackageCache | undefined,
  transport: Transport,
  keepVersions: number,
  confirmPlan?: (plan: ExecutionPlan) => boolean | Promise<boolean>,
  onProgress?: ProgressListener,
  signal?: AbortSignal,
): Promise<DeploymentResult> {
  const cluster = await loadCluster(options.clusterDirectory);
  const plan = buildRequestedPlan(cluster, options, "deploy");
  if (confirmPlan !== undefined && !(await confirmPlan(plan))) {
    throw new CancelledError("Cancelled: deployment was not confirmed");
  }
  if (cache) {
    for (const step of plan.steps) {
      if (!needsPackage(step)) continue;
      await cache.ensure(step.package!, {
        kind: step.kind,
        name: step.resource,
        version: packageVersion(step.parameters),
        cluster: plan.cluster,
      }, signal);
    }
  }
  const store = releaseStore(options, providers);
  const pending = await store.beginAttempt({
    operation: "deploy",
    selection: releaseSelection(options),
  });
  try {
    const archived = await pending.archivePlans(plan, deriveRollbackPlan(plan));
    const result = await executePlan(archived, {
      bindings,
      downloadProviders: providers,
      packageCache: cache,
      transport,
      keepVersions,
      onStep: stepListener(onProgress),
      signal,
    });
    const record = await finishAttemptResult(pending, result);
    return withRelease(result, record.releaseId);
  } catch (cause) {
    await finishAttemptError(pending, cause);
    throw cause;
  }
}

async function runFetch(
  options: RunOptions,
  cache: PackageCache | undefined,
  onProgress?: ProgressListener,
  signal?: AbortSignal,
): Promise<FetchResult> {
  throwIfAborted(signal);
  if (!cache) {
    throw new ConfigurationError(
      "fetch requires a local deployment package cache directory: the CLI reads ~/.sfo-deploy/config.yaml automatically, " +
        "the public API must be given packagesDir",
    );
  }
  const cluster = await loadCluster(options.clusterDirectory);
  const appNames = options.apps.length > 0
    ? Object.freeze([...options.apps])
    : [...cluster.apps.keys()].sort();
  const packages: FetchPackageResult[] = [];
  const appsWithoutPackage: string[] = [];
  for (const [index, appName] of appNames.entries()) {
    throwIfAborted(signal);
    const app = cluster.apps.get(appName);
    if (!app) throw new PlanningError(`Unknown App: ${appName}`);
    if (!app.package) {
      appsWithoutPackage.push(appName);
      continue;
    }
    const version = app.version;
    if (version === undefined) throw new PlanningError(`App ${appName} has no version`);
    const fetched = await cache.fetch(app.package, {
      kind: "app",
      name: app.name,
      version,
      cluster: cluster.name,
    }, signal);
    await assertGzipTar(fetched.path, `installer package for App ${app.name}`);
    packages.push(Object.freeze({
      app: app.name,
      version,
      provider: app.package.provider,
      status: fetched.status,
      path: fetched.path,
      hashAlgorithm: fetched.hashAlgorithm,
      hashValue: fetched.hashValue,
      size: fetched.size,
    }));
    if (onProgress !== undefined) {
      await onProgress({
        kind: "package-result",
        index,
        total: appNames.length,
        package: packages.at(-1)!,
      });
    }
  }
  return new FetchResult({
    cluster: cluster.name,
    apps: appNames,
    packages,
    appsWithoutPackage,
  });
}

async function runInstallDeno(
  options: RunOptions,
  transport: Transport,
  confirmMachines?: (machines: readonly string[]) => boolean | Promise<boolean>,
  onProgress?: ProgressListener,
  signal?: AbortSignal,
): Promise<InstallDenoResult> {
  if (options.denoVersion !== undefined) {
    normalizeDenoVersion(options.denoVersion);
  }
  validateInstallTo(options.installTo);
  const cluster = await loadCluster(options.clusterDirectory);
  const names = options.machines.length > 0
    ? Object.freeze([...options.machines])
    : Object.freeze([...cluster.machines.keys()].sort());
  if (names.length === 0) throw new PlanningError("Cluster has no usable machines");
  if (options.machines.length === 0 && confirmMachines) {
    if (!(await confirmMachines(names))) {
      throw new CancelledError("Cancelled: default full Deno install was not confirmed");
    }
  }

  const outcomes: MachineDenoOutcome[] = [];
  for (const [index, name] of names.entries()) {
    throwIfAborted(signal);
    let session: RemoteSession | undefined;
    try {
      const machine = cluster.machines.get(name);
      if (!machine) throw new PlanningError(`Unknown machine: ${name}`);
      const resolved = resolveMachine(cluster, name, {
        executorRegion: options.executorRegion,
        addressKind: options.addressKind,
      });
      session = await transport.connect(resolved, signal);
      outcomes.push(
        await installDenoOnMachine(session, name, {
          version: options.denoVersion,
          installTo: options.installTo,
          signal,
        }),
      );
    } catch (cause) {
      if (
        cause instanceof CancelledError ||
        (cause instanceof DOMException && cause.name === "AbortError")
      ) {
        throw cause;
      }
      outcomes.push(failedDenoOutcome(name, options.installTo, cause));
    } finally {
      if (session !== undefined) {
        try {
          await session.close();
        } catch (closeCause) {
          const previous = outcomes.pop();
          if (previous !== undefined) {
            const message = closeCause instanceof Error ? closeCause.message : String(closeCause);
            outcomes.push(Object.freeze({
              ...previous,
              status: "failed",
              errorCategory: "transport",
              message: previous.message === undefined ? message : `${previous.message}; ${message}`,
              cleanupErrors: Object.freeze([...previous.cleanupErrors, message]),
            }));
          }
        }
      }
    }
    if (onProgress !== undefined) {
      await onProgress({
        kind: "machine-result",
        index,
        total: names.length,
        machine: outcomes.at(-1)!,
      });
    }
  }
  return new InstallDenoResult({ cluster: cluster.name, machines: outcomes });
}

function failedDenoOutcome(
  machine: string,
  installTo: string | undefined,
  cause: unknown,
): MachineDenoOutcome {
  const message = cause instanceof Error ? cause.message : String(cause);
  return Object.freeze({
    machine,
    status: "failed" as const,
    denoPath: `${installTo ?? DEFAULT_DENO_INSTALL_ROOT}/bin/deno`,
    errorCategory: errorCategory(cause),
    message,
    cleanupErrors: Object.freeze([]),
  });
}

async function runRollback(
  options: RunOptions,
  store: ReleaseStore,
  bindings: ProjectBindings,
  providers: DownloadProviderRegistry,
  cache: PackageCache | undefined,
  transport: Transport,
  keepVersions: number,
  onProgress?: ProgressListener,
  signal?: AbortSignal,
): Promise<DeploymentResult> {
  const sourceReleaseId = options.releaseId!;
  await store.loadRollbackPlan(sourceReleaseId);
  const pending = await store.beginAttempt({
    operation: "rollback",
    selection: new ReleaseSelection(),
    sourceReleaseId,
  });
  try {
    const archived = await pending.inheritRollbackSnapshot(sourceReleaseId);
    const result = await executePlan(archived, {
      bindings,
      downloadProviders: providers,
      packageCache: cache,
      transport,
      keepVersions,
      onStep: stepListener(onProgress),
      signal,
    });
    const record = await finishAttemptResult(pending, result);
    return withRelease(result, record.releaseId, sourceReleaseId);
  } catch (cause) {
    await finishAttemptError(pending, cause);
    throw cause;
  }
}

function withRelease(
  result: DeploymentResult,
  releaseId: string,
  sourceReleaseId?: string,
): DeploymentResult {
  return new DeploymentResult({
    cluster: result.cluster,
    requestedAction: result.requestedAction,
    steps: result.steps,
    releaseId,
    sourceReleaseId,
  });
}

async function finishAttemptResult(
  pending: PendingRelease,
  result: DeploymentResult,
): Promise<ReleaseRecord> {
  try {
    return await pending.finishResult(result);
  } catch (cause) {
    await pending.closeIncomplete().catch(() => undefined);
    throw cause;
  }
}

async function finishAttemptError(pending: PendingRelease, cause: unknown): Promise<void> {
  const cancelled = cause instanceof CancelledError ||
    (cause instanceof DOMException && cause.name === "AbortError");
  try {
    await pending.finishError({
      status: cancelled ? "cancelled" : "failed",
      category: errorCategory(cause),
      message: cancelled ? "Operation cancelled" : historyErrorMessage(cause),
    });
  } catch {
    await pending.closeIncomplete().catch(() => undefined);
  }
}

function errorCategory(cause: unknown): string {
  if (
    cause instanceof CancelledError ||
    (cause instanceof DOMException && cause.name === "AbortError")
  ) {
    return "cancelled";
  }
  if (cause instanceof ConfigurationError || cause instanceof PlanningError) return "configuration";
  if (cause instanceof PreflightError) return "preflight";
  if (cause instanceof DownloadError) return "download";
  if (cause instanceof TransportError) return "transport";
  if (cause instanceof ExecutionError) return "execution";
  return "execution";
}

function historyErrorMessage(cause: unknown): string {
  switch (errorCategory(cause)) {
    case "configuration":
      return "Config or execution plan verification failed";
    case "preflight":
      return "Local or remote preflight failed";
    case "download":
      return "Deployment artifact preparation failed";
    case "transport":
      return "Remote transport failed";
    default:
      return "Deployment execution failed";
  }
}

function releaseStore(options: RunOptions, registry: DownloadProviderRegistry): ReleaseStore {
  return new ReleaseStore(options.clusterDirectory, {
    sourceExporter: (provider, source) => registry.exportReleaseSource(provider, source),
    sourceImporter: (provider, envelope) => registry.importReleaseSource(provider, envelope),
  });
}

function releaseSelection(options: RunOptions): ReleaseSelection {
  return new ReleaseSelection({
    machines: options.machines,
    apps: options.apps,
    environments: options.environments,
    executorRegion: options.executorRegion,
    addressKind: options.addressKind,
    withDependencies: options.withDependencies,
  });
}

function buildRequestedPlan(
  cluster: ClusterConfig,
  options: RunOptions,
  action: string,
): ExecutionPlan {
  return buildPlan(cluster, {
    action,
    machines: options.machines.length > 0 ? options.machines : undefined,
    apps: options.apps.length > 0 ? options.apps : undefined,
    environments: options.environments.length > 0 ? options.environments : undefined,
    executorRegion: options.executorRegion,
    addressKind: options.addressKind,
    withDependencies: options.withDependencies,
  });
}

function validationResult(cluster: ClusterConfig): ValidationResult {
  return new ValidationResult({
    cluster: cluster.name,
    directory: cluster.directory,
    machines: [...cluster.machines.keys()].sort(),
    environments: [...cluster.machines.values()]
      .flatMap((machine) =>
        machine.environments.map((environment) => `${machine.name}/${environment.name}`)
      )
      .sort(),
    apps: [...cluster.apps.keys()].sort(),
  });
}

function packageVersion(
  parameters: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = parameters.version;
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function providerRegistry(
  providers: RunDependencies["downloadProviders"],
): DownloadProviderRegistry {
  return providers instanceof DownloadProviderRegistry
    ? providers
    : new DownloadProviderRegistry(providers ?? {});
}

async function requireDirectory(path: string, label: string): Promise<void> {
  try {
    const info = await Deno.stat(path);
    if (!info.isDirectory) throw new ConfigurationError(`${label}: ${path}`);
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError(`${label}: ${path}`, { cause });
  }
}

function uniqueNames(values: Iterable<string>, label: string, allowQualified = false): string[] {
  const result: string[] = [];
  for (const value of values) {
    const parts = typeof value === "string" ? value.split("/") : [];
    const valid = parts.length === 1 && NAME_RE.test(value) ||
      allowQualified && parts.length === 2 && parts.every((part) => NAME_RE.test(part));
    if (!valid) {
      throw new ConfigurationError(`Invalid ${label} filter name: ${JSON.stringify(value)}`);
    }
    if (result.includes(value)) throw new ConfigurationError(`Duplicate ${label} filter: ${value}`);
    result.push(value);
  }
  return result;
}

function fileUrlPath(value: URL, label: string): string {
  if (value.protocol !== "file:") {
    throw new ConfigurationError(`${label} must be a local file path`);
  }
  return decodeURIComponent(value.pathname);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError("User cancelled", { cause: signal.reason });
}
