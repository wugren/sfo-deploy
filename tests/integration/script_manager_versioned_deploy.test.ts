import { createHash } from "node:crypto";
import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, withTempDir } from "../_support/assert.ts";
import { writePlacementCluster } from "../_support/environment_placement.ts";
import { loadCluster } from "../../src/config.ts";
import { buildPlan } from "../../src/planning.ts";
import { deriveRollbackPlan } from "../../src/history.ts";
import { DeploymentExecutor } from "../../src/execution.ts";
import { type CommandFactory, OpenSshRemoteSession } from "../../src/transport.ts";
import type { RemoteOperationLockRequest } from "../../src/remote_deployment.ts";
import { DownloadProviderRegistry, VerifiedArtifact } from "../../src/downloads.ts";
import { StepStatus } from "../../src/results.ts";

class RecordingSession extends OpenSshRemoteSession {
  acquisitions = 0;

  override async acquireOperationLock(
    request: RemoteOperationLockRequest,
    signal?: AbortSignal,
  ) {
    this.acquisitions += 1;
    return await super.acquireOperationLock({ ...request, timeoutMs: 400 }, signal);
  }
}

const commandFactory: CommandFactory = (command, args) => {
  const stdio = { stdin: "null", stdout: "piped", stderr: "piped" } as const;
  if (command === "scp") {
    const source = args.at(-2)!;
    const destination = args.at(-1)!.split(":").slice(1).join(":");
    return new Deno.Command("/usr/bin/cp", {
      args: ["--", source, destination],
      ...stdio,
    }).spawn();
  }
  return new Deno.Command("/bin/sh", { args: ["-c", args.at(-1)!], ...stdio }).spawn();
};

async function fixture(
  root: string,
  options: { restartFails?: boolean } = {},
): Promise<{
  clusterDirectory: string;
  install: string;
  archive: string;
  hash: string;
  target: string;
}> {
  const target = `review-${crypto.randomUUID()}`;
  const install = join(root, "install");
  const clusterDirectory = await writePlacementCluster(root, {
    machines: [target],
    environments: [],
    apps: [{ name: "demo", machines: [target], dependsOn: [] }],
  });
  await Deno.writeTextFile(
    join(clusterDirectory, "machines.yaml"),
    `schema_version: 1\nmachines:\n  - name: ${target}\n    private_ip: 127.0.0.1\n    region: local\n    ssh_user: root\n    deno: ${Deno.execPath()}\n`,
  );
  await Deno.mkdir(join(clusterDirectory, "apps", "demo", "scripts"), { recursive: true });
  await Deno.writeTextFile(
    join(clusterDirectory, "apps", "demo", "scripts", "run.ts"),
    'console.log("manager invoked");\n',
  );
  const restartPath = options.restartFails ? "scripts/restart.ts" : "scripts/run.ts";
  if (options.restartFails) {
    await Deno.writeTextFile(
      join(clusterDirectory, "apps", "demo", "scripts", "restart.ts"),
      'console.log("restart failing");\nDeno.exit(23);\n',
    );
  }
  await Deno.writeTextFile(
    join(clusterDirectory, "apps", "demo", "app.yaml"),
    `schema_version: 1\nname: demo\ninstall_directory: ${install}\ndeployment: {kind: versioned}\nconfigs: []\nmanagement:\n  kind: script\n  start: {path: scripts/run.ts, permissions: {run: [], net: []}}\n  stop: {path: scripts/run.ts, permissions: {run: [], net: []}}\n  restart: {path: ${restartPath}, permissions: {run: [], net: []}}\n`,
  );
  await Deno.mkdir(join(root, "payload"));
  await Deno.writeTextFile(join(root, "payload", "VERSION"), "2\n");
  await Deno.writeTextFile(join(root, "payload", "app.txt"), "test payload");
  const archive = join(root, "package.tar.gz");
  const tar = await new Deno.Command("tar", {
    args: ["-czf", archive, "-C", join(root, "payload"), "VERSION", "app.txt"],
  }).output();
  if (!tar.success) throw new Error(new TextDecoder().decode(tar.stderr));
  const bytes = await Deno.readFile(archive);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await Deno.writeTextFile(
    join(clusterDirectory, "app_versions.yaml"),
    `schema_version: 1\napps:\n  demo:\n    version: "2"\n    package:\n      provider: http\n      source: {url: "https://example.invalid/demo"}\n      hash: {algorithm: sha256, value: "${hash}"}\n`,
  );
  return { clusterDirectory, install, archive, hash, target };
}

function registry(archive: string, hash: string, size: number): DownloadProviderRegistry {
  return new DownloadProviderRegistry({
    http: {
      async fetch(_request, destination) {
        await Deno.copyFile(archive, destination);
        return new VerifiedArtifact(destination, "sha256", hash, size);
      },
    },
  });
}

async function connect(root: string): Promise<RecordingSession> {
  const knownHosts = join(root, "known_hosts");
  await Deno.writeTextFile(knownHosts, "fixture\n");
  const session = new RecordingSession({
    address: "127.0.0.1",
    user: "root",
    port: 22,
    knownHosts,
    sshExecutable: "ssh",
    scpExecutable: "scp",
    connectTimeoutMs: 1_000,
    commandTimeoutMs: 10_000,
    terminateTimeoutMs: 1_000,
    commandFactory,
  });
  return session;
}

Deno.test("integration/110: script-manager versioned deploy reuses one operation lease", async () => {
  await withTempDir(async (root) => {
    const f = await fixture(root);
    const session = await connect(root);
    try {
      const cluster = await loadCluster(f.clusterDirectory);
      const plan = buildPlan(cluster, "deploy");
      assertEquals(plan.steps.map((step) => step.action), ["stage", "activate", "restart"]);
      const bytes = await Deno.readFile(f.archive);
      const result = await new DeploymentExecutor(
        { connect: () => Promise.resolve(session) },
        { downloadProviders: registry(f.archive, f.hash, bytes.length) },
      ).execute(plan);
      assert(
        result.steps.every((step) => step.status === StepStatus.SUCCEEDED),
        JSON.stringify(result.steps),
      );
      assertEquals(session.acquisitions, 1);
      assertEquals(await Deno.readLink(join(f.install, "latest")), "2");
      assertEquals(await Deno.readTextFile(join(f.install, ".demo.version")), "2\n");
      assert(
        result.steps.at(-1)!.stdout.includes("manager invoked"),
        JSON.stringify(result.steps.map((step) => step.stdout)),
      );
    } finally {
      await session.close();
    }
  });
});

Deno.test("integration/110: script-manager rollback keeps and runs the manager restart", async () => {
  await withTempDir(async (root) => {
    const f = await fixture(root);
    await Deno.mkdir(join(f.install, "3"), { recursive: true });
    await Deno.writeTextFile(join(f.install, "3", "VERSION"), "3\n");
    await Deno.writeTextFile(join(f.install, ".demo.version"), "3\n");
    await Deno.symlink("3", join(f.install, "latest"));
    const session = await connect(root);
    try {
      const cluster = await loadCluster(f.clusterDirectory);
      const plan = deriveRollbackPlan(buildPlan(cluster, "deploy"));
      assertEquals(plan.requestedAction, "rollback");
      assertEquals(plan.steps.map((step) => step.action), ["stage", "activate", "restart"]);
      const bytes = await Deno.readFile(f.archive);
      const result = await new DeploymentExecutor(
        { connect: () => Promise.resolve(session) },
        { downloadProviders: registry(f.archive, f.hash, bytes.length) },
      ).execute(plan);
      assert(
        result.steps.every((step) => step.status === StepStatus.SUCCEEDED),
        JSON.stringify(result.steps),
      );
      assertEquals(session.acquisitions, 1);
      assertEquals(await Deno.readLink(join(f.install, "latest")), "2");
      assertEquals(await Deno.readTextFile(join(f.install, ".demo.version")), "2\n");
      assert(
        result.steps.at(-1)!.stdout.includes("manager invoked"),
        JSON.stringify(result.steps.map((step) => step.stdout)),
      );
    } finally {
      await session.close();
    }
  });
});

Deno.test("integration/112: script-manager restart 失败恢复上一版本并保留旧版本", async () => {
  await withTempDir(async (root) => {
    const f = await fixture(root, { restartFails: true });
    await Deno.mkdir(join(f.install, "3"), { recursive: true });
    await Deno.writeTextFile(join(f.install, "3", "VERSION"), "3\n");
    await Deno.writeTextFile(join(f.install, ".demo.version"), "3\n");
    await Deno.symlink("3", join(f.install, "latest"));
    const session = await connect(root);
    try {
      const cluster = await loadCluster(f.clusterDirectory);
      const plan = buildPlan(cluster, "deploy");
      assertEquals(plan.steps.map((step) => step.action), ["stage", "activate", "restart"]);
      const bytes = await Deno.readFile(f.archive);
      const result = await new DeploymentExecutor(
        { connect: () => Promise.resolve(session) },
        { downloadProviders: registry(f.archive, f.hash, bytes.length) },
      ).execute(plan);
      const restart = result.steps.at(-1)!;
      assertEquals(restart.action, "restart");
      assertEquals(restart.status, StepStatus.FAILED, JSON.stringify(result.steps));
      assertEquals(await Deno.readLink(join(f.install, "latest")), "3");
      assertEquals(await Deno.readTextFile(join(f.install, ".demo.version")), "3\n");
      assert((await Deno.stat(join(f.install, "3"))).isDirectory);
      assertEquals(restart.recovery?.attempted, true);
      assertEquals(restart.recovery?.succeeded, true);
    } finally {
      await session.close();
    }
  });
});
