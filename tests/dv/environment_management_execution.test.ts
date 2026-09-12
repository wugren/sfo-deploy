import { join } from "jsr:@std/path@1.1.6";
import { assertEquals, withTempDir } from "../_support/assert.ts";
import { FakeSession } from "../_support/fake_session.ts";
import { DeploymentExecutor } from "../../src/execution.ts";
import type {
  EnvironmentPackageInstall,
  EnvironmentScriptManager,
  EnvironmentSystemManager,
  ExecutionPlan,
  PlanStep,
  ScriptInvocation,
} from "../../src/types.ts";

const packageInstall: EnvironmentPackageInstall = Object.freeze({
  kind: "package",
  manager: "auto",
  packages: ["nginx"],
  updateCache: true,
});
const serviceManager: EnvironmentSystemManager = Object.freeze({
  kind: "system",
  name: "nginx",
  tool: "auto",
  enabled: true,
  startAfterInstall: true,
  timeoutMs: 30000,
});

const scriptInvocation: ScriptInvocation = Object.freeze({
  source: "/fixture/stop.ts",
  relativePath: "scripts/stop.ts",
  permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
});

const scriptManager: EnvironmentScriptManager = Object.freeze({
  kind: "script",
  start: scriptInvocation,
  stop: scriptInvocation,
  restart: scriptInvocation,
});

Deno.test("dv/environment management: prepare runs package install then system manager start", async () => {
  await withTempDir(async (_root) => {
    const session = new FakeSession(
      127,
      "",
      0,
      0,
      "",
      "/home/deploy",
      [],
      "/usr/bin/apt-get",
      0,
      0,
      true,
      undefined,
      1,
    );
    const machine = session as unknown as never;
    const resolved = {
      machine: {
        name: "node-a",
        domains: [],
        privateIp: ["10.0.0.1"],
        publicIp: ["203.0.113.10"],
        region: "local",
        sshUser: "deploy",
        sshPort: 22,
        scriptRuntime: { kind: "deno", executable: "/usr/bin/deno" },
        environments: [],
      },
      address: "10.0.0.1",
      addressKind: "private",
      addresses: ["10.0.0.1"],
    } as never;
    const install: PlanStep = Object.freeze({
      id: "env:node-a/runtime:install",
      machine: resolved,
      kind: "environment",
      resource: "runtime",
      action: "install",
      scripts: [],
      parameters: { version: "1", requires_privilege: true },
      secretValues: [],
      secretFiles: [],
      templates: [],
      dependsOn: [],
      environmentInstall: packageInstall,
    });
    const start: PlanStep = Object.freeze({
      ...install,
      id: "env:node-a/runtime:start",
      action: "start",
      dependsOn: ["env:node-a/runtime:install"],
      environmentInstall: undefined,
      environmentManager: serviceManager,
    });
    const restart: PlanStep = Object.freeze({
      ...start,
      id: "env:node-a/runtime:restart",
      action: "restart",
      dependsOn: ["env:node-a/runtime:start"],
    });
    const plan: ExecutionPlan = Object.freeze({
      schemaVersion: 4,
      cluster: "demo",
      requestedAction: "prepare",
      steps: [install, start, restart],
    });
    const result = await new DeploymentExecutor({
      connect: () => Promise.resolve(machine),
    } as never).execute(plan);
    assertEquals(result.steps.map((step) => [step.action, step.status]), [
      ["install", "succeeded"],
      ["start", "succeeded"],
      ["restart", "skipped"],
    ]);
    assertEquals(session.pmCalls.at(-1)?.argv, [
      "/usr/bin/apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      "nginx",
    ]);
    assertEquals(
      session.calls.some((call) =>
        call.argv.join(" ") === "/usr/bin/systemctl start -- nginx.service"
      ),
      true,
    );
    assertEquals(
      session.calls.some((call) =>
        call.argv.join(" ") === "/usr/bin/systemctl restart -- nginx.service"
      ),
      false,
    );
  });
});

Deno.test("dv/environment management: stop runs script manager invocation", async () => {
  await withTempDir(async (root) => {
    const scriptPath = join(root, "stop.ts");
    await Deno.writeTextFile(scriptPath, "Deno.exit(0);\n");
    const invocation: ScriptInvocation = Object.freeze({
      source: scriptPath,
      relativePath: "scripts/stop.ts",
      permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
    });
    const manager: EnvironmentScriptManager = Object.freeze({
      kind: "script",
      start: invocation,
      stop: invocation,
      restart: invocation,
    });
    const session = new FakeSession();
    const machine = session as unknown as never;
    const resolved = {
      machine: {
        name: "node-a",
        domains: [],
        privateIp: ["10.0.0.1"],
        publicIp: ["203.0.113.10"],
        region: "local",
        sshUser: "deploy",
        sshPort: 22,
        scriptRuntime: { kind: "deno", executable: "/usr/bin/deno" },
        environments: [],
      },
      address: "10.0.0.1",
      addressKind: "private",
      addresses: ["10.0.0.1"],
    } as never;
    const step: PlanStep = Object.freeze({
      id: "env:node-a/mysql:stop",
      machine: resolved,
      kind: "environment",
      resource: "mysql",
      action: "stop",
      scripts: [invocation],
      parameters: { version: "8.0", requires_privilege: true },
      secretValues: [],
      secretFiles: [],
      templates: [],
      dependsOn: [],
      environmentManager: manager,
    });
    const plan: ExecutionPlan = Object.freeze({
      schemaVersion: 4,
      cluster: "demo",
      requestedAction: "stop",
      steps: [step],
    });
    const result = await new DeploymentExecutor({
      connect: () => Promise.resolve(machine),
    } as never).execute(plan);
    assertEquals(result.steps.map((item) => [item.action, item.status]), [
      ["stop", "succeeded"],
    ]);
  });
});
