/** 内置版本提交：准备、最后切换、服务成功后提交标记和清理。 */
import { PreflightError, TransportError } from "./errors.ts";
import type { RemoteSession } from "./transport.ts";

export interface VersionedReleaseRequest {
  readonly installDirectory: string;
  readonly resource: string;
  readonly version: string;
  /** 已由执行器验证的应用运行账户；版本标记须供后续 stage 读取。 */
  readonly runAs: string;
  readonly keepVersions?: number;
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

async function run(
  session: RemoteSession,
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await session.run(argv, { privileged: true, signal });
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
  const result = await session.run(["/usr/bin/test", flag, path], { privileged: true, signal });
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
    typeof request.runAs !== "string" || !/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(request.runAs) ||
    (request.keepVersions !== undefined && (!Number.isInteger(request.keepVersions) ||
      request.keepVersions < 1 || request.keepVersions > 100))
  ) {
    throw new PreflightError("Invalid version commit arguments");
  }
  await session.preflightPrivilege(signal);
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
      "-o",
      request.runAs,
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
