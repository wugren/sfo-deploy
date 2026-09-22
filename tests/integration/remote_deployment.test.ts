import { createHash } from "node:crypto";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";
import type {
  BuiltDeploymentBundle,
  DeploymentBundleManifest,
} from "../../src/deployment_bundle.ts";
import { PreflightError, TransportError } from "../../src/errors.ts";
import {
  extractValidatedAppPackage,
  type RemoteDeploymentChannel,
  stageDeploymentBundle,
} from "../../src/remote_deployment.ts";
import { type CommandResult, commandResult } from "../../src/results.ts";
import { OpenSshTransport, type SpawnedCommand } from "../../src/transport.ts";

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
      path: "scripts/deploy.ts",
      purpose: "script" as const,
      size: 20,
      sha256: "2".repeat(64),
      mode: "0700",
    }),
  ]),
});
const bundle: BuiltDeploymentBundle = Object.freeze({
  path: "/local/bundle.tar.gz",
  size: 123,
  sha256: "a".repeat(64),
  manifest,
});

class Channel implements RemoteDeploymentChannel {
  readonly calls: readonly string[][] = [] as unknown as string[][];
  readonly uploads: string[] = [];
  constructor(readonly reused = false, readonly tamperPath?: string) {}

  uploadFile(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push(`${localPath} -> ${remotePath}`);
    return Promise.resolve();
  }

  run(argv: readonly string[]): Promise<CommandResult> {
    (this.calls as string[][]).push([...argv]);
    const path = argv.at(-1) ?? "";
    if (argv[0] === "/usr/bin/test" && argv[1] === "-f" && path.endsWith("/.ready")) {
      return Promise.resolve(commandResult(this.reused ? 0 : 1));
    }
    if (argv[0] === "/usr/bin/test" && argv[1] === "-e") {
      return Promise.resolve(commandResult(1));
    }
    if (argv[0] === "stat" && argv[2] === "%s" && path.includes("/bundle-")) {
      return Promise.resolve(commandResult(0, `${bundle.size}\n`));
    }
    if (argv[0] === "tar" && argv[1] === "-tzf") {
      return Promise.resolve(commandResult(
        0,
        ["manifest.json", ...manifest.entries.map((entry) => entry.path)].join("\n") + "\n",
      ));
    }
    if (argv[0] === "tar" && argv[1] === "-tvzf") {
      return Promise.resolve(commandResult(
        0,
        ["manifest.json", ...manifest.entries.map((entry) => entry.path)]
          .map((name) => `-rw------- user group 1 Jan 1 00:00 ${name}`).join("\n") + "\n",
      ));
    }
    if (argv[0] === "stat") {
      const entry = manifest.entries.find((item) => path.endsWith(`/${item.path}`));
      const size = entry?.size ??
        new TextEncoder().encode(`${JSON.stringify(manifest, undefined, 2)}\n`).length;
      return Promise.resolve(commandResult(0, `regular file\t${size}\n`));
    }
    if (argv[0] === "sha256sum") {
      let digest = bundle.sha256;
      if (path.endsWith("/manifest.json")) {
        digest = createHash("sha256").update(`${JSON.stringify(manifest, undefined, 2)}\n`).digest(
          "hex",
        );
      } else {
        const entry = manifest.entries.find((item) => path.endsWith(`/${item.path}`));
        if (entry) digest = entry.sha256;
      }
      if (this.tamperPath && path.endsWith(this.tamperPath)) digest = "f".repeat(64);
      return Promise.resolve(commandResult(0, `${digest}  ${path}\n`));
    }
    return Promise.resolve(commandResult(0));
  }
}

Deno.test("integration/remote-deployment: 单次上传后按外层、列表、类型、成员顺序校验并发布", async () => {
  const channel = new Channel();
  const staged = await stageDeploymentBundle(channel, bundle, {
    workspace: "/tmp/sfo-deploy-attempt",
  });
  assertEquals(channel.uploads.length, 1);
  assertEquals(staged.packagePath, `${staged.root}/package/app.tar.gz`);
  assertEquals(staged.scripts.get("deploy.ts"), `${staged.root}/scripts/deploy.ts`);
  assertEquals(staged.reused, false);
  const operations = channel.calls.map((argv) => argv.slice(0, 2).join(" "));
  assert(operations.indexOf("sha256sum --") < operations.indexOf("tar -tzf"));
  assert(operations.indexOf("tar -tvzf") < operations.indexOf("tar --extract"));
  assert(channel.calls.some((argv) => argv[0] === "mv" && argv[1] === "-T"));
  assert(channel.calls.some((argv) => argv[0] === "rm" && argv[1] === "-f"));
  assert(
    channel.calls.flat().every((argument) =>
      [...argument].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && code !== 127;
      })
    ),
  );
});

Deno.test("integration/remote-deployment: ready 内容按摘要复验并零上传复用", async () => {
  const channel = new Channel(true);
  const staged = await stageDeploymentBundle(channel, bundle, {
    workspace: "/tmp/sfo-deploy-attempt",
  });
  assertEquals(staged.reused, true);
  assertEquals(channel.uploads, []);
  assert(channel.calls.filter((argv) => argv[0] === "sha256sum").length >= 3);
});

Deno.test("integration/remote-deployment: 成员篡改清理 pending/archive 且不写 ready", async () => {
  const channel = new Channel(false, "/scripts/deploy.ts");
  const error = await assertRejects(
    () => stageDeploymentBundle(channel, bundle, { workspace: "/tmp/sfo-deploy-attempt" }),
    TransportError,
  );
  assertStringIncludes(error.message, "member SHA-256");
  assertEquals(channel.calls.some((argv) => argv[0] === "touch"), false);
  assert(channel.calls.some((argv) => argv[0] === "rm" && argv[1] === "-rf"));
  assert(channel.calls.some((argv) => argv[0] === "rm" && argv[1] === "-f"));
});

Deno.test("integration/remote-deployment: 不安全路径、用途错配和重复 package 在上传前拒绝", async () => {
  const badEntries = [
    [{ ...manifest.entries[0], path: "../escape" }],
    [{ ...manifest.entries[0], path: "scripts/app.tar.gz" }],
    [manifest.entries[0], { ...manifest.entries[0], path: "package/other.tar.gz" }],
  ];
  for (const entries of badEntries) {
    const channel = new Channel();
    await assertRejects(
      () =>
        stageDeploymentBundle(channel, {
          ...bundle,
          manifest: { schema_version: 1, entries },
        }, { workspace: "/tmp/sfo-deploy-attempt" }),
      PreflightError,
    );
    assertEquals(channel.uploads, []);
  }
});

Deno.test("integration/remote-deployment: 配置渲染器使用固定参数和 deny env/net/run/ffi 沙箱", async () => {
  await withTempDir(async (root) => {
    const knownHosts = `${root}/known_hosts`;
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const rendered: string[] = [];
    const factory = (_command: string, args: readonly string[]): SpawnedCommand => {
      const remote = String(args.at(-1) ?? "");
      rendered.push(remote);
      let stdout = "";
      if (remote.includes("printf")) stdout = "/home/deploy";
      else if (remote.includes("'getent' 'passwd' 'deploy'")) {
        stdout = "deploy:x:1000:1000::/home/deploy:/bin/sh\n";
      } else if (remote.includes("'id' '-u' 'deploy'")) stdout = "1000\n";
      else if (remote.includes("'id' '-un'")) stdout = "deploy\n";
      else if (remote === "exec 'id' '-u'") stdout = "0\n";
      else if (remote.includes("'id' '-u'")) stdout = "1000\n";
      else if (remote.includes("'stat'")) stdout = "regular file\t42\n";
      return {
        output: () =>
          Promise.resolve({
            success: true,
            code: 0,
            signal: null,
            stdout: new TextEncoder().encode(stdout),
            stderr: new Uint8Array(),
          }),
        kill: () => undefined,
      };
    };
    const session = await new OpenSshTransport({ knownHosts, commandFactory: factory }).connect(
      resolved("node-a"),
    );
    const workspace = await session.createWorkspace();
    const stagedRoot = `${workspace}/deployment-${"a".repeat(64)}`;
    await session.createManagedConfigCandidate!({
      name: "custom",
      workspace,
      updaterScript: `${stagedRoot}/scripts/sfo-config-updater.ts`,
      denoExecutable: "/usr/bin/deno",
      format: "yaml",
      skeleton: `${stagedRoot}/configs/custom.skeleton`,
      bindings: `${stagedRoot}/configs/custom.skeleton.bindings.json`,
      secretDir: `${workspace}/secrets`,
      secretRoot: "/home/deploy/.sfo-deploy/secrets",
      fileSecrets: Object.freeze([]),
      timeoutMs: 1234,
    });
    const denoRuns = rendered.filter((command) => command.includes("'/usr/bin/deno' 'run'"));
    assertEquals(denoRuns.length, 1);
    // 配置渲染器以 SSH 身份直接运行，不再降权到 run_as，也不注入 HOME。
    assert(denoRuns.every((command) => !command.includes("'sudo'")));
    assert(denoRuns.every((command) => !command.includes("'HOME=")));
    assert(rendered.every((command) =>
      [...command].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && code !== 127;
      })
    ));
    for (const command of denoRuns) {
      for (
        const flag of [
          "--no-remote",
          "--no-npm",
          "--deny-env",
          "--deny-net",
          "--deny-run",
          "--deny-ffi",
        ]
      ) {
        assertStringIncludes(command, `'${flag}'`);
      }
    }
    assertStringIncludes(denoRuns[0], "'--input'");
    assertStringIncludes(denoRuns[0], "'--output'");
    assertStringIncludes(denoRuns[0], "'--bindings'");
    assertStringIncludes(denoRuns[0], "'--secrets'");
    assertStringIncludes(denoRuns[0], "'--secret-root'");
    await session.close();
  });
});

class InnerArchiveChannel implements RemoteDeploymentChannel {
  readonly calls: string[][] = [];
  constructor(
    readonly names: readonly string[],
    readonly details: readonly string[],
  ) {}

  uploadFile(): Promise<void> {
    return Promise.resolve();
  }

  run(argv: readonly string[]): Promise<CommandResult> {
    this.calls.push([...argv]);
    if (argv[0] === "stat") return Promise.resolve(commandResult(0, "regular file\n"));
    if (argv[0] === "tar" && argv.includes("--verbose")) {
      return Promise.resolve(commandResult(0, `${this.details.join("\n")}\n`));
    }
    if (argv[0] === "tar" && argv.includes("--list")) {
      return Promise.resolve(commandResult(0, `${this.names.join("\n")}\n`));
    }
    return Promise.resolve(commandResult(0));
  }
}

Deno.test("integration/remote-deployment: 恶意内层 tar 在任何 extract/脚本之前 fail closed", async () => {
  const cases = [
    { name: "absolute", names: ["/escape"], details: ["-rw------- 0/0 1 DATE TIME /escape"] },
    { name: "parent", names: ["../escape"], details: ["-rw------- 0/0 1 DATE TIME ../escape"] },
    { name: "symlink", names: ["link"], details: ["lrwxrwxrwx 0/0 0 DATE TIME link"] },
    { name: "device", names: ["dev"], details: ["crw------- 0/0 0 DATE TIME dev"] },
    {
      name: "duplicate",
      names: ["dup", "dup"],
      details: ["-rw------- 0/0 1 DATE TIME dup", "-rw------- 0/0 1 DATE TIME dup"],
    },
    {
      name: "member-limit",
      names: ["one", "two"],
      details: ["-rw------- 0/0 1 DATE TIME one", "-rw------- 0/0 1 DATE TIME two"],
      maxMembers: 1,
    },
    {
      name: "expanded-limit",
      names: ["large"],
      details: ["-rw------- 0/0 10 DATE TIME large"],
      maxExpandedBytes: 5,
    },
  ] as const;
  for (const testCase of cases) {
    const channel = new InnerArchiveChannel(testCase.names, testCase.details);
    await assertRejects(
      () =>
        extractValidatedAppPackage(channel, {
          workspace: "/tmp/sfo-deploy-inner",
          packagePath: "/tmp/sfo-deploy-inner/package/app.tar.gz",
          maxMembers: "maxMembers" in testCase ? testCase.maxMembers : undefined,
          maxExpandedBytes: "maxExpandedBytes" in testCase ? testCase.maxExpandedBytes : undefined,
        }),
      TransportError,
    );
    assert(
      !channel.calls.some((argv) => argv[0] === "tar" && argv.includes("--extract")),
      `${testCase.name} must not be unpacked`,
    );
  }
});
