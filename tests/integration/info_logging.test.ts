import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { join } from "jsr:@std/path@1.1.6";
import { plan as makePlan } from "../_support/fixtures.ts";
import { FakeSession, FakeTransport } from "../_support/fake_session.ts";
import {
  type DeploymentResult,
  type ExecutionPlan,
  type InfoLogFields,
  type InstallDenoResult,
  prepareExecution,
  run,
  type SecretsDeployResult,
} from "../../src/mod.ts";
import type { InfoLogValue } from "../../src/logging.ts";
import { DeploymentExecutor } from "../../src/execution.ts";
import type { ValidationResult } from "../../src/integration.ts";

type LoggedEvent = { readonly message: string; readonly fields?: InfoLogFields };

function logger(events: LoggedEvent[]) {
  return (message: string, fields?: Record<string, InfoLogValue>) => {
    events.push({ message, fields });
  };
}

Deno.test("integration/info-logging: validate emits command orchestration info", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const events: LoggedEvent[] = [];
    const result = await run(
      { configRoot: root, cluster: "demo", action: "validate" },
      { onInfo: logger(events) },
    ) as ValidationResult;

    assertEquals(result.cluster, "demo");
    const messages = events.map((event) => event.message);
    assertStringIncludes(messages.join("\n"), "command started");
    assertStringIncludes(messages.join("\n"), "config directories verified");
    assertStringIncludes(messages.join("\n"), "execution dependencies initialized");
    assertStringIncludes(messages.join("\n"), "cluster configuration loaded");
    assertStringIncludes(messages.join("\n"), "configuration validation completed");
  });
});

Deno.test("integration/info-logging: plan emits terminal completion", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const events: LoggedEvent[] = [];
    const result = await run(
      { configRoot: root, cluster: "demo", action: "plan" },
      { onInfo: logger(events), transport: new FakeTransport() },
    ) as ExecutionPlan;

    assertEquals(result.requestedAction, "deploy");
    const messages = events.map((event) => event.message);
    assertStringIncludes(messages.join("\n"), "execution plan built");
    assertStringIncludes(messages.join("\n"), "plan completed");
  });
});

Deno.test("integration/info-logging: environment preparation emits terminal status", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const events: LoggedEvent[] = [];
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "prepare",
        environments: ["base"],
      },
      { onInfo: logger(events), transport: new FakeTransport() },
    ) as DeploymentResult;

    assertEquals(result.succeeded, true);
    const messages = events.map((event) => event.message);
    assertStringIncludes(messages.join("\n"), "local preparation started");
    assertStringIncludes(messages.join("\n"), "local preparation completed");
    assertStringIncludes(messages.join("\n"), "deployment execution completed");
  });
});

Deno.test("integration/info-logging: local preparation failure is logged", async () => {
  const events: LoggedEvent[] = [];
  await assertRejects(
    () => prepareExecution(makePlan(), { onInfo: logger(events) }),
    Error,
  );
  const messages = events.map((event) => event.message);
  assertStringIncludes(messages.join("\n"), "local preparation started");
  assertStringIncludes(messages.join("\n"), "local preparation failed");
  assert(!messages.includes("local preparation completed"));
});

class CloseFailingSession extends FakeSession {
  override close(): Promise<void> {
    return Promise.reject(new Error("close failed"));
  }
}

Deno.test("integration/info-logging: Deno close failure changes terminal phase", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const events: LoggedEvent[] = [];
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "install-deno",
        machines: ["node-a"],
      },
      {
        onInfo: logger(events),
        transport: new FakeTransport(() => new CloseFailingSession()),
      },
    ) as InstallDenoResult;

    assertEquals(result.succeeded, false);
    const messages = events.map((event) => event.message);
    assertStringIncludes(messages.join("\n"), "Deno session close failed");
    assertStringIncludes(messages.join("\n"), "Deno installation completed");
  });
});

Deno.test("integration/info-logging: disabled Deno installation emits a safe skip event", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeCluster(root);
    const path = join(cluster, "machines.yaml");
    await Deno.writeTextFile(
      path,
      (await Deno.readTextFile(path)).replace(
        "    deno: /usr/bin/deno\n",
        "    deno: /usr/bin/deno\n    enable_deno: false\n",
      ),
    );
    const events: LoggedEvent[] = [];
    const transport = new FakeTransport();
    const result = await run(
      { configRoot: root, cluster: "demo", action: "install-deno", machines: ["node-a"] },
      { onInfo: logger(events), transport },
    ) as InstallDenoResult;
    assertEquals(result.machines, []);
    assertEquals(transport.connectCalls, 0);
    assertEquals(events.find((event) => event.message === "Deno machine skipped")?.fields, {
      machine: "node-a",
      reason: "enable_deno: false",
    });
    assert(events.some((event) => event.message === "Deno installation completed"));

    const loggerFailure = await run(
      { configRoot: root, cluster: "demo", action: "install-deno", machines: ["node-a"] },
      {
        onInfo: () => {
          throw new Error("logger unavailable");
        },
        transport,
      },
    ) as InstallDenoResult;
    assertEquals(loggerFailure.exitCode, 0);
    assertEquals(transport.connectCalls, 0);
  });
});

async function secretCluster(root: string): Promise<string> {
  const directory = await writeCluster(root);
  const clusterPath = join(directory, "cluster.yaml");
  await Deno.writeTextFile(
    clusterPath,
    `${await Deno.readTextFile(
      clusterPath,
    )}secrets:\n  DB_PASSWORD:\n    kind: value\n    machines: [node-a]\n`,
  );
  const secretsPath = join(directory, "secrets.yaml");
  await Deno.writeTextFile(secretsPath, 'DB_PASSWORD: "s3cret_value"\n');
  await Deno.chmod(secretsPath, 0o600);
  return directory;
}

Deno.test("integration/info-logging: secret close failure changes terminal phase", async () => {
  await withTempDir(async (root) => {
    await secretCluster(root);
    const events: LoggedEvent[] = [];
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "secrets-deploy",
        machines: ["node-a"],
      },
      {
        onInfo: logger(events),
        transport: new FakeTransport(() => new CloseFailingSession()),
      },
    ) as SecretsDeployResult;

    assertEquals(result.succeeded, false);
    const messages = events.map((event) => event.message);
    assertStringIncludes(messages.join("\n"), "secret session close failed");
    assertStringIncludes(messages.join("\n"), "secret deployment completed");
  });
});

Deno.test("integration/info-logging: logger failure does not fail validation", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    const result = await run(
      { configRoot: root, cluster: "demo", action: "validate" },
      {
        onInfo: () => {
          throw new Error("logger unavailable");
        },
      },
    ) as ValidationResult;
    assertEquals(result.cluster, "demo");
  });
});

Deno.test("integration/info-logging: executor emits lifecycle and remote logs", async () => {
  await withTempDir(async (root) => {
    const scriptPath = join(root, "action.ts");
    await Deno.writeTextFile(scriptPath, "Deno.exit(0);\n");
    const base = makePlan();
    const steps = base.steps.map((step) =>
      Object.freeze({
        ...step,
        secretValues: Object.freeze(["super-secret"]),
        scripts: step.scripts.map((invocation) =>
          Object.freeze({ ...invocation, source: scriptPath })
        ),
      })
    );
    const executablePlan = Object.freeze({ ...base, steps: Object.freeze(steps) });
    const events: LoggedEvent[] = [];
    const executor = new DeploymentExecutor(new FakeTransport(), { onInfo: logger(events) });

    const result = await executor.execute(executablePlan);
    assertEquals(result.succeeded, true);
    const messages = events.map((event) => event.message).join("\n");
    assertStringIncludes(messages, "local preparation started");
    assertStringIncludes(messages, "local script staged");
    assertStringIncludes(messages, "plan step started");
    assertStringIncludes(messages, "remote workspace created");
    assertStringIncludes(messages, "plan step finished");
    assertStringIncludes(messages, "remote session closed");
    assertStringIncludes(messages, "deployment execution completed");
    assert(!messages.includes("super-secret"), "info logs must not contain secret values");
  });
});

import { writeCluster } from "../_support/fixtures.ts";
