import { assertStringIncludes, withTempDir } from "../_support/assert.ts";
import {
  parseFilehubVersions,
  parseUpdateOptions,
  renderAppVersions,
  requiredApps,
  selectLatestVersion,
  writeAtomically,
} from "../../examples/eleph-server-multipass/scripts/update-filehub-app-versions.ts";

function version(number: number, timestamp: string) {
  return {
    project_id: 1,
    version: `0.1.${number}`,
    published_at: timestamp,
    locked_at: null,
    apps: [
      {
        app: "jx-server",
        file_id: "a".repeat(36),
        sha256: "a".repeat(64),
        size: 120,
        updated_at: timestamp,
      },
      {
        app: "jx-web",
        file_id: "b".repeat(36),
        sha256: "b".repeat(64),
        size: 32,
        updated_at: timestamp,
      },
    ],
  };
}

Deno.test("unit/update-filehub-app-versions: selects latest by published_at", () => {
  const versions = parseFilehubVersions([
    version(0, "2026-08-31T14:42:32.952576773Z"),
    version(1, "2026-09-02T08:00:00.000000000Z"),
  ]);
  const latest = selectLatestVersion(versions);
  const apps = requiredApps(latest);
  const yaml = renderAppVersions(latest, apps);

  if (latest.version !== "0.1.1") throw new Error("selected wrong latest version");
  assertStringIncludes(yaml, 'version: "0.1.1"');
  assertStringIncludes(yaml, "provider: filehub");
  assertStringIncludes(yaml, 'target: "filehub.mynode.site:8443/eleph-server/0.1.1/jx-server"');
  assertStringIncludes(yaml, `value: "${"b".repeat(64)}"`);
});

Deno.test("unit/update-filehub-app-versions: rejects missing apps and invalid hashes", () => {
  const missingWeb = parseFilehubVersions([{
    version: "0.1.0",
    published_at: "2026-09-01T00:00:00Z",
    locked_at: null,
    apps: [{
      app: "jx-server",
      file_id: "a".repeat(36),
      sha256: "a".repeat(64),
      size: 1,
      updated_at: "2026-09-01T00:00:00Z",
    }],
  }]);
  let error;
  try {
    requiredApps(selectLatestVersion(missingWeb));
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || !error.message.includes("is missing App: jx-web")) {
    throw new Error("missing jx-web was not rejected");
  }

  let hashError;
  try {
    parseFilehubVersions([{
      version: "0.1.0",
      published_at: "2026-09-01T00:00:00Z",
      locked_at: null,
      apps: [{
        app: "jx-server",
        file_id: "a".repeat(36),
        sha256: "not-a-hash",
        size: 1,
        updated_at: "2026-09-01T00:00:00Z",
      }],
    }]);
  } catch (caught) {
    hashError = caught;
  }
  if (!(hashError instanceof Error) || !hashError.message.includes("64-character hexadecimal")) {
    throw new Error("invalid hash was not rejected");
  }
});

Deno.test("unit/update-filehub-app-versions: rejects unknown options", () => {
  let error;
  try {
    parseUpdateOptions(["--write", "--yes"]);
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || !error.message.includes("Unknown argument: --yes")) {
    throw new Error("unknown option was not rejected");
  }
});

Deno.test("unit/update-filehub-app-versions: atomically replaces target", async () => {
  await withTempDir(async (root) => {
    const target = `${root}/app_versions.yaml`;
    await Deno.writeTextFile(target, "old\n");
    await writeAtomically(target, "new\n");

    const content = await Deno.readTextFile(target);
    const siblings = [...Deno.readDirSync(root)].map((entry) => entry.name);
    if (content !== "new\n") throw new Error("atomic write did not replace target");
    if (siblings.length !== 1 || siblings[0] !== "app_versions.yaml") {
      throw new Error("atomic write left temporary files");
    }
  });
});
