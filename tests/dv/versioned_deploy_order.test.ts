import { join } from "jsr:@std/path@1.1.6";
import { ManagedConfigPublicationError } from "../../src/remote_deployment.ts";
import { REMOTE_VERSIONED_RELEASE_BUNDLE_PATH } from "../../src/remote_runtime/artifact.ts";
import { DeploymentExecutor } from "../../src/execution.ts";
import { commandResult, StepStatus } from "../../src/results.ts";
import type { RemoteSession, Transport } from "../../src/transport.ts";
import type { ExecutionPlan, PlanStep } from "../../src/types.ts";
import type { BuiltDeploymentBundle } from "../../src/deployment_bundle.ts";
import type {
  ManagedConfigPublication,
  ManagedConfigPublishRequest,
} from "../../src/remote_deployment.ts";
import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { resolved } from "../_support/fixtures.ts";

type Fault = "publish" | "switch" | "service" | "marker" | "restore" | "partial-publish";
async function fixture(
  root: string,
  options: {
    first?: boolean;
    configure?: boolean;
    same?: boolean;
    service?: boolean | "static";
    reload?: boolean;
    fault?: Fault;
    cancel?: AbortController;
    targetRoot?: "current" | "latest" | "install";
  } = {},
) {
  const identity = await new Deno.Command("id", { args: ["-un"] }).output();
  assert(identity.success);
  const localRunAs = new TextDecoder().decode(identity.stdout).trim();
  const events: string[] = [];
  const installs = [join(root, "one"), join(root, "two")];
  const targetRoot = options.targetRoot ?? "current";
  for (const install of installs) {
    for (const version of ["v1", "v2"]) {
      await Deno.mkdir(`${install}/${version}/resources`, { recursive: true });
      await Deno.writeTextFile(`${install}/${version}/VERSION`, `${version}\n`);
      await Deno.writeTextFile(`${install}/${version}/resources/application.yml`, "old\n");
    }
    if (targetRoot === "install") {
      await Deno.mkdir(`${install}/resources`, { recursive: true });
      await Deno.writeTextFile(`${install}/resources/application.yml`, "old\n");
    }
    if (!options.first) {
      await Deno.symlink(options.same ? "v2" : "v1", `${install}/latest`);
      await Deno.writeTextFile(`${install}/.demo.version`, options.same ? "v2\n" : "v1\n");
    }
  }
  const source = join(root, "application.yml");
  await Deno.writeTextFile(source, "value: new\n");
  const sessions = installs.map((install, index) => {
    let active = !options.first;
    let faulted = false;
    const workspace = join(root, `workspace-${index}`);
    let workspaceCount = 0;
    const session = {
      async createWorkspace() {
        const path = workspaceCount++ === 0 ? workspace : `${workspace}-${workspaceCount}`;
        await Deno.mkdir(path);
        return path;
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async acquireOperationLock() {
        events.push(`${index}:lock`);
        return { id: `${index}`, app: "demo", target: `node-${index}` };
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async releaseOperationLock() {
        events.push(`${index}:unlock`);
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async validateManagedIdentity() {
        return { runAs: "deploy", uid: 0, sshUid: 0, requiresSudo: false };
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async preflightPrivilege() {
        events.push(`${index}:privilege`);
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async preflightDeno() {
        return commandResult(0);
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async stageDeploymentBundle(bundle: BuiltDeploymentBundle) {
        const scripts = new Map<string, string>();
        const configSkeletons = new Map<string, string>();
        const configBindings = new Map<string, string>();
        for (const entry of bundle.manifest.entries) {
          if (entry.purpose === "script") {
            scripts.set(entry.path.slice(8), `${workspace}/${entry.path}`);
          }
          if (entry.purpose === "config-skeleton") {
            configSkeletons.set(entry.path.slice(8), `${workspace}/${entry.path}`);
          }
          if (entry.purpose === "config-bindings") {
            configBindings.set(entry.path.slice(8), `${workspace}/${entry.path}`);
          }
        }
        return {
          workspace,
          root: workspace,
          manifestPath: `${workspace}/manifest.json`,
          scripts,
          configSkeletons,
          configBindings,
          files: new Map(),
          entries: bundle.manifest.entries,
          sha256: bundle.sha256,
          reused: false,
        };
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async createScopedSecretCopy() {
        return { workspace, path: workspace, runAs: "deploy" };
      },
      async cleanupScopedSecretCopy() {},
      async createManagedConfigCandidate(request: { name: string }) {
        const path = `${workspace}/candidate`;
        await Deno.copyFile(source, path);
        return { name: request.name, workspace, path };
      },
      async publishManagedConfigs(requests: readonly ManagedConfigPublishRequest[]) {
        events.push(`${index}:publish`);
        if (index === 1 && options.fault === "publish") {
          throw new Error("injected publication failure");
        }
        const pubs: ManagedConfigPublication[] = [];
        for (const request of requests) {
          assertEquals(
            request.target,
            options.configure || targetRoot === "latest" || targetRoot === "install"
              ? targetRoot === "install"
                ? `${install}/resources/application.yml`
                : `${install}/latest/resources/application.yml`
              : `${install}/v2/resources/application.yml`,
          );
          assertEquals(
            request.releaseRoot,
            !options.configure && targetRoot === "current" ? `${install}/v2` : undefined,
          );
          assertEquals(
            await Deno.readLink(`${install}/latest`).catch(() => undefined),
            options.first ? undefined : options.same ? "v2" : "v1",
          );
          const backupPath = `${workspace}/backup`;
          await Deno.copyFile(request.target, backupPath);
          await Deno.copyFile(request.candidate.path, request.target);
          pubs.push({
            name: request.candidate.name,
            workspace,
            target: request.target,
            changed: true,
            existed: true,
            backupPath,
          });
        }
        if (index === 0 && options.fault === "partial-publish") {
          throw new ManagedConfigPublicationError(
            "injected partial publication rollback failure",
            pubs,
          );
        }
        return pubs;
      },
      async restoreManagedConfigs(pubs: readonly ManagedConfigPublication[]) {
        events.push(`${index}:restore`);
        if (options.fault === "restore" || options.fault === "partial-publish") {
          throw new Error("injected restore failure");
        }
        for (const pub of pubs) await Deno.copyFile(pub.backupPath!, pub.target);
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async commitManagedConfigs() {
        events.push(`${index}:commit`);
      },
      async uploadFile() {},
      async removeFile() {},
      async cleanupWorkspace(path: string) {
        events.push(`${index}:cleanup`);
        await Deno.remove(path, { recursive: true });
      },
      preserveWorkspace() {
        events.push(`${index}:preserve`);
      },
      // deno-lint-ignore require-await -- recording RemoteSession promise boundary
      async close() {
        events.push(`${index}:close`);
      },
      async run(argv: readonly string[]) {
        const switchCall = argv[0] === "/usr/bin/mv" && argv.at(-1) === `${install}/latest`;
        const markerCall = argv[0] === "/usr/bin/mv" && argv.at(-1) === `${install}/.demo.version`;
        const serviceCall = argv[0] === "systemctl" && ["start", "restart"].includes(argv[1]);
        events.push(`${index}:${switchCall ? "switch" : markerCall ? "marker" : argv.join(" ")}`);
        if (
          !faulted && index === 0 &&
          ((options.fault === "switch" && switchCall) ||
            (options.fault === "marker" && markerCall) ||
            (["service", "restore"].includes(options.fault ?? "") && serviceCall))
        ) {
          faulted = true;
          return commandResult(1, "", "injected failure");
        }
        if (argv[0] === "systemctl") {
          if (argv[1] === "is-enabled") return commandResult(0, "enabled\n");
          if (argv[1] === "is-active") {
            return commandResult(active ? 0 : 3, active ? "active\n" : "inactive\n");
          }
          if (serviceCall) active = true;
          if (argv[1] === "stop") active = false;
          if (index === 1 && argv[1] === "daemon-reload") options.cancel?.abort();
          return commandResult(0);
        }
        if (argv[0] === "/usr/bin/install" && argv.at(-1)?.includes(".sfo-deploy-marker-")) {
          // Verify the executor passes the app identity before adapting the local OS account.
          assertEquals(argv[argv.indexOf("-o") + 1], "deploy");
          assertEquals(argv[argv.indexOf("-m") + 1], "0640");
        }
        const realArgs = argv[0] === "/usr/bin/install" && argv.includes("-o")
          ? argv.map((value, index) =>
            index === argv.indexOf("-o") + 1 && value === "deploy" ? localRunAs : value
          )
          : argv;
        const output = await new Deno.Command(argv[0], {
          args: [...realArgs.slice(1)],
          stdout: "piped",
          stderr: "piped",
        }).output();
        return commandResult(
          output.code,
          new TextDecoder().decode(output.stdout),
          new TextDecoder().decode(output.stderr),
        );
      },
    } as unknown as RemoteSession;
    return session;
  });
  const steps: PlanStep[] = [];
  for (const action of ["stage", "activate"]) {
    for (const [index, install] of installs.entries()) {
      steps.push({
        id: `app:node-${index}/demo:${action}`,
        machine: resolved(`node-${index}`),
        kind: "app",
        resource: "demo",
        action,
        scripts: [],
        parameters: { version: "v2" },
        deployment: { kind: "versioned" },
        installDirectory: install,
        runAs: "deploy",
        secretValues: [],
        secretFiles: [],
        templates: [],
        dependsOn: action === "activate" ? installs.map((_, i) => `app:node-${i}/demo:stage`) : [],
        management: {
          runAs: "deploy",
          configs: [{
            name: "application",
            relativePath: "templates/application.yml",
            source,
            target: targetRoot === "install"
              ? `${install}/resources/application.yml`
              : `${install}/latest/resources/application.yml`,
            targetRoot,
            mode: 0o600,
            variables: [],
            format: "yaml",
            secretReferences: new Map(),
            onChange: options.reload ? "reload" : options.service === "static" ? "none" : "restart",
          }],
          configScripts: [],
          manager: options.service === false ? undefined : {
            kind: "service",
            tool: "systemctl",
            unit: options.reload ? "nginx.service" : "demo.service",
            enabled: options.service === "static" || options.reload ? undefined : true,
            daemonReload: !options.reload,
            onDeploy: options.service === "static" ? "none" : "restart",
            timeoutMs: 1000,
          },
        },
        deliveryInputs: { scripts: [], files: [] },
      });
    }
  }
  const plan: ExecutionPlan = {
    schemaVersion: 4,
    cluster: "fixture",
    requestedAction: "deploy",
    steps,
  };
  const transport: Transport = {
    connect: (target) => Promise.resolve(sessions[Number(target.machine.name.split("-")[1])]),
  };
  return { events, installs, plan, transport };
}

for (const variant of [{}, { first: true }, { same: true }, { service: false }]) {
  Deno.test(`dv/069: preparation barrier and immediate switch/action ${JSON.stringify(variant)}`, () =>
    withTempDir(async (root) => {
      const f = await fixture(root, variant);
      const result = await new DeploymentExecutor(f.transport).execute(f.plan);
      assert(
        result.steps.every((s) => s.status === StepStatus.SUCCEEDED),
        JSON.stringify(result.steps),
      );
      assert(f.events.indexOf("1:publish") < f.events.indexOf("0:switch"));
      for (const index of [0, 1]) {
        const offset = f.events.indexOf(`${index}:switch`);
        assertEquals(
          f.events[offset + 1],
          `${index}:${
            "service" in variant
              ? "marker"
              : `systemctl ${"first" in variant ? "start" : "restart"} -- demo.service`
          }`,
        );
        assertEquals(await Deno.readLink(`${f.installs[index]}/latest`), "v2");
        assertEquals(
          await Deno.readTextFile(`${f.installs[index]}/v1/resources/application.yml`),
          "old\n",
        );
        assertEquals(
          await Deno.readTextFile(`${f.installs[index]}/v2/resources/application.yml`),
          "value: new\n",
        );
        assert(f.events.indexOf(`${index}:cleanup`) > offset);
      }
    }));
}

Deno.test("dv/082: latest target stays on the latest symlink path during deploy", () =>
  withTempDir(async (root) => {
    const f = await fixture(root, { targetRoot: "latest" });
    const result = await new DeploymentExecutor(f.transport).execute(f.plan);
    assert(result.steps.every((s) => s.status === StepStatus.SUCCEEDED));
    assertEquals(
      await Deno.readTextFile(`${f.installs[0]}/v1/resources/application.yml`),
      "value: new\n",
    );
    assertEquals(await Deno.readTextFile(`${f.installs[0]}/v2/resources/application.yml`), "old\n");
  }));

Deno.test("dv/082: install root target is not reinterpreted as a release path", () =>
  withTempDir(async (root) => {
    const f = await fixture(root, { targetRoot: "install" });
    const result = await new DeploymentExecutor(f.transport).execute(f.plan);
    assert(result.steps.every((s) => s.status === StepStatus.SUCCEEDED));
    assertEquals(
      await Deno.readTextFile(`${f.installs[0]}/resources/application.yml`),
      "value: new\n",
    );
    assertEquals(await Deno.readTextFile(`${f.installs[0]}/v2/resources/application.yml`), "old\n");
  }));

for (const fault of ["publish", "switch", "service", "marker", "restore"] as const) {
  Deno.test(`dv/069: ${fault} failure recovery`, () =>
    withTempDir(async (root) => {
      const f = await fixture(root, { fault });
      const result = await new DeploymentExecutor(f.transport).execute(f.plan);
      assert(
        result.steps.some((s) => s.status === StepStatus.FAILED),
        JSON.stringify(result.steps),
      );
      assertEquals(await Deno.readLink(`${f.installs[0]}/latest`), "v1");
      assertEquals(await Deno.readTextFile(`${f.installs[0]}/.demo.version`), "v1\n");
      if (fault === "publish") assert(!f.events.includes("0:switch"));
      if (fault === "switch") assert(!f.events.includes("0:systemctl restart -- demo.service"));
      if (fault === "service" || fault === "marker") {
        assertEquals(f.events.filter((e) => e === "0:systemctl restart -- demo.service").length, 2);
      }
      if (fault === "restore") {
        assert(f.events.includes("0:preserve"));
        assertEquals(await Deno.readTextFile(`${root}/workspace-0/backup`), "old\n");
      } else {assertEquals(
          await Deno.readTextFile(`${f.installs[0]}/v2/resources/application.yml`),
          "old\n",
        );}
    }));
}

Deno.test("dv/069: static versioned service defers to existing unit state", () =>
  withTempDir(async (root) => {
    const f = await fixture(root, { service: "static" });
    const result = await new DeploymentExecutor(f.transport).execute(f.plan);
    assert(
      result.steps.every((s) => s.status === StepStatus.SUCCEEDED),
      JSON.stringify(result.steps),
    );
    assert(
      f.events.every((event) => !event.includes("systemctl start -- demo.service")),
      JSON.stringify(f.events),
    );
    assert(
      f.events.every((event) => !event.includes("systemctl restart -- demo.service")),
      JSON.stringify(f.events),
    );
  }));

Deno.test("dv/083: nginx config reload follows latest switch without restart", () =>
  withTempDir(async (root) => {
    const f = await fixture(root, { service: "static", reload: true });
    const result = await new DeploymentExecutor(f.transport).execute(f.plan);
    assert(result.steps.every((s) => s.status === StepStatus.SUCCEEDED));
    for (const index of [0, 1]) {
      const offset = f.events.indexOf(`${index}:switch`);
      assertEquals(f.events[offset + 1], `${index}:systemctl reload -- nginx.service`);
      assert(!f.events.some((event) => event.includes("systemctl restart -- nginx.service")));
      assert(!f.events.some((event) => event.includes("systemctl start -- nginx.service")));
    }
  }));

Deno.test("dv/069: cancellation before activation restores staged config without switching", () =>
  withTempDir(async (root) => {
    const cancel = new AbortController();
    const f = await fixture(root, { cancel });
    await new DeploymentExecutor(f.transport).execute(f.plan, cancel.signal);
    assert(!f.events.includes("0:switch"));
    assertEquals(await Deno.readTextFile(`${f.installs[0]}/v2/resources/application.yml`), "old\n");
  }));

Deno.test("dv/069: partial publication recovery failure retains backups through close", () =>
  withTempDir(async (root) => {
    const f = await fixture(root, { fault: "partial-publish" });
    const result = await new DeploymentExecutor(f.transport).execute(f.plan);
    assert(result.steps.some((s) => s.status === StepStatus.FAILED));
    assert(!f.events.includes("0:switch"));
    assert(f.events.includes("0:restore"));
    assert(f.events.includes("0:preserve"));
    assert(f.events.includes("0:close"));
    assertEquals(await Deno.readTextFile(`${root}/workspace-0/backup`), "old\n");
    assert(result.steps.some((s) => s.recovery?.succeeded === false));
  }));

Deno.test("dv/069: legacy three-phase dependency graph prepares globally and restarts once", () =>
  withTempDir(async (root) => {
    const f = await fixture(root);
    const [s0, s1, a0, a1] = f.plan.steps;
    const r0 = {
      ...a0,
      id: "legacy-restart-0",
      action: "restart",
      deployment: undefined,
      dependsOn: [a0.id],
    };
    const r1 = {
      ...a1,
      id: "legacy-restart-1",
      action: "restart",
      deployment: undefined,
      dependsOn: [a1.id],
    };
    const custom = {
      ...s0,
      id: "custom-setup",
      action: "deploy",
      resource: "custom",
      deployment: undefined,
      management: undefined,
      deliveryInputs: undefined,
      dependsOn: [s0.id],
    };
    const steps = [
      { ...s0, management: undefined, deliveryInputs: undefined },
      custom,
      { ...s1, management: undefined, deliveryInputs: undefined, dependsOn: [r0.id, custom.id] },
      a0,
      { ...a1, dependsOn: [s1.id, r0.id] },
      r0,
      r1,
    ];
    const result = await new DeploymentExecutor(f.transport).execute({ ...f.plan, steps });
    assert(
      result.steps.every((s) => [StepStatus.SUCCEEDED, StepStatus.SKIPPED].includes(s.status)),
      JSON.stringify(result.steps),
    );
    assertEquals(f.events.filter((e) => e.includes("systemctl restart --")).length, 2);
    assert(f.events.indexOf("1:publish") < f.events.indexOf("0:switch"));
    assert(f.events.indexOf("0:switch") < f.events.indexOf("1:switch"));
  }));

Deno.test("dv/069: legacy single-step versioned snapshot rejected before SSH", () =>
  withTempDir(async (root) => {
    const f = await fixture(root);
    let connects = 0;
    const transport: Transport = {
      connect: () => {
        connects++;
        throw new Error("must not connect");
      },
    };
    const step = {
      ...f.plan.steps[0],
      action: "deploy",
      scripts: [{
        source: join(root, "legacy.ts"),
        relativePath: REMOTE_VERSIONED_RELEASE_BUNDLE_PATH,
        permissions: { run: [], net: [] },
      }],
    };
    await assertRejects(() =>
      new DeploymentExecutor(transport).execute({ ...f.plan, steps: [step] })
    );
    assertEquals(connects, 0);
  }));

for (const variant of [{ first: true }, { same: true }]) {
  Deno.test(`dv/069: service failure restores ${JSON.stringify(variant)} state`, () =>
    withTempDir(async (root) => {
      const f = await fixture(root, { ...variant, fault: "service" });
      const result = await new DeploymentExecutor(f.transport).execute(f.plan);
      assert(result.steps.some((s) => s.status === StepStatus.FAILED && s.recovery?.succeeded));
      assertEquals(
        await Deno.readLink(`${f.installs[0]}/latest`).catch(() => undefined),
        "first" in variant ? undefined : "v2",
      );
      assertEquals(
        await Deno.readTextFile(`${f.installs[0]}/v2/resources/application.yml`),
        "old\n",
      );
    }));
}
Deno.test("dv/069: explicit configure updates current link target without activation", () =>
  withTempDir(async (root) => {
    const f = await fixture(root, { configure: true, service: false });
    const step = { ...f.plan.steps[0], action: "configure", deployment: undefined };
    const result = await new DeploymentExecutor(f.transport).execute({
      ...f.plan,
      requestedAction: "configure",
      steps: [step],
    });
    assertEquals(result.steps[0].status, StepStatus.SUCCEEDED, JSON.stringify(result.steps));
    assert(!f.events.includes("0:switch"));
    assertEquals(await Deno.readLink(`${f.installs[0]}/latest`), "v1");
    assertEquals(
      await Deno.readTextFile(`${f.installs[0]}/v1/resources/application.yml`),
      "value: new\n",
    );
    assertEquals(await Deno.readTextFile(`${f.installs[0]}/v2/resources/application.yml`), "old\n");
  }));
