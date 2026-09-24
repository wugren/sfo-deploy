/** 发布历史、不可变执行计划快照与回退计划。 */

import {
  basename,
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "jsr:@std/path@1.1.6";
import { ConfigurationError, ExecutionError } from "./errors.ts";
import type {
  AppManagementDefinition,
  AppManagerDefinition,
  ConfigTemplate,
  DeploymentDefinition,
  EnvironmentInstallDefinition,
  EnvironmentInstance,
  EnvironmentManagerDefinition,
  EnvironmentPackageInstall,
  EnvironmentPackageManagerKind,
  EnvironmentScriptInstall,
  EnvironmentScriptManager,
  EnvironmentServiceTool,
  EnvironmentSystemManager,
  ExecutionPlan,
  Machine,
  ManagedConfigFile,
  ManagedConfigPathSegment,
  ManagedConfigTargetRoot,
  ManagedConfigVariableBinding,
  ManagedSecretReference,
  PackageSpec,
  PlanDeliveryInputs,
  PlanStep,
  ResolvedMachine,
  ScriptInvocation,
  ScriptPermissions,
  ScriptRuntime,
  SystemdRestartPolicy,
} from "./types.ts";
import { freezeArray, freezeRecord } from "./types.ts";
import { immutableMap } from "./types.ts";

export type { ExecutionPlan, PlanStep } from "./types.ts";

export const RELEASE_SCHEMA_VERSION = 1;
export const PLAN_SCHEMA_VERSION = 4;
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_OUTCOME_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 4096;
export const MAX_STEPS = 10_000;
export const MAX_STRING_BYTES = 64 * 1024;
export const MAX_JSON_DEPTH = 16;
export const MAX_JSON_ITEMS = 16_384;
export const MAX_MESSAGE_CHARS = 4096;
export const LOCK_TIMEOUT_MS = 10_000;

// exclusive hard-link 发布在 link 与临时名删除之间会短暂出现 nlink=2。
// 总等待上限 63ms，既容纳正常调度抖动，也不把持久双链接状态当成合法输入。
const HARD_LINK_SETTLE_DELAYS_MS = Object.freeze([1, 2, 4, 8, 16, 32] as const);

const RELEASE_ID_RE = /^r\d{8}T\d{12}Z-[0-9a-f]{16}$/;
const SOURCE_SCHEMA_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const APP_RUN_AS_RE = /^[a-z_][a-z0-9_-]{0,31}\$?$/;
const APP_ACCESS_GROUP_RE = /^[a-z_][a-z0-9_-]{0,31}\$?$/;
const SYSTEMD_RESTART_POLICIES = new Set([
  "no",
  "on-success",
  "on-failure",
  "on-abnormal",
  "on-watchdog",
  "on-abort",
  "always",
]);
const RELEASE_OPERATIONS = new Set([
  "configure",
  "deploy",
  "start",
  "stop",
  "restart",
  "rollback",
]);
export type ReleaseOperation =
  | "configure"
  | "deploy"
  | "start"
  | "stop"
  | "restart"
  | "rollback";
const PLAN_ACTIONS = new Set([
  "check",
  "install",
  "prepare",
  "configure",
  "deploy",
  "start",
  "stop",
  "restart",
  "rollback",
]);
const STEP_ACTIONS = new Set([
  "check",
  "install",
  "configure",
  "deploy",
  "start",
  "stop",
  "restart",
  "stage",
  "activate",
  "before-start",
  "after-start",
  "enable",
]);
const STEP_STATUSES = new Set(["succeeded", "failed", "skipped", "blocked", "cancelled"]);
const PLAN_STEP_ACTIONS: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> =
  Object.freeze({
    check: { environment: new Set(["check"]), app: new Set<string>() },
    install: { environment: new Set(["install"]), app: new Set<string>() },
    prepare: {
      environment: new Set([
        "check",
        "install",
        "configure",
        "start",
        "restart",
        "before-start",
        "after-start",
        "enable",
      ]),
      app: new Set([]),
    },
    configure: {
      environment: new Set(["check", "install", "configure"]),
      app: new Set(["configure"]),
    },
    deploy: {
      environment: new Set(["check", "install", "configure"]),
      app: new Set(["check", "configure", "deploy", "stage", "activate", "restart"]),
    },
    start: { environment: new Set(["start"]), app: new Set(["start"]) },
    stop: { environment: new Set(["stop"]), app: new Set(["stop"]) },
    restart: { environment: new Set(["restart"]), app: new Set(["restart"]) },
    rollback: {
      environment: new Set(["check"]),
      app: new Set(["check", "configure", "deploy", "stage", "activate", "restart"]),
    },
  });

type JsonObject = Readonly<Record<string, unknown>>;
export type SourceExporter = (provider: string, source: JsonObject) => JsonObject;
export type SourceImporter = (provider: string, envelope: JsonObject) => JsonObject;

export interface ReleaseSelectionOptions {
  readonly machines?: readonly string[];
  readonly apps?: readonly string[];
  readonly environments?: readonly string[];
  readonly executorRegion?: string;
  readonly addressKind?: string;
  readonly withDependencies?: boolean;
}

export class ReleaseSelection {
  readonly machines: readonly string[];
  readonly apps: readonly string[];
  readonly environments: readonly string[];
  readonly executorRegion?: string;
  readonly addressKind?: string;
  readonly withDependencies: boolean;

  constructor(options: ReleaseSelectionOptions = {}) {
    this.machines = uniqueStrings(options.machines ?? [], "machines");
    this.apps = uniqueStrings(options.apps ?? [], "apps");
    this.environments = uniqueStrings(options.environments ?? [], "environments");
    this.executorRegion = optionalString(options.executorRegion, "executor_region");
    this.addressKind = optionalString(options.addressKind, "address_kind");
    this.withDependencies = options.withDependencies ?? false;
    if (typeof this.withDependencies !== "boolean") {
      throw new ConfigurationError("with_dependencies must be a boolean");
    }
    Object.freeze(this);
  }
}

export interface ReleaseErrorSummary {
  readonly category: string;
  readonly message: string;
}

export interface ReleaseStepSummary {
  readonly stepId: string;
  readonly machine: string;
  readonly kind: string;
  readonly resource: string;
  readonly action: string;
  readonly status: string;
  readonly exitCode?: number;
  readonly errorCategory?: string;
  readonly skipReason?: string;
  readonly message?: string;
  readonly cleanupErrors: readonly string[];
  readonly changed?: boolean;
  readonly service?: ReleaseStepServiceSummary;
  readonly recovery?: ReleaseStepRecoverySummary;
  readonly bundle?: ReleaseStepBundleSummary;
}

export interface ReleaseStepBundleSummary {
  readonly sha256: string;
  readonly size: number;
  readonly reused: boolean;
}

export interface ReleaseStepServiceSummary {
  readonly unit: string;
  readonly action: "none" | "start" | "stop" | "reload" | "restart";
  readonly daemonReloaded: boolean;
  readonly enableAction: "none" | "enable" | "disable";
  readonly before: { readonly enabled: boolean; readonly active: boolean };
  readonly after: { readonly enabled: boolean; readonly active: boolean };
}

export interface ReleaseStepRecoverySummary {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly configAttempted: boolean;
  readonly serviceAttempted: boolean;
}

export interface ReleaseTargetSummary {
  readonly machine: string;
  readonly status: string;
  readonly steps: readonly ReleaseStepSummary[];
  readonly cleanupErrors: readonly string[];
}

export interface ReleaseExecutionSummary {
  readonly exitCode: number;
  readonly targets: readonly ReleaseTargetSummary[];
}

export interface ReleaseRecord {
  readonly releaseId: string;
  readonly cluster: string;
  readonly operation: ReleaseOperation;
  readonly sourceReleaseId?: string;
  readonly status: "incomplete" | "succeeded" | "failed" | "cancelled";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly selection: ReleaseSelection;
  readonly apps: readonly string[];
  readonly machines: readonly string[];
  readonly appVersions: Readonly<Record<string, string>>;
  readonly executionResult?: ReleaseExecutionSummary;
  readonly error?: ReleaseErrorSummary;
  readonly rollbackEligible: boolean;
}

export class ReleaseHistoryResult {
  readonly cluster: string;
  readonly releases: readonly ReleaseRecord[];
  readonly succeeded = true;
  readonly exitCode = 0;

  constructor(cluster: string, releases: readonly ReleaseRecord[]) {
    this.cluster = requiredString(cluster, "cluster");
    this.releases = freezeArray(releases);
    Object.freeze(this);
  }
}

export interface DeploymentStepLike {
  readonly stepId: string;
  readonly machine: string;
  readonly kind: string;
  readonly resource: string;
  readonly action: string;
  readonly status: string | { readonly value?: string };
  readonly exitCode?: number;
  readonly errorCategory?: string;
  readonly skipReason?: string;
  readonly message?: string;
  readonly cleanupErrors?: readonly string[];
  readonly changed?: boolean;
  readonly service?: ReleaseStepServiceSummary;
  readonly recovery?: ReleaseStepRecoverySummary;
  readonly bundle?: ReleaseStepBundleSummary;
}

export interface DeploymentTargetLike {
  readonly machine: string;
  readonly status: string | { readonly value?: string };
  readonly steps: readonly DeploymentStepLike[];
  readonly cleanupErrors?: readonly string[];
}

export interface DeploymentResultLike {
  readonly cluster: string;
  readonly requestedAction: string;
  readonly succeeded: boolean;
  readonly exitCode: number;
  readonly targets?: readonly DeploymentTargetLike[];
  readonly steps?: readonly DeploymentStepLike[];
}

interface ReleaseStoreOptions {
  readonly sourceExporter: SourceExporter;
  readonly sourceImporter: SourceImporter;
  readonly lockTimeoutMs?: number;
}

class OperationLock {
  readonly path: string;
  readonly timeoutMs: number;
  #file?: Deno.FsFile;

  constructor(path: string, timeoutMs = LOCK_TIMEOUT_MS) {
    this.path = path;
    this.timeoutMs = timeoutMs;
  }

  async acquire(): Promise<void> {
    let file: Deno.FsFile;
    let created = false;
    try {
      file = await Deno.open(this.path, { createNew: true, read: true, write: true, mode: 0o600 });
      created = true;
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) {
        throw new ConfigurationError("Failed to create the release operation lock", { cause });
      }
      try {
        file = await Deno.open(this.path, { read: true, write: true });
      } catch (openCause) {
        throw new ConfigurationError("Release operation lock is not a safe regular file", {
          cause: openCause,
        });
      }
    }
    try {
      const current = await Deno.lstat(this.path);
      const opened = await file.stat();
      if (
        !current.isFile || current.isSymlink || current.nlink !== 1 ||
        !opened.isFile || opened.nlink !== 1 || !sameFileIdentity(current, opened)
      ) {
        throw new ConfigurationError("Release operation lock is not a safe regular file");
      }
      if (created) {
        await Deno.chmod(this.path, 0o600);
        await writeAll(file, new Uint8Array([0]), "release operation lock");
        await file.sync();
      } else if (opened.size === 0) {
        throw new ConfigurationError(
          "Existing release operation lock is empty; refusing to modify it unsafely",
        );
      }
    } catch (cause) {
      file.close();
      throw cause;
    }
    const deadline = performance.now() + this.timeoutMs;
    while (true) {
      try {
        if (await file.tryLock(true)) {
          this.#file = file;
          return;
        }
      } catch (cause) {
        file.close();
        throw new ConfigurationError("Failed to acquire the release operation lock", { cause });
      }
      if (performance.now() >= deadline) {
        file.close();
        throw new ConfigurationError(
          "Another release or rollback operation is already running for this cluster",
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }

  async release(): Promise<void> {
    const file = this.#file;
    this.#file = undefined;
    if (!file) return;
    try {
      await file.unlock();
    } finally {
      file.close();
    }
  }
}

/** 一个集群目录的发布历史唯一所有者。 */
export class ReleaseStore {
  readonly clusterDirectory: string;
  readonly cluster: string;
  readonly root: string;
  readonly sourceExporter: SourceExporter;
  readonly sourceImporter: SourceImporter;
  readonly lockTimeoutMs: number;
  readonly #lockPath: string;

  constructor(clusterDirectory: string | URL, options: ReleaseStoreOptions);
  constructor(
    clusterDirectory: string | URL,
    sourceExporter: SourceExporter,
    sourceImporter: SourceImporter,
  );
  constructor(
    clusterDirectory: string | URL,
    optionsOrExporter: ReleaseStoreOptions | SourceExporter,
    sourceImporter?: SourceImporter,
  ) {
    const raw = clusterDirectory instanceof URL ? fromFileUrl(clusterDirectory) : clusterDirectory;
    this.clusterDirectory = resolve(raw);
    this.cluster = basename(this.clusterDirectory);
    const options: ReleaseStoreOptions = typeof optionsOrExporter === "function"
      ? { sourceExporter: optionsOrExporter, sourceImporter: sourceImporter! }
      : optionsOrExporter;
    if (
      typeof options?.sourceExporter !== "function" || typeof options?.sourceImporter !== "function"
    ) {
      throw new TypeError("ReleaseStore requires sourceExporter and sourceImporter");
    }
    this.sourceExporter = options.sourceExporter;
    this.sourceImporter = options.sourceImporter;
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.root = join(this.clusterDirectory, ".sfo-deploy", "releases");
    this.#lockPath = join(this.clusterDirectory, ".sfo-deploy", "operation.lock");
  }

  async beginAttempt(options: {
    readonly operation: ReleaseOperation;
    readonly selection: ReleaseSelection;
    readonly sourceReleaseId?: string;
  }): Promise<PendingRelease> {
    const { operation, selection, sourceReleaseId } = options;
    if (!RELEASE_OPERATIONS.has(operation)) {
      throw new ConfigurationError(`Unsupported release history operation: ${operation}`);
    }
    if (!(selection instanceof ReleaseSelection)) {
      throw new TypeError("selection must be a ReleaseSelection");
    }
    if ((operation === "rollback") !== (sourceReleaseId !== undefined)) {
      throw new ConfigurationError(
        operation === "rollback"
          ? "rollback attempt must reference a source release ID"
          : `${operation} attempt must not reference a source release ID`,
      );
    }
    if (sourceReleaseId !== undefined) validateReleaseId(sourceReleaseId);
    await this.#ensureReady();
    const lock = new OperationLock(this.#lockPath, this.lockTimeoutMs);
    await lock.acquire();
    const releaseId = newReleaseId();
    const releaseDirectory = join(this.root, releaseId);
    const stagingDirectory = join(this.root, `.${releaseId}.${randomHex(8)}.tmp`);
    let published = false;
    const intent = {
      schema_version: RELEASE_SCHEMA_VERSION,
      release_id: releaseId,
      cluster: this.cluster,
      operation,
      source_release_id: sourceReleaseId ?? null,
      started_at: now(),
      selection: selectionData(selection),
    };
    try {
      if (await pathExists(releaseDirectory)) {
        throw new ConfigurationError(`Release ID already exists: ${releaseId}`);
      }
      await Deno.mkdir(stagingDirectory, { mode: 0o700 });
      await atomicJson(join(stagingDirectory, "intent.json"), intent, { exclusive: true });
      await Deno.rename(stagingDirectory, releaseDirectory);
      published = true;
      return new PendingRelease(this, releaseDirectory, intent, lock);
    } catch (cause) {
      if (!published) {
        await Deno.remove(stagingDirectory, { recursive: true }).catch(() => undefined);
      }
      await lock.release();
      throw cause;
    }
  }

  async list(): Promise<readonly ReleaseRecord[]> {
    await this.#ensureReady();
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(this.root)) entries.push(entry);
    entries.sort((left, right) => right.name.localeCompare(left.name));
    const records: ReleaseRecord[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory || entry.isSymlink) {
        throw new ConfigurationError(
          `Release history contains an invalid directory entry: ${entry.name}`,
        );
      }
      validateReleaseId(entry.name);
      records.push(await this.readRecord(join(this.root, entry.name)));
    }
    return freezeArray(records);
  }

  async get(releaseId: string): Promise<ReleaseRecord> {
    await this.#ensureReady();
    validateReleaseId(releaseId);
    const path = join(this.root, releaseId);
    const info = await safeLstat(path);
    if (!info?.isDirectory || info.isSymlink) {
      throw new ConfigurationError(`Release record does not exist: ${releaseId}`);
    }
    return await this.readRecord(path);
  }

  async loadRollbackPlan(releaseId: string): Promise<ExecutionPlan> {
    const record = await this.get(releaseId);
    if (!record.rollbackEligible) {
      throw new ConfigurationError(
        `Release record cannot be rolled back: ${releaseId} status=${record.status}`,
      );
    }
    const snapshot = join(this.root, releaseId, "snapshot");
    await this.verifySnapshot(snapshot, releaseId);
    return await this.readPlan(snapshot, "rollback-plan.json");
  }

  async readRecord(releaseDirectory: string): Promise<ReleaseRecord> {
    const intent = objectValue(
      await readJson(join(releaseDirectory, "intent.json"), MAX_JSON_BYTES),
      "intent.json",
    );
    expectKeys(intent, [
      "schema_version",
      "release_id",
      "cluster",
      "operation",
      "source_release_id",
      "started_at",
      "selection",
    ], "intent.json");
    if (intent.schema_version !== RELEASE_SCHEMA_VERSION) {
      throw new ConfigurationError(
        `Unsupported release record schema: ${String(intent.schema_version)}`,
      );
    }
    const releaseId = basename(releaseDirectory);
    if (intent.release_id !== releaseId || intent.cluster !== this.cluster) {
      throw new ConfigurationError(`Release record identity does not match: ${releaseId}`);
    }
    const operation = requiredString(intent.operation, "operation");
    if (!RELEASE_OPERATIONS.has(operation)) {
      throw new ConfigurationError(`Invalid release record operation: ${operation}`);
    }
    const sourceReleaseId = optionalString(intent.source_release_id, "source_release_id");
    if ((operation === "rollback") !== (sourceReleaseId !== undefined)) {
      throw new ConfigurationError("Invalid release record operation/source_release_id binding");
    }
    if (sourceReleaseId) validateReleaseId(sourceReleaseId);
    const selection = selectionFromData(intent.selection);
    const outcomePath = join(releaseDirectory, "outcome.json");
    if (!(await pathExists(outcomePath))) {
      const snapshot = join(releaseDirectory, "snapshot");
      if (await pathExists(snapshot)) {
        await this.verifySnapshot(snapshot, releaseId);
        await assertSnapshotOperation(snapshot, operation);
      }
      return freezeRecordDeep({
        releaseId,
        cluster: this.cluster,
        operation,
        sourceReleaseId,
        status: "incomplete",
        startedAt: requiredString(intent.started_at, "started_at"),
        selection,
        apps: selection.apps,
        machines: selection.machines,
        appVersions: {},
        rollbackEligible: false,
      }) as ReleaseRecord;
    }
    const outcome = objectValue(await readJson(outcomePath, MAX_OUTCOME_BYTES), "outcome.json");
    expectKeys(outcome, [
      "schema_version",
      "status",
      "finished_at",
      "apps",
      "machines",
      "app_versions",
      "execution_result",
      "error",
    ], "outcome.json");
    if (outcome.schema_version !== RELEASE_SCHEMA_VERSION) {
      throw new ConfigurationError("Unsupported outcome schema");
    }
    const status = requiredString(outcome.status, "status");
    if (!(["succeeded", "failed", "cancelled"] as string[]).includes(status)) {
      throw new ConfigurationError(`Invalid release record status: ${status}`);
    }
    const executionResult = executionSummaryFromData(outcome.execution_result);
    const error = errorFromData(outcome.error);
    validateOutcomeConsistency(status, executionResult, error);
    const snapshot = join(releaseDirectory, "snapshot");
    let actualPlan: ExecutionPlan | undefined;
    if (status === "succeeded") {
      actualPlan = await this.verifySnapshot(snapshot, releaseId);
      await assertSnapshotOperation(snapshot, operation);
    } else if (await pathExists(snapshot)) {
      actualPlan = await this.verifySnapshot(snapshot, releaseId);
      await assertSnapshotOperation(snapshot, operation);
    }
    const apps = uniqueStrings(outcome.apps, "apps");
    const machines = uniqueStrings(outcome.machines, "machines");
    const appVersions = stringMapping(outcome.app_versions, "app_versions");
    if (actualPlan) {
      if (actualPlan.requestedAction !== operation) {
        throw new ConfigurationError(
          "Release record operation does not match the actual execution plan requested_action",
        );
      }
      const expected = planSummary(actualPlan);
      if (
        !equalJson(apps, expected.apps) || !equalJson(machines, expected.machines) ||
        !equalJson(appVersions, expected.appVersions)
      ) {
        throw new ConfigurationError(
          "Release result metadata does not match the actual execution plan",
        );
      }
      if (executionResult) validateExecutionAgainstPlan(executionResult, actualPlan);
    }
    return freezeRecordDeep({
      releaseId,
      cluster: this.cluster,
      operation,
      sourceReleaseId,
      status,
      startedAt: requiredString(intent.started_at, "started_at"),
      finishedAt: requiredString(outcome.finished_at, "finished_at"),
      selection,
      apps,
      machines,
      appVersions,
      executionResult,
      error,
      rollbackEligible: status === "succeeded" &&
        (operation === "deploy" || operation === "rollback"),
    }) as ReleaseRecord;
  }

  async verifySnapshot(snapshot: string, releaseId?: string): Promise<ExecutionPlan> {
    const info = await safeLstat(snapshot);
    if (!info?.isDirectory || info.isSymlink) {
      throw new ConfigurationError("Release snapshot does not exist or is not a safe directory");
    }
    const manifest = objectValue(
      await readJson(join(snapshot, "manifest.json"), MAX_JSON_BYTES),
      "snapshot manifest",
    );
    expectKeys(manifest, ["schema_version", "release_id", "cluster", "files"], "snapshot manifest");
    if (manifest.schema_version !== RELEASE_SCHEMA_VERSION || !Array.isArray(manifest.files)) {
      throw new ConfigurationError("Invalid release snapshot manifest");
    }
    const manifestReleaseId = validateReleaseId(
      requiredString(manifest.release_id, "snapshot release_id"),
    );
    if (releaseId !== undefined && manifestReleaseId !== releaseId) {
      throw new ConfigurationError("Release snapshot does not match the attempt ID");
    }
    if (requiredString(manifest.cluster, "snapshot cluster") !== this.cluster) {
      throw new ConfigurationError("Release snapshot does not match the current cluster");
    }
    const expected = new Map<string, readonly [string, number]>();
    let total = 0;
    for (const raw of manifest.files) {
      const item = objectValue(raw, "snapshot file");
      expectKeys(item, ["path", "sha256", "size"], "snapshot file");
      const path = safeRelative(requiredString(item.path, "snapshot path"));
      const digest = sha256Text(item.sha256);
      const size = boundedInteger(item.size, "snapshot size", 0, MAX_ARCHIVE_FILE_BYTES);
      if (expected.has(path)) throw new ConfigurationError(`Duplicate snapshot file: ${path}`);
      expected.set(path, [digest, size]);
      total += size;
    }
    if (expected.size > MAX_ARCHIVE_FILES || total > MAX_SNAPSHOT_BYTES) {
      throw new ConfigurationError("Release snapshot exceeds the capacity limit");
    }
    const actual = new Set<string>();
    await walkSnapshot(snapshot, async (path, entry) => {
      const rel = relative(snapshot, path).split(SEPARATOR).join("/");
      if (rel === "manifest.json") return;
      if (entry.isSymlink) {
        throw new ConfigurationError(`Snapshot must not contain symlinks: ${rel}`);
      }
      if (entry.isDirectory) {
        if (rel !== "files") {
          throw new ConfigurationError(`Snapshot contains an unregistered directory: ${rel}`);
        }
        return;
      }
      if (!entry.isFile) {
        throw new ConfigurationError(`Snapshot contains a non-regular file: ${rel}`);
      }
      actual.add(rel);
      const wanted = expected.get(rel);
      if (!wanted) throw new ConfigurationError(`Snapshot contains an unregistered file: ${rel}`);
      const found = await hashRegularFile(path);
      if (wanted[0] !== found.hash || wanted[1] !== found.size) {
        throw new ConfigurationError(`Snapshot file integrity failed: ${rel}`);
      }
    });
    const missing = [...expected.keys()].filter((path) => !actual.has(path)).sort();
    if (missing.length) {
      throw new ConfigurationError(`Snapshot is missing files: ${missing.join(", ")}`);
    }
    if (!expected.has("actual-plan.json")) {
      throw new ConfigurationError("Release snapshot is missing the actual execution plan");
    }
    const actualPlan = await this.readPlan(snapshot, "actual-plan.json");
    if (actualPlan.cluster !== this.cluster) {
      throw new ConfigurationError("Release snapshot execution plan cluster does not match");
    }
    if (expected.has("rollback-plan.json")) {
      const rollbackPlan = await this.readPlan(snapshot, "rollback-plan.json");
      if (rollbackPlan.cluster !== this.cluster) {
        throw new ConfigurationError("Release snapshot rollback plan cluster does not match");
      }
      if (rollbackPlan.requestedAction !== "rollback") {
        throw new ConfigurationError("Invalid release snapshot rollback plan action");
      }
    }
    return actualPlan;
  }

  async readPlan(snapshot: string, name: string): Promise<ExecutionPlan> {
    return await decodePlan(
      await readJson(join(snapshot, name), MAX_JSON_BYTES),
      snapshot,
      this.clusterDirectory,
      this.sourceImporter,
    );
  }

  async #ensureReady(): Promise<void> {
    const info = await safeLstat(this.clusterDirectory);
    if (!info?.isDirectory || info.isSymlink) {
      throw new ConfigurationError(`Cluster directory does not exist: ${this.clusterDirectory}`);
    }
    await ensurePrivateDirectory(join(this.clusterDirectory, ".sfo-deploy"));
    await ensurePrivateDirectory(this.root);
  }
}

export class PendingRelease implements AsyncDisposable {
  readonly store: ReleaseStore;
  readonly releaseDirectory: string;
  readonly intent: JsonObject;
  readonly #lock: OperationLock;
  #closed = false;
  #apps: readonly string[] = freezeArray([]);
  #machines: readonly string[] = freezeArray([]);
  #appVersions: Readonly<Record<string, string>> = Object.freeze({});

  constructor(
    store: ReleaseStore,
    releaseDirectory: string,
    intent: JsonObject,
    lock: OperationLock,
  ) {
    this.store = store;
    this.releaseDirectory = releaseDirectory;
    this.intent = intent;
    this.#lock = lock;
  }

  get releaseId(): string {
    return String(this.intent.release_id);
  }

  async archivePlans(
    executedPlan: ExecutionPlan,
    rollbackPlan?: ExecutionPlan,
  ): Promise<ExecutionPlan> {
    const rollback = rollbackPlan ?? deriveRollbackPlan(executedPlan);
    return await this.#archiveSnapshot(executedPlan, rollback);
  }

  /**
   * 为 configure/start/stop/restart attempt 固化实际计划。
   * 这些操作不是可回退发布，因此快照明确不伪造 rollback plan。
   */
  async archiveAttemptPlan(executedPlan: ExecutionPlan): Promise<ExecutionPlan> {
    if (
      executedPlan.requestedAction !== "configure" &&
      executedPlan.requestedAction !== "start" &&
      executedPlan.requestedAction !== "stop" &&
      executedPlan.requestedAction !== "restart"
    ) {
      throw new ConfigurationError("Invalid plan action for a non-release attempt");
    }
    return await this.#archiveSnapshot(executedPlan);
  }

  async #archiveSnapshot(
    executedPlan: ExecutionPlan,
    rollback?: ExecutionPlan,
  ): Promise<ExecutionPlan> {
    this.#requireOpen();
    if (requiredString(this.intent.operation, "operation") !== executedPlan.requestedAction) {
      throw new ConfigurationError(
        "Attempt operation does not match the actual execution plan action",
      );
    }
    if (executedPlan.cluster !== this.store.cluster) {
      throw new ConfigurationError("Actual execution plan does not match the current cluster");
    }
    if (
      rollback !== undefined &&
      (rollback.cluster !== this.store.cluster || rollback.requestedAction !== "rollback")
    ) {
      throw new ConfigurationError(
        "Rollback plan must bind the current cluster and use requested_action=rollback",
      );
    }
    const temporary = join(this.releaseDirectory, `.snapshot-${randomHex(8)}`);
    await Deno.mkdir(join(temporary, "files"), { recursive: true, mode: 0o700 });
    const archive = new ArchiveWriter(temporary, this.store.clusterDirectory);
    try {
      const actualData = await encodePlan(
        executedPlan,
        archive,
        this.store.sourceExporter,
      );
      await atomicJson(join(temporary, "actual-plan.json"), actualData, { exclusive: true });
      if (rollback !== undefined) {
        const rollbackData = await encodePlan(
          rollback,
          archive,
          this.store.sourceExporter,
        );
        await atomicJson(join(temporary, "rollback-plan.json"), rollbackData, { exclusive: true });
      }
      const entries: Array<{ path: string; sha256: string; size: number }> = [];
      await walkSnapshot(temporary, async (path, entry) => {
        if (!entry.isFile) return;
        const rel = relative(temporary, path).split(SEPARATOR).join("/");
        if (rel === "manifest.json") return;
        const found = await hashRegularFile(path);
        entries.push({ path: rel, sha256: found.hash, size: found.size });
      });
      entries.sort((left, right) => left.path.localeCompare(right.path));
      await atomicJson(join(temporary, "manifest.json"), {
        schema_version: RELEASE_SCHEMA_VERSION,
        release_id: this.releaseId,
        cluster: this.store.cluster,
        files: entries,
      }, { exclusive: true });
      await this.store.verifySnapshot(temporary, this.releaseId);
      const destination = join(this.releaseDirectory, "snapshot");
      if (await pathExists(destination)) {
        throw new ConfigurationError("Release attempt already contains a snapshot");
      }
      await Deno.rename(temporary, destination);
      const decoded = await this.store.readPlan(destination, "actual-plan.json");
      const summary = planSummary(decoded);
      this.#apps = summary.apps;
      this.#machines = summary.machines;
      this.#appVersions = summary.appVersions;
      return decoded;
    } catch (cause) {
      await Deno.remove(temporary, { recursive: true }).catch(() => undefined);
      throw cause;
    }
  }

  async inheritRollbackSnapshot(sourceReleaseId: string): Promise<ExecutionPlan> {
    this.#requireOpen();
    const plan = await this.store.loadRollbackPlan(sourceReleaseId);
    if (plan.steps.some((step) => step.machine.machine.scriptRuntime.kind !== "deno")) {
      throw new ConfigurationError("Rollback plan contains mixed or unknown script runtimes");
    }
    return await this.archivePlans(plan, plan);
  }

  async finishResult(result: DeploymentResultLike): Promise<ReleaseRecord> {
    this.#requireOpen();
    if (result.cluster !== this.store.cluster) {
      throw new ConfigurationError("Deployment result does not match the release attempt cluster");
    }
    const actualPlan = await this.store.verifySnapshot(
      join(this.releaseDirectory, "snapshot"),
      this.releaseId,
    );
    await assertSnapshotOperation(
      join(this.releaseDirectory, "snapshot"),
      requiredString(this.intent.operation, "operation"),
    );
    if (result.requestedAction !== actualPlan.requestedAction) {
      throw new ConfigurationError(
        "Deployment result action does not match the actual execution plan",
      );
    }
    const summary = executionSummary(result);
    validateExecutionAgainstPlan(summary, actualPlan);
    const status = result.succeeded
      ? "succeeded"
      : result.exitCode === 130
      ? "cancelled"
      : "failed";
    validateOutcomeConsistency(status, summary, undefined);
    return await this.#finish(status, summaryData(summary), null);
  }

  async finishError(
    options: {
      readonly status: "failed" | "cancelled";
      readonly category: string;
      readonly message: string;
    },
  ): Promise<ReleaseRecord> {
    if (options.status !== "failed" && options.status !== "cancelled") {
      throw new TypeError("Error terminal state must be failed or cancelled");
    }
    return await this.#finish(options.status, null, {
      category: bounded(options.category),
      message: bounded(options.message),
    });
  }

  async closeIncomplete(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#lock.release();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.closeIncomplete();
  }

  async #finish(
    status: "succeeded" | "failed" | "cancelled",
    executionResult: unknown,
    error: unknown,
  ): Promise<ReleaseRecord> {
    this.#requireOpen();
    const outcome = {
      schema_version: RELEASE_SCHEMA_VERSION,
      status,
      finished_at: now(),
      apps: this.#apps,
      machines: this.#machines,
      app_versions: this.#appVersions,
      execution_result: executionResult,
      error,
    };
    try {
      await atomicJson(join(this.releaseDirectory, "outcome.json"), outcome, {
        exclusive: true,
        maxBytes: MAX_OUTCOME_BYTES,
      });
    } catch (cause) {
      throw new ExecutionError(
        `Failed to finalize release history ${this.releaseId}: ${String(cause)}`,
        { cause },
      );
    } finally {
      this.#closed = true;
      await this.#lock.release();
    }
    try {
      return await this.store.get(this.releaseId);
    } catch (cause) {
      throw new ExecutionError(
        `Release history terminal state verification failed ${this.releaseId}: ${String(cause)}`,
        {
          cause,
        },
      );
    }
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new ExecutionError(`Release attempt already finalized: ${this.releaseId}`);
    }
  }
}

class ArchiveWriter {
  readonly snapshot: string;
  readonly clusterDirectory: string;
  readonly files = new Map<string, string>();
  readonly pending = new Map<string, Promise<string>>();
  count = 0;
  total = 0;

  constructor(snapshot: string, clusterDirectory: string) {
    this.snapshot = snapshot;
    this.clusterDirectory = clusterDirectory;
  }

  async add(source: string): Promise<string> {
    const data = await readRegularBytes(source, MAX_ARCHIVE_FILE_BYTES, "release snapshot source");
    const digest = await sha256(data);
    const key = `${digest}:${data.byteLength}`;
    const existing = this.files.get(key);
    if (existing) return existing;
    const current = this.pending.get(key);
    if (current) return await current;
    const operation = (async () => {
      this.count++;
      this.total += data.byteLength;
      if (this.count > MAX_ARCHIVE_FILES || this.total > MAX_SNAPSHOT_BYTES) {
        throw new ConfigurationError("Release snapshot exceeds the capacity limit");
      }
      const rel = `files/${digest}`;
      const target = join(this.snapshot, "files", digest);
      const file = await Deno.open(target, { createNew: true, write: true, mode: 0o600 });
      try {
        await writeAll(file, data, "release snapshot file");
        await file.sync();
      } finally {
        file.close();
      }
      this.files.set(key, rel);
      return rel;
    })();
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(key);
    }
  }
}

/** 从实际 deploy 计划派生只检查环境并重放 App 的安全计划。 */
export function deriveRollbackPlan(plan: ExecutionPlan): ExecutionPlan {
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_STEPS) {
    throw new ConfigurationError("Execution plan is empty or exceeds the step limit");
  }
  const byId = new Map<string, PlanStep>(plan.steps.map((step) => [step.id, step]));
  if (byId.size !== plan.steps.length) {
    throw new ConfigurationError("Execution plan contains a duplicate step ID");
  }
  const packagelessResources = new Set(
    plan.steps.filter((step) => step.kind === "app").map((step) => step.resource)
      .filter((resource) =>
        !plan.steps.some((candidate) =>
          candidate.kind === "app" && candidate.resource === resource &&
          (candidate.action === "deploy" || candidate.action === "stage" ||
            candidate.action === "activate")
        )
      ),
  );
  const versionedResources = new Set(
    plan.steps.filter((step) =>
      step.kind === "app" && (step.action === "stage" || step.action === "activate")
    ).map((step) => step.resource),
  );
  const appIds = new Set<string>(
    plan.steps.filter((step) =>
      step.kind === "app" &&
      (step.action === "configure" || step.action === "deploy" ||
        step.action === "stage" || step.action === "activate" ||
        (step.action === "restart" && step.management?.manager?.kind === "script" &&
          versionedResources.has(step.resource)) ||
        (step.action === "check" && packagelessResources.has(step.resource)))
    ).map((step) => step.id),
  );
  if (
    !packagelessResources.size &&
    ![...appIds].some((id) => ["deploy", "stage", "activate"].includes(byId.get(id)?.action ?? ""))
  ) {
    throw new ConfigurationError("Release plan contains no rollback-capable App deploy step");
  }
  const environmentCheck = (dependency: string): string => {
    const index = dependency.lastIndexOf(":");
    const candidate = `${index < 0 ? dependency : dependency.slice(0, index)}:check`;
    const step = byId.get(candidate);
    if (!step || step.kind !== "environment" || step.action !== "check") {
      throw new ConfigurationError(
        `Rollback plan is missing an environment check step: ${candidate}`,
      );
    }
    return candidate;
  };
  const checkIds = new Set<string>();
  const pending = [...appIds].flatMap((id) =>
    byId.get(id)!.dependsOn.filter((dependency) => !appIds.has(dependency))
  );
  while (pending.length) {
    const checkId = environmentCheck(pending.pop()!);
    if (checkIds.has(checkId)) continue;
    checkIds.add(checkId);
    pending.push(...byId.get(checkId)!.dependsOn);
  }
  const keep = new Set([...appIds, ...checkIds]);
  const rewritten = plan.steps.filter((step) => keep.has(step.id)).map((step) => {
    const dependencies = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (keep.has(dependency)) dependencies.add(dependency);
      else if (dependency.startsWith("env:")) dependencies.add(environmentCheck(dependency));
      else {throw new ConfigurationError(
          `Rollback plan contains an unmappable dependency: ${dependency}`,
        );}
    }
    return Object.freeze({ ...step, dependsOn: freezeArray([...dependencies].sort()) });
  });
  validateStepGraph(rewritten);
  return Object.freeze({
    schemaVersion: plan.schemaVersion === 4 ? 4 : 3,
    cluster: plan.cluster,
    requestedAction: "rollback",
    steps: freezeArray(rewritten),
  });
}

async function encodePlan(
  plan: ExecutionPlan,
  archive: ArchiveWriter,
  sourceExporter: SourceExporter,
): Promise<JsonObject> {
  if (
    !plan || !Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_STEPS
  ) throw new ConfigurationError("Execution plan is empty or exceeds the step limit");
  validateStepGraph(plan.steps);
  validatePlanSemantics(plan.requestedAction, plan.steps);
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    cluster: requiredString(plan.cluster, "cluster"),
    requested_action: requiredString(plan.requestedAction, "requested_action"),
    ...(plan.activate === false ? { activate: false } : {}),
    steps: await Promise.all(
      plan.steps.map((step) => encodeStep(step, archive, sourceExporter)),
    ),
  };
}

async function encodeStep(
  step: PlanStep,
  archive: ArchiveWriter,
  sourceExporter: SourceExporter,
): Promise<JsonObject> {
  const machine = step.machine.machine;
  const runtime = machine.scriptRuntime;
  if (!runtime) throw new ConfigurationError("Plan machine is missing an explicit script runtime");
  if (runtime.kind !== "deno") {
    throw new ConfigurationError("execution-plan v4 accepts only the Deno runtime");
  }
  const legacyRunAs = step.runAs ?? step.management?.runAs;
  const legacyAccessGroup = step.management?.accessGroup;
  const mode = step.mode;
  const isVersionedStage = step.kind === "app" &&
    (step.action === "stage" || step.action === "activate") &&
    step.deployment?.kind === "versioned";
  if (legacyRunAs !== undefined) validateAppRunAs(legacyRunAs);
  if (legacyAccessGroup !== undefined) validateAppAccessGroup(legacyAccessGroup);
  if (mode !== undefined) validateAppMode(mode);
  if (step.management !== undefined) {
    if (
      step.lifecycleSecretValues === undefined ||
      step.lifecycleSecretFiles === undefined
    ) {
      throw new ConfigurationError("managed plan-v4 step is missing lifecycle secret declarations");
    }
  } else if (!isVersionedStage && legacyRunAs !== undefined) {
    throw new ConfigurationError("non-managed plan-v4 step must not declare run_as");
  }
  let sshKey: string | null = null;
  if (machine.sshPrivateKey !== undefined) {
    const rel = relative(archive.clusterDirectory, resolve(machine.sshPrivateKey)).split(SEPARATOR)
      .join("/");
    if (rel.startsWith("../") || rel === "..") {
      throw new ConfigurationError(
        "SSH private key must be stored as a logical relative path inside the cluster directory",
      );
    }
    sshKey = safeRelative(rel);
  }
  let packageData: JsonObject | null = null;
  if (step.package) {
    const envelope = objectValue(
      sourceExporter(step.package.provider, step.package.source),
      "package source envelope",
    );
    expectKeys(envelope, ["schema", "payload"], "package source envelope");
    if (typeof envelope.schema !== "string" || !SOURCE_SCHEMA_RE.test(envelope.schema)) {
      throw new ConfigurationError(
        "provider source exporter must return a schema/payload envelope",
      );
    }
    validateJson(envelope.payload);
    packageData = {
      provider: step.package.provider,
      source: envelope,
      hash_algorithm: step.package.hashAlgorithm,
      hash_value: step.package.hashValue,
    };
  }
  const scripts = await Promise.all(
    step.scripts.map((invocation) => encodePlanInvocation(invocation, archive)),
  );
  return {
    id: step.id,
    machine: {
      definition: {
        name: machine.name,
        domains: machine.domains,
        private_ip: machine.privateIp,
        public_ip: machine.publicIp,
        region: machine.region,
        ssh_user: machine.sshUser,
        ssh_port: machine.sshPort,
        ssh_private_key: sshKey,
        enable_deno: machine.enableDeno !== false,
        ...(machine.secretsDir !== undefined ? { secrets_dir: machine.secretsDir } : {}),
        script_runtime: { kind: "deno", executable: runtimeExecutable(runtime.executable) },
        environments: machine.environments.map((item) => ({
          name: item.name,
          definition: item.definition,
          version: item.version,
          parameters: jsonCopy(item.parameters),
          depends_on: item.dependsOn,
          requires_privilege: item.requiresPrivilege ?? null,
        })),
      },
      address: step.machine.address,
      address_kind: step.machine.addressKind,
    },
    kind: step.kind,
    resource: step.resource,
    action: step.action,
    scripts,
    parameters: jsonCopy(step.parameters),
    package: packageData,
    secret_values: step.secretValues,
    secret_files: step.secretFiles,
    run_as: legacyRunAs ?? null,
    access_group: legacyAccessGroup ?? null,
    mode: mode ?? null,
    lifecycle_secret_values: step.lifecycleSecretValues ?? [],
    lifecycle_secret_files: step.lifecycleSecretFiles ?? [],
    install_directory: step.installDirectory ?? null,
    bundle_scripts: step.bundleScripts === undefined ? null : await Promise.all(
      step.bundleScripts.map((invocation) => encodePlanInvocation(invocation, archive)),
    ),
    deployment: step.deployment ?? null,
    management: step.management === undefined
      ? null
      : await encodeManagement(step.management, archive),
    delivery_inputs: step.deliveryInputs === undefined
      ? null
      : await encodeDeliveryInputs(step.deliveryInputs, archive),
    environment_install: step.environmentInstall === undefined
      ? null
      : await encodeEnvironmentInstall(step.environmentInstall, archive),
    environment_manager: step.environmentManager === undefined
      ? null
      : await encodeEnvironmentManager(step.environmentManager, archive),
    depends_on: step.dependsOn,
  };
}

async function encodePlanInvocation(
  invocation: ScriptInvocation,
  archive: ArchiveWriter,
): Promise<JsonObject> {
  return {
    source: await archive.add(invocation.source),
    // 旧 v2/v3 快照的步骤脚本可省略 relative_path；重新归档时保留空值。
    relative_path: invocation.relativePath,
    permissions: {
      run: validateRunPermissions(invocation.permissions.run),
      net: validateNetPermissions(invocation.permissions.net),
      read: validatePathPermissions(invocation.permissions.read ?? [], "permissions.read"),
      write: validatePathPermissions(invocation.permissions.write ?? [], "permissions.write"),
    },
  };
}

function decodeDeployment(value: unknown): DeploymentDefinition {
  const item = objectValue(value, "deployment");
  expectKeys(item, ["kind"], "deployment");
  if (item.kind !== "versioned") {
    throw new ConfigurationError("deployment.kind supports only versioned");
  }
  return Object.freeze({ kind: "versioned" as const });
}

async function encodeInvocation(
  invocation: ScriptInvocation,
  archive: ArchiveWriter,
): Promise<JsonObject> {
  return {
    source: await archive.add(invocation.source),
    relative_path: safeRelative(invocation.relativePath),
    permissions: {
      run: validateRunPermissions(invocation.permissions.run),
      net: validateNetPermissions(invocation.permissions.net),
      read: validatePathPermissions(invocation.permissions.read ?? [], "permissions.read"),
      write: validatePathPermissions(invocation.permissions.write ?? [], "permissions.write"),
    },
  };
}

async function encodeManagement(
  management: AppManagementDefinition,
  archive: ArchiveWriter,
): Promise<JsonObject> {
  const configs = await Promise.all(management.configs.map(async (config) => ({
    name: config.name,
    relative_path: safeRelative(config.relativePath),
    source: await archive.add(config.source),
    target: config.target,
    target_root: config.targetRoot,
    owner: config.owner ?? null,
    group: config.group ?? null,
    mode: config.mode,
    variables: config.variables.map((binding) => ({
      name: binding.name,
      parameter_path: binding.parameterPath,
      value_type: binding.valueType,
    })),
    format: config.format,
    secret_references: [...config.secretReferences.entries()].map(([secret, reference]) => ({
      secret,
      kind: reference.kind,
      value_type: reference.valueType,
    })),
    validator: config.validator === undefined
      ? null
      : { argv: config.validator.argv, timeout_ms: config.validator.timeoutMs },
    on_change: config.onChange,
  })));
  const configScripts = await Promise.all(
    management.configScripts.map((script) => encodeInvocation(script, archive)),
  );
  const manager = management.manager === undefined
    ? null
    : management.manager.kind === "service"
    ? {
      kind: management.manager.kind,
      unit: management.manager.unit,
      tool: management.manager.tool,
      enabled: management.manager.enabled ?? null,
      enabled_explicit: management.manager.enabledExplicit ??
        (management.manager.enabled !== undefined),
      daemon_reload: management.manager.daemonReload,
      on_deploy: management.manager.onDeploy,
      timeout_ms: management.manager.timeoutMs,
      ...(management.manager.unitConfig === undefined ? {} : {
        unit_config: {
          target: management.manager.unitConfig.target,
          working_directory: management.manager.unitConfig.workingDirectory,
          command: management.manager.unitConfig.command,
          args: management.manager.unitConfig.args,
          ...(management.manager.unitConfig.user === undefined
            ? {}
            : { user: management.manager.unitConfig.user }),
          ...(management.manager.unitConfig.restartPolicy === undefined
            ? {}
            : { restart_policy: management.manager.unitConfig.restartPolicy }),
          ...(management.manager.unitConfig.restartSec === undefined
            ? {}
            : { restart_sec: management.manager.unitConfig.restartSec }),
          ...(management.manager.unitConfig.startLimitIntervalSec === undefined
            ? {}
            : { start_limit_interval_sec: management.manager.unitConfig.startLimitIntervalSec }),
          ...(management.manager.unitConfig.startLimitBurst === undefined
            ? {}
            : { start_limit_burst: management.manager.unitConfig.startLimitBurst }),
        },
      }),
    }
    : {
      kind: management.manager.kind,
      start: await encodeInvocation(management.manager.start, archive),
      stop: await encodeInvocation(management.manager.stop, archive),
      restart: await encodeInvocation(management.manager.restart, archive),
    };
  return {
    configs,
    config_scripts: configScripts,
    manager,
  };
}

async function encodeDeliveryInputs(
  inputs: PlanDeliveryInputs,
  archive: ArchiveWriter,
): Promise<JsonObject> {
  return {
    scripts: await Promise.all(inputs.scripts.map((script) => encodeInvocation(script, archive))),
    files: await Promise.all(inputs.files.map(async (file) => ({
      relative_path: safeRelative(file.relativePath),
      source: await archive.add(file.source),
    }))),
  };
}

async function decodeInvocation(
  raw: unknown,
  snapshot: string,
  label: string,
): Promise<ScriptInvocation> {
  const item = objectValue(raw, label);
  expectKeys(item, ["source", "relative_path", "permissions"], label);
  return Object.freeze({
    source: await snapshotFile(snapshot, item.source),
    relativePath: safeRelative(requiredString(item.relative_path, `${label}.relative_path`)),
    permissions: decodePermissions(item.permissions, `${label}.permissions`),
  });
}

function decodePermissions(value: unknown, label: string): ScriptPermissions {
  const permissions = objectValue(value, label);
  expectKeysOptional(permissions, ["run", "net"], ["read", "write"], label);
  return Object.freeze({
    run: validateRunPermissions(uniqueStrings(permissions.run, `${label}.run`)),
    net: validateNetPermissions(uniqueStrings(permissions.net, `${label}.net`)),
    read: permissions.read === undefined
      ? freezeArray([])
      : validatePathPermissions(uniqueStrings(permissions.read, `${label}.read`), `${label}.read`),
    write: permissions.write === undefined ? freezeArray([]) : validatePathPermissions(
      uniqueStrings(permissions.write, `${label}.write`),
      `${label}.write`,
    ),
  });
}

async function decodeManagement(
  raw: unknown,
  snapshot: string,
  runAs?: string,
  deployment?: DeploymentDefinition,
  accessGroup?: string,
): Promise<AppManagementDefinition | undefined> {
  if (raw === null || raw === undefined) return undefined;
  const value = objectValue(raw, "management");
  expectKeys(value, ["configs", "config_scripts", "manager"], "management");
  if (!Array.isArray(value.configs) || value.configs.length > MAX_JSON_ITEMS) {
    throw new ConfigurationError("management.configs must be a bounded list");
  }
  const configs = freezeArray(
    await Promise.all(value.configs.map(async (rawConfig) => {
      const config = objectValue(rawConfig, "managed config");
      if (config.updater !== undefined) {
        throw new ConfigurationError(
          "Legacy release snapshot contains managed config.updater; roll back with the old version first; the new contract supports only format/secret_references",
        );
      }
      expectKeysOptional(
        config,
        [
          "name",
          "relative_path",
          "source",
          "target",
          "owner",
          "group",
          "mode",
          "variables",
          "format",
          "secret_references",
          "validator",
          "on_change",
        ],
        ["target_root"],
        "managed config",
      );
      if (!Array.isArray(config.variables) || config.variables.length > MAX_JSON_ITEMS) {
        throw new ConfigurationError("managed config variables must be a bounded list");
      }
      const variables = freezeArray(config.variables.map((rawBinding) => {
        const binding = objectValue(rawBinding, "managed config variable");
        expectKeys(binding, ["name", "parameter_path", "value_type"], "managed config variable");
        return Object.freeze({
          name: requiredString(binding.name, "managed config variable.name"),
          parameterPath: configPath(
            binding.parameter_path,
            "managed config variable.parameter_path",
          ),
          valueType: configValueType(binding.value_type),
        }) as ManagedConfigVariableBinding;
      }));
      const target = requiredString(config.target, "managed config.target");
      if (!isAbsolute(target) || /[\0\r\n]/u.test(target)) {
        throw new ConfigurationError("managed config.target must be a safe absolute path");
      }
      const targetRoot = config.target_root === undefined
        ? "absolute"
        : configTargetRoot(config.target_root);
      const onChange = requiredString(config.on_change, "managed config.on_change");
      if (onChange !== "none" && onChange !== "reload" && onChange !== "restart") {
        throw new ConfigurationError("Invalid managed config.on_change");
      }
      const format = requiredString(config.format, "managed config.format");
      if (
        format !== "yaml" && format !== "json" && format !== "toml" && format !== "ini" &&
        format !== "nginx"
      ) {
        throw new ConfigurationError("Invalid managed config.format");
      }
      if (
        !Array.isArray(config.secret_references) || config.secret_references.length > MAX_JSON_ITEMS
      ) {
        throw new ConfigurationError("managed config.secret_references must be a bounded list");
      }
      const secretReferences = immutableMap(
        new Map(
          config.secret_references.map((rawReference) => {
            const reference = objectValue(rawReference, "managed secret reference");
            expectKeys(reference, ["secret", "kind", "value_type"], "managed secret reference");
            const secret = requiredString(reference.secret, "managed secret reference.secret");
            const kind = secretKind(reference.kind);
            if (kind === "file") {
              if (reference.value_type !== "string") {
                throw new ConfigurationError("file secret reference.value_type must be string");
              }
            }
            return [
              secret,
              Object.freeze({
                kind,
                valueType: configValueType(reference.value_type),
              }) as ManagedSecretReference,
            ];
          }),
        ),
      );
      return Object.freeze({
        name: requiredString(config.name, "managed config.name"),
        relativePath: safeRelative(
          requiredString(config.relative_path, "managed config.relative_path"),
        ),
        source: await snapshotFile(snapshot, config.source),
        target,
        targetRoot,
        owner: optionalString(config.owner, "managed config.owner"),
        group: optionalString(config.group, "managed config.group"),
        mode: boundedInteger(config.mode, "managed config.mode", 0, 0o777),
        variables,
        format,
        secretReferences,
        validator: decodeValidator(config.validator),
        onChange,
      });
    })),
  );
  if (!Array.isArray(value.config_scripts) || value.config_scripts.length > MAX_JSON_ITEMS) {
    throw new ConfigurationError("management.config_scripts must be a bounded list");
  }
  const configScripts = freezeArray(
    await Promise.all(
      value.config_scripts.map((script) =>
        decodeInvocation(script, snapshot, "management.config_scripts")
      ),
    ),
  );
  let manager: AppManagerDefinition | undefined;
  if (value.manager !== null && value.manager !== undefined) {
    const rawManager = objectValue(value.manager, "management.manager");
    if (rawManager.kind === "script") {
      expectKeys(rawManager, ["kind", "start", "stop", "restart"], "management.manager");
      manager = Object.freeze({
        kind: "script",
        start: await decodeInvocation(rawManager.start, snapshot, "management.manager.start"),
        stop: await decodeInvocation(rawManager.stop, snapshot, "management.manager.stop"),
        restart: await decodeInvocation(rawManager.restart, snapshot, "management.manager.restart"),
      });
    } else {
      if (rawManager.kind !== "service") throw new ConfigurationError("Invalid manager.kind");
      expectKeysOptional(
        rawManager,
        [
          "kind",
          "unit",
          "tool",
          "enabled",
          "daemon_reload",
          "on_deploy",
          "timeout_ms",
        ],
        ["enabled_explicit", "unit_config"],
        "management.manager",
      );
      const enabled = rawManager.enabled === null
        ? undefined
        : booleanValue(rawManager.enabled, "manager.enabled");
      const enabledExplicit = rawManager.enabled_explicit === undefined
        ? enabled !== undefined
        : booleanValue(rawManager.enabled_explicit, "manager.enabled_explicit");
      const onDeploy = requiredString(rawManager.on_deploy, "manager.on_deploy");
      const tool = requiredString(rawManager.tool, "manager.tool");
      if (!["none", "start", "reload", "restart"].includes(onDeploy)) {
        throw new ConfigurationError("Invalid manager.on_deploy");
      }
      if (!["auto", "systemctl", "service"].includes(tool)) {
        throw new ConfigurationError("Invalid manager.tool");
      }
      manager = Object.freeze({
        kind: "service",
        unit: requiredString(rawManager.unit, "manager.unit"),
        tool: tool as "auto" | "systemctl" | "service",
        enabled,
        enabledExplicit,
        daemonReload: booleanValue(rawManager.daemon_reload, "manager.daemon_reload"),
        onDeploy: onDeploy as "none" | "start" | "reload" | "restart",
        timeoutMs: boundedInteger(rawManager.timeout_ms, "manager.timeout_ms", 1, 86_400_000),
        ...(rawManager.unit_config === undefined ? {} : {
          unitConfig: decodeSystemdUnitConfig(
            rawManager.unit_config,
            requiredString(rawManager.unit, "manager.unit"),
            "management.manager.unit_config",
          ),
        }),
      });
    }
  }
  if (
    configs.length === 0 && configScripts.length === 0 &&
    manager === undefined &&
    !(runAs !== undefined && deployment?.kind === "versioned")
  ) {
    throw new ConfigurationError("management declaration must not be empty");
  }
  return Object.freeze({
    runAs,
    accessGroup,
    configs,
    configScripts,
    manager,
  });
}

function decodeSystemdUnitConfig(
  raw: unknown,
  unit: string,
  label: string,
) {
  const value = objectValue(raw, label);
  expectKeysOptional(
    value,
    ["target", "working_directory", "command", "args"],
    [
      "user",
      "restart_policy",
      "restart_sec",
      "start_limit_interval_sec",
      "start_limit_burst",
    ],
    label,
  );
  const target = safeAbsoluteRemotePath(value.target, `${label}.target`);
  if (basename(target) !== unit) {
    throw new ConfigurationError(`${label}.target file name must match service.unit`);
  }
  return Object.freeze({
    target,
    ...(value.user === null || value.user === undefined
      ? {}
      : { user: validateUnitUser(requiredString(value.user, `${label}.user`)) }),
    workingDirectory: safeAbsoluteRemotePath(
      value.working_directory,
      `${label}.working_directory`,
    ),
    command: safeAbsoluteRemotePath(value.command, `${label}.command`),
    args: freezeArray(
      uniqueStrings(value.args, `${label}.args`).map((argument) => {
        if (containsAsciiControl(argument)) {
          throw new ConfigurationError(`${label}.args contains control characters`);
        }
        return argument;
      }),
    ),
    restartPolicy: optionalRestartPolicy(value.restart_policy, `${label}.restart_policy`),
    restartSec: optionalBoundedInteger(value.restart_sec, 0, 86_400, `${label}.restart_sec`),
    startLimitIntervalSec: optionalBoundedInteger(
      value.start_limit_interval_sec,
      0,
      86_400,
      `${label}.start_limit_interval_sec`,
    ),
    startLimitBurst: optionalBoundedInteger(
      value.start_limit_burst,
      0,
      10_000,
      `${label}.start_limit_burst`,
    ),
  });
}

function safeAbsoluteRemotePath(raw: unknown, label: string): string {
  const text = requiredString(raw, label);
  if (
    !isAbsolute(text) || text.includes("\\") || containsAsciiControl(text) ||
    text === "/" || text.startsWith("//") || text.split("/").includes("..")
  ) {
    throw new ConfigurationError(`${label} must be a safe remote absolute path`);
  }
  return text;
}

function optionalRestartPolicy(value: unknown, label: string): SystemdRestartPolicy | undefined {
  if (value === null || value === undefined) return undefined;
  const text = requiredString(value, label);
  if (!SYSTEMD_RESTART_POLICIES.has(text)) {
    throw new ConfigurationError(`${label} uses an unsupported value`);
  }
  return text as SystemdRestartPolicy;
}

function optionalBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  return boundedInteger(value, label, minimum, maximum);
}

async function decodeDeliveryInputs(
  raw: unknown,
  snapshot: string,
): Promise<PlanDeliveryInputs | undefined> {
  if (raw === null || raw === undefined) return undefined;
  const value = objectValue(raw, "delivery_inputs");
  expectKeys(value, ["scripts", "files"], "delivery_inputs");
  if (
    !Array.isArray(value.scripts) || value.scripts.length > MAX_JSON_ITEMS ||
    !Array.isArray(value.files) || value.files.length > MAX_JSON_ITEMS
  ) throw new ConfigurationError("delivery_inputs must contain bounded scripts/files lists");
  const scripts = freezeArray(
    await Promise.all(
      value.scripts.map((script) => decodeInvocation(script, snapshot, "delivery input script")),
    ),
  );
  const files = freezeArray(
    await Promise.all(value.files.map(async (rawFile) => {
      const file = objectValue(rawFile, "delivery input file");
      expectKeys(file, ["relative_path", "source"], "delivery input file");
      return Object.freeze({
        relativePath: safeRelative(
          requiredString(file.relative_path, "delivery file.relative_path"),
        ),
        source: await snapshotFile(snapshot, file.source),
      });
    })),
  );
  return Object.freeze({ scripts, files });
}

function decodeValidator(raw: unknown): ManagedConfigFile["validator"] {
  if (raw === null || raw === undefined) return undefined;
  const value = objectValue(raw, "managed config validator");
  expectKeys(value, ["argv", "timeout_ms"], "managed config validator");
  const argv = uniqueStrings(value.argv, "managed config validator.argv");
  if (argv.length === 0) {
    throw new ConfigurationError("managed config validator.argv must not be empty");
  }
  return Object.freeze({
    argv,
    timeoutMs: boundedInteger(
      value.timeout_ms,
      "managed config validator.timeout_ms",
      1,
      86_400_000,
    ),
  });
}

function configPath(raw: unknown, label: string): readonly ManagedConfigPathSegment[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_JSON_ITEMS) {
    throw new ConfigurationError(`${label} must be a non-empty bounded list`);
  }
  return freezeArray(raw.map((segment) => {
    if (typeof segment === "string" && segment.length > 0) return requiredString(segment, label);
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return segment;
    }
    throw new ConfigurationError(`${label} contains an invalid segment`);
  }));
}

function configValueType(raw: unknown): "string" | "integer" | "number" | "boolean" {
  const value = requiredString(raw, "managed config value_type");
  if (!["string", "integer", "number", "boolean"].includes(value)) {
    throw new ConfigurationError("Invalid managed config value_type");
  }
  return value as "string" | "integer" | "number" | "boolean";
}

function configTargetRoot(raw: unknown): ManagedConfigTargetRoot {
  const value = requiredString(raw, "managed config target_root");
  if (!["absolute", "install", "current", "latest"].includes(value)) {
    throw new ConfigurationError("Invalid managed config target_root");
  }
  return value as ManagedConfigTargetRoot;
}

function secretKind(raw: unknown): "value" | "file" {
  const value = requiredString(raw, "secret_kind");
  if (value !== "value" && value !== "file") throw new ConfigurationError("Invalid secret_kind");
  return value;
}

function booleanValue(raw: unknown, label: string): boolean {
  if (typeof raw !== "boolean") throw new ConfigurationError(`${label} must be a boolean`);
  return raw;
}

async function decodePlan(
  value: unknown,
  snapshot: string,
  clusterDirectory: string,
  sourceImporter: SourceImporter,
): Promise<ExecutionPlan> {
  const plan = objectValue(value, "execution plan");
  expectKeysOptional(
    plan,
    ["schema_version", "cluster", "requested_action", "steps"],
    ["activate"],
    "execution plan",
  );
  const schema = plan.schema_version;
  if (schema === 1) {
    throw new ConfigurationError(
      "execution-plan v1 Python snapshots are no longer supported; use an old executor that matches the snapshot or redeploy as a Deno plan",
    );
  }
  if (
    (schema !== 2 && schema !== 3 && schema !== 4) || !Array.isArray(plan.steps) ||
    plan.steps.length === 0 || plan.steps.length > MAX_STEPS
  ) throw new ConfigurationError("Invalid execution plan schema");
  const requestedAction = requiredString(plan.requested_action, "requested_action");
  if (!PLAN_ACTIONS.has(requestedAction)) {
    throw new ConfigurationError(`Invalid execution plan requested_action: ${requestedAction}`);
  }
  const activate = plan.activate === undefined
    ? undefined
    : booleanValue(plan.activate, "activate");
  const steps = await Promise.all(
    plan.steps.map((item) => decodeStep(item, snapshot, clusterDirectory, sourceImporter, schema)),
  );
  validateStepGraph(steps);
  validatePlanSemantics(requestedAction, steps);
  return Object.freeze({
    schemaVersion: schema === 4 ? 4 : 3,
    cluster: requiredString(plan.cluster, "cluster"),
    requestedAction,
    ...(activate === false ? { activate: false as const } : {}),
    steps: freezeArray(steps),
  });
}

async function decodeStep(
  raw: unknown,
  snapshot: string,
  clusterDirectory: string,
  sourceImporter: SourceImporter,
  schema: 2 | 3 | 4,
): Promise<PlanStep> {
  const value = objectValue(raw, "plan step");
  expectKeysOptional(
    value,
    [
      "id",
      "machine",
      "kind",
      "resource",
      "action",
      "scripts",
      "parameters",
      "package",
      "depends_on",
      ...(schema === 4 ? ["secret_values", "secret_files", "management", "delivery_inputs"] : []),
    ],
    [
      ...(schema < 4 ? ["config_secrets", "file_secrets", "secret_values", "secret_files"] : []),
      ...(schema === 4
        ? [
          "run_as",
          "access_group",
          "mode",
          "lifecycle_secret_values",
          "lifecycle_secret_files",
          "deployment",
        ]
        : []),
      ...(schema === 4 ? ["environment_install", "environment_manager"] : []),
      "templates",
      "install_directory",
      "bundle_scripts",
    ],
    "plan step",
  );
  const machineValue = objectValue(value.machine, "resolved machine");
  expectKeys(machineValue, ["definition", "address", "address_kind"], "resolved machine");
  const definition = objectValue(machineValue.definition, "machine");
  expectKeysOptional(
    definition,
    [
      "name",
      "domains",
      "private_ip",
      "public_ip",
      "region",
      "ssh_user",
      "ssh_port",
      "ssh_private_key",
      "script_runtime",
      "environments",
    ],
    schema >= 3 ? ["secrets_dir", "enable_deno"] : [],
    "machine",
  );
  if (!Array.isArray(definition.environments)) {
    throw new ConfigurationError("machine.environments must be a list");
  }
  const environments: EnvironmentInstance[] = definition.environments.map((rawEnvironment) => {
    const item = objectValue(rawEnvironment, "environment instance");
    expectKeys(item, [
      "name",
      "definition",
      "version",
      "parameters",
      "depends_on",
      "requires_privilege",
    ], "environment instance");
    if (item.requires_privilege !== null && typeof item.requires_privilege !== "boolean") {
      throw new ConfigurationError("requires_privilege must be a boolean or null");
    }
    return Object.freeze({
      name: requiredString(item.name, "environment.name"),
      definition: requiredString(item.definition, "environment.definition"),
      version: requiredString(item.version, "environment.version"),
      parameters: freezeRecord(jsonMapping(item.parameters, "environment.parameters")),
      dependsOn: uniqueStrings(item.depends_on, "environment.depends_on"),
      requiresPrivilege: item.requires_privilege === null ? undefined : item.requires_privilege,
    });
  });
  let sshPrivateKey: string | undefined;
  if (definition.ssh_private_key !== null) {
    sshPrivateKey = contained(
      clusterDirectory,
      safeRelative(requiredString(definition.ssh_private_key, "ssh_private_key")),
    );
  }
  const secretsDir = definition.secrets_dir === null || definition.secrets_dir === undefined
    ? undefined
    : requiredString(definition.secrets_dir, "secrets_dir");
  if (definition.enable_deno !== undefined && typeof definition.enable_deno !== "boolean") {
    throw new ConfigurationError("machine.enable_deno must be a boolean");
  }
  const enableDeno = definition.enable_deno === undefined ? true : definition.enable_deno;
  const runtime = objectValue(definition.script_runtime, "script_runtime");
  expectKeys(runtime, ["kind", "executable"], "script_runtime");
  if (runtime.kind !== "deno") {
    throw new ConfigurationError("execution-plan v2/v3/v4 runtime kind must be deno");
  }
  const scriptRuntime: ScriptRuntime = Object.freeze({
    kind: "deno",
    executable: runtimeExecutable(runtime.executable),
  });
  const privateIp = ipAddresses(definition.private_ip, "private_ip", schema < 3);
  const publicIp = ipAddresses(definition.public_ip, "public_ip", schema < 3);
  const machine: Machine = Object.freeze({
    name: requiredString(definition.name, "machine.name"),
    domains: uniqueStrings(definition.domains, "machine.domains"),
    privateIp,
    publicIp,
    region: requiredString(definition.region, "region"),
    sshUser: requiredString(definition.ssh_user, "ssh_user"),
    sshPort: boundedInteger(definition.ssh_port, "ssh_port", 1, 65535),
    sshPrivateKey,
    secretsDir,
    enableDeno,
    scriptRuntime,
    environments: freezeArray(environments),
  });
  const addressKind = requiredString(machineValue.address_kind, "address_kind");
  if (addressKind !== "private" && addressKind !== "public") {
    throw new ConfigurationError("Invalid address_kind");
  }
  const addresses = addressKind === "private" ? privateIp : publicIp;
  const address = requiredString(machineValue.address, "address");
  if (!addresses.length || address !== addresses[0]) {
    throw new ConfigurationError(
      "Resolved machine primary address does not match the candidate addresses",
    );
  }
  const resolvedMachine: ResolvedMachine = Object.freeze({
    machine,
    address,
    addressKind,
    addresses,
  });
  if (!Array.isArray(value.scripts) || value.scripts.length > MAX_JSON_ITEMS) {
    throw new ConfigurationError("scripts must be a bounded list");
  }
  const scripts: readonly ScriptInvocation[] = freezeArray(
    await Promise.all(value.scripts.map(async (rawScript) => {
      const item = objectValue(rawScript, "script invocation");
      expectKeysOptional(item, ["source", "permissions"], ["relative_path"], "script invocation");
      return Object.freeze({
        source: await snapshotFile(snapshot, item.source),
        relativePath: typeof item.relative_path === "string" ? item.relative_path : "",
        permissions: decodePermissions(item.permissions, "script permissions"),
      });
    })),
  );
  if (!scripts.length && schema < 4) {
    throw new ConfigurationError("legacy plan step must contain at least one script invocation");
  }
  let bundleScripts: readonly ScriptInvocation[] | undefined;
  if (value.bundle_scripts !== null && value.bundle_scripts !== undefined) {
    if (!Array.isArray(value.bundle_scripts) || value.bundle_scripts.length > MAX_JSON_ITEMS) {
      throw new ConfigurationError("bundle_scripts must be a bounded list");
    }
    bundleScripts = freezeArray(
      await Promise.all(value.bundle_scripts.map(async (rawScript) => {
        const item = objectValue(rawScript, "bundle script invocation");
        expectKeysOptional(
          item,
          ["source", "permissions"],
          ["relative_path"],
          "bundle script invocation",
        );
        return Object.freeze({
          source: await snapshotFile(snapshot, item.source),
          relativePath: typeof item.relative_path === "string" ? item.relative_path : "",
          permissions: decodePermissions(item.permissions, "bundle script permissions"),
        });
      })),
    );
  }
  let templates: ConfigTemplate[] = [];
  if (value.templates !== undefined) {
    if (!Array.isArray(value.templates)) throw new ConfigurationError("templates must be a list");
    templates = await Promise.all(value.templates.map(async (rawTemplate) => {
      const item = objectValue(rawTemplate, "template");
      expectKeys(item, ["relative_path", "source"], "template");
      return Object.freeze({
        relativePath: safeRelative(requiredString(item.relative_path, "template.relative_path")),
        source: await snapshotFile(snapshot, item.source),
      });
    }));
  }
  const legacyConfigSecrets = value.config_secrets === undefined
    ? []
    : uniqueStrings(value.config_secrets, "config_secrets");
  const legacyFileSecrets = Array.isArray(value.file_secrets)
    ? value.file_secrets.map((rawSecret) => {
      const item = objectValue(rawSecret, "file secret");
      expectKeys(item, ["name", "path", "mode", "owner", "group", "overwrite"], "file secret");
      return Object.freeze({
        name: requiredString(item.name, "file secret name"),
        path: requiredString(item.path, "file secret path"),
        mode: boundedInteger(item.mode, "file secret mode", 0, 0o777),
        owner: optionalString(item.owner, "file secret owner"),
        group: optionalString(item.group, "file secret group"),
        overwrite: typeof item.overwrite === "boolean" ? item.overwrite : false,
      });
    })
    : [];
  if (legacyConfigSecrets.length > 0 || legacyFileSecrets.length > 0) {
    throw new ConfigurationError(
      "Legacy release snapshot uses the removed config_secrets/file_secrets mechanism; it cannot be executed, redeploy and then roll back",
    );
  }
  const secretValues = value.secret_values === undefined
    ? freezeArray([])
    : uniqueStrings(value.secret_values, "secret_values");
  const secretFiles = value.secret_files === undefined
    ? freezeArray([])
    : uniqueStrings(value.secret_files, "secret_files");
  const hasLifecycleValues = Object.hasOwn(value, "lifecycle_secret_values");
  const hasLifecycleFiles = Object.hasOwn(value, "lifecycle_secret_files");
  const currentV4 = hasLifecycleValues || hasLifecycleFiles;
  if (
    schema === 4 && currentV4 &&
    (!hasLifecycleValues || !hasLifecycleFiles)
  ) {
    throw new ConfigurationError("plan-v4 new field group is incomplete");
  }
  const runAs = value.run_as === null || value.run_as === undefined
    ? undefined
    : validateAppRunAs(requiredString(value.run_as, "run_as"));
  const accessGroup = value.access_group === null || value.access_group === undefined
    ? undefined
    : validateAppAccessGroup(requiredString(value.access_group, "access_group"));
  const mode = value.mode === null || value.mode === undefined
    ? undefined
    : validateAppMode(requiredString(value.mode, "mode"));
  const lifecycleSecretValues = currentV4
    ? uniqueStrings(value.lifecycle_secret_values, "lifecycle_secret_values")
    : undefined;
  const lifecycleSecretFiles = currentV4
    ? uniqueStrings(value.lifecycle_secret_files, "lifecycle_secret_files")
    : undefined;
  const kind = requiredString(value.kind, "kind");
  const action = requiredString(value.action, "action");
  if (kind !== "app" && kind !== "environment") {
    throw new ConfigurationError(`Invalid plan step kind: ${kind}`);
  }
  if (!STEP_ACTIONS.has(action)) {
    throw new ConfigurationError(`Invalid plan step action: ${action}`);
  }
  const installDirectory = value.install_directory === null || value.install_directory === undefined
    ? undefined
    : requiredString(value.install_directory, "install_directory");
  const deployment = schema === 4 && value.deployment !== null && value.deployment !== undefined
    ? decodeDeployment(value.deployment)
    : undefined;
  const management = schema === 4
    ? await decodeManagement(value.management, snapshot, runAs, deployment, accessGroup)
    : undefined;
  const deliveryInputs = schema === 4
    ? await decodeDeliveryInputs(value.delivery_inputs, snapshot)
    : undefined;
  const environmentInstall = schema === 4
    ? await decodeEnvironmentInstall(value.environment_install, snapshot)
    : undefined;
  const environmentManager = schema === 4
    ? await decodeEnvironmentManager(value.environment_manager, snapshot, action)
    : undefined;
  if (
    !scripts.length && management === undefined &&
    environmentInstall === undefined && environmentManager === undefined
  ) {
    throw new ConfigurationError("A step without scripts must contain a managed declaration");
  }
  if (deployment !== undefined) {
    if (kind !== "app" || !["deploy", "stage", "activate"].includes(action)) {
      throw new ConfigurationError(
        "Only App deploy/stage/activate steps can declare a versioned deployment",
      );
    }
    if (installDirectory === undefined) {
      throw new ConfigurationError("versioned deployment step is missing install_directory");
    }
  }
  const isVersionedStage = kind === "app" && (action === "stage" || action === "activate") &&
    deployment?.kind === "versioned";
  if (management === undefined && runAs !== undefined && !isVersionedStage) {
    throw new ConfigurationError("non-managed plan-v4 step must not declare run_as");
  }
  if (schema === 4) {
    validatePersistedManagementStep(
      kind,
      action,
      secretValues,
      secretFiles,
      management,
      deliveryInputs,
      lifecycleSecretValues,
      lifecycleSecretFiles,
    );
  }
  return Object.freeze({
    id: requiredString(value.id, "step id"),
    machine: resolvedMachine,
    kind,
    resource: requiredString(value.resource, "resource"),
    action,
    scripts,
    parameters: freezeRecord(jsonMapping(value.parameters, "parameters")),
    package: decodePackage(value.package, sourceImporter),
    secretValues,
    secretFiles,
    lifecycleSecretValues,
    lifecycleSecretFiles,
    templates: freezeArray(templates),
    dependsOn: uniqueStrings(value.depends_on, "depends_on"),
    installDirectory,
    runAs,
    mode,
    deployment,
    management,
    deliveryInputs,
    bundleScripts,
    environmentInstall,
    environmentManager,
  });
}

async function encodeEnvironmentInstall(
  install: EnvironmentInstallDefinition,
  archive: ArchiveWriter,
): Promise<JsonObject> {
  if (install.kind === "package") {
    return {
      kind: install.kind,
      manager: install.manager,
      packages: [...install.packages],
      update_cache: install.updateCache,
    };
  }
  return { kind: install.kind, invocation: await encodeInvocation(install.invocation, archive) };
}

async function decodeEnvironmentInstall(
  raw: unknown,
  snapshot: string,
): Promise<EnvironmentInstallDefinition | undefined> {
  if (raw === null || raw === undefined) return undefined;
  const value = objectValue(raw, "environment_install");
  const kind = requiredString(value.kind, "environment_install.kind");
  if (kind === "package") {
    expectKeys(value, ["kind", "manager", "packages", "update_cache"], "environment_install");
    const packages = freezeArray(
      Array.isArray(value.packages)
        ? value.packages.map((item) => requiredString(item, "environment_install.packages[]"))
        : [],
    );
    if (packages.length === 0) {
      throw new ConfigurationError("environment_install.packages must not be empty");
    }
    const manager = requiredString(value.manager, "environment_install.manager");
    if (!["auto", "apt-get", "yum"].includes(manager)) {
      throw new ConfigurationError("Invalid environment_install.manager");
    }
    return Object.freeze({
      kind: "package",
      manager: manager as EnvironmentPackageManagerKind,
      packages,
      updateCache: booleanValue(value.update_cache, "environment_install.update_cache"),
    }) as EnvironmentPackageInstall;
  }
  if (kind === "script") {
    expectKeys(value, ["kind", "invocation"], "environment_install");
    const result: EnvironmentScriptInstall = Object.freeze({
      kind: "script",
      invocation: await decodeInvocation(
        value.invocation,
        snapshot,
        "environment_install.invocation",
      ),
    });
    return result;
  }
  throw new ConfigurationError("Invalid environment_install.kind");
}

async function encodeEnvironmentManager(
  manager: EnvironmentManagerDefinition,
  archive: ArchiveWriter,
): Promise<JsonObject> {
  if (manager.kind === "system") {
    return {
      kind: manager.kind,
      name: manager.name,
      tool: manager.tool,
      enabled: manager.enabled ?? null,
      start_after_install: manager.startAfterInstall,
      timeout_ms: manager.timeoutMs,
    };
  }
  return {
    kind: manager.kind,
    start: await encodeInvocation(manager.start, archive),
    stop: manager.stop === undefined ? null : await encodeInvocation(manager.stop, archive),
    restart: await encodeInvocation(manager.restart, archive),
  };
}

async function decodeEnvironmentManager(
  raw: unknown,
  snapshot: string,
  action: string,
): Promise<EnvironmentManagerDefinition | undefined> {
  if (raw === null || raw === undefined) return undefined;
  const value = objectValue(raw, "environment_manager");
  const kind = requiredString(value.kind, "environment_manager.kind");
  if (kind === "system") {
    expectKeys(
      value,
      ["kind", "name", "tool", "enabled", "start_after_install", "timeout_ms"],
      "environment_manager",
    );
    const tool = requiredString(value.tool, "environment_manager.tool");
    if (!["auto", "systemctl", "service"].includes(tool)) {
      throw new ConfigurationError("Invalid environment_manager.tool");
    }
    const enabled = value.enabled === null
      ? undefined
      : booleanValue(value.enabled, "environment_manager.enabled");
    return Object.freeze({
      kind: "system",
      name: requiredString(value.name, "environment_manager.name"),
      tool: tool as EnvironmentServiceTool,
      enabled,
      startAfterInstall: booleanValue(
        value.start_after_install,
        "environment_manager.start_after_install",
      ),
      timeoutMs: boundedInteger(value.timeout_ms, "environment_manager.timeout_ms", 1, 86_400_000),
    }) as EnvironmentSystemManager;
  }
  if (kind === "script") {
    if (action === "stop") {
      expectKeys(value, ["kind", "start", "stop", "restart"], "environment_manager");
    } else {
      expectKeysOptional(
        value,
        ["kind", "start", "restart"],
        ["stop"],
        "environment_manager",
      );
    }
    const start = await decodeInvocation(value.start, snapshot, "environment_manager.start");
    const stop = value.stop === null || value.stop === undefined
      ? undefined
      : await decodeInvocation(value.stop, snapshot, "environment_manager.stop");
    const restart = await decodeInvocation(value.restart, snapshot, "environment_manager.restart");
    const result: EnvironmentScriptManager = Object.freeze(
      stop === undefined
        ? { kind: "script", start, restart }
        : { kind: "script", start, stop, restart },
    );
    return result;
  }
  throw new ConfigurationError("Invalid environment_manager.kind");
}

function validatePersistedManagementStep(
  kind: string,
  action: string,
  secretValues: readonly string[],
  secretFiles: readonly string[],
  management: AppManagementDefinition | undefined,
  deliveryInputs: PlanDeliveryInputs | undefined,
  lifecycleSecretValues?: readonly string[],
  lifecycleSecretFiles?: readonly string[],
): void {
  if (management === undefined) return;
  if (kind !== "app") throw new ConfigurationError("Only App steps can contain management");
  const values = new Set(secretValues);
  const files = new Set(secretFiles);
  for (const name of lifecycleSecretValues ?? []) {
    if (!values.has(name)) {
      throw new ConfigurationError(
        `Lifecycle value secret did not enter the step secret set: ${name}`,
      );
    }
  }
  for (const name of lifecycleSecretFiles ?? []) {
    if (!files.has(name)) {
      throw new ConfigurationError(
        `Lifecycle file secret did not enter the step secret set: ${name}`,
      );
    }
  }
  const requiredScripts: ScriptInvocation[] = [];
  const publishingConfigAction = action === "configure" ||
    action === "deploy" || action === "stage" || action === "activate";
  if (publishingConfigAction) {
    for (const config of management.configs) {
      for (const [name, reference] of config.secretReferences) {
        const declared = reference.kind === "value" ? values : files;
        if (!declared.has(name)) {
          throw new ConfigurationError(
            `managed secret did not enter the step minimal secret set: ${name}`,
          );
        }
      }
    }
  }
  requiredScripts.push(...management.configScripts);
  if (management.manager?.kind === "script") {
    requiredScripts.push(
      management.manager.start,
      management.manager.stop,
      management.manager.restart,
    );
  }
  if (
    ((action === "configure" || action === "deploy" || action === "stage" ||
      action === "activate") && management.configs.length > 0) ||
    (action === "configure" && management.configScripts.length > 0) ||
    (["start", "stop", "restart"].includes(action) &&
      management.manager?.kind === "script") ||
    requiredScripts.length > 0
  ) {
    if (deliveryInputs === undefined) {
      throw new ConfigurationError("managed step is missing delivery_inputs");
    }
  }
  const delivered = new Set(deliveryInputs?.scripts.map((script) => script.relativePath) ?? []);
  for (const script of requiredScripts) {
    if (!delivered.has(script.relativePath)) {
      throw new ConfigurationError(
        `managed script did not enter delivery_inputs: ${script.relativePath}`,
      );
    }
  }
}

function decodePackage(raw: unknown, sourceImporter: SourceImporter): PackageSpec | undefined {
  if (raw === null) return undefined;
  const value = objectValue(raw, "package");
  expectKeys(value, ["provider", "source", "hash_algorithm", "hash_value"], "package");
  const provider = requiredString(value.provider, "package.provider");
  const envelope = objectValue(value.source, "package source envelope");
  expectKeys(envelope, ["schema", "payload"], "package source envelope");
  const schema = requiredString(envelope.schema, "package source schema");
  if (!SOURCE_SCHEMA_RE.test(schema)) throw new ConfigurationError("Invalid package source schema");
  const imported = jsonMapping(
    sourceImporter(provider, { schema, payload: envelope.payload }),
    "imported package source",
  );
  return Object.freeze({
    provider,
    source: freezeRecord(imported),
    hashAlgorithm: requiredString(value.hash_algorithm, "hash_algorithm"),
    hashValue: requiredString(value.hash_value, "hash_value"),
  });
}

function validateStepGraph(steps: readonly PlanStep[]): void {
  const ids = steps.map((step) => requiredString(step.id, "step id"));
  if (new Set(ids).size !== ids.length) {
    throw new ConfigurationError("Execution plan contains a duplicate step ID");
  }
  const known = new Set(ids);
  const incoming = new Map<string, Set<string>>();
  for (const step of steps) {
    const dependencies = new Set(step.dependsOn);
    if (dependencies.size !== step.dependsOn.length) {
      throw new ConfigurationError(`Duplicate step dependency: ${step.id}`);
    }
    if (dependencies.has(step.id) || [...dependencies].some((item) => !known.has(item))) {
      throw new ConfigurationError(`Invalid step dependency: ${step.id}`);
    }
    incoming.set(step.id, dependencies);
  }
  const ready = [...incoming].filter(([, dependencies]) => !dependencies.size).map(([id]) => id)
    .sort();
  const visited = new Set<string>();
  while (ready.length) {
    const current = ready.shift()!;
    visited.add(current);
    for (const id of [...incoming.keys()].sort()) {
      const dependencies = incoming.get(id)!;
      if (
        dependencies.delete(current) && !dependencies.size && !visited.has(id) &&
        !ready.includes(id)
      ) {
        ready.push(id);
        ready.sort();
      }
    }
  }
  if (visited.size !== steps.length) {
    throw new ConfigurationError("Execution plan dependencies contain a cycle");
  }
}

function validatePlanSemantics(requestedAction: string, steps: readonly PlanStep[]): void {
  if (!PLAN_ACTIONS.has(requestedAction)) {
    throw new ConfigurationError(`Invalid execution plan requested_action: ${requestedAction}`);
  }
  const allowed = PLAN_STEP_ACTIONS[requestedAction];
  for (const step of steps) {
    if (!allowed?.[step.kind]?.has(step.action)) {
      throw new ConfigurationError(
        `Plan step does not match requested_action: ${step.id} ${step.kind}/${step.action} vs ${requestedAction}`,
      );
    }
  }
}

function executionSummary(result: DeploymentResultLike): ReleaseExecutionSummary {
  let targets = result.targets;
  if (!targets && result.steps) {
    const grouped = new Map<string, DeploymentStepLike[]>();
    for (const step of result.steps) {
      grouped.set(step.machine, [...(grouped.get(step.machine) ?? []), step]);
    }
    targets = [...grouped].map(([machine, steps]) => ({
      machine,
      status: deriveTargetStatus(steps.map(stepSummary), []),
      steps,
    }));
  }
  return executionSummaryFromData({
    exit_code: result.exitCode,
    targets: (targets ?? []).map((target) => ({
      machine: target.machine,
      status: statusText(target.status),
      cleanup_errors: target.cleanupErrors ?? [],
      steps: target.steps.map((step) => summaryStepData(stepSummary(step))),
    })),
  })!;
}

function stepSummary(step: DeploymentStepLike): ReleaseStepSummary {
  return Object.freeze({
    stepId: bounded(step.stepId),
    machine: bounded(step.machine),
    kind: bounded(step.kind),
    resource: bounded(step.resource),
    action: bounded(step.action),
    status: statusText(step.status),
    exitCode: step.exitCode,
    errorCategory: boundedOptional(step.errorCategory),
    skipReason: boundedOptional(step.skipReason),
    message: boundedOptional(step.message),
    cleanupErrors: freezeArray((step.cleanupErrors ?? []).map(bounded)),
    changed: optionalBoolean(step.changed, "changed"),
    service: step.service === undefined ? undefined : serviceSummary(step.service),
    recovery: step.recovery === undefined ? undefined : recoverySummary(step.recovery),
    bundle: step.bundle === undefined ? undefined : bundleSummary(step.bundle),
  });
}

function executionSummaryFromData(raw: unknown): ReleaseExecutionSummary | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = objectValue(raw, "execution summary");
  expectKeys(value, ["exit_code", "targets"], "execution summary");
  if (!Array.isArray(value.targets)) {
    throw new ConfigurationError("execution summary targets must be a list");
  }
  const targets: ReleaseTargetSummary[] = value.targets.map((rawTarget) => {
    const target = objectValue(rawTarget, "target summary");
    expectKeys(target, ["machine", "status", "steps", "cleanup_errors"], "target summary");
    if (!Array.isArray(target.steps)) throw new ConfigurationError("target steps must be a list");
    const status = requiredString(target.status, "target status");
    if (!STEP_STATUSES.has(status)) {
      throw new ConfigurationError(`Invalid target status: ${status}`);
    }
    const cleanupErrors = uniqueStrings(target.cleanup_errors, "target cleanup_errors");
    const steps = freezeArray(target.steps.map((rawStep) => {
      const step = objectValue(rawStep, "step summary");
      expectKeysOptional(
        step,
        [
          "step_id",
          "machine",
          "kind",
          "resource",
          "action",
          "status",
          "exit_code",
          "error_category",
          "skip_reason",
          "message",
          "cleanup_errors",
        ],
        ["changed", "service", "recovery", "bundle"],
        "step summary",
      );
      const exitCode = step.exit_code === null
        ? undefined
        : boundedInteger(step.exit_code, "step exit_code", 0, 255);
      const kind = requiredString(step.kind, "kind");
      const action = requiredString(step.action, "action");
      const stepStatus = requiredString(step.status, "status");
      if (
        (kind !== "app" && kind !== "environment") || !STEP_ACTIONS.has(action) ||
        !STEP_STATUSES.has(stepStatus)
      ) throw new ConfigurationError("Invalid step summary kind/action/status");
      const errors = uniqueStrings(step.cleanup_errors, "cleanup_errors");
      const errorCategory = optionalString(step.error_category, "error_category");
      const skipReason = optionalString(step.skip_reason, "skip_reason");
      if (errors.length && (stepStatus === "succeeded" || stepStatus === "skipped")) {
        throw new ConfigurationError(
          "A step with cleanup errors must not be marked succeeded or skipped",
        );
      }
      if (
        stepStatus === "succeeded" &&
        (exitCode === undefined || errorCategory !== undefined || skipReason !== undefined)
      ) {
        throw new ConfigurationError(
          "A succeeded step must contain an exit code and must not contain an error or skip reason",
        );
      }
      const expectedReasons: Record<string, ReadonlySet<string>> = {
        skipped: new Set([
          "check-satisfied",
          "target-fail-fast",
          "using-start",
          "using-restart",
          "up-to-date",
        ]),
        blocked: new Set(["dependency-failed"]),
        cancelled: new Set(["cancelled"]),
      };
      if (
        expectedReasons[stepStatus] &&
        (exitCode !== undefined || errorCategory !== undefined ||
          !expectedReasons[stepStatus].has(skipReason ?? ""))
      ) {
        throw new ConfigurationError(
          "A step that did not run must contain a skip reason and must not contain an exit code or error category",
        );
      }
      return Object.freeze({
        stepId: requiredString(step.step_id, "step_id"),
        machine: requiredString(step.machine, "machine"),
        kind,
        resource: requiredString(step.resource, "resource"),
        action,
        status: stepStatus,
        exitCode,
        errorCategory,
        skipReason,
        message: optionalString(step.message, "message"),
        cleanupErrors: errors,
        changed: optionalBoolean(step.changed, "step changed"),
        service: step.service === undefined ? undefined : serviceSummaryFromData(step.service),
        recovery: step.recovery === undefined ? undefined : recoverySummaryFromData(step.recovery),
        bundle: step.bundle === undefined ? undefined : bundleSummaryFromData(step.bundle),
      });
    }));
    const machine = requiredString(target.machine, "machine");
    if (steps.some((step) => step.machine !== machine)) {
      throw new ConfigurationError("target summary contains a step of another machine");
    }
    const expectedStatus = deriveTargetStatus(steps, cleanupErrors);
    if (status !== expectedStatus) {
      throw new ConfigurationError(
        `target status does not match the step results: ${status} != ${expectedStatus}`,
      );
    }
    return Object.freeze({ machine, status, steps, cleanupErrors });
  });
  if (new Set(targets.map((target) => target.machine)).size !== targets.length) {
    throw new ConfigurationError("execution summary contains a duplicate target");
  }
  const exitCode = boundedInteger(value.exit_code, "exit_code", 0, 255);
  const expectedExit = deriveExecutionExitCode(targets);
  if (exitCode !== expectedExit) {
    throw new ConfigurationError(
      `execution summary exit_code does not match the target result: ${exitCode} != ${expectedExit}`,
    );
  }
  return Object.freeze({ exitCode, targets: freezeArray(targets) });
}

function deriveTargetStatus(
  steps: readonly ReleaseStepSummary[],
  cleanupErrors: readonly string[],
): string {
  const statuses = new Set(steps.map((step) => step.status));
  if (cleanupErrors.length || statuses.has("failed")) return "failed";
  if (statuses.has("cancelled")) return "cancelled";
  if (statuses.has("blocked")) return "blocked";
  if (steps.length && statuses.size === 1 && statuses.has("skipped")) return "skipped";
  return "succeeded";
}

function deriveExecutionExitCode(targets: readonly ReleaseTargetSummary[]): number {
  if (targets.some((target) => target.status === "cancelled")) return 130;
  if (
    targets.some((target) =>
      target.steps.some((step) => step.status === "failed" && step.errorCategory === "preflight")
    )
  ) return 3;
  if (targets.every((target) => target.status === "succeeded" || target.status === "skipped")) {
    return 0;
  }
  return 4;
}

function validateOutcomeConsistency(
  status: string,
  result?: ReleaseExecutionSummary,
  error?: ReleaseErrorSummary,
): void {
  if (!result && !error) {
    throw new ConfigurationError(
      "Terminal release record is missing the execution or error summary",
    );
  }
  if (result && error) {
    throw new ConfigurationError(
      "Terminal release record must not contain both an execution and an error summary",
    );
  }
  if (status === "succeeded") {
    if (
      !result || result.exitCode !== 0 ||
      result.targets.some((target) => ["failed", "cancelled", "blocked"].includes(target.status))
    ) {
      throw new ConfigurationError(
        "A successful release record must contain a consistent exit_code=0 execution summary",
      );
    }
  } else if (result) {
    const expected = result.exitCode === 130 ? "cancelled" : "failed";
    if (status !== expected) {
      throw new ConfigurationError(
        `Release record status does not match the execution summary: ${status} != ${expected}`,
      );
    }
  }
}

function validateExecutionAgainstPlan(summary: ReleaseExecutionSummary, plan: ExecutionPlan): void {
  const expected = new Map(plan.steps.map((step) => [step.id, step]));
  const actual = new Map<string, ReleaseStepSummary>();
  const expectedMachines = new Set(plan.steps.map((step) => step.machine.machine.name));
  const actualMachines = new Set(summary.targets.map((target) => target.machine));
  if (!setEqual(expectedMachines, actualMachines)) {
    throw new ConfigurationError(
      "execution summary target set does not match the actual execution plan",
    );
  }
  for (const target of summary.targets) {
    if (!target.steps.length) {
      throw new ConfigurationError("execution summary target is missing plan steps");
    }
    for (const step of target.steps) {
      if (actual.has(step.stepId)) {
        throw new ConfigurationError(
          `execution summary contains a duplicate step ID: ${step.stepId}`,
        );
      }
      const planned = expected.get(step.stepId);
      if (!planned) {
        throw new ConfigurationError(
          `execution summary contains a step outside the plan: ${step.stepId}`,
        );
      }
      if (
        !equalJson([step.machine, step.kind, step.resource, step.action], [
          planned.machine.machine.name,
          planned.kind,
          planned.resource,
          planned.action,
        ])
      ) {
        throw new ConfigurationError(
          `execution summary step identity does not match the actual execution plan: ${step.stepId}`,
        );
      }
      actual.set(step.stepId, step);
    }
  }
  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  if (missing.length) {
    throw new ConfigurationError(
      `execution summary is missing actual execution plan steps: ${missing.sort().join(", ")}`,
    );
  }
  const positions = new Map(plan.steps.map((step, index) => [step.id, index]));
  for (const planned of plan.steps) {
    const result = actual.get(planned.id)!;
    if (result.status === "succeeded" && result.exitCode !== 0) {
      const hasInstall = plan.steps.some((candidate) =>
        candidate.kind === "environment" && candidate.action === "install" &&
        candidate.machine.machine.name === planned.machine.machine.name &&
        candidate.resource === planned.resource && candidate.dependsOn.includes(planned.id)
      );
      if (!(planned.kind === "environment" && planned.action === "check" && hasInstall)) {
        throw new ConfigurationError(
          `Succeeded step exit code does not match the actual execution plan action: ${planned.id}`,
        );
      }
    }
    if (result.status === "skipped" && result.skipReason === "check-satisfied") {
      if (planned.kind !== "environment" || planned.action !== "install") {
        throw new ConfigurationError(
          `check-satisfied can only be used for environment install steps: ${planned.id}`,
        );
      }
      const satisfied = planned.dependsOn.some((dependency) => {
        const dependencyPlan = expected.get(dependency);
        const dependencyResult = actual.get(dependency);
        return dependencyPlan?.kind === "environment" && dependencyPlan.action === "check" &&
          dependencyPlan.resource === planned.resource &&
          dependencyResult?.status === "succeeded" && dependencyResult.exitCode === 0;
      });
      if (!satisfied) {
        throw new ConfigurationError(
          `check-satisfied is missing a satisfied environment check: ${planned.id}`,
        );
      }
    }
    if (result.status === "skipped" && result.skipReason === "target-fail-fast") {
      const preceding = [...actual.values()].some((other) =>
        other.machine === result.machine && other.status === "failed" &&
        (positions.get(other.stepId) ?? Infinity) < (positions.get(planned.id) ?? -1)
      );
      if (!preceding) {
        throw new ConfigurationError(
          `target-fail-fast is missing a preceding failure on the same target: ${planned.id}`,
        );
      }
    }
  }
  if (
    summary.exitCode === 0 &&
    plan.steps.some((step) => step.kind === "app" && actual.get(step.id)?.status !== "succeeded")
  ) throw new ConfigurationError("App step of a successful release did not actually succeed");
}

function planSummary(
  plan: ExecutionPlan,
): {
  apps: readonly string[];
  machines: readonly string[];
  appVersions: Readonly<Record<string, string>>;
} {
  const apps = new Set<string>();
  const machines = new Set<string>();
  const appVersions: Record<string, string> = {};
  for (const step of plan.steps) {
    machines.add(step.machine.machine.name);
    if (step.kind === "app") {
      apps.add(step.resource);
      if (typeof step.parameters.version === "string") {
        appVersions[step.resource] = step.parameters.version;
      }
    }
  }
  return {
    apps: freezeArray([...apps].sort()),
    machines: freezeArray([...machines].sort()),
    appVersions: Object.freeze(Object.fromEntries(Object.entries(appVersions).sort())),
  };
}

function summaryData(summary: ReleaseExecutionSummary): JsonObject {
  return {
    exit_code: summary.exitCode,
    targets: summary.targets.map((target) => ({
      machine: target.machine,
      status: target.status,
      cleanup_errors: target.cleanupErrors,
      steps: target.steps.map(summaryStepData),
    })),
  };
}

function summaryStepData(step: ReleaseStepSummary): JsonObject {
  return {
    step_id: step.stepId,
    machine: step.machine,
    kind: step.kind,
    resource: step.resource,
    action: step.action,
    status: step.status,
    exit_code: step.exitCode ?? null,
    error_category: step.errorCategory ?? null,
    skip_reason: step.skipReason ?? null,
    message: step.message ?? null,
    cleanup_errors: step.cleanupErrors,
    ...(step.changed === undefined ? {} : { changed: step.changed }),
    ...(step.service === undefined ? {} : { service: serviceSummaryData(step.service) }),
    ...(step.recovery === undefined ? {} : { recovery: recoverySummaryData(step.recovery) }),
    ...(step.bundle === undefined ? {} : { bundle: bundleSummaryData(step.bundle) }),
  };
}

function serviceSummary(value: ReleaseStepServiceSummary): ReleaseStepServiceSummary {
  return serviceSummaryFromData(serviceSummaryData(value));
}

function serviceSummaryData(value: ReleaseStepServiceSummary): JsonObject {
  return {
    unit: bounded(value.unit),
    action: value.action,
    daemon_reloaded: value.daemonReloaded,
    enable_action: value.enableAction,
    before: { enabled: value.before.enabled, active: value.before.active },
    after: { enabled: value.after.enabled, active: value.after.active },
  };
}

function serviceSummaryFromData(raw: unknown): ReleaseStepServiceSummary {
  const value = objectValue(raw, "step service summary");
  expectKeys(value, [
    "unit",
    "action",
    "daemon_reloaded",
    "enable_action",
    "before",
    "after",
  ], "step service summary");
  const action = requiredString(value.action, "service action");
  const enableAction = requiredString(value.enable_action, "service enable_action");
  if (!["none", "start", "stop", "reload", "restart"].includes(action)) {
    throw new ConfigurationError("Invalid step service action");
  }
  if (!["none", "enable", "disable"].includes(enableAction)) {
    throw new ConfigurationError("Invalid step service enable_action");
  }
  const state = (rawState: unknown, label: string) => {
    const item = objectValue(rawState, label);
    expectKeys(item, ["enabled", "active"], label);
    return Object.freeze({
      enabled: booleanValue(item.enabled, `${label}.enabled`),
      active: booleanValue(item.active, `${label}.active`),
    });
  };
  return Object.freeze({
    unit: requiredString(value.unit, "service unit"),
    action: action as ReleaseStepServiceSummary["action"],
    daemonReloaded: booleanValue(value.daemon_reloaded, "service daemon_reloaded"),
    enableAction: enableAction as ReleaseStepServiceSummary["enableAction"],
    before: state(value.before, "service before"),
    after: state(value.after, "service after"),
  });
}

function recoverySummary(value: ReleaseStepRecoverySummary): ReleaseStepRecoverySummary {
  return recoverySummaryFromData(recoverySummaryData(value));
}

function recoverySummaryData(value: ReleaseStepRecoverySummary): JsonObject {
  return {
    attempted: value.attempted,
    succeeded: value.succeeded,
    config_attempted: value.configAttempted,
    service_attempted: value.serviceAttempted,
  };
}

function recoverySummaryFromData(raw: unknown): ReleaseStepRecoverySummary {
  const value = objectValue(raw, "step recovery summary");
  expectKeys(value, [
    "attempted",
    "succeeded",
    "config_attempted",
    "service_attempted",
  ], "step recovery summary");
  const result = Object.freeze({
    attempted: booleanValue(value.attempted, "recovery attempted"),
    succeeded: booleanValue(value.succeeded, "recovery succeeded"),
    configAttempted: booleanValue(value.config_attempted, "recovery config_attempted"),
    serviceAttempted: booleanValue(value.service_attempted, "recovery service_attempted"),
  });
  if (result.attempted !== (result.configAttempted || result.serviceAttempted)) {
    throw new ConfigurationError("step recovery attempted does not match its sub-fields");
  }
  return result;
}

function bundleSummary(value: ReleaseStepBundleSummary): ReleaseStepBundleSummary {
  return bundleSummaryFromData(bundleSummaryData(value));
}

function bundleSummaryData(value: ReleaseStepBundleSummary): JsonObject {
  return { sha256: value.sha256, size: value.size, reused: value.reused };
}

function bundleSummaryFromData(raw: unknown): ReleaseStepBundleSummary {
  const value = objectValue(raw, "step bundle summary");
  expectKeys(value, ["sha256", "size", "reused"], "step bundle summary");
  const sha256 = requiredString(value.sha256, "bundle sha256");
  if (!SHA256_RE.test(sha256)) throw new ConfigurationError("Invalid bundle sha256");
  return Object.freeze({
    sha256,
    size: boundedInteger(value.size, "bundle size", 0, Number.MAX_SAFE_INTEGER),
    reused: booleanValue(value.reused, "bundle reused"),
  });
}

function errorFromData(raw: unknown): ReleaseErrorSummary | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = objectValue(raw, "error summary");
  expectKeys(value, ["category", "message"], "error summary");
  return Object.freeze({
    category: requiredString(value.category, "error category"),
    message: requiredString(value.message, "error message"),
  });
}

function selectionData(selection: ReleaseSelection): JsonObject {
  return {
    machines: selection.machines,
    apps: selection.apps,
    environments: selection.environments,
    executor_region: selection.executorRegion ?? null,
    address_kind: selection.addressKind ?? null,
    with_dependencies: selection.withDependencies,
  };
}

function selectionFromData(raw: unknown): ReleaseSelection {
  const value = objectValue(raw, "release selection");
  expectKeys(value, [
    "machines",
    "apps",
    "environments",
    "executor_region",
    "address_kind",
    "with_dependencies",
  ], "release selection");
  if (typeof value.with_dependencies !== "boolean") {
    throw new ConfigurationError("with_dependencies must be a boolean");
  }
  return new ReleaseSelection({
    machines: uniqueStrings(value.machines, "machines"),
    apps: uniqueStrings(value.apps, "apps"),
    environments: uniqueStrings(value.environments, "environments"),
    executorRegion: optionalString(value.executor_region, "executor_region"),
    addressKind: optionalString(value.address_kind, "address_kind"),
    withDependencies: value.with_dependencies,
  });
}

function newReleaseId(): string {
  const iso = new Date().toISOString();
  const microsTail = String(crypto.getRandomValues(new Uint16Array(1))[0] % 1000).padStart(3, "0");
  const timestamp = `${iso.slice(0, 10).replaceAll("-", "")}T${
    iso.slice(11, 19).replaceAll(":", "")
  }${iso.slice(20, 23)}${microsTail}`;
  return `r${timestamp}Z-${randomHex(8)}`;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

function now(): string {
  return new Date().toISOString();
}

function validateReleaseId(value: unknown): string {
  if (typeof value !== "string" || !RELEASE_ID_RE.test(value)) {
    throw new ConfigurationError(`Invalid release ID: ${JSON.stringify(value)}`);
  }
  return value;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const info = await safeLstat(path);
  if (info && (!info.isDirectory || info.isSymlink)) {
    throw new ConfigurationError(`Release history path is not a safe directory: ${path}`);
  }
  if (!info) await Deno.mkdir(path, { recursive: false, mode: 0o700 });
  await Deno.chmod(path, 0o700).catch((cause) => {
    throw new ConfigurationError(`Failed to set release history directory permissions: ${path}`, {
      cause,
    });
  });
}

async function atomicJson(
  path: string,
  value: unknown,
  options: { exclusive: boolean; maxBytes?: number },
): Promise<void> {
  validateJson(value);
  const data = new TextEncoder().encode(`${stableJson(value)}\n`);
  if (data.byteLength > (options.maxBytes ?? MAX_JSON_BYTES)) {
    throw new ConfigurationError(`JSON exceeds the capacity limit: ${basename(path)}`);
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomHex(8)}.tmp`);
  try {
    const file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    try {
      await writeAll(file, data, `release history JSON ${basename(path)}`);
      await file.sync();
    } finally {
      file.close();
    }
    if (options.exclusive) {
      try {
        await Deno.link(temporary, path);
      } catch (cause) {
        if (cause instanceof Deno.errors.AlreadyExists) {
          throw new ConfigurationError(`History component already exists: ${basename(path)}`, {
            cause,
          });
        }
        throw new ConfigurationError(
          `Failed to publish the history component atomically: ${basename(path)}`,
          { cause },
        );
      }
      await Deno.remove(temporary);
      const info = await Deno.lstat(path);
      if (!info.isFile || info.isSymlink || info.nlink !== 1) {
        throw new ConfigurationError(
          `History component publish identity verification failed: ${basename(path)}`,
        );
      }
    } else await Deno.rename(temporary, path);
  } catch (cause) {
    await Deno.remove(temporary).catch(() => undefined);
    throw cause;
  }
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const bytes = await readRegularBytes(path, maxBytes, "release history JSON");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parseJsonStrict(text);
    validateJson(value);
    return value;
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError(`Release history JSON is corrupted: ${basename(path)}`, { cause });
  }
}

async function readRegularBytes(
  path: string,
  maxBytes: number,
  label: string,
  options: ReadRegularBytesOptions = {},
): Promise<Uint8Array> {
  const delays = options.hardLinkSettleDelaysMs ?? HARD_LINK_SETTLE_DELAYS_MS;
  const sleep = options.sleep ?? boundedSleep;
  let settlingIdentity: Deno.FileInfo | undefined;
  let before: Deno.FileInfo | undefined;
  for (let attempt = 0;; attempt++) {
    let candidate: Deno.FileInfo;
    try {
      candidate = await Deno.lstat(path);
    } catch (cause) {
      throw new ConfigurationError(
        `${label} does not exist or is not a safe regular file: ${path}`,
        { cause },
      );
    }
    if (!candidate.isFile || candidate.isSymlink) {
      throw new ConfigurationError(`${label} must be a single-link regular file: ${path}`);
    }
    if (settlingIdentity && !sameFileIdentity(settlingIdentity, candidate)) {
      throw new ConfigurationError(
        `${label} identity changed during the two-link publish window: ${path}`,
      );
    }
    if (candidate.nlink === 1) {
      before = candidate;
      break;
    }
    if (candidate.nlink !== 2) {
      throw new ConfigurationError(`${label} must be a single-link regular file: ${path}`);
    }
    settlingIdentity ??= candidate;
    const delay = delays[attempt];
    if (delay === undefined) {
      throw new ConfigurationError(
        `${label} two-link publish window did not converge within the deadline: ${path}`,
      );
    }
    if (!Number.isFinite(delay) || delay < 0 || delay > 1000) {
      throw new ConfigurationError(`${label} two-link retry parameters are unsafe`);
    }
    await sleep(delay);
  }
  if (!before) {
    throw new ConfigurationError(`${label} cannot be confirmed as a safe regular file: ${path}`);
  }
  if (before.size > maxBytes) {
    throw new ConfigurationError(`${label} exceeds the capacity limit: ${basename(path)}`);
  }
  const file = await Deno.open(path, { read: true });
  try {
    const opened = await file.stat();
    if (
      !opened.isFile || opened.nlink !== 1 || opened.size !== before.size ||
      !sameFileIdentity(before, opened)
    ) throw new ConfigurationError(`${label} changed while being opened: ${path}`);
    const data = new Uint8Array(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = await file.read(data.subarray(offset));
      if (count === null) break;
      if (count === 0) throw new ConfigurationError(`${label} read made no progress: ${path}`);
      offset += count;
    }
    const after = await Deno.lstat(path);
    if (
      !after.isFile || after.isSymlink || after.nlink !== 1 || after.size !== before.size ||
      after.mtime?.getTime() !== before.mtime?.getTime() || offset !== before.size ||
      !sameFileIdentity(before, after)
    ) throw new ConfigurationError(`${label} changed while being read: ${path}`);
    return data;
  } finally {
    file.close();
  }
}

interface ByteWriter {
  write(data: Uint8Array): Promise<number>;
}

interface ReadRegularBytesOptions {
  readonly hardLinkSettleDelaysMs?: readonly number[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

async function writeAll(writer: ByteWriter, data: Uint8Array, label: string): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const count = await writer.write(data.subarray(offset));
    if (!Number.isSafeInteger(count) || count <= 0 || count > data.byteLength - offset) {
      throw new ConfigurationError(`${label} write made no valid progress`);
    }
    offset += count;
  }
}

function boundedSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function snapshotFile(snapshot: string, raw: unknown): Promise<string> {
  const rel = safeRelative(requiredString(raw, "snapshot file"));
  const path = contained(snapshot, rel);
  await readRegularBytes(path, MAX_ARCHIVE_FILE_BYTES, "snapshot file");
  return path;
}

async function hashRegularFile(path: string): Promise<{ hash: string; size: number }> {
  const data = await readRegularBytes(path, MAX_ARCHIVE_FILE_BYTES, "snapshot file");
  return { hash: await sha256(data), size: data.byteLength };
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice().buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function walkSnapshot(
  root: string,
  visitor: (path: string, entry: Deno.DirEntry) => Promise<void>,
): Promise<void> {
  const recurse = async (directory: string): Promise<void> => {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      await visitor(path, entry);
      if (entry.isDirectory && !entry.isSymlink) await recurse(path);
    }
  };
  await recurse(root);
}

function safeRelative(value: string): string {
  if (
    !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new ConfigurationError(`Invalid snapshot relative path: ${JSON.stringify(value)}`);
  return value;
}

function contained(root: string, rel: string): string {
  const candidate = resolve(root, ...rel.split("/"));
  const difference = relative(resolve(root), candidate);
  if (difference === ".." || difference.startsWith(`..${SEPARATOR}`) || isAbsolute(difference)) {
    throw new ConfigurationError(`Path escapes the cluster directory: ${rel}`);
  }
  return candidate;
}

function validateJson(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (++budget.count > MAX_JSON_ITEMS || depth > MAX_JSON_DEPTH) {
    throw new ConfigurationError("JSON data exceeds the depth or item count limit");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_STRING_BYTES) {
      throw new ConfigurationError("JSON string exceeds the length limit");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConfigurationError("JSON must not contain NaN/Infinity");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1, budget);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      validateJson(key, depth + 1, budget);
      validateJson(item, depth + 1, budget);
    }
    return;
  }
  throw new ConfigurationError(`Unsupported JSON value type: ${typeof value}`);
}

/** JSON.parse 会静默覆盖重复键；历史数据必须拒绝这种歧义。 */
function parseJsonStrict(source: string): unknown {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(source[index] ?? "")) index++;
  };
  const parse = (): unknown => {
    whitespace();
    const start = index;
    const character = source[index];
    if (character === '"') {
      index++;
      let escaped = false;
      while (index < source.length) {
        const current = source[index++];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') return JSON.parse(source.slice(start, index));
      }
      throw new SyntaxError("unterminated string");
    }
    if (character === "[") {
      index++;
      const values: unknown[] = [];
      whitespace();
      if (source[index] === "]") {
        index++;
        return values;
      }
      while (true) {
        values.push(parse());
        whitespace();
        if (source[index] === "]") {
          index++;
          return values;
        }
        if (source[index++] !== ",") throw new SyntaxError("expected comma");
      }
    }
    if (character === "{") {
      index++;
      const value: Record<string, unknown> = {};
      const keys = new Set<string>();
      whitespace();
      if (source[index] === "}") {
        index++;
        return value;
      }
      while (true) {
        whitespace();
        const key = parse();
        if (typeof key !== "string") throw new SyntaxError("expected key");
        if (keys.has(key)) {
          throw new ConfigurationError(`Release history JSON contains a duplicate key: ${key}`);
        }
        keys.add(key);
        whitespace();
        if (source[index++] !== ":") throw new SyntaxError("expected colon");
        value[key] = parse();
        whitespace();
        if (source[index] === "}") {
          index++;
          return value;
        }
        if (source[index++] !== ",") throw new SyntaxError("expected comma");
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(index),
    );
    if (!match) throw new SyntaxError("invalid JSON value");
    index += match[0].length;
    return JSON.parse(match[0]);
  };
  const value = parse();
  whitespace();
  if (index !== source.length) throw new SyntaxError("trailing data");
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
      ).join(",")
    }}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ConfigurationError("Value is not valid JSON");
  return encoded;
}

function jsonCopy(value: unknown): unknown {
  validateJson(value);
  return JSON.parse(stableJson(value));
}
function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function jsonMapping(value: unknown, label: string): Record<string, unknown> {
  return jsonCopy(objectValue(value, label)) as Record<string, unknown>;
}
function expectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!equalJson(actual, wanted)) throw new ConfigurationError(`${label} fields do not match`);
}
function expectKeysOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !allowed.has(key)).sort();
  const missing = required.filter((key) => !actual.includes(key)).sort();
  if (unknown.length > 0 || missing.length > 0) {
    throw new ConfigurationError(`${label} fields do not match`);
  }
}
function requiredString(value: unknown, label: string): string {
  if (
    typeof value !== "string" || !value ||
    new TextEncoder().encode(value).byteLength > MAX_STRING_BYTES
  ) throw new ConfigurationError(`${label} must be a non-empty bounded string`);
  return value;
}

function validateAppRunAs(value: string): string {
  if (value === "root" || !APP_RUN_AS_RE.test(value)) {
    throw new ConfigurationError("run_as must be a canonical non-root Linux user");
  }
  return value;
}
function validateAppAccessGroup(value: string): string {
  if (value === "root" || !APP_ACCESS_GROUP_RE.test(value)) {
    throw new ConfigurationError("access_group must be a canonical non-root Linux group");
  }
  return value;
}
function validateAppMode(value: string): string {
  if (!/^0?[0-7]{3}$/.test(value)) {
    throw new ConfigurationError(
      "mode must be a three- or four-digit octal mode without special bits",
    );
  }
  return value.padStart(4, "0");
}
function validateUnitUser(value: string): string {
  if (value === "root" || !APP_RUN_AS_RE.test(value)) {
    throw new ConfigurationError("unit_config.user must be a canonical non-root Linux user");
  }
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === null || value === undefined ? undefined : requiredString(value, label);
}
function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === null || value === undefined ? undefined : booleanValue(value, label);
}
function uniqueStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_JSON_ITEMS) {
    throw new ConfigurationError(`${label} must be a bounded list`);
  }
  const result = value.map((item) => requiredString(item, label));
  if (new Set(result).size !== result.length) {
    throw new ConfigurationError(`${label} contains duplicate values`);
  }
  return freezeArray(result);
}
function stringMapping(value: unknown, label: string): Readonly<Record<string, string>> {
  const source = objectValue(value, label);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    output[requiredString(key, label)] = requiredString(item, label);
  }
  return Object.freeze(output);
}
function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ConfigurationError(`${label} is out of range`);
  }
  return value as number;
}
function sha256Text(value: unknown): string {
  const text = requiredString(value, "sha256");
  if (!SHA256_RE.test(text)) throw new ConfigurationError("Invalid sha256 format");
  return text;
}
function bounded(value: unknown): string {
  return String(value).slice(0, MAX_MESSAGE_CHARS);
}
function boundedOptional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : bounded(value);
}
function statusText(value: string | { readonly value?: string }): string {
  return typeof value === "string" ? value : requiredString(value.value, "status");
}
function equalJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}
function setEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}
function freezeRecordDeep<T extends object>(value: T): Readonly<T> {
  for (const item of Object.values(value)) {
    if (Array.isArray(item)) Object.freeze(item);
    else if (item && typeof item === "object" && !Object.isFrozen(item)) Object.freeze(item);
  }
  return Object.freeze(value);
}

function ipAddresses(value: unknown, label: string, allowScalar: boolean): readonly string[] {
  const raw = allowScalar && value === null
    ? []
    : allowScalar && typeof value === "string"
    ? [value]
    : value;
  const values = uniqueStrings(raw, label);
  for (const address of values) {
    if (!isIpAddress(address)) {
      throw new ConfigurationError(`${label} is not a valid IP: ${address}`);
    }
  }
  return values;
}

function isIpAddress(value: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    return value.split(".").every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 255);
  }
  if (!value.includes(":")) return false;
  try {
    const url = new URL(`http://[${value}]/`);
    return url.hostname.startsWith("[") && url.hostname.endsWith("]");
  } catch {
    return false;
  }
}

function permissionText(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (text !== text.trim() || /[\s,]/u.test(text) || containsAsciiControl(text)) {
    throw new ConfigurationError(`${label} contains whitespace, control characters, or commas`);
  }
  return text;
}

function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function runtimeExecutable(value: unknown): string {
  const text = permissionText(value, "script_runtime.executable");
  if (
    text.includes("\\") ||
    (text.includes("/")
      ? !text.startsWith("/") || text.startsWith("//") || text === "/" ||
        text.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))
      : !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(text))
  ) {
    throw new ConfigurationError(
      "script_runtime.executable must be a bare command name or a canonical absolute POSIX path",
    );
  }
  return text;
}

function validateRunPermissions(values: readonly string[]): readonly string[] {
  const result = values.map((value, index) => {
    const text = permissionText(value, `permissions.run[${index}]`);
    if (
      !text.startsWith("/") || text.startsWith("//") || text === "/" || text.includes("\\") ||
      text.split("/").some((part, partIndex) =>
        partIndex > 0 && (!part || part === "." || part === "..")
      )
    ) {
      throw new ConfigurationError(
        `permissions.run[${index}] must be a canonical absolute POSIX executable path`,
      );
    }
    return text;
  });
  if (new Set(result).size !== result.length) {
    throw new ConfigurationError("permissions.run contains duplicate values");
  }
  return freezeArray(result);
}

function validatePathPermissions(
  values: readonly string[],
  label: string,
): readonly string[] {
  const result = values.map((value, index) => {
    const text = permissionText(value, `${label}[${index}]`);
    if (
      !text.startsWith("/") || text.startsWith("//") || text === "/" || text.includes("\\") ||
      text.split("/").some((part, partIndex) =>
        partIndex > 0 && (!part || part === "." || part === "..")
      )
    ) {
      throw new ConfigurationError(
        `${label}[${index}] must be a canonical absolute POSIX file path`,
      );
    }
    return text;
  });
  if (new Set(result).size !== result.length) {
    throw new ConfigurationError(`${label} contains duplicate values`);
  }
  return freezeArray(result);
}

function validateNetPermissions(values: readonly string[]): readonly string[] {
  const result = values.map((value, index) => {
    const text = permissionText(value, `permissions.net[${index}]`);
    if (/[\/@*?#\\]/.test(text)) {
      throw new ConfigurationError(`Invalid permissions.net[${index}] network target`);
    }
    let host = text;
    let port: string | undefined;
    if (text.startsWith("[")) {
      const match = /^\[([^\[\]]+)\](?::(\d+))?$/.exec(text);
      if (!match || !isIpAddress(match[1]) || !match[1].includes(":")) {
        throw new ConfigurationError("Invalid permissions.net IPv6 address format");
      }
      host = match[1];
      port = match[2];
    } else if (text.split(":").length > 2) {
      if (!isIpAddress(text)) {
        throw new ConfigurationError("IPv6 with a port must use square brackets");
      }
    } else {
      const index = text.lastIndexOf(":");
      if (index > 0) {
        host = text.slice(0, index);
        port = text.slice(index + 1);
      }
      if (
        !isIpAddress(host) &&
        (!host || host.length > 253 ||
          host.split(".").some((part) =>
            !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part)
          ))
      ) throw new ConfigurationError("Invalid permissions.net host name");
    }
    if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      throw new ConfigurationError("permissions.net port must be within 1..65535");
    }
    return text;
  });
  if (new Set(result).size !== result.length) {
    throw new ConfigurationError("permissions.net contains duplicate values");
  }
  return freezeArray(result);
}

async function safeLstat(path: string): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return undefined;
    throw cause;
  }
}

function sameFileIdentity(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  return left.dev !== null && left.ino !== null && right.dev !== null &&
    right.ino !== null && left.dev === right.dev && left.ino === right.ino;
}

async function pathExists(path: string): Promise<boolean> {
  return (await safeLstat(path)) !== undefined;
}

async function assertSnapshotOperation(snapshot: string, operation: string): Promise<void> {
  const hasRollback = await pathExists(join(snapshot, "rollback-plan.json"));
  const expectsRollback = operation === "deploy" || operation === "rollback";
  if (hasRollback !== expectsRollback) {
    throw new ConfigurationError(
      expectsRollback
        ? "Release or rollback snapshot is missing the rollback plan"
        : "Non-release lifecycle snapshot must not contain a rollback plan",
    );
  }
}

export const __internal = Object.freeze({
  atomicJson,
  readJson,
  readRegularBytes,
  writeAll,
  HARD_LINK_SETTLE_DELAYS_MS,
  decodePlan,
  encodePlan,
  validateStepGraph,
  validatePlanSemantics,
  parseJsonStrict,
  safeRelative,
  validateExecutionAgainstPlan,
});
