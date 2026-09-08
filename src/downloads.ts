/** 有界下载、完整性校验与发布历史 source codec。 */

import { basename, dirname, join, resolve } from "jsr:@std/path@1.1.6";
import { createHash, timingSafeEqual } from "node:crypto";
import { DownloadError } from "./errors.ts";
import type { PackageSpec } from "./types.ts";

export const DEFAULT_CONNECT_TIMEOUT = 10;
export const DEFAULT_READ_TIMEOUT = 30;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

const PROVIDER_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const SOURCE_SCHEMA_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const FILEHUB_PART_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const FILEHUB_SERVER_RE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?::([0-9]{1,5}))?$/;
const HEX_RE = /^[0-9a-f]+$/;
const SOURCE_MAX_BYTES = 64 * 1024;
const SOURCE_MAX_DEPTH = 8;
const SOURCE_MAX_ITEMS = 256;
const SOURCE_MAX_STRING = 16 * 1024;
const FILEHUB_PROCESS_TIMEOUT_MS = 900_000;
const FILEHUB_TERMINATE_TIMEOUT_MS = 2_000;
const FILEHUB_INSTALL_URL = "https://github.com/wugren/sfo-filehub/blob/main/README.md";
const GZIP_MAGIC = Uint8Array.of(0x1f, 0x8b);
const GZIP_LABEL_RE = /\.tar\.gz$|\.tgz$/i;
const FILEHUB_EXIT_DIAGNOSTICS: Readonly<Record<number, string>> = Object.freeze({
  1: "客户端用法或版本兼容错误",
  2: "认证失败，请先完成 filehub 登录",
  3: "授权失败",
  4: "目标冲突",
  5: "目标格式错误或目标不存在",
  6: "网络错误或请求超时",
  7: "下载完整性校验失败",
  8: "本地文件系统错误",
});

type JsonSource = Readonly<Record<string, unknown>>;
type FileIdentity = Readonly<{ dev: number | null; ino: number | null }>;

/**
 * 断言 App 可执行文件包是 gzip 流（用户约定为 tar.gz）。失败在 SSH 前抛错，绝不进入上传。
 * @param tarGzHint 为 true 时额外提示文件后缀应为 .tar.gz；框架按内容（魔数）为准。
 */
export async function assertGzipTar(path: string, label: string): Promise<void> {
  let handle: Deno.FsFile;
  try {
    handle = await Deno.open(path, { read: true });
  } catch (cause) {
    throw new DownloadError(`无法读取 ${label} 以校验 gzip 格式: ${String(cause)}`, { cause });
  }
  try {
    const header = new Uint8Array(2);
    let offset = 0;
    while (offset < header.length) {
      const count = await handle.read(header.subarray(offset));
      if (count === null || count === 0) break;
      offset += count;
    }
    if (
      offset !== GZIP_MAGIC.length || header[0] !== GZIP_MAGIC[0] || header[1] !== GZIP_MAGIC[1]
    ) {
      const suffix = GZIP_LABEL_RE.test(path) ? "" : "（文件名也不是 .tar.gz/.tgz）";
      throw new DownloadError(`${label} 必须是 tar.gz 格式的 App 可执行文件包${suffix}`);
    }
  } finally {
    handle.close();
  }
}

export interface DownloadRequestOptions {
  readonly source: JsonSource;
  readonly hashAlgorithm: string;
  readonly expectedHash: string;
  readonly connectTimeout?: number;
  readonly readTimeout?: number;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly chunkSize?: number;
}

export class DownloadRequest {
  readonly source: JsonSource;
  readonly hashAlgorithm: string;
  readonly expectedHash: string;
  readonly connectTimeout: number;
  readonly readTimeout: number;
  readonly maxRedirects: number;
  readonly maxBytes: number;
  readonly chunkSize: number;

  constructor(options: DownloadRequestOptions) {
    this.source = Object.freeze({ ...options.source });
    this.hashAlgorithm = options.hashAlgorithm;
    this.expectedHash = options.expectedHash;
    this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
    this.readTimeout = options.readTimeout ?? DEFAULT_READ_TIMEOUT;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    validateRequest(this);
    Object.freeze(this);
  }

  static fromPackage(
    value: PackageSpec,
    limits: Omit<Partial<DownloadRequestOptions>, "source" | "hashAlgorithm" | "expectedHash"> = {},
  ): DownloadRequest {
    return new DownloadRequest({
      source: value.source,
      hashAlgorithm: value.hashAlgorithm,
      expectedHash: value.hashValue,
      ...limits,
    });
  }
}

/** 调用者拥有生命周期；cleanup 幂等并拒绝悄然忽略清理失败。 */
export class VerifiedArtifact implements AsyncDisposable {
  readonly path: string;
  hashAlgorithm: string;
  hashValue: string;
  size: number;
  #cleaned = false;

  constructor(path: string, hashAlgorithm: string, hashValue: string, size: number) {
    this.path = resolve(path);
    this.hashAlgorithm = hashAlgorithm;
    this.hashValue = hashValue;
    this.size = size;
  }

  get cleaned(): boolean {
    return this.#cleaned;
  }

  async assertAvailable(): Promise<this> {
    if (this.#cleaned || !(await regularFile(this.path))) {
      throw new DownloadError(`已验证工件不再可用: ${this.path}`);
    }
    return this;
  }

  async cleanup(): Promise<void> {
    if (this.#cleaned) return;
    try {
      await Deno.remove(this.path);
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) {
        throw new DownloadError(`无法清理已验证工件 ${this.path}`, { cause });
      }
    }
    this.#cleaned = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }
}

export interface DownloadProvider {
  fetch(
    request: DownloadRequest,
    destination: string,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact>;
}

export interface ReleaseSourceCodec {
  readonly releaseSourceSchema: string;
  exportReleaseSource(source: JsonSource): JsonSource;
  importReleaseSource(payload: JsonSource): JsonSource;
}

export class HttpDownloadProvider implements DownloadProvider, ReleaseSourceCodec {
  readonly releaseSourceSchema = "http.v1";

  exportReleaseSource(source: JsonSource): JsonSource {
    return Object.freeze({ url: releaseHttpUrl(source) });
  }

  importReleaseSource(payload: JsonSource): JsonSource {
    return Object.freeze({ url: releaseHttpUrl(payload) });
  }

  async fetch(
    request: DownloadRequest,
    rawDestination: string,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    validateRequest(request);
    const initialUrl = sourceUrl(request.source);
    const destination = resolve(rawDestination);
    await requireDestinationBoundary(destination);
    const temporary = await makeTemporaryFile(
      dirname(destination),
      `.${basename(destination)}.`,
      ".part",
    );
    let publishedIdentity: FileIdentity | undefined;
    try {
      const { hash, size } = await this.#stream(initialUrl, request, temporary, signal);
      if (!constantTimeEqual(hash, request.expectedHash.toLowerCase())) {
        throw new DownloadError(
          `下载工件哈希不匹配: expected=${request.expectedHash.toLowerCase()} actual=${hash}`,
        );
      }
      await publishWithoutReplace(temporary, destination);
      publishedIdentity = await fileIdentity(destination);
      await removeIfPresent(temporary);
      return new VerifiedArtifact(destination, request.hashAlgorithm.toLowerCase(), hash, size);
    } catch (cause) {
      await cleanupPath(temporary, cause);
      if (publishedIdentity) await cleanupOwnedPath(destination, publishedIdentity, cause);
      if (cause instanceof DownloadError) throw cause;
      if (signal?.aborted) throw new DownloadError("HTTP 下载已取消", { cause });
      throw new DownloadError("HTTP 下载失败", { cause });
    }
  }

  async #stream(
    initialUrl: string,
    request: DownloadRequest,
    destination: string,
    outerSignal?: AbortSignal,
  ): Promise<{ readonly hash: string; readonly size: number }> {
    let current = initialUrl;
    let redirects = 0;
    const digest = createHash(request.hashAlgorithm.toLowerCase());
    const output = await Deno.open(destination, { write: true, truncate: true });
    try {
      while (true) {
        parseHttpUrl(current);
        const response = await fetchWithTimeout(
          current,
          request.connectTimeout * 1000,
          outerSignal,
        );
        try {
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            if (!location) throw new DownloadError(`HTTP ${response.status} 重定向缺少 Location`);
            if (redirects >= request.maxRedirects) {
              throw new DownloadError(`HTTP 重定向超过限制 ${request.maxRedirects}`);
            }
            current = new URL(location, current).href;
            parseHttpUrl(current);
            redirects++;
            continue;
          }
          if (response.status < 200 || response.status >= 300) {
            throw new DownloadError(`HTTP 下载失败: status=${response.status}`);
          }
          const length = contentLength(response);
          if (length !== undefined && length > request.maxBytes) {
            throw new DownloadError(
              `下载工件超过最大字节数: declared=${length} max=${request.maxBytes}`,
            );
          }
          if (!response.body) throw new DownloadError("HTTP 下载响应缺少正文");
          const reader = response.body.getReader();
          let size = 0;
          try {
            while (true) {
              const item = await readWithTimeout(reader, request.readTimeout * 1000, outerSignal);
              if (item.done) break;
              const chunk = item.value;
              size += chunk.byteLength;
              if (size > request.maxBytes) {
                throw new DownloadError(
                  `下载工件超过最大字节数: received=${size} max=${request.maxBytes}`,
                );
              }
              digest.update(chunk);
              let offset = 0;
              while (offset < chunk.byteLength) {
                offset += await output.write(chunk.subarray(offset));
              }
            }
          } finally {
            reader.releaseLock();
          }
          await output.sync();
          return { hash: digest.digest("hex").toLowerCase(), size };
        } finally {
          await response.body?.cancel().catch(() => undefined);
        }
      }
    } finally {
      output.close();
    }
  }
}

export const HTTPDownloadProvider = HttpDownloadProvider;

export class FilehubDownloadProvider implements DownloadProvider, ReleaseSourceCodec {
  readonly releaseSourceSchema = "filehub.v1";

  exportReleaseSource(source: JsonSource): JsonSource {
    return Object.freeze({ target: releaseFilehubTarget(source) });
  }

  importReleaseSource(payload: JsonSource): JsonSource {
    return Object.freeze({ target: releaseFilehubTarget(payload) });
  }

  async fetch(
    request: DownloadRequest,
    rawDestination: string,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    throwIfFilehubAborted(signal);
    validateRequest(request);
    const target = sourceTarget(request.source);
    const destination = resolve(rawDestination);
    await requireDestinationBoundary(destination);
    throwIfFilehubAborted(signal);
    const staging = await Deno.makeTempDir({
      dir: dirname(destination),
      prefix: `.${basename(destination)}.filehub-`,
    }).catch((cause) => {
      throw new DownloadError("无法创建 filehub 私有暂存目录", { cause });
    });
    const stagedOutput = join(staging, basename(destination));
    let publishedIdentity: FileIdentity | undefined;
    try {
      throwIfFilehubAborted(signal);
      await Deno.chmod(staging, 0o700).catch((cause) => {
        throw new DownloadError("无法设置 filehub 私有暂存目录权限", { cause });
      });
      throwIfFilehubAborted(signal);
      const exitCode = await runFilehubPull(target, stagedOutput, signal);
      throwIfFilehubAborted(signal);
      if (exitCode !== 0) {
        const category = FILEHUB_EXIT_DIAGNOSTICS[exitCode] ?? "未知错误";
        throw new DownloadError(`filehub 下载失败: exit_code=${exitCode} category=${category}`);
      }
      const info = await Deno.lstat(stagedOutput).catch((cause) => {
        throw new DownloadError("filehub 下载成功但未生成可用工件", { cause });
      });
      if (!info.isFile || info.isSymlink) {
        throw new DownloadError("filehub 下载成功但生成的工件不是普通文件");
      }
      const stagedArtifact = new VerifiedArtifact(
        stagedOutput,
        request.hashAlgorithm.toLowerCase(),
        "",
        info.size,
      );
      // FilehubDownloadProvider 是公开的 DownloadProvider，不能依赖 registry 才兑现
      // VerifiedArtifact 的完整性合同。复用 registry 的同一校验路径，避免两条入口漂移。
      await verifyArtifact(stagedArtifact, request);
      const stagedIdentity = await fileIdentity(stagedOutput);
      throwIfFilehubAborted(signal);
      await publishWithoutReplace(stagedOutput, destination);
      // hard-link 发布保持 inode；先保存来源身份，发布后的任何失败都能只清理本次拥有的目标。
      publishedIdentity = stagedIdentity;
      throwIfFilehubAborted(signal);
      await removeIfPresent(stagedOutput);
      await Deno.remove(staging, { recursive: true });
      throwIfFilehubAborted(signal);
      return new VerifiedArtifact(
        destination,
        stagedArtifact.hashAlgorithm,
        stagedArtifact.hashValue,
        stagedArtifact.size,
      );
    } catch (cause) {
      await cleanupDirectory(staging, cause);
      if (publishedIdentity) await cleanupOwnedPath(destination, publishedIdentity, cause);
      if (cause instanceof DownloadError) throw cause;
      throw new DownloadError("filehub 下载失败", { cause });
    }
  }
}

export class DownloadProviderRegistry {
  readonly #providers = new Map<string, DownloadProvider>();

  constructor(
    providers: Readonly<Record<string, DownloadProvider>> | ReadonlyMap<string, DownloadProvider> =
      {},
  ) {
    const http = new HttpDownloadProvider();
    this.#providers.set("http", http);
    this.#providers.set("https", http);
    this.#providers.set("filehub", new FilehubDownloadProvider());
    for (const [name, provider] of providerEntries(providers)) {
      this.register(name, provider, { replace: true });
    }
  }

  get providers(): ReadonlyMap<string, DownloadProvider> {
    return new Map(this.#providers);
  }

  register(
    name: string,
    provider: DownloadProvider,
    options: { readonly replace?: boolean } = {},
  ): void {
    const normalized = providerName(name);
    if (!provider || typeof provider.fetch !== "function") {
      throw new TypeError("下载提供方必须实现 fetch(request, destination)");
    }
    if (this.#providers.has(normalized) && !options.replace) {
      throw new DownloadError(`下载提供方已经注册: ${normalized}`);
    }
    this.#providers.set(normalized, provider);
  }

  resolve(name: string): DownloadProvider {
    const normalized = providerName(name);
    const provider = this.#providers.get(normalized);
    if (!provider) throw new DownloadError(`未知下载提供方: ${normalized}`);
    return provider;
  }

  async fetch(
    provider: string,
    request: DownloadRequest,
    destination: string,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    throwIfRegistryAborted(signal);
    validateRequest(request);
    const finalDestination = resolve(destination);
    await requireDestinationBoundary(finalDestination);
    throwIfRegistryAborted(signal);
    const stagingDirectory = await Deno.makeTempDir({
      dir: dirname(finalDestination),
      prefix: `.${basename(finalDestination)}.provider-`,
    });
    const stagingDestination = join(stagingDirectory, "artifact");
    let artifact: VerifiedArtifact | undefined;
    let publishedIdentity: FileIdentity | undefined;
    try {
      throwIfRegistryAborted(signal);
      await Deno.chmod(stagingDirectory, 0o700);
      throwIfRegistryAborted(signal);
      artifact = await this.resolve(provider).fetch(request, stagingDestination, signal);
      throwIfRegistryAborted(signal);
      if (!(artifact instanceof VerifiedArtifact)) {
        throw new DownloadError("下载提供方没有返回 VerifiedArtifact");
      }
      if (resolve(artifact.path) !== resolve(stagingDestination)) {
        throw new DownloadError("下载提供方返回了不属于本次暂存区的工件");
      }
      throwIfRegistryAborted(signal);
      await verifyArtifact(artifact, request);
      throwIfRegistryAborted(signal);
      const stagedIdentity = await fileIdentity(artifact.path);
      throwIfRegistryAborted(signal);
      await publishWithoutReplace(artifact.path, finalDestination);
      // hard-link 发布保持 inode；即使取消与 link syscall 同时发生，也只清理本次发布目标。
      publishedIdentity = stagedIdentity;
      throwIfRegistryAborted(signal);
      await artifact.cleanup();
      throwIfRegistryAborted(signal);
      await Deno.remove(stagingDirectory, { recursive: true });
      throwIfRegistryAborted(signal);
      return new VerifiedArtifact(
        finalDestination,
        artifact.hashAlgorithm,
        artifact.hashValue,
        artifact.size,
      );
    } catch (cause) {
      const failure = signal?.aborted ? new DownloadError("下载已取消", { cause }) : cause;
      await artifact?.cleanup().catch(() => undefined);
      await cleanupDirectory(stagingDirectory, failure);
      if (publishedIdentity) await cleanupOwnedPath(finalDestination, publishedIdentity, failure);
      throw failure;
    }
  }

  fetchPackage(
    value: PackageSpec,
    destination: string,
    limits: Omit<Partial<DownloadRequestOptions>, "source" | "hashAlgorithm" | "expectedHash"> = {},
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    return this.fetch(
      value.provider,
      DownloadRequest.fromPackage(value, limits),
      destination,
      signal,
    );
  }

  exportReleaseSource(providerValue: string, source: JsonSource): JsonSource {
    const provider = this.resolve(providerValue);
    const codec = releaseCodec(providerValue, provider);
    const schema = codecSchema(providerValue, codec);
    let payload: JsonSource;
    try {
      payload = validatedSourceMapping(codec.exportReleaseSource(source), "发布 source payload");
    } catch (cause) {
      if (cause instanceof DownloadError) throw cause;
      throw new DownloadError(`下载提供方 ${providerValue} 导出发布 source 失败`, { cause });
    }
    const imported = importWithCodec(providerValue, codec, payload);
    const original = validatedSourceMapping(source, "发布 source");
    if (stableJson(imported) !== stableJson(original)) {
      throw new DownloadError(`下载提供方 ${providerValue} 的发布 source codec 无法严格往返`);
    }
    return Object.freeze({ schema, payload });
  }

  importReleaseSource(providerValue: string, envelope: JsonSource): JsonSource {
    const provider = this.resolve(providerValue);
    const codec = releaseCodec(providerValue, provider);
    const value = validatedSourceMapping(envelope, "发布 source envelope");
    if (Object.keys(value).sort().join("\0") !== "payload\0schema") {
      throw new DownloadError("发布 source envelope 必须只包含 schema 和 payload");
    }
    const expected = codecSchema(providerValue, codec);
    if (value.schema !== expected) {
      throw new DownloadError(`下载提供方 ${providerValue} 的发布 source schema 不匹配`);
    }
    const payload = validatedSourceMapping(value.payload, "发布 source payload");
    const imported = importWithCodec(providerValue, codec, payload);
    let reexported: JsonSource;
    try {
      reexported = validatedSourceMapping(
        codec.exportReleaseSource(imported),
        "重导出的发布 source payload",
      );
    } catch (cause) {
      if (cause instanceof DownloadError) throw cause;
      throw new DownloadError(`下载提供方 ${providerValue} 重导出发布 source 失败`, { cause });
    }
    if (stableJson(reexported) !== stableJson(payload)) {
      throw new DownloadError(`下载提供方 ${providerValue} 的发布 source codec 无法严格往返`);
    }
    return imported;
  }
}

function providerEntries(
  values: Readonly<Record<string, DownloadProvider>> | ReadonlyMap<string, DownloadProvider>,
) {
  return values instanceof Map ? values.entries() : Object.entries(values);
}

function providerName(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_NAME_RE.test(value)) {
    throw new DownloadError(`下载提供方名称不合法: ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

function validateRequest(request: DownloadRequest): void {
  const algorithm = request.hashAlgorithm.toLowerCase();
  let digestSize: number;
  try {
    digestSize = createHash(algorithm).digest().byteLength;
  } catch (cause) {
    throw new DownloadError(`不支持的哈希算法: ${JSON.stringify(request.hashAlgorithm)}`, {
      cause,
    });
  }
  const expected = request.expectedHash.toLowerCase();
  if (
    algorithm.startsWith("shake") || expected.length !== digestSize * 2 || !HEX_RE.test(expected)
  ) {
    throw new DownloadError("预期哈希缺失或格式不合法");
  }
  positiveNumber(request.connectTimeout, "connect_timeout");
  positiveNumber(request.readTimeout, "read_timeout");
  positiveInteger(request.maxBytes, "max_bytes");
  positiveInteger(request.chunkSize, "chunk_size");
  if (!Number.isInteger(request.maxRedirects) || request.maxRedirects < 0) {
    throw new DownloadError("max_redirects 必须是非负整数");
  }
}

function positiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new DownloadError(`${label} 必须是有限正数`);
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new DownloadError(`${label} 必须是正整数`);
}

function sourceUrl(source: JsonSource): string {
  const unknown = Reflect.ownKeys(source).filter((key) => key !== "url");
  if (unknown.length) {
    throw new DownloadError(
      `HTTP 下载 source 包含未知字段: ${unknown.map(String).sort().join(", ")}`,
    );
  }
  if (typeof source.url !== "string" || source.url.trim().length === 0) {
    throw new DownloadError("HTTP 下载 source.url 必须是非空字符串");
  }
  const value = source.url.trim();
  parseHttpUrl(value);
  return value;
}

function parseHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new DownloadError(`HTTP URL 不合法: ${JSON.stringify(value)}`, { cause });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DownloadError(`仅允许 http/https URL: ${JSON.stringify(value)}`);
  }
  if (!parsed.hostname) throw new DownloadError(`HTTP URL 缺少主机名: ${JSON.stringify(value)}`);
  if (parsed.username || parsed.password) throw new DownloadError("HTTP URL 不允许包含用户凭据");
  if (
    parsed.port &&
    (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535)
  ) {
    throw new DownloadError(`HTTP URL 端口不合法: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function releaseHttpUrl(source: JsonSource): string {
  const value = sourceUrl(source);
  const parsed = parseHttpUrl(value);
  if (parsed.search) throw new DownloadError("发布历史中的 HTTP URL 不允许包含 query");
  if (parsed.hash) throw new DownloadError("发布历史中的 HTTP URL 不允许包含 fragment");
  if (parsed.href !== value) throw new DownloadError("发布历史中的 HTTP URL 必须使用规范形式");
  return value;
}

function sourceTarget(source: JsonSource): string {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new DownloadError("filehub 下载 source 必须是映射");
  }
  const unknown = Reflect.ownKeys(source).filter((key) => key !== "target");
  if (unknown.length) {
    throw new DownloadError(`filehub 下载 source 包含未知字段: ${unknown.join(", ")}`);
  }
  if (typeof source.target !== "string" || !source.target.trim()) {
    throw new DownloadError("filehub 下载 source.target 必须是非空字符串");
  }
  return source.target.trim();
}

function releaseFilehubTarget(source: JsonSource): string {
  const target = sourceTarget(source);
  const parts = target.split("/");
  const server = parts[0];
  const serverMatch = server === undefined ? undefined : FILEHUB_SERVER_RE.exec(server);
  const port = serverMatch?.[2];
  const serverValid = serverMatch !== null && serverMatch !== undefined &&
    (port === undefined || (port !== "0" && Number(port) <= 65535));
  if (
    parts.length !== 4 || !serverValid ||
    parts.slice(1).some((part) => !FILEHUB_PART_RE.test(part))
  ) {
    throw new DownloadError(
      "发布历史中的 filehub target 必须是规范四段 SERVER/PROJECT/VERSION/NAME",
    );
  }
  return parts.join("/");
}

function validatedSourceMapping(value: unknown, label: string): JsonSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DownloadError(`${label} 必须是映射`);
  }
  const budget = { count: 0 };
  const normalized = validateSourceJson(value, label, 0, budget) as Record<string, unknown>;
  const encoded = new TextEncoder().encode(stableJson(normalized));
  if (encoded.byteLength > SOURCE_MAX_BYTES) {
    throw new DownloadError(`${label} 超过 ${SOURCE_MAX_BYTES} 字节限制`);
  }
  return Object.freeze(normalized);
}

function validateSourceJson(
  value: unknown,
  label: string,
  depth: number,
  budget: { count: number },
): unknown {
  if (depth > SOURCE_MAX_DEPTH) throw new DownloadError(`${label} 超过嵌套深度限制`);
  if (++budget.count > SOURCE_MAX_ITEMS) throw new DownloadError(`${label} 超过项目数量限制`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DownloadError(`${label} 不允许 NaN/Infinity`);
    return value;
  }
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > SOURCE_MAX_STRING) {
      throw new DownloadError(`${label} 字符串超过长度限制`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => validateSourceJson(item, label, depth + 1, budget));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || Object.hasOwn(result, key)) {
        throw new DownloadError(`${label} 的键必须是唯一字符串`);
      }
      result[key] = validateSourceJson(
        (value as Record<string, unknown>)[key],
        label,
        depth + 1,
        budget,
      );
    }
    return result;
  }
  throw new DownloadError(`${label} 包含非 JSON 类型`);
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
  if (encoded === undefined) throw new DownloadError("值不是合法 JSON");
  return encoded;
}

function releaseCodec(provider: string, value: DownloadProvider): ReleaseSourceCodec {
  const candidate = value as Partial<ReleaseSourceCodec>;
  if (
    typeof candidate.releaseSourceSchema !== "string" ||
    typeof candidate.exportReleaseSource !== "function" ||
    typeof candidate.importReleaseSource !== "function"
  ) {
    throw new DownloadError(
      `下载提供方 ${provider} 未实现版本化 ReleaseSourceCodec，不能用于发布历史`,
    );
  }
  return candidate as ReleaseSourceCodec;
}

function codecSchema(provider: string, codec: ReleaseSourceCodec): string {
  const schema = codec.releaseSourceSchema;
  if (!SOURCE_SCHEMA_RE.test(schema)) {
    throw new DownloadError(`下载提供方 ${provider} 的发布 source schema 不合法`);
  }
  return schema;
}

function importWithCodec(
  provider: string,
  codec: ReleaseSourceCodec,
  payload: JsonSource,
): JsonSource {
  try {
    return validatedSourceMapping(codec.importReleaseSource(payload), "导入的发布 source");
  } catch (cause) {
    if (cause instanceof DownloadError) throw cause;
    throw new DownloadError(`下载提供方 ${provider} 导入发布 source 失败`, { cause });
  }
}

async function runFilehubPull(
  target: string,
  destination: string,
  signal?: AbortSignal,
): Promise<number> {
  throwIfFilehubAborted(signal);
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("filehub", {
      args: ["pull", target, destination],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) throw filehubInstallError(cause);
    throw new DownloadError("无法启动 filehub 客户端", { cause });
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  const abortPromise = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  signal?.addEventListener("abort", abort, { once: true });
  // AbortSignal 不会为迟注册 listener 重放事件；注册后必须显式补查 spawn 窗口。
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort("timeout"), FILEHUB_PROCESS_TIMEOUT_MS);
  try {
    const status = await Promise.race([child.status, abortPromise]);
    throwIfFilehubAborted(signal);
    return status.code;
  } catch (cause) {
    let terminationCause: unknown;
    try {
      await terminateAndReap(child);
    } catch (terminateCause) {
      terminationCause = terminateCause;
    }
    const combinedCause = terminationCause === undefined
      ? cause
      : new AggregateError([cause, terminationCause], "filehub 取消后的子进程清理失败");
    if (signal?.aborted) throw new DownloadError("filehub 下载已取消", { cause: combinedCause });
    if (terminationCause !== undefined) {
      throw new DownloadError("filehub 下载超时且无法确认子进程已退出", {
        cause: combinedCause,
      });
    }
    throw new DownloadError(`filehub 下载超过总期限 ${FILEHUB_PROCESS_TIMEOUT_MS / 1000} 秒`, {
      cause: combinedCause,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function throwIfFilehubAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DownloadError("filehub 下载已取消", { cause: signal.reason });
  }
}

function throwIfRegistryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DownloadError("下载已取消", { cause: signal.reason });
  }
}

async function terminateAndReap(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch { /* process may already be gone */ }
  if (await settlesWithin(child.status, FILEHUB_TERMINATE_TIMEOUT_MS)) return;
  try {
    child.kill("SIGKILL");
  } catch { /* process may already be gone */ }
  if (!(await settlesWithin(child.status, FILEHUB_TERMINATE_TIMEOUT_MS))) {
    throw new DownloadError("filehub 子进程强制终止后仍未退出");
  }
}

async function settlesWithin(value: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return await Promise.race([
    value.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

function filehubInstallError(cause?: unknown): DownloadError {
  return new DownloadError(
    "未找到 filehub 客户端命令，请先安装 filehub。" +
      "Linux/macOS 请使用官方 install-cli.sh，Windows 请使用官方 install-cli.ps1；" +
      `安装说明: ${FILEHUB_INSTALL_URL}`,
    { cause },
  );
}

async function fetchWithTimeout(
  url: string,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort("timeout"), milliseconds);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "accept-encoding": "identity", "user-agent": "sfo-deploy/0.1" },
      signal: controller.signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw new DownloadError("HTTP 下载已取消", { cause });
    if (controller.signal.aborted) throw new DownloadError("HTTP 下载超时", { cause });
    throw new DownloadError("HTTP 下载失败", { cause });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw new DownloadError("HTTP 下载已取消");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new DownloadError("HTTP 下载超时")), milliseconds);
        if (signal) {
          abortListener = () => reject(new DownloadError("HTTP 下载已取消"));
          signal.addEventListener("abort", abortListener, { once: true });
        }
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new DownloadError(`HTTP Content-Length 不合法: ${JSON.stringify(value)}`);
  }
  return Number(value);
}

async function verifyArtifact(artifact: VerifiedArtifact, request: DownloadRequest): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(artifact.path);
  } catch (cause) {
    throw new DownloadError(`下载提供方返回的工件不可读: ${artifact.path}`, { cause });
  }
  if (!info.isFile || info.isSymlink) {
    throw new DownloadError(`下载提供方返回的工件不是普通文件: ${artifact.path}`);
  }
  if (info.size > request.maxBytes) {
    throw new DownloadError(
      `下载工件超过最大字节数: received=${info.size} max=${request.maxBytes}`,
    );
  }
  const digest = createHash(request.hashAlgorithm.toLowerCase());
  const file = await Deno.open(artifact.path, { read: true }).catch((cause) => {
    throw new DownloadError(`无法校验下载工件 ${artifact.path}`, { cause });
  });
  let size = 0;
  const buffer = new Uint8Array(request.chunkSize);
  try {
    while (true) {
      const count = await file.read(buffer);
      if (count === null) break;
      size += count;
      if (size > request.maxBytes) {
        throw new DownloadError(`下载工件超过最大字节数: received=${size} max=${request.maxBytes}`);
      }
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    file.close();
  }
  const actual = digest.digest("hex").toLowerCase();
  if (!constantTimeEqual(actual, request.expectedHash.toLowerCase())) {
    throw new DownloadError(
      `下载工件哈希不匹配: expected=${request.expectedHash.toLowerCase()} actual=${actual}`,
    );
  }
  artifact.hashAlgorithm = request.hashAlgorithm.toLowerCase();
  artifact.hashValue = actual;
  artifact.size = size;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

async function requireDestinationBoundary(destination: string): Promise<void> {
  const parent = dirname(destination);
  try {
    const info = await Deno.stat(parent);
    if (!info.isDirectory) throw new DownloadError(`下载目标目录不存在: ${parent}`);
  } catch (cause) {
    if (cause instanceof DownloadError) throw cause;
    throw new DownloadError(`下载目标目录不存在: ${parent}`, { cause });
  }
  if (await pathExists(destination)) {
    throw new DownloadError(`下载目标已存在，拒绝覆盖: ${destination}`);
  }
}

async function makeTemporaryFile(
  directory: string,
  prefix: string,
  suffix: string,
): Promise<string> {
  const path = await Deno.makeTempFile({ dir: directory, prefix, suffix });
  await Deno.chmod(path, 0o600);
  return path;
}

async function publishWithoutReplace(source: string, destination: string): Promise<void> {
  try {
    await Deno.link(source, destination);
  } catch (cause) {
    if (cause instanceof Deno.errors.AlreadyExists) {
      throw new DownloadError(`下载目标已存在，拒绝覆盖: ${destination}`, { cause });
    }
    throw new DownloadError("无法原子发布下载工件", { cause });
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile && !info.isSymlink;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}

async function cleanupPath(path: string, primary: unknown): Promise<void> {
  try {
    await removeIfPresent(path);
  } catch (cause) {
    if (primary instanceof Error) primary.message += ` (清理失败: ${String(cause)})`;
  }
}

async function cleanupDirectory(path: string, primary: unknown): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound) && primary instanceof Error) {
      primary.message += ` (filehub 私有暂存目录清理失败)`;
    }
  }
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) throw new DownloadError(`下载目标不是安全普通文件: ${path}`);
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

async function cleanupOwnedPath(
  path: string,
  identity: FileIdentity,
  primary: unknown,
): Promise<void> {
  try {
    const current = await Deno.lstat(path);
    if (
      !current.isFile || current.isSymlink || current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      if (primary instanceof Error) primary.message += " (下载目标已被替换，拒绝清理)";
      return;
    }
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound) && primary instanceof Error) {
      primary.message += " (下载目标清理失败)";
    }
  }
}

export const __internal = Object.freeze({
  parseHttpUrl,
  sourceTarget,
  releaseHttpUrl,
  releaseFilehubTarget,
  runFilehubPull,
  terminateAndReap,
  verifyArtifact,
});
