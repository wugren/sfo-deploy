import { dirname, join } from "jsr:@std/path@1.1.6";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
  BufferWriter,
  withTempDir,
} from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";
import { createCli } from "../../src/cli.ts";
import { CancelledError, ConfigurationError, TransportError } from "../../src/errors.ts";
import { RunOptions, ValidationResult } from "../../src/integration.ts";
import { ProjectBindings } from "../../src/secrets.ts";
import {
  OpenSshTransport,
  quotePosix,
  type SpawnedCommand,
  validateArgv,
} from "../../src/transport.ts";
import { PreflightError } from "../../src/errors.ts";

function output(code = 0, stdout = "", stderr = ""): Deno.CommandOutput {
  return {
    success: code === 0,
    code,
    signal: null,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
  };
}

Deno.test("unit/transport: OpenSSH uses strict argv and known_hosts", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "example ssh-ed25519 AAAA\n");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const factory = (command: string, args: readonly string[]): SpawnedCommand => {
      calls.push({ command, args: [...args] });
      return { output: () => Promise.resolve(output()), kill: () => undefined };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const session = await transport.connect(resolved("node-a"));
    assertEquals(calls[0].command, "ssh");
    assert(calls[0].args.includes("StrictHostKeyChecking=yes"));
    assert(calls[0].args.includes(`UserKnownHostsFile=${knownHosts}`));
    assert(calls[0].args.includes("ControlMaster=auto"));
    const controlOption = calls[0].args.find((arg) => arg.startsWith("ControlPath="));
    assert(controlOption);
    assert(calls[1].args.includes(controlOption));
    assert(calls[1].args.includes("check"));
    assertEquals(calls[0].args.at(-2), "deploy@10.0.0.1");
    assertEquals(calls[0].args.at(-1), "exec 'true'");
    await session.close();
  });
});

Deno.test("unit/transport: uploadFile defaults remote files to mode 0600", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    const local = join(root, "context.json");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    await Deno.writeTextFile(local, "{}\n");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const factory = (command: string, args: readonly string[]): SpawnedCommand => {
      calls.push({ command, args: [...args] });
      return { output: () => Promise.resolve(output()), kill: () => undefined };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const session = await transport.connect(resolved("node-a"));
    await session.uploadFile(local, "/tmp/context.json");
    assertEquals(calls[2].command, "scp");
    assert((calls[2].args.at(-1) ?? "").endsWith(":/tmp/context.json"));
    assertEquals(calls[3].command, "ssh");
    assertStringIncludes(calls[3].args.at(-1) ?? "", "'chmod' '0600' '--' '/tmp/context.json'");
    const controlOption = calls[0].args.find((arg) => arg.startsWith("ControlPath="));
    assert(controlOption);
    assert(calls.slice(1).every((call) => call.args.includes(controlOption)));
    await session.close();
  });
});

Deno.test("unit/transport: sessions isolate and close their SSH control connections", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const factory = (command: string, args: readonly string[]): SpawnedCommand => {
      calls.push({ command, args: [...args] });
      const controlPath = args.find((arg) => arg.startsWith("ControlPath="))?.slice(12);
      if (args.at(-1) === "exec 'true'" && controlPath) {
        Deno.writeTextFileSync(controlPath, "mock control socket");
      }
      return { output: () => Promise.resolve(output()), kill: () => undefined };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const first = await transport.connect(resolved("node-a"));
    const second = await transport.connect(resolved("node-a"));
    const paths = calls.filter((call) => call.args.at(-1) === "exec 'true'").map((call) =>
      call.args.find((arg) => arg.startsWith("ControlPath="))!.slice(12)
    );
    assertEquals(paths.length, 2);
    assert(paths[0] !== paths[1]);
    assertEquals((await Deno.stat(dirname(paths[0]))).mode! & 0o777, 0o700);
    await first.run(["echo", "first"]);
    assert(calls.at(-1)!.args.includes(`ControlPath=${paths[0]}`));
    await first.close();
    assert(calls.at(-1)!.args.includes("exit"));
    await assertRejects(() => Deno.stat(dirname(paths[0])), Deno.errors.NotFound);
    await second.run(["echo", "second"]);
    assert(calls.at(-1)!.args.includes(`ControlPath=${paths[1]}`));
    await second.close();
    await assertRejects(() => Deno.stat(dirname(paths[1])), Deno.errors.NotFound);
  });
});

Deno.test("unit/transport: failed multiplex check closes the initial connection", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let controlPath = "";
    let exitCalled = false;
    const factory = (_command: string, args: readonly string[]): SpawnedCommand => {
      if (args.at(-1) === "exec 'true'") {
        controlPath = args.find((arg) => arg.startsWith("ControlPath="))!.slice(12);
        Deno.writeTextFileSync(controlPath, "mock control socket");
      }
      if (args.includes("exit")) exitCalled = true;
      return {
        output: () => Promise.resolve(output(args.includes("check") ? 255 : 0)),
        kill: () => undefined,
      };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    await assertRejects(() => transport.connect(resolved("node-a")), TransportError);
    assert(exitCalled);
    await assertRejects(() => Deno.stat(dirname(controlPath)), Deno.errors.NotFound);
  });
});

Deno.test("unit/transport: stale SSH control socket is removed on close", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let controlPath = "";
    let closing = false;
    const factory = (_command: string, args: readonly string[]): SpawnedCommand => {
      if (args.at(-1) === "exec 'true'") {
        controlPath = args.find((arg) => arg.startsWith("ControlPath="))!.slice(12);
        Deno.writeTextFileSync(controlPath, "stale control socket");
      }
      if (args.includes("exit")) closing = true;
      const code = closing && (args.includes("exit") || args.includes("check")) ? 255 : 0;
      return { output: () => Promise.resolve(output(code)), kill: () => undefined };
    };
    const session = await new OpenSshTransport({ knownHosts, commandFactory: factory }).connect(
      resolved("node-a"),
    );
    await session.close();
    await assertRejects(() => Deno.stat(dirname(controlPath)), Deno.errors.NotFound);
  });
});

Deno.test("unit/transport: readEnvironmentVersion reads or reports missing marker", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const remoteCalls: string[] = [];
    const factory = (_command: string, args: readonly string[]): SpawnedCommand => {
      const rendered = String(args.at(-1) ?? "");
      remoteCalls.push(rendered);
      if (rendered.includes("/usr/bin/sh") && rendered.includes("$HOME")) {
        return {
          output: () => Promise.resolve(output(0, "/home/deploy\n")),
          kill: () => undefined,
        };
      }
      if (rendered.includes("/usr/bin/test")) {
        return {
          output: () => Promise.resolve(output()),
          kill: () => undefined,
        };
      }
      if (rendered.includes("/usr/bin/cat")) {
        return { output: () => Promise.resolve(output(0, "1.2.3\n")), kill: () => undefined };
      }
      return { output: () => Promise.resolve(output()), kill: () => undefined };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const session = await transport.connect(resolved("node-a"));
    assertEquals(await session.readEnvironmentVersion("base"), "1.2.3");
    assert(remoteCalls.some((call) => call.includes("/usr/bin/sh") && call.includes("$HOME")));
    assert(remoteCalls.some((call) => call.includes("/usr/bin/test")));
    assert(remoteCalls.some((call) => call.includes("/usr/bin/cat")));
    await session.close();
  });
});

Deno.test("unit/transport: readEnvironmentVersion returns undefined when marker missing", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const factory = (_command: string, args: readonly string[]): SpawnedCommand => {
      const rendered = String(args.at(-1) ?? "");
      if (rendered.includes("/usr/bin/sh") && rendered.includes("$HOME")) {
        return {
          output: () => Promise.resolve(output(0, "/home/deploy\n")),
          kill: () => undefined,
        };
      }
      if (rendered.includes("/usr/bin/test")) {
        return { output: () => Promise.resolve(output(1)), kill: () => undefined };
      }
      return { output: () => Promise.resolve(output()), kill: () => undefined };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const session = await transport.connect(resolved("node-a"));
    assertEquals(await session.readEnvironmentVersion("base"), undefined);
    await session.close();
  });
});

Deno.test("unit/transport: writeEnvironmentVersion creates directory and uploads marker", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const calls: Array<{ command: string; rendered: string }> = [];
    const factory = (command: string, args: readonly string[]): SpawnedCommand => {
      const rendered = String(args.at(-1) ?? "");
      calls.push({ command, rendered });
      if (rendered.includes("/usr/bin/sh") && rendered.includes("$HOME")) {
        return {
          output: () => Promise.resolve(output(0, "/home/deploy\n")),
          kill: () => undefined,
        };
      }
      return { output: () => Promise.resolve(output()), kill: () => undefined };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const session = await transport.connect(resolved("node-a"));
    await session.writeEnvironmentVersion("base", "2.0.0");
    assert(calls.some((call) => call.rendered.includes("'mkdir'")));
    assert(calls.some((call) => call.command === "scp" && call.rendered.includes("base.version")));
    assert(calls.some((call) => call.command === "ssh" && call.rendered.includes("chmod")));
    await session.close();
  });
});

Deno.test("unit/transport: unsafe argv, identities and shell data are rejected or quoted", () => {
  assertEquals(quotePosix("a'b"), "'a'\\''b'");
  assertThrows(() => validateArgv([]), TransportError);
  assertThrows(() => validateArgv(["echo", "bad\0value"]), TransportError);
  assertThrows(() => new OpenSshTransport({ sshExecutable: "ssh;touch-pwned" }));
});

Deno.test("unit/transport: cancellation terminates and reaps local OpenSSH process", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let killed = false;
    let resolveOutput!: (value: Deno.CommandOutput) => void;
    const pending = new Promise<Deno.CommandOutput>((resolve) => resolveOutput = resolve);
    const controller = new AbortController();
    const factory = (): SpawnedCommand => {
      queueMicrotask(() => controller.abort("test"));
      return {
        output: () => pending,
        kill: () => {
          killed = true;
          resolveOutput(output(143));
        },
      };
    };
    const transport = new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 50,
    });
    const connecting = transport.connect(resolved("node-a"), controller.signal);
    await assertRejects(() => connecting);
    assert(killed);
  });
});

Deno.test("unit/transport: synchronous factory abort cannot return success and awaits reap", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const controller = new AbortController();
    let killed = false;
    let reaped = false;
    let factoryCalls = 0;
    let resolveOutput!: (value: Deno.CommandOutput) => void;
    const pending = new Promise<Deno.CommandOutput>((resolve) => resolveOutput = resolve);
    const observed = pending.then((value) => {
      reaped = true;
      return value;
    });
    const factory = (): SpawnedCommand => {
      factoryCalls++;
      controller.abort("synchronous command factory cancellation");
      return {
        output: () => observed,
        kill: () => {
          killed = true;
          resolveOutput(output(143));
        },
      };
    };
    const transport = new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      terminateTimeoutMs: 50,
    });
    await assertRejects(
      () => transport.connect(resolved("node-a"), controller.signal),
      CancelledError,
      "cancelled",
    );
    assertEquals(factoryCalls, 1);
    assert(killed);
    assert(reaped);
  });
});

Deno.test("unit/transport: command timeout terminates and reaps local OpenSSH process", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    let killed = false;
    let resolveOutput!: (value: Deno.CommandOutput) => void;
    const pending = new Promise<Deno.CommandOutput>((resolve) => resolveOutput = resolve);
    const factory = (): SpawnedCommand => ({
      output: () => pending,
      kill: () => {
        killed = true;
        resolveOutput(output(143));
      },
    });
    const transport = new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      connectTimeoutMs: 5,
      terminateTimeoutMs: 50,
    });
    await assertRejects(
      () => transport.connect(resolved("node-a")),
      TransportError,
      "timed out",
    );
    assert(killed);
  });
});

Deno.test("unit/transport: remote /usr/bin/test argv does not use --", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "example ssh-ed25519 AAAA\n");
    const remoteTestCalls: string[] = [];
    const factory = (_command: string, args: readonly string[]): SpawnedCommand => {
      const rendered = String(args.at(-1) ?? "");
      if (rendered.includes("'/usr/bin/sh'")) {
        return {
          output: () => Promise.resolve(output(0, "/home/deploy")),
          kill: () => undefined,
        };
      }
      if (rendered.includes("'/usr/bin/test'")) {
        remoteTestCalls.push(rendered);
        return { output: () => Promise.resolve(output(1)), kill: () => undefined };
      }
      return { output: () => Promise.resolve(output()), kill: () => undefined };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const session = await transport.connect(resolved("node-a"));

    const missing = await session.checkSecrets("~/.sfo-deploy/secrets/");
    assertEquals(missing.dirMode, "missing");
    await assertRejects(
      () => session.removeSecret("ELEPH_DB_PASSWORD", "~/.sfo-deploy/secrets/"),
      PreflightError,
      "is not deployed",
    );
    const workspace = await session.createWorkspace();
    await assertRejects(
      () => session.exposeStepSecrets(["ELEPH_DB_PASSWORD"], "~/.sfo-deploy/secrets/", workspace),
      PreflightError,
      "is not deployed",
    );
    await session.close();

    assert(
      remoteTestCalls.some((call) =>
        call.includes("'/usr/bin/test' '-d' '/home/deploy/.sfo-deploy/secrets'")
      ),
    );
    assert(
      remoteTestCalls.some((call) =>
        call.includes("'/usr/bin/test' '-f' '/home/deploy/.sfo-deploy/secrets/ELEPH_DB_PASSWORD'")
      ),
    );
    assert(remoteTestCalls.every((call) => !call.includes("'--'")));
  });
});

Deno.test("unit/transport: executeDeno merges workspace and configured file paths", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "fixture\n");
    const remoteCalls: string[] = [];
    const factory = (_command: string, args: readonly string[]): SpawnedCommand => {
      const rendered = String(args.at(-1) ?? "");
      remoteCalls.push(rendered);
      return { output: () => Promise.resolve(output()), kill: () => undefined };
    };
    const transport = new OpenSshTransport({ knownHosts, commandFactory: factory });
    const session = await transport.connect(resolved("node-a"));
    const workspace = await session.createWorkspace();
    await session.executeDeno("/usr/bin/deno", `${workspace}/action.ts`, {
      workspace,
      metadataPath: `${workspace}/metadata.json`,
      permissions: Object.freeze({
        run: Object.freeze([]),
        net: Object.freeze([]),
        read: Object.freeze(["/etc/demo/input.json"]),
        write: Object.freeze(["/srv/demo/state"]),
      }),
    });
    const execution = remoteCalls.find((call) => call.includes("'/usr/bin/deno' 'run'"))!;
    assertStringIncludes(execution, `--allow-read=${workspace},/etc/demo/input.json`);
    assertStringIncludes(execution, `--allow-write=${workspace},/srv/demo/state`);
    await session.close();
  });
});

Deno.test("unit/transport: successful remote commands are quiet and failures stay logged", async () => {
  await withTempDir(async (root) => {
    const knownHosts = join(root, "known_hosts");
    await Deno.writeTextFile(knownHosts, "example ssh-ed25519 AAAA\n");
    const events: string[] = [];
    const factory = (_command: string, args: readonly string[]): SpawnedCommand => {
      const rendered = String(args.at(-1) ?? "");
      if (rendered === "exec 'true'" || args.includes("check")) {
        return { output: () => Promise.resolve(output()), kill: () => undefined };
      }
      throw new Error("remote process failed");
    };
    const transport = new OpenSshTransport({
      knownHosts,
      commandFactory: factory,
      onInfo: (message) => {
        events.push(message);
      },
    });
    const session = await transport.connect(resolved("node-a"));
    const result = await session.run(["true"]);
    assertEquals(result.exitCode, 0);
    assert(!events.includes("remote command started"));
    assert(!events.includes("remote command completed"));

    await assertRejects(
      () => session.run(["false"]),
      TransportError,
      "Failed to start the remote command process",
    );
    assert(events.includes("remote command failed"));
    await session.close();
  });
});

Deno.test("unit/cli: help, argument errors, stable JSON and exit codes", async () => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout,
    stderr,
    runAction: (options) =>
      Promise.resolve(
        new ValidationResult({
          cluster: options.cluster,
          directory: new RunOptions(options).clusterDirectory,
          machines: ["node-a"],
          environments: ["node-a/base"],
          apps: ["demo"],
        }),
      ),
  });
  assertEquals(await cli(["--help"]), 0);
  assertStringIncludes(stdout.text(), "Usage: sfo-deploy");
  assertEquals(await cli(["validate"]), 2);
  assertStringIncludes(stderr.text(), "--cluster");

  const outputWriter = new BufferWriter();
  const success = createCli({
    configRoot: "/fixture",
    stdout: outputWriter,
    stderr: new BufferWriter(),
    runAction: (options) =>
      Promise.resolve(
        new ValidationResult({
          cluster: options.cluster,
          directory: new RunOptions(options).clusterDirectory,
          machines: ["node-a"],
          environments: [],
          apps: [],
        }),
      ),
  });
  assertEquals(await success(["validate", "--cluster", "demo", "--json"]), 0);
  assertEquals(JSON.parse(outputWriter.text()).cluster, "demo");
});

Deno.test("unit/cli: per-action help shows action-specific parameters", async () => {
  const global = new BufferWriter();
  const globalCli = createCli({
    configRoot: "/fixture",
    stdout: global,
    stderr: new BufferWriter(),
  });
  assertEquals(await globalCli(["--help"]), 0);
  assertStringIncludes(
    global.text(),
    "Run sfo-deploy <action> --help to see action-specific arguments.",
  );

  const history = new BufferWriter();
  const historyCli = createCli({
    configRoot: "/fixture",
    stdout: history,
    stderr: new BufferWriter(),
  });
  assertEquals(await historyCli(["history", "--help"]), 0);
  assertStringIncludes(
    history.text(),
    "Usage: sfo-deploy history --cluster NAME [--release-id ID]",
  );
  assertStringIncludes(
    history.text(),
    "View the given release record; when omitted, list all records",
  );
  assertStringIncludes(
    history.text(),
    "Cannot be combined with --machine/--app/--environment/--executor-region/--address-kind/--with-dependencies",
  );

  const rollback = new BufferWriter();
  const rollbackCli = createCli({
    configRoot: "/fixture",
    stdout: rollback,
    stderr: new BufferWriter(),
  });
  assertEquals(await rollbackCli(["--help", "rollback"]), 0);
  assertStringIncludes(
    rollback.text(),
    "Usage: sfo-deploy rollback --cluster NAME --release-id ID",
  );
  assertStringIncludes(rollback.text(), "Release ID to roll back to (required)");

  const check = new BufferWriter();
  const checkCli = createCli({
    configRoot: "/fixture",
    stdout: check,
    stderr: new BufferWriter(),
  });
  assertEquals(await checkCli(["check", "--help"]), 0);
  assertStringIncludes(check.text(), "Environment action; --app is not supported");
  assert(!check.text().includes("  --app NAME"));

  const deploy = new BufferWriter();
  const deployCli = createCli({
    configRoot: "/fixture",
    stdout: deploy,
    stderr: new BufferWriter(),
  });
  assertEquals(await deployCli(["deploy", "--help"]), 0);
  assertStringIncludes(deploy.text(), "--with-dependencies");
});

Deno.test("unit/cli: errors are categorized and configured secrets are redacted", async () => {
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout: new BufferWriter(),
    stderr,
    bindings: new ProjectBindings({ configSecrets: { TOKEN: "super-secret" } }),
    runAction: () => {
      throw new ConfigurationError("invalid super-secret");
    },
  });
  assertEquals(await cli(["validate", "--cluster", "demo", "--json"]), 2);
  const value = JSON.parse(stderr.text());
  assertEquals(value.error.category, "configuration");
  assertStringIncludes(value.error.message, "[REDACTED]");
  assert(!stderr.text().includes("super-secret"));
});
