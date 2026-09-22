/** 目标端不可变部署包的暂存、校验和固定布局解析。 */

import * as posix from "jsr:@std/path@1.1.6/posix";
import { createHash } from "node:crypto";
import type {
  BuiltDeploymentBundle,
  DeploymentBundleManifest,
  DeploymentBundleManifestEntry,
} from "./deployment_bundle.ts";
import { PreflightError, TransportError } from "./errors.ts";
import type { CommandResult } from "./results.ts";
import type { ManagedConfigFormat, ManagedConfigValidator } from "./types.ts";

const MAX_MEMBERS = 4_096;
const MAX_MEMBER_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MODE_RE = /^0[0-7]{3}$/;
const textEncoder = new TextEncoder();

export {
  REMOTE_CONFIG_UPDATER_BUNDLE_PATH,
  REMOTE_CONFIG_UPDATER_SOURCE,
} from "./remote_runtime/artifact.ts";

export interface RemoteDeploymentChannel {
  uploadFile(
    localPath: string,
    remotePath: string,
    options?: { readonly signal?: AbortSignal; readonly mode?: number },
  ): Promise<void>;
  run(
    argv: readonly string[],
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<CommandResult>;
}

export interface StageDeploymentBundleOptions {
  readonly workspace: string;
  readonly signal?: AbortSignal;
}

export interface StagedDeploymentBundle {
  readonly workspace: string;
  readonly root: string;
  readonly manifestPath: string;
  readonly packagePath?: string;
  readonly scripts: ReadonlyMap<string, string>;
  readonly configSkeletons: ReadonlyMap<string, string>;
  readonly configBindings: ReadonlyMap<string, string>;
  readonly files: ReadonlyMap<string, string>;
  readonly entries: readonly DeploymentBundleManifestEntry[];
  readonly sha256: string;
  readonly reused: boolean;
}

export interface BuiltinConfigCandidateRequest {
  readonly name: string;
  readonly workspace: string;
  readonly updaterScript: string;
  readonly denoExecutable: string;
  readonly format: ManagedConfigFormat;
  readonly skeleton: string;
  readonly bindings: string;
  readonly secretDir: string;
  readonly secretRoot: string;
  readonly fileSecrets: readonly string[];
  readonly timeoutMs?: number;
}

export interface RemoteOperationLockRequest {
  readonly app: string;
  readonly target: string;
  readonly timeoutMs: number;
  /** 远端操作锁租约 TTL；未提供时由 transport 使用保守默认值。 */
  readonly leaseTtlMs?: number;
}

export interface RemoteOperationLease {
  readonly id: string;
  readonly app: string;
  readonly target: string;
}

export interface ScopedSecretCopyRequest {
  readonly workspace: string;
  readonly sourceDirectory: string;
  readonly names: readonly string[];
}

export interface ScopedSecretCopy {
  readonly workspace: string;
  readonly path: string;
}

export interface RemoteConfigCandidate {
  readonly name: string;
  readonly workspace: string;
  readonly path: string;
}

export interface ManagedConfigPublishRequest {
  readonly candidate: RemoteConfigCandidate;
  readonly target: string;
  /** 内置版本部署映射目标的真实路径边界。 */
  readonly releaseRoot?: string;
  readonly mode: number;
  readonly owner?: string;
  readonly group?: string;
  readonly validator?: ManagedConfigValidator;
  readonly secretRoot: string;
  readonly secretFiles: readonly string[];
}

export interface ManagedConfigPublication {
  readonly name: string;
  readonly workspace: string;
  readonly target: string;
  readonly changed: boolean;
  readonly existed: boolean;
  readonly serviceChange?: boolean;
  readonly secretFingerprintPath?: string;
  readonly secretFingerprints?: Readonly<Record<string, string>>;
  /** 只在当前会话已登记 workspace 内使用，不持久化或输出内容。 */
  readonly backupPath?: string;
  readonly originalMode?: string;
  readonly originalOwner?: string;
  readonly originalGroup?: string;
}

/** 发布失败且内部补偿失败时，向执行器交还仍需恢复的事务。 */
export class ManagedConfigPublicationError extends TransportError {
  readonly publications: readonly ManagedConfigPublication[];
  readonly recoveryFailed = true;

  constructor(
    message: string,
    publications: readonly ManagedConfigPublication[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.publications = Object.freeze([...publications]);
  }
}

export interface ExtractAppPackageRequest {
  readonly workspace: string;
  readonly packagePath: string;
  readonly maxMembers?: number;
  readonly maxExpandedBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ExtractedAppPackage {
  readonly workspace: string;
  readonly root: string;
  readonly packagePath: string;
  readonly memberCount: number;
  readonly expandedBytes: number;
}

/**
 * 单次上传 bundle，校验外层 identity 和完整 tar 成员集合后才解包。
 * 解包始终发生在传入的已登记 workspace 下，并以 ready marker 原子暴露。
 */
export async function stageDeploymentBundle(
  channel: RemoteDeploymentChannel,
  bundle: BuiltDeploymentBundle,
  options: StageDeploymentBundleOptions,
): Promise<StagedDeploymentBundle> {
  validateBundle(bundle);
  const workspace = safeWorkspace(options.workspace);
  const root = `${workspace}/deployment-${bundle.sha256}`;
  const ready = `${root}/.ready`;
  const existing = await channel.run(["/usr/bin/test", "-f", ready], { signal: options.signal });
  if (existing.exitCode === 0) {
    await verifyStagedRoot(channel, bundle.manifest, root, options.signal);
    return layout(bundle.manifest, workspace, root, bundle.sha256, true);
  }
  if (existing.exitCode !== 1) {
    throw new TransportError("Failed to check the deployment bundle ready state");
  }

  const nonce = crypto.randomUUID().replaceAll("-", "");
  const archive = `${workspace}/bundle-${bundle.sha256}.tar.gz`;
  const pending = `${workspace}/.deployment-${bundle.sha256}-${nonce}`;
  try {
    requireSuccess(
      await channel.run(["mkdir", "-m", "0700", "--", pending], { signal: options.signal }),
      "Failed to create the deployment bundle staging directory",
    );
    await channel.uploadFile(bundle.path, archive, { signal: options.signal, mode: 0o600 });
    const size = await channel.run(["stat", "-c", "%s", "--", archive], {
      signal: options.signal,
    });
    requireSuccess(size, "Failed to check the deployment bundle length");
    if (size.stdout.trim() !== String(bundle.size)) {
      throw new TransportError("Deployment bundle length verification failed");
    }
    const outer = await channel.run(["sha256sum", "--", archive], { signal: options.signal });
    requireSuccess(outer, "Failed to check the deployment bundle digest");
    if (parseSha256(outer.stdout) !== bundle.sha256) {
      throw new TransportError("Deployment bundle SHA-256 verification failed");
    }

    const expectedPaths = ["manifest.json", ...bundle.manifest.entries.map((entry) => entry.path)];
    const names = await channel.run(["tar", "-tzf", archive], { signal: options.signal });
    requireSuccess(names, "Failed to read the deployment bundle directory");
    const actualPaths = outputLines(names.stdout);
    if (
      actualPaths.length !== expectedPaths.length ||
      actualPaths.some((path, index) => path !== expectedPaths[index])
    ) {
      throw new TransportError(
        "Deployment bundle member set, order, or duplicate verification failed",
      );
    }
    const listing = await channel.run(["tar", "-tvzf", archive], { signal: options.signal });
    requireSuccess(listing, "Failed to check deployment bundle member type");
    const types = outputLines(listing.stdout);
    if (types.length !== expectedPaths.length || types.some((line) => line[0] !== "-")) {
      throw new TransportError("Deployment bundle contains links, directories, or special files");
    }

    requireSuccess(
      await channel.run([
        "tar",
        "--extract",
        "--gzip",
        "--file",
        archive,
        "--directory",
        pending,
        "--no-same-owner",
        "--no-same-permissions",
        "--delay-directory-restore",
      ], { signal: options.signal }),
      "Failed to unpack the deployment bundle safely",
    );
    const manifestPath = `${pending}/manifest.json`;
    await verifyRegular(
      channel,
      manifestPath,
      undefined,
      manifestSha256(bundle.manifest),
      options.signal,
    );
    requireSuccess(
      await channel.run(["chmod", "0600", "--", manifestPath], { signal: options.signal }),
      "Failed to set deployment manifest permissions",
    );
    for (const entry of bundle.manifest.entries) {
      const path = `${pending}/${entry.path}`;
      await verifyRegular(channel, path, entry.size, entry.sha256, options.signal);
      requireSuccess(
        await channel.run(["chmod", entry.mode, "--", path], { signal: options.signal }),
        `Failed to restore deployment bundle member permissions ${entry.path}`,
      );
    }
    requireSuccess(
      await channel.run(["touch", "--", `${pending}/.ready`], { signal: options.signal }),
      "Failed to write the deployment bundle ready marker",
    );
    requireSuccess(
      await channel.run(["chmod", "0600", "--", `${pending}/.ready`], {
        signal: options.signal,
      }),
      "Failed to set deployment bundle ready marker permissions",
    );
    // 同一 workspace/digest 只允许一个完整 root；调用方串行时此操作也是暴露边界。
    const rootState = await channel.run(["/usr/bin/test", "-e", root], { signal: options.signal });
    if (rootState.exitCode === 0) {
      const rootReady = await channel.run(["/usr/bin/test", "-f", ready], {
        signal: options.signal,
      });
      if (rootReady.exitCode !== 0) {
        throw new TransportError("Deployment bundle destination has a not-ready state");
      }
      await verifyStagedRoot(channel, bundle.manifest, root, options.signal);
      await cleanup(channel, pending);
      return layout(bundle.manifest, workspace, root, bundle.sha256, true);
    }
    if (rootState.exitCode !== 1) {
      throw new TransportError("Failed to check the deployment bundle destination directory");
    }
    requireSuccess(
      await channel.run(["mv", "-T", "--", pending, root], { signal: options.signal }),
      "Failed to publish the deployment bundle staging directory atomically",
    );
    return layout(bundle.manifest, workspace, root, bundle.sha256, false);
  } catch (cause) {
    await cleanup(channel, pending);
    throw cause;
  } finally {
    await cleanupFile(channel, archive);
  }
}

/**
 * 在消费原始 App 包前完成只读列表检查，并只解到 attempt workspace 内的新隔离目录。
 * GNU tar 的两个列表必须逐项一致；任何路径、类型、重复或展开量异常均发生在 extract 前。
 */
export async function extractValidatedAppPackage(
  channel: RemoteDeploymentChannel,
  request: ExtractAppPackageRequest,
): Promise<ExtractedAppPackage> {
  const workspace = safeWorkspace(request.workspace);
  const packagePath = workspaceChild(workspace, request.packagePath, "raw App package");
  const maxMembers = boundedLimit(request.maxMembers, MAX_MEMBERS, "App package member count");
  const maxExpandedBytes = boundedLimit(
    request.maxExpandedBytes,
    MAX_TOTAL_BYTES,
    "App package unpacked total size",
  );
  const packageType = await channel.run(["stat", "-c", "%F", "--", packagePath], {
    signal: request.signal,
  });
  requireSuccess(packageType, "Failed to check the raw App package");
  if (compatibleStatField(packageType.stdout, 0) !== "regular file") {
    throw new TransportError("Raw App package is not a regular file");
  }
  const namesResult = await channel.run([
    "tar",
    "--list",
    "--gzip",
    "--file",
    packagePath,
  ], { signal: request.signal });
  requireSuccess(namesResult, "Failed to read the App package directory");
  const names = outputLines(namesResult.stdout);
  if (names.length === 0 || names.length > maxMembers) {
    throw new TransportError("App package member count exceeds the limit or is empty");
  }

  const detailResult = await channel.run([
    "tar",
    "--list",
    "--verbose",
    "--gzip",
    "--numeric-owner",
    "--full-time",
    "--file",
    packagePath,
  ], { signal: request.signal });
  requireSuccess(detailResult, "Failed to read App package member metadata");
  const details = outputLines(detailResult.stdout);
  if (details.length !== names.length) {
    throw new TransportError("App package listing output is inconsistent");
  }

  const seen = new Set<string>();
  let expandedBytes = 0;
  for (let index = 0; index < names.length; index++) {
    const rawName = names[index];
    const detail = details[index];
    const match = /^([d-])\S*\s+[0-9]+\/[0-9]+\s+([0-9]+)\s+\S+\s+\S+\s+(.+)$/u.exec(
      detail,
    );
    if (!match || match[3] !== rawName) {
      throw new TransportError("App package member metadata cannot be parsed unambiguously");
    }
    const directory = match[1] === "d";
    const canonical = canonicalInnerMember(rawName, directory);
    if (seen.has(canonical)) throw new TransportError("App package contains duplicate members");
    seen.add(canonical);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0 || (directory && size !== 0)) {
      throw new TransportError("Invalid App package member length");
    }
    expandedBytes += size;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maxExpandedBytes) {
      throw new TransportError("App package unpacked total size exceeds the limit");
    }
  }

  const root = `${workspace}/app-${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    requireSuccess(
      await channel.run(["mkdir", "-m", "0700", "--", root], { signal: request.signal }),
      "Failed to create the App package isolation directory",
    );
    requireSuccess(
      await channel.run([
        "tar",
        "--extract",
        "--gzip",
        "--file",
        packagePath,
        "--directory",
        root,
        "--no-same-owner",
        "--no-same-permissions",
        "--delay-directory-restore",
      ], { signal: request.signal }),
      "Failed to unpack the App package safely",
    );
    return Object.freeze({
      workspace,
      root,
      packagePath,
      memberCount: names.length,
      expandedBytes,
    });
  } catch (cause) {
    await cleanup(channel, root);
    throw cause;
  }
}

async function verifyStagedRoot(
  channel: RemoteDeploymentChannel,
  manifest: DeploymentBundleManifest,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  await verifyRegular(
    channel,
    `${root}/manifest.json`,
    undefined,
    manifestSha256(manifest),
    signal,
  );
  for (const entry of manifest.entries) {
    await verifyRegular(channel, `${root}/${entry.path}`, entry.size, entry.sha256, signal);
  }
}

function validateBundle(bundle: BuiltDeploymentBundle): void {
  if (
    !bundle || typeof bundle.path !== "string" || !Number.isSafeInteger(bundle.size) ||
    bundle.size <= 0 || bundle.size > MAX_TOTAL_BYTES || !SHA256_RE.test(bundle.sha256)
  ) {
    throw new PreflightError("Invalid deployment bundle identity");
  }
  const manifest = bundle.manifest;
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.entries)) {
    throw new PreflightError("Invalid deployment manifest version");
  }
  if (manifest.entries.length === 0 || manifest.entries.length + 1 > MAX_MEMBERS) {
    throw new PreflightError("Invalid deployment manifest member count");
  }
  const seen = new Set<string>(["manifest.json"]);
  let total = 0;
  let packages = 0;
  for (const entry of manifest.entries) {
    safeMember(entry.path);
    if (seen.has(entry.path)) {
      throw new PreflightError("Deployment manifest contains duplicate members");
    }
    seen.add(entry.path);
    if (
      !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_MEMBER_BYTES ||
      !SHA256_RE.test(entry.sha256) || !MODE_RE.test(entry.mode)
    ) {
      throw new PreflightError(`Invalid deployment bundle member identity: ${entry.path}`);
    }
    const prefix = purposePrefix(entry);
    if (!entry.path.startsWith(`${prefix}/`)) {
      throw new PreflightError(
        `Deployment bundle member purpose does not match the path: ${entry.path}`,
      );
    }
    if (entry.purpose === "package" && ++packages > 1) {
      throw new PreflightError("Deployment bundle must contain exactly one raw App package");
    }
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) {
      throw new PreflightError("Deployment manifest unpacked total size exceeds the limit");
    }
  }
}

function purposePrefix(entry: DeploymentBundleManifestEntry): string {
  switch (entry.purpose) {
    case "package":
      return "package";
    case "script":
      return "scripts";
    case "config-skeleton":
    case "config-bindings":
      return "configs";
    case "file":
      return "files";
  }
}

function safeMember(path: string): void {
  if (
    typeof path !== "string" || path.length === 0 || path.includes("\\") ||
    posix.isAbsolute(path) || path.startsWith("//") || posix.normalize(path) !== path ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    /[\0\r\n]/u.test(path)
  ) {
    throw new PreflightError("Deployment manifest contains an unsafe path");
  }
}

function safeWorkspace(path: string): string {
  if (
    typeof path !== "string" || !path.startsWith("/tmp/sfo-deploy-") || path.includes("\\") ||
    path.startsWith("//") || posix.normalize(path) !== path || path.split("/").includes("..") ||
    /[\0\r\n]/u.test(path)
  ) {
    throw new PreflightError("Invalid remote deployment workspace");
  }
  return path;
}

async function verifyRegular(
  channel: RemoteDeploymentChannel,
  path: string,
  expectedSize: number | undefined,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const type = await channel.run(["stat", "-c", "%F", "--", path], { signal });
  requireSuccess(type, "Failed to check deployment bundle member type");
  const typeText = compatibleStatField(type.stdout, 0);
  const size = await channel.run(["stat", "-c", "%s", "--", path], { signal });
  requireSuccess(size, "Failed to check deployment bundle member length");
  const sizeText = compatibleStatField(size.stdout, 1);
  if (
    typeText !== "regular file" || !/^(?:0|[1-9][0-9]*)$/u.test(sizeText) ||
    (expectedSize !== undefined && sizeText !== String(expectedSize))
  ) {
    throw new TransportError("Deployment bundle member type or length verification failed");
  }
  const digest = await channel.run(["sha256sum", "--", path], { signal });
  requireSuccess(digest, "Failed to check the deployment bundle member digest");
  if (parseSha256(digest.stdout) !== expectedSha256) {
    throw new TransportError("Deployment bundle member SHA-256 verification failed");
  }
}

function compatibleStatField(output: string, index: number): string {
  const text = output.trim();
  const fields = text.split("\t");
  return fields.length > index ? fields[index] : text;
}

function boundedLimit(value: number | undefined, maximum: number, label: string): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new PreflightError(`Invalid ${label} limit`);
  }
  return limit;
}

function workspaceChild(workspace: string, value: string, label: string): string {
  if (
    typeof value !== "string" || !value.startsWith(`${workspace}/`) ||
    posix.normalize(value) !== value || value.split("/").includes("..") || /[\0\r\n]/u.test(value)
  ) {
    throw new PreflightError(`${label} is outside the registered workspace`);
  }
  return value;
}

function canonicalInnerMember(value: string, directory: boolean): string {
  const path = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    path.length === 0 || value.includes("\\") || posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.split("/").some((part) =>
      part.length === 0 || part === "." || part === ".." ||
      !/^[A-Za-z0-9_@%+=,.-]+$/u.test(part)
    ) || /[\0\r\n]/u.test(value) || (!directory && value.endsWith("/"))
  ) {
    throw new TransportError("App package contains an unsafe or non-canonical path");
  }
  return path;
}

function layout(
  manifest: DeploymentBundleManifest,
  workspace: string,
  root: string,
  sha256: string,
  reused: boolean,
): StagedDeploymentBundle {
  const scripts = new Map<string, string>();
  const configs = new Map<string, string>();
  const bindings = new Map<string, string>();
  const files = new Map<string, string>();
  let packagePath: string | undefined;
  for (const entry of manifest.entries) {
    const path = `${root}/${entry.path}`;
    if (entry.purpose === "package") packagePath = path;
    else if (entry.purpose === "script") scripts.set(entry.path.slice("scripts/".length), path);
    else if (entry.purpose === "config-skeleton") {
      configs.set(entry.path.slice("configs/".length), path);
    } else if (entry.purpose === "config-bindings") {
      bindings.set(entry.path.slice("configs/".length), path);
    } else files.set(entry.path.slice("files/".length), path);
  }
  return Object.freeze({
    workspace,
    root,
    manifestPath: `${root}/manifest.json`,
    packagePath,
    scripts,
    configSkeletons: configs,
    configBindings: bindings,
    files,
    entries: Object.freeze([...manifest.entries]),
    sha256,
    reused,
  });
}

function manifestSha256(manifest: DeploymentBundleManifest): string {
  return createHash("sha256")
    .update(textEncoder.encode(`${JSON.stringify(manifest, undefined, 2)}\n`))
    .digest("hex");
}

function parseSha256(output: string): string {
  const match = /^([0-9a-f]{64})(?:\s|$)/u.exec(output);
  if (!match) throw new TransportError("Invalid SHA-256 command output");
  return match[1];
}

function outputLines(output: string): string[] {
  return output.split(/\r?\n/u).filter((line) => line.length > 0);
}

function requireSuccess(result: CommandResult, message: string): void {
  if (result.exitCode !== 0) throw new TransportError(message);
}

async function cleanup(
  channel: RemoteDeploymentChannel,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  await channel.run(["rm", "-rf", "--", path], { signal }).catch(() => undefined);
}

async function cleanupFile(
  channel: RemoteDeploymentChannel,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  await channel.run(["rm", "-f", "--", path], { signal }).catch(() => undefined);
}
