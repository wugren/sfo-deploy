/** 用户级本地部署包缓存：内容寻址、使用前校验、并发原子发布。 */

import { basename, dirname, join, resolve } from "jsr:@std/path@1.1.6";
import { createHash, randomBytes } from "node:crypto";
import { type DownloadProviderRegistry, DownloadRequest, VerifiedArtifact } from "./downloads.ts";
import { ConfigurationError, DownloadError, PreflightError } from "./errors.ts";
import type { PackageSpec } from "./types.ts";

const PROVIDER_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const METADATA_SCHEMA_VERSION = 1;

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

  constructor(options: PackageCacheOptions) {
    if (
      !options || typeof options !== "object" ||
      typeof options.packagesDir !== "string" || options.packagesDir.trim().length === 0
    ) {
      throw new ConfigurationError("packagesDir 必须是非空路径");
    }
    if (
      options.registry === null || typeof options.registry !== "object" ||
      typeof options.registry.fetch !== "function"
    ) {
      throw new TypeError("PackageCache 需要下载提供方注册表");
    }
    this.packagesDir = resolve(options.packagesDir);
    this.registry = options.registry;
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
      return Object.freeze({ status: "cached", path: target, ...existing });
    }
    const published = await this.#download(provider, request, target, signal);
    await this.#record(provider, target, request, metadata);
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
      throw missingLocalPackageError(metadata, request, target);
    }
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
      if (policy === "local-only") {
        throw missingLocalPackageError(metadata, request, target);
      }
      existing = (await this.#download(provider, request, target, signal)).entry;
    }
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
      throw new PreflightError(`无法检查本地部署包缓存 ${target}`, { cause });
    }
    if (!info.isFile || info.isSymlink) {
      throw new PreflightError(`本地部署包缓存路径不是普通文件: ${target}`);
    }
    const { actual, size } = await hashFile(target, request);
    if (!constantTimeEqual(actual, request.expectedHash.toLowerCase())) {
      throw new PreflightError(
        `本地部署包缓存校验失败: ${target} expected=${request.expectedHash.toLowerCase()} ` +
          `actual=${actual}；请移除该文件后重新运行 fetch`,
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
            throw new PreflightError(`并发下载后的缓存文件校验失败: ${target}`);
          }
          await artifact.cleanup();
          artifact = undefined;
          return Object.freeze({ hit: true, entry: existing });
        }
        throw new DownloadError("无法原子发布本地部署包缓存", { cause });
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
      throw new DownloadError("本地部署包缓存下载失败", { cause });
    }
  }

  async #record(
    provider: string,
    target: string,
    request: DownloadRequest,
    metadata: PackageMetadata,
  ): Promise<void> {
    const metadataPath = `${target}.json`;
    let records: unknown[] = [];
    try {
      const parsed = JSON.parse(await Deno.readTextFile(metadataPath)) as Record<string, unknown>;
      if (Array.isArray(parsed.records)) records = parsed.records;
    } catch {
      // 元数据仅用于审计；损坏或无元数据时重建，不影响包文件本身。
    }
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
    const temporary = join(dirname(metadataPath), `.${basename(metadataPath)}.tmp`);
    await Deno.writeTextFile(temporary, payload, { mode: 0o600, createNew: true });
    try {
      await Deno.rename(temporary, metadataPath);
    } catch (cause) {
      await Deno.remove(temporary).catch(() => undefined);
      throw new DownloadError("无法写入本地部署包缓存元数据", { cause });
    }
  }
}

function providerName(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_NAME_RE.test(value)) {
    throw new ConfigurationError("package provider 名称不合法");
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
    `本地部署包缓存缺失: app=${metadata.name}` +
      (metadata.version === undefined ? "" : ` version=${metadata.version}`) +
      ` hash=${request.hashAlgorithm.toLowerCase()}-${request.expectedHash.toLowerCase()}` +
      `（缓存路径 ${target}）。请先运行: sfo-deploy fetch ${selection}`,
  );
}

async function verifiedSize(target: string): Promise<number> {
  const info = await Deno.lstat(target);
  if (!info.isFile || info.isSymlink) {
    throw new PreflightError(`本地部署包缓存路径不是普通文件: ${target}`);
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
          `本地部署包缓存超过最大字节数: received=${size} max=${request.maxBytes}`,
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
  const digest = createHash(request.hashAlgorithm.toLowerCase());
  let size = 0;
  try {
    const before = await Deno.lstat(source);
    if (!before.isFile || before.isSymlink) {
      throw new PreflightError(`本地部署包缓存路径不是普通文件: ${source}`);
    }
    input = await Deno.open(source, { read: true });
    output = await Deno.open(destination, { write: true, createNew: true, mode: 0o600 });
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      throwIfAborted(signal);
      const count = await input.read(buffer);
      if (count === null) break;
      size += count;
      if (size > request.maxBytes) {
        throw new PreflightError(
          `本地部署包缓存超过最大字节数: received=${size} max=${request.maxBytes}`,
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
        `缓存拷贝哈希不匹配: expected=${request.expectedHash.toLowerCase()} actual=${actual}`,
      );
    }
    await Deno.chmod(destination, 0o600);
    return size;
  } catch (cause) {
    output?.close();
    output = undefined;
    input?.close();
    input = undefined;
    await Deno.remove(destination).catch(() => undefined);
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
  if (signal?.aborted) throw new DownloadError("下载已取消", { cause: signal.reason });
}
