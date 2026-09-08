import { assert, assertEquals, assertStringIncludes, BufferWriter } from "../_support/assert.ts";
import { createCli } from "../../src/cli.ts";
import { CLI_ACTIONS, RunOptions } from "../../src/integration.ts";
import { InstallDenoResult, type MachineDenoOutcome } from "../../src/mod.ts";

Deno.test("integration/install-deno: public CLI action list includes install-deno", () => {
  assert((CLI_ACTIONS as readonly string[]).includes("install-deno"));
});

Deno.test("integration/install-deno: public module exports result type and action join", () => {
  const outcome: MachineDenoOutcome = Object.freeze({
    machine: "node-a",
    status: "present",
    denoPath: "/home/deploy/.deno/bin/deno",
    version: "2.2.11",
    cleanupErrors: Object.freeze([]),
  });
  const result = new InstallDenoResult({ cluster: "demo", machines: [outcome] });
  assertEquals(result.exitCode, 0);
  assertEquals(result.machines[0].status, "present");
});

Deno.test("integration/install-deno: CLI JSON output carries stable machine fields", async () => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout,
    stderr,
    runAction: async (options) => {
      await Promise.resolve();
      const resolved = options instanceof RunOptions ? options : new RunOptions(options);
      return new InstallDenoResult({
        cluster: resolved.cluster,
        machines: [{
          machine: "node-a",
          status: "installed",
          denoPath: "/usr/local/bin/deno",
          version: "2.2.11",
          cleanupErrors: [],
        }],
      });
    },
  });
  assertEquals(
    await cli(["install-deno", "--cluster", "demo", "--machine", "node-a", "--json"]),
    0,
  );
  const json = JSON.parse(stdout.text()) as Record<string, unknown>;
  assertEquals(json.kind, "install-deno");
  assertEquals(json.status, "succeeded");
  assertEquals(json.exit_code, 0);
  const machines = json.machines as Array<Record<string, unknown>>;
  assertEquals(machines[0].machine, "node-a");
  assertEquals(machines[0].status, "installed");
  assertEquals(machines[0].deno_path, "/usr/local/bin/deno");
  assertEquals(machines[0].version, "2.2.11");
  assertStringIncludes(stdout.text(), '"kind":"install-deno"');
});
