import { join } from "jsr:@std/path@1.1.6";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
  BufferWriter,
  withTempDir,
} from "../_support/assert.ts";
import { plan, writeCluster } from "../_support/fixtures.ts";
import { FakeTransport } from "../_support/fake_session.ts";
import { createCli } from "../../src/cli.ts";
import { CancelledError, ConfigurationError } from "../../src/errors.ts";
import { run, RunOptions, ValidationResult } from "../../src/integration.ts";
import type { ExecutionPlan } from "../../src/types.ts";

class QueueReader {
  readonly values: Uint8Array[] = [];
  index = 0;

  constructor(values: readonly string[]) {
    this.values = values.map((value) => new TextEncoder().encode(value));
  }

  isTerminal(): boolean {
    return true;
  }

  read(data: Uint8Array): number | null {
    if (this.index >= this.values.length) return null;
    const chunk = this.values[this.index++];
    data.set(chunk.subarray(0, data.length));
    return chunk.length;
  }
}

function deployCliStub(reader: QueueReader): {
  cli: (args: readonly string[]) => Promise<number>;
  stderr: BufferWriter;
  confirmCalled: () => boolean;
  confirmed: () => boolean | undefined;
} {
  const stderr = new BufferWriter();
  let confirmCalled = false;
  let confirmed: boolean | undefined;
  const cli = createCli({
    configRoot: "/fixture",
    stdout: new BufferWriter(),
    stderr,
    stdin: reader,
    runAction: async (options, dependencies) => {
      if (options.action !== "deploy") throw new Error("unexpected action");
      if (dependencies !== undefined && dependencies.confirmPlan !== undefined) {
        confirmCalled = true;
        confirmed = await dependencies.confirmPlan(plan());
      }
      return new ValidationResult({
        cluster: options.cluster,
        directory: new RunOptions(options).clusterDirectory,
        machines: [],
        environments: [],
        apps: [],
      });
    },
  });
  return {
    cli,
    stderr,
    confirmCalled: () => confirmCalled,
    confirmed: () => confirmed,
  };
}

Deno.test("unit/deploy confirm: deploy prompts and rejects unless user types yes", async () => {
  const declined = deployCliStub(new QueueReader(["n\n"]));
  assertEquals(await declined.cli(["deploy", "--cluster", "demo"]), 0);
  assert(declined.confirmCalled());
  assertEquals(declined.confirmed(), false);
  assertStringIncludes(declined.stderr.text(), "Deployment will process 2 steps");
  assertStringIncludes(declined.stderr.text(), "Confirm deployment?");

  const accepted = deployCliStub(new QueueReader(["yes\n"]));
  assertEquals(await accepted.cli(["deploy", "--cluster", "demo"]), 0);
  assertEquals(accepted.confirmed(), true);
});

Deno.test("unit/deploy confirm: --yes skips the deploy confirmation", async () => {
  const stub = deployCliStub(new QueueReader([]));
  assertEquals(await stub.cli(["deploy", "--cluster", "demo", "--yes"]), 0);
  assert(!stub.confirmCalled());
  assertEquals(stub.confirmed(), undefined);
});

Deno.test("unit/deploy confirm: --no-activate prompts as stage-only deploy", async () => {
  const declined = deployCliStub(new QueueReader(["n\n"]));
  assertEquals(await declined.cli(["deploy", "--cluster", "demo", "--no-activate"]), 0);
  assert(declined.confirmCalled());
  assertStringIncludes(
    declined.stderr.text(),
    "activation is skipped: managed config and versions are published without switching latest or reloading/restarting",
  );
});

Deno.test("unit/deploy confirm: --no-activate rejects inline values and non-deploy actions", async () => {
  const inline = deployCliStub(new QueueReader([]));
  assertEquals(
    await inline.cli(["deploy", "--cluster", "demo", "--no-activate=true"]),
    2,
  );
  assertStringIncludes(inline.stderr.text(), "does not accept a value");

  await withTempDir(async (root) => {
    await writeCluster(root);
    assertThrows(
      () =>
        new RunOptions({
          configRoot: root,
          cluster: "demo",
          action: "history",
          activate: false,
        }),
      ConfigurationError,
      "--no-activate applies only to deploy and plan",
    );
  });
});

Deno.test("unit/deploy confirm: deploy rejects environment and dependency filters", async () => {
  const environment = deployCliStub(new QueueReader([]));
  assertEquals(
    await environment.cli(["deploy", "--cluster", "demo", "--environment", "jre"]),
    2,
  );
  assertStringIncludes(
    environment.stderr.text(),
    "deploy/plan handle only Apps; prepare environments first",
  );

  const dependencies = deployCliStub(new QueueReader([]));
  assertEquals(
    await dependencies.cli(["deploy", "--cluster", "demo", "--with-dependencies"]),
    2,
  );
  assertStringIncludes(
    dependencies.stderr.text(),
    "do not combine with --environment/--with-dependencies",
  );
});

Deno.test("unit/deploy confirm: unconfirmed deploy stays offline and leaves no release attempt", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeCluster(root);
    const transport = new FakeTransport();
    const options = new RunOptions({
      configRoot: root,
      cluster: "demo",
      action: "deploy",
    });
    await assertRejects(
      () =>
        run(options, {
          confirmPlan: (plan: ExecutionPlan) => {
            assertEquals(plan.requestedAction, "deploy");
            return false;
          },
          transport,
        }),
      CancelledError,
      "deployment was not confirmed",
    );
    assertEquals(transport.connectCalls, 0);
    await assertRejects(
      () => Deno.stat(join(cluster, ".sfo-deploy")),
      Deno.errors.NotFound,
    );
  });
});
