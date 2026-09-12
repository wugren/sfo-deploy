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
const SECRET_PLACEHOLDER_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const SECRET_PLACEHOLDER_CANDIDATE_RE = /\$\{([^{}]*)\}/g;

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
    throw new PreflightError(`配置变量名称不合法: ${name}`);
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
      throw new PreflightError(`配置 ${name} 不支持结构化解析 format: nginx`);
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
    throw new PreflightError(`无法解析 ${format.toUpperCase()} 配置 ${name}`, { cause });
  }
}

/** Nginx 原生配置只做文本安全边界检查，不做 DSL 解析。 */
export function validateManagedPlainText(text: string, name: string): void {
  if (text.includes(RESERVED_MARKER_PREFIX)) {
    throw new PreflightError(`配置 ${name} 源文件包含框架保留占位符`);
  }
  const invalid = SECRET_PLACEHOLDER_CANDIDATE_RE.exec(text);
  if (invalid !== null) {
    throw new PreflightError(`配置 ${name} 不支持占位符: \${${invalid?.[1] ?? ""}}`);
  }
}

/** 收集结构化值中的 `${SECRET_NAME}`；键名或非法占位符失败关闭。 */
export function collectManagedSecretPlaceholders(
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
        .find((name) => !SECRET_NAME_PATTERN.test(name));
      if (invalid !== undefined) {
        throw new PreflightError(`配置 ${configName} 的占位符名称不合法: \${${invalid}}`);
      }
      for (const match of item.matchAll(SECRET_PLACEHOLDER_RE)) found.add(match[1]!);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, configName, found));
      return;
    }
    if (!isPlainRecord(item)) return;
    for (const key of Object.keys(item)) {
      if (key.includes("${") || key.includes(RESERVED_MARKER_PREFIX)) {
        throw new PreflightError(`配置 ${configName} 的键名不能包含占位符或框架保留标记`);
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
): Promise<GeneratedConfigSkeleton> {
  if (config.format === "systemd") {
    throw new PreflightError(`配置 ${config.name} 不支持 systemd format`);
  }
  const format = config.format;
  const source = await readStableConfig(config.source, config.name);
  let text: string;
  try {
    text = TEXT_DECODER.decode(source);
  } catch (cause) {
    throw new PreflightError(`配置 ${config.name} 必须是有效 UTF-8 文本`, { cause });
  }
  if (text.includes(SECRET_MARKER_PREFIX)) {
    throw new PreflightError(`配置 ${config.name} 源文件包含框架保留占位符`);
  }

  if (format === "nginx") {
    if (config.variables.length > 0) {
      throw new PreflightError(`配置 ${config.name} 的 format: nginx 不支持 variables`);
    }
    if (config.secretReferences.size > 0) {
      throw new PreflightError(`配置 ${config.name} 的 format: nginx 不支持秘密占位符`);
    }
    validateManagedPlainText(text, config.name);
    const plainContent = TEXT_ENCODER.encode(text);
    if (plainContent.byteLength > MAX_CONFIG_BYTES) {
      throw new PreflightError(`配置 ${config.name} 骨架超过 ${MAX_CONFIG_BYTES} 字节限制`);
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
  replaceStructuredVariables(parsed, config, parameters);
  const bindings = secretBindings(config.name, config.secretReferences);
  const markers = new Map(bindings.map((binding) => [binding.secret, binding]));
  const wholeCounts = new Map<string, number>();
  const textCounts = new Map<string, number>();
  replaceSecretPlaceholders(parsed, config.name, markers, wholeCounts, textCounts);
  for (const binding of bindings) {
    if (
      (wholeCounts.get(binding.secret) ?? 0) === 0 && (textCounts.get(binding.secret) ?? 0) === 0
    ) {
      throw new PreflightError(`配置 ${config.name} 的秘密 ${binding.secret} 占位符未出现在值中`);
    }
  }
  const rendered = stringifyStructured(format, canonicalize(parsed), config.name);
  parseManagedStructured(format, rendered, config.name);

  const content = TEXT_ENCODER.encode(rendered);
  if (content.byteLength > MAX_CONFIG_BYTES) {
    throw new PreflightError(`配置 ${config.name} 骨架超过 ${MAX_CONFIG_BYTES} 字节限制`);
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
            `配置 ${configName} 的 ${name} 是 ${binding.valueType}，只能作为完整值占位符`,
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
    throw new PreflightError(`配置 ${configName} 的占位符 \${${name}} 未声明秘密`);
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
        throw new PreflightError(`配置 ${configName} 的占位符名称不合法: \${${invalid}}`);
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
        `配置 ${config.name} 的变量 ${
          expected.get(marker)!.name
        } 必须且只能作为完整值出现一次，实际 ${count} 次`,
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
        throw new PreflightError(`配置变量 ${name} 的参数路径不存在`);
      }
      value = value[segment];
    } else {
      if (!isPlainRecord(value) || !Object.hasOwn(value, segment)) {
        throw new PreflightError(`配置变量 ${name} 的参数路径不存在`);
      }
      value = value[segment];
    }
  }
  if (type === "string" && typeof value === "string") {
    if (value.includes(RESERVED_MARKER_PREFIX)) {
      throw new PreflightError(`配置变量 ${name} 的值包含框架保留标记`);
    }
    return value;
  }
  if (type === "boolean" && typeof value === "boolean") return value;
  if (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
  throw new PreflightError(`配置变量 ${name} 的参数值不符合 ${type} 类型`);
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
    throw new PreflightError(`无法序列化 ${format.toUpperCase()} 配置 ${name}`, { cause });
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
      throw new PreflightError("配置键名中不允许出现占位符或框架保留标记");
    }
    const item = value[key];
    visit(item, (next) => value[key] = next);
    walkMutable(value[key], configName, visit);
  }
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new PreflightError("配置包含循环引用");
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainRecord(value)) return value;
  if (seen.has(value)) throw new PreflightError("配置包含循环引用");
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
    throw new PreflightError("配置顶层必须是映射或列表");
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
    throw new PreflightError(`无法稳定读取配置 ${name}`, { cause });
  }
  if (!sameFileIdentity(before, after) || content.byteLength !== before.size) {
    throw new PreflightError(`读取配置 ${name} 时源文件发生变化`);
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
      if (keys.has(key)) throw new PreflightError(`JSON 配置包含重复键: ${key}`);
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
        throw new PreflightError(`INI 配置 ${name} 包含重复 section: ${section}`);
      }
      seenSections.add(section);
      continue;
    }
    const keyMatch = /^([^=:#][^=:]*?)\s*[=:]/.exec(line);
    if (!keyMatch) continue;
    const identity = `${section}\0${keyMatch[1].trim()}`;
    if (seenKeys.has(identity)) {
      throw new PreflightError(`INI 配置 ${name} 第 ${lineIndex + 1} 行包含重复键`);
    }
    seenKeys.add(identity);
  }
}
