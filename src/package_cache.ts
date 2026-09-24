/** 用户级本地部署包缓存：内容寻址、使用前校验、并发原子发布。 */

import { basename, dirname, join, resolve } from "jsr:@std/path@1.1.6";
import { createHash, randomBytes } from "node:crypto";
import { type DownloadProviderRegistry, DownloadRequest, VerifiedArtifact } from "./downloads.ts";
import { ConfigurationError, DownloadError, PreflightError } from "./errors.ts";
import { type InfoLogger, type SafeInfoLogger, safeInfoLogger } from "./logging.ts";
import type { PackageSpec } from "./types.ts";

const PROVIDER_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const METADATA_SCHEMA_VERSION = 1;
const METADATA_LOCK_TIMEOUT_MS = 5_000;
const METADATA_LOCK_STALE_MS = 30_000;
const METADATA_LOCK_RETRY_MS = 25;

export type CachePolicy = "local-only" | "remote-fallback";

export interface PackageMetadata {
  readonly kind: "app" | "environment";
  readonly name: string;
  readonly version?: string;
  readonly cluster?: string;
}

export interface FetchedPackage {
  readonly status: "downloaded" | "cached";
  readonly path: string;
  readonly hashAlgorithm: string;
  readonly hashValue: string;
  readonly size: number;
}

export interface PackageCacheOptions {
  readonly packagesDir: string;
  readonly registry: DownloadProviderRegistry;
  /** 可选 info 过程日志；未提供时保持静默。 */
  readonly onInfo?: InfoLogger;
}

interface VerifiedEntry {
  readonly hashAlgorithm: string;
  readonly hashValue: string;
  readonly size: number;
}

/** 本地缓存优先；缓存文件只读使用、永不删除。 */
export class PackageCache {
  readonly packagesDir: string;
  readonly registry: DownloadProviderRegistry;
  readonly #info: SafeInfoLogger;
  /** 按元数据路径串行化审计记录的读-改-写，避免并发丢更新。 */
  readonly #recordQueues = new Map<string, Promise<void>>();

  constructor(options: PackageCacheOptions) {
    if (
      !options || typeof options !== "object" ||
      typeof options.packagesDir !== "string" || options.packagesDir.trim().length === 0
    ) {
      throw new ConfigurationError("packagesDir must be a non-empty path");
    }
    if (
      options.registry === null || typeof options.registry !== "object" ||
      typeof options.registry.fetch !== "function"
    ) {
      throw new TypeError("PackageCache requires a download provider registry");
    }
    this.packagesDir = resolve(options.packagesDir);
    this.registry = options.registry;
    this.#info = safeInfoLogger(options.onInfo);
  }

  /** fetch 动作入口：命中且校验通过则跳过远端下载。 */
  async fetch(
    spec: PackageSpec,
    metadata: PackageMetadata,
    signal?: AbortSignal,
  ): Promise<FetchedPackage> {
    const request = DownloadRequest.fromPackage(spec);
    const provider = providerName(spec.provider);
    const target = this.#target(provider, request);
    const existing = await this.#verified(target, request);
    if (existing !== undefined) {
      await this.#record(provider, target, request, metadata);
      await this.#info("deployment package cache hit", {
        kind: metadata.kind,
        resource: metadata.name,
        version: metadata.version,
        size: existing.size,
      });
      return Object.freeze({ status: "cached", path: target, ...existing });
    }
    await this.#info("deployment package download started", {
      kind: metadata.kind,
      resource: metadata.name,
      version: metadata.version,
      provider,
    });
    const published = await this.#download(provider, request, target, signal);
    await this.#record(provider, target, request, metadata);
    await this.#info("deployment package download completed", {
      kind: metadata.kind,
      resource: metadata.name,
      version: metadata.version,
      size: published.entry.size,
    });
    return Object.freeze({
      status: published.hit ? "cached" : "downloaded",
      path: target,
      hashAlgorithm: request.hashAlgorithm.toLowerCase(),
      hashValue: request.expectedHash.toLowerCase(),
      size: published.entry.size,
    });
  }

  /** deploy 预检入口：只校验缓存命中，缺失时抛预检错误，绝不连接远端。 */
  async ensure(
    spec: PackageSpec,
    metadata: PackageMetadata,
    signal?: AbortSignal,
  ): Promise<{ readonly path: string; readonly size: number }> {
    throwIfAborted(signal);
    const request = DownloadRequest.fromPackage(spec);
    const provider = providerName(spec.provider);
    const target = this.#target(provider, request);
    const existing = await this.#verified(target, request);
    if (existing === undefined) {
      await this.#info("deployment package cache missing", {
        kind: metadata.kind,
        resource: metadata.name,
        version: metadata.version,
      });
      throw missingLocalPackageError(metadata, request, target);
    }
    await this.#info("deployment package cache verified", {
      kind: metadata.kind,
      resource: metadata.name,
      version: metadata.version,
      size: existing.size,
    });
    return Object.freeze({ path: target, size: existing.size });
  }

  /** 执行准备入口：deploy 为 local-only，其余动作缺失时远端下载并回填缓存。 */
  async prepare(
    spec: PackageSpec,
    destination: string,
    policy: CachePolicy,
    metadata: PackageMetadata,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    throwIfAborted(signal);
    const request = DownloadRequest.fromPackage(spec);
    const provider = providerName(spec.provider);
    const target = this.#target(provider, request);
    let existing = await this.#verified(target, request);
    if (existing === undefined) {
      await this.#info("execution preparation package missing", {
        kind: metadata.kind,
        resource: metadata.name,
        policy,
      });
      if (policy === "local-only") {
        throw missingLocalPackageError(metadata, request, target);
      }
      existing = (await this.#download(provider, request, target, signal)).entry;
    }
    await this.#info("execution preparation package verified", {
      kind: metadata.kind,
      resource: metadata.name,
      size: existing.size,
      policy,
    });
    const destinationPath = resolve(destination);
    const size = await copyVerified(request, target, destinationPath, signal);
    return new VerifiedArtifact(
      destinationPath,
      request.hashAlgorithm.toLowerCase(),
      request.expectedHash.toLowerCase(),
      size,
    );
  }

  #target(provider: string, request: DownloadRequest): string {
    const algorithm = request.hashAlgorithm.toLowerCase();
    const hash = request.expectedHash.toLowerCase();
    return join(this.packagesDir, provider, `${algorithm}-${hash}`);
  }

  async #verified(
    target: string,
    request: DownloadRequest,
  ): Promise<VerifiedEntry | undefined> {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(target);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return undefined;
      throw new PreflightError(`Failed to stat the local deployment package cache ${target}`, {
        cause,
      });
    }
    if (!info.isFile || info.isSymlink) {
      throw new PreflightError(
        `Local deployment package cache path is not a regular file: ${target}`,
      );
    }
    const { actual, size } = await hashFile(target, request);
    if (!constantTimeEqual(actual, request.expectedHash.toLowerCase())) {
      throw new PreflightError(
        `Local deployment package cache verification failed: ${target} expected=${request.expectedHash.toLowerCase()} ` +
          `actual=${actual}; remove the file and run fetch again`,
      );
    }
    return Object.freeze({
      hashAlgorithm: request.hashAlgorithm.toLowerCase(),
      hashValue: actual,
      size,
    });
  }

  async #download(
    provider: string,
    request: DownloadRequest,
    target: string,
    signal?: AbortSignal,
  ): Promise<{ readonly hit: boolean; readonly entry: VerifiedEntry }> {
    throwIfAborted(signal);
    const algorithm = request.hashAlgorithm.toLowerCase();
    const providerDir = join(this.packagesDir, provider);
    await Deno.mkdir(providerDir, { recursive: true, mode: 0o700 });
    const staged = join(
      providerDir,
      `.${basename(target)}.cache-${randomBytes(6).toString("hex")}`,
    );
    let artifact: VerifiedArtifact | undefined;
    try {
      artifact = await this.registry.fetch(provider, request, staged, signal);
      throwIfAborted(signal);
      try {
        await Deno.link(staged, target);
      } catch (cause) {
        if (cause instanceof Deno.errors.AlreadyExists) {
          const existing = await this.#verified(target, request);
          if (existing === undefined) {
            throw new PreflightError(
              `Cache file verification failed after concurrent download: ${target}`,
            );
          }
          await artifact.cleanup();
          artifact = undefined;
          return Object.freeze({ hit: true, entry: existing });
        }
        throw new DownloadError("Failed to publish the local deployment package cache atomically", {
          cause,
        });
      }
      await artifact.cleanup();
      artifact = undefined;
      return Object.freeze({
        hit: false,
        entry: Object.freeze({
          hashAlgorithm: algorithm,
          hashValue: request.expectedHash.toLowerCase(),
          size: await verifiedSize(target),
        }),
      });
    } catch (cause) {
      await artifact?.cleanup().catch(() => undefined);
      await Deno.remove(staged).catch(() => undefined);
      if (cause instanceof PreflightError) throw cause;
      if (cause instanceof DownloadError) throw cause;
      throw new DownloadError("Local deployment package cache download failed", { cause });
    }
  }

  async #record(
    provider: string,
    target: string,
    request: DownloadRequest,
    metadata: PackageMetadata,
  ): Promise<void> {
    const metadataPath = `${target}.json`;
    const previous = this.#recordQueues.get(metadataPath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const lockDir = `${metadataPath}.lock`;
      if (!await this.#tryAcquireMetadataLock(lockDir)) {
        await this.#writeOverflowRecord(metadataPath, metadata);
        return;
      }
      try {
        await this.#writeRecord(metadataPath, provider, request, metadata);
      } finally {
        await Deno.remove(lockDir, { recursive: true }).catch(() => undefined);
      }
    });
    this.#recordQueues.set(metadataPath, run.catch(() => undefined));
    await run;
  }

  /** 有界获取锁目录；取得返回 true，超时返回 false。 */
  async #tryAcquireMetadataLock(lockDir: string): Promise<boolean> {
    const deadline = Date.now() + METADATA_LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await Deno.mkdir(lockDir, { mode: 0o700 });
        return true;
      } catch (cause) {
        if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
        if (await removeStaleMetadataLock(lockDir)) continue;
        await delay(METADATA_LOCK_RETRY_MS);
      }
    }
    return false;
  }

  /** 未取得锁时写入唯一命名的独立记录，避免无锁覆盖聚合文件。 */
  async #writeOverflowRecord(metadataPath: string, metadata: PackageMetadata): Promise<void> {
    const overflowPath = `${metadataPath}.overflow-${randomBytes(8).toString("hex")}.json`;
    const payload = JSON.stringify({
      kind: metadata.kind,
      name: metadata.name,
      version: metadata.version ?? null,
      cluster: metadata.cluster ?? null,
      fetched_at: new Date().toISOString(),
    });
    try {
      await Deno.writeTextFile(overflowPath, payload, { mode: 0o600, createNew: true });
    } catch (cause) {
      throw new DownloadError("Failed to write local deployment package cache metadata", { cause });
    }
  }

  /** 收集同目录下待合并的溢出记录；损坏文件保留但不合并。 */
  async #collectOverflowRecords(
    metadataPath: string,
  ): Promise<{ records: unknown[]; paths: string[] }> {
    const directory = dirname(metadataPath);
    const prefix = `${basename(metadataPath)}.overflow-`;
    const records: unknown[] = [];
    const paths: string[] = [];
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(directory)];
    } catch {
      return { records, paths };
    }
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) {
        continue;
      }
      const path = join(directory, entry.name);
      try {
        records.push(JSON.parse(await Deno.readTextFile(path)));
        paths.push(path);
      } catch {
        // 损坏的溢出记录无法合并；保留文件以便人工检查。
      }
    }
    return { records, paths };
  }

  async #writeRecord(
    metadataPath: string,
    provider: string,
    request: DownloadRequest,
    metadata: PackageMetadata,
  ): Promise<void> {
    let records: unknown[] = [];
    try {
      const parsed = JSON.parse(await Deno.readTextFile(metadataPath)) as Record<string, unknown>;
      if (Array.isArray(parsed.records)) records = parsed.records;
    } catch {
      // 元数据仅用于审计；损坏或无元数据时重建，不影响包文件本身。
    }
    const overflows = await this.#collectOverflowRecords(metadataPath);
    records = records.concat(overflows.records);
    records.push({
      kind: metadata.kind,
      name: metadata.name,
      version: metadata.version ?? null,
      cluster: metadata.cluster ?? null,
      fetched_at: new Date().toISOString(),
    });
    const payload = JSON.stringify(
      {
        schema_version: METADATA_SCHEMA_VERSION,
        provider,
        source: request.source,
        hash_algorithm: request.hashAlgorithm.toLowerCase(),
        hash_value: request.expectedHash.toLowerCase(),
        cached_at: new Date().toISOString(),
        records,
      },
      undefined,
      2,
    );
    const temporary = join(
      dirname(metadataPath),
      `.${basename(metadataPath)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await Deno.writeTextFile(temporary, payload, { mode: 0o600, createNew: true });
    try {
      await Deno.rename(temporary, metadataPath);
    } catch (cause) {
      await Deno.remove(temporary).catch(() => undefined);
      throw new DownloadError("Failed to write local deployment package cache metadata", { cause });
    }
    for (const path of overflows.paths) {
      await Deno.remove(path).catch(() => undefined);
    }
  }
}

function providerName(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_NAME_RE.test(value)) {
    throw new ConfigurationError("Invalid package provider name");
  }
  return value.toLowerCase();
}

function missingLocalPackageError(
  metadata: PackageMetadata,
  request: DownloadRequest,
  target: string,
): PreflightError {
  const selection = metadata.cluster === undefined
    ? `--app ${metadata.name}`
    : `--cluster ${metadata.cluster} --app ${metadata.name}`;
  return new PreflightError(
    `Local deployment package cache is missing: app=${metadata.name}` +
      (metadata.version === undefined ? "" : ` version=${metadata.version}`) +
      ` hash=${request.hashAlgorithm.toLowerCase()}-${request.expectedHash.toLowerCase()}` +
      `(cache path ${target}). Run first: sfo-deploy fetch ${selection}`,
  );
}

async function verifiedSize(target: string): Promise<number> {
  const info = await Deno.lstat(target);
  if (!info.isFile || info.isSymlink) {
    throw new PreflightError(
      `Local deployment package cache path is not a regular file: ${target}`,
    );
  }
  return info.size;
}

async function hashFile(
  target: string,
  request: DownloadRequest,
): Promise<{ readonly actual: string; readonly size: number }> {
  const digest = createHash(request.hashAlgorithm.toLowerCase());
  const file = await Deno.open(target, { read: true });
  let size = 0;
  const buffer = new Uint8Array(64 * 1024);
  try {
    while (true) {
      const count = await file.read(buffer);
      if (count === null) break;
      size += count;
      if (size > request.maxBytes) {
        throw new PreflightError(
          `Local deployment package cache exceeds the maximum byte count: received=${size} max=${request.maxBytes}`,
        );
      }
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    file.close();
  }
  return { actual: digest.digest("hex").toLowerCase(), size };
}

async function copyVerified(
  request: DownloadRequest,
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  let input: Deno.FsFile | undefined;
  let output: Deno.FsFile | undefined;
  let created = false;
  const digest = createHash(request.hashAlgorithm.toLowerCase());
  let size = 0;
  try {
    const before = await Deno.lstat(source);
    if (!before.isFile || before.isSymlink) {
      throw new PreflightError(
        `Local deployment package cache path is not a regular file: ${source}`,
      );
    }
    input = await Deno.open(source, { read: true });
    output = await Deno.open(destination, { write: true, createNew: true, mode: 0o600 });
    created = true;
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      throwIfAborted(signal);
      const count = await input.read(buffer);
      if (count === null) break;
      size += count;
      if (size > request.maxBytes) {
        throw new PreflightError(
          `Local deployment package cache exceeds the maximum byte count: received=${size} max=${request.maxBytes}`,
        );
      }
      digest.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) {
        offset += await output.write(buffer.subarray(offset, count));
      }
    }
    await output.sync();
    const actual = digest.digest("hex").toLowerCase();
    if (!constantTimeEqual(actual, request.expectedHash.toLowerCase())) {
      throw new PreflightError(
        `Cache copy hash mismatch: expected=${request.expectedHash.toLowerCase()} actual=${actual}`,
      );
    }
    await Deno.chmod(destination, 0o600);
    return size;
  } catch (cause) {
    output?.close();
    output = undefined;
    input?.close();
    input = undefined;
    if (created) await Deno.remove(destination).catch(() => undefined);
    throw cause;
  } finally {
    output?.close();
    input?.close();
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  return leftBytes.byteLength === rightBytes.byteLength &&
    leftBytes.every((value, index) => value === rightBytes[index]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DownloadError("Download cancelled", { cause: signal.reason });
}

async function removeStaleMetadataLock(lockDir: string): Promise<boolean> {
  try {
    const info = await Deno.stat(lockDir);
    const mtime = info.mtime?.getTime();
    if (mtime === undefined || Date.now() - mtime < METADATA_LOCK_STALE_MS) return false;
    await Deno.remove(lockDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
