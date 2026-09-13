import { fromFileUrl, join } from "jsr:@std/path@1.1.6";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { plan as makePlan } from "../_support/fixtures.ts";
import { ConfigurationError } from "../../src/errors.ts";
import { __internal, ReleaseSelection, ReleaseStore } from "../../src/history.ts";
import type {
  DeploymentResultLike,
  PendingRelease,
  SourceExporter,
  SourceImporter,
} from "../../src/history.ts";
import type { AppManagementDefinition } from "../../src/types.ts";
import type { ExecutionPlan } from "../../src/types.ts";

const exporter: SourceExporter = (_provider, source) => ({
  schema: "http.v1",
  payload: source,
});
const importer: SourceImporter = (_provider, envelope) =>
  envelope.payload as Readonly<Record<string, unknown>>;

async function setupPlan(root: string): Promise<{
  readonly cluster: string;
  readonly plan: ExecutionPlan;
  readonly store: ReleaseStore;
}> {
  const cluster = join(root, "demo");
  await Deno.mkdir(cluster, { recursive: true });
  const source = join(cluster, "action.ts");
  await Deno.writeTextFile(source, "console.log('complete snapshot payload');\n");
  const base = makePlan();
  const plan: ExecutionPlan = Object.freeze({
    ...base,
    steps: Object.freeze(base.steps.map((step) =>
      Object.freeze({
        ...step,
        scripts: Object.freeze(step.scripts.map((item) => Object.freeze({ ...item, source }))),
      })
    )),
  });
  return {
    cluster,
    plan,
    store: new ReleaseStore(cluster, {
      sourceExporter: exporter,
      sourceImporter: importer,
      lockTimeoutMs: 100,
    }),
  };
}

async function beginArchived(root: string): Promise<{
  readonly store: ReleaseStore;
  readonly plan: ExecutionPlan;
  readonly pending: PendingRelease;
  readonly snapshot: string;
}> {
  const { store, plan } = await setupPlan(root);
  const pending = await store.beginAttempt({
    operation: "deploy",
    selection: new ReleaseSelection(),
  });
  await pending.archivePlans(plan);
  return {
    store,
    plan,
    pending,
    snapshot: join(store.root, pending.releaseId, "snapshot"),
  };
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

async function pathMissing(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return false;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return true;
    throw cause;
  }
}

Deno.test("unit/history write-all: short writes preserve archive and atomic JSON bytes", async () => {
  await withTempDir(async (root) => {
    const { store, plan } = await setupPlan(root);
    const originalWrite = Deno.FsFile.prototype.write;
    Deno.FsFile.prototype.write = function (data: Uint8Array): Promise<number> {
      return originalWrite.call(this, data.subarray(0, Math.min(7, data.byteLength)));
    };
    let releaseId = "";
    try {
      const pending = await store.beginAttempt({
        operation: "deploy",
        selection: new ReleaseSelection(),
      });
      releaseId = pending.releaseId;
      await pending.archivePlans(plan);
      await pending.closeIncomplete();
    } finally {
      Deno.FsFile.prototype.write = originalWrite;
    }

    const releaseDirectory = join(store.root, releaseId);
    const intent = await __internal.readJson(join(releaseDirectory, "intent.json"), 1024 * 1024);
    assertEquals((intent as { release_id: string }).release_id, releaseId);
    const decoded = await store.verifySnapshot(join(releaseDirectory, "snapshot"), releaseId);
    assertEquals(decoded.steps.length, plan.steps.length);
    assertEquals(
      await Deno.readTextFile(decoded.steps[0].scripts[0].source),
      "console.log('complete snapshot payload');\n",
    );
  });
});

Deno.test("unit/history write-all: zero progress fails before atomic target publication", async () => {
  await withTempDir(async (root) => {
    const destination = join(root, "outcome.json");
    const originalWrite = Deno.FsFile.prototype.write;
    Deno.FsFile.prototype.write = () => Promise.resolve(0);
    try {
      await assertRejects(
        () => __internal.atomicJson(destination, { status: "complete" }, { exclusive: true }),
        ConfigurationError,
        "写入未取得有效进展",
      );
    } finally {
      Deno.FsFile.prototype.write = originalWrite;
    }
    assert(await pathMissing(destination));
    assertEquals(
      [...Deno.readDirSync(root)].filter((entry) => entry.name.includes("outcome.json")).length,
      0,
    );
  });
});

Deno.test("unit/history nlink: transient hard-link window converges and persistent links fail", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "component.json");
    const alias = join(root, "component.alias");
    await Deno.writeTextFile(path, "stable");
    await Deno.link(path, alias);
    let sleeps = 0;
    const bytes = await __internal.readRegularBytes(path, 1024, "fixture", {
      hardLinkSettleDelaysMs: [0],
      sleep: async () => {
        sleeps++;
        await Deno.remove(alias);
      },
    });
    assertEquals(new TextDecoder().decode(bytes), "stable");
    assertEquals(sleeps, 1);

    await Deno.link(path, alias);
    await assertRejects(
      () =>
        __internal.readRegularBytes(path, 1024, "fixture", {
          hardLinkSettleDelaysMs: [0, 0],
          sleep: () => Promise.resolve(),
        }),
      ConfigurationError,
      "未在期限内收敛",
    );
    const third = join(root, "component.third");
    await Deno.link(path, third);
    await assertRejects(
      () => __internal.readRegularBytes(path, 1024, "fixture"),
      ConfigurationError,
      "单链接普通文件",
    );
  });
});

Deno.test("unit/history nlink: identity replacement during settle fails closed", async () => {
  await withTempDir(async (root) => {
    const path = join(root, "component.json");
    const alias = join(root, "component.alias");
    const replacement = join(root, "replacement.json");
    await Deno.writeTextFile(path, "old");
    await Deno.link(path, alias);
    await Deno.writeTextFile(replacement, "new");
    await assertRejects(
      () =>
        __internal.readRegularBytes(path, 1024, "fixture", {
          hardLinkSettleDelaysMs: [0],
          sleep: async () => {
            await Deno.remove(path);
            await Deno.rename(replacement, path);
          },
        }),
      ConfigurationError,
      "身份发生变化",
    );
  });
});

Deno.test("unit/history codec: checked-in Deno v2/v3 JSON fixtures decode from files", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    const snapshot = join(root, "snapshot");
    await Deno.mkdir(join(snapshot, "files"), { recursive: true });
    await Deno.mkdir(cluster);
    await Deno.writeTextFile(join(snapshot, "files", "action.py"), "raise SystemExit(0)\n");
    await Deno.writeTextFile(join(snapshot, "files", "action.ts"), "Deno.exit(0);\n");
    const fixtureRoot = fromFileUrl(new URL("../fixtures/history/", import.meta.url));
    for (const schema of [2, 3] as const) {
      const fixture = join(fixtureRoot, `plan-v${schema}.json`);
      const raw = await __internal.readJson(fixture, 1024 * 1024);
      const decoded = await __internal.decodePlan(raw, snapshot, cluster, importer);
      assertEquals(decoded.schemaVersion, 3);
      assertEquals(decoded.requestedAction, "deploy");
      assertEquals(decoded.steps[0].machine.machine.scriptRuntime.kind, "deno");
      assertEquals(decoded.steps[0].machine.addresses[0], "10.0.0.1");
      assertEquals(decoded.steps[0].machine.addresses.length, schema === 3 ? 2 : 1);
    }
  });
});

Deno.test("unit/history codec: Python v1 fixture is explicitly rejected", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    const snapshot = join(root, "snapshot");
    await Deno.mkdir(join(snapshot, "files"), { recursive: true });
    await Deno.mkdir(cluster);
    await Deno.writeTextFile(join(snapshot, "files", "action.py"), "raise SystemExit(0)\n");
    const fixture = join(
      fromFileUrl(new URL("../fixtures/history/", import.meta.url)),
      "plan-v1.json",
    );
    const raw = await __internal.readJson(fixture, 1024 * 1024);
    const error = await assertRejects(
      () => __internal.decodePlan(raw, snapshot, cluster, importer),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "execution-plan v1 Python 快照不再支持");
  });
});

Deno.test("unit/history codec: legacy v2 snapshot rearchives without a relative path", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    const snapshot = join(root, "snapshot");
    await Deno.mkdir(join(snapshot, "files"), { recursive: true });
    await Deno.mkdir(cluster);
    const snapshotAction = join(snapshot, "files", "action.ts");
    await Deno.writeTextFile(snapshotAction, "Deno.exit(0);\n");
    const fixture = join(
      fromFileUrl(new URL("../fixtures/history/", import.meta.url)),
      "plan-v2.json",
    );
    const decoded = await __internal.decodePlan(
      await __internal.readJson(fixture, 1024 * 1024),
      snapshot,
      cluster,
      importer,
    );
    assertEquals(decoded.steps[0].scripts[0].relativePath, "");

    const archive = {
      add: () => Promise.resolve("files/action.ts"),
    } as unknown as Parameters<typeof __internal.encodePlan>[1];
    const encoded = await __internal.encodePlan(
      decoded,
      archive,
      (_provider, source) => ({ schema: "fixture.v1", payload: source }),
    );
    assertEquals(encoded.schema_version, 4);
    const step = (encoded.steps as Array<{
      scripts: Array<{ relative_path: string }>;
    }>)[0];
    assertEquals(step.scripts[0].relative_path, "");
  });
});

Deno.test("unit/history codec: phased deploy accepts managed restart", async () => {
  await withTempDir(async (root) => {
    const { store, plan } = await setupPlan(root);
    const [configured, deployed] = plan.steps;
    const stage = Object.freeze({
      ...configured,
      id: "app:node-a/demo:stage",
      action: "stage" as const,
      dependsOn: Object.freeze([] as string[]),
    });
    const activate = Object.freeze({
      ...deployed,
      id: "app:node-a/demo:activate",
      action: "activate" as const,
      dependsOn: Object.freeze([stage.id]),
    });
    const restart = Object.freeze({
      ...deployed,
      id: "app:node-a/demo:restart",
      action: "restart" as const,
      package: undefined,
      deployment: undefined,
      installDirectory: undefined,
      runAs: "deploy",
      lifecycleSecretValues: Object.freeze([] as string[]),
      lifecycleSecretFiles: Object.freeze([] as string[]),
      management: Object.freeze({
        runAs: "deploy",
        configs: Object.freeze([]),
        configScripts: Object.freeze([]),
        manager: Object.freeze({
          kind: "service" as const,
          tool: "systemctl" as const,
          unit: "demo.service",
          enabled: true,
          daemonReload: true,
          onDeploy: "restart" as const,
          timeoutMs: 30_000,
        }),
      }),
      dependsOn: Object.freeze([activate.id]),
    });
    const phased: ExecutionPlan = Object.freeze({
      ...plan,
      steps: Object.freeze([stage, activate, restart]),
    });

    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await pending.archivePlans(phased);
    const decoded = await store.verifySnapshot(
      join(store.root, pending.releaseId, "snapshot"),
      pending.releaseId,
    );
    assertEquals(decoded.requestedAction, "deploy");
    assertEquals(decoded.steps.map((step) => step.action), ["stage", "activate", "restart"]);
    const service = decoded.steps[2].management?.manager;
    assert(service?.kind === "service");
    assertEquals(service.onDeploy, "restart");
    await pending.closeIncomplete();
  });
});

Deno.test("unit/history codec: deploy whitelist still rejects unknown managed action", async () => {
  await withTempDir(async (root) => {
    const { store, plan } = await setupPlan(root);
    const invalid = Object.freeze({
      ...plan,
      steps: Object.freeze(
        plan.steps.map((step) => Object.freeze({ ...step, action: "stop" as const })),
      ),
    });
    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    const error = await assertRejects(
      () => pending.archivePlans(invalid),
      ConfigurationError,
      "计划步骤与 requested_action 不匹配",
    );
    assertStringIncludes(error.message, "app:node-a/demo:configure app/stop vs deploy");
    await pending.closeIncomplete();
  });
});

Deno.test("unit/history codec: versioned stage keeps run_as without management", async () => {
  await withTempDir(async (root) => {
    const { store, plan } = await setupPlan(root);
    const [configured, deployed] = plan.steps;
    const stage = Object.freeze({
      ...deployed,
      id: "app:node-a/demo:stage",
      action: "stage" as const,
      package: deployed.package,
      deployment: { kind: "versioned" as const },
      installDirectory: "/srv/demo",
      runAs: "deploy",
      management: undefined,
      lifecycleSecretValues: undefined,
      lifecycleSecretFiles: undefined,
      dependsOn: Object.freeze([] as string[]),
    });
    const phasePlan: ExecutionPlan = Object.freeze({
      ...plan,
      steps: Object.freeze([stage]),
    });

    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await pending.archivePlans(phasePlan);
    const snapshot = join(store.root, pending.releaseId, "snapshot");
    const decoded = await store.verifySnapshot(snapshot, pending.releaseId);
    assertEquals(decoded.steps[0].runAs, "deploy");
    assertEquals(decoded.steps[0].management, undefined);
    const persisted = JSON.parse(
      await Deno.readTextFile(join(snapshot, "actual-plan.json")),
    );
    assertEquals(persisted.steps[0].run_as, "deploy");
    assertEquals(persisted.steps[0].management, null);
    assertEquals(persisted.steps[0].lifecycle_secret_values, []);
    assertEquals(persisted.steps[0].lifecycle_secret_files, []);
    await pending.closeIncomplete();

    const invalidRunAsPlan: ExecutionPlan = Object.freeze({
      ...plan,
      steps: Object.freeze([
        Object.freeze({ ...configured, runAs: "deploy" }),
      ]),
    });
    const invalidPending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await assertRejects(
      () => invalidPending.archivePlans(invalidRunAsPlan),
      ConfigurationError,
      "非 managed plan-v4 步骤不能声明 run_as",
    );
    await invalidPending.closeIncomplete();

    for (const runAs of [undefined, "root"] as const) {
      const invalidStagePlan: ExecutionPlan = Object.freeze({
        ...plan,
        steps: Object.freeze([
          Object.freeze({ ...stage, runAs }),
        ]),
      });
      const invalidStagePending = await store.beginAttempt({
        operation: "deploy",
        selection: new ReleaseSelection(),
      });
      await assertRejects(
        () => invalidStagePending.archivePlans(invalidStagePlan),
        ConfigurationError,
        runAs === undefined ? "versioned stage 步骤缺少 run_as" : "非 root",
      );
      await invalidStagePending.closeIncomplete();
    }
  });
});

Deno.test("unit/history codec: versioned activate accepts empty management run-as declaration", async () => {
  await withTempDir(async (root) => {
    const { store, plan } = await setupPlan(root);
    const [configured, deployed] = plan.steps;
    const emptyManagement: AppManagementDefinition = Object.freeze({
      runAs: "deploy",
      configs: Object.freeze([]),
      configScripts: Object.freeze([]),
      manager: undefined,
    });
    const activate = Object.freeze({
      ...deployed,
      id: "app:node-a/demo:activate",
      action: "activate" as const,
      package: undefined,
      deployment: { kind: "versioned" as const },
      installDirectory: "/srv/demo",
      runAs: "deploy",
      management: emptyManagement,
      lifecycleSecretValues: Object.freeze([]),
      lifecycleSecretFiles: Object.freeze([]),
      deliveryInputs: undefined,
      bundleScripts: undefined,
      dependsOn: Object.freeze([] as string[]),
    });
    const phasePlan: ExecutionPlan = Object.freeze({
      ...plan,
      steps: Object.freeze([activate]),
    });

    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await pending.archivePlans(phasePlan);
    const snapshot = join(store.root, pending.releaseId, "snapshot");
    const decoded = await store.verifySnapshot(snapshot, pending.releaseId);
    assertEquals(decoded.steps[0].runAs, "deploy");
    assertEquals(decoded.steps[0].management?.configs.length, 0);
    assertEquals(decoded.steps[0].management?.manager, undefined);
    const persisted = JSON.parse(
      await Deno.readTextFile(join(snapshot, "actual-plan.json")),
    );
    assertEquals(persisted.steps[0].management, {
      configs: [],
      config_scripts: [],
      manager: null,
    });
    await pending.closeIncomplete();

    const invalid = Object.freeze({
      ...configured,
      runAs: "deploy",
      management: emptyManagement,
      lifecycleSecretValues: Object.freeze([]),
      lifecycleSecretFiles: Object.freeze([]),
    });
    const invalidPending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await assertRejects(
      () =>
        invalidPending.archivePlans(Object.freeze({ ...plan, steps: Object.freeze([invalid]) })),
      ConfigurationError,
      "management 声明不能为空",
    );
    await invalidPending.closeIncomplete();
  });
});

Deno.test("unit/history integrity: extra, missing, symlink and outcome mismatch fail closed", async () => {
  await withTempDir(async (root) => {
    const extra = await beginArchived(join(root, "extra"));
    await Deno.writeTextFile(join(extra.snapshot, "unexpected"), "extra");
    await assertRejects(
      () => extra.store.verifySnapshot(extra.snapshot, extra.pending.releaseId),
      ConfigurationError,
      "未登记文件",
    );
    await extra.pending.closeIncomplete();

    const missing = await beginArchived(join(root, "missing"));
    const manifest = JSON.parse(await Deno.readTextFile(join(missing.snapshot, "manifest.json")));
    const archivedFile = manifest.files.find((item: { path: string }) =>
      item.path.startsWith("files/")
    ).path;
    await Deno.remove(join(missing.snapshot, archivedFile));
    await assertRejects(
      () => missing.store.verifySnapshot(missing.snapshot, missing.pending.releaseId),
      ConfigurationError,
      "缺少文件",
    );
    await missing.pending.closeIncomplete();

    const linked = await beginArchived(join(root, "linked"));
    await Deno.symlink("actual-plan.json", join(linked.snapshot, "linked-plan.json"));
    await assertRejects(
      () => linked.store.verifySnapshot(linked.snapshot, linked.pending.releaseId),
      ConfigurationError,
      "禁止符号链接",
    );
    await linked.pending.closeIncomplete();

    const inconsistent = await beginArchived(join(root, "outcome"));
    await assertRejects(
      () =>
        inconsistent.pending.finishResult({
          ...successfulResult(inconsistent.plan),
          requestedAction: "rollback",
        }),
      ConfigurationError,
      "动作与实际执行计划不一致",
    );
    assert(
      await pathMissing(
        join(inconsistent.store.root, inconsistent.pending.releaseId, "outcome.json"),
      ),
    );
    await inconsistent.pending.closeIncomplete();
  });
});

Deno.test("unit/history rollback: full attempt preserves source snapshot and lineage", async () => {
  await withTempDir(async (root) => {
    const first = await beginArchived(root);
    const sourceRecord = await first.pending.finishResult(successfulResult(first.plan));
    const sourceManifestPath = join(first.snapshot, "manifest.json");
    const sourceManifestBefore = await Deno.readTextFile(sourceManifestPath);
    const rollback = await first.store.beginAttempt({
      operation: "rollback",
      selection: new ReleaseSelection(),
      sourceReleaseId: sourceRecord.releaseId,
    });
    const inherited = await rollback.inheritRollbackSnapshot(sourceRecord.releaseId);
    assertEquals(inherited.requestedAction, "rollback");
    const rollbackRecord = await rollback.finishResult(successfulResult(inherited));
    assertEquals(rollbackRecord.operation, "rollback");
    assertEquals(rollbackRecord.sourceReleaseId, sourceRecord.releaseId);
    assertEquals(rollbackRecord.status, "succeeded");
    assertEquals(await Deno.readTextFile(sourceManifestPath), sourceManifestBefore);
    const sourceAfter = await first.store.get(sourceRecord.releaseId);
    assertEquals(sourceAfter.operation, "deploy");
    assertEquals(sourceAfter.sourceReleaseId, undefined);
    const loaded = await first.store.loadRollbackPlan(sourceRecord.releaseId);
    assertEquals(loaded.requestedAction, "rollback");
    assertStringIncludes(loaded.steps[0].scripts[0].source, sourceRecord.releaseId);
  });
});
