/** 目标节点固定配置渲染器：解析结构化配置后按 marker 注入，再复解析。 */

import { parse as parseIni, stringify as stringifyIni } from "jsr:@std/ini@0.225.2";
import { parse as parseToml, stringify as stringifyToml } from "jsr:@std/toml@1.0.11";
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@1.2.0";

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_BINDINGS_BYTES = 1024 * 1024;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MARKER_RE = /^__SFO_SECRET(?:_TEXT)?_V1_[0-9A-F]{32}__$/;
const RESERVED_MARKER = "__SFO_SECRET_";
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

type ConfigFormat = "yaml" | "json" | "toml" | "ini" | "nginx";
type ValueType = "string" | "integer" | "number" | "boolean";

interface Binding {
  readonly secret: string;
  readonly kind: "value" | "file";
  readonly encoding: "utf8" | "path";
  readonly type: ValueType;
  readonly marker: string;
  readonly textMarker: string;
  found: boolean;
}

interface BindingManifest {
  readonly format: ConfigFormat;
  readonly bindings: readonly Binding[];
}

export interface UpdateConfigOptions {
  readonly format: ConfigFormat;
  readonly input: string;
  readonly bindings: string;
  readonly secrets: string;
  readonly secretRoot: string;
  readonly output: string;
}

export async function updateConfig(options: UpdateConfigOptions): Promise<void> {
  const input = safeAbsoluteFile(options.input, "config skeleton");
  const bindingsPath = safeAbsoluteFile(options.bindings, "binding manifest");
  const secretDir = safeAbsoluteDirectory(options.secrets, "secret directory");
  const secretRoot = safeAbsoluteDirectory(options.secretRoot, "stable secret directory");
  const output = safeAbsoluteFile(options.output, "config candidate");
  if (
    output === input || output === bindingsPath || output.startsWith(`${secretDir}/`) ||
    output.startsWith(`${secretRoot}/`)
  ) throw new Error("Config candidate path conflicts with a read-only input");

  const skeleton = decodeUtf8(
    await readRegularFile(input, MAX_CONFIG_BYTES, "config skeleton"),
    "config skeleton",
  );
  const manifest = parseManifest(
    decodeUtf8(
      await readRegularFile(bindingsPath, MAX_BINDINGS_BYTES, "binding manifest"),
      "binding manifest",
    ),
    options.format,
  );
  if (options.format === "nginx") {
    if (manifest.bindings.length > 0) {
      throw new Error("NGINX config does not support secret bindings");
    }
    if (skeleton.includes(RESERVED_MARKER)) {
      throw new Error("NGINX config contains a framework-reserved placeholder");
    }
    const invalid = /\$\{([^{}]*)\}/.exec(skeleton);
    if (invalid !== null) {
      throw new Error(`NGINX config does not support the placeholder: \${${invalid?.[1] ?? ""}}`);
    }
    const content = encoder.encode(skeleton);
    if (content.byteLength > MAX_CONFIG_BYTES) {
      throw new Error("Config candidate exceeds the size limit");
    }
    await Deno.writeFile(output, content, { createNew: true, mode: 0o600 });
    await Deno.chmod(output, 0o600);
    return;
  }
  const parsed = parseStructured(skeleton, options.format);
  for (const binding of manifest.bindings) {
    const raw = await bindingValue(binding, secretDir, secretRoot);
    replaceMarkers(parsed, binding, raw);
  }
  const rendered = stringifyStructured(parsed, options.format);
  if (rendered.includes(RESERVED_MARKER)) {
    throw new Error("Config candidate still contains secret placeholders");
  }
  validateRendered(rendered, options.format);
  const content = encoder.encode(rendered);
  if (content.byteLength > MAX_CONFIG_BYTES) {
    throw new Error("Config candidate exceeds the size limit");
  }
  await Deno.writeFile(output, content, { createNew: true, mode: 0o600 });
  await Deno.chmod(output, 0o600);
}

export async function validateCandidate(path: string): Promise<void> {
  const content = decodeUtf8(
    await readRegularFile(
      safeAbsoluteFile(path, "config candidate"),
      MAX_CONFIG_BYTES,
      "config candidate",
    ),
    "config candidate",
  );
  if (content.includes(RESERVED_MARKER)) {
    throw new Error("Config candidate still contains secret placeholders");
  }
}

async function bindingValue(
  binding: Binding,
  secretDir: string,
  secretRoot: string,
): Promise<string> {
  if (binding.kind === "file") {
    if (binding.encoding !== "path" || binding.type !== "string") {
      throw new Error(`file binding for secret ${binding.secret} must be a string path`);
    }
    const path = `${secretRoot}/${binding.secret}`;
    const info = await Deno.stat(path);
    if (!info.isFile) {
      throw new Error(`file path for secret ${binding.secret} is not a regular file`);
    }
    return path;
  }
  if (binding.encoding !== "utf8") throw new Error(`Invalid encoding for secret ${binding.secret}`);
  return typedValue(
    decodeUtf8(
      await readRegularFile(
        `${secretDir}/${binding.secret}`,
        MAX_CONFIG_BYTES,
        `secret ${binding.secret}`,
      ),
      `secret ${binding.secret}`,
    ),
    binding.type,
  );
}

function parseManifest(text: string, format: ConfigFormat): BindingManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Binding manifest is not valid JSON");
  }
  const root = record(value, "binding manifest");
  exactKeys(root, ["schema_version", "config", "format", "bindings"], "binding manifest");
  if (root.schema_version !== 1 || root.format !== format || typeof root.config !== "string") {
    throw new Error("Binding manifest identity does not match");
  }
  if (!Array.isArray(root.bindings) || root.bindings.length > 1024) {
    throw new Error("Invalid binding manifest bindings");
  }
  const bindings = root.bindings.map((raw, index): Binding => {
    const item = record(raw, `binding ${index}`);
    exactKeys(
      item,
      ["secret", "kind", "encoding", "type", "marker", "text_marker"],
      `binding ${index}`,
    );
    if (
      typeof item.secret !== "string" || !SECRET_NAME_RE.test(item.secret) ||
      (item.kind !== "value" && item.kind !== "file") ||
      (item.encoding !== "utf8" && item.encoding !== "path") ||
      (item.type !== "string" && item.type !== "integer" && item.type !== "number" &&
        item.type !== "boolean") ||
      typeof item.marker !== "string" || !MARKER_RE.test(item.marker) ||
      typeof item.text_marker !== "string" || !MARKER_RE.test(item.text_marker) ||
      item.marker === item.text_marker
    ) throw new Error(`Invalid binding ${index}`);
    if (item.kind === "file" && (item.encoding !== "path" || item.type !== "string")) {
      throw new Error(`file secret for binding ${index} must be a string path`);
    }
    if (item.kind === "value" && item.encoding !== "utf8") {
      throw new Error(`value secret for binding ${index} must be utf8`);
    }
    return {
      secret: item.secret,
      kind: item.kind,
      encoding: item.encoding,
      type: item.type,
      marker: item.marker,
      textMarker: item.text_marker,
      found: false,
    };
  });
  return { format, bindings };
}

function replaceMarkers(value: unknown, binding: Binding, raw: string): void {
  visit(value);
  if (!binding.found) {
    throw new Error(`marker for secret ${binding.secret} does not appear in the config`);
  }

  function visit(item: unknown): void {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item === null || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (typeof child !== "string") {
        visit(child);
        continue;
      }
      if (child === binding.marker) {
        record[key] = convertValue(raw, binding.type);
        binding.found = true;
      } else if (child.includes(binding.textMarker)) {
        if (binding.type !== "string") {
          throw new Error(
            `non-string type for ${binding.secret} can only be a whole-value placeholder`,
          );
        }
        record[key] = child.replaceAll(binding.textMarker, raw);
        binding.found = true;
      } else if (child.includes(binding.marker)) {
        throw new Error(`whole-value marker for ${binding.secret} cannot be embedded in a string`);
      }
    }
  }
}

function convertValue(raw: string, type: ValueType): string | number | boolean {
  if (type === "integer" || type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  return raw;
}

function parseStructured(text: string, format: ConfigFormat): Record<string, unknown> {
  try {
    if (format === "yaml") {
      return parseYaml(text, { allowDuplicateKeys: false }) as Record<string, unknown>;
    }
    if (format === "json") return JSON.parse(text) as Record<string, unknown>;
    if (format === "toml") return parseToml(text) as Record<string, unknown>;
    return parseIni(text) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`Failed to parse the ${format.toUpperCase()} config skeleton`, { cause });
  }
}

function stringifyStructured(value: unknown, format: ConfigFormat): string {
  try {
    if (format === "yaml") {
      return stringifyYaml(value, { sortKeys: true, lineWidth: -1, useAnchors: false });
    }
    if (format === "json") return `${JSON.stringify(value, undefined, 2)}\n`;
    if (format === "toml") return stringifyToml(value as Record<string, unknown>);
    return stringifyIni(value);
  } catch (cause) {
    throw new Error(`Failed to serialize ${format.toUpperCase()} config`, { cause });
  }
}

function typedValue(raw: string, type: ValueType): string {
  if (type === "string") {
    if (raw.length === 0) throw new Error("String secret must not be empty");
    return raw;
  }
  if (type === "boolean") {
    if (raw !== "true" && raw !== "false") {
      throw new Error("Secret value does not match type boolean");
    }
    return raw;
  }
  if (type === "integer") {
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(raw)) {
      throw new Error("Secret value does not match type integer");
    }
    if (!Number.isSafeInteger(Number(raw))) {
      throw new Error("Secret integer exceeds the safe range");
    }
    return raw;
  }
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(raw)) {
    throw new Error("Secret value does not match type number");
  }
  if (!Number.isFinite(Number(raw))) throw new Error("Secret number is outside the finite range");
  return raw;
}

function validateRendered(text: string, format: ConfigFormat): void {
  try {
    if (format === "yaml") parseYaml(text, { allowDuplicateKeys: false });
    else if (format === "json") JSON.parse(text);
    else if (format === "toml") parseToml(text);
    else parseIni(text);
  } catch (cause) {
    throw new Error(`Failed to parse the updated ${format.toUpperCase()} config`, { cause });
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

async function readRegularFile(path: string, maxBytes: number, label: string): Promise<Uint8Array> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch {
    throw new Error(`${label} is not readable`);
  }
  if (!info.isFile || info.isSymlink || info.size > maxBytes) {
    throw new Error(`${label} is not a restricted regular file`);
  }
  const bytes = await Deno.readFile(path);
  if (bytes.byteLength !== info.size || bytes.byteLength > maxBytes) {
    throw new Error(`${label} changed while being read`);
  }
  return bytes;
}

function safeAbsoluteFile(path: string, label: string): string {
  return requireAbsolute(path, label, false);
}

function safeAbsoluteDirectory(path: string, label: string): string {
  return requireAbsolute(path, label, true);
}

function requireAbsolute(path: string, label: string, directory: boolean): string {
  if (
    typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") ||
    path.includes("\\") || /[\0\r\n]/u.test(path) || path.split("/").includes("..") ||
    (directory ? path === "/" || path.endsWith("/") : path.endsWith("/"))
  ) throw new Error(`${label} path is unsafe`);
  return path;
}

export function parseArgs(args: readonly string[]): {
  command: "validate" | "update";
} & Partial<UpdateConfigOptions> {
  const values = new Map<string, string>();
  const command = args[0];
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error("Invalid config updater arguments");
    }
    values.set(key, value);
  }
  if (command === "validate") {
    if (values.size !== 1 || !values.has("--input")) {
      throw new Error("Invalid config updater arguments");
    }
    return { command, input: values.get("--input") };
  }
  if (command !== "update") throw new Error("Invalid config updater command");
  const required = ["--format", "--input", "--bindings", "--secrets", "--secret-root", "--output"];
  if (values.size !== required.length || !required.every((key) => values.has(key))) {
    throw new Error("Invalid config updater arguments");
  }
  const format = values.get("--format");
  if (
    format !== "yaml" && format !== "json" && format !== "toml" && format !== "ini" &&
    format !== "nginx"
  ) {
    throw new Error("Invalid config updater arguments");
  }
  return {
    command,
    format,
    input: values.get("--input"),
    bindings: values.get("--bindings"),
    secrets: values.get("--secrets"),
    secretRoot: values.get("--secret-root"),
    output: values.get("--output"),
  };
}

if (import.meta.main) {
  try {
    const parsed = parseArgs(Deno.args);
    if (parsed.command === "validate") await validateCandidate(parsed.input!);
    else await updateConfig(parsed as UpdateConfigOptions);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Config update failed");
    Deno.exit(1);
  }
}
