/** 严格加载一个自包含的 sfo-deploy 集群目录。 */

import { parse } from "jsr:@std/yaml@1.2.0";
import { extname, isAbsolute, join, relative, resolve } from "jsr:@std/path@1.1.6";
import * as posix from "jsr:@std/path@1.1.6/posix";
import { ConfigurationError } from "./errors.ts";
import deployerPkg from "../deno.json" with { type: "json" };
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
const DEPLOYER_VERSION = String(deployerPkg.version ?? "");
/** sfo-deploy 运行时版本；与仓库根 deno.json.version 同源。 */
export const TOOL_VERSION: string = DEPLOYER_VERSION === "" ? "<unknown>" : DEPLOYER_VERSION;
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
    throw new ConfigurationError(`${label} must be a string-keyed mapping`);
  }
  return value;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${label} must be a list`);
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
    throw new ConfigurationError(`${label} contains unknown fields: ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new ConfigurationError(`${label} is missing fields: ${missing.join(", ")}`);
  }
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw new ConfigurationError(`${label} is not a valid name: ${repr(value)}`);
  }
  return value;
}

function stringValue(value: unknown, label: string, nonempty = true): string {
  if (typeof value !== "string" || (nonempty && value.trim().length === 0)) {
    throw new ConfigurationError(`${label} must be a string`);
  }
  return value.trim();
}

function version(data: StringRecord, label: string): void {
  if (data.schema_version !== 1) {
    throw new ConfigurationError(`${label}.schema_version supports only 1`);
  }
}

/** deployer_version 要求精确字符串值：不做 trim，带空白的值视为不匹配。 */
function exactDeployerVersion(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(
      "cluster.yaml.deployer_version must be a non-empty string",
    );
  }
  return value;
}

function clusterSchemaVersion(data: StringRecord): ClusterSchemaVersion {
  if (data.schema_version !== 2) {
    throw new ConfigurationError(
      "cluster.yaml.schema_version supports only 2; the v1 per-machine environment layout was removed, use shared definitions plus an environments mapping",
    );
  }
  return 2;
}

function appSchemaVersion(data: StringRecord, label: string): AppSchemaVersion {
  if (data.schema_version !== 1) {
    throw new ConfigurationError(`${label}.schema_version supports only 1`);
  }
  return data.schema_version;
}

/** 远端脚本使用的绝对 POSIX 路径；拒绝相对路径、`..` 段与非法字符。 */
function remoteAbsolutePath(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!text.startsWith("/")) {
    throw new ConfigurationError(`${label} must be a remote absolute POSIX path`);
  }
  if (text.split("/").includes("..")) {
    throw new ConfigurationError(`${label} must not contain a .. segment`);
  }
  if (/[\0\r\n\\]/.test(text)) {
    throw new ConfigurationError(`${label} contains invalid characters`);
  }
  return text;
}

function managedTargetPath(value: unknown, label: string): string {
  const text = remoteAbsolutePath(value, label);
  if (
    text === "/" || text.startsWith("//") || posix.normalize(text) !== text ||
    text.endsWith("/")
  ) {
    throw new ConfigurationError(`${label} must be a canonical remote absolute file path`);
  }
  if (["/dev", "/proc", "/sys"].some((root) => text === root || text.startsWith(`${root}/`))) {
    throw new ConfigurationError(
      `${label} must not write to kernel or device file systems: ${text}`,
    );
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
      `${label} must contain exactly one directory variable`,
    );
  }
  const match = Object.entries(MANAGED_TARGET_VARIABLE_PREFIXES).find(([, prefix]) =>
    text.startsWith(prefix)
  );
  if (match === undefined) {
    throw new ConfigurationError(
      `${label} supports only paths starting with \${INSTALL_DIRECTORY}/, \${CURRENT_VERSION_DIRECTORY}/, or \${LATEST_DIRECTORY}/`,
    );
  }
  const [targetRoot, variablePrefix] = match as [
    Exclude<ManagedConfigTargetRoot, "absolute">,
    string,
  ];
  if (installDirectory === undefined) {
    throw new ConfigurationError(
      `${label} uses an install directory variable, but the App is missing install_directory`,
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
      `${label} must be followed by a canonical relative path after \${${
        variableName.slice(2, -1)
      }}`,
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
    throw new ConfigurationError(`${label} uses an unsupported value: ${repr(text)}`);
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
    throw new ConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function timeoutMs(value: unknown, label: string): number {
  return boundedInteger(value ?? DEFAULT_MANAGED_TIMEOUT_MS, label, 1, 3_600_000);
}

function accountName(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!ACCOUNT_RE.test(text)) {
    throw new ConfigurationError(`${label} is not a valid Linux account name`);
  }
  return text;
}

function appRunAs(value: unknown, label: string): string {
  const text = accountName(value, label);
  if (text === "root") {
    throw new ConfigurationError(`${label} must be a non-root Linux user`);
  }
  return text;
}

function managedFileMode(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0?[0-7]{3}$/.test(value)) {
    throw new ConfigurationError(`${label} must be a three- or four-digit octal string`);
  }
  const mode = Number.parseInt(value, 8);
  if ((mode & 0o400) === 0 || (mode & 0o133) !== 0) {
    throw new ConfigurationError(
      `${label} must allow owner read and must not contain execute bits or group/other write permissions`,
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
      throw new ConfigurationError(`${segmentLabel} is a dangerous or invalid field name`);
    }
    result.push(text);
  }
  if (result.length === 0) throw new ConfigurationError(`${label} must not be empty`);
  return freezeArray(result);
}

function argvArgument(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || containsAsciiControl(value)) {
    throw new ConfigurationError(`${label} must be a non-empty string without control characters`);
  }
  return value;
}

/** 每机安全目录：接受 `~/` 用户目录路径或规范绝对 POSIX 路径。 */
function secretDirectory(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (text === "/" || text === "~" || text.includes("\\") || /[\0\r\n]/.test(text)) {
    throw new ConfigurationError(`${label} is an invalid secure directory path`);
  }
  if (text.startsWith("~/")) {
    const rest = text.slice(2);
    if (!rest || rest.split("/").includes("..")) {
      throw new ConfigurationError(`${label} allows ~/ paths but not .. segments`);
    }
    return text;
  }
  if (!text.startsWith("/") || text.split("/").includes("..")) {
    throw new ConfigurationError(`${label} must be a ~/ path or a safe absolute POSIX path`);
  }
  return text;
}

function secretKind(value: unknown, label: string): SecretKind {
  const text = stringValue(value, label);
  if (!SECRET_KINDS.has(text)) {
    throw new ConfigurationError(`${label} supports only value or file: ${repr(text)}`);
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
    throw new ConfigurationError(`${label} requires at least one target machine`);
  }
  const unknown = raw.filter((machine) => !known.has(machine)).sort();
  if (unknown.length > 0) {
    throw new ConfigurationError(`${label} references unknown machines: ${unknown.join(", ")}`);
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
    const secretName = stringValue(rawName, `${label} secret name`);
    if (!SECRET_RE.test(secretName)) {
      throw new ConfigurationError(`Invalid ${label} secret name: ${repr(rawName)}`);
    }
    if (declarations.has(secretName)) {
      throw new ConfigurationError(
        `${label} contains a duplicate secret declaration: ${secretName}`,
      );
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
    throw new ConfigurationError(`Failed to read YAML ${path}: ${String(cause)}`, { cause });
  }
  let value: unknown;
  try {
    // @std/yaml 默认拒绝重复键；显式写出选项以固定安全语义。
    value = parse(text, { allowDuplicateKeys: false });
  } catch (cause) {
    throw new ConfigurationError(`Failed to read YAML ${path}: ${String(cause)}`, { cause });
  }
  if (!isRecord(value)) {
    throw new ConfigurationError(`YAML top level must be a mapping: ${path}`);
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
    throw new ConfigurationError(`${label} must be inside the resource directory: ${text}`);
  }
  const baseResolved = resolve(base);
  const candidate = resolve(baseResolved, text);
  const lexicalRelative = relative(baseResolved, candidate);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new ConfigurationError(`${label} escapes the resource directory: ${text}`);
  }
  if (suffix && extname(candidate) !== suffix) {
    throw new ConfigurationError(`${label} must be a ${suffix} file: ${text}`);
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
      throw new ConfigurationError(`${label} escapes the resource directory: ${text}`);
    }
    if (!info.isFile) {
      throw new ConfigurationError(`${label} file does not exist: ${candidate}`);
    }
    return realCandidate;
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError(`${label} file does not exist: ${candidate}`, { cause });
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
      throw new ConfigurationError(`Invalid name for ${label}[${index}]: ${text}`);
    }
    if (result.includes(text)) {
      throw new ConfigurationError(`${label} contains a duplicate value: ${text}`);
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
    throw new ConfigurationError(`${label} list must not be empty`);
  }
  const result: string[] = [];
  const parsed = new Set<string>();
  for (const [index, raw] of rawValues.entries()) {
    const itemLabel = typeof value === "string" ? label : `${label}[${index}]`;
    const text = stringValue(raw, itemLabel);
    const normalized = normalizeIp(text);
    if (!normalized) throw new ConfigurationError(`${itemLabel} is not a valid IP`);
    if (parsed.has(normalized)) {
      throw new ConfigurationError(`${label} contains a duplicate IP: ${text}`);
    }
    parsed.add(normalized);
    result.push(text);
  }
  return freezeArray(result);
}

function permissionText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`${label} must be a non-empty string`);
  }
  if (
    value !== value.trim() || /[\s,]/u.test(value) || containsAsciiControl(value)
  ) {
    throw new ConfigurationError(`${label} contains whitespace, control characters, or commas`);
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
    throw new ConfigurationError(
      `${label} must be a bare command name or a canonical absolute POSIX path`,
    );
  }
  if (!text.includes("/")) {
    if (!COMMAND_NAME_RE.test(text) || text === "." || text === "..") {
      throw new ConfigurationError(`${label} is not a valid bare command name`);
    }
    return text;
  }
  if (
    !posix.isAbsolute(text) || text.startsWith("//") || posix.normalize(text) !== text ||
    text === "/" || text.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ConfigurationError(`${label} must be a canonical absolute POSIX path`);
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
    throw new ConfigurationError(`${label} must be a canonical absolute POSIX executable path`);
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
    throw new ConfigurationError(`${label} must be a canonical absolute POSIX file path`);
  }
  return text;
}

function validatePort(value: string, label: string): void {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new ConfigurationError(`${label} port must be within 1..65535`);
  }
}

function netPermission(value: unknown, label: string): string {
  const text = permissionText(value, label);
  if (["//", "@", "/", "*", "?", "#", "\\"].some((item) => text.includes(item))) {
    throw new ConfigurationError(
      `${label} must be a host/IP without scheme, user information, path, or wildcards`,
    );
  }
  if (text.startsWith("[")) {
    const match = /^\[([^\[\]]+)\](?::([^:]+))?$/.exec(text);
    if (!match) throw new ConfigurationError(`Invalid ${label} IPv6 address format`);
    const normalized = normalizeIp(match[1]);
    if (!normalized?.startsWith("6:")) {
      throw new ConfigurationError(`Invalid ${label} IPv6 address`);
    }
    if (match[2] !== undefined) validatePort(match[2], label);
    return text;
  }
  if (normalizeIp(text)) return text;
  if ((text.match(/:/g) ?? []).length > 1) {
    throw new ConfigurationError(`${label} IPv6 with a port must use square brackets`);
  }
  const colon = text.indexOf(":");
  const host = colon < 0 ? text : text.slice(0, colon);
  if (colon >= 0) validatePort(text.slice(colon + 1), label);
  if (normalizeIp(host)?.startsWith("4:")) return text;
  if (
    host.length === 0 || host.length > 253 ||
    host.split(".").some((part) => !HOST_LABEL_RE.test(part))
  ) {
    throw new ConfigurationError(`Invalid ${label} host name`);
  }
  if (host.includes(".") && /^[0-9.]+$/.test(host)) {
    throw new ConfigurationError(`Invalid ${label} IPv4 address`);
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
      throw new ConfigurationError(`${label} contains a duplicate value: ${validated}`);
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
    throw new ConfigurationError(`${label} uses an unsupported hash algorithm: ${algorithm}`);
  }
  const digest = stringValue(hash.value, `${label}.hash.value`).toLowerCase();
  if (digest.length !== digestSize * 2 || !/^[0-9a-f]+$/.test(digest)) {
    throw new ConfigurationError(`Invalid ${label}.hash.value length or format`);
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
    throw new ConfigurationError(
      `${label}.scripts contains unknown actions: ${unknownActions.join(", ")}`,
    );
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
    throw new ConfigurationError(`${label}.kind supports only package`);
  }
  const rawPackages = list(item.packages, `${label}.packages`);
  if (rawPackages.length === 0) {
    throw new ConfigurationError(`${label}.packages must not be empty`);
  }
  const packages = rawPackages.map((raw, index) => {
    const text = stringValue(raw, `${label}.packages[${index}]`);
    if (!PACKAGE_MANAGER_RE.test(text)) {
      throw new ConfigurationError(`${label}.packages[${index}] is not a valid package name`);
    }
    return text;
  });
  if (new Set(packages).size !== packages.length) {
    throw new ConfigurationError(`${label}.packages contains duplicate package names`);
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
    throw new ConfigurationError(`${label}.kind supports only script`);
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
    throw new ConfigurationError(`${label}.kind supports only system`);
  }
  const serviceName = stringValue(value.name, `${label}.name`);
  if (!ENVIRONMENT_SERVICE_NAME_RE.test(serviceName) || serviceName.includes("..")) {
    throw new ConfigurationError(`${label}.name is not a valid service name`);
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
    throw new ConfigurationError(`${label}.kind supports only script`);
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
      `${label} ${
        removed.join("/")
      } was removed: secrets are declared only in cluster.yaml.secrets; managed bindings and scripts reference machine-declared secrets directly`,
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
    `Top-level templates in ${label} were removed: deliver template files through management.configs(...) instead`,
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
      throw new ConfigurationError(
        `${itemLabel}.name is not a valid uppercase config variable name`,
      );
    }
    if (seen.has(variableName)) {
      throw new ConfigurationError(`${label} contains a duplicate variable: ${variableName}`);
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
  if (argv.length === 0) throw new ConfigurationError(`${label}.argv must not be empty`);
  argv[0] = runPermission(argv[0], `${label}.argv[0]`);
  if (argv.some((argument) => argument.includes(CANDIDATE_ARG) && argument !== CANDIDATE_ARG)) {
    throw new ConfigurationError(`${CANDIDATE_ARG} in ${label}.argv must be a standalone argument`);
  }
  if (argv.filter((argument) => argument === CANDIDATE_ARG).length !== 1) {
    throw new ConfigurationError(
      `${label}.argv must contain exactly one standalone ${CANDIDATE_ARG} argument`,
    );
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
    throw new ConfigurationError(`Failed to read ${label}.source config ${source}`, { cause });
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
        `\${${secretName}} in config ${configName} is not declared in cluster.yaml.secrets`,
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
        `${itemLabel}.updater was removed: use \${SECRET_NAME} in config values and declare format`,
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
      throw new ConfigurationError(`${itemLabel}.kind supports only file`);
    }
    const configName = `file-${index}`;
    if (names.has(configName)) {
      throw new ConfigurationError(`${label} contains an internal duplicate name: ${configName}`);
    }
    names.add(configName);
    const parsedTarget = managedConfigTarget(
      item.target,
      installDirectory,
      `${itemLabel}.target`,
    );
    if (targets.has(parsedTarget.target)) {
      throw new ConfigurationError(
        `${label} contains a duplicate target path: ${parsedTarget.target}`,
      );
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
      throw new ConfigurationError(`${itemLabel}.variables is incompatible with format: nginx`);
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
    throw new ConfigurationError(`${label}.kind supports only service`);
  }
  const unit = stringValue(item.name, `${label}.name`);
  if (!SYSTEMD_UNIT_RE.test(unit) || unit.includes("..")) {
    throw new ConfigurationError(`${label}.name must be a valid .service unit name`);
  }
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
    throw new ConfigurationError(`${label}.enabled must be a boolean`);
  }
  if (item.daemon_reload !== undefined && typeof item.daemon_reload !== "boolean") {
    throw new ConfigurationError(`${label}.daemon_reload must be a boolean`);
  }
  const tool = enumValue<EnvironmentServiceTool>(
    item.tool ?? "auto",
    new Set(["auto", "systemctl", "service"]),
    `${label}.tool`,
  );
  if (tool === "service") {
    if (item.daemon_reload === true) {
      throw new ConfigurationError(`${label}.daemon_reload is incompatible with tool: service`);
    }
    if (item.enabled !== undefined) {
      throw new ConfigurationError(`${label}.enabled is incompatible with tool: service`);
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
    throw new ConfigurationError(`${label}.unit_config is incompatible with tool: service`);
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
    throw new ConfigurationError(`${label}.kind supports only script`);
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
        `${label.replace(".management", ".configs")}.on_change requires management.kind: service`,
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
      `${label} requires management.kind: service to declare configs.on_change`,
    );
  }
  if (systemService?.unitConfig !== undefined) {
    if (!systemService.daemonReload) {
      throw new ConfigurationError(`${label}.unit_config requires daemon_reload: true`);
    }
    const unitTarget = systemService.unitConfig.target;
    if (fileConfigs.some((config) => config.target === unitTarget)) {
      throw new ConfigurationError(
        `${label} config and service.unit_config must not declare the same target path: ${unitTarget}`,
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
      throw new ConfigurationError(
        `${label} contains a duplicate config script: ${invocation.relativePath}`,
      );
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
    throw new ConfigurationError(`${label}.target file name must match service.unit`);
  }
  const workingDirectory = systemdWorkingDirectory(
    item.working_directory,
    installDirectory,
    `${label}.working_directory`,
  );
  const commandText = argvArgument(item.command, `${label}.command`);
  if (!commandText.includes("/")) {
    throw new ConfigurationError(`${label}.command must be a path, not a bare command name`);
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
        `${label} supports only the ${
          variableBareNames.join(", ")
        } directory variable and no other expansion or quote characters`,
      );
    }
    return remoteDirectoryPath(value, installDirectory, label);
  }
  if (variableCount > 1) {
    throw new ConfigurationError(`${label} must contain exactly one directory variable`);
  }
  const match = Object.entries(MANAGED_TARGET_VARIABLE_PREFIXES).find(
    ([, prefix]) => text === prefix.slice(0, -1) || text.startsWith(prefix),
  );
  if (match === undefined) {
    throw new ConfigurationError(
      `${label} supports only values starting with ${
        variableBareNames.join(", ")
      } or the bare variable`,
    );
  }
  if (installDirectory === undefined) {
    throw new ConfigurationError(
      `${label} uses a directory variable, but the App is missing install_directory`,
    );
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
      `${label} must be followed by a canonical relative path after the directory variable`,
    );
  }
  if (!bareValue && relative === "") {
    throw new ConfigurationError(
      `${label} must be followed by a canonical relative path after the directory variable`,
    );
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
    throw new ConfigurationError(`${label} contains invalid characters`);
  }
  if (posix.isAbsolute(text)) return managedTargetPath(text, label);
  if (
    text === "" || text.startsWith("//") || posix.normalize(text) !== text ||
    text.split("/").some((part) => part === "..")
  ) {
    throw new ConfigurationError(
      `${label} must be a canonical relative POSIX path or a remote absolute path`,
    );
  }
  if (installDirectory === undefined) {
    throw new ConfigurationError(
      `${label} is a relative path, but the App is missing install_directory`,
    );
  }
  const base = posix.normalize(installDirectory);
  const resolved = posix.normalize(posix.join(base, text));
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new ConfigurationError(`${label} escapes the App install directory`);
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
      throw new ConfigurationError(`${label} must be a canonical remote absolute path`);
    }
    return value;
  }
  const normalizedBase = posix.normalize(base);
  const resolved = posix.normalize(posix.join(normalizedBase, value));
  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}/`)) {
    throw new ConfigurationError(`${label} escapes working_directory`);
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
    if (machines.has(machineName)) {
      throw new ConfigurationError(`Duplicate machine name: ${machineName}`);
    }
    const sshPort = item.ssh_port ?? 22;
    if (
      typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535
    ) {
      throw new ConfigurationError(`Invalid ${label}.ssh_port`);
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
    throw new ConfigurationError(`Failed to read config directory: ${parent}`, { cause });
  }
  return entries.sort();
}

async function loadEnvironment(
  directory: string,
  directoryName: string,
  label: string,
): Promise<LoadedEnvironment> {
  const environmentName = name(directoryName, `${label} directory name`);
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
    throw new ConfigurationError(
      `Environment name ${declaredName} must match directory ${directoryName}`,
    );
  }
  const privilege = data.requires_privilege;
  if (privilege !== undefined && privilege !== null && typeof privilege !== "boolean") {
    throw new ConfigurationError(`${label}.requires_privilege must be a boolean`);
  }
  const hasScripts = data.scripts !== undefined && data.scripts !== null;
  const hasLifecycle = data.install !== undefined || data.manager !== undefined;
  if (hasScripts === hasLifecycle) {
    throw new ConfigurationError(
      `${label} must choose exactly one of the legacy top-level scripts or the new install/manager lifecycle`,
    );
  }
  if (hasLifecycle && (data.install === undefined || data.install === null)) {
    throw new ConfigurationError(`${label}.install is a required field of the new lifecycle`);
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
      `cluster.yaml schema_version 2 does not allow the v1 Environment layout: ${
        legacyDirectories.map((item) => `environments/${item}/<environment>`).join(", ")
      }`,
    );
  }

  const definitionNames = directoryNames.map((directoryName) =>
    name(directoryName, `environment[${directoryName}] directory name`)
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
      `cluster.yaml Environment mapping is inconsistent; missing=${
        JSON.stringify(missing)
      } unknown=${JSON.stringify(unknown)}`,
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
      throw new ConfigurationError(
        `Environment ${environmentName} requires at least one target machine`,
      );
    }
    const unknownMachines = assigned.filter((machineName) => !machines.has(machineName));
    if (unknownMachines.length > 0) {
      throw new ConfigurationError(
        `Environment ${environmentName} references unknown machines: ${unknownMachines.join(", ")}`,
      );
    }

    const directory = join(parent, environmentName);
    if (!(await isFile(join(directory, "environment.yaml")))) {
      throw new ConfigurationError(
        `cluster.yaml schema_version 2 requires a shared definition: environments/${environmentName}/environment.yaml`,
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
    `Top-level scripts in ${label} were removed: use configs.kind: script for config scripts and management.kind: script for service scripts`,
  );
}

function deploymentDefinition(value: unknown, label: string): DeploymentDefinition {
  const item = mapping(value, label);
  fields(item, ["kind"], ["kind"], label);
  if (item.kind !== "versioned") {
    throw new ConfigurationError(`${label}.kind supports only versioned in this version`);
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
    const key = name(appName, `${entryLabel} name`);
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
        "app_versions.yaml declares Apps, but the cluster apps directory does not exist",
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
      throw new ConfigurationError(`${label}.packageless must be a boolean`);
    }
    const packageless = data.packageless === true;
    const appName = name(data.name, `${label}.name`);
    if (appName !== directoryName) {
      throw new ConfigurationError(`App name ${appName} must match directory ${directoryName}`);
    }
    if (appVersions === undefined) {
      throw new ConfigurationError(
        `App ${appName} uses schema 1, but the cluster is missing app_versions.yaml`,
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
          `packageless App ${appName} must not have app_versions.yaml version records`,
        );
      }
    } else if (!entry) {
      throw new ConfigurationError(
        `app_versions.yaml is missing a version record for App ${appName}`,
      );
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
        throw new ConfigurationError(`${label}.deployment cannot be used for a packageless App`);
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
      throw new ConfigurationError(`${label}.configs.file requires management.run_as`);
    }
    if (deployment !== undefined && management?.runAs === undefined) {
      throw new ConfigurationError(
        `${label}.deployment.versioned requires management.run_as`,
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
        `app_versions.yaml declares unknown Apps: ${unknownVersions.join(", ")}`,
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
      throw new ConfigurationError(`Secret ${secretName} is not declared in cluster.yaml.secrets`);
    }
    if (kind !== undefined && declaration.kind !== kind) {
      throw new ConfigurationError(
        `Secret ${secretName} type conflict: the App requires ${kind} but cluster.yaml declares ${declaration.kind}`,
      );
    }
    if (!declaration.machines.includes(machineName)) {
      throw new ConfigurationError(
        `Secret ${secretName} is not declared for machine ${machineName}`,
      );
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
          `${machine.name}/${environment.name} references an unknown environment definition: ${environment.definition}`,
        );
      }
      for (const dependency of environment.dependsOn) {
        const target = dependency.includes("/") ? dependency : `${machine.name}/${dependency}`;
        if (!environmentIds.has(target)) {
          throw new ConfigurationError(
            `${machine.name}/${environment.name} references an unknown environment instance: ${dependency}`,
          );
        }
        if (!dependency.includes("/") && !local.has(dependency)) {
          throw new ConfigurationError(
            `${machine.name}/${environment.name} references an unknown local environment instance: ${dependency}`,
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
            `App ${appName} on ${machineName} references an unknown environment instance: ${dependency}`,
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
  if (!rawDirectory) {
    throw new ConfigurationError(`Cluster directory does not exist: ${String(directory)}`);
  }
  const root = resolve(rawDirectory);
  if (!(await isDirectory(root))) {
    throw new ConfigurationError(`Cluster directory does not exist: ${root}`);
  }
  const realRoot = await Deno.realPath(root);
  const clusterData = await loadYaml(join(realRoot, "cluster.yaml"));
  clusterSchemaVersion(clusterData);
  fields(
    clusterData,
    [
      "schema_version",
      "name",
      "executor_region",
      "environments",
      "apps",
      "secrets",
      "deployer_version",
    ],
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
      `cluster.yaml App mapping is inconsistent; missing=${JSON.stringify(missingApps)} unknown=${
        JSON.stringify(unknownApps)
      }`,
    );
  }
  const placements = new Map<string, readonly string[]>();
  for (const [appName, rawMachines] of Object.entries(placementData)) {
    const assigned = stringList(rawMachines, `cluster.yaml.apps.${appName}`);
    if (assigned.length === 0) {
      throw new ConfigurationError(`App ${appName} requires at least one target machine`);
    }
    const unknown = assigned.filter((machine) => !machines.has(machine)).sort();
    if (unknown.length > 0) {
      throw new ConfigurationError(
        `App ${appName} references unknown machines: ${unknown.join(", ")}`,
      );
    }
    placements.set(appName, assigned);
  }
  validateDependencies(machines, definitions, apps, placements, secrets);
  const deployerVersion = clusterData.deployer_version === undefined
    ? undefined
    : exactDeployerVersion(clusterData.deployer_version);
  return Object.freeze({
    name: name(clusterData.name, "cluster.yaml.name"),
    directory: realRoot,
    executorRegion: name(clusterData.executor_region, "cluster.yaml.executor_region"),
    ...(deployerVersion === undefined ? {} : { deployerVersion }),
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
