import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
  BufferWriter,
} from "../_support/assert.ts";
import { createCli, serializeResult } from "../../src/cli.ts";
import { ConfigurationError } from "../../src/errors.ts";
import {
  InstallDenoResult,
  type MachineDenoOutcome,
  RunOptions,
  ValidationResult,
} from "../../src/mod.ts";

function captureCli(): {
  cli: (args: readonly string[]) => Promise<number>;
  captured: RunOptions[];
} {
  const captured: RunOptions[] = [];
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout,
    stderr,
    runAction: async (options) => {
      await Promise.resolve();
      const resolved = options instanceof RunOptions ? options : new RunOptions(options);
      captured.push(resolved);
      return resolved.action === "install-deno"
        ? new InstallDenoResult({ cluster: resolved.cluster, machines: [] })
        : new ValidationResult({
          cluster: resolved.cluster,
          directory: resolved.clusterDirectory,
          machines: [],
          environments: [],
          apps: [],
        });
    },
  });
  return { cli, captured };
}

Deno.test("unit/cli: install-deno parses machine, version and install-to options", async () => {
  const { cli, captured } = captureCli();
  assertEquals(
    await cli([
      "install-deno",
      "--cluster",
      "demo",
      "--machine",
      "node-a",
      "--deno-version",
      "v2.2.11",
      "--install-to",
      "/usr/local",
    ]),
    0,
  );
  assertEquals(captured.length, 1);
  assertEquals(captured[0].action, "install-deno");
  assertEquals(captured[0].machines, ["node-a"]);
  assertEquals(captured[0].denoVersion, "v2.2.11");
  assertEquals(captured[0].installTo, "/usr/local");
});

Deno.test("unit/cli: install-deno rejects app/environment/with-dependencies filters", () => {
  const base = { configRoot: "/fixture", cluster: "demo", action: "install-deno" as const };
  assertThrows(
    () => new RunOptions({ ...base, apps: ["demo"] }),
    ConfigurationError,
    "supports only --machine",
  );
  assertThrows(
    () => new RunOptions({ ...base, environments: ["jre"] }),
    ConfigurationError,
    "supports only --machine",
  );
  assertThrows(
    () => new RunOptions({ ...base, withDependencies: true }),
    ConfigurationError,
    "supports only --machine",
  );
  assertThrows(
    () =>
      new RunOptions({
        configRoot: "/fixture",
        cluster: "demo",
        action: "validate",
        denoVersion: "2.2.11",
      }),
    ConfigurationError,
    "apply only to install-deno",
  );
});

Deno.test("unit/cli: install-deno help documents pure SSH semantics", async () => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout,
    stderr,
    runAction: async () => {
      await Promise.resolve();
      throw new Error("help must not invoke action");
    },
  });
  assertEquals(await cli(["install-deno", "--help"]), 0);
  const text = stdout.text();
  assertStringIncludes(text, "install-deno");
  assertStringIncludes(text, "--deno-version");
  assertStringIncludes(text, "--install-to");
  assertStringIncludes(text, "latest stable version");
  assertStringIncludes(text, "plain SSH");
  assert(stderr.text().length === 0);
});

Deno.test("unit/cli: serializeResult emits stable install-deno JSON", () => {
  const outcome: MachineDenoOutcome = Object.freeze({
    machine: "node-a",
    status: "installed",
    denoPath: "/home/deploy/.deno/bin/deno",
    version: "2.2.11",
    cleanupErrors: Object.freeze([]),
  });
  const result = new InstallDenoResult({
    cluster: "demo",
    machines: [outcome],
  });
  const json = serializeResult(result) as Record<string, unknown>;
  assertEquals(json.kind, "install-deno");
  assertEquals(json.status, "succeeded");
  assertEquals(json.exit_code, 0);
  assertEquals(json.cluster, "demo");
});

Deno.test("unit/cli: InstallDenoResult maps preflight failures to exit 3", () => {
  const preflight: MachineDenoOutcome = Object.freeze({
    machine: "node-a",
    status: "failed",
    denoPath: "/usr/local/bin/deno",
    errorCategory: "preflight",
    message: "known_hosts unavailable",
    cleanupErrors: Object.freeze([]),
  });
  const transportFailure: MachineDenoOutcome = Object.freeze({
    machine: "node-a",
    status: "failed",
    denoPath: "/usr/local/bin/deno",
    errorCategory: "transport",
    message: "SSH connection failed",
    cleanupErrors: Object.freeze([]),
  });
  assertEquals(new InstallDenoResult({ cluster: "demo", machines: [preflight] }).exitCode, 3);
  assertEquals(
    new InstallDenoResult({ cluster: "demo", machines: [transportFailure] }).exitCode,
    4,
  );
});
