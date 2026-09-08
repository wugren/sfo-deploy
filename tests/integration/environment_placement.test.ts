import { fromFileUrl, join } from "jsr:@std/path@1.1.6";

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
  withTempDir,
} from "../_support/assert.ts";
import { replaceInFile, writePlacementCluster } from "../_support/environment_placement.ts";
import {
  buildPlan,
  ConfigurationError,
  loadCluster,
  PlanningError,
  ReleaseSelection,
  ReleaseStore,
} from "../../src/mod.ts";
import type { DeploymentResultLike, SourceExporter, SourceImporter } from "../../src/mod.ts";
import type { ExecutionPlan } from "../../src/types.ts";

async function multiMachineCluster(root: string) {
  return await loadCluster(
    await writePlacementCluster(root, {
      machines: ["node-b", "node-a"],
      environments: [
        { name: "base", machines: ["node-b", "node-a"] },
        { name: "runtime", machines: ["node-b"], dependsOn: ["node-a/base"] },
      ],
      apps: [
        { name: "web", machines: ["node-b", "node-a"], dependsOn: ["base"] },
        { name: "remote", machines: ["node-b"], dependsOn: ["node-a/base"] },
      ],
    }),
  );
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory) await copyDirectory(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

function successfulResult(plan: ExecutionPlan): DeploymentResultLike {
  return {
    cluster: plan.cluster,
    requestedAction: plan.requestedAction,
    succeeded: true,
    exitCode: 0,
    steps: plan.steps.map((step) => ({
      stepId: step.id,
      machine: step.machine.machine.name,
      kind: step.kind,
      resource: step.resource,
      action: step.action,
      status: "succeeded",
      exitCode: 0,
      cleanupErrors: [],
    })),
  };
}

Deno.test("dv/environment placement: configure plan is deterministic with local and cross-machine dependencies", async () => {
  await withTempDir(async (root) => {
    const cluster = await multiMachineCluster(root);
    const plan = buildPlan(cluster, { action: "configure", withDependencies: true });
    assertEquals(plan.steps.map((step) => step.id), [
      "env:node-a/base:check",
      "env:node-a/base:install",
      "env:node-a/base:configure",
      "app:node-a/web:configure",
      "app:node-b/remote:configure",
      "env:node-b/base:check",
      "env:node-b/base:install",
      "env:node-b/base:configure",
      "app:node-b/web:configure",
      "env:node-b/runtime:check",
      "env:node-b/runtime:install",
      "env:node-b/runtime:configure",
    ]);
    assertEquals(
      plan.steps.find((step) => step.id === "env:node-b/runtime:check")?.dependsOn,
      ["env:node-a/base:configure"],
    );
    assertEquals(
      plan.steps.find((step) => step.id === "app:node-b/web:configure")?.dependsOn,
      ["env:node-b/base:configure"],
    );
  });
});

Deno.test("dv/environment placement: machine, App and Environment filters preserve action modes", async () => {
  await withTempDir(async (root) => {
    const cluster = await multiMachineCluster(root);
    const directed = buildPlan(cluster, { action: "deploy", apps: ["web"] });
    assertEquals(directed.steps.map((step) => step.id), [
      "app:node-a/web:configure",
      "app:node-a/web:deploy",
      "app:node-b/web:configure",
      "app:node-b/web:deploy",
    ]);
    const withDependencies = buildPlan(cluster, {
      action: "configure",
      machines: ["node-a"],
      apps: ["web"],
      withDependencies: true,
    });
    assertEquals(withDependencies.steps.map((step) => step.id), [
      "env:node-a/base:check",
      "env:node-a/base:install",
      "env:node-a/base:configure",
      "app:node-a/web:configure",
    ]);
    assertEquals(
      buildPlan(cluster, { action: "check", environments: ["node-b/base"] }).steps.map(
        (step) => step.id,
      ),
      ["env:node-b/base:check"],
    );
    assertEquals(
      buildPlan(cluster, { action: "check", environments: ["base"] }).steps.map((step) => step.id),
      ["env:node-a/base:check", "env:node-b/base:check"],
    );
  });
});

Deno.test("dv/environment placement: excluded, unknown and incomplete workflows fail closed", async () => {
  await withTempDir(async (root) => {
    const cluster = await multiMachineCluster(root);
    assertStringIncludes(
      assertThrows(
        () =>
          buildPlan(cluster, {
            action: "configure",
            machines: ["node-b"],
            apps: ["remote"],
            withDependencies: true,
          }),
        PlanningError,
      ).message,
      "过滤条件排除了必需依赖: env:node-a/base",
    );
    assertStringIncludes(
      assertThrows(
        () => buildPlan(cluster, { action: "deploy", apps: ["missing"] }),
        PlanningError,
      ).message,
      "未知 App 过滤器: missing",
    );
    assertStringIncludes(
      assertThrows(
        () => buildPlan(cluster, { action: "check", environments: ["missing"] }),
        PlanningError,
      ).message,
      "过滤条件没有选择任何部署对象",
    );
  });

  await withTempDir(async (root) => {
    const directory = await writePlacementCluster(root);
    await replaceInFile(
      join(directory, "cluster.yaml"),
      "base: [node-a]",
      "base: [missing-node]",
    );
    await assertRejects(
      () => loadCluster(directory),
      ConfigurationError,
      "Environment base 引用未知机器: missing-node",
    );
  });
});

Deno.test("integration/environment placement: public load and planning APIs keep v2 normalized behavior", async () => {
  await withTempDir(async (root) => {
    const v2 = await loadCluster(
      await writePlacementCluster(root, {
        machines: ["node-a", "node-b"],
        environments: [{ name: "base", machines: ["node-a", "node-b"] }],
        apps: [{ name: "demo", machines: ["node-a", "node-b"], dependsOn: ["base"] }],
      }),
    );
    const request = { action: "configure", apps: ["demo"], withDependencies: true } as const;
    const steps = buildPlan(v2, request).steps;
    assert(steps.some((step) => step.id === "app:node-a/demo:configure"));
    assert(steps.some((step) => step.id === "app:node-b/demo:configure"));

    const excluded = assertThrows(
      () => buildPlan(v2, { ...request, environments: ["node-a/base"] }),
      PlanningError,
    );
    assertStringIncludes(excluded.message, "过滤条件排除了必需依赖");

    await replaceInFile(
      join(v2.directory, "cluster.yaml"),
      "base: [node-a, node-b]",
      "base: [node-z]",
    );
    await assertRejects(() => loadCluster(v2.directory), ConfigurationError, "引用未知机器");
  });
});

Deno.test("integration/environment placement: multipass template is a runnable v2 shared-definition cluster", async () => {
  await withTempDir(async (root) => {
    const source = fromFileUrl(
      new URL("../../examples/eleph-server-multipass/cluster-template/", import.meta.url),
    );
    const clusterDirectory = join(root, "multipass");
    await copyDirectory(source, clusterDirectory);
    await Deno.writeTextFile(
      join(clusterDirectory, "machines.yaml"),
      (await Deno.readTextFile(join(clusterDirectory, "machines.yaml.tpl"))).replace(
        "__VM_IPV4__",
        "10.0.0.8",
      ),
    );
    await Deno.mkdir(join(clusterDirectory, "secrets"));
    await Deno.writeTextFile(join(clusterDirectory, "secrets", "id_ed25519"), "fixture-key\n");

    const cluster = await loadCluster(clusterDirectory);
    assertEquals([...cluster.environments.keys()], [
      "eleph-server/jre",
      "eleph-server/mysql",
      "eleph-server/nginx",
      "eleph-server/redis",
    ]);
    const plan = buildPlan(cluster, {
      action: "prepare",
    });
    assertEquals(plan.steps.map((step) => step.id), [
      "env:eleph-server/jre:check",
      "env:eleph-server/jre:install",
      "env:eleph-server/mysql:check",
      "env:eleph-server/mysql:install",
      "env:eleph-server/mysql:start",
      "env:eleph-server/mysql:restart",
      "env:eleph-server/nginx:check",
      "env:eleph-server/nginx:install",
      "env:eleph-server/redis:check",
      "env:eleph-server/redis:install",
      "env:eleph-server/redis:start",
      "env:eleph-server/redis:restart",
    ]);
    for (const definition of cluster.environments.values()) {
      assertStringIncludes(definition.directory, "/environments/");
      if (definition.directory.includes("/environments/eleph-server/")) {
        throw new Error(`template retained v1 machine nesting: ${definition.directory}`);
      }
    }

    const legacyRoot = join(clusterDirectory, "environments", "eleph-server", "mysql");
    await copyDirectory(join(clusterDirectory, "environments", "mysql"), legacyRoot);
    await assertRejects(
      () => loadCluster(clusterDirectory),
      ConfigurationError,
      "schema_version 2 不允许 v1 Environment 布局",
    );
  });
});

Deno.test("integration/environment placement: archived rollback plan does not read the current v2 layout", async () => {
  await withTempDir(async (root) => {
    const directory = await writePlacementCluster(root);
    await replaceInFile(
      join(directory, "cluster.yaml"),
      "name: placement-fixture",
      "name: cluster-v2",
    );
    const cluster = await loadCluster(directory);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    const exporter: SourceExporter = (_provider, source) => ({
      schema: "http.v1",
      payload: source,
    });
    const importer: SourceImporter = (_provider, envelope) =>
      envelope.payload as Readonly<Record<string, unknown>>;
    const store = new ReleaseStore(directory, {
      sourceExporter: exporter,
      sourceImporter: importer,
    });
    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await pending.archivePlans(plan);
    const record = await pending.finishResult(successfulResult(plan));

    await Deno.remove(join(directory, "environments"), { recursive: true });
    await Deno.remove(join(directory, "apps"), { recursive: true });
    const rollback = await store.loadRollbackPlan(record.releaseId);
    assertEquals(rollback.requestedAction, "rollback");
    assertEquals(rollback.steps.map((step) => step.id), [
      "app:node-a/demo:configure",
      "app:node-a/demo:deploy",
    ]);
    for (const step of rollback.steps) {
      for (const script of step.scripts) {
        assertStringIncludes(script.source, `/${record.releaseId}/snapshot/`);
      }
    }
  });
});
