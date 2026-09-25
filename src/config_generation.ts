/** 控制端配置骨架生成：只解析普通参数，绝不接收或读取秘密值。 */

import { parse as parseIni, stringify as stringifyIni } from "jsr:@std/ini@0.225.2";
import { parse as parseToml, stringify as stringifyToml } from "jsr:@std/toml@1.0.11";
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@1.2.0";
import { createHash } from "node:crypto";
import { PreflightError } from "./errors.ts";
import type {
  ManagedConfigFile,
  ManagedConfigFormat,
  ManagedConfigPathSegment,
  ManagedConfigValueType,
  ManagedFileFormat,
  ManagedSecretReference,
} from "./types.ts";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();
const RESERVED_MARKER_PREFIX = "__SFO_";
const SECRET_MARKER_PREFIX = "__SFO_SECRET_";
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
export const APP_VERSION_PLACEHOLDER = "${APP_VERSION}";
const SECRET_PLACEHOLDER_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const SECRET_PLACEHOLDER_CANDIDATE_RE = /\$\{([^{}]*)\}/g;
const MACHINE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** version 字符串既是版本目录名，也是配置上下文值；统一 fail-closed 校验。 */
export function isValidAppVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) &&
    !value.includes(RESERVED_MARKER_PREFIX)
  );
}

export interface ConfigSkeletonSecretBinding {
  readonly secret: string;
  readonly secretKind: "value" | "file";
  readonly encoding: "utf8" | "path";
  readonly valueType: ManagedConfigValueType;
  /** 整值占位符 marker；远端按声明类型转成标量。 */
  readonly marker: string;
  /** 嵌入字符串占位符 marker；远端按原文字符串替换。 */
  readonly textMarker: string;
}

export interface GeneratedConfigSkeleton {
  readonly name: string;
  readonly format: ManagedFileFormat;
  readonly content: Uint8Array;
  readonly size: number;
  readonly sha256: string;
  readonly secretBindings: readonly ConfigSkeletonSecretBinding[];
}

/** app 模板中普通变量的完整值占位符。 */
export function configVariableMarker(name: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new PreflightError(`Invalid config variable name: ${name}`);
  }
  return `__SFO_CONFIG_VAR_V1_${name}__`;
}

/** 解析受支持的结构化配置；装载面与骨架渲染共用唯一 parser 入口。 */
export function parseManagedStructured(
  format: ManagedConfigFormat,
  text: string,
  name: string,
): unknown {
  try {
    if (format === "nginx") {
      throw new PreflightError(
        `Config ${name} does not support structured parsing for format: nginx`,
      );
    }
    if (format === "yaml") return requireContainer(parseYaml(text, { allowDuplicateKeys: false }));
    if (format === "json") {
      rejectDuplicateJsonKeys(text);
      return requireContainer(JSON.parse(text));
    }
    if (format === "toml") return requireContainer(parseToml(text));
    rejectDuplicateIniKeys(text, name);
    return requireContainer(parseIni(text));
  } catch (cause) {
    if (cause instanceof PreflightError) throw cause;
    throw new PreflightError(`Failed to parse ${format.toUpperCase()} config ${name}`, { cause });
  }
}

/** Nginx 原生配置只做文本安全边界检查，不做 DSL 解析。 */
export function validateManagedPlainText(
  text: string,
  name: string,
  machineNames: ReadonlySet<string> = new Set(),
): void {
  if (text.includes(RESERVED_MARKER_PREFIX)) {
    throw new PreflightError(
      `Config ${name} source file contains a framework-reserved placeholder`,
    );
  }
  const invalid = [...text.matchAll(SECRET_PLACEHOLDER_CANDIDATE_RE)]
    .find((match) => !machineNames.has(match[1]!));
  if (invalid !== undefined) {
    throw new PreflightError(
      `Config ${name} does not support the placeholder: \${${invalid?.[1] ?? ""}}`,
    );
  }
}

/** 收集结构化值中的占位符；键名或非法占位符失败关闭。 */
export function collectManagedPlaceholders(
  value: unknown,
  name: string,
): ReadonlySet<string> {
  const names = new Set<string>();
  visit(value, name, names);
  return Object.freeze(names);

  function visit(item: unknown, configName: string, found: Set<string>): void {
    if (typeof item === "string") {
      const invalid = [...item.matchAll(SECRET_PLACEHOLDER_CANDIDATE_RE)]
        .map((match) => match[1]!)
        .find((name) => !MACHINE_NAME_PATTERN.test(name));
      if (invalid !== undefined) {
        throw new PreflightError(
          `Invalid placeholder name in config ${configName}: \${${invalid}}`,
        );
      }
      for (const match of item.matchAll(SECRET_PLACEHOLDER_CANDIDATE_RE)) found.add(match[1]!);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, configName, found));
      return;
    }
    if (!isPlainRecord(item)) return;
    for (const key of Object.keys(item)) {
      if (key.includes("${") || key.includes(RESERVED_MARKER_PREFIX)) {
        throw new PreflightError(
          `Config ${configName} keys must not contain placeholders or framework-reserved markers`,
        );
      }
      visit(item[key], configName, found);
    }
  }
}

/**
 * 从已严格装载的 ManagedConfigFile 生成无秘密骨架。
 * 秘密占位符只转换为 marker/描述符，控制端不接受 secret provider。
 */
export async function generateConfigSkeleton(
  config: ManagedConfigFile,
  parameters: Readonly<Record<string, unknown>>,
  targetRegion?: string,
): Promise<GeneratedConfigSkeleton> {
  if (config.format === "systemd") {
    throw new PreflightError(`Config ${config.name} does not support systemd format`);
  }
  const format = config.format;
  const source = await readStableConfig(config.source, config.name);
  let text: string;
  try {
    text = TEXT_DECODER.decode(source);
  } catch (cause) {
    throw new PreflightError(`Config ${config.name} must be valid UTF-8 text`, { cause });
  }
  if (text.includes(SECRET_MARKER_PREFIX)) {
    throw new PreflightError(
      `Config ${config.name} source file contains a framework-reserved placeholder`,
    );
  }

  if (format === "nginx") {
    if (config.variables.length > 0) {
      throw new PreflightError(
        `Config ${config.name} with format: nginx does not support variables`,
      );
    }
    if (config.secretReferences.size > 0) {
      throw new PreflightError(
        `Config ${config.name} with format: nginx does not support secret placeholders`,
      );
    }
    validateManagedPlainText(
      text,
      config.name,
      new Set(config.machineReferences?.keys() ?? []),
    );
    const plainContent = TEXT_ENCODER.encode(
      replaceMachinePlaceholders(text, config, targetRegion),
    );
    if (plainContent.byteLength > MAX_CONFIG_BYTES) {
      throw new PreflightError(
        `Config ${config.name} skeleton exceeds the ${MAX_CONFIG_BYTES} byte limit`,
      );
    }
    return Object.freeze({
      name: config.name,
      format: config.format,
      content: plainContent,
      size: plainContent.byteLength,
      sha256: sha256Bytes(plainContent),
      secretBindings: Object.freeze([]),
    });
  }

  const parsed = parseManagedStructured(format, text, config.name);
  if (!config.secretReferences.has("APP_VERSION")) {
    replaceBuiltInAppVersion(parsed, config, parameters);
  }
  walkMutable(parsed, config.name, (value, assign) => {
    if (typeof value !== "string") return;
    const replaced = replaceMachinePlaceholders(value, config, targetRegion);
    if (replaced !== value) assign(replaced);
  });
  replaceStructuredVariables(parsed, config, parameters);
  const bindings = secretBindings(config.name, config.secretReferences);
  const markers = new Map(bindings.map((binding) => [binding.secret, binding]));
  const wholeCounts = new Map<string, number>();
  const textCounts = new Map<string, number>();
  rejectInvalidPlaceholders(parsed, config.name);
  replaceSecretPlaceholders(parsed, config.name, markers, wholeCounts, textCounts);
  for (const binding of bindings) {
    if (
      (wholeCounts.get(binding.secret) ?? 0) === 0 && (textCounts.get(binding.secret) ?? 0) === 0
    ) {
      throw new PreflightError(
        `Secret placeholder ${binding.secret} of config ${config.name} does not appear in the value`,
      );
    }
  }
  const rendered = stringifyStructured(format, canonicalize(parsed), config.name);
  parseManagedStructured(format, rendered, config.name);

  const content = TEXT_ENCODER.encode(rendered);
  if (content.byteLength > MAX_CONFIG_BYTES) {
    throw new PreflightError(
      `Config ${config.name} skeleton exceeds the ${MAX_CONFIG_BYTES} byte limit`,
    );
  }
  return Object.freeze({
    name: config.name,
    format: config.format,
    content,
    size: content.byteLength,
    sha256: sha256Bytes(content),
    secretBindings: Object.freeze(bindings),
  });
}

function replaceMachinePlaceholders(
  text: string,
  config: ManagedConfigFile,
  targetRegion: string | undefined,
): string {
  const references = config.machineReferences;
  if (references === undefined || references.size === 0) return text;
  return text.replace(SECRET_PLACEHOLDER_CANDIDATE_RE, (placeholder, name: string) => {
    const machine = references.get(name);
    if (machine === undefined) return placeholder;
    if (targetRegion === undefined) {
      throw new PreflightError(
        `Config ${config.name} uses ${placeholder}, but the target machine region is unavailable`,
      );
    }
    const sameRegion = machine.region === targetRegion;
    const address = sameRegion
      ? machine.privateIp[0] ?? machine.publicIp[0]
      : machine.publicIp[0];
    if (address === undefined) {
      throw new PreflightError(
        `Config ${config.name} uses ${placeholder}, but machine ${name} has no required ${sameRegion ? "private or public" : "public"} IP for target region ${targetRegion}`,
      );
    }
    return address;
  });
}

function secretBindings(
  configName: string,
  references: ReadonlyMap<string, ManagedSecretReference>,
): ConfigSkeletonSecretBinding[] {
  return [...references.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([secret, reference], index) => {
      const identity = JSON.stringify({
        config: configName,
        index,
        secret,
        kind: reference.kind,
        type: reference.valueType,
        encoding: reference.kind === "file" ? "path" : "utf8",
      });
      const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 32).toUpperCase();
      return Object.freeze({
        secret,
        secretKind: reference.kind,
        encoding: reference.kind === "file" ? "path" as const : "utf8" as const,
        valueType: reference.valueType,
        marker: `__SFO_SECRET_V1_${suffix}__`,
        textMarker: `__SFO_SECRET_TEXT_V1_${suffix}__`,
      });
    });
}

function replaceBuiltInAppVersion(
  root: unknown,
  config: ManagedConfigFile,
  parameters: Readonly<Record<string, unknown>>,
): void {
  walkMutable(root, config.name, (value, assign) => {
    if (typeof value !== "string" || !value.includes(APP_VERSION_PLACEHOLDER)) return;
    assign(value.replaceAll(APP_VERSION_PLACEHOLDER, requiredAppVersion(config, parameters)));
  });
}

function requiredAppVersion(
  config: ManagedConfigFile,
  parameters: Readonly<Record<string, unknown>>,
): string {
  const value = parameters.version;
  if (!isValidAppVersion(value)) {
    throw new PreflightError(
      `Config ${config.name} uses ${APP_VERSION_PLACEHOLDER}, but the App step has no valid version`,
    );
  }
  return value;
}

function replaceSecretPlaceholders(
  root: unknown,
  configName: string,
  markers: ReadonlyMap<string, ConfigSkeletonSecretBinding>,
  wholeCounts: Map<string, number>,
  textCounts: Map<string, number>,
): void {
  walkMutable(root, configName, (value, assign) => {
    if (typeof value !== "string") return;
    const exact = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(value);
    if (exact) {
      const name = exact[1]!;
      const binding = requiredMarker(configName, markers, name);
      wholeCounts.set(name, (wholeCounts.get(name) ?? 0) + 1);
      assign(binding.marker);
      return;
    }
    let replaced = false;
    const rendered = value.replace(
      SECRET_PLACEHOLDER_RE,
      (_match, name: string) => {
        const binding = requiredMarker(configName, markers, name);
        if (binding.valueType !== "string") {
          throw new PreflightError(
            `Config ${configName} ${name} is ${binding.valueType} and can only be a whole-value placeholder`,
          );
        }
        textCounts.set(name, (textCounts.get(name) ?? 0) + 1);
        replaced = true;
        return binding.textMarker;
      },
    );
    if (replaced) assign(rendered);
  });
  rejectInvalidPlaceholders(root, configName);
}

function requiredMarker(
  configName: string,
  markers: ReadonlyMap<string, ConfigSkeletonSecretBinding>,
  name: string,
): ConfigSkeletonSecretBinding {
  const binding = markers.get(name);
  if (binding === undefined) {
    throw new PreflightError(
      `Placeholder \${${name}} in config ${configName} has no declared secret`,
    );
  }
  return binding;
}

function rejectInvalidPlaceholders(value: unknown, configName: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => rejectInvalidPlaceholders(item, configName));
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const item of Object.values(value)) {
    if (typeof item === "string") {
      const invalid = [...item.matchAll(SECRET_PLACEHOLDER_CANDIDATE_RE)]
        .map((match) => match[1]!)
        .find((name) => !SECRET_NAME_PATTERN.test(name));
      if (invalid !== undefined) {
        throw new PreflightError(
          `Invalid placeholder name in config ${configName}: \${${invalid}}`,
        );
      }
    }
    rejectInvalidPlaceholders(item, configName);
  }
}

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function replaceStructuredVariables(
  root: unknown,
  config: ManagedConfigFile,
  parameters: Readonly<Record<string, unknown>>,
): void {
  const expected = new Map(
    config.variables.map((binding) => [configVariableMarker(binding.name), binding]),
  );
  const counts = new Map<string, number>();
  walkMutable(root, config.name, (value, assign) => {
    if (typeof value !== "string") return;
    const binding = expected.get(value);
    if (binding === undefined) return;
    counts.set(value, (counts.get(value) ?? 0) + 1);
    assign(typedParameter(parameters, binding.parameterPath, binding.valueType, binding.name));
  });
  for (const marker of expected.keys()) {
    const count = counts.get(marker) ?? 0;
    if (count !== 1) {
      throw new PreflightError(
        `Config ${config.name} variable ${
          expected.get(marker)!.name
        } must appear exactly once as a whole value; actual count ${count}`,
      );
    }
  }
}

function typedParameter(
  parameters: Readonly<Record<string, unknown>>,
  path: readonly ManagedConfigPathSegment[],
  type: ManagedConfigValueType,
  name: string,
): string | number | boolean {
  let value: unknown = parameters;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(value) || segment >= value.length) {
        throw new PreflightError(`Config variable ${name} parameter path does not exist`);
      }
      value = value[segment];
    } else {
      if (!isPlainRecord(value) || !Object.hasOwn(value, segment)) {
        throw new PreflightError(`Config variable ${name} parameter path does not exist`);
      }
      value = value[segment];
    }
  }
  if (type === "string" && typeof value === "string") {
    if (value.includes(RESERVED_MARKER_PREFIX)) {
      throw new PreflightError(
        `Config variable ${name} value contains a framework-reserved marker`,
      );
    }
    return value;
  }
  if (type === "boolean" && typeof value === "boolean") return value;
  if (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
  throw new PreflightError(`Config variable ${name} parameter value does not match type ${type}`);
}

function stringifyStructured(
  format: ManagedConfigFormat,
  value: unknown,
  name: string,
): string {
  try {
    if (format === "yaml") {
      return stringifyYaml(value, { sortKeys: true, lineWidth: -1, useAnchors: false });
    }
    if (format === "json") return `${JSON.stringify(value, undefined, 2)}\n`;
    if (format === "toml") return stringifyToml(value as Record<string, unknown>);
    return stringifyIni(value);
  } catch (cause) {
    throw new PreflightError(`Failed to serialize ${format.toUpperCase()} config ${name}`, {
      cause,
    });
  }
}

function walkMutable(
  value: unknown,
  configName: string,
  visit: (value: unknown, assign: (next: unknown) => void) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visit(item, (next) => value[index] = next);
      walkMutable(value[index], configName, visit);
    });
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (key.includes(RESERVED_MARKER_PREFIX) || key.includes("${")) {
      throw new PreflightError(
        "Config keys must not contain placeholders or framework-reserved markers",
      );
    }
    const item = value[key];
    visit(item, (next) => value[key] = next);
    walkMutable(value[key], configName, visit);
  }
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new PreflightError("Config contains a circular reference");
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainRecord(value)) return value;
  if (seen.has(value)) throw new PreflightError("Config contains a circular reference");
  seen.add(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
  seen.delete(value);
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireContainer(value: unknown): unknown {
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new PreflightError("Config top level must be a mapping or a list");
  }
  return value;
}

async function readStableConfig(path: string, name: string): Promise<Uint8Array> {
  let before: Deno.FileInfo;
  let content: Uint8Array;
  let after: Deno.FileInfo;
  try {
    before = await Deno.lstat(path);
    if (!before.isFile || before.isSymlink) throw new Error("not a regular file");
    if (before.size > MAX_CONFIG_BYTES) throw new Error("too large");
    content = await Deno.readFile(path);
    after = await Deno.lstat(path);
  } catch (cause) {
    throw new PreflightError(`Failed to read config ${name} consistently`, { cause });
  }
  if (!sameFileIdentity(before, after) || content.byteLength !== before.size) {
    throw new PreflightError(`Source file changed while reading config ${name}`);
  }
  return content;
}

function sameFileIdentity(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  return left.isFile && right.isFile && !left.isSymlink && !right.isSymlink &&
    left.size === right.size && left.mtime?.getTime() === right.mtime?.getTime() &&
    (left.ino === null || right.ino === null || left.ino === right.ino) &&
    (left.dev === null || right.dev === null || left.dev === right.dev);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 拒绝 JSON 对象内重复键；JSON.parse 本身会静默保留最后一个值。 */
function rejectDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(text[index] ?? "")) index++;
  };
  const stringToken = (): string => {
    const start = index++;
    let escaped = false;
    while (index < text.length) {
      const character = text[index++];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return JSON.parse(text.slice(start, index));
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const value = (): void => {
    whitespace();
    if (text[index] === "{") return object();
    if (text[index] === "[") return array();
    if (text[index] === '"') {
      stringToken();
      return;
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/
      .exec(text.slice(index));
    if (!match) throw new SyntaxError("invalid JSON value");
    index += match[0].length;
  };
  const object = (): void => {
    index++;
    whitespace();
    const keys = new Set<string>();
    if (text[index] === "}") {
      index++;
      return;
    }
    while (true) {
      whitespace();
      if (text[index] !== '"') throw new SyntaxError("JSON object key must be a string");
      const key = stringToken();
      if (keys.has(key)) throw new PreflightError(`JSON config contains a duplicate key: ${key}`);
      keys.add(key);
      whitespace();
      if (text[index++] !== ":") throw new SyntaxError("missing JSON colon");
      value();
      whitespace();
      const delimiter = text[index++];
      if (delimiter === "}") return;
      if (delimiter !== ",") throw new SyntaxError("invalid JSON object delimiter");
    }
  };
  const array = (): void => {
    index++;
    whitespace();
    if (text[index] === "]") {
      index++;
      return;
    }
    while (true) {
      value();
      whitespace();
      const delimiter = text[index++];
      if (delimiter === "]") return;
      if (delimiter !== ",") throw new SyntaxError("invalid JSON object delimiter");
    }
  };
  value();
  whitespace();
  if (index !== text.length) throw new SyntaxError("trailing JSON content");
}

function rejectDuplicateIniKeys(text: string, name: string): void {
  let section = "";
  const seenSections = new Set<string>();
  const seenKeys = new Set<string>();
  for (const [lineIndex, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (seenSections.has(section)) {
        throw new PreflightError(`INI config ${name} contains a duplicate section: ${section}`);
      }
      seenSections.add(section);
      continue;
    }
    const keyMatch = /^([^=:#][^=:]*?)\s*[=:]/.exec(line);
    if (!keyMatch) continue;
    const identity = `${section}\0${keyMatch[1].trim()}`;
    if (seenKeys.has(identity)) {
      throw new PreflightError(`INI config ${name} line ${lineIndex + 1} contains a duplicate key`);
    }
    seenKeys.add(identity);
  }
}
