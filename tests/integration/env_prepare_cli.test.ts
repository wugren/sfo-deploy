import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "jsr:@std/path@1.1.6";
import { writeCluster } from "../_support/fixtures.ts";
import { CLI_ACTIONS, run } from "../../src/mod.ts";
import type { DeploymentResult } from "../../src/mod.ts";
import { commandResult } from "../../src/results.ts";
import type {
  DeploySecretResult,
  RemoteRunOptions,
  RemoteSecretState,
  RemoteSession,
  Transport,
} from "../../src/transport.ts";
import type { CommandResult } from "../../src/results.ts";
import type { ResolvedMachine, ScriptPermissions } from "../../src/types.ts";
import type { BuiltDeploymentBundle } from "../../src/deployment_bundle.ts";
import type { StagedDeploymentBundle } from "../../src/remote_deployment.ts";
import {
  type DownloadProvider,
  DownloadProviderRegistry,
  type ReleaseSourceCodec,
  VerifiedArtifact,
} from "../../src/downloads.ts";

class IntegrationSession implements RemoteSession {
  readonly executed: string[] = [];
  readonly environmentVersions = new Map<string, string | undefined>();
  closed = false;

  acquireOperationLock(request: { readonly app: string; readonly target: string }): Promise<{
    readonly id: string;
    readonly app: string;
    readonly target: string;
  }> {
    return Promise.resolve(Object.freeze({
      id: "integration-lease",
      app: request.app,
      target: request.target,
    }));
  }

  releaseOperationLock(): Promise<void> {
    return Promise.resolve();
  }

  validateManagedIdentity(runAs: string): Promise<{
    readonly runAs: string;
    readonly uid: number;
    readonly sshUid: number;
    readonly requiresSudo: boolean;
  }> {
    return Promise.resolve(Object.freeze({
      runAs,
      uid: 1000,
      sshUid: 1000,
      requiresSudo: false,
    }));
  }

  createScopedSecretCopy(
    request: {
      readonly workspace: string;
      readonly sourceDirectory: string;
      readonly names: readonly string[];
      readonly runAs: string;
    },
  ): Promise<{ readonly workspace: string; readonly path: string; readonly runAs: string }> {
    return Promise.resolve(Object.freeze({
      workspace: request.workspace,
      path: `${request.workspace}/consumer-secrets-integration`,
      runAs: request.runAs,
    }));
  }

  cleanupScopedSecretCopy(): Promise<void> {
    return Promise.resolve();
  }

  extractAppPackage(
    request: {
      readonly workspace: string;
      readonly packagePath: string;
      readonly runAs: string;
    },
  ): Promise<{
    readonly workspace: string;
    readonly root: string;
    readonly packagePath: string;
    readonly memberCount: number;
    readonly expandedBytes: number;
  }> {
    return Promise.resolve(Object.freeze({
      workspace: request.workspace,
      root: `${request.workspace}/app-package`,
      packagePath: request.packagePath,
      memberCount: 1,
      expandedBytes: 0,
    }));
  }

  createWorkspace(): Promise<string> {
    return Promise.resolve("/tmp/sfo-deploy-integration");
  }
  stageDeploymentBundle(bundle: BuiltDeploymentBundle): Promise<StagedDeploymentBundle> {
    const root = "/tmp/sfo-deploy-integration/deployment";
    const scripts = new Map<string, string>();
    let packagePath: string | undefined;
    for (const entry of bundle.manifest.entries) {
      if (entry.purpose === "script") {
        scripts.set(entry.path.slice("scripts/".length), `${root}/${entry.path}`);
      }
      if (entry.purpose === "package") packagePath = `${root}/${entry.path}`;
    }
    return Promise.resolve(Object.freeze({
      workspace: "/tmp/sfo-deploy-integration",
      root,
      manifestPath: `${root}/manifest.json`,
      packagePath,
      scripts,
      configSkeletons: new Map(),
      configBindings: new Map(),
      files: new Map(),
      entries: bundle.manifest.entries,
      sha256: bundle.sha256,
      reused: false,
    }));
  }
  upload(): Promise<void> {
    return Promise.resolve();
  }
  uploadFile(): Promise<void> {
    return Promise.resolve();
  }
  run(argv: readonly string[], _options?: RemoteRunOptions): Promise<CommandResult> {
    if (argv[0] === "/usr/bin/test") {
      const [flag, path] = argv.slice(1);
      if (flag === "-L") return Promise.resolve(commandResult(1));
      if (flag === "-d" && (path === "/srv/demo" || path === "/srv/demo/1.0.0")) {
        return Promise.resolve(commandResult(0));
      }
      if (
        flag === "-e" &&
        (path === "/srv/demo/.demo.version" || path === "/srv/demo/latest")
      ) {
        return Promise.resolve(commandResult(1));
      }
      return Promise.resolve(commandResult(0));
    }
    if (
      argv[0] === "/usr/bin/cat" &&
      argv[1] === "--" &&
      argv[2] === "/srv/demo/1.0.0/VERSION"
    ) {
      return Promise.resolve(commandResult(0, "1.0.0\n"));
    }
    return Promise.resolve(commandResult(0));
  }
  deploySecrets(): Promise<readonly DeploySecretResult[]> {
    return Promise.resolve([] as readonly DeploySecretResult[]);
  }
  removeSecret(_name: string, _directory: string): Promise<void> {
    return Promise.resolve();
  }
  checkSecrets(): Promise<RemoteSecretState> {
    return Promise.resolve(Object.freeze({
      dirMode: "700",
      entries: Object.freeze([] as string[]),
      manifest: Object.freeze([]),
      sha256: Object.freeze({}),
    }));
  }
  exposeStepSecrets(
    _secretNames: readonly string[],
    _directory: string,
  ): Promise<string> {
    return Promise.resolve("/tmp/sfo-deploy-integration/secrets");
  }
  preflightPython(): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }
  preflightDeno(): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }
  preflightPrivilege(): Promise<void> {
    return Promise.resolve();
  }
  executePython(): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }
  executeDeno(
    _executable: string,
    _script: string,
    _options: {
      workspace: string;
      metadataPath: string;
      secretDir?: string;
      permissions: ScriptPermissions;
      privileged?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }
  readEnvironmentVersion(resource: string): Promise<string | undefined> {
    return Promise.resolve(this.environmentVersions.get(resource));
  }
  writeEnvironmentVersion(resource: string, version: string): Promise<void> {
    this.environmentVersions.set(resource, version);
    return Promise.resolve();
  }
  removeFile(): Promise<void> {
    return Promise.resolve();
  }
  removeTree(): Promise<void> {
    return Promise.resolve();
  }
  cleanupWorkspace(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

class IntegrationTransport implements Transport {
  readonly sessions = new Map<string, IntegrationSession>();
  connect(_target: ResolvedMachine): Promise<RemoteSession> {
    const session = new IntegrationSession();
    this.sessions.set("node-a", session);
    return Promise.resolve(session);
  }
}

Deno.test("integration/prepare: public CLI exposes prepare action", () => {
  assert((CLI_ACTIONS as readonly string[]).includes("prepare"));
});

Deno.test("integration/prepare: run() prepares the selected environment app end to end", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root, {
      envActions: ["check", "install", "configure", "start", "restart"],
      envVersion: "2",
    });
    const transport = new IntegrationTransport();
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "prepare",
        environments: ["base"],
      },
      { transport },
    ) as DeploymentResult;
    assertEquals(directory.length > 0, true);
    assertEquals(result.requestedAction, "prepare");
    assertEquals(result.exitCode, 0);
    assertEquals(
      result.steps.map((step) => step.action),
      ["check", "install", "configure", "start", "restart"],
    );
    assertEquals(
      result.steps.map((step) => step.status).join(","),
      ["succeeded", "skipped", "succeeded", "succeeded", "skipped"].join(","),
    );
    assertEquals(result.steps[1].skipReason, "check-satisfied");
    assertEquals(result.steps[4].skipReason, "using-start");
    const session = transport.sessions.get("node-a")!;
    assertEquals(session.environmentVersions.get("base"), "2");
    assert(session.closed);
  });
});

Deno.test("integration/prepare: default-all without --env requests confirmation", async () => {
  await withTempDir(async (root) => {
    await writeCluster(root);
    let confirmed = false;
    const transport = new IntegrationTransport();
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "prepare",
      },
      {
        transport,
        confirmPlan: () => {
          confirmed = true;
          return true;
        },
      },
    ) as DeploymentResult;
    assertEquals(confirmed, true);
    assertEquals(result.exitCode, 0);
  });
});

Deno.test("integration/prepare: RunOptions rejects --app for prepare", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    try {
      await run({
        configRoot: root,
        cluster: "demo",
        action: "prepare",
        apps: ["demo"],
      });
      throw new Error("expected ConfigurationError");
    } catch (error) {
      assert(error instanceof Error);
      assert(String(error.message).includes("不能与 --app 同时使用"));
    }
    assertEquals(directory.length > 0, true);
  });
});

Deno.test("integration/lifecycle: start executes inside a completed release attempt", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root, { envActions: ["start"] });
    const appDefinition = join(directory, "apps", "demo", "app.yaml");
    await Deno.writeTextFile(
      appDefinition,
      `schema_version: 1
name: demo
install_directory: /srv/demo
depends_on: [base]
configs:
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    format: json
management:
  run_as: deploy
  kind: script
  start: {path: scripts/start.ts, permissions: {run: [], net: []}}
  stop: {path: scripts/stop.ts, permissions: {run: [], net: []}}
  restart: {path: scripts/restart.ts, permissions: {run: [], net: []}}
`,
    );
    for (const name of ["start", "stop", "restart"]) {
      await Deno.writeTextFile(
        join(directory, "apps", "demo", "scripts", `${name}.ts`),
        "Deno.exit(0);\n",
      );
    }
    const result = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "start",
        environments: ["base"],
      },
      { transport: new IntegrationTransport() },
    ) as DeploymentResult;
    assert(result.releaseId !== undefined);
    const release = join(directory, ".sfo-deploy", "releases", result.releaseId);
    const intent = JSON.parse(await Deno.readTextFile(join(release, "intent.json")));
    const outcome = JSON.parse(await Deno.readTextFile(join(release, "outcome.json")));
    assertEquals(intent.operation, "start");
    assertEquals(outcome.status, "succeeded");
    await Deno.lstat(join(release, "snapshot", "actual-plan.json"));
    await assertRejects(
      () => Deno.lstat(join(release, "snapshot", "rollback-plan.json")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("integration/lifecycle: configure/start/stop/restart/deploy/rollback 都创建完整 control attempt", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const packageBytes = gzipSync(new TextEncoder().encode("fixture-package"));
    const packageHash = createHash("sha256").update(packageBytes).digest("hex");
    await Deno.writeTextFile(
      join(directory, "app_versions.yaml"),
      `schema_version: 1
apps:
  demo:
    version: "1.0.0"
    package:
      provider: fixture
      source: {id: demo}
      hash: {algorithm: sha256, value: "${packageHash}"}
`,
    );
    await Deno.writeTextFile(
      join(directory, "apps", "demo", "app.yaml"),
      `schema_version: 1
name: demo
install_directory: /srv/demo
depends_on: []
configs:
  - kind: script
    path: scripts/configure.ts
    permissions: {run: [], net: []}
management:
  run_as: deploy
  kind: script
  start: {path: scripts/start.ts, permissions: {run: [], net: []}}
  stop: {path: scripts/stop.ts, permissions: {run: [], net: []}}
  restart: {path: scripts/restart.ts, permissions: {run: [], net: []}}
`,
    );
    for (const name of ["configure", "start", "stop", "restart"]) {
      await Deno.writeTextFile(
        join(directory, "apps", "demo", "scripts", `${name}.ts`),
        "Deno.exit(0);\n",
      );
    }
    const transport = new IntegrationTransport();
    const fixtureProvider: DownloadProvider & ReleaseSourceCodec = {
      releaseSourceSchema: "fixture.v1",
      exportReleaseSource: (source: Readonly<Record<string, unknown>>) =>
        Object.freeze({ ...source }),
      importReleaseSource: (payload: Readonly<Record<string, unknown>>) =>
        Object.freeze({ ...payload }),
      async fetch(request, destination) {
        await Deno.writeFile(destination, packageBytes);
        return new VerifiedArtifact(
          destination,
          request.hashAlgorithm,
          request.expectedHash,
          packageBytes.length,
        );
      },
    };
    const downloadProviders = new DownloadProviderRegistry({ fixture: fixtureProvider });
    let deployReleaseId = "";
    for (const action of ["configure", "start", "stop", "restart", "deploy"] as const) {
      const result = await run(
        { configRoot: root, cluster: "demo", action, apps: ["demo"] },
        { transport, downloadProviders },
      ) as DeploymentResult;
      assert(result.exitCode === 0, `${action}: ${JSON.stringify(result)}`);
      assert(result.releaseId !== undefined);
      if (action === "deploy") deployReleaseId = result.releaseId;
      const release = join(directory, ".sfo-deploy", "releases", result.releaseId);
      const intent = JSON.parse(await Deno.readTextFile(join(release, "intent.json")));
      const outcome = JSON.parse(await Deno.readTextFile(join(release, "outcome.json")));
      assertEquals(intent.operation, action);
      assertEquals(outcome.status, "succeeded");
      await Deno.lstat(join(release, "snapshot", "actual-plan.json"));
    }
    const rollback = await run(
      {
        configRoot: root,
        cluster: "demo",
        action: "rollback",
        releaseId: deployReleaseId,
      },
      { transport, downloadProviders },
    ) as DeploymentResult;
    assertEquals(rollback.exitCode, 0);
    assert(rollback.releaseId !== undefined);
    const release = join(directory, ".sfo-deploy", "releases", rollback.releaseId);
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(release, "intent.json"))).operation,
      "rollback",
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(release, "outcome.json"))).status,
      "succeeded",
    );
  });
});
