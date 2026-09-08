import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { plan as makePlan } from "../_support/fixtures.ts";
import { ConfigurationError } from "../../src/errors.ts";
import {
  __internal,
  deriveRollbackPlan,
  ReleaseSelection,
  ReleaseStore,
} from "../../src/history.ts";
import type { SourceExporter, SourceImporter } from "../../src/history.ts";
import type { ExecutionPlan } from "../../src/types.ts";

const exporter: SourceExporter = (_provider, source) => ({
  schema: "http.v1",
  payload: source,
});
const importer: SourceImporter = (_provider, envelope) =>
  envelope.payload as Readonly<Record<string, unknown>>;

async function archived(root: string): Promise<{
  store: ReleaseStore;
  releaseId: string;
  snapshot: string;
  plan: ExecutionPlan;
}> {
  const cluster = join(root, "demo");
  await Deno.mkdir(cluster, { recursive: true });
  const source = join(cluster, "action.ts");
  await Deno.writeTextFile(source, "Deno.exit(0);\n");
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
  const store = new ReleaseStore(cluster, {
    sourceExporter: exporter,
    sourceImporter: importer,
    lockTimeoutMs: 100,
  });
  const pending = await store.beginAttempt({
    operation: "deploy",
    selection: new ReleaseSelection(),
  });
  await pending.archivePlans(plan);
  const releaseId = pending.releaseId;
  await pending.closeIncomplete();
  return { store, releaseId, snapshot: join(store.root, releaseId, "snapshot"), plan };
}

Deno.test("unit/history: new writes use v4 and v1/v2/v3 snapshots remain readable", async () => {
  await withTempDir(async (root) => {
    const { snapshot } = await archived(root);
    const current = JSON.parse(await Deno.readTextFile(join(snapshot, "actual-plan.json")));
    assertEquals(current.schema_version, 4);
    assertEquals(current.steps[0].management, null);
    assertEquals(current.steps[0].run_as, null);
    assertEquals(current.steps[0].lifecycle_secret_values, []);
    assertEquals(current.steps[0].lifecycle_secret_files, []);
    const currentDecoded = await __internal.decodePlan(
      current,
      snapshot,
      join(root, "demo"),
      importer,
    );
    assertEquals(currentDecoded.schemaVersion, 4);

    const v3 = structuredClone(current);
    v3.schema_version = 3;
    const legacyFields = JSON.parse(
      await Deno.readTextFile(
        join(import.meta.dirname ?? ".", "../fixtures/history/legacy-v3-secret-field-names.json"),
      ),
    );
    for (const step of v3.steps) {
      step[legacyFields.values_field] = step.secret_values;
      step[legacyFields.files_field] = step.secret_files;
      delete step.secret_values;
      delete step.secret_files;
      delete step.management;
      delete step.deployment;
      delete step.delivery_inputs;
      delete step.run_as;
      delete step.lifecycle_secret_values;
      delete step.lifecycle_secret_files;
    }
    const decodedV3 = await __internal.decodePlan(v3, snapshot, join(root, "demo"), importer);
    assertEquals(decodedV3.schemaVersion, 3);
    assertEquals(decodedV3.steps[0].machine.machine.scriptRuntime.kind, "deno");

    const v2 = structuredClone(v3);
    v2.schema_version = 2;
    const decodedV2 = await __internal.decodePlan(v2, snapshot, join(root, "demo"), importer);
    assertEquals(decodedV2.steps.length, current.steps.length);

    const v1 = structuredClone(v3);
    v1.schema_version = 1;
    for (const step of v1.steps) {
      step.machine.definition.python = "python3";
      delete step.machine.definition.script_runtime;
      step.scripts = step.scripts.map((item: { source: string }) => item.source);
    }
    const decodedV1 = await __internal.decodePlan(v1, snapshot, join(root, "demo"), importer);
    assertEquals(decodedV1.steps[0].machine.machine.scriptRuntime.kind, "python");
  });
});

Deno.test("unit/history: snapshot tampering and duplicate JSON keys fail closed", async () => {
  await withTempDir(async (root) => {
    const { store, releaseId, snapshot } = await archived(root);
    await Deno.writeTextFile(join(snapshot, "actual-plan.json"), "{}\n");
    const error = await assertRejects(
      () => store.verifySnapshot(snapshot, releaseId),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "完整性失败");
    const duplicate = join(root, "duplicate.json");
    await Deno.writeTextFile(duplicate, '{"a":1,"a":2}\n');
    await assertRejects(() => __internal.readJson(duplicate, 1024), ConfigurationError, "重复键");
  });
});

Deno.test("unit/history: operation lock serializes attempts and releases on close", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    await Deno.mkdir(cluster);
    const store = new ReleaseStore(cluster, {
      sourceExporter: exporter,
      sourceImporter: importer,
      lockTimeoutMs: 60,
    });
    const first = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await assertRejects(
      () => store.beginAttempt({ operation: "deploy", selection: new ReleaseSelection() }),
      ConfigurationError,
      "已有发布",
    );
    await first.closeIncomplete();
    const second = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await second.finishError({ status: "failed", category: "test", message: "expected" });
    assertEquals((await store.get(second.releaseId)).status, "failed");
  });
});

Deno.test("unit/history: rollback lineage is derived without mutating source plan", () => {
  const original = makePlan();
  const rollback = deriveRollbackPlan(original);
  assertEquals(rollback.requestedAction, "rollback");
  assertEquals(original.requestedAction, "deploy");
  assertEquals(rollback.steps.map((step) => step.action), ["configure", "deploy"]);
});

Deno.test("unit/history: packageless rollback keeps app check/configure", () => {
  const original = makePlan();
  const packageless: ExecutionPlan = Object.freeze({
    ...original,
    steps: Object.freeze(
      original.steps.filter((step) => step.action === "configure").flatMap((configure) => [
        Object.freeze({
          ...configure,
          action: "check",
          id: "app:node-a/demo:check",
          parameters: Object.freeze({}),
        }),
        Object.freeze({
          ...configure,
          dependsOn: Object.freeze(["app:node-a/demo:check"]),
          parameters: Object.freeze({}),
        }),
      ]),
    ),
  });
  const rollback = deriveRollbackPlan(packageless);
  assertEquals(rollback.requestedAction, "rollback");
  assertEquals(rollback.steps.map((step) => step.action), ["check", "configure"]);
  assertEquals(rollback.steps[1].dependsOn, ["app:node-a/demo:check"]);
});

Deno.test("unit/history: v4 codec round-trips install_directory and delivery inputs", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    await Deno.mkdir(cluster);
    const source = join(cluster, "action.ts");
    const start = join(cluster, "start.ts");
    await Deno.writeTextFile(source, "Deno.exit(0);\n");
    await Deno.writeTextFile(start, "Deno.exit(0);\n");
    const base = makePlan(["node-a"]);
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze(base.steps.map((step) =>
        Object.freeze({
          ...step,
          scripts: Object.freeze(
            step.scripts.map((item) => Object.freeze({ ...item, source })),
          ),
          installDirectory: step.action === "deploy" ? "/srv/demo" : undefined,
          bundleScripts: step.action === "deploy"
            ? Object.freeze([Object.freeze({
              source: start,
              relativePath: "scripts/start.ts",
              permissions: Object.freeze({
                run: Object.freeze(["/usr/bin/sudo"]),
                net: Object.freeze([] as string[]),
              }),
            })])
            : undefined,
          ...(step.action === "deploy"
            ? {
              runAs: "deploy",
              lifecycleSecretValues: Object.freeze([] as string[]),
              lifecycleSecretFiles: Object.freeze([] as string[]),
              management: Object.freeze({
                runAs: "deploy",
                configs: Object.freeze([]),
                service: Object.freeze({
                  kind: "systemd" as const,
                  unit: "demo.service",
                  daemonReload: false,
                  onDeploy: "restart" as const,
                  timeoutMs: 30_000,
                }),
                hooks: new Map(),
              }),
            }
            : {}),
        })
      )),
    });
    const store = new ReleaseStore(cluster, {
      sourceExporter: exporter,
      sourceImporter: importer,
    });
    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await pending.archivePlans(plan);
    const releaseId = pending.releaseId;
    await pending.closeIncomplete();
    const snapshot = join(store.root, releaseId, "snapshot");
    const current = JSON.parse(await Deno.readTextFile(join(snapshot, "actual-plan.json")));
    assertStringIncludes(
      JSON.stringify(current.steps[1]),
      "install_directory",
    );
    const decoded = await __internal.decodePlan(current, snapshot, cluster, importer);
    const deployStep = decoded.steps.find((step) => step.action === "deploy");
    assertEquals(deployStep?.installDirectory, "/srv/demo");
    assertEquals(deployStep?.bundleScripts?.[0].relativePath, "scripts/start.ts");
    assertEquals(deployStep?.bundleScripts?.[0].permissions.run, ["/usr/bin/sudo"]);
    assertEquals(deployStep?.runAs, "deploy");
    assertEquals(deployStep?.management?.runAs, "deploy");
    assertEquals(deployStep?.lifecycleSecretValues, []);

    const missingRunAs = structuredClone(current);
    const managed = missingRunAs.steps.find((step: { action: string }) => step.action === "deploy");
    managed.run_as = null;
    await assertRejects(
      () => __internal.decodePlan(missingRunAs, snapshot, cluster, importer),
      ConfigurationError,
      "缺少 run_as",
    );
  });
});

Deno.test("unit/history: v4 codec round-trips secret placeholder references", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    await Deno.mkdir(cluster);
    const source = join(cluster, "action.ts");
    const template = join(cluster, "custom.conf");
    await Deno.writeTextFile(source, "Deno.exit(0);\n");
    await Deno.writeTextFile(template, "password=${DB_PASSWORD}\n");
    const base = makePlan(["node-a"]);
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze(base.steps.map((step) =>
        Object.freeze({
          ...step,
          scripts: Object.freeze(step.scripts.map((item) => Object.freeze({ ...item, source }))),
          deliveryInputs: Object.freeze({
            scripts: Object.freeze(
              step.scripts.map((item) => Object.freeze({ ...item, source })),
            ),
            files: Object.freeze([]),
          }),
          ...(step.action === "deploy"
            ? {
              runAs: "deploy",
              secretValues: Object.freeze(["DB_PASSWORD"]),
              lifecycleSecretValues: Object.freeze(["DB_PASSWORD"]),
              lifecycleSecretFiles: Object.freeze([] as string[]),
              management: Object.freeze({
                runAs: "deploy",
                configs: Object.freeze([
                  Object.freeze({
                    name: "custom",
                    relativePath: "custom.conf",
                    source: template,
                    target: "/etc/demo/custom.conf",
                    owner: undefined,
                    group: undefined,
                    mode: 0o600,
                    variables: Object.freeze([]),
                    format: "json" as const,
                    secretReferences: Object.freeze(
                      new Map([
                        [
                          "DB_PASSWORD",
                          Object.freeze({ kind: "value" as const, valueType: "string" as const }),
                        ],
                      ]),
                    ),
                    validator: undefined,
                    onChange: "restart" as const,
                  }),
                ]),
                service: undefined,
                hooks: new Map(),
              }),
            }
            : {}),
        })
      )),
    });
    const store = new ReleaseStore(cluster, {
      sourceExporter: exporter,
      sourceImporter: importer,
    });
    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await pending.archivePlans(plan);
    const releaseId = pending.releaseId;
    await pending.closeIncomplete();
    const snapshot = join(store.root, releaseId, "snapshot");
    const current = JSON.parse(await Deno.readTextFile(join(snapshot, "actual-plan.json")));
    const encoded = current.steps.find((step: { action: string }) => step.action === "deploy")
      .management.configs[0];
    assertEquals(encoded.format, "json");
    assertEquals(encoded.secret_references, [{
      secret: "DB_PASSWORD",
      kind: "value",
      value_type: "string",
    }]);
    const decoded = await __internal.decodePlan(current, snapshot, cluster, importer);
    const config = decoded.steps.find((step) => step.action === "deploy")?.management?.configs[0];
    assertEquals(config?.format, "json");
    assertEquals([...config!.secretReferences.entries()], [[
      "DB_PASSWORD",
      { kind: "value", valueType: "string" },
    ]]);
    assertEquals(config?.variables, []);
  });
});

Deno.test("unit/history: v4 codec round-trips service unit config", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    await Deno.mkdir(cluster);
    const source = join(cluster, "action.ts");
    await Deno.writeTextFile(source, "Deno.exit(0);\n");
    const base = makePlan(["node-a"]);
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze(base.steps.map((step) =>
        Object.freeze({
          ...step,
          scripts: Object.freeze(step.scripts.map((item) => Object.freeze({ ...item, source }))),
          ...(step.action === "deploy"
            ? {
              runAs: "deploy",
              lifecycleSecretValues: Object.freeze([] as string[]),
              lifecycleSecretFiles: Object.freeze([] as string[]),
              management: Object.freeze({
                runAs: "deploy",
                configs: Object.freeze([]),
                service: Object.freeze({
                  kind: "systemd" as const,
                  unit: "demo.service",
                  daemonReload: true,
                  onDeploy: "restart" as const,
                  timeoutMs: 30_000,
                  unitConfig: Object.freeze({
                    target: "/etc/systemd/system/demo.service",
                    workingDirectory: "/srv/demo/current",
                    command: "/srv/demo/current/bin/server",
                    args: Object.freeze(["--config", "config/application.ini"]),
                  }),
                }),
                hooks: new Map(),
              }),
            }
            : {}),
        })
      )),
    });
    const store = new ReleaseStore(cluster, {
      sourceExporter: exporter,
      sourceImporter: importer,
    });
    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    await pending.archivePlans(plan);
    await pending.closeIncomplete();
    const snapshot = join(store.root, pending.releaseId, "snapshot");
    const current = JSON.parse(await Deno.readTextFile(join(snapshot, "actual-plan.json")));
    const encoded = current.steps.find((step: { action: string }) => step.action === "deploy")
      .management.service.unit_config;
    assertEquals(encoded, {
      target: "/etc/systemd/system/demo.service",
      working_directory: "/srv/demo/current",
      command: "/srv/demo/current/bin/server",
      args: ["--config", "config/application.ini"],
    });
    const decoded = await __internal.decodePlan(current, snapshot, cluster, importer);
    assertEquals(
      decoded.steps.find((step) => step.action === "deploy")?.management?.service?.unitConfig,
      {
        target: "/etc/systemd/system/demo.service",
        workingDirectory: "/srv/demo/current",
        command: "/srv/demo/current/bin/server",
        args: ["--config", "config/application.ini"],
      },
    );
  });
});
