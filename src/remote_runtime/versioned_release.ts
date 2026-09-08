/**
 * sfo-deploy 内置版本化发布。
 *
 * stage 消费已验证的 App 解包目录并建立版本目录；activate 校验该目录后原子切换 latest、
 * 写当前版本标记并清理旧版本。旧 deploy 快照仍按原单步流程重放。
 */

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const APP_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const MAX_KEEP_VERSIONS = 100;

type JsonObject = Record<string, unknown>;

function mapping(value: unknown, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length === 0) throw new Error(`${label} was not supplied`);
  return value;
}

function uniqueId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

async function run(
  executable: string,
  args: readonly string[],
  check = true,
): Promise<Deno.CommandOutput> {
  const result = await new Deno.Command(executable, {
    args: [...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (check && !result.success) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `${executable} failed with exit code ${result.code}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

async function readMetadata(): Promise<JsonObject> {
  const path = Deno.env.get("DEPLOYMENT_METADATA_PATH");
  if (!path) throw new Error("DEPLOYMENT_METADATA_PATH is not set");
  return mapping(JSON.parse(await Deno.readTextFile(path)), "step metadata");
}

function safeInstallDirectory(path: string, label: string): string {
  if (
    !path.startsWith("/") || path === "/" || path.endsWith("/") || path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a safe absolute release root`);
  }
  return path;
}

async function readTextFile(path: string): Promise<string | undefined> {
  const result = await run("/usr/bin/cat", ["--", path], false);
  if (result.success) return new TextDecoder().decode(result.stdout).trim();
  if (result.code === 1) return undefined;
  throw new Error(
    `读取文件失败（exit ${result.code}）: ${new TextDecoder().decode(result.stderr).trim()}`,
  );
}

async function requireReleaseDirectory(path: string): Promise<void> {
  if (
    !(await run("/usr/bin/test", ["-d", path], false)).success ||
    (await run("/usr/bin/test", ["-L", path], false)).success
  ) {
    throw new Error(`版本目录不是安全的普通目录: ${path}`);
  }
}

async function listVersionDirectories(
  installDirectory: string,
): Promise<Array<{ name: string; time: number }>> {
  const result = await run("/usr/bin/find", [
    installDirectory,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-type",
    "d",
    "-printf",
    "%T@ %f\n",
  ]);
  return new TextDecoder().decode(result.stdout).split("\n").flatMap((line) => {
    const [rawTime, name] = line.trim().split(" ", 2);
    const time = Number(rawTime);
    if (!name || !VERSION_RE.test(name) || !Number.isFinite(time)) return [];
    return [{ name, time }];
  });
}

async function cleanupOldVersions(
  installDirectory: string,
  currentVersion: string,
  keep: number,
): Promise<void> {
  if (!Number.isInteger(keep) || keep < 1 || keep > MAX_KEEP_VERSIONS) {
    throw new Error(`keep_versions must be an integer between 1 and ${MAX_KEEP_VERSIONS}`);
  }
  const versions = (await listVersionDirectories(installDirectory)).sort(
    (left, right) => right.time - left.time,
  );
  for (const version of versions.slice(keep)) {
    if (version.name === currentVersion) continue;
    await run("/usr/bin/rm", ["-rf", "--", `${installDirectory}/${version.name}`]);
  }
}

async function stageRelease(metadata: JsonObject): Promise<void> {
  const parameters = mapping(metadata.parameters, "step metadata parameters");
  const nextVersion = requiredString(parameters.version, "The deployed App version");
  if (!VERSION_RE.test(nextVersion)) {
    throw new Error(`The deployed App version is invalid: ${nextVersion}`);
  }
  const installDirectory = safeInstallDirectory(
    requiredString(metadata.install_directory, "The App install directory"),
    "The App install directory",
  );
  const packageKind = requiredString(metadata.package_kind, "The package kind");
  if (packageKind !== "validated-directory") {
    throw new Error("The built-in release requires a framework-validated package directory");
  }
  const packageInput = requiredString(metadata.package_path, "The validated package directory");
  const packageInfo = await Deno.lstat(packageInput);
  if (!packageInfo.isDirectory || packageInfo.isSymlink) {
    throw new Error("The framework-validated package is not a safe directory");
  }
  if (
    !(await run("/usr/bin/test", ["-d", installDirectory], false)).success ||
    (await run("/usr/bin/test", ["-L", installDirectory], false)).success ||
    !(await run("/usr/bin/test", ["-w", installDirectory], false)).success
  ) {
    throw new Error(
      `${installDirectory} must be an existing writable directory and must not be a symlink`,
    );
  }

  const markerName = `.${metadata.resource as string}.version`;
  const previousVersion = await readTextFile(`${installDirectory}/${markerName}`);
  if (previousVersion === nextVersion) {
    console.log(`App 版本无变化（${nextVersion}），跳过暂存`);
    return;
  }

  const releasePath = `${installDirectory}/${nextVersion}`;
  const latestPath = `${installDirectory}/latest`;
  const nonce = uniqueId();
  const stagePath = `${installDirectory}/.sfo-deploy-${metadata
    .resource as string}-${nextVersion}-${nonce}`;
  const versionFileName = `sfo-version-${nonce}`;
  try {
    if ((await run("/usr/bin/test", ["-e", releasePath], false)).success) {
      const latestTarget = await run("/usr/bin/readlink", ["-f", latestPath], false);
      if (
        latestTarget.success &&
        new TextDecoder().decode(latestTarget.stdout).trim() === releasePath
      ) {
        throw new Error(
          `latest points to ${nextVersion}, but the version marker is missing; refusing to replace the current release`,
        );
      }
      await run("/usr/bin/rm", ["-rf", "--", releasePath]);
    }
    await run("/usr/bin/install", ["-d", "-m", "0750", "--", stagePath]);
    await run("/usr/bin/cp", ["-a", "--", `${packageInput}/.`, `${stagePath}/`]);
    await Deno.writeTextFile(versionFileName, `${nextVersion}\n`, { mode: 0o600 });
    await run("/usr/bin/install", [
      "-m",
      "0644",
      "--",
      versionFileName,
      `${stagePath}/VERSION`,
    ]);
    await run("/usr/bin/mv", ["-Tf", "--", stagePath, releasePath]);
    console.log(`App 已暂存版本 ${nextVersion}`);
  } finally {
    await run("/usr/bin/rm", ["-rf", "--", stagePath], false);
    await Deno.remove(versionFileName).catch(() => undefined);
  }
}

async function activateRelease(metadata: JsonObject): Promise<void> {
  const parameters = mapping(metadata.parameters, "step metadata parameters");
  const nextVersion = requiredString(parameters.version, "The deployed App version");
  if (!VERSION_RE.test(nextVersion)) {
    throw new Error(`The deployed App version is invalid: ${nextVersion}`);
  }
  const installDirectory = safeInstallDirectory(
    requiredString(metadata.install_directory, "The App install directory"),
    "The App install directory",
  );
  const releasePath = `${installDirectory}/${nextVersion}`;
  const latestPath = `${installDirectory}/latest`;
  const markerName = `.${metadata.resource as string}.version`;
  const markerPath = `${installDirectory}/${markerName}`;
  const previousVersion = await readTextFile(markerPath);
  if (previousVersion === nextVersion) {
    console.log(`App 版本无变化（${nextVersion}），跳过激活`);
    return;
  }
  await requireReleaseDirectory(releasePath);
  const version = await readTextFile(`${releasePath}/VERSION`);
  if (version !== nextVersion) {
    throw new Error(
      `版本目录 VERSION 不匹配: expected ${nextVersion}, got ${version ?? "missing"}`,
    );
  }

  const nonce = uniqueId();
  const latestTmp = `${installDirectory}/.sfo-deploy-latest-${nonce}`;
  const markerTmp = `${installDirectory}/.sfo-deploy-marker-${nonce}`;
  const markerFileName = `sfo-marker-${nonce}`;
  let latestSwitched = false;
  try {
    await run("/usr/bin/ln", ["-s", "--", nextVersion, latestTmp]);
    await run("/usr/bin/mv", ["-Tf", "--", latestTmp, latestPath]);
    latestSwitched = true;
    await Deno.writeTextFile(markerFileName, `${nextVersion}\n`, { mode: 0o600 });
    await run("/usr/bin/install", ["-m", "0640", "--", markerFileName, markerTmp]);
    await run("/usr/bin/mv", ["-f", "--", markerTmp, markerPath]);

    const keepVersions = metadata.keep_versions;
    if (typeof keepVersions === "number") {
      await cleanupOldVersions(installDirectory, nextVersion, keepVersions);
    }
    console.log(`App 已发布版本 ${nextVersion}`);
  } catch (error) {
    if (latestSwitched) {
      const rollbackTmp = `${installDirectory}/.sfo-deploy-latest-rollback-${nonce}`;
      try {
        if (previousVersion === undefined) {
          await run("/usr/bin/rm", ["-f", "--", latestPath, markerPath], false);
        } else {
          await run("/usr/bin/ln", ["-s", "--", previousVersion, rollbackTmp]);
          await run("/usr/bin/mv", ["-Tf", "--", rollbackTmp, latestPath]);
          await Deno.writeTextFile(markerFileName, `${previousVersion}\n`, { mode: 0o600 });
          await run("/usr/bin/install", ["-m", "0640", "--", markerFileName, markerTmp]);
          await run("/usr/bin/mv", ["-f", "--", markerTmp, markerPath]);
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "版本激活失败且 latest/版本标记恢复不完整",
        );
      }
    }
    throw error;
  } finally {
    await run("/usr/bin/rm", ["-f", "--", latestTmp, markerTmp], false);
    await Deno.remove(markerFileName).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const metadata = await readMetadata();
  const deployment = mapping(metadata.deployment, "step metadata deployment");
  if (deployment.kind !== "versioned") {
    throw new Error("Only the built-in versioned deployment is supported");
  }
  const resource = requiredString(metadata.resource, "The deployed App name");
  if (!APP_NAME_RE.test(resource)) {
    throw new Error(`The deployed App name is invalid: ${resource}`);
  }
  if (metadata.kind !== "app") {
    throw new Error("The built-in release only runs for App deployment steps");
  }
  if (metadata.action === "stage") {
    await stageRelease(metadata);
    return;
  }
  if (metadata.action === "activate") {
    await activateRelease(metadata);
    return;
  }
  if (metadata.action !== "deploy") {
    throw new Error("The built-in release only supports stage, activate and deploy");
  }
  await stageRelease(metadata);
  await activateRelease(metadata);
}

await main();
