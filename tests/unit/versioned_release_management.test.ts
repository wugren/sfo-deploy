import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { FakeSession } from "../_support/fake_session.ts";
import { type CommandResult, commandResult } from "../../src/results.ts";
import type { RemoteRunOptions } from "../../src/transport.ts";
import { PreflightError, TransportError } from "../../src/errors.ts";
import {
  cleanupVersionedRelease,
  finalizeVersionedRelease,
  prepareVersionedRelease,
  restoreVersionedRelease,
  switchVersionedRelease,
} from "../../src/versioned_release_management.ts";
import {
  executePreparedSystemd,
  prepareSystemd,
  restoreSystemd,
} from "../../src/service_management.ts";
import type { AppServiceManagement } from "../../src/types.ts";

/** Run the production fixed argv against disposable real directories, never real systemd. */
class LocalSession extends FakeSession {
  fail?: (argv: readonly string[]) => boolean;
  override async run(
    argv: readonly string[],
    options: RemoteRunOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({ argv: [...argv], options });
    if (this.fail?.(argv)) return commandResult(1, "", "injected failure");
    const result = await new Deno.Command(argv[0], { args: [...argv.slice(1)] }).output();
    return commandResult(
      result.code,
      new TextDecoder().decode(result.stdout),
      new TextDecoder().decode(result.stderr),
    );
  }
}

async function release(root: string, version: string) {
  await Deno.mkdir(`${root}/${version}`, { recursive: true });
  await Deno.writeTextFile(`${root}/${version}/VERSION`, `${version}\n`);
}
async function fixture(root: string, old = "v1", next = "v2") {
  await release(root, next);
  if (old) {
    await release(root, old);
    await Deno.symlink(old, `${root}/latest`);
    await Deno.writeTextFile(`${root}/.demo.version`, `${old}\n`);
  }
  const identity = await new Deno.Command("id", { args: ["-un"] }).output();
  assertEquals(identity.code, 0);
  const runAs = new TextDecoder().decode(identity.stdout).trim();
  return { installDirectory: root, resource: "demo", version: next, runAs };
}

Deno.test("unit/versioned-release: prepare leaves old link and marker; switch only renames; commit follows", async () => {
  await withTempDir(async (root) => {
    const session = new LocalSession();
    const state = await prepareVersionedRelease(session, await fixture(root));
    assertEquals(await Deno.readLink(`${root}/latest`), "v1");
    assertEquals(await Deno.readTextFile(state.markerPath), "v1\n");
    session.calls.length = 0;
    await switchVersionedRelease(session, state);
    assertEquals(session.calls.map((call) => call.argv), [[
      "/usr/bin/mv",
      "-Tf",
      "--",
      state.temporaryLatest,
      state.latestPath,
    ]]);
    assertEquals(await Deno.readLink(state.latestPath), "v2");
    assertEquals(await Deno.readTextFile(state.markerPath), "v1\n");
    await finalizeVersionedRelease(session, state);
    assertEquals(await Deno.readTextFile(state.markerPath), "v2\n");
    await cleanupVersionedRelease(session, state);
    await assertRejects(() => Deno.lstat(state.previousMarkerBackup), Deno.errors.NotFound);
  });
});

for (const old of ["", "v2"]) {
  Deno.test(`unit/versioned-release: ${old ? "same-version" : "first"} publication restores pre-state`, async () => {
    await withTempDir(async (root) => {
      const session = new LocalSession();
      const state = await prepareVersionedRelease(session, await fixture(root, old));
      await switchVersionedRelease(session, state);
      await finalizeVersionedRelease(session, state);
      await restoreVersionedRelease(session, state);
      await cleanupVersionedRelease(session, state);
      if (old) {
        assertEquals(await Deno.readLink(state.latestPath), old);
        assertEquals(await Deno.readTextFile(state.markerPath), `${old}\n`);
      } else {
        await assertRejects(() => Deno.lstat(state.latestPath), Deno.errors.NotFound);
        await assertRejects(() => Deno.lstat(state.markerPath), Deno.errors.NotFound);
      }
    });
  });
}

Deno.test("unit/versioned-release: marker failure and failed restore retain recovery backup", async () => {
  await withTempDir(async (root) => {
    const session = new LocalSession();
    const state = await prepareVersionedRelease(session, await fixture(root));
    await switchVersionedRelease(session, state);
    session.fail = (argv) => argv[0] === "/usr/bin/mv" && argv.at(-1) === state.markerPath;
    await assertRejects(() => finalizeVersionedRelease(session, state), TransportError);
    await assertRejects(() => restoreVersionedRelease(session, state), AggregateError);
    await assertRejects(() => cleanupVersionedRelease(session, state), TransportError);
    assertEquals(await Deno.readTextFile(state.previousMarkerBackup), "v1\n");
    session.fail = undefined;
    await restoreVersionedRelease(session, state);
    assertEquals(await Deno.readLink(state.latestPath), "v1");
    assertEquals(await Deno.readTextFile(state.markerPath), "v1\n");
    await cleanupVersionedRelease(session, state);
  });
});

Deno.test("unit/versioned-release: lost switch response restores actual link and original marker", async () => {
  await withTempDir(async (root) => {
    class LostResponse extends LocalSession {
      lose = true;
      override async run(argv: readonly string[], options: RemoteRunOptions = {}) {
        const result = await super.run(argv, options);
        if (this.lose && argv[0] === "/usr/bin/mv" && argv.at(-1) === `${root}/latest`) {
          this.lose = false;
          throw new TransportError("response lost");
        }
        return result;
      }
    }
    const session = new LostResponse();
    const state = await prepareVersionedRelease(session, await fixture(root));
    await assertRejects(() => switchVersionedRelease(session, state), TransportError);
    assertEquals(await Deno.readLink(state.latestPath), "v2");
    await restoreVersionedRelease(session, state);
    assertEquals(await Deno.readLink(state.latestPath), "v1");
    assertEquals(await Deno.readTextFile(state.markerPath), "v1\n");
    await cleanupVersionedRelease(session, state);
  });
});

Deno.test("unit/versioned-release: keepVersions retains current and newest valid release, ignores unrelated dirs", async () => {
  await withTempDir(async (root) => {
    const request = await fixture(root);
    await release(root, "v0");
    await Deno.utime(`${root}/v0`, 1, 1);
    await Deno.utime(`${root}/v1`, 2, 2);
    await Deno.mkdir(`${root}/resources`);
    await Deno.mkdir(`${root}/invalid`);
    await Deno.writeTextFile(`${root}/invalid/VERSION`, "different\n");
    const session = new LocalSession();
    const state = await prepareVersionedRelease(session, { ...request, keepVersions: 2 });
    await switchVersionedRelease(session, state);
    assert((await Deno.stat(`${root}/v0`)).isDirectory);
    await finalizeVersionedRelease(session, state);
    await cleanupVersionedRelease(session, state);
    await assertRejects(() => Deno.stat(`${root}/v0`), Deno.errors.NotFound);
    for (const retained of ["v1", "v2", "resources", "invalid"]) {
      assert((await Deno.stat(`${root}/${retained}`)).isDirectory);
    }
  });
});

Deno.test("unit/versioned-release: reject traversal and symlink release without touching latest", async () => {
  await withTempDir(async (root) => {
    const session = new LocalSession();
    const request = await fixture(root);
    for (const version of ["../v1", "v2/../v1", "-v1"]) {
      await assertRejects(
        () => prepareVersionedRelease(session, { ...request, version }),
        PreflightError,
      );
    }
    await Deno.remove(`${root}/v2`, { recursive: true });
    await Deno.symlink("v1", `${root}/v2`);
    await assertRejects(() => prepareVersionedRelease(session, request), TransportError);
    assertEquals(await Deno.readLink(`${root}/latest`), "v1");
  });
});

Deno.test("unit/versioned-release: systemd preparation precedes immediate action and recovery forces restart", async () => {
  class SystemdRecorder extends FakeSession {
    enabled = false;
    override run(argv: readonly string[], options: RemoteRunOptions = {}) {
      this.calls.push({ argv: [...argv], options });
      if (argv[1] === "enable") this.enabled = true;
      if (argv[1] === "disable") this.enabled = false;
      return Promise.resolve(
        argv[1] === "is-enabled"
          ? commandResult(this.enabled ? 0 : 1, this.enabled ? "enabled\n" : "disabled\n")
          : commandResult(0, argv[1] === "is-active" ? "active\n" : ""),
      );
    }
  }
  const service: AppServiceManagement = {
    kind: "service",
    unit: "demo.service",
    tool: "systemctl",
    enabled: true,
    daemonReload: true,
    onDeploy: "restart",
    timeoutMs: 1000,
  };
  const before = { enabled: false, enabledState: "disabled", active: true, activeState: "active" };
  for (const action of ["start", "restart"] as const) {
    const session = new SystemdRecorder();
    const prepared = await prepareSystemd(session, service, {
      operation: "deploy",
      changed: true,
      actionOverride: action,
    }, before);
    assertEquals(session.calls.map((call) => call.argv[1]), ["daemon-reload", "enable"]);
    session.calls.length = 0;
    await executePreparedSystemd(session, service, prepared);
    assertEquals(session.calls[0].argv, ["systemctl", action, "--", "demo.service"]);
    session.calls.length = 0;
    await restoreSystemd(session, service, before, false, undefined, true);
    assertEquals(session.calls.filter((call) => call.argv[1] === "restart").length, 1);
    assertEquals(session.enabled, false);
  }
});

Deno.test("unit/versioned-release: committed marker is readable by app and real same-version stage succeeds", async () => {
  await withTempDir(async (root) => {
    const decoder = new TextDecoder();
    const uidResult = await new Deno.Command("id", { args: ["-u"] }).output();
    assertEquals(uidResult.code, 0);
    const isRoot = decoder.decode(uidResult.stdout).trim() === "0";
    const app = `${root}/app`;
    await Deno.mkdir(app);
    const request = await fixture(app);
    // Root CI exercises a genuinely different uid. Non-root development uses the
    // current application account, still checking the marker's uid/mode and real stage.
    const runAs = isRoot ? "nobody" : request.runAs;
    const account = await new Deno.Command("id", { args: ["-u", runAs] }).output();
    assertEquals(account.code, 0);
    const appUid = Number(decoder.decode(account.stdout).trim());
    if (isRoot) assert(appUid !== 0);
    await Deno.chmod(root, 0o755);
    await Deno.chmod(app, 0o750);
    const packagePath = `${app}/package`;
    await Deno.mkdir(packagePath);
    const script = `${root}/release.ts`;
    await Deno.copyFile("src/remote_runtime/versioned_release.ts", script);
    await Deno.chmod(script, 0o644);
    // The installed Deno executable may be under /root; copy it into traversable
    // temporary storage so failure cannot be caused by the test harness's HOME.
    const executable = `${root}/deno`;
    await Deno.copyFile(Deno.execPath(), executable);
    await Deno.chmod(executable, 0o755);
    const metadataPath = `${app}/metadata.json`;
    await Deno.writeTextFile(
      metadataPath,
      JSON.stringify({
        kind: "app",
        resource: "demo",
        action: "stage",
        deployment: { kind: "versioned" },
        install_directory: app,
        package_path: packagePath,
        package_kind: "validated-directory",
        parameters: { version: "v2" },
      }),
    );
    if (isRoot) {
      const ownership = await new Deno.Command("chown", { args: ["-R", runAs, app] }).output();
      assertEquals(ownership.code, 0, decoder.decode(ownership.stderr));
    }
    assertEquals((await Deno.stat(app)).uid, appUid);
    assertEquals((await Deno.stat(root)).mode! & 0o777, 0o755);
    const session = new LocalSession();
    const state = await prepareVersionedRelease(session, { ...request, runAs });
    await switchVersionedRelease(session, state);
    await finalizeVersionedRelease(session, state);
    const marker = await Deno.stat(state.markerPath);
    assertEquals(marker.uid, appUid);
    assertEquals(marker.mode! & 0o777, 0o640);
    const asApp = (command: string, args: string[], env?: Record<string, string>) =>
      new Deno.Command(isRoot ? "/usr/sbin/runuser" : command, {
        args: isRoot ? ["-u", runAs, "--", command, ...args] : args,
        cwd: root,
        env,
      }).output();
    const read = await asApp("/usr/bin/cat", [state.markerPath]);
    assertEquals(read.code, 0, decoder.decode(read.stderr));
    assertEquals(decoder.decode(read.stdout), "v2\n");
    await cleanupVersionedRelease(session, state);
    const staged = await asApp(executable, [
      "run",
      "--no-config",
      "--no-remote",
      "--no-npm",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env=DEPLOYMENT_METADATA_PATH",
      script,
    ], { DEPLOYMENT_METADATA_PATH: metadataPath, DENO_DIR: `${app}/deno-cache` });
    assertEquals(staged.code, 0, decoder.decode(staged.stderr));
    assert(decoder.decode(staged.stdout).includes("skipping staging"));
    assertEquals(await Deno.readLink(state.latestPath), "v2");
    assertEquals(await Deno.readTextFile(state.markerPath), "v2\n");
  });
});
