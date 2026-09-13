/** 严格装载用户级 sfo-deploy 配置（默认 ~/.sfo-deploy/config.yaml）。 */

import { parse } from "jsr:@std/yaml@1.2.0";
import { isAbsolute, join, resolve } from "jsr:@std/path@1.1.6";
import { ConfigurationError } from "./errors.ts";

export const CONFIG_DIRECTORY_NAME = ".sfo-deploy";
export const CONFIG_FILENAME = "config.yaml";
export const DEFAULT_PACKAGES_DIRECTORY_NAME = "packages";
export const DEFAULT_KEEP_VERSIONS = 5;
export const MAX_KEEP_VERSIONS = 100;

export interface SfoDeployUserConfig {
  readonly schemaVersion: 1;
  readonly packagesDir: string;
  readonly keepVersions: number;
}

export interface LoadUserConfigOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringValue(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${label} must be a string`);
  }
  return value.trim();
}

function keepVersionsValue(value: unknown, label: string): number {
  if (value === undefined) return DEFAULT_KEEP_VERSIONS;
  if (
    typeof value !== "number" || !Number.isInteger(value) ||
    value < 1 || value > MAX_KEEP_VERSIONS
  ) {
    throw new ConfigurationError(`${label} must be an integer between 1 and ${MAX_KEEP_VERSIONS}`);
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  throw new ConfigurationError(
    "packages_dir supports only home-directory expansion (~) or an absolute path",
  );
}

async function loadConfigFile(
  configPath: string,
  homeDir: string,
): Promise<{ packagesDir: string; keepVersions: number }> {
  if (!(await exists(configPath))) {
    return {
      packagesDir: join(homeDir, CONFIG_DIRECTORY_NAME, DEFAULT_PACKAGES_DIRECTORY_NAME),
      keepVersions: DEFAULT_KEEP_VERSIONS,
    };
  }
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (cause) {
    throw new ConfigurationError(`Failed to read user config file ${configPath}`, { cause });
  }
  let value: unknown;
  try {
    value = parse(text, { allowDuplicateKeys: false });
  } catch (cause) {
    throw new ConfigurationError(`Failed to read YAML ${configPath}: ${String(cause)}`, { cause });
  }
  if (!isRecord(value)) {
    throw new ConfigurationError(`User config file top level must be a mapping: ${configPath}`);
  }
  const unknown = Object.keys(value).filter((key) =>
    key !== "schema_version" && key !== "packages_dir" && key !== "keep_versions"
  )
    .sort();
  if (unknown.length > 0) {
    throw new ConfigurationError(`User config file contains unknown fields: ${unknown.join(", ")}`);
  }
  if (value.schema_version !== 1) {
    throw new ConfigurationError("User config schema_version supports only 1");
  }
  const raw = stringValue(value.packages_dir, "packages_dir");
  let packagesDir = join(homeDir, CONFIG_DIRECTORY_NAME, DEFAULT_PACKAGES_DIRECTORY_NAME);
  if (raw !== undefined) {
    const expanded = raw.startsWith("~") ? expandHome(raw, homeDir) : raw;
    if (!isAbsolute(expanded)) {
      throw new ConfigurationError("packages_dir must be an absolute path or start with ~");
    }
    packagesDir = resolve(expanded);
  }
  return {
    packagesDir,
    keepVersions: keepVersionsValue(value.keep_versions, "keep_versions"),
  };
}

function defaultHome(homeDir: string | undefined): string {
  const home = homeDir ??
    Deno.env.get(Deno.build.os === "windows" ? "USERPROFILE" : "HOME");
  if (typeof home !== "string" || home.length === 0) {
    throw new ConfigurationError(
      "Failed to determine the user home directory (HOME/USERPROFILE is not set)",
    );
  }
  return home;
}

/** 装载用户配置；配置文件缺失时返回默认缓存目录。 */
export async function loadUserConfig(
  options: LoadUserConfigOptions = {},
): Promise<SfoDeployUserConfig> {
  const homeDir = defaultHome(options.homeDir);
  const configPath = options.configPath ?? join(homeDir, CONFIG_DIRECTORY_NAME, CONFIG_FILENAME);
  const { packagesDir, keepVersions } = await loadConfigFile(configPath, homeDir);
  return Object.freeze({ schemaVersion: 1, packagesDir, keepVersions });
}
