import { assert, assertEquals } from "../_support/assert.ts";
import { loadCluster } from "../../src/mod.ts";
import { buildPlan } from "../../src/planning.ts";
import { withTempDir } from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";

const FULL_ACTIONS = ["check", "install", "configure", "start", "restart"] as const;

Deno.test("unit/planning: prepare plans only declared environment lifecycle steps", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(
      await writeCluster(root, { envActions: FULL_ACTIONS }),
    );
    const plan = buildPlan(cluster, { action: "prepare" });
    assertEquals(
      plan.steps.map((step) => step.action),
      ["check", "install", "configure", "start", "restart"],
    );
    for (const step of plan.steps) {
      assertEquals(step.kind, "environment");
      assertEquals(step.resource, "base");
      assertEquals(step.parameters.version, "1");
    }
  });
});

Deno.test("unit/planning: prepare omits undeclared start/restart and ignores apps", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeCluster(root));
    const plan = buildPlan(cluster, { action: "prepare" });
    assertEquals(
      plan.steps.map((step) => step.action),
      ["check", "install", "configure"],
    );
    assert(plan.steps.every((step) => step.kind === "environment"));
    assert(!plan.steps.some((step) => step.resource === "demo"));
  });
});

Deno.test("unit/planning: prepare omits undeclared configure", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(
      await writeCluster(root, { envActions: ["check", "install"] }),
    );
    const plan = buildPlan(cluster, { action: "prepare" });
    assertEquals(
      plan.steps.map((step) => step.action),
      ["check", "install"],
    );
  });
});

Deno.test("unit/planning: prepare honors environment selection", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeCluster(root));
    const plan = buildPlan(cluster, {
      action: "prepare",
      environments: ["base"],
    });
    assert(plan.steps.length > 0);
    assert(plan.steps.every((step) => step.resource === "base"));
  });
});

Deno.test("unit/planning: prepare step dependencies follow declaration order", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(
      await writeCluster(root, { envActions: FULL_ACTIONS }),
    );
    const plan = buildPlan(cluster, { action: "prepare" });
    for (const [index, step] of plan.steps.entries()) {
      const expected = index === 0 ? [] : [plan.steps[index - 1].id];
      assertEquals(step.dependsOn, expected);
    }
  });
});
