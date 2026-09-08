import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, withTempDir } from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";
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
      mode: 0o600,
      variables: Object.freeze([]),
      format: "json" as const,
      secretReferences: Object.freeze(new Map()),
      onChange: "restart" as const,
    })
  );
  const management: AppManagementDefinition = Object.freeze({
    runAs: "deploy",
    configs,
    hooks: new Map(afterDeploy.length === 0 ? [] : [["after_deploy" as const, afterDeploy]]),
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
      runAs: "deploy",
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
}) {
  const events: string[] = [];
  const scopedRequests: { names: readonly string[]; path: string }[] = [];
  let publicationBatchSize = 0;
  let systemdStateReads = 0;
  const session = {
    acquireOperationLock(): Promise<{ id: string; app: string; target: string }> {
      events.push("lock");
      return Promise.resolve({ id: "lease", app: "demo", target: "node-a" });
    },
    releaseOperationLock(): Promise<void> {
      events.push("unlock");
      return Promise.resolve();
    },
    validateManagedIdentity(): Promise<{
      runAs: string;
      uid: number;
      sshUid: number;
      requiresSudo: boolean;
    }> {
      events.push("identity");
      return Promise.resolve({ runAs: "deploy", uid: 1000, sshUid: 1000, requiresSudo: false });
    },
    createScopedSecretCopy(
      request: { readonly names: readonly string[] },
    ): Promise<{ workspace: string; path: string; runAs: string }> {
      const path = `/tmp/sfo-deploy-managed-dv/secrets-${events.length}`;
      events.push("scoped-secrets");
      scopedRequests.push({ names: [...request.names], path });
      return Promise.resolve({ workspace: "/tmp/sfo-deploy-managed-dv", path, runAs: "deploy" });
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
      request: { readonly name: string; readonly updaterScript: string; readonly runAs?: string },
    ): Promise<{ name: string; workspace: string; path: string }> {
      assert(request.updaterScript.endsWith(REMOTE_CONFIG_UPDATER_BUNDLE_PATH));
      assertEquals(request.runAs, "deploy");
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
      if (argv[0] === "systemctl" && argv[1] === "is-enabled") {
        systemdStateReads += 1;
        if (options.initialUnitMissing && systemdStateReads === 1) {
          return Promise.resolve(commandResult(4, "not-found\n"));
        }
        return Promise.resolve(commandResult(0, "enabled\n"));
      }
      if (argv[0] === "systemctl" && argv[1] === "is-active") {
        systemdStateReads += 1;
        if (options.initialUnitMissing && systemdStateReads === 2) {
          return Promise.resolve(commandResult(4, "inactive\n"));
        }
        return Promise.resolve(commandResult(0, "active\n"));
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

Deno.test("dv/app-management: 两个候选先生成再单批发布，unchanged 仍提交且不误报 changed", async () => {
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
    assertEquals(remote.events.filter((event) => event.startsWith("candidate:")), [
      "candidate:alpha",
      "candidate:beta",
    ]);
    assert(remote.events.indexOf("candidate:beta") < remote.events.indexOf("publish"));
    assert(remote.events.indexOf("lock") < remote.events.indexOf("workspace"));
    assert(remote.events.indexOf("cleanup") < remote.events.indexOf("unlock"));
    assertEquals(remote.events.filter((event) => event === "scoped-secrets").length, 2);
    assertEquals(remote.events.filter((event) => event === "cleanup-secrets").length, 2);
    assert(remote.events.includes("commit:2"));
    assertEquals(remote.events.some((event) => event.startsWith("restore:")), false);
  });
});

Deno.test("dv/app-management: 发布后 hook 失败恢复整批配置且结果显式记录 recovery", async () => {
  await withTempDir(async (root) => {
    await Promise.all(
      ["alpha", "beta"].map((name) =>
        Deno.writeTextFile(join(root, `${name}.json`), '{"value":"fixed"}\n')
      ),
    );
    const hookPath = join(root, "after.ts");
    await Deno.writeTextFile(hookPath, "Deno.exit(19);\n");
    const hook = Object.freeze({
      source: hookPath,
      relativePath: "scripts/after.ts",
      permissions: Object.freeze({ run: Object.freeze([]), net: Object.freeze([]) }),
    });
    const remote = managedTransport({ changed: true, failHook: true });
    const result = await new DeploymentExecutor(remote.transport).execute(
      managedPlan(root, "deploy", [hook]),
    );
    assertEquals(result.steps[0].status, StepStatus.FAILED);
    assertEquals(
      result.steps[0].recovery,
      Object.freeze({
        attempted: true,
        succeeded: true,
        configAttempted: true,
        serviceAttempted: false,
      }),
    );
    assert(remote.events.indexOf("publish") < remote.events.indexOf("hook"));
    assert(remote.events.indexOf("hook") < remote.events.indexOf("restore:2"));
    assertEquals(remote.events.some((event) => event.startsWith("commit:")), false);
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
    const base = managedPlan(root, "deploy", [invocation]);
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
      management: Object.freeze({ ...base.steps[0].management!, configs }),
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
      ["ALPHA_SECRET"],
      ["BETA_SECRET"],
      ["HOOK_SECRET", "HOOK_FILE"],
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
      runAs: "deploy",
      management: Object.freeze({
        runAs: "deploy",
        configs: Object.freeze([]),
        service: Object.freeze({
          kind: "systemd" as const,
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
        hooks: new Map(),
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
