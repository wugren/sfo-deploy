import { assert, assertEquals, assertStringIncludes, BufferWriter } from "../_support/assert.ts";
import { plan, resolved } from "../_support/fixtures.ts";
import { createCli } from "../../src/cli.ts";
import type { ExecutionPlan, PlanStep, ScriptInvocation } from "../../src/types.ts";

const script: ScriptInvocation = Object.freeze({
  source: "/fixture/action.ts",
  relativePath: "scripts/action.ts",
  permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
});

function cliWithPlan(result: ExecutionPlan): {
  cli: (args: readonly string[]) => Promise<number>;
  stdout: BufferWriter;
} {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout,
    stderr,
    runAction: () => Promise.resolve(result),
  });
  return { cli, stdout };
}

function fullStep(): PlanStep {
  return {
    id: "app:node-a/demo:stage",
    machine: resolved("node-a", "10.0.0.1"),
    kind: "app",
    resource: "demo",
    action: "stage",
    scripts: Object.freeze([script]),
    parameters: Object.freeze({}),
    package: Object.freeze({
      provider: "filehub",
      source: Object.freeze({}),
      hashAlgorithm: "sha256",
      hashValue: "00".repeat(32),
    }),
    secretValues: Object.freeze(["DB_PASSWORD", "TOKEN_SECRET"]),
    secretFiles: Object.freeze(["app-key.pem"]),
    templates: Object.freeze([]),
    dependsOn: Object.freeze(["env:node-a/base:check"]),
    deployment: Object.freeze({ kind: "versioned" }),
    management: Object.freeze({
      runAs: "deploy",
      manager: Object.freeze({
        kind: "service",
        unit: "demo.service",
        tool: "systemctl",
        enabled: true,
        daemonReload: true,
        onDeploy: "restart",
        timeoutMs: 30000,
      }),
      configs: Object.freeze([
        Object.freeze({
          name: "file-0",
          relativePath: "templates/application.json",
          source: "templates/application.json",
          target: "/etc/demo/application.json",
          targetRoot: "absolute",
          mode: 0o600,
          variables: Object.freeze([]),
          format: "json",
          secretReferences: Object.freeze(
            new Map([
              ["DB_PASSWORD", Object.freeze({ kind: "value", valueType: "string" })],
            ]),
          ),
          onChange: "restart",
        }),
      ]),
      configScripts: Object.freeze([]),
    }),
  };
}

Deno.test("unit/cli plan: human output renders detailed step fields", async () => {
  const { cli, stdout } = cliWithPlan({
    schemaVersion: 4,
    cluster: "demo",
    requestedAction: "deploy",
    steps: Object.freeze([
      fullStep(),
      Object.freeze({
        ...fullStep(),
        id: "app:node-a/demo:activate",
        action: "activate",
        dependsOn: Object.freeze(["app:node-a/demo:stage"]),
        package: undefined,
      }),
    ]),
  });
  assertEquals(await cli(["plan", "--cluster", "demo"]), 0);
  const text = stdout.text();
  assertStringIncludes(text, "Plan: cluster demo | action deploy | 2 steps");
  assertStringIncludes(text, "- [1/2] node-a (10.0.0.1/private) app:demo stage");
  assertStringIncludes(text, "- [2/2] node-a (10.0.0.1/private) app:demo activate");
  assertStringIncludes(text, "depends_on: env:node-a/base:check");
  assertStringIncludes(text, "package: filehub");
  assertStringIncludes(text, "deployment: versioned");
  assertStringIncludes(text, "runtime: deno");
  assertStringIncludes(text, "scripts: scripts/action.ts");
  assertStringIncludes(text, "secrets: DB_PASSWORD, TOKEN_SECRET, app-key.pem");
  assertStringIncludes(text, "service: demo.service (enabled, on restart)");
  assertStringIncludes(text, "configs: /etc/demo/application.json (json)");
});

Deno.test("unit/cli plan: human output omits absent optional fields", async () => {
  const minimal: PlanStep = {
    id: "app:node-a/demo:deploy",
    machine: resolved("node-a"),
    kind: "app",
    resource: "demo",
    action: "deploy",
    scripts: Object.freeze([script]),
    parameters: Object.freeze({}),
    secretValues: Object.freeze([]),
    secretFiles: Object.freeze([]),
    templates: Object.freeze([]),
    dependsOn: Object.freeze([]),
  };
  const { cli, stdout } = cliWithPlan({
    schemaVersion: 4,
    cluster: "demo",
    requestedAction: "deploy",
    steps: Object.freeze([minimal]),
  });
  assertEquals(await cli(["plan", "--cluster", "demo"]), 0);
  const text = stdout.text();
  assertStringIncludes(text, "- [1/1] node-a (10.0.0.1/private) app:demo deploy");
  assertStringIncludes(text, "runtime: deno");
  assertStringIncludes(text, "scripts: scripts/action.ts");
  for (
    const absent of ["depends_on:", "package:", "deployment:", "secrets:", "service:", "configs:"]
  ) {
    assert(!text.includes(absent), `plan output must not include absent field ${absent}`);
  }
});

Deno.test("unit/cli plan: --json keeps the stable plan contract", async () => {
  const { cli, stdout } = cliWithPlan(plan());
  assertEquals(await cli(["plan", "--cluster", "demo", "--json"]), 0);
  const json = JSON.parse(stdout.text()) as Record<string, unknown>;
  assertEquals(json.kind, "plan");
  assertEquals(json.cluster, "demo");
  assertEquals(json.requested_action, "deploy");
  const steps = json.steps as Array<Record<string, unknown>>;
  assertEquals(steps.length, 2);
  for (
    const expected of [
      "id",
      "machine",
      "address",
      "addresses",
      "address_kind",
      "resource_kind",
      "resource",
      "action",
      "script_runtime",
      "scripts",
      "secret_values",
      "secret_files",
      "depends_on",
    ]
  ) {
    assert(expected in steps[0], `plan step JSON must keep key ${expected}`);
  }
});
