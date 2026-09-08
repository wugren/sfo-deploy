/** 项目敏感输入绑定、文件秘密投递准备与纯文本脱敏。 */

import { dirname, isAbsolute, join, resolve } from "jsr:@std/path@1.1.6";
import { parse } from "jsr:@std/yaml@1.2.0";
import { ConfigurationError, PreflightError } from "./errors.ts";
import type {
  ClusterConfig,
  ManagedConfigValueType,
  SecretDeclaration,
  SecretKind,
} from "./types.ts";
import { freezeArray, freezeRecord, immutableMap } from "./types.ts";

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const SECRET_SOURCE_FILENAME = "secrets.yaml";
const SECRET_KIND_SET = new Set<string>(["value", "file"]);
const STAGE_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type ConfigSecretProvider = string | (() => string | Promise<string>);

export interface ProjectBindingsOptions {
  readonly fileSecrets?: Readonly<Record<string, string | URL>> | ReadonlyMap<string, string | URL>;
  readonly configSecrets?:
    | Readonly<Record<string, ConfigSecretProvider>>
    | ReadonlyMap<string, ConfigSecretProvider>;
}

function entries<T>(
  values: Readonly<Record<string, T>> | ReadonlyMap<string, T> | undefined,
): Iterable<readonly [string, T]> {
  if (!values) return [];
  if (
    Symbol.iterator in values && "entries" in values &&
    typeof values.entries === "function"
  ) {
    return values.entries();
  }
  return Object.entries(values as Readonly<Record<string, T>>);
}

function pathText(value: string | URL, label: string): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") throw new ConfigurationError(`${label} 必须是本地文件路径`);
    return decodeURIComponent(value.pathname);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`${label} 必须是本地文件路径`);
  }
  if (value === "~" || value.startsWith("~/")) {
    let home: string | undefined;
    try {
      home = Deno.env.get(Deno.build.os === "windows" ? "USERPROFILE" : "HOME");
    } catch (cause) {
      throw new ConfigurationError(`${label} 无法展开用户主目录`, { cause });
    }
    if (!home) throw new ConfigurationError(`${label} 无法展开用户主目录`);
    return value === "~" ? home : join(home, value.slice(2));
  }
  return value;
}

export function validateSecretName(name: unknown): string {
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    let rendered: string;
    try {
      rendered = JSON.stringify(name);
    } catch {
      rendered = String(name);
    }
    throw new ConfigurationError(`敏感输入名称不合法: ${rendered}`);
  }
  return name;
}

/** 校验并归一秘密类型（值密钥或文件密钥）。 */
export function validateSecretKind(value: unknown): SecretKind {
  if (typeof value !== "string" || !SECRET_KIND_SET.has(value)) {
    throw new ConfigurationError(`敏感输入类型只支持 value 或 file: ${JSON.stringify(value)}`);
  }
  return value as SecretKind;
}

/** 集群本地秘密来源固定位于集群配置目录内。 */
export function clusterSecretSourcePath(clusterDirectory: string): string {
  return join(clusterDirectory, SECRET_SOURCE_FILENAME);
}

async function requireSecretSourceFile(path: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      throw new ConfigurationError(`缺少集群秘密来源 ${path}`);
    }
    throw new ConfigurationError(`无法读取集群秘密来源 ${path}`);
  }
  if (!info.isFile || info.isSymlink) {
    throw new ConfigurationError(`集群秘密来源必须是普通文件: ${path}`);
  }
  if (
    Deno.build.os !== "windows" && typeof info.mode === "number" &&
    (info.mode & 0o777) !== 0o600
  ) {
    throw new ConfigurationError(`集群秘密来源权限必须是 0600: ${path}`);
  }
}

/** 读取集群本地 secrets.yaml 并按 cluster.yaml 的 kind 分派来源。 */
export async function loadClusterSecretSource(
  cluster: ClusterConfig,
  clusterDirectory: string,
): Promise<ProjectBindings> {
  const sourcePath = clusterSecretSourcePath(clusterDirectory);
  await requireSecretSourceFile(sourcePath);
  let text: string;
  try {
    text = await Deno.readTextFile(sourcePath);
  } catch (cause) {
    throw new ConfigurationError(`无法读取集群秘密来源 ${sourcePath}`, { cause });
  }
  let value: unknown;
  try {
    value = parse(text, { allowDuplicateKeys: false });
  } catch {
    throw new ConfigurationError(`集群秘密来源不是合法 YAML: ${sourcePath}`);
  }
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`集群秘密来源顶层必须是映射: ${sourcePath}`);
  }
  const rawEntries = Object.entries(value as Record<string, unknown>);
  const sourceDirectory = dirname(sourcePath);
  const sourceDirectoryReal = await Deno.realPath(sourceDirectory);
  const configSecrets = new Map<string, string>();
  const fileSecrets = new Map<string, string>();
  const missing = [...cluster.secrets.keys()].filter((name) => !(name in (value as object)));
  if (missing.length > 0) {
    throw new ConfigurationError(`集群秘密来源缺少密钥: ${missing.join(", ")}`);
  }
  for (const [rawName, rawValue] of rawEntries) {
    const name = validateSecretName(rawName);
    const declaration = cluster.secrets.get(name);
    if (declaration === undefined) {
      throw new ConfigurationError(`集群秘密来源包含未声明密钥: ${name}`);
    }
    if (typeof rawValue !== "string" || rawValue.length === 0) {
      throw new ConfigurationError(`集群秘密来源中 ${name} 必须是非空字符串`);
    }
    if (declaration.kind === "file") {
      if (isAbsolute(rawValue) || rawValue.includes("\\")) {
        throw new ConfigurationError(`文件密钥 ${name} 必须是相对 POSIX 路径`);
      }
      if (rawValue.split("/").includes("..")) {
        throw new ConfigurationError(`文件密钥 ${name} 路径不允许 ..`);
      }
      const candidate = resolve(sourceDirectory, rawValue);
      let realPath: string;
      try {
        realPath = await Deno.realPath(candidate);
      } catch (cause) {
        throw new PreflightError(`文件密钥 ${name} 来源不存在或不可访问`, { cause });
      }
      if (realPath === sourceDirectoryReal || !realPath.startsWith(`${sourceDirectoryReal}/`)) {
        throw new PreflightError(`文件密钥 ${name} 路径不允许离开集群目录`);
      }
      fileSecrets.set(name, realPath);
    } else {
      validateSecretValueType(rawValue, declaration.valueType, name);
      configSecrets.set(name, rawValue);
    }
  }
  return new ProjectBindings({ configSecrets, fileSecrets });
}

function validateSecretValueType(
  value: string,
  type: ManagedConfigValueType,
  name: string,
): void {
  if (type === "string") return;
  if (type === "boolean" && (value === "true" || value === "false")) return;
  if (
    type === "integer" && /^-?(?:0|[1-9][0-9]*)$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  ) return;
  if (
    type === "number" &&
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value) &&
    Number.isFinite(Number(value))
  ) return;
  throw new ConfigurationError(`密钥 ${name} 的值不符合 ${type} 类型`);
}

function validateProvider(name: string, provider: unknown): ConfigSecretProvider {
  if (typeof provider === "string") return provider;
  if (typeof provider !== "function") {
    throw new ConfigurationError(`配置密钥 ${name} 必须是字符串或零参数函数`);
  }
  if (provider.length > 0) {
    throw new ConfigurationError(`配置密钥 ${name} 的延迟函数必须可用零参数调用`);
  }
  return provider as () => string | Promise<string>;
}

/** 每个项目实例拥有一份构造时复制、之后只读的秘密绑定。 */
export class ProjectBindings {
  readonly fileSecrets: ReadonlyMap<string, string>;
  readonly configSecrets: ReadonlyMap<string, ConfigSecretProvider>;

  constructor(options: ProjectBindingsOptions = {}) {
    const fileValues = new Map<string, string>();
    for (const [rawName, rawPath] of entries(options.fileSecrets)) {
      const name = validateSecretName(rawName);
      fileValues.set(name, resolve(pathText(rawPath, `文件私钥 ${name} 的来源`)));
    }
    const configValues = new Map<string, ConfigSecretProvider>();
    for (const [rawName, provider] of entries(options.configSecrets)) {
      const name = validateSecretName(rawName);
      configValues.set(name, validateProvider(name, provider));
    }
    this.fileSecrets = immutableMap(fileValues);
    this.configSecrets = immutableMap(configValues);
  }

  /** 只解析当前脚本声明的配置秘密，不接触未声明绑定。 */
  async selectConfigSecrets(names: Iterable<string>): Promise<Readonly<Record<string, string>>> {
    const selected: Record<string, string> = {};
    for (const rawName of names) {
      const name = validateSecretName(rawName);
      if (Object.hasOwn(selected, name)) {
        throw new ConfigurationError(`配置密钥选择包含重复名称: ${name}`);
      }
      const provider = this.configSecrets.get(name);
      if (provider === undefined) throw new PreflightError(`项目未绑定配置密钥: ${name}`);
      let value: unknown;
      try {
        value = typeof provider === "function" ? await provider() : provider;
      } catch (cause) {
        throw new PreflightError(`读取配置密钥 ${name} 失败`, { cause });
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new PreflightError(`配置密钥 ${name} 必须解析为非空字符串`);
      }
      selected[name] = value;
    }
    return freezeRecord(selected);
  }

  /** 设计接口：解析一个命名配置秘密。 */
  async secret(name: string): Promise<string> {
    return (await this.selectConfigSecrets([name]))[name];
  }

  /** 解析一个已绑定、当前存在且可读的普通文件。 */
  async resolveFileSecret(rawName: string): Promise<string> {
    const name = validateSecretName(rawName);
    const source = this.fileSecrets.get(name);
    if (!source) throw new PreflightError(`项目未绑定文件私钥: ${name}`);
    let resolved: string;
    try {
      resolved = await Deno.realPath(source);
      const info = await Deno.stat(resolved);
      if (!info.isFile) throw new PreflightError(`文件私钥 ${name} 的来源不是可读普通文件`);
      const file = await Deno.open(resolved, { read: true });
      file.close();
    } catch (cause) {
      if (cause instanceof PreflightError) throw cause;
      throw new PreflightError(`文件私钥 ${name} 的来源不存在或不可访问`, { cause });
    }
    return resolved;
  }

  /** 设计接口：只在调用者明确请求时读取文件秘密内容。 */
  async fileSecret(name: string): Promise<Uint8Array> {
    const path = await this.resolveFileSecret(name);
    try {
      return await Deno.readFile(path);
    } catch (cause) {
      throw new PreflightError(`读取文件私钥 ${validateSecretName(name)} 失败`, { cause });
    }
  }
}

export interface ResolvedValueSecret {
  readonly name: string;
  readonly kind: "value";
  readonly value: string;
}

export interface ResolvedFileSecret {
  readonly name: string;
  readonly kind: "file";
  readonly source: string;
}

export type ResolvedSecret = ResolvedValueSecret | ResolvedFileSecret;

/** 返回声明放置到指定机器的全部密钥名（按声明的 kind 校验后排序）。 */
export function declaredSecretNamesForMachine(
  declarations: ReadonlyMap<string, SecretDeclaration>,
  machineName: string,
): readonly string[] {
  const names: string[] = [];
  for (const declaration of declarations.values()) {
    const name = validateSecretName(declaration.name);
    if (declaration.kind !== "value" && declaration.kind !== "file") {
      throw new PreflightError(`密钥 ${name} 的类型不合法`);
    }
    if (declaration.machines.includes(machineName)) names.push(name);
  }
  return freezeArray(names.sort());
}

/** 在首次 SSH 连接前解析某台机器上全部放置密钥的来源。 */
export async function resolveSecretsForMachine(
  declarations: ReadonlyMap<string, SecretDeclaration>,
  machineName: string,
  bindings: ProjectBindings,
): Promise<readonly ResolvedSecret[]> {
  const names = declaredSecretNamesForMachine(declarations, machineName);
  const values = await bindings.selectConfigSecrets(
    names.filter((name) => declarations.get(name)!.kind === "value"),
  );
  const resolved: ResolvedSecret[] = [];
  for (const name of names) {
    const declaration = declarations.get(name)!;
    if (declaration.kind === "value") {
      const value = values[name];
      if (typeof value !== "string" || value.length === 0) {
        throw new PreflightError(`配置密钥 ${name} 必须解析为非空字符串`);
      }
      resolved.push(Object.freeze({ name, kind: "value" as const, value }));
    } else {
      resolved.push(Object.freeze({
        name,
        kind: "file" as const,
        source: await bindings.resolveFileSecret(name),
      }));
    }
  }
  return freezeArray(resolved);
}

export const DEFAULT_SECRETS_DIR = "~/.sfo-deploy/secrets/";

/** 一台机器上待部署/校验/移除的密钥文件（本地固定暂存源 + sha256）。 */
export interface SecretDeploymentFile {
  readonly name: string;
  readonly kind: SecretKind;
  readonly source: string;
  readonly sha256: string;
}

async function sha256Bytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 在首次 SSH 前固定全部放置密钥的本地 0600 暂存与哈希；值不含尾随换行。 */
export async function prepareSecretDeployments(
  declarations: ReadonlyMap<string, SecretDeclaration>,
  machineName: string,
  bindings: ProjectBindings,
  directory: string,
  options: { readonly prefix: string },
): Promise<readonly SecretDeploymentFile[]> {
  if (!STAGE_PREFIX_RE.test(options.prefix) || options.prefix === "." || options.prefix === "..") {
    throw new PreflightError(`密钥暂存前缀不合法: ${JSON.stringify(options.prefix)}`);
  }
  const stagingDirectory = resolve(directory);
  const info = await Deno.stat(stagingDirectory);
  if (!info.isDirectory) throw new PreflightError("密钥暂存路径不是目录");
  const resolved = await resolveSecretsForMachine(declarations, machineName, bindings);
  const files: SecretDeploymentFile[] = [];
  for (let index = 0; index < resolved.length; index++) {
    const secret = resolved[index];
    const name = validateSecretName(secret.name);
    const staged = join(stagingDirectory, `${options.prefix}-${index}`);
    if (secret.kind === "value") {
      const content = new TextEncoder().encode(secret.value);
      const file = await Deno.open(staged, { write: true, createNew: true, mode: 0o600 });
      try {
        await writeAllBytes(file, content);
        await file.sync();
      } finally {
        file.close();
      }
      await Deno.chmod(staged, 0o600);
      files.push(Object.freeze({
        name,
        kind: secret.kind,
        source: staged,
        sha256: await sha256Bytes(content),
      }));
    } else {
      await copyPrivateFile(secret.source, staged, name);
      files.push(Object.freeze({
        name,
        kind: secret.kind,
        source: staged,
        sha256: await sha256Bytes(await Deno.readFile(staged)),
      }));
    }
  }
  return freezeArray(files);
}

async function writeAllBytes(file: Deno.FsFile, content: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < content.length) offset += await file.write(content.subarray(offset));
}

function sameFile(before: Deno.FileInfo, after: Deno.FileInfo): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtime?.getTime() === after.mtime?.getTime();
}

async function removeStagedSecret(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function copyPrivateFile(source: string, destination: string, name: string): Promise<void> {
  let input: Deno.FsFile | undefined;
  let output: Deno.FsFile | undefined;
  try {
    const linkInfo = await Deno.lstat(source);
    if (!linkInfo.isFile || linkInfo.isSymlink) {
      throw new PreflightError(`文件私钥 ${name} 的来源不是普通文件`);
    }
    input = await Deno.open(source, { read: true });
    const before = await input.stat();
    if (!sameFile(linkInfo, before)) {
      throw new PreflightError(`文件私钥 ${name} 在暂存前发生变化`);
    }
    output = await Deno.open(destination, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      const count = await input.read(buffer);
      if (count === null) break;
      let offset = 0;
      while (offset < count) offset += await output.write(buffer.subarray(offset, count));
    }
    await output.sync();
    const after = await input.stat();
    if (!sameFile(before, after)) {
      throw new PreflightError(`文件私钥 ${name} 在暂存期间发生变化`);
    }
    await Deno.chmod(destination, 0o600);
  } catch (cause) {
    // Windows 不能删除仍被打开的文件；先关闭句柄，再清理部分秘密。
    output?.close();
    output = undefined;
    input?.close();
    input = undefined;
    try {
      await removeStagedSecret(destination);
    } catch {
      // 清理错误不能泄漏秘密路径内容，也不应遮蔽主错误。
    }
    if (cause instanceof PreflightError) throw cause;
    throw new PreflightError(`暂存文件私钥 ${name} 失败`, { cause });
  } finally {
    output?.close();
    input?.close();
  }
}

export async function validateSshPrivateKey(path?: string | URL): Promise<string | undefined> {
  if (path === undefined) return undefined;
  const candidate = resolve(pathText(path, "SSH 私钥"));
  try {
    const resolved = await Deno.realPath(candidate);
    const info = await Deno.stat(resolved);
    if (!info.isFile) throw new PreflightError("SSH 私钥不是可读普通文件");
    const file = await Deno.open(resolved, { read: true });
    file.close();
    return resolved;
  } catch (cause) {
    if (cause instanceof PreflightError) throw cause;
    throw new PreflightError("SSH 私钥不存在或不可访问", { cause });
  }
}

/** 对已解析秘密执行确定的最长优先纯文本替换。 */
export class Redactor {
  readonly #values: readonly string[];

  constructor(values: Iterable<string> = []) {
    const unique = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string") throw new TypeError("脱敏值必须是字符串");
      if (value.length > 0) unique.add(value);
    }
    this.#values = freezeArray(
      [...unique].sort((left, right) => right.length - left.length || left.localeCompare(right)),
    );
  }

  static fromMapping(
    values: Readonly<Record<string, string>> | ReadonlyMap<string, string>,
  ): Redactor {
    return new Redactor(
      "values" in values && typeof values.values === "function"
        ? values.values()
        : Object.values(values),
    );
  }

  redact(text: string): string {
    if (typeof text !== "string") throw new TypeError("待脱敏内容必须是字符串");
    for (const value of this.#values) text = text.split(value).join("[REDACTED]");
    return text;
  }
}
