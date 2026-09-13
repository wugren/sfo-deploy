import { join } from "jsr:@std/path@1.1.6";
import { assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { loadCluster } from "../../src/config.ts";
import { PlanningError } from "../../src/errors.ts";
import { buildPlan } from "../../src/planning.ts";

async function writeLifecycle(root: string, manager = "", managerScript = false): Promise<string> {
  const directory = join(root, "demo", "environments", "runtime");
  await Deno.mkdir(join(directory, "scripts"), { recursive: true });
  await Deno.writeTextFile(join(directory, "scripts", "action.ts"), "Deno.exit(0);\n");
  await Deno.writeTextFile(
    join(directory, "environment.yaml"),
    `schema_version: 1
name: runtime
version: "1"
requires_privilege: true
install:
  kind: package
  manager: auto
  packages: [nginx]
${
      manager
        ? `manager:\n  kind: system\n  name: nginx\n  tool: auto\n  enabled: true\n`
        : managerScript
        ? `manager:\n  kind: script\n  start: {path: scripts/action.ts, permissions: {run: [], net: []}}\n  stop: {path: scripts/action.ts, permissions: {run: [], net: []}}\n  restart: {path: scripts/action.ts, permissions: {run: [], net: []}}\n`
        : ""
    }`,
  );
  await Deno.mkdir(join(root, "demo"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "demo", "cluster.yaml"),
    `schema_version: 2\nname: demo\nexecutor_region: local\nenvironments:\n  runtime: [node-a]\napps: {}\n`,
  );
  await Deno.writeTextFile(
    join(root, "demo", "machines.yaml"),
    `schema_version: 1\nmachines:\n  - name: node-a\n    private_ip: [10.0.0.1]\n    public_ip: [203.0.113.10]\n    region: local\n    ssh_user: deploy\n    deno: /usr/bin/deno\n`,
  );
  return join(root, "demo");
}

Deno.test("unit/environment management planning: prepare omits check and manager by default", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeLifecycle(root));
    const plan = buildPlan(cluster, { action: "prepare" });
    assertEquals(plan.steps.map((step) => step.action), ["install"]);
    assertEquals(plan.steps[0].id, "env:node-a/runtime:install");
    assertEquals(plan.steps[0].environmentInstall?.kind, "package");
    assertEquals(plan.steps[0].scripts, []);
  });
});

Deno.test("unit/environment management planning: prepare plans start/restart and selects script", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeLifecycle(root, "system"));
    const plan = buildPlan(cluster, { action: "prepare" });
    assertEquals(plan.steps.map((step) => step.action), ["install", "start", "restart"]);
    assertEquals(plan.steps[1].dependsOn, ["env:node-a/runtime:install"]);
    assertEquals(plan.steps[2].dependsOn, ["env:node-a/runtime:start"]);
    assertEquals(plan.steps[1].environmentManager?.kind, "system");
  });
});

Deno.test("unit/environment management planning: script manager supplies one invocation per action", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeLifecycle(root, "", true));
    const prepare = buildPlan(cluster, { action: "prepare" });
    assertEquals(prepare.steps.map((step) => step.action), ["install", "start", "restart"]);
    assertEquals(prepare.steps[1].scripts.length, 1);
    assertEquals(prepare.steps[2].scripts.length, 1);
    const direct = buildPlan(cluster, { action: "restart" });
    assertEquals(direct.steps.map((step) => step.action), ["restart"]);
    assertEquals(direct.steps[0].scripts.length, 1);
    const stop = buildPlan(cluster, { action: "stop" });
    assertEquals(stop.steps.map((step) => step.action), ["stop"]);
    assertEquals(stop.steps[0].scripts.length, 1);
    assertEquals(stop.steps[0].environmentManager?.kind, "script");
  });
});

Deno.test("unit/environment management planning: system manager does not plan stop", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeLifecycle(root, "system"));
    await assertRejects(
      async () => {
        await Promise.resolve();
        buildPlan(cluster, { action: "stop" });
      },
      PlanningError,
      "has no action script",
    );
  });
});

Deno.test("unit/environment management planning: direct check fails closed", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeLifecycle(root));
    await assertRejects(
      async () => {
        await Promise.resolve();
        buildPlan(cluster, { action: "check" });
      },
      PlanningError,
      "does not support a check step",
    );
  });
});
