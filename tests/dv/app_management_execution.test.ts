import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "jsr:@std/path@1.1.6";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { PreflightError } from "../../src/errors.ts";
import { resolved, writeCluster } from "../_support/fixtures.ts";
import { loadCluster } from "../../src/config.ts";
import { buildPlan } from "../../src/planning.ts";
import {
  type DownloadProvider,
  DownloadProviderRegistry,
  type DownloadRequest,
  VerifiedArtifact,
} from "../../src/downloads.ts";
import { prepareExecution } from "../../src/execution.ts";
import { DeploymentExecutor } from "../../src/execution.ts";
import { PackageCache } from "../../src/package_cache.ts";
import { ProjectBindings } from "../../src/secrets.ts";
import type { BuiltDeploymentBundle } from "../../src/deployment_bundle.ts";
import {
  type ManagedConfigPublication,
  type ManagedConfigPublishRequest,
  REMOTE_CONFIG_UPDATER_BUNDLE_PATH,
  type StagedDeploymentBundle,
} from "../../src/remote_deployment.ts";
import { type CommandResult, commandResult, StepStatus } from "../../src/results.ts";
import type { RemoteSession, Transport } from "../../src/transport.ts";
import type {
  AppManagementDefinition,
  ExecutionPlan,
  ManagedConfigFile,
  PackageSpec,
  PlanStep,
  ScriptInvocation,
} from "../../src/types.ts";

class CountingProvider implements DownloadProvider {
  calls = 0;

  constructor(readonly bytes: Uint8Array) {}

  async fetch(request: DownloadRequest, destination: string): Promise<VerifiedArtifact> {
    this.calls += 1;
    await Deno.writeFile(destination, this.bytes);
    return new VerifiedArtifact(
      destination,
      request.hashAlgorithm,
      request.expectedHash,
      this.bytes.length,
    );
  }
}

Deno.test("dv/app-management: fetch 后执行准备只读 packageCache 且生成单一 bundle", async () => {
  await withTempDir(async (root) => {
    const packageBytes = gzipSync(new TextEncoder().encode("immutable app package\n"));
    const digest = createHash("sha256").update(packageBytes).digest("hex");
    const provider = new CountingProvider(packageBytes);
    const registry = new DownloadProviderRegistry({ fixture: provider });
    const cache = new PackageCache({ packagesDir: join(root, "packages"), registry });
    const spec: PackageSpec = Object.freeze({
      provider: "fixture",
      source: Object.freeze({ id: "app-v1" }),
      hashAlgorithm: "sha256",
      hashValue: digest,
    });
    await cache.fetch(spec, { kind: "app", name: "demo", version: "1", cluster: "demo" });
    assertEquals(provider.calls, 1);

    const scriptPath = join(root, "deploy.ts");
    await Deno.writeTextFile(scriptPath, "Deno.exit(0);\n");
    const invocation: ScriptInvocation = Object.freeze({
      source: scriptPath,
      relativePath: "scripts/deploy.ts",
      permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
    });
    const plan: ExecutionPlan = Object.freeze({
      schemaVersion: 4,
      cluster: "demo",
      requestedAction: "deploy",
      steps: Object.freeze([Object.freeze({
        id: "app:node-a/demo:deploy",
        machine: resolved("node-a"),
        kind: "app" as const,
        resource: "demo",
        action: "deploy",
        scripts: Object.freeze([invocation]),
        parameters: Object.freeze({ version: "1" }),
        package: spec,
        secretValues: Object.freeze([]),
        secretFiles: Object.freeze([]),
        templates: Object.freeze([]),
        deliveryInputs: Object.freeze({
          scripts: Object.freeze([invocation]),
          files: Object.freeze([]),
        }),
        dependsOn: Object.freeze([]),
      })]),
    });

    const prepared = await prepareExecution(plan, {
      packageCache: cache,
      downloadProviders: registry,
    });
    try {
      assertEquals(provider.calls, 1);
      const step = prepared.steps.get("app:node-a/demo:deploy");
      assert(step?.artifact !== undefined);
      assert(step.deliveryBundle !== undefined);
      assertEquals(
        step.deliveryBundle.manifest.entries.filter((entry) => entry.purpose === "package").length,
        1,
      );
      assertEquals(
        step.deliveryBundle.manifest.entries.filter((entry) => entry.purpose === "script").length,
        1,
      );
    } finally {
      await prepared.close();
    }
  });
});

function managedPlan(
  root: string,
  action: "configure" | "deploy",
  afterDeploy: readonly ScriptInvocation[] = [],
): ExecutionPlan {
  const configs: readonly ManagedConfigFile[] = ["alpha", "beta"].map((name) =>
    Object.freeze({
      name,
      relativePath: `templates/${name}.json`,
      source: join(root, `${name}.json`),
      target: `/etc/demo/${name}.json`,
      targetRoot: "absolute",
      mode: 0o600,
      variables: Object.freeze([]),
      format: "json" as const,
      secretReferences: Object.freeze(new Map()),
      onChange: "restart" as const,
    })
  );
  const management: AppManagementDefinition = Object.freeze({
    configs,
    configScripts: Object.freeze([]),
    manager: Object.freeze({
      kind: "service" as const,
      unit: "demo.service",
      tool: "systemctl" as const,
      enabled: true,
      daemonReload: true,
      onDeploy: "none" as const,
      timeoutMs: 30_000,
    }),
  });
  return Object.freeze({
    schemaVersion: 4,
    cluster: "demo",
    requestedAction: action,
    steps: Object.freeze([Object.freeze({
      id: `app:node-a/demo:${action}`,
      machine: resolved("node-a"),
      kind: "app" as const,
      resource: "demo",
      action,
      scripts: Object.freeze([]),
      parameters: Object.freeze({}),
      secretValues: Object.freeze([]),
      secretFiles: Object.freeze([]),
      templates: Object.freeze([]),
      management,
      deliveryInputs: Object.freeze({
        scripts: Object.freeze([...afterDeploy]),
        files: Object.freeze([]),
      }),
      dependsOn: Object.freeze([]),
    })]),
  });
}

function managedTransport(options: {
  changed: boolean;
  failHook?: boolean;
  commandOutput?: CommandResult;
  initialUnitMissing?: boolean;
  unitUserId?: string;
  unitUserExitCode?: number;
  failActiveAfterRestart?: boolean;
}) {
  const events: string[] = [];
  const scopedRequests: { names: readonly string[]; path: string }[] = [];
  let publicationBatchSize = 0;
  let systemdStateReads = 0;
  let restartSeen = false;
  let activeFailures = 0;
  const session = {
    acquireOperationLock(): Promise<{ id: string; app: string; target: string }> {
      events.push("lock");
      return Promise.resolve({ id: "lease", app: "demo", target: "node-a" });
    },
    releaseOperationLock(): Promise<void> {
      events.push("unlock");
      return Promise.resolve();
    },
    createScopedSecretCopy(
      request: { readonly names: readonly string[] },
    ): Promise<{ workspace: string; path: string }> {
      const path = `/tmp/sfo-deploy-managed-dv/secrets-${events.length}`;
      events.push("scoped-secrets");
      scopedRequests.push({ names: [...request.names], path });
      return Promise.resolve({ workspace: "/tmp/sfo-deploy-managed-dv", path });
    },
    cleanupScopedSecretCopy(): Promise<void> {
      events.push("cleanup-secrets");
      return Promise.resolve();
    },
    createWorkspace(): Promise<string> {
      events.push("workspace");
      return Promise.resolve("/tmp/sfo-deploy-managed-dv");
    },
    stageDeploymentBundle(bundle: BuiltDeploymentBundle): Promise<StagedDeploymentBundle> {
      events.push("stage");
      const root = "/tmp/sfo-deploy-managed-dv/root";
      const scripts = new Map<string, string>();
      const configSkeletons = new Map<string, string>();
      const configBindings = new Map<string, string>();
      for (const entry of bundle.manifest.entries) {
        if (entry.purpose === "script") {
          scripts.set(entry.path.slice("scripts/".length), `${root}/${entry.path}`);
        }
        if (entry.purpose === "config-skeleton") {
          configSkeletons.set(entry.path.slice("configs/".length), `${root}/${entry.path}`);
        }
        if (entry.purpose === "config-bindings") {
          configBindings.set(entry.path.slice("configs/".length), `${root}/${entry.path}`);
        }
      }
      return Promise.resolve(Object.freeze({
        workspace: "/tmp/sfo-deploy-managed-dv",
        root,
        manifestPath: `${root}/manifest.json`,
        scripts,
        configSkeletons,
        configBindings,
        files: new Map(),
        entries: bundle.manifest.entries,
        sha256: bundle.sha256,
        reused: false,
      }));
    },
    createManagedConfigCandidate(
      request: {
        readonly name: string;
        readonly updaterScript: string;
        readonly secretDir: string;
      },
    ): Promise<{ name: string; workspace: string; path: string }> {
      assert(request.updaterScript.endsWith(REMOTE_CONFIG_UPDATER_BUNDLE_PATH));
      assert(request.secretDir.startsWith("/tmp/sfo-deploy-managed-dv/secrets-"));
      events.push(`candidate:${request.name}`);
      return Promise.resolve({
        name: request.name,
        workspace: "/tmp/sfo-deploy-managed-dv",
        path: `/tmp/${request.name}.candidate`,
      });
    },
    publishManagedConfigs(
      requests: readonly ManagedConfigPublishRequest[],
    ): Promise<readonly ManagedConfigPublication[]> {
      publicationBatchSize = requests.length;
      events.push("publish");
      return Promise.resolve(requests.map((request) =>
        Object.freeze({
          name: request.candidate.name,
          workspace: request.candidate.workspace,
          target: request.target,
          changed: options.changed,
          existed: true,
          backupPath: `${request.candidate.workspace}/${request.candidate.name}.backup`,
        })
      ));
    },
    restoreManagedConfigs(publications: readonly ManagedConfigPublication[]): Promise<void> {
      events.push(`restore:${publications.length}`);
      return Promise.resolve();
    },
    commitManagedConfigs(publications: readonly ManagedConfigPublication[]): Promise<void> {
      events.push(`commit:${publications.length}`);
      return Promise.resolve();
    },
    exposeStepSecrets(): Promise<string> {
      events.push("secrets");
      return Promise.resolve("/tmp/sfo-deploy-managed-dv/secrets");
    },
    uploadFile(): Promise<void> {
      events.push("upload");
      return Promise.resolve();
    },
    run(argv: readonly string[]): Promise<CommandResult> {
      events.push(`run:${argv[0]}:${argv[1] ?? ""}`);
      if (
        argv[0] === "/usr/bin/cat" && argv[1] === "--" && argv[2] === "/etc/os-release"
      ) {
        return Promise.resolve(commandResult(0, 'ID=ubuntu\nVERSION_ID="22.04"\n'));
      }
      if (argv[0] === "id" && argv[1] === "-u") {
        return Promise.resolve(
          commandResult(
            options.unitUserExitCode ?? 0,
            options.unitUserId === undefined ? "" : `${options.unitUserId}\n`,
          ),
        );
      }
      if (argv[0] === "systemctl" && argv[1] === "is-enabled") {
        systemdStateReads += 1;
        if (options.initialUnitMissing && systemdStateReads === 1) {
          return Promise.resolve(commandResult(4, "not-found\n"));
        }
        return Promise.resolve(commandResult(0, "enabled\n"));
      }
      if (argv[0] === "systemctl" && argv[1] === "is-active") {
        systemdStateReads += 1;
        if (options.failActiveAfterRestart && restartSeen && activeFailures === 0) {
          activeFailures += 1;
          return Promise.resolve(commandResult(1, "inactive\n"));
        }
        if (options.initialUnitMissing && systemdStateReads === 2) {
          return Promise.resolve(commandResult(4, "inactive\n"));
        }
        return Promise.resolve(commandResult(0, "active\n"));
      }
      if (argv[0] === "systemctl" && argv[1] === "restart") {
        restartSeen = true;
      }
      return Promise.resolve(commandResult(0));
    },
    preflightPrivilege(): Promise<void> {
      events.push("privilege");
      return Promise.resolve();
    },
    preflightDeno(): Promise<CommandResult> {
      events.push("preflight");
      return Promise.resolve(commandResult(0));
    },
    executeDeno(): Promise<CommandResult> {
      events.push("hook");
      return Promise.resolve(
        options.commandOutput ?? commandResult(options.failHook ? 19 : 0),
      );
    },
    removeFile(): Promise<void> {
      events.push("remove-file");
      return Promise.resolve();
    },
    cleanupWorkspace(): Promise<void> {
      events.push("cleanup");
      return Promise.resolve();
    },
    close(): Promise<void> {
      events.push("close");
      return Promise.resolve();
    },
  } as unknown as RemoteSession;
  const transport = Object.freeze({ connect: () => Promise.resolve(session) }) as Transport;
  return { transport, events, scopedRequests, publicationBatchSize: () => publicationBatchSize };
}

Deno.test("dv/app-management: 无密钥配置由 SSH 创建候选并单批发布，无需 Deno", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const remote = managedTransport({ changed: false });
    const result = await new DeploymentExecutor(remote.transport).execute(
      managedPlan(root, "configure"),
    );
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
    assertEquals(result.steps[0].changed, false);
    assertEquals(remote.publicationBatchSize(), 2);
    assertEquals(remote.events.filter((event) => event.startsWith("candidate:")), []);
    assertEquals(remote.events.filter((event) => event === "preflight"), []);
    assertEquals(remote.events.filter((event) => event === "run:cp:--").length, 2);
    assert(remote.events.indexOf("run:cp:--") < remote.events.indexOf("publish"));
    assert(remote.events.indexOf("lock") < remote.events.indexOf("workspace"));
    assert(remote.events.indexOf("cleanup") < remote.events.indexOf("unlock"));
    assertEquals(remote.events.filter((event) => event === "scoped-secrets").length, 0);
    assertEquals(remote.events.filter((event) => event === "cleanup-secrets").length, 0);
    assert(remote.events.includes("commit:2"));
    assertEquals(remote.events.some((event) => event.startsWith("restore:")), false);
  });
});

Deno.test("dv/app-management: 每个配置与生命周期只获得声明秘密，清理后输出按值和文件内容脱敏", async () => {
  await withTempDir(async (root) => {
    const alpha = "alpha-secret-value";
    const beta = "beta-secret-value";
    const hook = "hook-secret-value";
    const fileValue = "file-secret-value";
    const secretFile = join(root, "hook.secret");
    await Deno.writeTextFile(secretFile, fileValue);
    await Deno.chmod(secretFile, 0o600);
    await Promise.all(
      [
        ["alpha", "ALPHA_SECRET"],
        ["beta", "BETA_SECRET"],
      ].map(([name, secret]) =>
        Deno.writeTextFile(join(root, `${name}.json`), `{"secret":"\${${secret}}"}`)
      ),
    );
    const hookPath = join(root, "after.ts");
    await Deno.writeTextFile(hookPath, "Deno.exit(0);\n");
    const invocation: ScriptInvocation = Object.freeze({
      source: hookPath,
      relativePath: "scripts/after.ts",
      permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
    });
    const base = managedPlan(root, "deploy");
    const configs = base.steps[0].management!.configs.map((config, index) =>
      Object.freeze({
        ...config,
        format: "json" as const,
        secretReferences: Object.freeze(
          new Map([
            [
              index === 0 ? "ALPHA_SECRET" : "BETA_SECRET",
              Object.freeze({ kind: "value" as const, valueType: "string" as const }),
            ],
          ]),
        ),
      })
    );
    const step = Object.freeze({
      ...base.steps[0],
      secretValues: Object.freeze(["ALPHA_SECRET", "BETA_SECRET", "HOOK_SECRET"]),
      secretFiles: Object.freeze(["HOOK_FILE"]),
      lifecycleSecretValues: Object.freeze(["HOOK_SECRET"]),
      lifecycleSecretFiles: Object.freeze(["HOOK_FILE"]),
      scripts: Object.freeze([invocation]),
      deliveryInputs: Object.freeze({
        scripts: Object.freeze([invocation]),
        files: Object.freeze([]),
      }),
      management: Object.freeze({
        ...base.steps[0].management!,
        configs,
        configScripts: Object.freeze([invocation]),
      }),
    });
    const plan: ExecutionPlan = Object.freeze({ ...base, steps: Object.freeze([step]) });
    const leaked = `${alpha} ${beta} ${hook} ${fileValue}`;
    const remote = managedTransport({
      changed: true,
      commandOutput: commandResult(0, leaked, leaked),
    });
    const bindings = new ProjectBindings({
      configSecrets: { ALPHA_SECRET: alpha, BETA_SECRET: beta, HOOK_SECRET: hook },
      fileSecrets: { HOOK_FILE: secretFile },
    });
    const result = await new DeploymentExecutor(remote.transport, { bindings }).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
    assertEquals(remote.scopedRequests.map((request) => request.names), [
      ["HOOK_SECRET", "HOOK_FILE"],
      ["ALPHA_SECRET"],
      ["BETA_SECRET"],
    ]);
    assertEquals(new Set(remote.scopedRequests.map((request) => request.path)).size, 3);
    assertEquals(remote.events.filter((event) => event === "cleanup-secrets").length, 3);
    for (const secret of [alpha, beta, hook, fileValue]) {
      assert(!result.steps[0].stdout.includes(secret));
      assert(!result.steps[0].stderr.includes(secret));
    }
  });
});

Deno.test("dv/app-management: redactor 无法构造时 stdout/stderr fail closed 为空", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const hookPath = join(root, "after.ts");
    await Deno.writeTextFile(hookPath, "Deno.exit(0);\n");
    const hook: ScriptInvocation = Object.freeze({
      source: hookPath,
      relativePath: "scripts/after.ts",
      permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
    });
    const base = managedPlan(root, "deploy", [hook]);
    const step = Object.freeze({
      ...base.steps[0],
      secretValues: Object.freeze(["MISSING_SECRET"]),
      lifecycleSecretValues: Object.freeze([]),
      lifecycleSecretFiles: Object.freeze([]),
    });
    const remote = managedTransport({
      changed: true,
      commandOutput: commandResult(0, "unsafe stdout", "unsafe stderr"),
    });
    const result = await new DeploymentExecutor(remote.transport).execute(
      Object.freeze({ ...base, steps: Object.freeze([step]) }),
    );
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
    assertEquals(result.steps[0].stdout, "");
    assertEquals(result.steps[0].stderr, "");
  });
});

function withSshUser(step: PlanStep, sshUser: string): PlanStep {
  return Object.freeze({
    ...step,
    machine: Object.freeze({
      ...step.machine,
      machine: Object.freeze({ ...step.machine.machine, sshUser }),
    }),
  });
}

function withGeneratedUnit(step: PlanStep, user?: string): PlanStep {
  const management = step.management;
  const manager = management?.manager;
  if (management === undefined || manager?.kind !== "service") {
    throw new Error("fixture expects a service manager");
  }
  return Object.freeze({
    ...step,
    management: Object.freeze({
      ...management,
      manager: Object.freeze({
        ...manager,
        unitConfig: Object.freeze({
          target: "/etc/systemd/system/demo.service",
          workingDirectory: "/srv/demo/current",
          command: "/srv/demo/current/bin/server",
          args: Object.freeze([] as string[]),
          ...(user === undefined ? {} : { user }),
        }),
      }),
    }),
  });
}

Deno.test("dv/app-management: legacy run_as/access_group plans are rejected before replay", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const remote = managedTransport({ changed: true });
    const base = managedPlan(root, "configure");
    const legacy: PlanStep = Object.freeze({
      ...base.steps[0],
      runAs: "deploy",
      management: Object.freeze({
        ...base.steps[0].management!,
        runAs: "deploy",
        accessGroup: "www-data",
      }),
    });
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze([legacy]),
    });
    await assertRejects(
      () => new DeploymentExecutor(remote.transport).execute(plan),
      PreflightError,
      "regenerate the plan",
    );
    assertEquals(remote.events.length, 0);
  });
});

Deno.test("dv/app-management: root SSH without an explicit unit user publishes the unit", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const remote = managedTransport({ changed: true });
    const base = managedPlan(root, "configure");
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze([withSshUser(withGeneratedUnit(base.steps[0]), "root")]),
    });
    const result = await new DeploymentExecutor(remote.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
    assert(!remote.events.includes("run:id:-u"));
    assert(remote.events.includes("publish"));
  });
});

Deno.test("dv/app-management: explicit root service user requires UID 0 before publication", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const base = managedPlan(root, "configure");
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze([withGeneratedUnit(base.steps[0], "root")]),
    });
    const accepted = managedTransport({ changed: true, unitUserId: "0" });
    const result = await new DeploymentExecutor(accepted.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
    assert(accepted.events.includes("run:id:-u"));
    assert(accepted.events.includes("publish"));

    for (const uid of ["1000", "00", ""]) {
      const rejected = managedTransport({ changed: true, unitUserId: uid });
      const failure = await new DeploymentExecutor(rejected.transport).execute(plan);
      assertEquals(failure.steps[0].status, StepStatus.FAILED);
      assertStringIncludes(failure.steps[0].message ?? "", "unexpected UID");
      assert(!rejected.events.includes("publish"));
    }
    const missing = managedTransport({ changed: true, unitUserExitCode: 1 });
    const failure = await new DeploymentExecutor(missing.transport).execute(plan);
    assertEquals(failure.steps[0].status, StepStatus.FAILED);
    assertStringIncludes(failure.steps[0].message ?? "", "does not exist");
    assert(!missing.events.includes("publish"));
  });
});

Deno.test("dv/app-management: explicit unit user is verified remotely before publication", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const remote = managedTransport({ changed: true, unitUserId: "1000" });
    const base = managedPlan(root, "configure");
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze([
        withSshUser(withGeneratedUnit(base.steps[0], "app"), "root"),
      ]),
    });
    const result = await new DeploymentExecutor(remote.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
    assert(remote.events.includes("run:id:-u"));
    assert(remote.events.includes("publish"));

    const rootUid = managedTransport({ changed: true, unitUserId: "0" });
    const rejected = await new DeploymentExecutor(rootUid.transport).execute(plan);
    assertEquals(rejected.steps[0].status, StepStatus.FAILED);
    assertStringIncludes(rejected.steps[0].message ?? "", "unexpected UID");
    assert(!rootUid.events.includes("publish"));
  });
});

Deno.test("dv/app-management: missing explicit unit user fails before publication", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const remote = managedTransport({ changed: true });
    const base = managedPlan(root, "configure");
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze([
        withSshUser(withGeneratedUnit(base.steps[0], "app"), "root"),
      ]),
    });
    const result = await new DeploymentExecutor(remote.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.FAILED);
    assertStringIncludes(result.steps[0].message ?? "", "unit user");
    assert(!remote.events.includes("publish"));
  });
});

Deno.test("dv/app-management: activate 发布 service unit 并触发 daemon-reload/restart", async () => {
  const remote = managedTransport({ changed: true, initialUnitMissing: true });
  const plan: ExecutionPlan = Object.freeze({
    schemaVersion: 4,
    cluster: "demo",
    requestedAction: "deploy",
    steps: Object.freeze([Object.freeze({
      id: "app:node-a/demo:activate",
      machine: resolved("node-a"),
      kind: "app" as const,
      resource: "demo",
      action: "activate",
      scripts: Object.freeze([]),
      parameters: Object.freeze({}),
      secretValues: Object.freeze([]),
      secretFiles: Object.freeze([]),
      templates: Object.freeze([]),
      management: Object.freeze({
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
          unitConfig: Object.freeze({
            target: "/etc/systemd/system/demo.service",
            workingDirectory: "/srv/demo/current",
            command: "/srv/demo/current/bin/server",
            args: Object.freeze(["--config", "config/application.ini"]),
          }),
        }),
      }),
      deliveryInputs: Object.freeze({
        scripts: Object.freeze([]),
        files: Object.freeze([]),
      }),
      dependsOn: Object.freeze([]),
    })]),
  });
  const result = await new DeploymentExecutor(remote.transport).execute(plan);
  assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
  assertEquals(result.steps[0].changed, true);
  assertEquals(result.steps[0].service?.action, "restart");
  assertEquals(result.steps[0].service?.daemonReloaded, true);
  assertEquals(result.steps[0].service?.enableAction, "enable");
  assertEquals(result.steps[0].service?.before, { enabled: false, active: false });
  assertEquals(result.steps[0].service?.after, { enabled: true, active: true });
  assertEquals(remote.publicationBatchSize(), 1);
  assertEquals(remote.events.some((event) => event.startsWith("candidate:")), false);
  assert(remote.events.includes("run:cp:--"));
});

function decoupledPlan(enabledExplicit: boolean): ExecutionPlan {
  return Object.freeze({
    schemaVersion: 4,
    cluster: "demo",
    requestedAction: "deploy",
    steps: Object.freeze([Object.freeze({
      id: "app:node-a/demo:activate",
      machine: resolved("node-a"),
      kind: "app" as const,
      resource: "demo",
      action: "activate",
      scripts: Object.freeze([]),
      parameters: Object.freeze({}),
      secretValues: Object.freeze([]),
      secretFiles: Object.freeze([]),
      templates: Object.freeze([]),
      management: Object.freeze({
        configs: Object.freeze([]),
        configScripts: Object.freeze([]),
        manager: Object.freeze({
          kind: "service" as const,
          tool: "systemctl" as const,
          unit: "demo.service",
          enabled: true,
          enabledExplicit,
          daemonReload: false,
          onDeploy: "none" as const,
          timeoutMs: 30_000,
          unitConfig: Object.freeze({
            target: "/etc/systemd/system/demo.service",
            workingDirectory: "/srv/demo/current",
            command: "/srv/demo/current/bin/server",
            args: Object.freeze([]),
          }),
        }),
      }),
      deliveryInputs: Object.freeze({
        scripts: Object.freeze([]),
        files: Object.freeze([]),
      }),
      dependsOn: Object.freeze([]),
    })]),
  });
}

Deno.test("dv/app-management: implicit enabled does not force a start or restart", async () => {
  const remote = managedTransport({ changed: false });
  const result = await new DeploymentExecutor(remote.transport).execute(decoupledPlan(false));
  assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
  assertEquals(result.steps[0].service?.action, "none");
  assertEquals(
    remote.events.some((event) => event.startsWith("run:systemctl:start")),
    false,
  );
  assertEquals(
    remote.events.some((event) => event.startsWith("run:systemctl:restart")),
    false,
  );
});

Deno.test("dv/110: deploy --no-activate suppresses service convergence from the pre-stage configure", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const base = managedPlan(root, "configure");
    const configure = base.steps[0];
    const stageOnly: PlanStep = Object.freeze({
      ...configure,
      id: "app:node-a/demo:stage",
      action: "stage",
      deployment: Object.freeze({ kind: "versioned" as const }),
      installDirectory: undefined,
      dependsOn: Object.freeze([configure.id]),
    });
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      requestedAction: "deploy",
      steps: Object.freeze([configure, stageOnly]),
    });
    const remote = managedTransport({ changed: true });
    const result = await new DeploymentExecutor(remote.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED, JSON.stringify(result.steps));
    // F3：前置 configure 不再发布受管配置，发布与提交延迟到 stage 事务。
    assertEquals(result.steps[0].changed, false);
    assertEquals(remote.events.includes("publish"), false, JSON.stringify(remote.events));
    assertEquals(
      remote.events.some((event) =>
        event.startsWith("run:systemctl:restart") ||
        event.startsWith("run:systemctl:start") ||
        event.startsWith("run:systemctl:is-")
      ),
      false,
      JSON.stringify(remote.events),
    );
  });
});

Deno.test("dv/110: standalone configure still converges the service manager", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const remote = managedTransport({ changed: true });
    const result = await new DeploymentExecutor(remote.transport).execute(
      managedPlan(root, "configure"),
    );
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED);
    assert(
      remote.events.some((event) => event === "run:systemctl:restart"),
      JSON.stringify(remote.events),
    );
  });
});

async function packagelessCluster(root: string): Promise<string> {
  const directory = await writeCluster(root);
  await Deno.mkdir(join(directory, "apps", "config", "templates"), { recursive: true });
  await Deno.writeTextFile(
    join(directory, "apps", "config", "templates", "settings.json"),
    '{"value":"fixed"}\n',
  );
  await Deno.writeTextFile(
    join(directory, "apps", "config", "app.yaml"),
    `schema_version: 1\nname: config\npackageless: true\nconfigs:\n  - kind: file\n    source: templates/settings.json\n    target: /etc/config/settings.json\n    format: json\n    on_change: restart\nmanagement:\n  kind: service\n  name: config.service\n  tool: systemctl\n`,
  );
  await Deno.writeTextFile(
    join(directory, "cluster.yaml"),
    (await Deno.readTextFile(join(directory, "cluster.yaml"))).replace(
      "apps:\n  demo: [node-a]",
      "apps:\n  demo: [node-a]\n  config: [node-a]",
    ),
  );
  return directory;
}

Deno.test("dv/118: packageless deploy --no-activate publishes configs without service convergence", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await packagelessCluster(root));
    const plan = buildPlan(cluster, { action: "deploy", apps: ["config"], activate: false });
    assertEquals(plan.activate, false);
    assertEquals(plan.steps.map((step) => step.action), ["configure"]);
    const remote = managedTransport({ changed: true });
    const result = await new DeploymentExecutor(remote.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED, JSON.stringify(result.steps));
    // 配置仍发布并提交，但没有任何服务状态读取或收敛命令。
    assert(remote.events.includes("publish"), JSON.stringify(remote.events));
    assert(remote.events.includes("commit:1"), JSON.stringify(remote.events));
    assertEquals(result.steps[0].service, undefined);
    assertStringIncludes(result.steps[0].message ?? "", "service activation skipped");
    assertEquals(
      remote.events.some((event) => event.startsWith("run:systemctl")),
      false,
      JSON.stringify(remote.events),
    );
  });
});

Deno.test("dv/118: the same packageless deploy still converges the service when activating", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await packagelessCluster(root));
    const plan = buildPlan(cluster, { action: "deploy", apps: ["config"] });
    assertEquals(plan.activate, undefined);
    const remote = managedTransport({ changed: true });
    const result = await new DeploymentExecutor(remote.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED, JSON.stringify(result.steps));
    assertEquals(result.steps[0].service?.action, "restart");
    assert(
      remote.events.some((event) => event === "run:systemctl:restart"),
      JSON.stringify(remote.events),
    );
  });
});

Deno.test("dv/115: packageless 部署状态查询失败后强制重启以采用旧配置", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const base = managedPlan(root, "deploy");
    const step = base.steps[0];
    const management = Object.freeze({
      ...step.management!,
      manager: Object.freeze({ ...step.management!.manager!, onDeploy: "restart" as const }),
    });
    const plan: ExecutionPlan = Object.freeze({
      ...base,
      steps: Object.freeze([Object.freeze({ ...step, management })]),
    });
    const remote = managedTransport({ changed: true, failActiveAfterRestart: true });
    const result = await new DeploymentExecutor(remote.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.FAILED, JSON.stringify(result.steps));
    assert(remote.events.includes("restore:2"), JSON.stringify(remote.events));
    assertEquals(
      remote.events.filter((event) => event === "run:systemctl:restart").length,
      2,
      JSON.stringify(remote.events),
    );
  });
});

Deno.test("dv/117: config-only app publishes configs and runs config script without service actions", async () => {
  await withTempDir(async (root) => {
    await Deno.writeTextFile(join(root, "config.json"), '{"value":"fixed"}\n');
    const scriptPath = join(root, "configure.ts");
    await Deno.writeTextFile(scriptPath, "Deno.exit(0);\n");
    const invocation: ScriptInvocation = Object.freeze({
      source: scriptPath,
      relativePath: "scripts/configure.ts",
      permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
    });
    const config: ManagedConfigFile = Object.freeze({
      name: "file-0",
      relativePath: "templates/config.json",
      source: join(root, "config.json"),
      target: "/etc/demo/config.json",
      targetRoot: "absolute",
      mode: 0o600,
      variables: Object.freeze([]),
      format: "json",
      secretReferences: Object.freeze(new Map()),
      onChange: "none",
    });
    const management: AppManagementDefinition = Object.freeze({
      configs: Object.freeze([config]),
      configScripts: Object.freeze([invocation]),
      manager: undefined,
    });
    const plan: ExecutionPlan = Object.freeze({
      schemaVersion: 4,
      cluster: "demo",
      requestedAction: "deploy",
      steps: Object.freeze([Object.freeze({
        id: "app:node-a/demo:configure",
        machine: resolved("node-a"),
        kind: "app" as const,
        resource: "demo",
        action: "configure",
        scripts: Object.freeze([invocation]),
        parameters: Object.freeze({}),
        secretValues: Object.freeze([]),
        secretFiles: Object.freeze([]),
        templates: Object.freeze([]),
        management,
        deliveryInputs: Object.freeze({
          scripts: Object.freeze([invocation]),
          files: Object.freeze([]),
        }),
        dependsOn: Object.freeze([]),
      })]),
    });
    const remote = managedTransport({ changed: true });
    const result = await new DeploymentExecutor(remote.transport).execute(plan);
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED, JSON.stringify(result.steps));
    assert(remote.events.includes("hook"), JSON.stringify(remote.events));
    assert(remote.events.includes("run:cp:--"), JSON.stringify(remote.events));
    assert(remote.events.includes("publish"), JSON.stringify(remote.events));
    assert(remote.events.includes("commit:1"), JSON.stringify(remote.events));
    assertEquals(
      remote.events.some((event) => event.startsWith("run:systemctl")),
      false,
      JSON.stringify(remote.events),
    );
  });
});
