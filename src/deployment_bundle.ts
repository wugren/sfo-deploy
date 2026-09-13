/** 确定性控制端部署包：固定布局、逐成员摘要、单一 tar.gz 输出。 */

import { basename, dirname, resolve } from "jsr:@std/path@1.1.6";
import * as posix from "jsr:@std/path@1.1.6/posix";
import { createHash } from "node:crypto";
import type { GeneratedConfigSkeleton } from "./config_generation.ts";
import { assertGzipTar } from "./downloads.ts";
import { CancelledError, PreflightError } from "./errors.ts";
import {
  REMOTE_CONFIG_UPDATER_BUNDLE_PATH,
  REMOTE_CONFIG_UPDATER_SOURCE,
} from "./remote_runtime/artifact.ts";

const TEXT_ENCODER = new TextEncoder();
const TAR_BLOCK_SIZE = 512;
const DEFAULT_MAX_MEMBERS = 4_096;
const DEFAULT_MAX_MEMBER_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export type DeploymentBundlePurpose =
  | "package"
  | "script"
  | "config-skeleton"
  | "config-bindings"
  | "file";

export interface DeploymentBundleFileInput {
  readonly source: string;
  /** 对应固定布局目录下的相对 POSIX 路径。 */
  readonly relativePath: string;
  /** 解包校验后由远端恢复的期望模式；归档本身不被信任。 */
  readonly mode?: number;
}

export interface DeploymentBundlePackageInput {
  readonly source: string;
  readonly expectedSha256?: string;
}

export interface DeploymentBundleConfigInput {
  readonly skeleton: GeneratedConfigSkeleton;
  readonly relativePath?: string;
  readonly mode?: number;
}

export interface BuildDeploymentBundleOptions {
  readonly destination: string;
  readonly package?: DeploymentBundlePackageInput;
  readonly scripts?: readonly DeploymentBundleFileInput[];
  readonly configs?: readonly DeploymentBundleConfigInput[];
  readonly ordinaryFiles?: readonly DeploymentBundleFileInput[];
  readonly maxMembers?: number;
  readonly maxMemberBytes?: number;
  readonly maxTotalBytes?: number;
  readonly signal?: AbortSignal;
}

export interface DeploymentBundleManifestEntry {
  readonly path: string;
  readonly purpose: DeploymentBundlePurpose;
  readonly size: number;
  readonly sha256: string;
  readonly mode: string;
}

export interface DeploymentBundleManifest {
  readonly schema_version: 1;
  readonly entries: readonly DeploymentBundleManifestEntry[];
}

export interface BuiltDeploymentBundle {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly manifest: DeploymentBundleManifest;
}

interface PendingMember {
  readonly path: string;
  readonly purpose: DeploymentBundlePurpose;
  readonly source?: string;
  readonly content?: Uint8Array;
  readonly expectedSha256?: string;
  readonly mode: number;
}

interface StagedMember extends DeploymentBundleManifestEntry {
  readonly stagedPath: string;
}

/**
 * 构建单一外层 tar.gz。输入先复制到私有暂存区并校验，随后才创建 manifest/归档。
 * `ordinaryFiles` 必须来自 App 显式声明的非秘密文件；本 API 不接受 secret provider。
 */
export async function buildDeploymentBundle(
  options: BuildDeploymentBundleOptions,
): Promise<BuiltDeploymentBundle> {
  throwIfAborted(options.signal);
  const destination = resolve(options.destination);
  const maxMembers = boundedLimit(options.maxMembers, DEFAULT_MAX_MEMBERS, "maxMembers");
  const maxMemberBytes = boundedLimit(
    options.maxMemberBytes,
    DEFAULT_MAX_MEMBER_BYTES,
    "maxMemberBytes",
  );
  const maxTotalBytes = boundedLimit(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const pending = collectMembers(options);
  if (pending.length === 0) {
    throw new PreflightError("Deployment bundle requires at least one content member");
  }
  if (pending.length + 1 > maxMembers) {
    throw new PreflightError(`Deployment bundle member count exceeds the ${maxMembers} limit`);
  }

  await Deno.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await assertMissing(destination);
  const staging = await Deno.makeTempDir({ dir: dirname(destination), prefix: ".sfo-bundle-" });
  await Deno.chmod(staging, 0o700);
  const tarPath = `${staging}/bundle.tar`;
  const gzipPath = `${staging}/bundle.tar.gz`;
  try {
    const staged: StagedMember[] = [];
    let total = 0;
    for (const [index, member] of pending.entries()) {
      throwIfAborted(options.signal);
      const stagedPath = `${staging}/member-${index}`;
      const identity = member.source === undefined
        ? await writeContentStable(member.content!, stagedPath, maxMemberBytes)
        : await copyFileStable(member.source, stagedPath, maxMemberBytes, options.signal);
      if (member.purpose === "package") {
        await assertGzipTar(stagedPath, "raw App package in the deployment bundle");
      }
      if (
        member.expectedSha256 !== undefined &&
        !constantTimeHexEqual(identity.sha256, normalizeSha256(member.expectedSha256))
      ) {
        throw new PreflightError(
          `Deployment bundle member ${member.path} SHA-256 does not match the declaration`,
        );
      }
      total += identity.size;
      if (!Number.isSafeInteger(total) || total > maxTotalBytes) {
        throw new PreflightError(
          `Deployment bundle total content exceeds the ${maxTotalBytes} byte limit`,
        );
      }
      staged.push(Object.freeze({
        path: member.path,
        purpose: member.purpose,
        size: identity.size,
        sha256: identity.sha256,
        mode: modeText(member.mode),
        stagedPath,
      }));
    }

    staged.sort((left, right) => compareText(left.path, right.path));
    const manifest: DeploymentBundleManifest = Object.freeze({
      schema_version: 1 as const,
      entries: Object.freeze(
        staged.map(({ stagedPath: _stagedPath, ...entry }) => Object.freeze(entry)),
      ),
    });
    const manifestBytes = TEXT_ENCODER.encode(`${JSON.stringify(manifest, undefined, 2)}\n`);
    const manifestPath = `${staging}/manifest.json`;
    await Deno.writeFile(manifestPath, manifestBytes, { createNew: true, mode: 0o600 });

    const tar = await Deno.open(tarPath, { createNew: true, write: true, mode: 0o600 });
    try {
      await appendTarEntry(tar, "manifest.json", manifestPath, manifestBytes.byteLength);
      for (const member of staged) {
        throwIfAborted(options.signal);
        await appendTarEntry(tar, member.path, member.stagedPath, member.size);
      }
      await writeAll(tar, new Uint8Array(TAR_BLOCK_SIZE * 2));
      await tar.sync();
    } finally {
      tar.close();
    }

    await gzipDeterministic(tarPath, gzipPath, options.signal);
    const bundleIdentity = await hashRegularFile(gzipPath, Number.MAX_SAFE_INTEGER, options.signal);
    try {
      await Deno.link(gzipPath, destination);
    } catch (cause) {
      if (cause instanceof Deno.errors.AlreadyExists) {
        throw new PreflightError(
          `Deployment bundle output already exists; refusing to overwrite: ${destination}`,
          { cause },
        );
      }
      throw new PreflightError(
        `Failed to publish the deployment bundle atomically: ${destination}`,
        { cause },
      );
    }
    return Object.freeze({
      path: destination,
      size: bundleIdentity.size,
      sha256: bundleIdentity.sha256,
      manifest,
    });
  } catch (cause) {
    if (cause instanceof PreflightError || cause instanceof CancelledError) throw cause;
    throw new PreflightError("Failed to build the deployment bundle", { cause });
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => undefined);
  }
}

function collectMembers(options: BuildDeploymentBundleOptions): PendingMember[] {
  const result: PendingMember[] = [];
  if (options.package !== undefined) {
    result.push(Object.freeze({
      path: "package/app.tar.gz",
      purpose: "package" as const,
      source: options.package.source,
      expectedSha256: options.package.expectedSha256,
      mode: 0o600,
    }));
  }
  let hasFrameworkUpdater = false;
  for (const input of options.scripts ?? []) {
    const member = fileMember("scripts", "script", input, 0o700);
    if (member.path === `scripts/${REMOTE_CONFIG_UPDATER_BUNDLE_PATH}`) {
      if (resolve(input.source) !== resolve(REMOTE_CONFIG_UPDATER_SOURCE)) {
        throw new PreflightError(
          "App scripts must not override the framework-reserved config updater member",
        );
      }
      hasFrameworkUpdater = true;
    }
    result.push(member);
  }
  if ((options.configs?.length ?? 0) > 0 && !hasFrameworkUpdater) {
    result.push(Object.freeze({
      path: `scripts/${REMOTE_CONFIG_UPDATER_BUNDLE_PATH}`,
      purpose: "script" as const,
      source: REMOTE_CONFIG_UPDATER_SOURCE,
      mode: 0o700,
    }));
  }
  for (const config of options.configs ?? []) {
    const relative = safeRelative(config.relativePath ?? `${config.skeleton.name}.skeleton`);
    result.push(Object.freeze({
      path: `configs/${stripCategory(relative, "configs")}`,
      purpose: "config-skeleton" as const,
      content: config.skeleton.content,
      expectedSha256: config.skeleton.sha256,
      mode: validMode(config.mode ?? 0o600),
    }));
    const bindingPath = `configs/${stripCategory(relative, "configs")}.bindings.json`;
    const bindingContent = TEXT_ENCODER.encode(`${
      JSON.stringify(
        {
          schema_version: 1,
          config: config.skeleton.name,
          format: config.skeleton.format,
          bindings: config.skeleton.secretBindings.map((binding) => ({
            secret: binding.secret,
            kind: binding.secretKind,
            encoding: binding.encoding,
            type: binding.valueType ?? null,
            marker: binding.marker ?? null,
            text_marker: binding.textMarker,
          })),
        },
        undefined,
        2,
      )
    }\n`);
    result.push(Object.freeze({
      path: bindingPath,
      purpose: "config-bindings" as const,
      content: bindingContent,
      mode: 0o600,
    }));
  }
  for (const input of options.ordinaryFiles ?? []) {
    result.push(fileMember("files", "file", input, 0o600));
  }
  result.sort((left, right) => compareText(left.path, right.path));
  const seen = new Set<string>(["manifest.json"]);
  for (const member of result) {
    if (seen.has(member.path)) {
      throw new PreflightError(
        `Deployment bundle contains a duplicate member path: ${member.path}`,
      );
    }
    seen.add(member.path);
  }
  return result;
}

function fileMember(
  category: "scripts" | "files",
  purpose: "script" | "file",
  input: DeploymentBundleFileInput,
  defaultMode: number,
): PendingMember {
  const relative = stripCategory(safeRelative(input.relativePath), category);
  return Object.freeze({
    path: `${category}/${relative}`,
    purpose,
    source: input.source,
    mode: validMode(input.mode ?? defaultMode),
  });
}

function safeRelative(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\\") ||
    posix.isAbsolute(value) || value.startsWith("//") || posix.normalize(value) !== value ||
    value === "." ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new PreflightError(
      `Deployment bundle member must be a canonical relative POSIX path: ${String(value)}`,
    );
  }
  if (TEXT_ENCODER.encode(value).byteLength > 255) {
    throw new PreflightError(
      `Deployment bundle member path exceeds the ustar 255-byte limit: ${value}`,
    );
  }
  return value;
}

function stripCategory(path: string, category: string): string {
  const prefix = `${category}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

async function copyFileStable(
  source: string,
  destination: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const input = await Deno.open(source, { read: true }).catch((cause) => {
    throw new PreflightError(`Failed to read deployment bundle input ${source}`, { cause });
  });
  let before: Deno.FileInfo;
  try {
    before = await input.stat();
    const pathInfo = await Deno.lstat(source);
    if (
      !before.isFile || !pathInfo.isFile || pathInfo.isSymlink || !sameIdentity(before, pathInfo)
    ) {
      throw new PreflightError(`Deployment bundle input is not a stable regular file: ${source}`);
    }
    if (before.size > maxBytes) {
      throw new PreflightError(
        `Deployment bundle input exceeds the single-member limit: ${source}`,
      );
    }
    const output = await Deno.open(destination, { createNew: true, write: true, mode: 0o600 });
    const hash = createHash("sha256");
    let size = 0;
    try {
      const buffer = new Uint8Array(64 * 1024);
      while (true) {
        throwIfAborted(signal);
        const count = await input.read(buffer);
        if (count === null) break;
        if (count === 0) continue;
        size += count;
        if (size > maxBytes) {
          throw new PreflightError(
            `Deployment bundle input exceeds the single-member limit: ${source}`,
          );
        }
        const chunk = buffer.subarray(0, count);
        hash.update(chunk);
        await writeAll(output, chunk);
      }
      await output.sync();
    } finally {
      output.close();
    }
    const after = await input.stat();
    const pathAfter = await Deno.lstat(source);
    if (size !== before.size || !sameIdentity(before, after) || !sameIdentity(after, pathAfter)) {
      throw new PreflightError(`File changed while copying deployment bundle input: ${source}`);
    }
    return Object.freeze({ size, sha256: hash.digest("hex") });
  } finally {
    input.close();
  }
}

async function writeContentStable(
  content: Uint8Array,
  destination: string,
  maxBytes: number,
): Promise<{ readonly size: number; readonly sha256: string }> {
  if (content.byteLength > maxBytes) {
    throw new PreflightError("Generated content exceeds the deployment bundle single-member limit");
  }
  await Deno.writeFile(destination, content, { createNew: true, mode: 0o600 });
  return Object.freeze({ size: content.byteLength, sha256: sha256Bytes(content) });
}

async function appendTarEntry(
  tar: Deno.FsFile,
  path: string,
  source: string,
  size: number,
): Promise<void> {
  await writeAll(tar, tarHeader(path, size));
  const input = await Deno.open(source, { read: true });
  let written = 0;
  try {
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const count = await input.read(buffer);
      if (count === null) break;
      if (count === 0) continue;
      written += count;
      await writeAll(tar, buffer.subarray(0, count));
    }
  } finally {
    input.close();
  }
  if (written !== size) throw new PreflightError(`Staged member ${path} changed during archiving`);
  const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  if (padding > 0) await writeAll(tar, new Uint8Array(padding));
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const { name, prefix } = splitUstarPath(path);
  writeField(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  writeField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeField(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitUstarPath(path: string): { readonly name: string; readonly prefix: string } {
  if (TEXT_ENCODER.encode(path).byteLength <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      TEXT_ENCODER.encode(prefix).byteLength <= 155 && TEXT_ENCODER.encode(name).byteLength <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new PreflightError(`Deployment bundle member path cannot be written to ustar: ${path}`);
}

function writeField(buffer: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.byteLength > length) {
    throw new PreflightError(`tar field exceeds the ${length} byte limit`);
  }
  buffer.set(encoded, offset);
}

function writeOctal(buffer: Uint8Array, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PreflightError("Invalid tar numeric field");
  }
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  if (encoded.length > length) throw new PreflightError("tar numeric field overflow");
  writeField(buffer, offset, length, encoded);
}

async function gzipDeterministic(source: string, destination: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const input = await Deno.open(source, { read: true });
  const output = await Deno.open(destination, { createNew: true, write: true, mode: 0o600 });
  try {
    await input.readable
      .pipeThrough(new CompressionStream("gzip"))
      .pipeTo(output.writable, { signal });
  } catch (cause) {
    if (signal?.aborted) {
      throw new CancelledError("Deployment bundle compression cancelled", { cause });
    }
    throw cause;
  }
}

async function hashRegularFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new PreflightError(`Output is not a regular file: ${path}`);
  }
  if (info.size > maxBytes) throw new PreflightError(`Output file is too large: ${path}`);
  const handle = await Deno.open(path, { read: true });
  const hash = createHash("sha256");
  let size = 0;
  try {
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      throwIfAborted(signal);
      const count = await handle.read(buffer);
      if (count === null) break;
      size += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    handle.close();
  }
  return Object.freeze({ size, sha256: hash.digest("hex") });
}

async function writeAll(file: Deno.FsFile, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) offset += await file.write(data.subarray(offset));
}

function sameIdentity(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  return left.isFile && right.isFile && !left.isSymlink && !right.isSymlink &&
    left.size === right.size && left.mtime?.getTime() === right.mtime?.getTime() &&
    (left.ino === null || right.ino === null || left.ino === right.ino) &&
    (left.dev === null || right.dev === null || left.dev === right.dev);
}

function sha256Bytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new PreflightError("Invalid expectedSha256 format");
  return normalized;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function validMode(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o777 || (value & 0o6000) !== 0) {
    throw new PreflightError(`Invalid deployment bundle member mode: ${value}`);
  }
  return value;
}

function modeText(value: number): string {
  return validMode(value).toString(8).padStart(4, "0");
}

function boundedLimit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new PreflightError(`${label} must be a positive safe integer`);
  }
  return result;
}

async function assertMissing(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return;
    throw new PreflightError(`Failed to inspect the deployment bundle output: ${basename(path)}`, {
      cause,
    });
  }
  throw new PreflightError(
    `Deployment bundle output already exists; refusing to overwrite: ${path}`,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CancelledError("Deployment bundle build cancelled", { cause: signal.reason });
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
