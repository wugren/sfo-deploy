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
  AppManagementHook,
  ConfigTemplate,
  DeploymentDefinition,
  EnvironmentInstance,
  ExecutionPlan,
  Machine,
  ManagedConfigFile,
  ManagedConfigPathSegment,
  ManagedConfigVariableBinding,
  ManagedSecretReference,
  PackageSpec,
  PlanDeliveryInputs,
  PlanStep,
  ResolvedMachine,
  ScriptInvocation,
  ScriptRuntime,
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
]);
const STEP_STATUSES = new Set(["succeeded", "failed", "skipped", "blocked", "cancelled"]);
const PLAN_STEP_ACTIONS: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> =
  Object.freeze({
    check: { environment: new Set(["check"]), app: new Set<string>() },
    install: { environment: new Set(["install"]), app: new Set<string>() },
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
      app: new Set(["check", "configure", "deploy", "stage", "activate"]),
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
      throw new ConfigurationError("with_dependencies 必须是布尔值");
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
        throw new ConfigurationError("无法创建发布操作锁", { cause });
      }
      try {
        file = await Deno.open(this.path, { read: true, write: true });
      } catch (openCause) {
        throw new ConfigurationError("发布操作锁不是安全普通文件", { cause: openCause });
      }
    }
    try {
      const current = await Deno.lstat(this.path);
      const opened = await file.stat();
      if (
        !current.isFile || current.isSymlink || current.nlink !== 1 ||
        !opened.isFile || opened.nlink !== 1 || !sameFileIdentity(current, opened)
      ) {
        throw new ConfigurationError("发布操作锁不是安全普通文件");
      }
      if (created) {
        await Deno.chmod(this.path, 0o600);
        await writeAll(file, new Uint8Array([0]), "发布操作锁");
        await file.sync();
      } else if (opened.size === 0) {
        throw new ConfigurationError("现有发布操作锁为空，拒绝不安全地修改");
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
        throw new ConfigurationError("无法获取发布操作锁", { cause });
      }
      if (performance.now() >= deadline) {
        file.close();
        throw new ConfigurationError("同一集群已有发布或回退操作正在执行");
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
      throw new TypeError("ReleaseStore 需要 sourceExporter 和 sourceImporter");
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
      throw new ConfigurationError(`发布历史不支持的操作: ${operation}`);
    }
    if (!(selection instanceof ReleaseSelection)) {
      throw new TypeError("selection 必须是 ReleaseSelection");
    }
    if ((operation === "rollback") !== (sourceReleaseId !== undefined)) {
      throw new ConfigurationError(
        operation === "rollback"
          ? "rollback attempt 必须关联来源发布 ID"
          : `${operation} attempt 不能关联来源发布 ID`,
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
        throw new ConfigurationError(`发布 ID 已经存在: ${releaseId}`);
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
        throw new ConfigurationError(`发布历史包含非法目录项: ${entry.name}`);
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
      throw new ConfigurationError(`发布记录不存在: ${releaseId}`);
    }
    return await this.readRecord(path);
  }

  async loadRollbackPlan(releaseId: string): Promise<ExecutionPlan> {
    const record = await this.get(releaseId);
    if (!record.rollbackEligible) {
      throw new ConfigurationError(`发布记录不可回退: ${releaseId} status=${record.status}`);
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
      throw new ConfigurationError(`不支持的发布记录 schema: ${String(intent.schema_version)}`);
    }
    const releaseId = basename(releaseDirectory);
    if (intent.release_id !== releaseId || intent.cluster !== this.cluster) {
      throw new ConfigurationError(`发布记录身份不匹配: ${releaseId}`);
    }
    const operation = requiredString(intent.operation, "operation");
    if (!RELEASE_OPERATIONS.has(operation)) {
      throw new ConfigurationError(`发布记录 operation 非法: ${operation}`);
    }
    const sourceReleaseId = optionalString(intent.source_release_id, "source_release_id");
    if ((operation === "rollback") !== (sourceReleaseId !== undefined)) {
      throw new ConfigurationError("发布记录 operation/source_release_id 绑定非法");
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
      throw new ConfigurationError("不支持的 outcome schema");
    }
    const status = requiredString(outcome.status, "status");
    if (!(["succeeded", "failed", "cancelled"] as string[]).includes(status)) {
      throw new ConfigurationError(`发布记录状态非法: ${status}`);
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
        throw new ConfigurationError("发布记录 operation 与实际执行计划 requested_action 不一致");
      }
      const expected = planSummary(actualPlan);
      if (
        !equalJson(apps, expected.apps) || !equalJson(machines, expected.machines) ||
        !equalJson(appVersions, expected.appVersions)
      ) {
        throw new ConfigurationError("发布结果元数据与实际执行计划不一致");
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
      throw new ConfigurationError("发布快照不存在或不是安全目录");
    }
    const manifest = objectValue(
      await readJson(join(snapshot, "manifest.json"), MAX_JSON_BYTES),
      "snapshot manifest",
    );
    expectKeys(manifest, ["schema_version", "release_id", "cluster", "files"], "snapshot manifest");
    if (manifest.schema_version !== RELEASE_SCHEMA_VERSION || !Array.isArray(manifest.files)) {
      throw new ConfigurationError("发布快照 manifest 非法");
    }
    const manifestReleaseId = validateReleaseId(
      requiredString(manifest.release_id, "snapshot release_id"),
    );
    if (releaseId !== undefined && manifestReleaseId !== releaseId) {
      throw new ConfigurationError("发布快照与 attempt ID 不匹配");
    }
    if (requiredString(manifest.cluster, "snapshot cluster") !== this.cluster) {
      throw new ConfigurationError("发布快照与当前集群不匹配");
    }
    const expected = new Map<string, readonly [string, number]>();
    let total = 0;
    for (const raw of manifest.files) {
      const item = objectValue(raw, "snapshot file");
      expectKeys(item, ["path", "sha256", "size"], "snapshot file");
      const path = safeRelative(requiredString(item.path, "snapshot path"));
      const digest = sha256Text(item.sha256);
      const size = boundedInteger(item.size, "snapshot size", 0, MAX_ARCHIVE_FILE_BYTES);
      if (expected.has(path)) throw new ConfigurationError(`快照文件重复: ${path}`);
      expected.set(path, [digest, size]);
      total += size;
    }
    if (expected.size > MAX_ARCHIVE_FILES || total > MAX_SNAPSHOT_BYTES) {
      throw new ConfigurationError("发布快照超过容量限制");
    }
    const actual = new Set<string>();
    await walkSnapshot(snapshot, async (path, entry) => {
      const rel = relative(snapshot, path).split(SEPARATOR).join("/");
      if (rel === "manifest.json") return;
      if (entry.isSymlink) throw new ConfigurationError(`快照禁止符号链接: ${rel}`);
      if (entry.isDirectory) {
        if (rel !== "files") throw new ConfigurationError(`快照包含未登记目录: ${rel}`);
        return;
      }
      if (!entry.isFile) throw new ConfigurationError(`快照包含非普通文件: ${rel}`);
      actual.add(rel);
      const wanted = expected.get(rel);
      if (!wanted) throw new ConfigurationError(`快照包含未登记文件: ${rel}`);
      const found = await hashRegularFile(path);
      if (wanted[0] !== found.hash || wanted[1] !== found.size) {
        throw new ConfigurationError(`快照文件完整性失败: ${rel}`);
      }
    });
    const missing = [...expected.keys()].filter((path) => !actual.has(path)).sort();
    if (missing.length) throw new ConfigurationError(`快照缺少文件: ${missing.join(", ")}`);
    if (!expected.has("actual-plan.json")) throw new ConfigurationError("发布快照缺少实际执行计划");
    const actualPlan = await this.readPlan(snapshot, "actual-plan.json");
    if (actualPlan.cluster !== this.cluster) {
      throw new ConfigurationError("发布快照执行计划集群不匹配");
    }
    if (expected.has("rollback-plan.json")) {
      const rollbackPlan = await this.readPlan(snapshot, "rollback-plan.json");
      if (rollbackPlan.cluster !== this.cluster) {
        throw new ConfigurationError("发布快照回退计划集群不匹配");
      }
      if (rollbackPlan.requestedAction !== "rollback") {
        throw new ConfigurationError("发布快照回退计划动作非法");
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
      throw new ConfigurationError(`集群目录不存在: ${this.clusterDirectory}`);
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
      throw new ConfigurationError("非发布 attempt 计划动作非法");
    }
    return await this.#archiveSnapshot(executedPlan);
  }

  async #archiveSnapshot(
    executedPlan: ExecutionPlan,
    rollback?: ExecutionPlan,
  ): Promise<ExecutionPlan> {
    this.#requireOpen();
    if (requiredString(this.intent.operation, "operation") !== executedPlan.requestedAction) {
      throw new ConfigurationError("attempt operation 与实际执行计划动作不一致");
    }
    if (executedPlan.cluster !== this.store.cluster) {
      throw new ConfigurationError("实际执行计划与当前集群不匹配");
    }
    if (
      rollback !== undefined &&
      (rollback.cluster !== this.store.cluster || rollback.requestedAction !== "rollback")
    ) {
      throw new ConfigurationError("回退计划必须绑定当前集群且 requested_action=rollback");
    }
    const temporary = join(this.releaseDirectory, `.snapshot-${randomHex(8)}`);
    await Deno.mkdir(join(temporary, "files"), { recursive: true, mode: 0o700 });
    const archive = new ArchiveWriter(temporary, this.store.clusterDirectory);
    try {
      const legacy = executedPlan.steps.some((step) =>
        step.machine.machine.scriptRuntime.kind === "python"
      );
      const actualData = await encodePlan(
        executedPlan,
        archive,
        this.store.sourceExporter,
        legacy ? 1 : PLAN_SCHEMA_VERSION,
      );
      await atomicJson(join(temporary, "actual-plan.json"), actualData, { exclusive: true });
      if (rollback !== undefined) {
        const rollbackData = await encodePlan(
          rollback,
          archive,
          this.store.sourceExporter,
          legacy ? 1 : PLAN_SCHEMA_VERSION,
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
        throw new ConfigurationError("发布 attempt 已经包含 snapshot");
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
    const runtimeKinds = new Set(plan.steps.map((step) => step.machine.machine.scriptRuntime.kind));
    if (
      runtimeKinds.size !== 1 ||
      ![...runtimeKinds].every((kind) => kind === "deno" || kind === "python")
    ) {
      throw new ConfigurationError("回退计划包含混合或未知脚本运行时");
    }
    return await this.archivePlans(plan, plan);
  }

  async finishResult(result: DeploymentResultLike): Promise<ReleaseRecord> {
    this.#requireOpen();
    if (result.cluster !== this.store.cluster) {
      throw new ConfigurationError("部署结果与发布 attempt 集群不匹配");
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
      throw new ConfigurationError("部署结果动作与实际执行计划不一致");
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
      throw new TypeError("错误终态必须是 failed 或 cancelled");
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
      throw new ExecutionError(`无法终结发布历史 ${this.releaseId}: ${String(cause)}`, { cause });
    } finally {
      this.#closed = true;
      await this.#lock.release();
    }
    try {
      return await this.store.get(this.releaseId);
    } catch (cause) {
      throw new ExecutionError(`发布历史终态校验失败 ${this.releaseId}: ${String(cause)}`, {
        cause,
      });
    }
  }

  #requireOpen(): void {
    if (this.#closed) throw new ExecutionError(`发布 attempt 已终结: ${this.releaseId}`);
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
    const data = await readRegularBytes(source, MAX_ARCHIVE_FILE_BYTES, "发布快照来源");
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
        throw new ConfigurationError("发布快照超过容量限制");
      }
      const rel = `files/${digest}`;
      const target = join(this.snapshot, "files", digest);
      const file = await Deno.open(target, { createNew: true, write: true, mode: 0o600 });
      try {
        await writeAll(file, data, "发布快照文件");
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
    throw new ConfigurationError("执行计划为空或超过步骤限制");
  }
  const byId = new Map<string, PlanStep>(plan.steps.map((step) => [step.id, step]));
  if (byId.size !== plan.steps.length) throw new ConfigurationError("执行计划包含重复步骤 ID");
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
  const appIds = new Set<string>(
    plan.steps.filter((step) =>
      step.kind === "app" &&
      (step.action === "configure" || step.action === "deploy" ||
        step.action === "stage" || step.action === "activate" ||
        (step.action === "check" && packagelessResources.has(step.resource)))
    ).map((step) => step.id),
  );
  if (
    !packagelessResources.size &&
    ![...appIds].some((id) => ["deploy", "stage", "activate"].includes(byId.get(id)?.action ?? ""))
  ) {
    throw new ConfigurationError("发布计划不包含可回退的 App deploy 步骤");
  }
  const environmentCheck = (dependency: string): string => {
    const index = dependency.lastIndexOf(":");
    const candidate = `${index < 0 ? dependency : dependency.slice(0, index)}:check`;
    const step = byId.get(candidate);
    if (!step || step.kind !== "environment" || step.action !== "check") {
      throw new ConfigurationError(`回退计划缺少环境检查步骤: ${candidate}`);
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
      else throw new ConfigurationError(`回退计划包含无法映射的依赖: ${dependency}`);
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
  schemaVersion: 1 | 4,
): Promise<JsonObject> {
  if (
    !plan || !Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_STEPS
  ) throw new ConfigurationError("执行计划为空或超过步骤限制");
  validateStepGraph(plan.steps);
  validatePlanSemantics(plan.requestedAction, plan.steps);
  return {
    schema_version: schemaVersion,
    cluster: requiredString(plan.cluster, "cluster"),
    requested_action: requiredString(plan.requestedAction, "requested_action"),
    steps: await Promise.all(
      plan.steps.map((step) => encodeStep(step, archive, sourceExporter, schemaVersion)),
    ),
  };
}

async function encodeStep(
  step: PlanStep,
  archive: ArchiveWriter,
  sourceExporter: SourceExporter,
  schemaVersion: 1 | 4,
): Promise<JsonObject> {
  const machine = step.machine.machine;
  const runtime = machine.scriptRuntime;
  if (!runtime) throw new ConfigurationError("计划机器缺少显式脚本运行时");
  if (!step.scripts.length && schemaVersion !== 4) {
    throw new ConfigurationError("legacy 计划步骤必须包含显式脚本调用");
  }
  if (schemaVersion === 4 && runtime.kind !== "deno") {
    throw new ConfigurationError("execution-plan v4 只接受 Deno 运行时");
  }
  if (schemaVersion === 1 && runtime.kind !== "python") {
    throw new ConfigurationError("execution-plan v1 兼容编码只接受 Python 运行时");
  }
  const declaredRunAs = step.management?.runAs;
  const runAs = step.runAs ?? declaredRunAs;
  const isVersionedStage = step.kind === "app" && step.action === "stage" &&
    step.deployment?.kind === "versioned";
  if (step.management !== undefined) {
    if (runAs === undefined) throw new ConfigurationError("managed plan-v4 步骤缺少 run_as");
    validateAppRunAs(runAs);
    if (declaredRunAs !== undefined && declaredRunAs !== runAs) {
      throw new ConfigurationError("managed plan-v4 步骤包含不一致的 run_as");
    }
    if (
      step.lifecycleSecretValues === undefined ||
      step.lifecycleSecretFiles === undefined
    ) {
      throw new ConfigurationError("managed plan-v4 步骤缺少生命周期秘密声明");
    }
  } else if (isVersionedStage) {
    if (runAs === undefined) throw new ConfigurationError("versioned stage 步骤缺少 run_as");
    validateAppRunAs(runAs);
  } else if (runAs !== undefined) {
    throw new ConfigurationError("非 managed plan-v4 步骤不能声明 run_as");
  }
  let sshKey: string | null = null;
  if (machine.sshPrivateKey !== undefined) {
    const rel = relative(archive.clusterDirectory, resolve(machine.sshPrivateKey)).split(SEPARATOR)
      .join("/");
    if (rel.startsWith("../") || rel === "..") {
      throw new ConfigurationError("SSH 私钥只能保存集群目录内的逻辑相对路径");
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
      throw new ConfigurationError("provider source exporter 必须返回 schema/payload envelope");
    }
    validateJson(envelope.payload);
    packageData = {
      provider: step.package.provider,
      source: envelope,
      hash_algorithm: step.package.hashAlgorithm,
      hash_value: step.package.hashValue,
    };
  }
  const scripts = schemaVersion === 1
    ? await Promise.all(step.scripts.map((invocation) => archive.add(invocation.source)))
    : await Promise.all(step.scripts.map(async (invocation) => ({
      source: await archive.add(invocation.source),
      relative_path: invocation.relativePath,
      permissions: {
        run: validateRunPermissions(invocation.permissions.run),
        net: validateNetPermissions(invocation.permissions.net),
      },
    })));
  return {
    id: step.id,
    machine: {
      definition: {
        name: machine.name,
        domains: machine.domains,
        private_ip: schemaVersion === 1 ? machine.privateIp[0] ?? null : machine.privateIp,
        public_ip: schemaVersion === 1 ? machine.publicIp[0] ?? null : machine.publicIp,
        region: machine.region,
        ssh_user: machine.sshUser,
        ssh_port: machine.sshPort,
        ssh_private_key: sshKey,
        ...(schemaVersion === 4 && machine.secretsDir !== undefined
          ? { secrets_dir: machine.secretsDir }
          : {}),
        ...(schemaVersion === 1 ? { python: runtime.executable } : {
          script_runtime: { kind: "deno", executable: runtimeExecutable(runtime.executable) },
        }),
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
    ...(schemaVersion === 4
      ? {
        secret_values: step.secretValues,
        secret_files: step.secretFiles,
        run_as: runAs ?? null,
        lifecycle_secret_values: step.lifecycleSecretValues ?? [],
        lifecycle_secret_files: step.lifecycleSecretFiles ?? [],
      }
      : { config_secrets: [], file_secrets: [] }),
    install_directory: step.installDirectory ?? null,
    bundle_scripts: step.bundleScripts === undefined ? null : await Promise.all(
      step.bundleScripts.map(async (invocation) => ({
        source: await archive.add(invocation.source),
        relative_path: invocation.relativePath,
        permissions: {
          run: validateRunPermissions(invocation.permissions.run),
          net: validateNetPermissions(invocation.permissions.net),
        },
      })),
    ),
    ...(schemaVersion === 4
      ? {
        deployment: step.deployment ?? null,
        management: step.management === undefined
          ? null
          : await encodeManagement(step.management, archive),
        delivery_inputs: step.deliveryInputs === undefined
          ? null
          : await encodeDeliveryInputs(step.deliveryInputs, archive),
      }
      : {}),
    depends_on: step.dependsOn,
  };
}

function decodeDeployment(value: unknown): DeploymentDefinition {
  const item = objectValue(value, "deployment");
  expectKeys(item, ["kind"], "deployment");
  if (item.kind !== "versioned") {
    throw new ConfigurationError("deployment.kind 只支持 versioned");
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
  const hooks = await Promise.all(
    [...management.hooks.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      async ([hook, scripts]) => ({
        hook,
        scripts: await Promise.all(scripts.map((script) => encodeInvocation(script, archive))),
      }),
    ),
  );
  return {
    configs,
    service: management.service === undefined ? null : {
      kind: management.service.kind,
      unit: management.service.unit,
      enabled: management.service.enabled ?? null,
      daemon_reload: management.service.daemonReload,
      on_deploy: management.service.onDeploy,
      timeout_ms: management.service.timeoutMs,
      ...(management.service.unitConfig === undefined ? {} : {
        unit_config: {
          target: management.service.unitConfig.target,
          working_directory: management.service.unitConfig.workingDirectory,
          command: management.service.unitConfig.command,
          args: management.service.unitConfig.args,
        },
      }),
    },
    hooks,
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
  const permissions = objectValue(item.permissions, `${label}.permissions`);
  expectKeys(permissions, ["run", "net"], `${label}.permissions`);
  return Object.freeze({
    source: await snapshotFile(snapshot, item.source),
    relativePath: safeRelative(requiredString(item.relative_path, `${label}.relative_path`)),
    permissions: Object.freeze({
      run: validateRunPermissions(uniqueStrings(permissions.run, `${label}.permissions.run`)),
      net: validateNetPermissions(uniqueStrings(permissions.net, `${label}.permissions.net`)),
    }),
  });
}

async function decodeManagement(
  raw: unknown,
  snapshot: string,
  runAs?: string,
  deployment?: DeploymentDefinition,
): Promise<AppManagementDefinition | undefined> {
  if (raw === null || raw === undefined) return undefined;
  const value = objectValue(raw, "management");
  expectKeys(value, ["configs", "service", "hooks"], "management");
  if (!Array.isArray(value.configs) || value.configs.length > MAX_JSON_ITEMS) {
    throw new ConfigurationError("management.configs 必须是有界列表");
  }
  const configs = freezeArray(
    await Promise.all(value.configs.map(async (rawConfig) => {
      const config = objectValue(rawConfig, "managed config");
      if (config.updater !== undefined) {
        throw new ConfigurationError(
          "旧发布快照包含 managed config.updater，请先在旧版本完成回滚；新契约只支持 format/secret_references",
        );
      }
      expectKeys(config, [
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
      ], "managed config");
      if (!Array.isArray(config.variables) || config.variables.length > MAX_JSON_ITEMS) {
        throw new ConfigurationError("managed config variables 必须是有界列表");
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
        throw new ConfigurationError("managed config.target 必须是安全绝对路径");
      }
      const onChange = requiredString(config.on_change, "managed config.on_change");
      if (onChange !== "none" && onChange !== "reload" && onChange !== "restart") {
        throw new ConfigurationError("managed config.on_change 非法");
      }
      const format = requiredString(config.format, "managed config.format");
      if (format !== "yaml" && format !== "json" && format !== "toml" && format !== "ini") {
        throw new ConfigurationError("managed config.format 非法");
      }
      if (
        !Array.isArray(config.secret_references) || config.secret_references.length > MAX_JSON_ITEMS
      ) {
        throw new ConfigurationError("managed config.secret_references 必须是有界列表");
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
                throw new ConfigurationError("file secret reference.value_type 必须是 string");
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
  let service: AppManagementDefinition["service"];
  if (value.service !== null && value.service !== undefined) {
    const rawService = objectValue(value.service, "management.service");
    expectKeysOptional(
      rawService,
      [
        "kind",
        "unit",
        "enabled",
        "daemon_reload",
        "on_deploy",
        "timeout_ms",
      ],
      ["unit_config"],
      "management.service",
    );
    if (rawService.kind !== "systemd") throw new ConfigurationError("service.kind 非法");
    const enabled = rawService.enabled === null
      ? undefined
      : booleanValue(rawService.enabled, "service.enabled");
    const onDeploy = requiredString(rawService.on_deploy, "service.on_deploy");
    if (!["none", "start", "reload", "restart"].includes(onDeploy)) {
      throw new ConfigurationError("service.on_deploy 非法");
    }
    service = Object.freeze({
      kind: "systemd",
      unit: requiredString(rawService.unit, "service.unit"),
      enabled,
      daemonReload: booleanValue(rawService.daemon_reload, "service.daemon_reload"),
      onDeploy: onDeploy as "none" | "start" | "reload" | "restart",
      timeoutMs: boundedInteger(rawService.timeout_ms, "service.timeout_ms", 1, 86_400_000),
      ...(rawService.unit_config === undefined ? {} : {
        unitConfig: decodeSystemdUnitConfig(
          rawService.unit_config,
          requiredString(rawService.unit, "service.unit"),
          "management.service.unit_config",
        ),
      }),
    });
  }
  if (!Array.isArray(value.hooks) || value.hooks.length > MAX_JSON_ITEMS) {
    throw new ConfigurationError("management.hooks 必须是有界列表");
  }
  const hookNames = new Set<string>();
  const hooks: Array<readonly [AppManagementHook, readonly ScriptInvocation[]]> = [];
  for (const rawHook of value.hooks) {
    const item = objectValue(rawHook, "management hook");
    expectKeys(item, ["hook", "scripts"], "management hook");
    const hook = managementHook(item.hook);
    if (hookNames.has(hook)) throw new ConfigurationError(`management hook 重复: ${hook}`);
    hookNames.add(hook);
    if (!Array.isArray(item.scripts) || item.scripts.length > MAX_JSON_ITEMS) {
      throw new ConfigurationError("management hook scripts 必须是有界列表");
    }
    hooks.push([
      hook,
      freezeArray(
        await Promise.all(
          item.scripts.map((script) =>
            decodeInvocation(script, snapshot, "management hook script")
          ),
        ),
      ),
    ]);
  }
  if (
    configs.length === 0 && service === undefined && hooks.length === 0 &&
    !(runAs !== undefined && deployment?.kind === "versioned")
  ) {
    throw new ConfigurationError("management 声明不能为空");
  }
  return Object.freeze({ runAs, configs, service, hooks: immutableMap(hooks) });
}

function decodeSystemdUnitConfig(
  raw: unknown,
  unit: string,
  label: string,
) {
  const value = objectValue(raw, label);
  expectKeys(value, ["target", "working_directory", "command", "args"], label);
  const target = safeAbsoluteRemotePath(value.target, `${label}.target`);
  if (basename(target) !== unit) {
    throw new ConfigurationError(`${label}.target 文件名必须与 service.unit 一致`);
  }
  return Object.freeze({
    target,
    workingDirectory: safeAbsoluteRemotePath(
      value.working_directory,
      `${label}.working_directory`,
    ),
    command: safeAbsoluteRemotePath(value.command, `${label}.command`),
    args: freezeArray(
      uniqueStrings(value.args, `${label}.args`).map((argument) => {
        if (containsAsciiControl(argument)) {
          throw new ConfigurationError(`${label}.args 包含控制字符`);
        }
        return argument;
      }),
    ),
  });
}

function safeAbsoluteRemotePath(raw: unknown, label: string): string {
  const text = requiredString(raw, label);
  if (
    !isAbsolute(text) || text.includes("\\") || containsAsciiControl(text) ||
    text === "/" || text.startsWith("//") || text.split("/").includes("..")
  ) {
    throw new ConfigurationError(`${label} 必须是安全远端绝对路径`);
  }
  return text;
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
  ) throw new ConfigurationError("delivery_inputs 必须包含有界 scripts/files 列表");
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
  if (argv.length === 0) throw new ConfigurationError("managed config validator.argv 不能为空");
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
    throw new ConfigurationError(`${label} 必须是非空有界列表`);
  }
  return freezeArray(raw.map((segment) => {
    if (typeof segment === "string" && segment.length > 0) return requiredString(segment, label);
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return segment;
    }
    throw new ConfigurationError(`${label} 包含非法段`);
  }));
}

function configValueType(raw: unknown): "string" | "integer" | "number" | "boolean" {
  const value = requiredString(raw, "managed config value_type");
  if (!["string", "integer", "number", "boolean"].includes(value)) {
    throw new ConfigurationError("managed config value_type 非法");
  }
  return value as "string" | "integer" | "number" | "boolean";
}

function secretKind(raw: unknown): "value" | "file" {
  const value = requiredString(raw, "secret_kind");
  if (value !== "value" && value !== "file") throw new ConfigurationError("secret_kind 非法");
  return value;
}

function booleanValue(raw: unknown, label: string): boolean {
  if (typeof raw !== "boolean") throw new ConfigurationError(`${label} 必须是布尔值`);
  return raw;
}

function managementHook(raw: unknown): AppManagementHook {
  const value = requiredString(raw, "management hook");
  const allowed = new Set<string>([
    "before_install",
    "after_install",
    "before_configure",
    "after_configure",
    "before_deploy",
    "after_deploy",
    "before_start",
    "after_start",
    "before_stop",
    "after_stop",
    "before_restart",
    "after_restart",
  ]);
  if (!allowed.has(value)) throw new ConfigurationError(`management hook 非法: ${value}`);
  return value as AppManagementHook;
}

async function decodePlan(
  value: unknown,
  snapshot: string,
  clusterDirectory: string,
  sourceImporter: SourceImporter,
): Promise<ExecutionPlan> {
  const plan = objectValue(value, "execution plan");
  expectKeys(plan, ["schema_version", "cluster", "requested_action", "steps"], "execution plan");
  const schema = plan.schema_version;
  if (
    (schema !== 1 && schema !== 2 && schema !== 3 && schema !== 4) || !Array.isArray(plan.steps) ||
    plan.steps.length === 0 || plan.steps.length > MAX_STEPS
  ) throw new ConfigurationError("执行计划 schema 非法");
  const requestedAction = requiredString(plan.requested_action, "requested_action");
  if (!PLAN_ACTIONS.has(requestedAction)) {
    throw new ConfigurationError(`执行计划 requested_action 非法: ${requestedAction}`);
  }
  const steps = await Promise.all(
    plan.steps.map((item) => decodeStep(item, snapshot, clusterDirectory, sourceImporter, schema)),
  );
  validateStepGraph(steps);
  validatePlanSemantics(requestedAction, steps);
  return Object.freeze({
    schemaVersion: schema === 4 ? 4 : 3,
    cluster: requiredString(plan.cluster, "cluster"),
    requestedAction,
    steps: freezeArray(steps),
  });
}

async function decodeStep(
  raw: unknown,
  snapshot: string,
  clusterDirectory: string,
  sourceImporter: SourceImporter,
  schema: 1 | 2 | 3 | 4,
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
        ? ["run_as", "lifecycle_secret_values", "lifecycle_secret_files", "deployment"]
        : []),
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
      schema === 1 ? "python" : "script_runtime",
      "environments",
    ],
    schema >= 3 ? ["secrets_dir"] : [],
    "machine",
  );
  if (!Array.isArray(definition.environments)) {
    throw new ConfigurationError("machine.environments 必须是列表");
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
      throw new ConfigurationError("requires_privilege 必须是布尔值或 null");
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
  let scriptRuntime: ScriptRuntime;
  if (schema === 1) {
    scriptRuntime = Object.freeze({
      kind: "python",
      executable: requiredString(definition.python, "python"),
    });
  } else {
    const runtime = objectValue(definition.script_runtime, "script_runtime");
    expectKeys(runtime, ["kind", "executable"], "script_runtime");
    if (runtime.kind !== "deno") {
      throw new ConfigurationError("execution-plan v2/v3/v4 运行时 kind 必须是 deno");
    }
    scriptRuntime = Object.freeze({
      kind: "deno",
      executable: runtimeExecutable(runtime.executable),
    });
  }
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
    scriptRuntime,
    environments: freezeArray(environments),
  });
  const addressKind = requiredString(machineValue.address_kind, "address_kind");
  if (addressKind !== "private" && addressKind !== "public") {
    throw new ConfigurationError("address_kind 非法");
  }
  const addresses = addressKind === "private" ? privateIp : publicIp;
  const address = requiredString(machineValue.address, "address");
  if (!addresses.length || address !== addresses[0]) {
    throw new ConfigurationError("resolved machine 主地址与候选地址不匹配");
  }
  const resolvedMachine: ResolvedMachine = Object.freeze({
    machine,
    address,
    addressKind,
    addresses,
  });
  let scripts: readonly ScriptInvocation[];
  if (schema === 1) {
    scripts = freezeArray(
      await Promise.all(
        uniqueStrings(value.scripts, "scripts").map(async (item) =>
          Object.freeze({
            source: await snapshotFile(snapshot, item),
            relativePath: "",
            permissions: Object.freeze({ run: freezeArray([]), net: freezeArray([]) }),
          })
        ),
      ),
    );
  } else {
    if (!Array.isArray(value.scripts) || value.scripts.length > MAX_JSON_ITEMS) {
      throw new ConfigurationError("scripts 必须是有界列表");
    }
    scripts = freezeArray(
      await Promise.all(value.scripts.map(async (rawScript) => {
        const item = objectValue(rawScript, "script invocation");
        expectKeysOptional(item, ["source", "permissions"], ["relative_path"], "script invocation");
        const permissions = objectValue(item.permissions, "script permissions");
        expectKeys(permissions, ["run", "net"], "script permissions");
        return Object.freeze({
          source: await snapshotFile(snapshot, item.source),
          relativePath: typeof item.relative_path === "string" ? item.relative_path : "",
          permissions: Object.freeze({
            run: validateRunPermissions(uniqueStrings(permissions.run, "permissions.run")),
            net: validateNetPermissions(uniqueStrings(permissions.net, "permissions.net")),
          }),
        });
      })),
    );
  }
  if (!scripts.length && schema < 4) {
    throw new ConfigurationError("legacy 计划步骤必须包含至少一个脚本调用");
  }
  let bundleScripts: readonly ScriptInvocation[] | undefined;
  if (schema >= 2 && value.bundle_scripts !== null && value.bundle_scripts !== undefined) {
    if (!Array.isArray(value.bundle_scripts) || value.bundle_scripts.length > MAX_JSON_ITEMS) {
      throw new ConfigurationError("bundle_scripts 必须是有界列表");
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
        const permissions = objectValue(item.permissions, "bundle script permissions");
        expectKeys(permissions, ["run", "net"], "bundle script permissions");
        return Object.freeze({
          source: await snapshotFile(snapshot, item.source),
          relativePath: typeof item.relative_path === "string" ? item.relative_path : "",
          permissions: Object.freeze({
            run: validateRunPermissions(uniqueStrings(permissions.run, "permissions.run")),
            net: validateNetPermissions(uniqueStrings(permissions.net, "permissions.net")),
          }),
        });
      })),
    );
  }
  let templates: ConfigTemplate[] = [];
  if (value.templates !== undefined) {
    if (!Array.isArray(value.templates)) throw new ConfigurationError("templates 必须是列表");
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
      "旧发布快照使用已移除的 config_secrets/file_secrets 密钥机制；无法执行，请重新部署后再回滚",
    );
  }
  const secretValues = value.secret_values === undefined
    ? freezeArray([])
    : uniqueStrings(value.secret_values, "secret_values");
  const secretFiles = value.secret_files === undefined
    ? freezeArray([])
    : uniqueStrings(value.secret_files, "secret_files");
  const hasRunAs = Object.hasOwn(value, "run_as");
  const hasLifecycleValues = Object.hasOwn(value, "lifecycle_secret_values");
  const hasLifecycleFiles = Object.hasOwn(value, "lifecycle_secret_files");
  const currentV4 = hasRunAs || hasLifecycleValues || hasLifecycleFiles;
  if (
    schema === 4 && currentV4 &&
    (!hasRunAs || !hasLifecycleValues || !hasLifecycleFiles)
  ) {
    throw new ConfigurationError("plan-v4 新字段组不完整");
  }
  const runAs = !currentV4 || value.run_as === null
    ? undefined
    : validateAppRunAs(requiredString(value.run_as, "run_as"));
  const lifecycleSecretValues = currentV4
    ? uniqueStrings(value.lifecycle_secret_values, "lifecycle_secret_values")
    : undefined;
  const lifecycleSecretFiles = currentV4
    ? uniqueStrings(value.lifecycle_secret_files, "lifecycle_secret_files")
    : undefined;
  const kind = requiredString(value.kind, "kind");
  const action = requiredString(value.action, "action");
  if (kind !== "app" && kind !== "environment") {
    throw new ConfigurationError(`计划步骤 kind 非法: ${kind}`);
  }
  if (!STEP_ACTIONS.has(action)) throw new ConfigurationError(`计划步骤 action 非法: ${action}`);
  const installDirectory = value.install_directory === null || value.install_directory === undefined
    ? undefined
    : requiredString(value.install_directory, "install_directory");
  const deployment = schema === 4 && value.deployment !== null && value.deployment !== undefined
    ? decodeDeployment(value.deployment)
    : undefined;
  const management = schema === 4
    ? await decodeManagement(value.management, snapshot, runAs, deployment)
    : undefined;
  const deliveryInputs = schema === 4
    ? await decodeDeliveryInputs(value.delivery_inputs, snapshot)
    : undefined;
  if (!scripts.length && management === undefined) {
    throw new ConfigurationError("无脚本步骤必须包含 managed 声明");
  }
  if (deployment !== undefined) {
    if (kind !== "app" || !["deploy", "stage", "activate"].includes(action)) {
      throw new ConfigurationError(
        "只有 App deploy/stage/activate 步骤可以声明 versioned deployment",
      );
    }
    if (action !== "stage" && management === undefined) {
      throw new ConfigurationError("versioned deployment 步骤必须包含 managed 声明");
    }
    if (runAs === undefined) {
      throw new ConfigurationError("versioned deployment 步骤缺少 run_as");
    }
    if (installDirectory === undefined) {
      throw new ConfigurationError("versioned deployment 步骤缺少 install_directory");
    }
  }
  if (currentV4 && management !== undefined && runAs === undefined) {
    throw new ConfigurationError("managed plan-v4 步骤缺少 run_as");
  }
  const isVersionedStage = kind === "app" && action === "stage" &&
    deployment?.kind === "versioned";
  if (currentV4 && management === undefined && runAs !== undefined && !isVersionedStage) {
    throw new ConfigurationError("非 managed plan-v4 步骤不能声明 run_as");
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
    deployment,
    management,
    deliveryInputs,
    bundleScripts,
  });
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
  if (kind !== "app") throw new ConfigurationError("只有 App 步骤可以包含 management");
  const values = new Set(secretValues);
  const files = new Set(secretFiles);
  for (const name of lifecycleSecretValues ?? []) {
    if (!values.has(name)) {
      throw new ConfigurationError(`生命周期值秘密未进入步骤秘密集合: ${name}`);
    }
  }
  for (const name of lifecycleSecretFiles ?? []) {
    if (!files.has(name)) {
      throw new ConfigurationError(`生命周期文件秘密未进入步骤秘密集合: ${name}`);
    }
  }
  const requiredScripts: ScriptInvocation[] = [];
  for (const config of management.configs) {
    for (const [name, reference] of config.secretReferences) {
      const declared = reference.kind === "value" ? values : files;
      if (!declared.has(name)) {
        throw new ConfigurationError(`managed secret 未进入步骤最小秘密集合: ${name}`);
      }
    }
  }
  for (const scripts of management.hooks.values()) requiredScripts.push(...scripts);
  if (
    ((action === "configure" || action === "deploy") && management.configs.length > 0) ||
    requiredScripts.length > 0
  ) {
    if (deliveryInputs === undefined) {
      throw new ConfigurationError("managed 步骤缺少 delivery_inputs");
    }
  }
  const delivered = new Set(deliveryInputs?.scripts.map((script) => script.relativePath) ?? []);
  for (const script of requiredScripts) {
    if (!delivered.has(script.relativePath)) {
      throw new ConfigurationError(`managed 脚本未进入 delivery_inputs: ${script.relativePath}`);
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
  if (!SOURCE_SCHEMA_RE.test(schema)) throw new ConfigurationError("package source schema 非法");
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
  if (new Set(ids).size !== ids.length) throw new ConfigurationError("执行计划包含重复步骤 ID");
  const known = new Set(ids);
  const incoming = new Map<string, Set<string>>();
  for (const step of steps) {
    const dependencies = new Set(step.dependsOn);
    if (dependencies.size !== step.dependsOn.length) {
      throw new ConfigurationError(`步骤依赖重复: ${step.id}`);
    }
    if (dependencies.has(step.id) || [...dependencies].some((item) => !known.has(item))) {
      throw new ConfigurationError(`步骤依赖非法: ${step.id}`);
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
  if (visited.size !== steps.length) throw new ConfigurationError("执行计划依赖存在循环");
}

function validatePlanSemantics(requestedAction: string, steps: readonly PlanStep[]): void {
  if (!PLAN_ACTIONS.has(requestedAction)) {
    throw new ConfigurationError(`执行计划 requested_action 非法: ${requestedAction}`);
  }
  const allowed = PLAN_STEP_ACTIONS[requestedAction];
  for (const step of steps) {
    if (!allowed?.[step.kind]?.has(step.action)) {
      throw new ConfigurationError(
        `计划步骤与 requested_action 不匹配: ${step.id} ${step.kind}/${step.action} vs ${requestedAction}`,
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
    throw new ConfigurationError("execution summary targets 必须是列表");
  }
  const targets: ReleaseTargetSummary[] = value.targets.map((rawTarget) => {
    const target = objectValue(rawTarget, "target summary");
    expectKeys(target, ["machine", "status", "steps", "cleanup_errors"], "target summary");
    if (!Array.isArray(target.steps)) throw new ConfigurationError("target steps 必须是列表");
    const status = requiredString(target.status, "target status");
    if (!STEP_STATUSES.has(status)) throw new ConfigurationError(`target status 非法: ${status}`);
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
      ) throw new ConfigurationError("step summary kind/action/status 非法");
      const errors = uniqueStrings(step.cleanup_errors, "cleanup_errors");
      const errorCategory = optionalString(step.error_category, "error_category");
      const skipReason = optionalString(step.skip_reason, "skip_reason");
      if (errors.length && (stepStatus === "succeeded" || stepStatus === "skipped")) {
        throw new ConfigurationError("包含清理错误的步骤不能标记为成功或跳过");
      }
      if (
        stepStatus === "succeeded" &&
        (exitCode === undefined || errorCategory !== undefined || skipReason !== undefined)
      ) throw new ConfigurationError("成功步骤必须包含退出码且不能含错误或跳过原因");
      const expectedReasons: Record<string, ReadonlySet<string>> = {
        skipped: new Set(["check-satisfied", "target-fail-fast"]),
        blocked: new Set(["dependency-failed"]),
        cancelled: new Set(["cancelled"]),
      };
      if (
        expectedReasons[stepStatus] &&
        (exitCode !== undefined || errorCategory !== undefined ||
          !expectedReasons[stepStatus].has(skipReason ?? ""))
      ) throw new ConfigurationError("未执行步骤必须包含跳过原因且不能含退出码或错误类别");
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
      throw new ConfigurationError("target summary 包含其他机器的步骤");
    }
    const expectedStatus = deriveTargetStatus(steps, cleanupErrors);
    if (status !== expectedStatus) {
      throw new ConfigurationError(
        `target status 与步骤结果不一致: ${status} != ${expectedStatus}`,
      );
    }
    return Object.freeze({ machine, status, steps, cleanupErrors });
  });
  if (new Set(targets.map((target) => target.machine)).size !== targets.length) {
    throw new ConfigurationError("execution summary 包含重复目标");
  }
  const exitCode = boundedInteger(value.exit_code, "exit_code", 0, 255);
  const expectedExit = deriveExecutionExitCode(targets);
  if (exitCode !== expectedExit) {
    throw new ConfigurationError(
      `execution summary exit_code 与目标结果不一致: ${exitCode} != ${expectedExit}`,
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
  if (!result && !error) throw new ConfigurationError("终态发布记录缺少执行或错误摘要");
  if (result && error) throw new ConfigurationError("终态发布记录不能同时包含执行和错误摘要");
  if (status === "succeeded") {
    if (
      !result || result.exitCode !== 0 ||
      result.targets.some((target) => ["failed", "cancelled", "blocked"].includes(target.status))
    ) throw new ConfigurationError("成功发布记录必须包含一致的 exit_code=0 执行摘要");
  } else if (result) {
    const expected = result.exitCode === 130 ? "cancelled" : "failed";
    if (status !== expected) {
      throw new ConfigurationError(`发布记录状态与执行摘要不一致: ${status} != ${expected}`);
    }
  }
}

function validateExecutionAgainstPlan(summary: ReleaseExecutionSummary, plan: ExecutionPlan): void {
  const expected = new Map(plan.steps.map((step) => [step.id, step]));
  const actual = new Map<string, ReleaseStepSummary>();
  const expectedMachines = new Set(plan.steps.map((step) => step.machine.machine.name));
  const actualMachines = new Set(summary.targets.map((target) => target.machine));
  if (!setEqual(expectedMachines, actualMachines)) {
    throw new ConfigurationError("execution summary 目标集合与实际执行计划不一致");
  }
  for (const target of summary.targets) {
    if (!target.steps.length) throw new ConfigurationError("execution summary 目标缺少计划步骤");
    for (const step of target.steps) {
      if (actual.has(step.stepId)) {
        throw new ConfigurationError(`execution summary 包含重复步骤 ID: ${step.stepId}`);
      }
      const planned = expected.get(step.stepId);
      if (!planned) {
        throw new ConfigurationError(`execution summary 包含计划外步骤: ${step.stepId}`);
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
          `execution summary 步骤身份与实际执行计划不一致: ${step.stepId}`,
        );
      }
      actual.set(step.stepId, step);
    }
  }
  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  if (missing.length) {
    throw new ConfigurationError(
      `execution summary 缺少实际执行计划步骤: ${missing.sort().join(", ")}`,
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
        throw new ConfigurationError(`成功步骤退出码与实际执行计划动作不一致: ${planned.id}`);
      }
    }
    if (result.status === "skipped" && result.skipReason === "check-satisfied") {
      if (planned.kind !== "environment" || planned.action !== "install") {
        throw new ConfigurationError(`check-satisfied 只能用于环境 install 步骤: ${planned.id}`);
      }
      const satisfied = planned.dependsOn.some((dependency) => {
        const dependencyPlan = expected.get(dependency);
        const dependencyResult = actual.get(dependency);
        return dependencyPlan?.kind === "environment" && dependencyPlan.action === "check" &&
          dependencyPlan.resource === planned.resource &&
          dependencyResult?.status === "succeeded" && dependencyResult.exitCode === 0;
      });
      if (!satisfied) {
        throw new ConfigurationError(`check-satisfied 缺少已满足的环境 check: ${planned.id}`);
      }
    }
    if (result.status === "skipped" && result.skipReason === "target-fail-fast") {
      const preceding = [...actual.values()].some((other) =>
        other.machine === result.machine && other.status === "failed" &&
        (positions.get(other.stepId) ?? Infinity) < (positions.get(planned.id) ?? -1)
      );
      if (!preceding) {
        throw new ConfigurationError(`target-fail-fast 缺少同目标前置失败: ${planned.id}`);
      }
    }
  }
  if (
    summary.exitCode === 0 &&
    plan.steps.some((step) => step.kind === "app" && actual.get(step.id)?.status !== "succeeded")
  ) throw new ConfigurationError("成功发布的 App 步骤未实际成功");
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
    throw new ConfigurationError("step service action 非法");
  }
  if (!["none", "enable", "disable"].includes(enableAction)) {
    throw new ConfigurationError("step service enable_action 非法");
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
    throw new ConfigurationError("step recovery attempted 与分项不一致");
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
  if (!SHA256_RE.test(sha256)) throw new ConfigurationError("bundle sha256 非法");
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
    throw new ConfigurationError("with_dependencies 必须是布尔值");
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
    throw new ConfigurationError(`发布 ID 不合法: ${JSON.stringify(value)}`);
  }
  return value;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const info = await safeLstat(path);
  if (info && (!info.isDirectory || info.isSymlink)) {
    throw new ConfigurationError(`发布历史路径不是安全目录: ${path}`);
  }
  if (!info) await Deno.mkdir(path, { recursive: false, mode: 0o700 });
  await Deno.chmod(path, 0o700).catch((cause) => {
    throw new ConfigurationError(`无法设置发布历史目录权限: ${path}`, { cause });
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
    throw new ConfigurationError(`JSON 超过容量限制: ${basename(path)}`);
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomHex(8)}.tmp`);
  try {
    const file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    try {
      await writeAll(file, data, `发布历史 JSON ${basename(path)}`);
      await file.sync();
    } finally {
      file.close();
    }
    if (options.exclusive) {
      try {
        await Deno.link(temporary, path);
      } catch (cause) {
        if (cause instanceof Deno.errors.AlreadyExists) {
          throw new ConfigurationError(`历史组件已经存在: ${basename(path)}`, { cause });
        }
        throw new ConfigurationError(`无法原子发布历史组件: ${basename(path)}`, { cause });
      }
      await Deno.remove(temporary);
      const info = await Deno.lstat(path);
      if (!info.isFile || info.isSymlink || info.nlink !== 1) {
        throw new ConfigurationError(`历史组件发布身份校验失败: ${basename(path)}`);
      }
    } else await Deno.rename(temporary, path);
  } catch (cause) {
    await Deno.remove(temporary).catch(() => undefined);
    throw cause;
  }
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const bytes = await readRegularBytes(path, maxBytes, "发布历史 JSON");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parseJsonStrict(text);
    validateJson(value);
    return value;
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError(`发布历史 JSON 损坏: ${basename(path)}`, { cause });
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
      throw new ConfigurationError(`${label} 不存在或不是安全普通文件: ${path}`, { cause });
    }
    if (!candidate.isFile || candidate.isSymlink) {
      throw new ConfigurationError(`${label} 必须是单链接普通文件: ${path}`);
    }
    if (settlingIdentity && !sameFileIdentity(settlingIdentity, candidate)) {
      throw new ConfigurationError(`${label} 在双链接发布窗口中身份发生变化: ${path}`);
    }
    if (candidate.nlink === 1) {
      before = candidate;
      break;
    }
    if (candidate.nlink !== 2) {
      throw new ConfigurationError(`${label} 必须是单链接普通文件: ${path}`);
    }
    settlingIdentity ??= candidate;
    const delay = delays[attempt];
    if (delay === undefined) {
      throw new ConfigurationError(`${label} 的双链接发布窗口未在期限内收敛: ${path}`);
    }
    if (!Number.isFinite(delay) || delay < 0 || delay > 1000) {
      throw new ConfigurationError(`${label} 的双链接重试参数不安全`);
    }
    await sleep(delay);
  }
  if (!before) throw new ConfigurationError(`${label} 无法确认安全普通文件: ${path}`);
  if (before.size > maxBytes) {
    throw new ConfigurationError(`${label} 超过容量限制: ${basename(path)}`);
  }
  const file = await Deno.open(path, { read: true });
  try {
    const opened = await file.stat();
    if (
      !opened.isFile || opened.nlink !== 1 || opened.size !== before.size ||
      !sameFileIdentity(before, opened)
    ) throw new ConfigurationError(`${label} 在打开期间发生变化: ${path}`);
    const data = new Uint8Array(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = await file.read(data.subarray(offset));
      if (count === null) break;
      if (count === 0) throw new ConfigurationError(`${label} 读取未取得进展: ${path}`);
      offset += count;
    }
    const after = await Deno.lstat(path);
    if (
      !after.isFile || after.isSymlink || after.nlink !== 1 || after.size !== before.size ||
      after.mtime?.getTime() !== before.mtime?.getTime() || offset !== before.size ||
      !sameFileIdentity(before, after)
    ) throw new ConfigurationError(`${label} 在读取期间发生变化: ${path}`);
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
      throw new ConfigurationError(`${label} 写入未取得有效进展`);
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
  await readRegularBytes(path, MAX_ARCHIVE_FILE_BYTES, "快照文件");
  return path;
}

async function hashRegularFile(path: string): Promise<{ hash: string; size: number }> {
  const data = await readRegularBytes(path, MAX_ARCHIVE_FILE_BYTES, "快照文件");
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
  ) throw new ConfigurationError(`快照相对路径非法: ${JSON.stringify(value)}`);
  return value;
}

function contained(root: string, rel: string): string {
  const candidate = resolve(root, ...rel.split("/"));
  const difference = relative(resolve(root), candidate);
  if (difference === ".." || difference.startsWith(`..${SEPARATOR}`) || isAbsolute(difference)) {
    throw new ConfigurationError(`路径逃逸集群目录: ${rel}`);
  }
  return candidate;
}

function validateJson(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (++budget.count > MAX_JSON_ITEMS || depth > MAX_JSON_DEPTH) {
    throw new ConfigurationError("JSON 数据超过深度或项目数限制");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_STRING_BYTES) {
      throw new ConfigurationError("JSON 字符串超过长度限制");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConfigurationError("JSON 不允许 NaN/Infinity");
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
  throw new ConfigurationError(`JSON 不支持的值类型: ${typeof value}`);
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
        if (keys.has(key)) throw new ConfigurationError(`发布历史 JSON 包含重复键: ${key}`);
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
  if (encoded === undefined) throw new ConfigurationError("值不是合法 JSON");
  return encoded;
}

function jsonCopy(value: unknown): unknown {
  validateJson(value);
  return JSON.parse(stableJson(value));
}
function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${label} 必须是对象`);
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
  if (!equalJson(actual, wanted)) throw new ConfigurationError(`${label} 字段不匹配`);
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
    throw new ConfigurationError(`${label} 字段不匹配`);
  }
}
function requiredString(value: unknown, label: string): string {
  if (
    typeof value !== "string" || !value ||
    new TextEncoder().encode(value).byteLength > MAX_STRING_BYTES
  ) throw new ConfigurationError(`${label} 必须是非空有界字符串`);
  return value;
}

function validateAppRunAs(value: string): string {
  if (value === "root" || !APP_RUN_AS_RE.test(value)) {
    throw new ConfigurationError("run_as 必须是规范的非 root Linux 用户");
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
    throw new ConfigurationError(`${label} 必须是有界列表`);
  }
  const result = value.map((item) => requiredString(item, label));
  if (new Set(result).size !== result.length) throw new ConfigurationError(`${label} 包含重复值`);
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
    throw new ConfigurationError(`${label} 超出范围`);
  }
  return value as number;
}
function sha256Text(value: unknown): string {
  const text = requiredString(value, "sha256");
  if (!SHA256_RE.test(text)) throw new ConfigurationError("sha256 格式非法");
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
    if (!isIpAddress(address)) throw new ConfigurationError(`${label} 不是合法 IP: ${address}`);
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
    throw new ConfigurationError(`${label} 包含空白、控制字符或逗号`);
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
  ) throw new ConfigurationError("script_runtime.executable 必须是裸命令名或规范绝对 POSIX 路径");
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
    ) throw new ConfigurationError(`permissions.run[${index}] 必须是规范绝对 POSIX 可执行路径`);
    return text;
  });
  if (new Set(result).size !== result.length) {
    throw new ConfigurationError("permissions.run 包含重复值");
  }
  return freezeArray(result);
}

function validateNetPermissions(values: readonly string[]): readonly string[] {
  const result = values.map((value, index) => {
    const text = permissionText(value, `permissions.net[${index}]`);
    if (/[\/@*?#\\]/.test(text)) {
      throw new ConfigurationError(`permissions.net[${index}] 网络目标不合法`);
    }
    let host = text;
    let port: string | undefined;
    if (text.startsWith("[")) {
      const match = /^\[([^\[\]]+)\](?::(\d+))?$/.exec(text);
      if (!match || !isIpAddress(match[1]) || !match[1].includes(":")) {
        throw new ConfigurationError("permissions.net IPv6 地址格式不合法");
      }
      host = match[1];
      port = match[2];
    } else if (text.split(":").length > 2) {
      if (!isIpAddress(text)) throw new ConfigurationError("带端口 IPv6 必须使用方括号");
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
      ) throw new ConfigurationError("permissions.net 主机名不合法");
    }
    if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      throw new ConfigurationError("permissions.net 端口必须在 1..65535");
    }
    return text;
  });
  if (new Set(result).size !== result.length) {
    throw new ConfigurationError("permissions.net 包含重复值");
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
        ? "发布或回退快照缺少 rollback plan"
        : "非发布生命周期快照不能包含 rollback plan",
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
