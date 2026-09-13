/** 通过既有 OpenSSH 传输（ssh/scp）在目标机安装 Deno 的受控编排。 */

import { ConfigurationError, TransportError } from "./errors.ts";
import type { MachineDenoOutcome } from "./results.ts";
import type { RemoteSession } from "./transport.ts";

export const DEFAULT_DENO_INSTALL_ROOT = "/usr/local";
const DENO_RELEASE_DOWNLOAD_URL = "https://github.com/denoland/deno/releases/download";
const DENO_RELEASE_LATEST_URL = "https://github.com/denoland/deno/releases/latest/download";

const VERSION_RE = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/;
const INSTALL_ROOT_RE = /^\/[A-Za-z0-9_@%+=:.,/~-]+$/;
const PROBE_VERSION_RE = /^deno ([0-9]+\.[0-9]+\.[0-9]+)(?:[-+][^\s]+)?(?: \([^\r\n]+\))?$/;
const TOOL_PROBE_SCRIPT =
  'for tool in curl wget unzip 7z; do if command -v "$tool" >/dev/null 2>&1; then printf "%s " "$tool"; fi; done';
const PACKAGE_MANAGER_PROBE_SCRIPT =
  'for path in /usr/bin/apt-get /sbin/apk /bin/apk /usr/bin/dnf /usr/bin/yum /bin/yum; do if test -x "$path"; then printf "%s" "$path"; exit 0; fi; done; exit 1';
const KNOWN_PACKAGE_MANAGERS = new Set(["apt-get", "apk", "dnf", "yum"]);

export interface InstallDenoOptions {
  readonly version?: string;
  readonly installTo?: string;
  readonly signal?: AbortSignal;
}

/** 接受 `2.2.11` 或 `v2.2.11`，规范化并强制 Deno 2+。 */
export function normalizeDenoVersion(value: string): string {
  if (typeof value !== "string") {
    throw new ConfigurationError("--deno-version must be a string");
  }
  const match = VERSION_RE.exec(value.trim());
  if (!match) {
    throw new ConfigurationError(
      `--deno-version must be x.y.z or vx.y.z: ${JSON.stringify(value)}`,
    );
  }
  const major = Number(match[1]);
  if (major < 2) {
    throw new ConfigurationError("install-deno supports only Deno 2 or later");
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** 安装目录必须是绝对 POSIX 路径，且不含 `..`、空白与控制字符。 */
export function validateInstallTo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || !INSTALL_ROOT_RE.test(value)) {
    throw new ConfigurationError(
      `--install-to must be an absolute POSIX path without whitespace/control characters: ${
        JSON.stringify(value)
      }`,
    );
  }
  if (value.split("/").includes("..")) {
    throw new ConfigurationError("--install-to must not contain a .. path segment");
  }
  return value;
}

function versionFromOutput(output: string): string | undefined {
  const firstLine = output.split(/\r?\n/, 1)[0] ?? "";
  const match = PROBE_VERSION_RE.exec(firstLine);
  return match?.[1];
}

async function remoteHome(
  session: RemoteSession,
  signal?: AbortSignal,
): Promise<string> {
  const result = await session.run(
    ["/bin/sh", "-c", 'printf "%s" "$HOME"'],
    { signal },
  );
  const home = result.stdout.trim();
  if (
    result.exitCode !== 0 || home.length === 0 || home === "/" ||
    !home.startsWith("/") || /\s/.test(home)
  ) {
    throw new TransportError(
      `Failed to determine the remote user home directory: ${result.stdout}${result.stderr}`.trim(),
    );
  }
  return home;
}

function installerScript(
  version: string | undefined,
  existingVersion: string | undefined,
): string {
  const requestedVersion = version ?? "";
  const existing = existingVersion ?? "";
  const baseURL = version === undefined
    ? DENO_RELEASE_LATEST_URL
    : `${DENO_RELEASE_DOWNLOAD_URL}/v${version}`;
  return [
    "set -eu",
    `requested_version='${requestedVersion}'`,
    `existing_version='${existing}'`,
    'case "$(uname -m)" in x86_64) target=x86_64-unknown-linux-gnu;; aarch64|arm64) target=aarch64-unknown-linux-gnu;; *) echo "install-deno: unsupported remote architecture $(uname -m)" >&2; exit 1;; esac',
    `base_url='${baseURL}'`,
    'archive_name="deno-${target}.zip"',
    'archive_url="${base_url}/${archive_name}"',
    'checksum_url="${archive_url}.sha256sum"',
    'tmp_dir="$(mktemp -d)"',
    "cleanup_binary=",
    'trap \'test -z "$cleanup_binary" || rm -f "$cleanup_binary"; rm -rf "$tmp_dir"\' EXIT HUP INT TERM',
    `if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then echo "install-deno: target machine is missing curl or wget" >&2; exit 1; fi`,
    `if ! command -v unzip >/dev/null 2>&1 && ! command -v 7z >/dev/null 2>&1; then echo "install-deno: target machine is missing unzip or 7z" >&2; exit 1; fi`,
    'if ! command -v sha256sum >/dev/null 2>&1; then echo "install-deno: target machine is missing sha256sum" >&2; exit 1; fi',
    'archive_path="${tmp_dir}/${archive_name}"',
    'if command -v curl >/dev/null 2>&1; then curl -fL "$archive_url" -o "$archive_path" && curl -fL "$checksum_url" -o "${archive_path}.sha256sum"; else wget -q -O "$archive_path" "$archive_url" && wget -q -O "${archive_path}.sha256sum" "$checksum_url"; fi',
    '(cd "$tmp_dir" && sha256sum -c "${archive_name}.sha256sum")',
    'if command -v unzip >/dev/null 2>&1; then unzip -q "$archive_path" -d "$tmp_dir"; else 7z x -y "-o$tmp_dir" "$archive_path" >/dev/null; fi',
    'staged_version="$("$tmp_dir/deno" --version)"',
    'case "$staged_version" in deno\\ [0-9]*.[0-9]*.[0-9]*\\ *|deno\\ [0-9]*.[0-9]*.[0-9]*) ;; *) echo "install-deno: cannot recognize the staged Deno version: $staged_version" >&2; exit 1;; esac',
    'staged_version="${staged_version#deno }"',
    'staged_version="${staged_version%% *}"',
    'if test -z "$requested_version" && test -n "$existing_version" && test "$staged_version" = "$existing_version"; then echo "sfo-deno-present:$staged_version"; exit 0; fi',
    'mkdir -p "$DENO_INSTALL/bin"',
    'cleanup_binary="$DENO_INSTALL/bin/.deno.sfo-install.$$"',
    'cp "$tmp_dir/deno" "$cleanup_binary"',
    'chmod 0755 "$cleanup_binary"',
    'mv -f "$cleanup_binary" "$DENO_INSTALL/bin/deno"',
    "cleanup_binary=",
  ].join("; ");
}

interface PackageManager {
  readonly name: string;
  readonly binary: string;
}

async function probeTools(
  session: RemoteSession,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const result = await session.run(
    ["/bin/sh", "-c", TOOL_PROBE_SCRIPT],
    { signal },
  );
  if (result.exitCode !== 0) {
    throw new TransportError(`Remote tool probe failed: ${diagnostic(result)}`);
  }
  return Object.freeze(
    result.stdout.trim().split(/\s+/).filter((line) => line.length > 0),
  );
}

async function detectPackageManager(
  session: RemoteSession,
  signal?: AbortSignal,
): Promise<PackageManager | undefined> {
  const result = await session.run(
    ["/bin/sh", "-c", PACKAGE_MANAGER_PROBE_SCRIPT],
    { signal },
  );
  if (result.exitCode !== 0) return undefined;
  const binary = result.stdout.trim();
  const name = binary.split("/").pop() ?? "";
  if (!KNOWN_PACKAGE_MANAGERS.has(name) || !binary.startsWith("/")) {
    return undefined;
  }
  return Object.freeze({ name, binary });
}

function packageInstallArgv(manager: PackageManager, packages: readonly string[]): string[] {
  if (manager.name === "apt-get") {
    return [manager.binary, "install", "-y", "--no-install-recommends", ...packages];
  }
  if (manager.name === "apk") {
    return [manager.binary, "add", "--no-cache", ...packages];
  }
  return [manager.binary, "install", "-y", ...packages];
}

async function installRemotePackages(
  session: RemoteSession,
  manager: PackageManager,
  packages: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (manager.name === "apt-get") {
    const updated = await session.run([manager.binary, "update"], {
      signal,
      privileged: true,
    });
    if (updated.exitCode !== 0) {
      throw new TransportError(
        `Failed to refresh the apt package index ${manager.binary}: ${diagnostic(updated)}`,
      );
    }
  }
  const installed = await session.run(packageInstallArgv(manager, packages), {
    signal,
    privileged: true,
  });
  if (installed.exitCode !== 0) {
    throw new TransportError(
      `Failed to install remote base tools (${manager.name}): ${diagnostic(installed)}`,
    );
  }
}

/** 探测并补齐远端最小工具（curl/wget 与 unzip/7z）；失败时抛出 TransportError。 */
async function ensureRemoteTools(
  session: RemoteSession,
  signal?: AbortSignal,
): Promise<void> {
  const present = await probeTools(session, signal);
  const hasDownloader = present.some((tool) => tool === "curl" || tool === "wget");
  const hasUnarchiver = present.some((tool) => tool === "unzip" || tool === "7z");
  if (hasDownloader && hasUnarchiver) return;

  const packages: string[] = [];
  if (!hasDownloader) packages.push("curl");
  if (!hasUnarchiver) packages.push("unzip");

  const manager = await detectPackageManager(session, signal);
  if (manager === undefined) {
    throw new TransportError(
      `The target machine has no usable package manager (supported: apt-get/apk/dnf/yum); install ${
        packages.join(", ")
      } manually and retry`,
    );
  }

  await installRemotePackages(session, manager, packages, signal);
  const after = await probeTools(session, signal);
  const stillMissingDownloader = !after.some(
    (tool) => tool === "curl" || tool === "wget",
  );
  const stillMissingUnarchiver = !after.some(
    (tool) => tool === "unzip" || tool === "7z",
  );
  if (stillMissingDownloader || stillMissingUnarchiver) {
    const missing = [
      ...(stillMissingDownloader ? ["curl/wget"] : []),
      ...(stillMissingUnarchiver ? ["unzip/7z"] : []),
    ];
    throw new TransportError(
      `Remote base tools are still missing after automatic installation: ${
        missing.join(", ")
      } (${manager.name}); install them manually and retry`,
    );
  }
}

function diagnostic(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`.trim() || "Unknown remote error";
}

/** 在一台已连接机器上探测并安装 Deno；失败时抛出 TransportError。 */
export async function installDenoOnMachine(
  session: RemoteSession,
  machine: string,
  options: InstallDenoOptions,
): Promise<MachineDenoOutcome> {
  const version = options.version === undefined ? undefined : normalizeDenoVersion(options.version);
  const requestedRoot = validateInstallTo(options.installTo);
  const home = await remoteHome(session, options.signal);
  const root = requestedRoot ?? DEFAULT_DENO_INSTALL_ROOT;
  const denoPath = `${root}/bin/deno`;

  const probe = await session.run([denoPath, "--version"], {
    signal: options.signal,
  });
  const existing = probe.exitCode === 0 ? versionFromOutput(probe.stdout) : undefined;
  if (probe.exitCode === 0 && existing !== undefined && existing === version) {
    return Object.freeze({
      machine,
      status: "present",
      denoPath,
      version: existing,
      cleanupErrors: Object.freeze([]),
    });
  }

  await ensureRemoteTools(session, options.signal);
  const privileged = !root.startsWith(`${home}/`);
  const installed = await session.run(
    ["/bin/sh", "-c", installerScript(version, existing)],
    {
      signal: options.signal,
      environment: { DENO_INSTALL: root },
      privileged,
    },
  );
  if (installed.exitCode !== 0) {
    throw new TransportError(
      `Failed to install Deno ${machine}: ${diagnostic(installed)}`,
    );
  }

  const unchangedVersion = /(?:^|\n)sfo-deno-present:([0-9]+\.[0-9]+\.[0-9]+)(?:\n|$)/
    .exec(installed.stdout)?.[1];

  const verify = await session.run([denoPath, "--version"], {
    signal: options.signal,
  });
  const verified = verify.exitCode === 0 ? versionFromOutput(verify.stdout) : undefined;
  if (verify.exitCode !== 0 || verified === undefined) {
    throw new TransportError(
      `Post-install verification failed ${machine}: ${diagnostic(verify)}`,
    );
  }
  if (version !== undefined && verified !== version) {
    throw new TransportError(
      `Post-install version mismatch ${machine}: expected ${version}, got ${verified}`,
    );
  }
  if (version === undefined && unchangedVersion !== undefined && verified !== unchangedVersion) {
    throw new TransportError(
      `Post-install version mismatch ${machine}: expected ${unchangedVersion}, got ${verified}`,
    );
  }
  return Object.freeze({
    machine,
    status: unchangedVersion === undefined ? "installed" : "present",
    denoPath,
    version: verified,
    cleanupErrors: Object.freeze([]),
  });
}
