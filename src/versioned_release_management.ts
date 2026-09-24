/** 内置版本提交：准备、最后切换、服务成功后提交标记和清理。 */
import { PreflightError, TransportError } from "./errors.ts";
import type { RemoteSession } from "./transport.ts";

export interface VersionedReleaseRequest {
  readonly installDirectory: string;
  readonly resource: string;
  readonly version: string;
  /** App 根级发布权限位；声明时收敛发布根与版本树，未声明时不做权限变更。 */
  readonly mode?: string;
  readonly keepVersions?: number;
}

export interface VersionedStageRequest {
  readonly installDirectory: string;
  readonly resource: string;
  readonly version: string;
  /** The framework-validated unpacked App directory under workspace. */
  readonly packageDirectory: string;
  readonly workspace: string;
}

export interface PreparedVersionedRelease {
  readonly request: VersionedReleaseRequest;
  readonly releasePath: string;
  readonly latestPath: string;
  readonly markerPath: string;
  readonly previousVersion?: string;
  readonly previousTarget?: string;
  readonly temporaryLatest: string;
  readonly temporaryMarker: string;
  readonly previousMarkerBackup: string;
  switched: boolean;
  finalized: boolean;
}

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const RESOURCE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const PAYLOAD_ROOT = /^[A-Za-z0-9_@%+=,.-]+$/u;
const RELEASE_MODE = /^0?[0-7]{3}$/;

function safeDirectory(path: string): boolean {
  return typeof path === "string" && path.startsWith("/") && path !== "/" &&
    !path.endsWith("/") && !path.includes("\\") && !/[\0\r\n]/u.test(path) &&
    path.split("/").every((part, index) =>
      index === 0 || (part !== "" && part !== "." && part !== "..")
    );
}

/** Stage an already validated App package without invoking Deno on the target. */
export async function stageVersionedRelease(
  session: RemoteSession,
  request: VersionedStageRequest,
  signal?: AbortSignal,
): Promise<void> {
  const { installDirectory: root, resource, version, packageDirectory, workspace } = request;
  if (
    !safeDirectory(root) || !safeDirectory(workspace) || !safeDirectory(packageDirectory) ||
    !packageDirectory.startsWith(`${workspace}/`) || !RESOURCE.test(resource) ||
    !VERSION.test(version)
  ) {
    throw new PreflightError("Invalid version stage arguments");
  }
  if (
    !(await test(session, "-d", packageDirectory, signal)) ||
    await test(session, "-L", packageDirectory, signal)
  ) {
    throw new TransportError("The framework-validated package is not a safe directory");
  }
  if (
    !(await test(session, "-d", root, signal)) || await test(session, "-L", root, signal) ||
    !(await test(session, "-w", root, signal))
  ) {
    throw new TransportError(
      `${root} must be an existing writable directory and must not be a symlink`,
    );
  }

  const markerPath = `${root}/.${resource}.version`;
  if (await test(session, "-L", markerPath, signal)) {
    throw new TransportError(`Version marker is not a regular file ${markerPath}`);
  }
  const markerExists = await test(session, "-e", markerPath, signal);
  if (markerExists && !(await test(session, "-f", markerPath, signal))) {
    throw new TransportError(`Version marker is not a regular file ${markerPath}`);
  }
  const previousVersion = markerExists
    ? await run(session, ["/usr/bin/cat", "--", markerPath], signal)
    : undefined;
  if (previousVersion === version) return;

  const releasePath = `${root}/${version}`;
  const latestPath = `${root}/latest`;
  if (await test(session, "-L", latestPath, signal)) {
    const result = await session.run(["/usr/bin/readlink", "-f", "--", latestPath], { signal });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new TransportError(`Failed to inspect latest link ${latestPath}`);
    }
    if (result.exitCode === 0 && result.stdout.trim() === releasePath) {
      throw new TransportError(
        `latest points to ${version}, but the version marker is missing; refusing to replace the current release`,
      );
    }
  } else if (await test(session, "-e", latestPath, signal)) {
    throw new TransportError(`latest is not a symlink ${latestPath}`);
  }

  const existing = await test(session, "-e", releasePath, signal);
  if (
    await test(session, "-L", releasePath, signal) ||
    (existing && !(await test(session, "-d", releasePath, signal)))
  ) {
    throw new TransportError(`Version path is not a regular directory ${releasePath}`);
  }

  // Package members were checked before extraction. Inspect just the top level to preserve
  // the single-wrapper-directory layout used by the old built-in release script.
  const listing = await run(session, [
    "/usr/bin/find",
    packageDirectory,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-printf",
    "%f\\0%y\\0",
  ], signal);
  const fields = listing === "" ? [] : listing.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) {
    throw new TransportError("The validated package top-level listing is malformed");
  }
  let payload = packageDirectory;
  if (fields.length === 2 && fields[1] === "d") {
    if (!PAYLOAD_ROOT.test(fields[0])) {
      throw new TransportError(`Validated package has an unsafe top-level directory: ${fields[0]}`);
    }
    payload = `${packageDirectory}/${fields[0]}`;
  }

  const nonce = crypto.randomUUID().replaceAll("-", "");
  const stagePath = `${root}/.sfo-deploy-${resource}-${version}-${nonce}`;
  const backupPath = `${root}/.sfo-deploy-release-backup-${nonce}`;
  const versionSource = `${workspace}/sfo-version-${nonce}`;
  let localVersion: string | undefined;
  let movedExisting = false;
  let committed = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await run(session, ["/usr/bin/install", "-d", "-m", "0750", "--", stagePath], signal);
    await run(session, ["/usr/bin/cp", "-a", "--", `${payload}/.`, `${stagePath}/`], signal);
    localVersion = await Deno.makeTempFile({ prefix: "sfo-stage-version-" });
    await Deno.chmod(localVersion, 0o600);
    await Deno.writeTextFile(localVersion, `${version}\n`);
    await session.uploadFile(localVersion, versionSource, { signal, mode: 0o600 });
    await run(session, [
      "/usr/bin/install",
      "-m",
      "0644",
      "--",
      versionSource,
      `${stagePath}/VERSION`,
    ], signal);
    if (existing) {
      try {
        await run(session, ["/usr/bin/mv", "-T", "--", releasePath, backupPath], signal);
        movedExisting = true;
      } catch (cause) {
        // The rename may have completed even if the SSH response was lost.
        movedExisting = await test(session, "-d", backupPath).catch(() => false) &&
          !(await test(session, "-e", releasePath).catch(() => true));
        if (!movedExisting) throw cause;
      }
    }
    try {
      await run(session, ["/usr/bin/mv", "-T", "--", stagePath, releasePath], signal);
      committed = true;
    } catch (cause) {
      // A lost response after the atomic rename still constitutes a successful stage.
      committed = !(await test(session, "-e", stagePath).catch(() => true)) &&
        await test(session, "-d", releasePath).catch(() => false) &&
        !await test(session, "-L", releasePath).catch(() => true) &&
        await run(session, ["/usr/bin/cat", "--", `${releasePath}/VERSION`]).catch(() => "") ===
          version;
      if (!committed) throw cause;
    }
  } catch (cause) {
    primaryError = cause;
  }

  if (primaryError !== undefined && movedExisting && !committed) {
    try {
      if (await test(session, "-e", releasePath)) {
        throw new TransportError(
          `Version stage recovery found an unexpected release ${releasePath}`,
        );
      }
      await run(session, ["/usr/bin/mv", "-T", "--", backupPath, releasePath]);
    } catch (cause) {
      cleanupErrors.push(cause);
    }
  }
  if (committed && movedExisting) {
    try {
      await run(session, ["/usr/bin/rm", "-rf", "--", backupPath]);
    } catch (cause) {
      cleanupErrors.push(cause);
    }
  }
  try {
    await run(session, ["/usr/bin/rm", "-rf", "--", stagePath]);
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  try {
    await run(session, ["/usr/bin/rm", "-f", "--", versionSource]);
  } catch (cause) {
    cleanupErrors.push(cause);
  }
  if (localVersion !== undefined) {
    try {
      await Deno.remove(localVersion);
    } catch (cause) {
      cleanupErrors.push(cause);
    }
  }
  if (primaryError !== undefined && cleanupErrors.length === 0) throw primaryError;
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      "Version staging or cleanup failed",
    );
  }
}

/** 把八进制发布模式渲染为 chmod 符号表达式：目录与已有执行位文件自动获得 x。 */
export function modeChmodExpression(mode: string): string {
  if (!RELEASE_MODE.test(mode)) throw new PreflightError("Invalid release mode");
  const bits = Number.parseInt(mode, 8);
  const classExpression = (shift: number, label: "u" | "g" | "o"): string => {
    const value = (bits >> shift) & 0o7;
    if (value === 0) return `${label}=`;
    const read = value & 0o4 ? "r" : "";
    const write = value & 0o2 ? "w" : "";
    const execute = value & 0o1 ? "x" : value & 0o4 ? "X" : "";
    return `${label}=${read}${write}${execute}`;
  };
  return [
    classExpression(6, "u"),
    classExpression(3, "g"),
    classExpression(0, "o"),
  ].join(",");
}

async function run(
  session: RemoteSession,
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await session.run(argv, { signal });
  if (result.exitCode !== 0) {
    throw new TransportError(`Version operation ${argv[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function test(
  session: RemoteSession,
  flag: string,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await session.run(["/usr/bin/test", flag, path], { signal });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new TransportError(`Failed to inspect version path ${path}`);
  }
  return result.exitCode === 0;
}

export async function prepareVersionedRelease(
  session: RemoteSession,
  request: VersionedReleaseRequest,
  signal?: AbortSignal,
): Promise<PreparedVersionedRelease> {
  const root = request.installDirectory;
  if (
    !root.startsWith("/") || root === "/" || root.endsWith("/") || root.includes("\\") ||
    root.split("/").some((part, index) =>
      index > 0 && (part === ".." || part === "." || part === "")
    ) ||
    !VERSION.test(request.version) || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(request.resource) ||
    (request.mode !== undefined &&
      (typeof request.mode !== "string" || !RELEASE_MODE.test(request.mode))) ||
    (request.keepVersions !== undefined && (!Number.isInteger(request.keepVersions) ||
      request.keepVersions < 1 || request.keepVersions > 100))
  ) {
    throw new PreflightError("Invalid version commit arguments");
  }
  const releasePath = `${root}/${request.version}`;
  for (const path of [root, releasePath]) {
    if (!(await test(session, "-d", path, signal)) || await test(session, "-L", path, signal)) {
      throw new TransportError(`Version path is not a regular directory ${path}`);
    }
    await run(session, ["/usr/bin/test", "-r", path], signal);
    await run(session, ["/usr/bin/test", "-x", path], signal);
  }
  if (
    await run(session, ["/usr/bin/cat", "--", `${releasePath}/VERSION`], signal) !== request.version
  ) {
    throw new TransportError(`Version directory VERSION mismatch ${releasePath}`);
  }
  if (request.mode !== undefined) {
    const expression = modeChmodExpression(request.mode);
    await run(session, ["/usr/bin/chmod", expression, "--", root], signal);
    await run(session, ["/usr/bin/chmod", "-R", expression, "--", releasePath], signal);
  }
  const latestPath = `${root}/latest`;
  const markerPath = `${root}/.${request.resource}.version`;
  const markerExists = await test(session, "-e", markerPath, signal);
  if (
    await test(session, "-L", markerPath, signal) ||
    (markerExists && !(await test(session, "-f", markerPath, signal)))
  ) {
    throw new TransportError(`Version marker is not a regular file ${markerPath}`);
  }
  const previousVersion = markerExists
    ? await run(session, ["/usr/bin/cat", "--", markerPath], signal)
    : undefined;
  const linked = await test(session, "-L", latestPath, signal);
  if (!linked && await test(session, "-e", latestPath, signal)) {
    throw new TransportError(`latest is not a symlink ${latestPath}`);
  }
  const previousTarget = linked
    ? await run(session, ["/usr/bin/readlink", "--", latestPath], signal)
    : undefined;
  if (
    (previousVersion === undefined) !== (previousTarget === undefined) ||
    (previousVersion !== undefined && (!VERSION.test(previousVersion) ||
      (previousTarget !== previousVersion && previousTarget !== `${root}/${previousVersion}`)))
  ) {
    throw new TransportError("latest and the version marker disagree; refusing to commit");
  }
  if (
    previousVersion !== undefined &&
    (!(await test(session, "-d", `${root}/${previousVersion}`, signal)) ||
      await test(session, "-L", `${root}/${previousVersion}`, signal))
  ) {
    throw new TransportError("The previous latest target is not a recoverable version directory");
  }
  const nonce = crypto.randomUUID();
  const state: PreparedVersionedRelease = {
    request,
    releasePath,
    latestPath,
    markerPath,
    previousVersion,
    previousTarget,
    temporaryLatest: `${root}/.sfo-deploy-latest-${nonce}`,
    temporaryMarker: `${root}/.sfo-deploy-marker-${nonce}`,
    previousMarkerBackup: `${root}/.sfo-deploy-marker-backup-${nonce}`,
    switched: false,
    finalized: false,
  };
  try {
    await run(session, ["/usr/bin/ln", "-s", "--", request.version, state.temporaryLatest], signal);
    await run(session, [
      "/usr/bin/install",
      "-m",
      "0640",
      "--",
      `${releasePath}/VERSION`,
      state.temporaryMarker,
    ], signal);
    if (markerExists) {
      await run(
        session,
        ["/usr/bin/cp", "-p", "--", markerPath, state.previousMarkerBackup],
        signal,
      );
    }
    return state;
  } catch (cause) {
    try {
      await cleanupVersionedRelease(session, state);
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        "Version preparation failed and temporary resource cleanup failed",
      );
    }
    throw cause;
  }
}

/** 此函数唯一远端操作是切换；返回后调用者必须立即执行服务动作。 */
export async function switchVersionedRelease(
  session: RemoteSession,
  state: PreparedVersionedRelease,
  signal?: AbortSignal,
): Promise<void> {
  // 在发送前记录可能已切换，以覆盖远端成功而响应丢失的情况。
  state.switched = true;
  await run(session, ["/usr/bin/mv", "-Tf", "--", state.temporaryLatest, state.latestPath], signal);
}

export async function finalizeVersionedRelease(
  session: RemoteSession,
  state: PreparedVersionedRelease,
  signal?: AbortSignal,
): Promise<void> {
  await run(session, ["/usr/bin/mv", "-Tf", "--", state.temporaryMarker, state.markerPath], signal);
  state.finalized = true;
}

export async function restoreVersionedRelease(
  session: RemoteSession,
  state: PreparedVersionedRelease,
  signal?: AbortSignal,
): Promise<void> {
  if (!state.switched) return;
  const errors: unknown[] = [];
  try {
    if (state.previousTarget === undefined) {
      await run(session, ["/usr/bin/rm", "-f", "--", state.latestPath], signal);
    } else {
      await run(
        session,
        ["/usr/bin/ln", "-sfn", "--", state.previousTarget, state.temporaryLatest],
        signal,
      );
      await run(
        session,
        ["/usr/bin/mv", "-Tf", "--", state.temporaryLatest, state.latestPath],
        signal,
      );
    }
  } catch (cause) {
    errors.push(cause);
  }
  try {
    if (state.previousVersion === undefined) {
      await run(session, ["/usr/bin/rm", "-f", "--", state.markerPath], signal);
    } else {
      await run(session, [
        "/usr/bin/cp",
        "-p",
        "--",
        state.previousMarkerBackup,
        state.temporaryMarker,
      ], signal);
      await run(
        session,
        ["/usr/bin/mv", "-Tf", "--", state.temporaryMarker, state.markerPath],
        signal,
      );
    }
  } catch (cause) {
    errors.push(cause);
  }
  state.finalized = false;
  if (errors.length) {
    throw new AggregateError(errors, "Version symlink/marker recovery is incomplete");
  }
  state.switched = false;
}

/** 服务与标记已成功后才执行保留策略；失败仅作为清理错误报告。 */
export async function cleanupVersionedRelease(
  session: RemoteSession,
  state: PreparedVersionedRelease,
  signal?: AbortSignal,
): Promise<void> {
  if (state.switched && !state.finalized) {
    throw new TransportError(
      "Version recovery is incomplete; keeping the temporary marker backup for recovery",
    );
  }
  const errors: unknown[] = [];
  if (state.finalized && state.request.keepVersions !== undefined) {
    try {
      const root = state.request.installDirectory;
      const listed = await run(session, [
        "/usr/bin/find",
        root,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-type",
        "d",
        "-printf",
        "%T@ %f\\n",
      ], signal);
      const versions = listed.split("\n").flatMap((line) => {
        const [timestamp, name] = line.split(" ");
        return name && VERSION.test(name) && Number.isFinite(Number(timestamp))
          ? [{ name, timestamp: Number(timestamp) }]
          : [];
      }).sort((a, b) => b.timestamp - a.timestamp);
      const retained = new Set([state.request.version]);
      for (const version of versions) {
        if (retained.has(version.name)) continue;
        const versionMarker = `${root}/${version.name}/VERSION`;
        if (
          !(await test(session, "-f", versionMarker, signal)) ||
          await test(session, "-L", versionMarker, signal)
        ) continue;
        if (await run(session, ["/usr/bin/cat", "--", versionMarker], signal) !== version.name) {
          continue;
        }
        if (retained.size < state.request.keepVersions) retained.add(version.name);
        else await run(session, ["/usr/bin/rm", "-rf", "--", `${root}/${version.name}`], signal);
      }
    } catch (cause) {
      errors.push(cause);
    }
  }
  try {
    await run(session, [
      "/usr/bin/rm",
      "-f",
      "--",
      state.temporaryLatest,
      state.temporaryMarker,
      state.previousMarkerBackup,
    ], signal);
  } catch (cause) {
    errors.push(cause);
  }
  if (errors.length) throw new AggregateError(errors, "Version cleanup failed");
}
