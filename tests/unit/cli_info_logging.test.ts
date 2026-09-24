import { assert, assertEquals, assertStringIncludes, BufferWriter } from "../_support/assert.ts";
import { createCli } from "../../src/cli.ts";
import type { RunDependencies, RunResult } from "../../src/integration.ts";
import { ValidationResult } from "../../src/integration.ts";

function result(): RunResult {
  return new ValidationResult({
    cluster: "demo",
    directory: "/fixture/demo",
    machines: [],
    environments: [],
    apps: [],
  });
}

function cliFixture() {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout,
    stderr,
    runAction: (_options, dependencies?: RunDependencies) => {
      dependencies?.onInfo?.("command started", { action: "validate" });
      return Promise.resolve(result());
    },
  });
  return { fixture: cli, stdout, stderr };
}

Deno.test("unit/cli: non-json info logs use stdout and a single-line format", async () => {
  const { fixture, stdout, stderr } = cliFixture();
  const cli = fixture;
  assertEquals(await cli(["validate", "--cluster", "demo"]), 0);
  assertStringIncludes(stdout.text(), `[info] command started action="validate"`);
  assertEquals(stderr.text(), "");
});

Deno.test("unit/cli: JSON mode remains quiet and stdout stays valid JSON", async () => {
  const { fixture, stdout, stderr } = cliFixture();
  const cli = fixture;
  assertEquals(await cli(["validate", "--cluster", "demo", "--json"]), 0);
  const json = JSON.parse(stdout.text()) as Record<string, unknown>;
  assertEquals(json.kind, "validation");
  assert(!stdout.text().includes("[info]"), "JSON stdout must not contain info logs");
  assertEquals(stderr.text(), "");
});

Deno.test("unit/cli: documentation describes the info logging boundary", async () => {
  const [readme, moduleDocs] = await Promise.all([
    Deno.readTextFile("README.md"),
    Deno.readTextFile("docs/modules/sfo-deploy.md"),
  ]);
  assertStringIncludes(readme, "`[info]` 过程日志");
  assertStringIncludes(readme, "stdout 不输出过程日志");
  assertStringIncludes(moduleDocs, "RunDependencies.onInfo");
  assertStringIncludes(moduleDocs, "不记录 secret 值");
});
