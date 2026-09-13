/** 严格加载一个自包含的 sfo-deploy 集群目录。 */

import { parse } from "jsr:@std/yaml@1.2.0";
import { extname, isAbsolute, join, relative, resolve } from "jsr:@std/path@1.1.6";
import * as posix from "jsr:@std/path@1.1.6/posix";
import { ConfigurationError } from "./errors.ts";
import {
  collectManagedSecretPlaceholders,
  parseManagedStructured,
  validateManagedPlainText,
} from "./config_generation.ts";
import type {
  AppConfigKind,
  AppDefinition,
  AppManagementDefinition,
  AppManagerDefinition,
  AppScriptManagement,
  AppServiceManagement,
  ClusterConfig,
  ConfigTemplate as _ConfigTemplate,
  DeploymentDefinition,
  EnvironmentDefinition,
  EnvironmentInstallDefinition,
  EnvironmentInstallKind,
  EnvironmentInstance,
  EnvironmentManagerDefinition,
  EnvironmentPackageInstall,
  EnvironmentPackageManagerKind,
  EnvironmentScriptInstall,
  EnvironmentScriptManager,
  EnvironmentServiceManagerKind,
  EnvironmentServiceTool,
  EnvironmentSystemManager,
  Machine,
  ManagedConfigChangeAction,
  ManagedConfigFile,
  ManagedConfigFormat,
  ManagedConfigPathSegment,
  ManagedConfigTargetRoot,
  ManagedConfigValidator,
  ManagedConfigValueType,
  ManagedConfigVariableBinding,
  ManagedSecretReference,
  PackageSpec,
  ScriptDefinition,
  ScriptInvocation,
  ScriptPermissions,
  SecretDeclaration,
  SecretKind,
  SystemdDeployAction,
  SystemdRestartPolicy,
  SystemdUnitConfig,
} from "./types.ts";
import { freezeArray, immutableMap } from "./types.ts";

export const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
export const SECRET_RE = /^[A-Z][A-Z0-9_]*$/;
const SECRET_KINDS = new Set<string>(["value", "file"]);
export const SCRIPT_ACTIONS = Object.freeze(
  [
    "check",
    "install",
    "configure",
    "deploy",
    "start",
    "stop",
    "restart",
  ] as const,
);

const SCRIPT_ACTION_SET = new Set<string>(SCRIPT_ACTIONS);
const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const HASH_DIGEST_SIZES: Readonly<Record<string, number>> = Object.freeze({
  md5: 16,
  "md5-sha1": 36,
  ripemd160: 20,
  sha1: 20,
  sha224: 28,
  sha256: 32,
  sha384: 48,
  sha512: 64,
  sha512_224: 28,
  sha512_256: 32,
  sha3_224: 28,
  sha3_256: 32,
  sha3_384: 48,
  sha3_512: 64,
  blake2s: 32,
  blake2b: 64,
  sm3: 32,
});

type StringRecord = Record<string, unknown>;
type ClusterSchemaVersion = 2;
type AppSchemaVersion = 1;

const MANAGED_CONFIG_FORMATS = new Set<string>(["yaml", "json", "toml", "ini", "nginx"]);
const MANAGED_CONFIG_VALUE_TYPES = new Set<string>([
  "string",
  "integer",
  "number",
  "boolean",
]);
const MANAGED_CHANGE_ACTIONS = new Set<string>(["none", "reload", "restart"]);
const SYSTEMD_DEPLOY_ACTIONS = new Set<string>(["none", "start", "reload", "restart"]);
const SYSTEMD_RESTART_POLICIES = new Set<string>([
  "no",
  "on-success",
  "on-failure",
  "on-abnormal",
  "on-watchdog",
  "on-abort",
  "always",
]);
const CONFIG_VARIABLE_RE = /^[A-Z][A-Z0-9_]*$/;
const ACCOUNT_RE = /^[a-z_][a-z0-9_-]{0,31}\$?$/;
const SYSTEMD_UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,254}\.service$/;
const PACKAGE_MANAGER_RE = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const ENVIRONMENT_SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/;
const CANDIDATE_ARG = "{candidate}";
const DEFAULT_MANAGED_TIMEOUT_MS = 30_000;

interface AppVersionEntry {
  readonly version: string;
  readonly package: PackageSpec;
}

interface LoadedEnvironments {
  readonly definitions: Map<string, EnvironmentDefinition>;
  readonly instances: Map<string, readonly EnvironmentInstance[]>;
}

interface LoadedEnvironment {
  readonly name: string;
  readonly directory: string;
  readonly scripts: ScriptDefinition;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly package?: PackageSpec;
  readonly requiresPrivilege: boolean;
  readonly version: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly dependsOn: readonly string[];
  readonly install?: EnvironmentInstallDefinition;
  readonly manager?: EnvironmentManagerDefinition;
}

function repr(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is StringRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mapping(value: unknown, label: string): StringRecord {
  if (!isRecord(value)) {
    throw new ConfigurationError(`${label} 必须是字符串键映射`);
  }
  return value;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${label} 必须是列表`);
  }
  return value;
}

function fields(
  data: StringRecord,
  allowed: Iterable<string>,
  required: Iterable<string>,
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const keys = new Set(Object.keys(data));
  const unknown = [...keys].filter((key) => !allowedSet.has(key)).sort();
  const missing = [...required].filter((key) => !keys.has(key)).sort();
  if (unknown.length > 0) {
    throw new ConfigurationError(`${label} 包含未知字段: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new ConfigurationError(`${label} 缺少字段: ${missing.join(", ")}`);
  }
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw new ConfigurationError(`${label} 不是合法名称: ${repr(value)}`);
  }
  return value;
}

function stringValue(value: unknown, label: string, nonempty = true): string {
  if (typeof value !== "string" || (nonempty && value.trim().length === 0)) {
    throw new ConfigurationError(`${label} 必须是字符串`);
  }
  return value.trim();
}

function version(data: StringRecord, label: string): void {
  if (data.schema_version !== 1) {
    throw new ConfigurationError(`${label}.schema_version 只支持 1`);
  }
}

function clusterSchemaVersion(data: StringRecord): ClusterSchemaVersion {
  if (data.schema_version !== 2) {
    throw new ConfigurationError(
      "cluster.yaml.schema_version 只支持 2；v1 每机环境布局已移除，请改用共享定义 + environments 映射",
    );
  }
  return 2;
}

function appSchemaVersion(data: StringRecord, label: string): AppSchemaVersion {
  if (data.schema_version !== 1) {
    throw new ConfigurationError(`${label}.schema_version 只支持 1`);
  }
  return data.schema_version;
}

/** 远端脚本使用的绝对 POSIX 路径；拒绝相对路径、`..` 段与非法字符。 */
function remoteAbsolutePath(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!text.startsWith("/")) {
    throw new ConfigurationError(`${label} 必须是远端绝对 POSIX 路径`);
  }
  if (text.split("/").includes("..")) {
    throw new ConfigurationError(`${label} 不允许包含 .. 段`);
  }
  if (/[\0\r\n\\]/.test(text)) {
    throw new ConfigurationError(`${label} 包含非法字符`);
  }
  return text;
}

function managedTargetPath(value: unknown, label: string): string {
  const text = remoteAbsolutePath(value, label);
  if (
    text === "/" || text.startsWith("//") || posix.normalize(text) !== text ||
    text.endsWith("/")
  ) {
    throw new ConfigurationError(`${label} 必须是规范的远端文件绝对路径`);
  }
  if (["/dev", "/proc", "/sys"].some((root) => text === root || text.startsWith(`${root}/`))) {
    throw new ConfigurationError(`${label} 不允许写入内核或设备文件系统: ${text}`);
  }
  return text;
}

const MANAGED_TARGET_VARIABLE_PREFIXES = {
  install: "${INSTALL_DIRECTORY}/",
  current: "${CURRENT_VERSION_DIRECTORY}/",
  latest: "${LATEST_DIRECTORY}/",
} as const satisfies Record<Exclude<ManagedConfigTargetRoot, "absolute">, string>;

function managedConfigTarget(
  value: unknown,
  installDirectory: string | undefined,
  label: string,
): { readonly target: string; readonly targetRoot: ManagedConfigTargetRoot } {
  const text = stringValue(value, label);
  const variableBareNames = Object.values(MANAGED_TARGET_VARIABLE_PREFIXES)
    .map((prefix) => prefix.slice(0, -1));
  const variableCount = variableBareNames.reduce(
    (count, variable) => count + text.split(variable).length - 1,
    0,
  );
  if (variableCount === 0) {
    return { target: managedTargetPath(text, label), targetRoot: "absolute" };
  }
  if (variableCount > 1) {
    throw new ConfigurationError(
      `${label} 只能包含一个目录变量`,
    );
  }
  const match = Object.entries(MANAGED_TARGET_VARIABLE_PREFIXES).find(([, prefix]) =>
    text.startsWith(prefix)
  );
  if (match === undefined) {
    throw new ConfigurationError(
      `${label} 只支持以 \${INSTALL_DIRECTORY}/、\${CURRENT_VERSION_DIRECTORY}/ 或 \${LATEST_DIRECTORY}/ 开头`,
    );
  }
  const [targetRoot, variablePrefix] = match as [
    Exclude<ManagedConfigTargetRoot, "absolute">,
    string,
  ];
  if (installDirectory === undefined) {
    throw new ConfigurationError(
      `${label} 使用安装目录变量，但 App 缺少 install_directory`,
    );
  }
  const variableName = variableBareNames.find((variable) => variablePrefix.startsWith(variable))!;
  const relative = text.slice(variablePrefix.length);
  if (
    relative === "" || relative.startsWith("/") || relative.endsWith("/") ||
    relative.includes("\\") ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ConfigurationError(
      `${label} 的 \${${variableName.slice(2, -1)}} 后必须是规范相对路径`,
    );
  }
  const root = targetRoot === "install"
    ? posix.normalize(installDirectory)
    : `${posix.normalize(installDirectory)}/latest`;
  return {
    target: managedTargetPath(`${root}/${relative}`, label),
    targetRoot,
  };
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  const text = stringValue(value, label);
  if (!allowed.has(text)) {
    throw new ConfigurationError(`${label} 使用不支持的值: ${repr(text)}`);
  }
  return text as T;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum
  ) {
    throw new ConfigurationError(`${label} 必须是 ${minimum}..${maximum} 的整数`);
  }
  return value;
}

function timeoutMs(value: unknown, label: string): number {
  return boundedInteger(value ?? DEFAULT_MANAGED_TIMEOUT_MS, label, 1, 3_600_000);
}

function accountName(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!ACCOUNT_RE.test(text)) {
    throw new ConfigurationError(`${label} 不是合法的 Linux 帐户名称`);
  }
  return text;
}

function appRunAs(value: unknown, label: string): string {
  const text = accountName(value, label);
  if (text === "root") {
    throw new ConfigurationError(`${label} 必须是非 root Linux 用户`);
  }
  return text;
}

function managedFileMode(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0?[0-7]{3}$/.test(value)) {
    throw new ConfigurationError(`${label} 必须是三位或四位八进制字符串`);
  }
  const mode = Number.parseInt(value, 8);
  if ((mode & 0o400) === 0 || (mode & 0o133) !== 0) {
    throw new ConfigurationError(
      `${label} 必须允许 owner 读取且不能包含执行位或 group/other 写权限`,
    );
  }
  return mode;
}

function configPath(
  value: unknown,
  label: string,
): readonly ManagedConfigPathSegment[] {
  const result: ManagedConfigPathSegment[] = [];
  for (const [index, segment] of list(value, label).entries()) {
    const segmentLabel = `${label}[${index}]`;
    if (typeof segment === "number") {
      result.push(boundedInteger(segment, segmentLabel, 0, 1_000_000));
      continue;
    }
    const text = stringValue(segment, segmentLabel);
    if (
      containsAsciiControl(text) ||
      text === "__proto__" || text === "prototype" || text === "constructor"
    ) {
      throw new ConfigurationError(`${segmentLabel} 是危险或非法字段名`);
    }
    result.push(text);
  }
  if (result.length === 0) throw new ConfigurationError(`${label} 不能为空`);
  return freezeArray(result);
}

function argvArgument(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || containsAsciiControl(value)) {
    throw new ConfigurationError(`${label} 必须是无控制字符的非空字符串`);
  }
  return value;
}

/** 每机安全目录：接受 `~/` 用户目录路径或规范绝对 POSIX 路径。 */
function secretDirectory(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (text === "/" || text === "~" || text.includes("\\") || /[\0\r\n]/.test(text)) {
    throw new ConfigurationError(`${label} 是非法安全目录路径`);
  }
  if (text.startsWith("~/")) {
    const rest = text.slice(2);
    if (!rest || rest.split("/").includes("..")) {
      throw new ConfigurationError(`${label} 允许 ~/ 起始路径但不允许 .. 段`);
    }
    return text;
  }
  if (!text.startsWith("/") || text.split("/").includes("..")) {
    throw new ConfigurationError(`${label} 必须是 ~/ 起始路径或安全绝对 POSIX 路径`);
  }
  return text;
}

function secretKind(value: unknown, label: string): SecretKind {
  const text = stringValue(value, label);
  if (!SECRET_KINDS.has(text)) {
    throw new ConfigurationError(`${label} 只支持 value 或 file: ${repr(text)}`);
  }
  return text as SecretKind;
}

function secretMachines(
  value: unknown,
  label: string,
  known: ReadonlyMap<string, Machine>,
): readonly string[] {
  const raw = typeof value === "string" && value === "*"
    ? [...known.keys()].sort()
    : stringList(value, label, NAME_RE);
  if (raw.length === 0) {
    throw new ConfigurationError(`${label} 至少需要一台目标机器`);
  }
  const unknown = raw.filter((machine) => !known.has(machine)).sort();
  if (unknown.length > 0) {
    throw new ConfigurationError(`${label} 引用未知机器: ${unknown.join(", ")}`);
  }
  return raw;
}

function secretDeclarations(
  value: unknown,
  label: string,
  known: ReadonlyMap<string, Machine>,
): ReadonlyMap<string, SecretDeclaration> {
  if (value === undefined || value === null) return immutableMap([]);
  const data = mapping(value, label);
  const declarations = new Map<string, SecretDeclaration>();
  for (const [rawName, rawEntry] of Object.entries(data)) {
    const entryLabel = `${label}.${rawName}`;
    const secretName = stringValue(rawName, `${label} 密钥名`);
    if (!SECRET_RE.test(secretName)) {
      throw new ConfigurationError(`${label} 密钥名不合法: ${repr(rawName)}`);
    }
    if (declarations.has(secretName)) {
      throw new ConfigurationError(`${label} 包含重复密钥声明: ${secretName}`);
    }
    const entry = mapping(rawEntry, entryLabel);
    const kind = secretKind(entry.kind, `${entryLabel}.kind`);
    if (kind === "file") {
      fields(entry, ["kind", "machines"], ["kind", "machines"], entryLabel);
      declarations.set(
        secretName,
        Object.freeze({
          name: secretName,
          kind,
          valueType: "string" as const,
          machines: secretMachines(entry.machines, `${entryLabel}.machines`, known),
        }),
      );
      continue;
    }
    fields(entry, ["kind", "type", "machines"], ["kind", "machines"], entryLabel);
    declarations.set(
      secretName,
      Object.freeze({
        name: secretName,
        kind,
        valueType: managedValueType(entry.type, `${entryLabel}.type`),
        machines: secretMachines(entry.machines, `${entryLabel}.machines`, known),
      }),
    );
  }
  return immutableMap(declarations);
}

async function loadYaml(path: string): Promise<StringRecord> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    throw new ConfigurationError(`无法读取 YAML ${path}: ${String(cause)}`, { cause });
  }
  let value: unknown;
  try {
    // @std/yaml 默认拒绝重复键；显式写出选项以固定安全语义。
    value = parse(text, { allowDuplicateKeys: false });
  } catch (cause) {
    throw new ConfigurationError(`无法读取 YAML ${path}: ${String(cause)}`, { cause });
  }
  if (!isRecord(value)) {
    throw new ConfigurationError(`YAML 顶层必须是映射: ${path}`);
  }
  return value;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function contained(
  base: string,
  rawRelative: unknown,
  label: string,
  suffix?: string,
): Promise<string> {
  const text = stringValue(rawRelative, label);
  if (isAbsolute(text) || text.includes("\\") || text.split("/").includes("..")) {
    throw new ConfigurationError(`${label} 必须位于资源目录内: ${text}`);
  }
  const baseResolved = resolve(base);
  const candidate = resolve(baseResolved, text);
  const lexicalRelative = relative(baseResolved, candidate);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new ConfigurationError(`${label} 逃逸资源目录: ${text}`);
  }
  if (suffix && extname(candidate) !== suffix) {
    throw new ConfigurationError(`${label} 必须是 ${suffix} 文件: ${text}`);
  }
  try {
    const [realBase, realCandidate, info] = await Promise.all([
      Deno.realPath(baseResolved),
      Deno.realPath(candidate),
      Deno.stat(candidate),
    ]);
    const realRelative = relative(realBase, realCandidate);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`) ||
      isAbsolute(realRelative)
    ) {
      throw new ConfigurationError(`${label} 逃逸资源目录: ${text}`);
    }
    if (!info.isFile) {
      throw new ConfigurationError(`${label} 文件不存在: ${candidate}`);
    }
    return realCandidate;
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError(`${label} 文件不存在: ${candidate}`, { cause });
  }
}

function stringList(
  value: unknown,
  label: string,
  validator?: RegExp,
): readonly string[] {
  const result: string[] = [];
  for (const [index, item] of list(value, label).entries()) {
    const text = stringValue(item, `${label}[${index}]`);
    if (validator && !validator.test(text)) {
      throw new ConfigurationError(`${label}[${index}] 名称不合法: ${text}`);
    }
    if (result.includes(text)) {
      throw new ConfigurationError(`${label} 包含重复值: ${text}`);
    }
    result.push(text);
  }
  return freezeArray(result);
}

function parseIpv4(value: string): readonly number[] | undefined {
  const pieces = value.split(".");
  if (pieces.length !== 4) return undefined;
  const result: number[] = [];
  for (const piece of pieces) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(piece)) return undefined;
    const number = Number(piece);
    if (number > 255) return undefined;
    result.push(number);
  }
  return result;
}

function normalizeIp(value: string): string | undefined {
  const ipv4 = parseIpv4(value);
  if (ipv4) return `4:${ipv4.join(".")}`;
  if (!value.includes(":") || value.includes("%")) return undefined;
  if ((value.match(/::/g) ?? []).length > 1) return undefined;

  const compressed = value.includes("::");
  const [leftRaw, rightRaw = ""] = compressed ? value.split("::") : [value, ""];
  const left = leftRaw === "" ? [] : leftRaw.split(":");
  const right = rightRaw === "" ? [] : rightRaw.split(":");
  if ([...left, ...right].some((part) => part.length === 0)) return undefined;

  const expand = (parts: string[]): string[] | undefined => {
    const expanded: string[] = [];
    for (const [index, part] of parts.entries()) {
      const maybeV4 = parseIpv4(part);
      if (maybeV4) {
        if (index !== parts.length - 1) return undefined;
        expanded.push(
          ((maybeV4[0] << 8) | maybeV4[1]).toString(16),
          ((maybeV4[2] << 8) | maybeV4[3]).toString(16),
        );
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(part)) {
        expanded.push(Number.parseInt(part, 16).toString(16));
      } else {
        return undefined;
      }
    }
    return expanded;
  };
  const leftExpanded = expand(left);
  const rightExpanded = expand(right);
  if (!leftExpanded || !rightExpanded) return undefined;
  const count = leftExpanded.length + rightExpanded.length;
  if ((!compressed && count !== 8) || (compressed && count >= 8)) return undefined;
  const zeros = compressed ? Array<string>(8 - count).fill("0") : [];
  return `6:${[...leftExpanded, ...zeros, ...rightExpanded].join(":")}`;
}

function ipAddresses(value: unknown, label: string): readonly string[] {
  if (value === null || value === undefined) return freezeArray([]);
  const rawValues = typeof value === "string" ? [value] : list(value, label);
  if (rawValues.length === 0) {
    throw new ConfigurationError(`${label} 列表不能为空`);
  }
  const result: string[] = [];
  const parsed = new Set<string>();
  for (const [index, raw] of rawValues.entries()) {
    const itemLabel = typeof value === "string" ? label : `${label}[${index}]`;
    const text = stringValue(raw, itemLabel);
    const normalized = normalizeIp(text);
    if (!normalized) throw new ConfigurationError(`${itemLabel} 不是合法 IP`);
    if (parsed.has(normalized)) {
      throw new ConfigurationError(`${label} 包含重复 IP: ${text}`);
    }
    parsed.add(normalized);
    result.push(text);
  }
  return freezeArray(result);
}

function permissionText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`${label} 必须是非空字符串`);
  }
  if (
    value !== value.trim() || /[\s,]/u.test(value) || containsAsciiControl(value)
  ) {
    throw new ConfigurationError(`${label} 包含空白、控制字符或逗号`);
  }
  return value;
}

function containsAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function validateScriptRuntimeExecutable(value: unknown, label: string): string {
  const text = permissionText(value, label);
  if (text.includes("\\")) {
    throw new ConfigurationError(`${label} 必须是裸命令名或规范绝对 POSIX 路径`);
  }
  if (!text.includes("/")) {
    if (!COMMAND_NAME_RE.test(text) || text === "." || text === "..") {
      throw new ConfigurationError(`${label} 不是合法的裸命令名`);
    }
    return text;
  }
  if (
    !posix.isAbsolute(text) || text.startsWith("//") || posix.normalize(text) !== text ||
    text === "/" || text.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ConfigurationError(`${label} 必须是规范绝对 POSIX 路径`);
  }
  return text;
}

function runPermission(value: unknown, label: string): string {
  const text = permissionText(value, label);
  if (
    text.includes("\\") || !posix.isAbsolute(text) || text.startsWith("//") ||
    posix.normalize(text) !== text || text === "/" ||
    text.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ConfigurationError(`${label} 必须是规范绝对 POSIX 可执行路径`);
  }
  return text;
}

function pathPermission(value: unknown, label: string): string {
  const text = permissionText(value, label);
  if (
    text.includes("\\") || !posix.isAbsolute(text) || text.startsWith("//") ||
    posix.normalize(text) !== text || text === "/" ||
    text.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ConfigurationError(`${label} 必须是规范绝对 POSIX 文件路径`);
  }
  return text;
}

function validatePort(value: string, label: string): void {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new ConfigurationError(`${label} 端口必须在 1..65535`);
  }
}

function netPermission(value: unknown, label: string): string {
  const text = permissionText(value, label);
  if (["//", "@", "/", "*", "?", "#", "\\"].some((item) => text.includes(item))) {
    throw new ConfigurationError(`${label} 只能是无 scheme、用户信息、路径或通配符的主机/IP`);
  }
  if (text.startsWith("[")) {
    const match = /^\[([^\[\]]+)\](?::([^:]+))?$/.exec(text);
    if (!match) throw new ConfigurationError(`${label} IPv6 地址格式不合法`);
    const normalized = normalizeIp(match[1]);
    if (!normalized?.startsWith("6:")) {
      throw new ConfigurationError(`${label} IPv6 地址不合法`);
    }
    if (match[2] !== undefined) validatePort(match[2], label);
    return text;
  }
  if (normalizeIp(text)) return text;
  if ((text.match(/:/g) ?? []).length > 1) {
    throw new ConfigurationError(`${label} 带端口的 IPv6 必须使用方括号`);
  }
  const colon = text.indexOf(":");
  const host = colon < 0 ? text : text.slice(0, colon);
  if (colon >= 0) validatePort(text.slice(colon + 1), label);
  if (normalizeIp(host)?.startsWith("4:")) return text;
  if (
    host.length === 0 || host.length > 253 ||
    host.split(".").some((part) => !HOST_LABEL_RE.test(part))
  ) {
    throw new ConfigurationError(`${label} 主机名不合法`);
  }
  if (host.includes(".") && /^[0-9.]+$/.test(host)) {
    throw new ConfigurationError(`${label} IPv4 地址不合法`);
  }
  return text;
}

function permissionList(
  value: unknown,
  label: string,
  validator: (value: unknown, label: string) => string,
): readonly string[] {
  const result: string[] = [];
  for (const [index, item] of list(value, label).entries()) {
    const validated = validator(item, `${label}[${index}]`);
    if (result.includes(validated)) {
      throw new ConfigurationError(`${label} 包含重复值: ${validated}`);
    }
    result.push(validated);
  }
  return freezeArray(result);
}

function deepFreezeRecord(value: StringRecord): Readonly<Record<string, unknown>> {
  const copied = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) copied[key] = deepFreezeRecord(item);
    else if (Array.isArray(item)) {
      copied[key] = Object.freeze(
        item.map((entry) => isRecord(entry) ? deepFreezeRecord(entry) : entry),
      );
    } else copied[key] = item;
  }
  return Object.freeze(copied);
}

function packageSpec(value: unknown, label: string): PackageSpec {
  const data = mapping(value, label);
  fields(data, ["provider", "source", "hash"], ["provider", "source", "hash"], label);
  const hash = mapping(data.hash, `${label}.hash`);
  fields(hash, ["algorithm", "value"], ["algorithm", "value"], `${label}.hash`);
  const algorithm = stringValue(hash.algorithm, `${label}.hash.algorithm`).toLowerCase();
  const digestSize = HASH_DIGEST_SIZES[algorithm];
  if (digestSize === undefined) {
    throw new ConfigurationError(`${label} 使用不支持的哈希算法: ${algorithm}`);
  }
  const digest = stringValue(hash.value, `${label}.hash.value`).toLowerCase();
  if (digest.length !== digestSize * 2 || !/^[0-9a-f]+$/.test(digest)) {
    throw new ConfigurationError(`${label}.hash.value 长度或格式不合法`);
  }
  return Object.freeze({
    provider: name(data.provider, `${label}.provider`),
    source: deepFreezeRecord(mapping(data.source, `${label}.source`)),
    hashAlgorithm: algorithm,
    hashValue: digest,
  });
}

async function scriptInvocation(
  value: unknown,
  directory: string,
  label: string,
): Promise<ScriptInvocation> {
  const entry = mapping(value, label);
  fields(entry, ["path", "permissions"], ["path", "permissions"], label);
  const permissionData = mapping(entry.permissions, `${label}.permissions`);
  fields(permissionData, ["run", "net", "read", "write"], ["run", "net"], `${label}.permissions`);
  const permissions: ScriptPermissions = Object.freeze({
    run: permissionList(permissionData.run ?? [], `${label}.permissions.run`, runPermission),
    net: permissionList(permissionData.net ?? [], `${label}.permissions.net`, netPermission),
    read: permissionList(permissionData.read ?? [], `${label}.permissions.read`, pathPermission),
    write: permissionList(permissionData.write ?? [], `${label}.permissions.write`, pathPermission),
  });
  const rawPath = stringValue(entry.path, `${label}.path`);
  return Object.freeze({
    source: await contained(directory, rawPath, `${label}.path`, ".ts"),
    relativePath: rawPath,
    permissions,
  });
}

async function scripts(
  data: StringRecord,
  directory: string,
  label: string,
): Promise<ScriptDefinition> {
  const actionsData = mapping(data.scripts ?? {}, `${label}.scripts`);
  const unknownActions = Object.keys(actionsData).filter((item) => !SCRIPT_ACTION_SET.has(item))
    .sort();
  if (unknownActions.length > 0) {
    throw new ConfigurationError(`${label}.scripts 包含未知动作: ${unknownActions.join(", ")}`);
  }
  const actions = new Map<string, readonly ScriptInvocation[]>();
  for (const [action, rawEntries] of Object.entries(actionsData)) {
    const invocations: ScriptInvocation[] = [];
    for (const [index, rawEntry] of list(rawEntries, `${label}.scripts.${action}`).entries()) {
      const entryLabel = `${label}.scripts.${action}[${index}]`;
      invocations.push(await scriptInvocation(rawEntry, directory, entryLabel));
    }
    actions.set(action, freezeArray(invocations));
  }

  return Object.freeze({
    actions: immutableMap(actions),
  });
}

function environmentPackageInstall(
  value: unknown,
  label: string,
): EnvironmentPackageInstall {
  const item = mapping(value, label);
  fields(
    item,
    ["kind", "manager", "packages", "update_cache"],
    ["kind", "packages"],
    label,
  );
  if (item.kind !== "package") {
    throw new ConfigurationError(`${label}.kind 只支持 package`);
  }
  const rawPackages = list(item.packages, `${label}.packages`);
  if (rawPackages.length === 0) {
    throw new ConfigurationError(`${label}.packages 不能为空`);
  }
  const packages = rawPackages.map((raw, index) => {
    const text = stringValue(raw, `${label}.packages[${index}]`);
    if (!PACKAGE_MANAGER_RE.test(text)) {
      throw new ConfigurationError(`${label}.packages[${index}] 不是合法包名`);
    }
    return text;
  });
  if (new Set(packages).size !== packages.length) {
    throw new ConfigurationError(`${label}.packages 包含重复包名`);
  }
  return Object.freeze({
    kind: "package",
    manager: enumValue<EnvironmentPackageManagerKind>(
      item.manager === undefined || item.manager === null ? "auto" : item.manager,
      new Set(["auto", "apt-get", "yum"]),
      `${label}.manager`,
    ),
    packages: freezeArray(packages),
    updateCache: item.update_cache === true,
  });
}

async function environmentScriptInstall(
  value: unknown,
  directory: string,
  label: string,
): Promise<EnvironmentScriptInstall> {
  const item = mapping(value, label);
  fields(item, ["kind", "path", "permissions"], ["kind", "path", "permissions"], label);
  if (item.kind !== "script") {
    throw new ConfigurationError(`${label}.kind 只支持 script`);
  }
  return Object.freeze({
    kind: "script",
    invocation: await scriptInvocation(
      { path: item.path, permissions: item.permissions },
      directory,
      `${label}.invocation`,
    ),
  });
}

async function environmentInstall(
  value: unknown,
  directory: string,
  label: string,
): Promise<EnvironmentInstallDefinition> {
  const item = mapping(value, label);
  const kind = enumValue<EnvironmentInstallKind>(
    item.kind,
    new Set(["package", "script"]),
    `${label}.kind`,
  );
  return kind === "package"
    ? environmentPackageInstall(item, label)
    : await environmentScriptInstall(item, directory, label);
}

async function environmentManager(
  value: unknown,
  directory: string,
  label: string,
): Promise<EnvironmentManagerDefinition> {
  const item = mapping(value, label);
  const kind = enumValue<EnvironmentServiceManagerKind>(
    item.kind,
    new Set(["system", "script"]),
    `${label}.kind`,
  );
  if (kind === "system") return environmentSystemManager(item, label);
  return await environmentScriptManager(item, directory, label);
}

function environmentSystemManager(
  value: StringRecord,
  label: string,
): EnvironmentSystemManager {
  fields(
    value,
    ["kind", "name", "tool", "enabled", "start_after_install", "timeout_ms"],
    ["kind", "name"],
    label,
  );
  if (value.kind !== "system") {
    throw new ConfigurationError(`${label}.kind 只支持 system`);
  }
  const serviceName = stringValue(value.name, `${label}.name`);
  if (!ENVIRONMENT_SERVICE_NAME_RE.test(serviceName) || serviceName.includes("..")) {
    throw new ConfigurationError(`${label}.name 不是合法服务名称`);
  }
  return Object.freeze({
    kind: "system",
    name: serviceName,
    tool: enumValue<EnvironmentServiceTool>(
      value.tool ?? "auto",
      new Set(["auto", "systemctl", "service"]),
      `${label}.tool`,
    ),
    enabled: value.enabled === undefined ? undefined : value.enabled === true,
    startAfterInstall: value.start_after_install === undefined
      ? true
      : value.start_after_install === true,
    timeoutMs: timeoutMs(value.timeout_ms, `${label}.timeout_ms`),
  });
}

async function environmentScriptManager(
  value: unknown,
  directory: string,
  label: string,
): Promise<EnvironmentScriptManager> {
  const item = mapping(value, label);
  fields(
    item,
    ["kind", "start", "stop", "restart"],
    ["kind", "start", "stop", "restart"],
    label,
  );
  if (item.kind !== "script") {
    throw new ConfigurationError(`${label}.kind 只支持 script`);
  }
  const start = await scriptInvocation(item.start, directory, `${label}.start`);
  const stop = await scriptInvocation(item.stop, directory, `${label}.stop`);
  const restart = await scriptInvocation(item.restart, directory, `${label}.restart`);
  return Object.freeze({ kind: "script", start, stop, restart });
}

/** 顶层 secret_values/secret_files 已移除：cluster.yaml.secrets 是秘密唯一声明点。 */
function rejectTopLevelSecretDeclarations(
  data: Record<string, unknown>,
  label: string,
): void {
  const removed = ["secret_values", "secret_files"].filter(
    (key) => data[key] !== undefined,
  );
  if (removed.length > 0) {
    throw new ConfigurationError(
      `${label} 的 ${
        removed.join("/")
      } 已移除：秘密由 cluster.yaml.secrets 唯一声明，managed 绑定与脚本直接引用本机已声明秘密`,
    );
  }
}

/** 顶层 templates 已移除：模板文件交付请改用 management.configs。 */
function rejectTopLevelTemplates(
  data: Record<string, unknown>,
  label: string,
): void {
  if (data.templates === undefined) return;
  throw new ConfigurationError(
    `${label} 的顶层 templates 已移除：模板文件交付请改用 management.configs(...)`,
  );
}

function managedValueType(value: unknown, label: string): ManagedConfigValueType {
  return enumValue<ManagedConfigValueType>(
    value ?? "string",
    MANAGED_CONFIG_VALUE_TYPES,
    label,
  );
}

function managedVariables(value: unknown, label: string): readonly ManagedConfigVariableBinding[] {
  const result: ManagedConfigVariableBinding[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of list(value ?? [], label).entries()) {
    const itemLabel = `${label}[${index}]`;
    const item = mapping(raw, itemLabel);
    fields(item, ["name", "path", "type"], ["name", "path"], itemLabel);
    const variableName = stringValue(item.name, `${itemLabel}.name`);
    if (!CONFIG_VARIABLE_RE.test(variableName)) {
      throw new ConfigurationError(`${itemLabel}.name 不是合法的大写配置变量名称`);
    }
    if (seen.has(variableName)) {
      throw new ConfigurationError(`${label} 包含重复变量: ${variableName}`);
    }
    seen.add(variableName);
    result.push(Object.freeze({
      name: variableName,
      parameterPath: configPath(item.path, `${itemLabel}.path`),
      valueType: managedValueType(item.type, `${itemLabel}.type`),
    }));
  }
  return freezeArray(result);
}

function managedValidator(value: unknown, label: string): ManagedConfigValidator | undefined {
  if (value === undefined || value === null) return undefined;
  const item = mapping(value, label);
  fields(item, ["argv", "timeout_ms"], ["argv"], label);
  const argv = list(item.argv, `${label}.argv`).map((argument, index) =>
    argvArgument(argument, `${label}.argv[${index}]`)
  );
  if (argv.length === 0) throw new ConfigurationError(`${label}.argv 不能为空`);
  argv[0] = runPermission(argv[0], `${label}.argv[0]`);
  if (argv.some((argument) => argument.includes(CANDIDATE_ARG) && argument !== CANDIDATE_ARG)) {
    throw new ConfigurationError(`${label}.argv 的 ${CANDIDATE_ARG} 必须是独立参数`);
  }
  if (argv.filter((argument) => argument === CANDIDATE_ARG).length !== 1) {
    throw new ConfigurationError(`${label}.argv 必须包含且只包含一个独立 ${CANDIDATE_ARG} 参数`);
  }
  return Object.freeze({
    argv: freezeArray(argv),
    timeoutMs: timeoutMs(item.timeout_ms, `${label}.timeout_ms`),
  });
}

async function managedSecretReferences(
  configName: string,
  format: ManagedConfigFormat,
  source: string,
  secrets: ReadonlyMap<string, SecretDeclaration>,
  label: string,
): Promise<ReadonlyMap<string, ManagedSecretReference>> {
  let text: string;
  try {
    text = await Deno.readTextFile(source);
  } catch (cause) {
    throw new ConfigurationError(`无法读取 ${label}.source 配置 ${source}`, { cause });
  }
  if (format === "nginx") {
    validateManagedPlainText(text, configName);
    return immutableMap(new Map());
  }
  const parsed = parseManagedStructured(format, text, configName);
  const references = new Map<string, ManagedSecretReference>();
  for (const secretName of collectManagedSecretPlaceholders(parsed, configName)) {
    const declaration = secrets.get(secretName);
    if (declaration === undefined) {
      throw new ConfigurationError(
        `配置 ${configName} 的 \${${secretName}} 未在 cluster.yaml.secrets 声明`,
      );
    }
    references.set(
      secretName,
      Object.freeze({ kind: declaration.kind, valueType: declaration.valueType }),
    );
  }
  return immutableMap(references);
}

async function managedConfigFiles(
  value: unknown,
  directory: string,
  installDirectory: string | undefined,
  label: string,
  secrets: ReadonlyMap<string, SecretDeclaration>,
): Promise<readonly ManagedConfigFile[]> {
  const result: ManagedConfigFile[] = [];
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const [index, raw] of list(value ?? [], label).entries()) {
    const itemLabel = `${label}[${index}]`;
    const item = mapping(raw, itemLabel);
    if (item.updater !== undefined) {
      throw new ConfigurationError(
        `${itemLabel}.updater 已移除：请在配置值中使用 \${SECRET_NAME}，并声明 format`,
      );
    }
    fields(
      item,
      [
        "kind",
        "source",
        "target",
        "owner",
        "group",
        "mode",
        "variables",
        "format",
        "validator",
        "on_change",
      ],
      ["kind", "source", "target", "format"],
      itemLabel,
    );
    if (item.kind !== "file") {
      throw new ConfigurationError(`${itemLabel}.kind 只支持 file`);
    }
    const configName = `file-${index}`;
    if (names.has(configName)) {
      throw new ConfigurationError(`${label} 包含内部重复名称: ${configName}`);
    }
    names.add(configName);
    const parsedTarget = managedConfigTarget(
      item.target,
      installDirectory,
      `${itemLabel}.target`,
    );
    if (targets.has(parsedTarget.target)) {
      throw new ConfigurationError(`${label} 包含重复目标路径: ${parsedTarget.target}`);
    }
    targets.add(parsedTarget.target);
    const rawSource = stringValue(item.source, `${itemLabel}.source`);
    const variables = managedVariables(item.variables, `${itemLabel}.variables`);
    const format = enumValue<ManagedConfigFormat>(
      item.format,
      MANAGED_CONFIG_FORMATS,
      `${itemLabel}.format`,
    );
    const source = await contained(directory, rawSource, `${itemLabel}.source`);
    if (format === "nginx" && variables.length > 0) {
      throw new ConfigurationError(`${itemLabel}.variables 与 format: nginx 不兼容`);
    }
    const secretReferences = await managedSecretReferences(
      configName,
      format,
      source,
      secrets,
      `${itemLabel}`,
    );
    result.push(Object.freeze({
      name: configName,
      relativePath: rawSource,
      source,
      target: parsedTarget.target,
      targetRoot: parsedTarget.targetRoot,
      owner: item.owner === undefined ? undefined : accountName(item.owner, `${itemLabel}.owner`),
      group: item.group === undefined ? undefined : accountName(item.group, `${itemLabel}.group`),
      mode: managedFileMode(item.mode ?? "0600", `${itemLabel}.mode`),
      variables,
      format,
      secretReferences,
      validator: managedValidator(item.validator, `${itemLabel}.validator`),
      onChange: enumValue<ManagedConfigChangeAction>(
        item.on_change ?? "none",
        MANAGED_CHANGE_ACTIONS,
        `${itemLabel}.on_change`,
      ),
    }));
  }
  return freezeArray(result);
}

function appServiceManagement(
  item: StringRecord,
  _directory: string,
  installDirectory: string | undefined,
  label: string,
): Promise<AppServiceManagement> {
  fields(
    item,
    [
      "kind",
      "name",
      "tool",
      "enabled",
      "daemon_reload",
      "on_deploy",
      "timeout_ms",
      "unit_config",
    ],
    ["kind", "name"],
    label,
  );
  if (item.kind !== "service") {
    throw new ConfigurationError(`${label}.kind 只支持 service`);
  }
  const unit = stringValue(item.name, `${label}.name`);
  if (!SYSTEMD_UNIT_RE.test(unit) || unit.includes("..")) {
    throw new ConfigurationError(`${label}.name 必须是合法的 .service unit 名称`);
  }
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
    throw new ConfigurationError(`${label}.enabled 必须是布尔值`);
  }
  if (item.daemon_reload !== undefined && typeof item.daemon_reload !== "boolean") {
    throw new ConfigurationError(`${label}.daemon_reload 必须是布尔值`);
  }
  const tool = enumValue<EnvironmentServiceTool>(
    item.tool ?? "auto",
    new Set(["auto", "systemctl", "service"]),
    `${label}.tool`,
  );
  if (tool === "service") {
    if (item.daemon_reload === true) {
      throw new ConfigurationError(`${label}.daemon_reload 与 tool: service 不兼容`);
    }
    if (item.enabled !== undefined) {
      throw new ConfigurationError(`${label}.enabled 与 tool: service 不兼容`);
    }
  }
  const service: AppServiceManagement = Object.freeze({
    kind: "service",
    unit,
    tool,
    enabled: item.enabled as boolean | undefined,
    daemonReload: item.daemon_reload === true,
    onDeploy: enumValue<SystemdDeployAction>(
      item.on_deploy ?? "none",
      SYSTEMD_DEPLOY_ACTIONS,
      `${label}.on_deploy`,
    ),
    timeoutMs: timeoutMs(item.timeout_ms, `${label}.timeout_ms`),
  });
  if (item.unit_config === undefined) return Promise.resolve(service);
  if (service.tool === "service") {
    throw new ConfigurationError(`${label}.unit_config 与 tool: service 不兼容`);
  }
  return Promise.resolve(Object.freeze({
    ...service,
    unitConfig: systemdUnitConfig(
      item.unit_config,
      service.unit,
      installDirectory,
      `${label}.unit_config`,
    ),
  }));
}

async function appScriptManagement(
  item: StringRecord,
  directory: string,
  label: string,
): Promise<AppScriptManagement> {
  fields(item, ["kind", "start", "stop", "restart"], ["kind", "start", "stop", "restart"], label);
  if (item.kind !== "script") {
    throw new ConfigurationError(`${label}.kind 只支持 script`);
  }
  const invocation = async (action: "start" | "stop" | "restart") =>
    await scriptInvocation(item[action], directory, `${label}.${action}`);
  return Object.freeze({
    kind: "script",
    start: await invocation("start"),
    stop: await invocation("stop"),
    restart: await invocation("restart"),
  });
}

async function appManagement(
  value: unknown,
  directory: string,
  installDirectory: string | undefined,
  label: string,
  fileConfigs: readonly ManagedConfigFile[],
  configScripts: readonly ScriptInvocation[],
): Promise<AppManagementDefinition | undefined> {
  if (value === undefined || value === null) {
    if (fileConfigs.some((config) => config.onChange !== "none")) {
      throw new ConfigurationError(
        `${label.replace(".management", ".configs")}.on_change 需要声明 management.kind: service`,
      );
    }
    return undefined;
  }
  const item = mapping(value, label);
  fields(
    item,
    [
      "run_as",
      "kind",
      "start",
      "stop",
      "restart",
      "name",
      "tool",
      "enabled",
      "daemon_reload",
      "on_deploy",
      "timeout_ms",
      "unit_config",
    ],
    ["run_as", "kind"],
    label,
  );
  const runAs = appRunAs(item.run_as, `${label}.run_as`);
  const kind = enumValue<AppManagerDefinition["kind"]>(
    item.kind,
    new Set(["script", "service"]),
    `${label}.kind`,
  );
  const managerInput: StringRecord = { ...item };
  delete managerInput.run_as;
  const manager = kind === "script"
    ? await appScriptManagement(managerInput, directory, label)
    : await appServiceManagement(managerInput, directory, installDirectory, label);
  const systemService = manager.kind === "service" ? manager : undefined;
  if (systemService === undefined && fileConfigs.some((config) => config.onChange !== "none")) {
    throw new ConfigurationError(
      `${label} 需要 management.kind: service 才能声明 configs.on_change`,
    );
  }
  if (systemService?.unitConfig !== undefined) {
    if (!systemService.daemonReload) {
      throw new ConfigurationError(`${label}.unit_config 需要 daemon_reload: true`);
    }
    const unitTarget = systemService.unitConfig.target;
    if (fileConfigs.some((config) => config.target === unitTarget)) {
      throw new ConfigurationError(
        `${label} 配置与 service.unit_config 不能声明同一个目标路径: ${unitTarget}`,
      );
    }
  }
  return Object.freeze({
    runAs,
    configs: fileConfigs,
    configScripts,
    manager,
  });
}
async function appConfigs(
  value: unknown,
  directory: string,
  installDirectory: string | undefined,
  label: string,
  secrets: ReadonlyMap<string, SecretDeclaration>,
): Promise<
  {
    readonly configs: readonly ManagedConfigFile[];
    readonly configScripts: readonly ScriptInvocation[];
  }
> {
  const fileInputs: unknown[] = [];
  const scriptInvocations: ScriptInvocation[] = [];
  const scriptPaths = new Set<string>();
  for (const [index, raw] of list(value ?? [], label).entries()) {
    const itemLabel = `${label}[${index}]`;
    const item = mapping(raw, itemLabel);
    const kind = enumValue<AppConfigKind>(
      item.kind,
      new Set(["script", "file"]),
      `${itemLabel}.kind`,
    );
    if (kind === "file") {
      fileInputs.push(item);
      continue;
    }
    fields(item, ["kind", "path", "permissions"], ["kind", "path", "permissions"], itemLabel);
    const invocation = await scriptInvocation(
      { path: item.path, permissions: item.permissions },
      directory,
      `${itemLabel}.script`,
    );
    if (scriptPaths.has(invocation.relativePath)) {
      throw new ConfigurationError(`${label} 包含重复配置脚本: ${invocation.relativePath}`);
    }
    scriptPaths.add(invocation.relativePath);
    scriptInvocations.push(invocation);
  }
  const configs = await managedConfigFiles(
    fileInputs,
    directory,
    installDirectory,
    `${label}.file`,
    secrets,
  );
  return Object.freeze({
    configs,
    configScripts: freezeArray(scriptInvocations),
  });
}

function systemdUnitConfig(
  value: unknown,
  unit: string,
  installDirectory: string | undefined,
  label: string,
): SystemdUnitConfig {
  const item = mapping(value, label);
  fields(
    item,
    [
      "target",
      "working_directory",
      "command",
      "args",
      "restart_policy",
      "restart_sec",
      "start_limit_interval_sec",
      "start_limit_burst",
    ],
    ["working_directory", "command"],
    label,
  );
  const target = item.target === undefined
    ? `/etc/systemd/system/${unit}`
    : managedTargetPath(item.target, `${label}.target`);
  if (posix.basename(target) !== unit) {
    throw new ConfigurationError(`${label}.target 文件名必须与 service.unit 一致`);
  }
  const workingDirectory = systemdWorkingDirectory(
    item.working_directory,
    installDirectory,
    `${label}.working_directory`,
  );
  const commandText = argvArgument(item.command, `${label}.command`);
  if (!commandText.includes("/")) {
    throw new ConfigurationError(`${label}.command 必须是路径，不能只写裸命令名`);
  }
  const command = absoluteOrRelativeRemotePath(commandText, workingDirectory, `${label}.command`);
  const args = list(item.args ?? [], `${label}.args`).map((argument, index) =>
    argvArgument(argument, `${label}.args[${index}]`)
  );
  return Object.freeze({
    target,
    workingDirectory,
    command,
    args: freezeArray(args),
    restartPolicy: item.restart_policy === undefined ? undefined : enumValue<SystemdRestartPolicy>(
      item.restart_policy,
      SYSTEMD_RESTART_POLICIES,
      `${label}.restart_policy`,
    ),
    restartSec: item.restart_sec === undefined
      ? undefined
      : boundedInteger(item.restart_sec, `${label}.restart_sec`, 0, 86_400),
    startLimitIntervalSec: item.start_limit_interval_sec === undefined ? undefined : boundedInteger(
      item.start_limit_interval_sec,
      `${label}.start_limit_interval_sec`,
      0,
      86_400,
    ),
    startLimitBurst: item.start_limit_burst === undefined
      ? undefined
      : boundedInteger(item.start_limit_burst, `${label}.start_limit_burst`, 0, 10_000),
  });
}

function systemdWorkingDirectory(
  value: unknown,
  installDirectory: string | undefined,
  label: string,
): string {
  const text = stringValue(value, label);
  const variableBareNames = Object.values(MANAGED_TARGET_VARIABLE_PREFIXES)
    .map((prefix) => prefix.slice(0, -1));
  const variableCount = variableBareNames.reduce(
    (count, variable) => count + text.split(variable).length - 1,
    0,
  );
  if (variableCount === 0) {
    if (text.includes("$") || text.includes("%") || text.includes('"')) {
      throw new ConfigurationError(
        `${label} 只支持 ${variableBareNames.join("、")} 目录变量，不支持其他展开或引号字符`,
      );
    }
    return remoteDirectoryPath(value, installDirectory, label);
  }
  if (variableCount > 1) {
    throw new ConfigurationError(`${label} 只能包含一个目录变量`);
  }
  const match = Object.entries(MANAGED_TARGET_VARIABLE_PREFIXES).find(
    ([, prefix]) => text === prefix.slice(0, -1) || text.startsWith(prefix),
  );
  if (match === undefined) {
    throw new ConfigurationError(
      `${label} 只支持以 ${variableBareNames.join("、")} 开头或作为裸值`,
    );
  }
  if (installDirectory === undefined) {
    throw new ConfigurationError(`${label} 使用目录变量，但 App 缺少 install_directory`);
  }
  const [targetRoot, variablePrefix] = match as [
    Exclude<ManagedConfigTargetRoot, "absolute">,
    string,
  ];
  const bareValue = text === variablePrefix.slice(0, -1);
  const relative = bareValue ? "" : text.slice(variablePrefix.length);
  if (
    relative !== "" && (
      relative.startsWith("/") || relative.endsWith("/") || relative.includes("\\") ||
      relative.includes("$") || relative.includes("%") || relative.includes('"') ||
      relative.split("/").some((part) => part === "" || part === "." || part === "..")
    )
  ) {
    throw new ConfigurationError(
      `${label} 的目录变量后必须是规范相对路径`,
    );
  }
  if (!bareValue && relative === "") {
    throw new ConfigurationError(`${label} 的目录变量后必须是规范相对路径`);
  }
  const root = targetRoot === "install"
    ? posix.normalize(installDirectory)
    : `${posix.normalize(installDirectory)}/latest`;
  const resolved = relative === "" ? root : posix.join(root, relative);
  return managedTargetPath(resolved, label);
}

function remoteDirectoryPath(
  value: unknown,
  installDirectory: string | undefined,
  label: string,
): string {
  const text = stringValue(value, label);
  if (text.includes("\\") || /[\0\r\n]/.test(text)) {
    throw new ConfigurationError(`${label} 包含非法字符`);
  }
  if (posix.isAbsolute(text)) return managedTargetPath(text, label);
  if (
    text === "" || text.startsWith("//") || posix.normalize(text) !== text ||
    text.split("/").some((part) => part === "..")
  ) {
    throw new ConfigurationError(`${label} 必须是规范相对 POSIX 路径或远端绝对路径`);
  }
  if (installDirectory === undefined) {
    throw new ConfigurationError(`${label} 是相对路径，但 App 缺少 install_directory`);
  }
  const base = posix.normalize(installDirectory);
  const resolved = posix.normalize(posix.join(base, text));
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new ConfigurationError(`${label} 逃逸 App 安装目录`);
  }
  return resolved;
}

function absoluteOrRelativeRemotePath(
  value: string,
  base: string,
  label: string,
): string {
  if (posix.isAbsolute(value)) {
    if (value === "/" || value.startsWith("//") || posix.normalize(value) !== value) {
      throw new ConfigurationError(`${label} 必须是规范的远端绝对路径`);
    }
    return value;
  }
  const normalizedBase = posix.normalize(base);
  const resolved = posix.normalize(posix.join(normalizedBase, value));
  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}/`)) {
    throw new ConfigurationError(`${label} 逃逸 working_directory`);
  }
  return resolved;
}

async function loadMachines(path: string, root: string): Promise<Map<string, Machine>> {
  const data = await loadYaml(path);
  version(data, "machines.yaml");
  fields(data, ["schema_version", "machines"], ["schema_version", "machines"], "machines.yaml");
  const machines = new Map<string, Machine>();
  for (const [index, raw] of list(data.machines, "machines.yaml.machines").entries()) {
    const label = `machines[${index}]`;
    const item = mapping(raw, label);
    fields(
      item,
      [
        "name",
        "domains",
        "private_ip",
        "public_ip",
        "region",
        "ssh_user",
        "ssh_port",
        "ssh_private_key",
        "secrets_dir",
        "deno",
      ],
      ["name", "region", "ssh_user"],
      label,
    );
    const machineName = name(item.name, `${label}.name`);
    if (machines.has(machineName)) throw new ConfigurationError(`重复机器名称: ${machineName}`);
    const sshPort = item.ssh_port ?? 22;
    if (
      typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535
    ) {
      throw new ConfigurationError(`${label}.ssh_port 不合法`);
    }
    const key = item.ssh_private_key;
    const secretsDir = item.secrets_dir === undefined || item.secrets_dir === null
      ? undefined
      : secretDirectory(item.secrets_dir, `${label}.secrets_dir`);
    machines.set(
      machineName,
      Object.freeze({
        name: machineName,
        domains: stringList(item.domains ?? [], `${label}.domains`),
        privateIp: ipAddresses(item.private_ip, `${label}.private_ip`),
        publicIp: ipAddresses(item.public_ip, `${label}.public_ip`),
        region: name(item.region, `${label}.region`),
        sshUser: stringValue(item.ssh_user, `${label}.ssh_user`),
        sshPort,
        secretsDir,
        sshPrivateKey: key ? await contained(root, key, `${label}.ssh_private_key`) : undefined,
        scriptRuntime: Object.freeze({
          kind: "deno" as const,
          executable: validateScriptRuntimeExecutable(item.deno ?? "deno", `${label}.deno`),
        }),
        environments: freezeArray([]),
      }),
    );
  }
  return machines;
}

async function childDirectories(parent: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(parent)) {
      if (entry.isDirectory) entries.push(entry.name);
    }
  } catch (cause) {
    throw new ConfigurationError(`无法读取配置目录: ${parent}`, { cause });
  }
  return entries.sort();
}

async function loadEnvironment(
  directory: string,
  directoryName: string,
  label: string,
): Promise<LoadedEnvironment> {
  const environmentName = name(directoryName, `${label} 目录名`);
  const data = await loadYaml(join(directory, "environment.yaml"));
  version(data, label);
  rejectTopLevelSecretDeclarations(data, label);
  rejectTopLevelTemplates(data, label);
  fields(
    data,
    [
      "schema_version",
      "name",
      "version",
      "parameters",
      "depends_on",
      "defaults",
      "requires_privilege",
      "package",
      "scripts",
      "install",
      "manager",
    ],
    ["schema_version", "name", "version"],
    label,
  );
  const declaredName = name(data.name, `${label}.name`);
  if (declaredName !== environmentName) {
    throw new ConfigurationError(`环境名称 ${declaredName} 必须与目录 ${directoryName} 相同`);
  }
  const privilege = data.requires_privilege;
  if (privilege !== undefined && privilege !== null && typeof privilege !== "boolean") {
    throw new ConfigurationError(`${label}.requires_privilege 必须是布尔值`);
  }
  const hasScripts = data.scripts !== undefined && data.scripts !== null;
  const hasLifecycle = data.install !== undefined || data.manager !== undefined;
  if (hasScripts === hasLifecycle) {
    throw new ConfigurationError(
      `${label} 必须且只能选择旧顶层 scripts 或新的 install/manager 生命周期`,
    );
  }
  if (hasLifecycle && (data.install === undefined || data.install === null)) {
    throw new ConfigurationError(`${label}.install 是新生命周期的必需字段`);
  }
  const environmentScripts = hasScripts
    ? await scripts(data, directory, label)
    : Object.freeze({ actions: immutableMap(new Map()) });
  const install = hasLifecycle
    ? await environmentInstall(data.install, directory, `${label}.install`)
    : undefined;
  const manager = data.manager === undefined || data.manager === null
    ? undefined
    : await environmentManager(data.manager, directory, `${label}.manager`);
  return Object.freeze({
    name: environmentName,
    directory: await Deno.realPath(directory),
    scripts: environmentScripts,
    defaults: deepFreezeRecord(mapping(data.defaults ?? {}, `${label}.defaults`)),
    package: data.package === undefined || data.package === null
      ? undefined
      : packageSpec(data.package, `${label}.package`),
    requiresPrivilege: privilege === true,
    install,
    manager,
    version: stringValue(data.version, `${label}.version`),
    parameters: deepFreezeRecord(mapping(data.parameters ?? {}, `${label}.parameters`)),
    dependsOn: stringList(data.depends_on ?? [], `${label}.depends_on`),
  });
}

function placedEnvironmentDefinition(
  machineName: string,
  environment: LoadedEnvironment,
): EnvironmentDefinition {
  return Object.freeze({
    name: `${machineName}/${environment.name}`,
    directory: environment.directory,
    scripts: environment.scripts,
    defaults: environment.defaults,
    package: environment.package,
    requiresPrivilege: environment.requiresPrivilege,
    install: environment.install,
    manager: environment.manager,
  });
}

function placedEnvironmentInstance(
  machineName: string,
  environment: LoadedEnvironment,
): EnvironmentInstance {
  return Object.freeze({
    name: environment.name,
    definition: `${machineName}/${environment.name}`,
    version: environment.version,
    parameters: environment.parameters,
    dependsOn: environment.dependsOn,
  });
}

async function containsNestedEnvironmentDefinition(directory: string): Promise<boolean> {
  for (const child of await childDirectories(directory)) {
    if (await isFile(join(directory, child, "environment.yaml"))) return true;
  }
  return false;
}

async function loadV2PlacedEnvironments(
  root: string,
  machines: ReadonlyMap<string, Machine>,
  placementData: Readonly<StringRecord>,
): Promise<LoadedEnvironments> {
  const definitions = new Map<string, EnvironmentDefinition>();
  const instanceLists = new Map<string, EnvironmentInstance[]>();
  const parent = join(root, "environments");
  const directoryNames = (await isDirectory(parent)) ? await childDirectories(parent) : [];

  const legacyDirectories: string[] = [];
  for (const directoryName of directoryNames) {
    const directory = join(parent, directoryName);
    if (machines.has(directoryName) && await containsNestedEnvironmentDefinition(directory)) {
      legacyDirectories.push(directoryName);
    }
  }
  if (legacyDirectories.length > 0) {
    throw new ConfigurationError(
      `cluster.yaml schema_version 2 不允许 v1 Environment 布局: ${
        legacyDirectories.map((item) => `environments/${item}/<environment>`).join(", ")
      }`,
    );
  }

  const definitionNames = directoryNames.map((directoryName) =>
    name(directoryName, `environment[${directoryName}] 目录名`)
  );
  const placementNames = Object.keys(placementData).map((environmentName) =>
    name(environmentName, `cluster.yaml.environments.${environmentName}`)
  ).sort();
  const definitionSet = new Set(definitionNames);
  const placementSet = new Set(placementNames);
  const missing = definitionNames.filter((environmentName) => !placementSet.has(environmentName));
  const unknown = placementNames.filter((environmentName) => !definitionSet.has(environmentName));
  if (missing.length > 0 || unknown.length > 0) {
    throw new ConfigurationError(
      `cluster.yaml Environment 映射不一致；缺失=${JSON.stringify(missing)} 未知=${
        JSON.stringify(unknown)
      }`,
    );
  }

  for (const environmentName of definitionNames) {
    const assigned = freezeArray(
      [...stringList(
        placementData[environmentName],
        `cluster.yaml.environments.${environmentName}`,
        NAME_RE,
      )].sort(),
    );
    if (assigned.length === 0) {
      throw new ConfigurationError(`Environment ${environmentName} 至少需要一台目标机器`);
    }
    const unknownMachines = assigned.filter((machineName) => !machines.has(machineName));
    if (unknownMachines.length > 0) {
      throw new ConfigurationError(
        `Environment ${environmentName} 引用未知机器: ${unknownMachines.join(", ")}`,
      );
    }

    const directory = join(parent, environmentName);
    if (!(await isFile(join(directory, "environment.yaml")))) {
      throw new ConfigurationError(
        `cluster.yaml schema_version 2 要求共享定义: environments/${environmentName}/environment.yaml`,
      );
    }
    const environment = await loadEnvironment(
      directory,
      environmentName,
      `environment[${environmentName}]`,
    );
    for (const machineName of assigned) {
      const definitionKey = `${machineName}/${environmentName}`;
      definitions.set(definitionKey, placedEnvironmentDefinition(machineName, environment));
      const machineInstances = instanceLists.get(machineName) ?? [];
      machineInstances.push(placedEnvironmentInstance(machineName, environment));
      instanceLists.set(machineName, machineInstances);
    }
  }

  return {
    definitions,
    instances: new Map(
      [...instanceLists].map(([machineName, machineInstances]) => [
        machineName,
        freezeArray(machineInstances),
      ]),
    ),
  };
}

const APP_FIELDS = [
  "schema_version",
  "name",
  "install_directory",
  "packageless",
  "depends_on",
  "deployment",
  "configs",
  "management",
] as const;

function rejectTopLevelAppScripts(data: StringRecord, label: string): void {
  if (data.scripts === undefined) return;
  throw new ConfigurationError(
    `${label} 的顶层 scripts 已移除：配置脚本请使用 configs.kind: script，服务脚本请使用 management.kind: script`,
  );
}

function deploymentDefinition(value: unknown, label: string): DeploymentDefinition {
  const item = mapping(value, label);
  fields(item, ["kind"], ["kind"], label);
  if (item.kind !== "versioned") {
    throw new ConfigurationError(`${label}.kind 首版只支持 versioned`);
  }
  return Object.freeze({ kind: "versioned" as const });
}

/** 读取集群根 app_versions.yaml；文件不存在时返回 undefined（App 装载会进一步报错）。 */
async function loadAppVersions(root: string): Promise<Map<string, AppVersionEntry> | undefined> {
  const path = join(root, "app_versions.yaml");
  if (!(await isFile(path))) return undefined;
  const data = await loadYaml(path);
  version(data, "app_versions.yaml");
  fields(data, ["schema_version", "apps"], ["schema_version", "apps"], "app_versions.yaml");
  const entries = new Map<string, AppVersionEntry>();
  for (
    const [appName, rawValue] of Object.entries(
      mapping(data.apps, "app_versions.yaml.apps"),
    )
  ) {
    const entryLabel = `app_versions.yaml.apps.${appName}`;
    const key = name(appName, `${entryLabel} 名称`);
    const entry = mapping(rawValue, entryLabel);
    fields(entry, ["version", "package"], ["version", "package"], entryLabel);
    entries.set(
      key,
      Object.freeze({
        version: stringValue(entry.version, `${entryLabel}.version`),
        package: packageSpec(entry.package, `${entryLabel}.package`),
      }),
    );
  }
  return entries;
}

async function loadApps(
  root: string,
  appVersions: ReadonlyMap<string, AppVersionEntry> | undefined,
  secrets: ReadonlyMap<string, SecretDeclaration>,
): Promise<Map<string, AppDefinition>> {
  const apps = new Map<string, AppDefinition>();
  const parent = join(root, "apps");
  if (!(await isDirectory(parent))) {
    if (appVersions !== undefined && appVersions.size > 0) {
      throw new ConfigurationError(
        "app_versions.yaml 声明了 App，但集群 apps 目录不存在",
      );
    }
    return apps;
  }
  for (const directoryName of await childDirectories(parent)) {
    const directory = join(parent, directoryName);
    const data = await loadYaml(join(directory, "app.yaml"));
    const label = `app[${directoryName}]`;
    appSchemaVersion(data, label);
    rejectTopLevelSecretDeclarations(data, label);
    rejectTopLevelTemplates(data, label);
    rejectTopLevelAppScripts(data, label);
    if (data.packageless !== undefined && typeof data.packageless !== "boolean") {
      throw new ConfigurationError(`${label}.packageless 必须是布尔值`);
    }
    const packageless = data.packageless === true;
    const appName = name(data.name, `${label}.name`);
    if (appName !== directoryName) {
      throw new ConfigurationError(`App 名称 ${appName} 必须与目录 ${directoryName} 相同`);
    }
    if (appVersions === undefined) {
      throw new ConfigurationError(
        `App ${appName} 使用 schema 1，但集群缺少 app_versions.yaml`,
      );
    }
    fields(
      data,
      APP_FIELDS,
      packageless ? ["schema_version", "name"] : ["schema_version", "name", "install_directory"],
      label,
    );
    const entry = appVersions.get(appName);
    if (packageless) {
      if (entry) {
        throw new ConfigurationError(
          `packageless App ${appName} 不允许 app_versions.yaml 版本记录`,
        );
      }
    } else if (!entry) {
      throw new ConfigurationError(`app_versions.yaml 缺少 App ${appName} 的版本记录`);
    }
    const installDirectory = data.install_directory === undefined
      ? undefined
      : remoteAbsolutePath(data.install_directory, `${label}.install_directory`);
    let deployment: DeploymentDefinition | undefined;
    if (data.deployment !== undefined) {
      deployment = deploymentDefinition(data.deployment, `${label}.deployment`);
    }
    if (deployment !== undefined) {
      if (packageless) {
        throw new ConfigurationError(`${label}.deployment 不能用于 packageless App`);
      }
    } else if (!packageless) {
      deployment = Object.freeze({ kind: "versioned" as const });
    }
    const appConfig = await appConfigs(
      data.configs,
      directory,
      installDirectory,
      `${label}.configs`,
      secrets,
    );
    const management = await appManagement(
      data.management,
      directory,
      installDirectory,
      `${label}.management`,
      appConfig.configs,
      appConfig.configScripts,
    );
    if (appConfig.configs.length > 0 && management?.runAs === undefined) {
      throw new ConfigurationError(`${label}.configs.file 需要声明 management.run_as`);
    }
    if (deployment !== undefined && management?.runAs === undefined) {
      throw new ConfigurationError(
        `${label}.deployment.versioned 需要声明 management.run_as`,
      );
    }
    apps.set(
      appName,
      Object.freeze({
        name: appName,
        directory: await Deno.realPath(directory),
        installDirectory: data.install_directory === undefined
          ? undefined
          : remoteAbsolutePath(data.install_directory, `${label}.install_directory`),
        version: entry?.version,
        package: entry?.package,
        packageless,
        deployment,
        dependsOn: stringList(data.depends_on ?? [], `${label}.depends_on`),
        management,
      }),
    );
  }
  if (appVersions !== undefined) {
    const unknownVersions = [...appVersions.keys()]
      .filter((app) => !apps.has(app))
      .sort();
    if (unknownVersions.length > 0) {
      throw new ConfigurationError(
        `app_versions.yaml 声明未知 App: ${unknownVersions.join(", ")}`,
      );
    }
  }
  return apps;
}

function validateDependencies(
  machines: ReadonlyMap<string, Machine>,
  definitions: ReadonlyMap<string, EnvironmentDefinition>,
  apps: ReadonlyMap<string, AppDefinition>,
  placements: ReadonlyMap<string, readonly string[]>,
  secrets: ReadonlyMap<string, SecretDeclaration>,
): void {
  const validateSecret = (
    secretName: string,
    kind: SecretKind | undefined,
    machineName: string,
  ): void => {
    const declaration = secrets.get(secretName);
    if (declaration === undefined) {
      throw new ConfigurationError(`密钥 ${secretName} 未在 cluster.yaml.secrets 声明`);
    }
    if (kind !== undefined && declaration.kind !== kind) {
      throw new ConfigurationError(
        `密钥 ${secretName} 类型冲突；App 要求 ${kind}，cluster.yaml 声明 ${declaration.kind}`,
      );
    }
    if (!declaration.machines.includes(machineName)) {
      throw new ConfigurationError(`密钥 ${secretName} 未声明放置到机器 ${machineName}`);
    }
  };
  const environmentIds = new Set<string>();
  for (const machine of machines.values()) {
    for (const environment of machine.environments) {
      environmentIds.add(`${machine.name}/${environment.name}`);
    }
  }
  for (const machine of machines.values()) {
    const local = new Set(machine.environments.map((environment) => environment.name));
    for (const environment of machine.environments) {
      if (!definitions.has(environment.definition)) {
        throw new ConfigurationError(
          `${machine.name}/${environment.name} 引用未知环境定义: ${environment.definition}`,
        );
      }
      for (const dependency of environment.dependsOn) {
        const target = dependency.includes("/") ? dependency : `${machine.name}/${dependency}`;
        if (!environmentIds.has(target)) {
          throw new ConfigurationError(
            `${machine.name}/${environment.name} 引用未知环境实例: ${dependency}`,
          );
        }
        if (!dependency.includes("/") && !local.has(dependency)) {
          throw new ConfigurationError(
            `${machine.name}/${environment.name} 引用未知本机环境实例: ${dependency}`,
          );
        }
      }
    }
  }
  for (const [appName, app] of apps) {
    for (const machineName of placements.get(appName) ?? []) {
      for (const dependency of app.dependsOn) {
        const target = dependency.includes("/") ? dependency : `${machineName}/${dependency}`;
        if (!environmentIds.has(target)) {
          throw new ConfigurationError(
            `App ${appName} 在 ${machineName} 引用未知环境实例: ${dependency}`,
          );
        }
      }
      for (const config of app.management?.configs ?? []) {
        for (const [secretName, reference] of config.secretReferences) {
          validateSecret(secretName, reference.kind, machineName);
        }
      }
    }
  }
}

/** 从集群目录异步读取并严格校验全部 YAML 与资源路径。 */
export async function loadCluster(directory: string | URL): Promise<ClusterConfig> {
  const rawDirectory = directory instanceof URL
    ? (directory.protocol === "file:" ? decodeURIComponent(directory.pathname) : "")
    : directory;
  if (!rawDirectory) throw new ConfigurationError(`集群目录不存在: ${String(directory)}`);
  const root = resolve(rawDirectory);
  if (!(await isDirectory(root))) throw new ConfigurationError(`集群目录不存在: ${root}`);
  const realRoot = await Deno.realPath(root);
  const clusterData = await loadYaml(join(realRoot, "cluster.yaml"));
  clusterSchemaVersion(clusterData);
  fields(
    clusterData,
    ["schema_version", "name", "executor_region", "environments", "apps", "secrets"],
    ["schema_version", "name", "executor_region", "environments", "apps"],
    "cluster.yaml",
  );

  let machines = await loadMachines(join(realRoot, "machines.yaml"), realRoot);
  const { definitions, instances } = await loadV2PlacedEnvironments(
    realRoot,
    machines,
    mapping(clusterData.environments, "cluster.yaml.environments"),
  );
  machines = new Map([...machines].map(([machineName, machine]) => [
    machineName,
    Object.freeze({ ...machine, environments: instances.get(machineName) ?? freezeArray([]) }),
  ]));
  const appVersions = await loadAppVersions(realRoot);
  const secrets = await secretDeclarations(clusterData.secrets, "cluster.yaml.secrets", machines);
  const apps = await loadApps(realRoot, appVersions, secrets);
  const placementData = mapping(clusterData.apps, "cluster.yaml.apps");
  const missingApps = [...apps.keys()].filter((app) => !(app in placementData)).sort();
  const unknownApps = Object.keys(placementData).filter((app) => !apps.has(app)).sort();
  if (missingApps.length > 0 || unknownApps.length > 0) {
    throw new ConfigurationError(
      `cluster.yaml App 映射不一致；缺失=${JSON.stringify(missingApps)} 未知=${
        JSON.stringify(unknownApps)
      }`,
    );
  }
  const placements = new Map<string, readonly string[]>();
  for (const [appName, rawMachines] of Object.entries(placementData)) {
    const assigned = stringList(rawMachines, `cluster.yaml.apps.${appName}`);
    if (assigned.length === 0) throw new ConfigurationError(`App ${appName} 至少需要一台目标机器`);
    const unknown = assigned.filter((machine) => !machines.has(machine)).sort();
    if (unknown.length > 0) {
      throw new ConfigurationError(`App ${appName} 引用未知机器: ${unknown.join(", ")}`);
    }
    placements.set(appName, assigned);
  }
  validateDependencies(machines, definitions, apps, placements, secrets);
  return Object.freeze({
    name: name(clusterData.name, "cluster.yaml.name"),
    directory: realRoot,
    executorRegion: name(clusterData.executor_region, "cluster.yaml.executor_region"),
    machines: immutableMap(machines),
    environments: immutableMap(definitions),
    apps: immutableMap(apps),
    placements: immutableMap(placements),
    secrets,
  });
}

export const __internal = Object.freeze({
  normalizeIp,
  netPermission,
  runPermission,
  scripts,
});
