import { assert, assertEquals, assertStringIncludes, BufferWriter } from "../_support/assert.ts";
import { createCli } from "../../src/cli.ts";
import { RunOptions, ValidationResult } from "../../src/mod.ts";

function prepareCli(captured: RunOptions[]): {
  cli: (args: readonly string[]) => Promise<number>;
  stderr: BufferWriter;
} {
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
      return new ValidationResult({
        cluster: resolved.cluster,
        directory: resolved.clusterDirectory,
        machines: [],
        environments: [],
        apps: [],
      });
    },
  });
  return { cli, stderr };
}

Deno.test("unit/cli: prepare accepts repeatable --env short filter", async () => {
  const captured: RunOptions[] = [];
  const { cli } = prepareCli(captured);
  assertEquals(
    await cli(["prepare", "--cluster", "demo", "--env", "jre", "--env", "nginx"]),
    0,
  );
  assertEquals(captured.length, 1);
  assertEquals(captured[0].action, "prepare");
  assertEquals(captured[0].environments, ["jre", "nginx"]);
});

Deno.test("unit/cli: --env and --environment are equivalent", async () => {
  const shortCaptured: RunOptions[] = [];
  const shortCli = prepareCli(shortCaptured);
  await shortCli.cli(["prepare", "--cluster", "demo", "--env", "jre"]);

  const longCaptured: RunOptions[] = [];
  const longCli = prepareCli(longCaptured);
  await longCli.cli(["prepare", "--cluster", "demo", "--environment", "jre"]);

  assertEquals(shortCaptured[0].environments, ["jre"]);
  assertEquals(longCaptured[0].environments, ["jre"]);
});

Deno.test("unit/cli: prepare rejects --app and requires user config context", async () => {
  const captured: RunOptions[] = [];
  const { cli, stderr } = prepareCli(captured);
  const code = await cli(["prepare", "--cluster", "demo", "--app", "demo"]);
  assertEquals(code, 2);
  assertStringIncludes(stderr.text(), "不能与 --app 同时使用");
  assertEquals(captured.length, 0);
});

Deno.test("unit/cli: prepare help documents environment-app semantics", async () => {
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
  assertEquals(await cli(["prepare", "--help"]), 0);
  const text = stdout.text();
  assertStringIncludes(text, "--env");
  assertStringIncludes(text, "首次安装成功");
  assertStringIncludes(text, "更新成功");
  assert(stderr.text().length === 0);
});
