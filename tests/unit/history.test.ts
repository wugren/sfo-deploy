import { join } from "jsr:@std/path@1.1.6";
import {
  assert,
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

Deno.test("unit/history: non-activating deploy plans persist and decode the optional activate key", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    await Deno.mkdir(cluster, { recursive: true });
    const source = join(cluster, "action.ts");
    await Deno.writeTextFile(source, "Deno.exit(0);\n");

    async function archivePlan(
      plan: ExecutionPlan,
    ): Promise<{ snapshot: string; raw: Record<string, unknown> }> {
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
      const snapshot = join(store.root, releaseId, "snapshot");
      return {
        snapshot,
        raw: JSON.parse(await Deno.readTextFile(join(snapshot, "actual-plan.json"))),
      };
    }

    const base = makePlan();
    const withScripts = {
      ...base,
      steps: Object.freeze(base.steps.map((step) =>
        Object.freeze({
          ...step,
          scripts: Object.freeze(step.scripts.map((item) => Object.freeze({ ...item, source }))),
        })
      )),
    };
    const nonActivating: ExecutionPlan = Object.freeze({ ...withScripts, activate: false });
    const staged = await archivePlan(nonActivating);
    assertEquals(staged.raw.activate, false);
    const decoded = await __internal.decodePlan(
      staged.raw,
      staged.snapshot,
      cluster,
      importer,
    );
    assertEquals(decoded.activate, false);

    // 旧快照（无该键）解码为激活语义
    const legacy = structuredClone(staged.raw);
    delete legacy.activate;
    const legacyDecoded = await __internal.decodePlan(legacy, staged.snapshot, cluster, importer);
    assertEquals(legacyDecoded.activate, undefined);

    // 激活计划不写出该键，快照内容与现状一致
    const activating = await archivePlan(Object.freeze({ ...withScripts }));
    assertEquals("activate" in activating.raw, false);

    // 非布尔值 fail-closed
    const invalid = structuredClone(staged.raw);
    invalid.activate = "yes";
    const error = await assertRejects(
      () => __internal.decodePlan(invalid, staged.snapshot, cluster, importer),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "activate must be a boolean");
  });
});

Deno.test("unit/history: new writes use v4 and Deno v2/v3 snapshots remain readable", async () => {
  await withTempDir(async (root) => {
    const { snapshot } = await archived(root);
    const current = JSON.parse(await Deno.readTextFile(join(snapshot, "actual-plan.json")));
    assertEquals(current.schema_version, 4);
    assertEquals(current.steps[0].management, null);
    assertEquals(current.steps[0].run_as, null);
    assertEquals(current.steps[0].access_group, null);
    assertEquals(current.steps[0].mode, null);
    assertEquals(current.steps[0].lifecycle_secret_values, []);
    assertEquals(current.steps[0].lifecycle_secret_files, []);
    assertEquals(current.steps[0].scripts[0].permissions.read, []);
    assertEquals(current.steps[0].scripts[0].permissions.write, []);
    assertEquals(current.steps[0].machine.definition.enable_deno, true);
    const currentDecoded = await __internal.decodePlan(
      current,
      snapshot,
      join(root, "demo"),
      importer,
    );
    assertEquals(currentDecoded.schemaVersion, 4);
    assertEquals(currentDecoded.steps[0].machine.machine.enableDeno, true);

    const disabled = structuredClone(current);
    disabled.steps[0].machine.definition.enable_deno = false;
    const disabledDecoded = await __internal.decodePlan(
      disabled,
      snapshot,
      join(root, "demo"),
      importer,
    );
    assertEquals(disabledDecoded.steps[0].machine.machine.enableDeno, false);

    const priorV4 = structuredClone(current);
    delete priorV4.steps[0].machine.definition.enable_deno;
    const priorDecoded = await __internal.decodePlan(
      priorV4,
      snapshot,
      join(root, "demo"),
      importer,
    );
    assertEquals(priorDecoded.steps[0].machine.machine.enableDeno, true);

    const invalidPolicy = structuredClone(current);
    invalidPolicy.steps[0].machine.definition.enable_deno = "false";
    await assertRejects(
      () => __internal.decodePlan(invalidPolicy, snapshot, join(root, "demo"), importer),
      ConfigurationError,
      "machine.enable_deno must be a boolean",
    );

    const v3 = structuredClone(priorV4);
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
      delete step.environment_install;
      delete step.environment_manager;
      delete step.run_as;
      delete step.access_group;
      delete step.mode;
      delete step.lifecycle_secret_values;
      delete step.lifecycle_secret_files;
    }
    const decodedV3 = await __internal.decodePlan(v3, snapshot, join(root, "demo"), importer);
    assertEquals(decodedV3.schemaVersion, 3);
    assertEquals(decodedV3.steps[0].machine.machine.scriptRuntime.kind, "deno");

    const v2 = structuredClone(v3);
    v2.schema_version = 2;
    for (const step of v2.steps) delete step.machine.definition.enable_deno;
    const decodedV2 = await __internal.decodePlan(v2, snapshot, join(root, "demo"), importer);
    assertEquals(decodedV2.steps.length, current.steps.length);

    const v1 = structuredClone(v3);
    v1.schema_version = 1;
    const v1Error = await assertRejects(
      () => __internal.decodePlan(v1, snapshot, join(root, "demo"), importer),
      ConfigurationError,
    );
    assertStringIncludes(
      v1Error.message,
      "execution-plan v1 Python snapshots are no longer supported",
    );
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
    assertStringIncludes(error.message, "integrity failed");
    const duplicate = join(root, "duplicate.json");
    await Deno.writeTextFile(duplicate, '{"a":1,"a":2}\n');
    await assertRejects(
      () => __internal.readJson(duplicate, 1024),
      ConfigurationError,
      "duplicate key",
    );
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
      "already running for this cluster",
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

Deno.test("unit/history: rollback keeps script-manager restart but drops service restart", () => {
  const build = (kind: "script" | "service"): ExecutionPlan => {
    const base = makePlan();
    const [configure, deploy] = base.steps;
    const invocation = deploy.scripts[0];
    const manager = kind === "script"
      ? Object.freeze({
        kind: "script" as const,
        start: invocation,
        stop: invocation,
        restart: invocation,
      })
      : Object.freeze({
        kind: "service" as const,
        unit: "demo.service",
        tool: "systemctl" as const,
        daemonReload: false,
        onDeploy: "restart" as const,
        timeoutMs: 1_000,
      });
    const management = Object.freeze({
      configs: Object.freeze([]),
      configScripts: Object.freeze([]),
      manager,
    });
    const managed = (
      id: string,
      action: "stage" | "activate" | "restart",
      dependsOn: readonly string[],
    ) =>
      Object.freeze({
        ...deploy,
        id,
        action,
        dependsOn: Object.freeze([...dependsOn]),
        management,
      });
    return Object.freeze({
      ...base,
      steps: Object.freeze([
        configure,
        managed("app:node-a/demo:stage", "stage", ["app:node-a/demo:configure"]),
        managed("app:node-a/demo:activate", "activate", ["app:node-a/demo:stage"]),
        managed("app:node-a/demo:restart", "restart", ["app:node-a/demo:activate"]),
      ]),
    });
  };
  assertEquals(
    deriveRollbackPlan(build("script")).steps.map((step) => step.action),
    ["configure", "stage", "activate", "restart"],
  );
  assertEquals(
    deriveRollbackPlan(build("service")).steps.map((step) => step.action),
    ["configure", "stage", "activate"],
  );
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
                read: Object.freeze(["/etc/demo/config.json"] as string[]),
                write: Object.freeze(["/srv/demo/state"] as string[]),
              }),
            })])
            : undefined,
          ...(step.action === "deploy"
            ? {
              mode: "0644",
              lifecycleSecretValues: Object.freeze([] as string[]),
              lifecycleSecretFiles: Object.freeze([] as string[]),
              management: Object.freeze({
                configs: Object.freeze([]),
                configScripts: Object.freeze([]),
                manager: Object.freeze({
                  kind: "service" as const,
                  tool: "systemctl" as const,
                  unit: "demo.service",
                  daemonReload: false,
                  onDeploy: "restart" as const,
                  timeoutMs: 30_000,
                }),
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
    assertEquals(deployStep?.bundleScripts?.[0].permissions.read, ["/etc/demo/config.json"]);
    assertEquals(deployStep?.bundleScripts?.[0].permissions.write, ["/srv/demo/state"]);
    assertEquals(deployStep?.mode, "0644");
    assertEquals(deployStep?.runAs, undefined);
    assertEquals(deployStep?.management?.runAs, undefined);
    assertEquals(deployStep?.lifecycleSecretValues, []);
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
                    target: "/srv/demo/latest/resources/application.json",
                    targetRoot: "current",
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
                configScripts: Object.freeze([]),
                manager: undefined,
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
    const encodedConfig = current.steps.find((step: { action: string }) => step.action === "deploy")
      .management.configs[0];
    assertEquals(encodedConfig.target_root, "current");
    assertEquals(
      decoded.steps.find((step) => step.action === "deploy")?.management?.configs[0]?.targetRoot,
      "current",
    );
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
              lifecycleSecretValues: Object.freeze([] as string[]),
              lifecycleSecretFiles: Object.freeze([] as string[]),
              management: Object.freeze({
                configs: Object.freeze([]),
                configScripts: Object.freeze([]),
                manager: Object.freeze({
                  kind: "service" as const,
                  tool: "systemctl" as const,
                  unit: "demo.service",
                  daemonReload: true,
                  onDeploy: "restart" as const,
                  timeoutMs: 30_000,
                  unitConfig: Object.freeze({
                    target: "/etc/systemd/system/demo.service",
                    workingDirectory: "/srv/demo/current",
                    command: "/srv/demo/current/bin/server",
                    args: Object.freeze(["--config", "config/application.ini"]),
                    user: "deploy",
                    restartPolicy: "on-failure" as const,
                    restartSec: 5,
                    startLimitIntervalSec: 30,
                    startLimitBurst: 5,
                  }),
                }),
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
      .management.manager.unit_config;
    assertEquals(encoded, {
      target: "/etc/systemd/system/demo.service",
      user: "deploy",
      working_directory: "/srv/demo/current",
      command: "/srv/demo/current/bin/server",
      args: ["--config", "config/application.ini"],
      restart_policy: "on-failure",
      restart_sec: 5,
      start_limit_interval_sec: 30,
      start_limit_burst: 5,
    });
    const decoded = await __internal.decodePlan(current, snapshot, cluster, importer);
    const service = decoded.steps.find((step) => step.action === "deploy")?.management?.manager;
    assert(service?.kind === "service");
    assertEquals(service.unitConfig, {
      target: "/etc/systemd/system/demo.service",
      user: "deploy",
      workingDirectory: "/srv/demo/current",
      command: "/srv/demo/current/bin/server",
      args: ["--config", "config/application.ini"],
      restartPolicy: "on-failure",
      restartSec: 5,
      startLimitIntervalSec: 30,
      startLimitBurst: 5,
    });
    const legacy = JSON.parse(JSON.stringify(current));
    const deployStep = legacy.steps.find((step: { action: string }) => step.action === "deploy");
    for (
      const key of [
        "restart_policy",
        "restart_sec",
        "start_limit_interval_sec",
        "start_limit_burst",
      ]
    ) delete deployStep.management.manager.unit_config[key];
    const legacyDecoded = await __internal.decodePlan(legacy, snapshot, cluster, importer);
    const legacyService = legacyDecoded.steps.find((step) => step.action === "deploy")
      ?.management?.manager;
    assert(legacyService?.kind === "service");
    assertEquals(legacyService.unitConfig?.restartPolicy, undefined);
    assertEquals(legacyService.unitConfig?.restartSec, undefined);
    assertEquals(legacyService.unitConfig?.startLimitIntervalSec, undefined);
    assertEquals(legacyService.unitConfig?.startLimitBurst, undefined);
  });
});

Deno.test("unit/history: v4 codec round-trips service enabled_explicit", async () => {
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
              lifecycleSecretValues: Object.freeze([] as string[]),
              lifecycleSecretFiles: Object.freeze([] as string[]),
              management: Object.freeze({
                configs: Object.freeze([]),
                configScripts: Object.freeze([]),
                manager: Object.freeze({
                  kind: "service" as const,
                  tool: "systemctl" as const,
                  unit: "demo.service",
                  enabled: true,
                  enabledExplicit: true,
                  daemonReload: false,
                  onDeploy: "none" as const,
                  timeoutMs: 30_000,
                }),
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
    const manager = current.steps.find((step: { action: string }) => step.action === "deploy")
      .management.manager;
    assertEquals(manager.enabled, true);
    assertEquals(manager.enabled_explicit, true);
    const decoded = await __internal.decodePlan(current, snapshot, cluster, importer);
    const service = decoded.steps.find((step) => step.action === "deploy")?.management?.manager;
    assert(service?.kind === "service");
    assertEquals(service.enabled, true);
    assertEquals(service.enabledExplicit, true);

    const legacy = JSON.parse(JSON.stringify(current));
    const legacyManager = legacy.steps.find((step: { action: string }) => step.action === "deploy")
      .management.manager;
    delete legacyManager.enabled_explicit;
    legacyManager.enabled = null;
    const legacyDecoded = await __internal.decodePlan(legacy, snapshot, cluster, importer);
    const legacyService = legacyDecoded.steps.find((step) => step.action === "deploy")
      ?.management?.manager;
    assert(legacyService?.kind === "service");
    assertEquals(legacyService.enabled, undefined);
    assertEquals(legacyService.enabledExplicit, false);
  });
});

Deno.test("unit/history: v4 codec round-trips nginx raw config format", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    await Deno.mkdir(cluster);
    const source = join(cluster, "action.ts");
    const template = join(cluster, "jx-web.conf");
    await Deno.writeTextFile(source, "Deno.exit(0);\n");
    await Deno.writeTextFile(template, "server { listen 80; }\n");
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
              secretValues: Object.freeze([]),
              secretFiles: Object.freeze([]),
              lifecycleSecretValues: Object.freeze([]),
              lifecycleSecretFiles: Object.freeze([]),
              management: Object.freeze({
                runAs: "deploy",
                configs: Object.freeze([
                  Object.freeze({
                    name: "jx-web",
                    relativePath: "jx-web.conf",
                    source: template,
                    target: "/etc/nginx/conf.d/jx-web.conf",
                    targetRoot: "absolute",
                    owner: undefined,
                    group: undefined,
                    mode: 0o644,
                    variables: Object.freeze([]),
                    format: "nginx" as const,
                    secretReferences: Object.freeze(new Map()),
                    validator: undefined,
                    onChange: "reload" as const,
                  }),
                ]),
                configScripts: Object.freeze([]),
                manager: undefined,
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
    const encoded = JSON.parse(await Deno.readTextFile(join(snapshot, "actual-plan.json")));
    const config = encoded.steps.find((step: { action: string }) => step.action === "deploy")
      .management.configs[0];
    assertEquals(config.format, "nginx");
    const decoded = await __internal.decodePlan(encoded, snapshot, cluster, importer);
    assertEquals(
      decoded.steps.find((step) => step.action === "deploy")?.management?.configs[0]?.format,
      "nginx",
    );
  });
});

Deno.test("unit/history: v4 codec round-trips access_group and legacy snapshots stay readable", async () => {
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
              installDirectory: "/srv/demo",
              deployment: Object.freeze({ kind: "versioned" as const }),
              lifecycleSecretValues: Object.freeze([] as string[]),
              lifecycleSecretFiles: Object.freeze([] as string[]),
              management: Object.freeze({
                runAs: "deploy",
                accessGroup: "www-data",
                configs: Object.freeze([]),
                configScripts: Object.freeze([]),
                manager: undefined,
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
    const deployStep = current.steps.find((step: { action: string }) => step.action === "deploy");
    assertEquals(deployStep.access_group, "www-data");
    const decoded = await __internal.decodePlan(current, snapshot, cluster, importer);
    assertEquals(
      decoded.steps.find((step) => step.action === "deploy")?.management?.accessGroup,
      "www-data",
    );

    const legacy = JSON.parse(JSON.stringify(current));
    delete legacy.steps.find((step: { action: string }) => step.action === "deploy").access_group;
    const legacyDecoded = await __internal.decodePlan(legacy, snapshot, cluster, importer);
    assertEquals(
      legacyDecoded.steps.find((step) => step.action === "deploy")?.management?.accessGroup,
      undefined,
    );

    const invalid = JSON.parse(JSON.stringify(current));
    invalid.steps.find((step: { action: string }) => step.action === "deploy").access_group =
      "root";
    const error = await assertRejects(
      () => __internal.decodePlan(invalid, snapshot, cluster, importer),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "access_group must be a canonical non-root Linux group");
  });
});

Deno.test("unit/history: manager-less management with configs round-trips plan snapshots (117)", async () => {
  await withTempDir(async (root) => {
    const cluster = join(root, "demo");
    await Deno.mkdir(cluster, { recursive: true });
    const scriptSource = join(cluster, "action.ts");
    const configSource = join(cluster, "config.json");
    await Deno.writeTextFile(scriptSource, "Deno.exit(0);\n");
    await Deno.writeTextFile(configSource, '{"value":"fixed"}\n');
    const base = makePlan();
    const step = base.steps[0];
    const script = Object.freeze({ ...step.scripts[0], source: scriptSource });
    const config = Object.freeze({
      name: "file-0",
      relativePath: "templates/config.json",
      source: configSource,
      target: "/etc/demo/config.json",
      targetRoot: "absolute" as const,
      mode: 0o600,
      variables: Object.freeze([]),
      format: "json" as const,
      secretReferences: Object.freeze(new Map()),
      onChange: "none" as const,
    });
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze([Object.freeze({
        ...step,
        scripts: Object.freeze([script]),
        deliveryInputs: Object.freeze({
          scripts: Object.freeze([script]),
          files: Object.freeze([]),
        }),
        lifecycleSecretValues: Object.freeze([] as string[]),
        lifecycleSecretFiles: Object.freeze([] as string[]),
        management: Object.freeze({
          configs: Object.freeze([config]),
          configScripts: Object.freeze([script]),
          manager: undefined,
        }),
      })]),
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
    const snapshot = join(store.root, releaseId, "snapshot");
    const persisted = JSON.parse(await Deno.readTextFile(join(snapshot, "actual-plan.json")));
    assertEquals(persisted.steps[0].management.manager, null);
    assertEquals(persisted.steps[0].management.configs.length, 1);
    const decoded = await __internal.decodePlan(persisted, snapshot, cluster, importer);
    const management = decoded.steps[0].management;
    assertEquals(management?.configs.length, 1);
    assertEquals(management?.configScripts.length, 1);
    assertEquals(management?.manager, undefined);
  });
});
