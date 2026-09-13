import { join } from "jsr:@std/path@1.1.6";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { plan as makePlan } from "../_support/fixtures.ts";
import {
  type DownloadProvider,
  DownloadProviderRegistry,
  type DownloadRequest,
  VerifiedArtifact,
} from "../../src/downloads.ts";
import { DeploymentExecutor, executePlan, prepareExecution } from "../../src/execution.ts";
import { CancelledError, PreflightError } from "../../src/errors.ts";
import { commandResult, type StepResult, StepStatus } from "../../src/results.ts";
import { ProjectBindings } from "../../src/secrets.ts";
import type {
  DeploySecretResult,
  RemoteRunOptions,
  RemoteSecretState,
  RemoteSecretUpload,
  RemoteSession,
  Transport,
} from "../../src/transport.ts";
import type { CommandResult } from "../../src/results.ts";
import type { ExecutionPlan, ResolvedMachine, ScriptPermissions } from "../../src/types.ts";

class MemorySession implements RemoteSession {
  readonly machine: string;
  readonly events: string[];
  readonly failFirst: boolean;
  executeCount = 0;
  closed = false;
  readonly uploads: Array<{
    local: string;
    remote: string;
    requestedMode?: number;
    effectiveMode: number;
  }> = [];
  readonly uploadedMetadata: unknown[] = [];
  readonly secretExposures: Array<{
    names: readonly string[];
    directory: string;
    workspace: string;
  }> = [];
  readonly deployedSecrets: Array<{
    name: string;
    kind: string;
    sha256: string;
  }> = [];
  readonly removedSecrets: string[] = [];
  readonly checkStates: RemoteSecretState[] = [];
  readonly removedFiles: string[] = [];
  readonly environmentVersions = new Map<string, string | undefined>();
  readonly denoExecutions: Array<{
    executable: string;
    script: string;
    workspace: string;
    metadataPath: string;
    secretDir?: string;
    permissions: ScriptPermissions;
    privileged?: boolean;
    signal?: AbortSignal;
  }> = [];
  readonly errorOnExpose?: Error;

  constructor(machine: string, events: string[], failFirst = false, errorOnExpose?: Error) {
    this.machine = machine;
    this.events = events;
    this.failFirst = failFirst;
    this.errorOnExpose = errorOnExpose;
  }

  createWorkspace(): Promise<string> {
    const path = `/tmp/sfo-deploy-${this.machine}`;
    this.events.push(`${this.machine}:workspace`);
    return Promise.resolve(path);
  }

  upload(_local: string, _remote: string): Promise<void> {
    return Promise.resolve();
  }

  async uploadFile(
    local: string,
    remote: string,
    options?: { readonly signal?: AbortSignal; readonly mode?: number },
  ): Promise<void> {
    const effectiveMode = options?.mode ?? 0o600;
    this.uploads.push({
      local,
      remote,
      requestedMode: options?.mode,
      effectiveMode,
    });
    this.events.push(`${this.machine}:upload:${remote}:${effectiveMode.toString(8)}`);
    if (/\/metadata-\d+\.json$/.test(remote)) {
      this.uploadedMetadata.push(JSON.parse(await Deno.readTextFile(local)));
    }
  }

  run(_argv: readonly string[], _options?: RemoteRunOptions): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }

  deploySecrets(
    files: readonly RemoteSecretUpload[],
    _directory: string,
  ): Promise<readonly DeploySecretResult[]> {
    for (const file of files) {
      this.deployedSecrets.push({ name: file.name, kind: file.kind, sha256: file.sha256 });
      this.events.push(`${this.machine}:secret-deploy:${file.name}`);
    }
    return Promise.resolve(files.map((file) =>
      Object.freeze({
        name: file.name,
        kind: file.kind,
        sha256: file.sha256,
        status: "written" as const,
      })
    ));
  }

  removeSecret(name: string): Promise<void> {
    this.removedSecrets.push(name);
    this.events.push(`${this.machine}:secret-remove:${name}`);
    return Promise.resolve();
  }

  checkSecrets(): Promise<RemoteSecretState> {
    const state: RemoteSecretState = Object.freeze({
      dirMode: "700",
      entries: Object.freeze([] as string[]),
      manifest: Object.freeze([]),
      sha256: Object.freeze({}),
    });
    this.checkStates.push(state);
    this.events.push(`${this.machine}:secret-check`);
    return Promise.resolve(state);
  }

  exposeStepSecrets(
    secretNames: readonly string[],
    directory: string,
    workspace: string,
  ): Promise<string> {
    if (this.errorOnExpose !== undefined) throw this.errorOnExpose;
    this.secretExposures.push({ names: secretNames, directory, workspace });
    this.events.push(`${this.machine}:expose-secrets:${secretNames.join(",")}`);
    return Promise.resolve(`${workspace}/secrets`);
  }

  preflightDeno(): Promise<CommandResult> {
    this.events.push(`${this.machine}:preflight`);
    return Promise.resolve(commandResult(0));
  }

  preflightPrivilege(): Promise<void> {
    return Promise.resolve();
  }

  executeDeno(
    executable: string,
    script: string,
    options: {
      readonly workspace: string;
      readonly metadataPath: string;
      readonly secretDir?: string;
      readonly permissions: ScriptPermissions;
      readonly privileged?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<CommandResult> {
    this.executeCount++;
    this.denoExecutions.push({ executable, script, ...options });
    this.events.push(`${this.machine}:execute:${this.executeCount}`);
    return Promise.resolve(commandResult(this.failFirst && this.executeCount === 1 ? 9 : 0));
  }

  removeFile(path: string): Promise<void> {
    this.removedFiles.push(path);
    this.events.push(`${this.machine}:remove:${path}`);
    return Promise.resolve();
  }

  readEnvironmentVersion(resource: string): Promise<string | undefined> {
    this.events.push(`${this.machine}:read-version:${resource}`);
    return Promise.resolve(this.environmentVersions.get(resource));
  }

  writeEnvironmentVersion(resource: string, version: string): Promise<void> {
    this.environmentVersions.set(resource, version);
    this.events.push(`${this.machine}:write-version:${resource}:${version}`);
    return Promise.resolve();
  }

  removeTree(): Promise<void> {
    return Promise.resolve();
  }

  cleanupWorkspace(path: string): Promise<void> {
    this.events.push(`${this.machine}:cleanup:${path}`);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.events.push(`${this.machine}:close`);
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

class MemoryTransport implements Transport {
  readonly sessions = new Map<string, MemorySession>();
  readonly events: string[] = [];

  constructor(
    readonly failingMachine?: string,
    readonly initialEnvironmentVersions?: ReadonlyMap<string, string>,
    readonly sessionFactory?: (machine: string, events: string[]) => MemorySession,
    readonly errorOnExpose?: Error,
  ) {}

  connect(target: ResolvedMachine): Promise<RemoteSession> {
    const name = target.machine.name;
    this.events.push(`${name}:connect`);
    const session = this.sessionFactory === undefined
      ? new MemorySession(name, this.events, name === this.failingMachine, this.errorOnExpose)
      : this.sessionFactory(name, this.events);
    if (this.initialEnvironmentVersions !== undefined) {
      for (const [resource, version] of this.initialEnvironmentVersions) {
        session.environmentVersions.set(resource, version);
      }
    }
    this.sessions.set(name, session);
    return Promise.resolve(session);
  }
}

class CancellingSession extends MemorySession {
  readonly controller: AbortController;

  constructor(machine: string, events: string[], controller: AbortController) {
    super(machine, events);
    this.controller = controller;
  }

  override executeDeno(): Promise<CommandResult> {
    this.executeCount++;
    this.events.push(`${this.machine}:execute:${this.executeCount}`);
    this.controller.abort("test cancellation");
    return Promise.reject(new CancelledError("远端命令已取消"));
  }
}

class CancellingTransport implements Transport {
  readonly events: string[] = [];
  readonly sessions = new Map<string, CancellingSession>();
  constructor(readonly controller: AbortController) {}

  connect(target: ResolvedMachine): Promise<RemoteSession> {
    const name = target.machine.name;
    this.events.push(`${name}:connect`);
    const session = new CancellingSession(name, this.events, this.controller);
    this.sessions.set(name, session);
    return Promise.resolve(session);
  }
}

class MetadataUploadFailingSession extends MemorySession {
  override async uploadFile(
    local: string,
    remote: string,
    options?: { readonly signal?: AbortSignal; readonly mode?: number },
  ): Promise<void> {
    await super.uploadFile(local, remote, options);
    if (/\/metadata-\d+\.json$/.test(remote)) {
      throw new Error("forced metadata upload failure");
    }
  }
}

class MetadataUploadFailingTransport implements Transport {
  readonly events: string[] = [];
  session?: MetadataUploadFailingSession;

  connect(target: ResolvedMachine): Promise<RemoteSession> {
    const name = target.machine.name;
    this.events.push(`${name}:connect`);
    this.session = new MetadataUploadFailingSession(name, this.events);
    return Promise.resolve(this.session);
  }
}

class FixtureDownloadProvider implements DownloadProvider {
  readonly content: Uint8Array;
  readonly hash: string;

  constructor(content: Uint8Array, hash: string) {
    this.content = content;
    this.hash = hash;
  }

  async fetch(
    _request: DownloadRequest,
    destination: string,
  ): Promise<VerifiedArtifact> {
    await Deno.writeFile(destination, this.content, { createNew: true });
    return new VerifiedArtifact(destination, "sha256", this.hash, this.content.length);
  }
}

async function executablePlan(
  root: string,
  machines = ["node-a", "node-b"],
): Promise<ExecutionPlan> {
  const source = join(root, "action.ts");
  await Deno.writeTextFile(source, "Deno.exit(0);\n");
  const plan = makePlan(machines);
  return Object.freeze({
    ...plan,
    steps: Object.freeze(
      plan.steps.map((step) =>
        Object.freeze({
          ...step,
          scripts: Object.freeze(
            step.scripts.map((item) => Object.freeze({ ...item, source })),
          ),
        })
      ),
    ),
  });
}

async function richExecutionInputs(root: string): Promise<{
  readonly plan: ExecutionPlan;
  readonly bindings: ProjectBindings;
  readonly downloads: DownloadProviderRegistry;
}> {
  const source = join(root, "action.ts");
  const template = join(root, "application.yml.tpl");
  await Deno.writeTextFile(source, "Deno.exit(0);\n");
  await Deno.writeTextFile(template, "token=$APP_TOKEN\n");

  const packageContent = gzipSync(new TextEncoder().encode("verified-package-content\n"));
  const packageHash = createHash("sha256").update(packageContent).digest("hex");
  const base = makePlan(["node-a"]);
  const [configure, deploy] = base.steps;
  const plan: ExecutionPlan = Object.freeze({
    ...base,
    steps: Object.freeze([
      Object.freeze({
        ...configure,
        scripts: Object.freeze([Object.freeze({
          source,
          relativePath: "scripts/action.ts",
          permissions: Object.freeze({
            run: Object.freeze(["/usr/bin/install"]),
            net: Object.freeze([] as string[]),
          }),
        })]),
        secretValues: Object.freeze(["APP_TOKEN"]),
        secretFiles: Object.freeze([]),
        templates: Object.freeze([Object.freeze({
          relativePath: "templates/application.yml.tpl",
          source: template,
        })]),
      }),
      Object.freeze({
        ...deploy,
        scripts: Object.freeze([Object.freeze({
          source,
          relativePath: "scripts/action.ts",
          permissions: Object.freeze({
            run: Object.freeze(["/usr/bin/cp"]),
            net: Object.freeze(["127.0.0.1:8080"]),
          }),
        })]),
        package: Object.freeze({
          provider: "fixture",
          source: Object.freeze({ fixture: "package" }),
          hashAlgorithm: "sha256",
          hashValue: packageHash,
        }),
      }),
    ]),
  });
  return {
    plan,
    bindings: new ProjectBindings({ configSecrets: { APP_TOKEN: "selected-config-secret" } }),
    downloads: new DownloadProviderRegistry({
      fixture: new FixtureDownloadProvider(packageContent, packageHash),
    }),
  };
}

Deno.test("dv/execution: one target fails fast while another target remains isolated", async () => {
  await withTempDir(async (root) => {
    const transport = new MemoryTransport("node-a");
    const result = await executePlan(await executablePlan(root), { transport });
    assertEquals(result.exitCode, 4);
    assertEquals(result.steps.map((step) => step.status), [
      StepStatus.FAILED,
      StepStatus.SKIPPED,
      StepStatus.SUCCEEDED,
      StepStatus.SUCCEEDED,
    ]);
    assertEquals(result.steps[1].skipReason, "target-fail-fast");
    assert(transport.sessions.get("node-a")?.closed);
    assert(transport.sessions.get("node-b")?.closed);
  });
});

Deno.test("dv/execution: onStep emits every completed step in plan order", async () => {
  await withTempDir(async (root) => {
    const transport = new MemoryTransport();
    const emitted: StepResult[] = [];
    const plan = await executablePlan(root, ["node-a"]);
    const result = await executePlan(plan, {
      transport,
      onStep: (progress) => {
        emitted.push(progress.step);
      },
    });
    assertEquals(result.exitCode, 0);
    assertEquals(emitted.map((step) => step.stepId), plan.steps.map((step) => step.id));
    assertEquals(emitted.map((step) => step.status), [
      StepStatus.SUCCEEDED,
      StepStatus.SUCCEEDED,
    ]);
  });
});

Deno.test("dv/execution: pre-aborted request performs no SSH and returns cancelled results", async () => {
  await withTempDir(async (root) => {
    const plan = await executablePlan(root, ["node-a"]);
    const prepared = await prepareExecution(plan);
    const controller = new AbortController();
    controller.abort();
    const result = await new DeploymentExecutor(new MemoryTransport()).executePrepared(
      prepared,
      controller.signal,
    );
    assertEquals(result.steps.map((step) => step.status), [
      StepStatus.CANCELLED,
      StepStatus.CANCELLED,
    ]);
  });
});

Deno.test("dv/execution: in-flight cancellation stops current target and closes resources", async () => {
  await withTempDir(async (root) => {
    const controller = new AbortController();
    const transport = new CancellingTransport(controller);
    const result = await executePlan(await executablePlan(root, ["node-a"]), {
      transport,
      signal: controller.signal,
    });
    assertEquals(result.steps.map((step) => step.status), [
      StepStatus.CANCELLED,
      StepStatus.CANCELLED,
    ]);
    assert(transport.sessions.get("node-a")?.closed);
  });
});

Deno.test("dv/execution: PreparedExecution close removes local staging and is idempotent", async () => {
  await withTempDir(async (root) => {
    const prepared = await prepareExecution(await executablePlan(root, ["node-a"]));
    const directory = prepared.localDirectory;
    await prepared.close();
    await assertRejects(() => Deno.stat(directory));
    assertEquals(await prepared.close(), []);
  });
});

Deno.test("dv/execution: plain steps upload metadata and scripts only", async () => {
  await withTempDir(async (root) => {
    const transport = new MemoryTransport();
    const result = await executePlan(await executablePlan(root, ["node-a"]), { transport });
    assertEquals(result.exitCode, 0);
    const session = transport.sessions.get("node-a");
    assert(session);
    assertEquals(session.uploads.map((upload) => upload.remote), [
      "/tmp/sfo-deploy-node-a/metadata-0.json",
      "/tmp/sfo-deploy-node-a/script-0-0.ts",
      "/tmp/sfo-deploy-node-a/metadata-1.json",
      "/tmp/sfo-deploy-node-a/script-1-0.ts",
    ]);
    assertEquals(session.uploads.filter((upload) => upload.effectiveMode === 0o700).length, 2);
    assertEquals(session.uploadedMetadata, [
      {
        machine: "node-a",
        kind: "app",
        resource: "demo",
        action: "configure",
        parameters: { version: "1.0.0" },
        templates: {},
      },
      {
        machine: "node-a",
        kind: "app",
        resource: "demo",
        action: "deploy",
        parameters: { version: "1.0.0" },
        templates: {},
        keep_versions: 5,
      },
    ]);
    assertEquals(session.secretExposures, []);
    assertEquals(
      session.uploads.some((upload) => /sfo-secret-loader\.ts$/.test(upload.remote)),
      false,
    );
    assertEquals(session.denoExecutions[0]?.secretDir, undefined);
    assertEquals(session.removedFiles, [
      "/tmp/sfo-deploy-node-a/metadata-0.json",
      "/tmp/sfo-deploy-node-a/metadata-1.json",
    ]);
  });
});

Deno.test("dv/execution: declared secrets load only the step subset via loader", async () => {
  await withTempDir(async (root) => {
    const inputs = await richExecutionInputs(root);
    const transport = new MemoryTransport();
    const result = await executePlan(inputs.plan, {
      transport,
      downloadProviders: inputs.downloads,
    });
    assertEquals(result.exitCode, 0);
    const session = transport.sessions.get("node-a");
    assert(session);
    assertEquals(session.secretExposures, [{
      names: ["APP_TOKEN"],
      directory: "~/.sfo-deploy/secrets/",
      workspace: "/tmp/sfo-deploy-node-a",
    }]);
    assert(
      session.uploads.some((upload) =>
        upload.remote === "/tmp/sfo-deploy-node-a/sfo-secret-loader.ts" &&
        upload.effectiveMode === 0o600
      ),
    );
    assertEquals(session.denoExecutions[0].secretDir, "/tmp/sfo-deploy-node-a/secrets");
    assertEquals(session.denoExecutions[1].secretDir, undefined);
  });
});

Deno.test("dv/execution: missing declared secret fails the step before scripts run", async () => {
  await withTempDir(async (root) => {
    const inputs = await richExecutionInputs(root);
    const transport = new MemoryTransport(
      "node-a",
      undefined,
      undefined,
      new PreflightError("密钥未部署到该机器: APP_TOKEN"),
    );
    const result = await executePlan(inputs.plan, {
      transport,
      downloadProviders: inputs.downloads,
    });
    assertEquals(result.exitCode, 3);
    const failed = result.steps[0];
    assertEquals(failed.status, StepStatus.FAILED);
    assert(failed.message?.includes("密钥未部署到该机器: APP_TOKEN"));
    assertEquals(result.steps[1].status, StepStatus.SKIPPED);
  });
});

Deno.test("dv/execution: invalid keep_versions is rejected at executor construction", () => {
  assertThrowsSync(() => new DeploymentExecutor(new MemoryTransport(), { keepVersions: 0 }));
  assertThrowsSync(() => new DeploymentExecutor(new MemoryTransport(), { keepVersions: 101 }));
});

Deno.test("dv/execution: metadata upload failure still cleans all owned resources", async () => {
  await withTempDir(async (root) => {
    const transport = new MetadataUploadFailingTransport();
    const result = await executePlan(await executablePlan(root, ["node-a"]), { transport });
    assertEquals(result.exitCode, 4);
    const session = transport.session;
    assert(session);
    assert(session.events.some((event) => event.startsWith("node-a:cleanup:")));
    assert(session.closed);
  });
});

function assertThrowsSync(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw);
}
