import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
  BufferWriter,
} from "../_support/assert.ts";
import { createCli } from "../../src/cli.ts";
import { DeploymentError } from "../../src/errors.ts";
import type { RunDependencies } from "../../src/integration.ts";
import type { RunResult } from "../../src/integration.ts";
import { DeploymentResult, InstallDenoResult, StepResult, StepStatus } from "../../src/results.ts";

function step(
  action: string,
  status: StepStatus,
  options: { readonly message?: string; readonly skipReason?: string } = {},
): StepResult {
  return new StepResult({
    stepId: `env:eleph-server/jre:${action}`,
    machine: "eleph-server",
    kind: "environment",
    resource: "jre",
    action,
    status,
    message: options.message,
    skipReason: options.skipReason,
  });
}

function cliWith(callback: (dependencies: RunDependencies) => RunResult): {
  cli: (args: readonly string[]) => Promise<number>;
  stdout: BufferWriter;
  stderr: BufferWriter;
} {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout,
    stderr,
    runAction: (_options, dependencies) => Promise.resolve(callback(dependencies ?? {})),
  });
  return { cli, stdout, stderr };
}

const prepareResult = () =>
  new DeploymentResult({
    cluster: "multipass",
    requestedAction: "prepare",
    steps: [
      step("check", StepStatus.SUCCEEDED, { message: "环境检查已满足" }),
      step("install", StepStatus.SKIPPED, { skipReason: "up-to-date" }),
      step("configure", StepStatus.SKIPPED, { skipReason: "up-to-date" }),
    ],
  });

Deno.test("unit/cli: default output is human readable step-by-step without JSON", async () => {
  const { cli, stdout, stderr } = cliWith((dependencies) => {
    const total = 3;
    prepareResult().steps.forEach((stepResult, index) => {
      dependencies.onProgress?.({
        kind: "step-result",
        index,
        total,
        step: stepResult,
      });
    });
    return prepareResult();
  });
  assertEquals(await cli(["prepare", "--cluster", "multipass", "--env", "jre"]), 0);
  const text = stdout.text();
  assertStringIncludes(text, "[eleph-server] jre 检查（1/3）... 通过（环境检查已满足）");
  assertStringIncludes(text, "[eleph-server] jre 安装（2/3）... 跳过（已是最新）");
  assertStringIncludes(text, "状态：成功");
  assertStringIncludes(text, "目标：eleph-server");
  assert(!text.trimStart().startsWith("{"), "human output must not be a JSON document");
  assert(stderr.text().length === 0);
});

Deno.test("unit/cli: --json keeps stable structured result on stdout", async () => {
  const { cli, stdout } = cliWith(() => prepareResult());
  assertEquals(
    await cli(["prepare", "--cluster", "multipass", "--env", "jre", "--json"]),
    0,
  );
  const json = JSON.parse(stdout.text()) as Record<string, unknown>;
  assertEquals(json.kind, "result");
  assertEquals(json.requested_action, "prepare");
  assertEquals((json.targets as unknown[]).length, 1);
  const steps = (json.targets as Array<{ steps: unknown[] }>)[0].steps;
  assertEquals(steps.length, 3);
  assertStringIncludes(stdout.text(), '"kind":"result"');
});

Deno.test("unit/cli: errors are human readable by default and JSON with --json", async () => {
  const { cli, stderr } = cliWith(() => {
    throw new DeploymentError("远端执行失败：连接超时");
  });
  assertEquals(await cli(["prepare", "--cluster", "multipass"]), 4);
  const text = stderr.text();
  assertStringIncludes(text, "错误（execution）: 远端执行失败：连接超时");

  const jsonCli = cliWith((): RunResult => {
    throw new DeploymentError("远端执行失败：连接超时");
  });
  assertEquals(
    await jsonCli.cli(["prepare", "--cluster", "multipass", "--json"]),
    4,
  );
  const json = JSON.parse(jsonCli.stderr.text()) as {
    error: { category: string; message: string };
  };
  assertEquals(json.error.category, "execution");
  assertEquals(json.error.message, "远端执行失败：连接超时");
});

Deno.test("unit/cli: install-deno and fetch progress lines are rendered", async () => {
  const { cli, stdout } = cliWith((dependencies) => {
    dependencies.onProgress?.({
      kind: "machine-result",
      index: 0,
      total: 1,
      machine: {
        machine: "node-a",
        status: "installed",
        denoPath: "/usr/local/bin/deno",
        version: "2.2.11",
        cleanupErrors: [],
      },
    });
    return new InstallDenoResult({
      cluster: "demo",
      machines: [{
        machine: "node-a",
        status: "installed",
        denoPath: "/usr/local/bin/deno",
        version: "2.2.11",
        cleanupErrors: [],
      }],
    });
  });
  assertEquals(await cli(["install-deno", "--cluster", "demo", "--machine", "node-a"]), 0);
  const text = stdout.text();
  assertStringIncludes(text, "[node-a] install-deno ... 已安装（/usr/local/bin/deno 2.2.11）");
  assertStringIncludes(text, "install-deno 完成：集群 demo");
});

Deno.test("unit/cli: help documents --json and argument parse accepts it", async () => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const cli = createCli({
    configRoot: "/fixture",
    stdout,
    stderr,
    runAction: () => {
      throw new Error("help must not invoke action");
    },
  });
  assertEquals(await cli(["prepare", "--help"]), 0);
  assertStringIncludes(stdout.text(), "--json");
  assertMatch(stdout.text(), /人类可读/);
});

Deno.test("unit/cli: --json rejects inline values", async () => {
  const { cli, stderr } = cliWith(() => prepareResult());
  assertEquals(await cli(["prepare", "--cluster", "multipass", "--json=1"]), 2);
  assertStringIncludes(stderr.text(), "--json 不接受值");
});

Deno.test("unit/cli: README documents default human output and --json contract", async () => {
  const readme = await Deno.readTextFile(new URL("../../README.md", import.meta.url));
  assertStringIncludes(readme, "按步骤输出中文人可读的进度行");
  assertStringIncludes(readme, "--json");
  assertStringIncludes(readme, "稳定 JSON 契约");
});
