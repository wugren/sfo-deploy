import { createHash } from "node:crypto";
import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";
import type {
  BuiltDeploymentBundle,
  DeploymentBundleManifest,
} from "../../src/deployment_bundle.ts";
import { PreflightError } from "../../src/errors.ts";
import { type CommandFactory, OpenSshTransport, type SpawnedCommand } from "../../src/transport.ts";

function output(code = 0, stdout = "", stderr = ""): Deno.CommandOutput {
  return {
    success: code === 0,
    code,
    signal: null,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
  };
}

function spawned(result: Deno.CommandOutput | Promise<Deno.CommandOutput>): SpawnedCommand {
  return { output: () => Promise.resolve(result), kill: () => undefined };
}

function hasNoControl(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code >= 32 && code !== 127;
  });
}

Deno.test("integration/managed-transport: 真实 OpenSSH 路径的部署成员和已有配置 stat argv 无控制字符", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    const localBundle = join(root, "bundle.tar.gz");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    await Deno.writeFile(localBundle, new Uint8Array(123));
    const manifest: DeploymentBundleManifest = Object.freeze({
      schema_version: 1,
      entries: Object.freeze([
        Object.freeze({
          path: "package/app.tar.gz",
          purpose: "package" as const,
          size: 10,
          sha256: "1".repeat(64),
          mode: "0600",
        }),
        Object.freeze({
          path: "scripts/update.ts",
          purpose: "script" as const,
          size: 20,
          sha256: "2".repeat(64),
          mode: "0700",
        }),
        Object.freeze({
          path: "scripts/sfo-config-updater.ts",
          purpose: "script" as const,
          size: 30,
          sha256: "3".repeat(64),
          mode: "0700",
        }),
      ]),
    });
    const bundle: BuiltDeploymentBundle = Object.freeze({
      path: localBundle,
      size: 123,
      sha256: "a".repeat(64),
      manifest,
    });
    const manifestText = `${JSON.stringify(manifest, undefined, 2)}\n`;
    const manifestDigest = createHash("sha256").update(manifestText).digest("hex");
    const remoteCalls: string[] = [];
    const factory: CommandFactory = (command, args) => {
      const remote = String(args.at(-1) ?? "");
      if (command === "ssh") remoteCalls.push(remote);
      if (command === "scp") return spawned(output());
      if (remote === "exec 'true'") return spawned(output());
      if (remote.includes("printf")) return spawned(output(0, "/home/deploy"));
      if (remote.includes("'getent' 'passwd' 'deploy'")) {
        return spawned(output(0, "deploy:x:1000:1000::/home/deploy:/bin/sh\n"));
      }
      if (remote === "exec 'id' '-u'" || remote.includes("'id' '-u' 'deploy'")) {
        return spawned(output(0, "1000\n"));
      }
      if (remote.includes("'id' '-un'")) return spawned(output(0, "deploy\n"));
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("'/.ready'")) {
        return spawned(output(1));
      }
      if (remote.includes("'/usr/bin/test' '-e'") && remote.includes("/deployment-")) {
        return spawned(output(1));
      }
      if (remote.includes("'tar' '-tzf'")) {
        return spawned(output(
          0,
          "manifest.json\npackage/app.tar.gz\nscripts/sfo-config-updater.ts\nscripts/update.ts\n",
        ));
      }
      if (remote.includes("'tar' '-tvzf'")) {
        return spawned(output(
          0,
          "-rw------- user group 1 Jan 1 00:00 manifest.json\n" +
            "-rw------- user group 10 Jan 1 00:00 package/app.tar.gz\n" +
            "-rwx------ user group 30 Jan 1 00:00 scripts/sfo-config-updater.ts\n" +
            "-rwx------ user group 20 Jan 1 00:00 scripts/update.ts\n",
        ));
      }
      if (remote.includes("'stat' '-c' '%F'")) return spawned(output(0, "regular file\n"));
      if (remote.includes("'stat' '-c' '%s'")) {
        const size = remote.includes("/manifest.json'")
          ? new TextEncoder().encode(manifestText).length
          : remote.includes("/package/app.tar.gz'")
          ? 10
          : remote.includes("/scripts/update.ts'")
          ? 20
          : remote.includes("/scripts/sfo-config-updater.ts'")
          ? 30
          : remote.includes("/bundle-")
          ? 123
          : 42;
        return spawned(output(0, `${size}\n`));
      }
      if (remote.includes("'stat' '-c' '%a'")) return spawned(output(0, "600\n"));
      if (remote.includes("'stat' '-c' '%U'")) return spawned(output(0, "deploy\n"));
      if (remote.includes("'stat' '-c' '%G'")) return spawned(output(0, "deploy\n"));
      if (remote.includes("'sha256sum'")) {
        const digest = remote.includes("/manifest.json'")
          ? manifestDigest
          : remote.includes("/package/app.tar.gz'")
          ? "1".repeat(64)
          : remote.includes("/scripts/update.ts'")
          ? "2".repeat(64)
          : remote.includes("/scripts/sfo-config-updater.ts'")
          ? "3".repeat(64)
          : bundle.sha256;
        return spawned(output(0, `${digest}  remote\n`));
      }
      if (remote.includes("'/usr/bin/test' '-d' '/etc/demo'")) return spawned(output());
      if (remote.includes("'/usr/bin/test' '-e' '/etc/demo/current.conf'")) {
        return spawned(output());
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({ knownHosts, commandFactory: factory }).connect(
      resolved("node-a"),
    );
    const workspace = await session.createWorkspace();
    const staged = await session.stageDeploymentBundle!(bundle, { workspace });
    const candidate = await session.createManagedConfigCandidate!({
      name: "current",
      workspace,
      updaterScript: `${staged.root}/scripts/sfo-config-updater.ts`,
      denoExecutable: "/usr/bin/deno",
      format: "yaml",
      skeleton: `${staged.root}/package/app.tar.gz`,
      bindings: `${staged.root}/manifest.json`,
      secretDir: `${workspace}/secrets-current`,
      secretRoot: "/home/deploy/.sfo-deploy/secrets",
      fileSecrets: Object.freeze([]),
      timeoutMs: 1000,
    });
    const publications = await session.publishManagedConfigs!([{
      candidate,
      target: "/etc/demo/current.conf",
      mode: 0o600,
      owner: "deploy",
      group: "deploy",
      secretRoot: "/home/deploy/.sfo-deploy/secrets",
      secretFiles: Object.freeze([]),
    }]);
    assertEquals(publications[0].changed, false);
    assert(remoteCalls.some((call) => call.includes("/package/app.tar.gz'")));
    assert(
      remoteCalls.some((call) => call.includes("'stat' '-c' '%a' '--' '/etc/demo/current.conf'")),
    );
    assert(remoteCalls.every(hasNoControl));
    await session.close();
  });
});

Deno.test("integration/managed-transport: Deno 脚本以 SSH 身份运行且不注入 HOME 覆盖", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const calls: string[] = [];
    const factory: CommandFactory = (_command, args) => {
      calls.push(String(args.at(-1) ?? ""));
      return spawned(output());
    };
    const session = await new OpenSshTransport({ knownHosts, commandFactory: factory }).connect(
      resolved("node-a"),
    );
    const workspace = await session.createWorkspace();
    const secrets = `${workspace}/scoped-secrets`;
    await session.executeDeno("/usr/bin/deno", `${workspace}/lifecycle.ts`, {
      workspace,
      metadataPath: `${workspace}/metadata.json`,
      secretDir: secrets,
      permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
    });
    const lifecycle = calls.filter((call) => call.includes("'/usr/bin/deno' 'run'"));
    assertEquals(lifecycle.length, 1);
    assert(!lifecycle[0].includes("'sudo'"), lifecycle[0]);
    assert(!lifecycle[0].includes("'getent'"), lifecycle[0]);
    assert(!lifecycle[0].includes("'HOME="), lifecycle[0]);
    assert(lifecycle[0].includes(`'DEPLOYMENT_SECRETS_DIR=${secrets}'`), lifecycle[0]);
    assert(lifecycle[0].includes("'DEPLOYMENT_METADATA_PATH="), lifecycle[0]);
    await session.close();
  });
});

Deno.test("integration/managed-transport: flock 成功释放、争用超时和取消均清理持有进程", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let resolveHolder!: (value: Deno.CommandOutput) => void;
    let killed = false;
    const holder = new Promise<Deno.CommandOutput>((resolve) => resolveHolder = resolve);
    const calls: string[] = [];
    const successFactory: CommandFactory = (_command, args) => {
      const remote = String(args.at(-1) ?? "");
      calls.push(remote);
      if (remote.includes("exec 'flock'")) {
        return {
          output: () => holder,
          kill: () => {
            killed = true;
            resolveHolder(output(143));
          },
        };
      }
      if (remote.includes("'/usr/bin/test' '-f'") && remote.includes("lock-ready-")) {
        return spawned(output());
      }
      if (remote.includes("'rm' '-f' '--'") && remote.includes("lock-stop-")) {
        queueMicrotask(() => resolveHolder(output()));
      }
      return spawned(output());
    };
    const session = await new OpenSshTransport({
      knownHosts,
      commandFactory: successFactory,
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    const lease = await session.acquireOperationLock!({
      app: "demo",
      target: "node-a",
      timeoutMs: 200,
    });
    await session.releaseOperationLock!(lease);
    assertEquals(killed, false);
    assert(calls.some((call) => call.includes("'flock' '--exclusive' '--wait'")));
    await session.close();

    const contention = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) =>
        String(args.at(-1) ?? "").includes("exec 'flock'")
          ? spawned(output(73))
          : spawned(output()),
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    await assertRejects(
      () => contention.acquireOperationLock!({ app: "demo", target: "node-a", timeoutMs: 50 }),
      PreflightError,
      "acquisition timed out",
    );
    await contention.close();

    let cancelledHolderKilled = false;
    let resolveCancelled!: (value: Deno.CommandOutput) => void;
    const cancelledOutput = new Promise<Deno.CommandOutput>((resolve) =>
      resolveCancelled = resolve
    );
    const cancelled = await new OpenSshTransport({
      knownHosts,
      commandFactory: (_command, args) => {
        const remote = String(args.at(-1) ?? "");
        if (remote.includes("exec 'flock'")) {
          return {
            output: () => cancelledOutput,
            kill: () => {
              cancelledHolderKilled = true;
              resolveCancelled(output(143));
            },
          };
        }
        return spawned(output());
      },
      terminateTimeoutMs: 50,
    }).connect(resolved("node-a"));
    const controller = new AbortController();
    controller.abort("cancel lock");
    await assertRejects(
      () =>
        cancelled.acquireOperationLock!(
          { app: "demo", target: "node-a", timeoutMs: 100 },
          controller.signal,
        ),
    );
    assert(cancelledHolderKilled);
    await cancelled.close();
  });
});
