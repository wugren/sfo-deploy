import { basename, join } from "jsr:@std/path@1.1.6";
import { assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { loadCluster } from "../../src/config.ts";
import { __internal } from "../../src/history.ts";
import { buildPlan } from "../../src/planning.ts";
import { ConfigurationError } from "../../src/errors.ts";
import type { SourceImporter } from "../../src/history.ts";

const importer: SourceImporter = (_provider, envelope) =>
  envelope.payload as Readonly<Record<string, unknown>>;

Deno.test("integration/environment management history: plan v4 round-trips builtin declarations", async () => {
  await withTempDir(async (root) => {
    const clusterDirectory = join(root, "demo");
    const environmentDirectory = join(clusterDirectory, "environments", "runtime");
    await Deno.mkdir(join(environmentDirectory, "scripts"), { recursive: true });
    await Deno.writeTextFile(
      join(environmentDirectory, "environment.yaml"),
      `schema_version: 1
name: runtime
version: "1"
requires_privilege: true
install:
  kind: package
  manager: auto
  packages: [nginx]
manager:
  kind: system
  name: nginx
  tool: auto
  enabled: true
`,
    );
    await Deno.writeTextFile(
      join(clusterDirectory, "cluster.yaml"),
      `schema_version: 2
name: demo
executor_region: local
environments:
  runtime: [node-a]
apps: {}
`,
    );
    await Deno.writeTextFile(
      join(clusterDirectory, "machines.yaml"),
      `schema_version: 1
machines:
  - name: node-a
    private_ip: [10.0.0.1]
    public_ip: [203.0.113.10]
    region: local
    ssh_user: deploy
    deno: /usr/bin/deno
`,
    );
    const cluster = await loadCluster(clusterDirectory);
    const plan = buildPlan(cluster, { action: "prepare" });
    const snapshot = join(root, "snapshot");
    await Deno.mkdir(snapshot, { recursive: true });
    const archive = {
      add: async (source: string) => {
        const relative = `files/${basename(source)}`;
        await Deno.mkdir(join(snapshot, "files"), { recursive: true });
        await Deno.writeTextFile(join(snapshot, relative), await Deno.readTextFile(source));
        return relative;
      },
    } as Parameters<typeof __internal.encodePlan>[1];
    const encoded = await __internal.encodePlan(
      plan,
      archive,
      (_provider, source) => ({ schema: "fixture.v1", payload: source }),
      4,
    ) as Record<string, unknown>;
    const encodedSteps = encoded.steps as Array<Record<string, Record<string, unknown>>>;
    assertEquals(encodedSteps[0].environment_install.kind, "package");
    assertEquals(encodedSteps[1].environment_manager.kind, "system");
    const decoded = await __internal.decodePlan(encoded, snapshot, clusterDirectory, importer);
    assertEquals(decoded.steps[0].environmentInstall, {
      kind: "package",
      manager: "auto",
      packages: ["nginx"],
      updateCache: false,
    });
    assertEquals(decoded.steps[1].environmentManager?.kind, "system");
  });
});

Deno.test("integration/environment management history: script manager stop round-trips", async () => {
  await withTempDir(async (root) => {
    const clusterDirectory = join(root, "demo");
    const environmentDirectory = join(clusterDirectory, "environments", "runtime");
    await Deno.mkdir(join(environmentDirectory, "scripts"), { recursive: true });
    await Deno.writeTextFile(
      join(environmentDirectory, "environment.yaml"),
      `schema_version: 1
name: runtime
version: "1"
requires_privilege: true
install:
  kind: package
  manager: auto
  packages: [nginx]
manager:
  kind: script
  start: {path: scripts/action.ts, permissions: {run: [], net: []}}
  stop: {path: scripts/action.ts, permissions: {run: [], net: []}}
  restart: {path: scripts/action.ts, permissions: {run: [], net: []}}
`,
    );
    await Deno.writeTextFile(
      join(environmentDirectory, "scripts", "action.ts"),
      "Deno.exit(0);\n",
    );
    await Deno.writeTextFile(
      join(clusterDirectory, "cluster.yaml"),
      `schema_version: 2
name: demo
executor_region: local
environments:
  runtime: [node-a]
apps: {}
`,
    );
    await Deno.writeTextFile(
      join(clusterDirectory, "machines.yaml"),
      `schema_version: 1
machines:
  - name: node-a
    private_ip: [10.0.0.1]
    public_ip: [203.0.113.10]
    region: local
    ssh_user: deploy
    deno: /usr/bin/deno
`,
    );
    const cluster = await loadCluster(clusterDirectory);
    const plan = buildPlan(cluster, { action: "stop" });
    const snapshot = join(root, "snapshot");
    await Deno.mkdir(snapshot, { recursive: true });
    const archive = {
      add: async (source: string) => {
        const relative = `files/${basename(source)}`;
        await Deno.mkdir(join(snapshot, "files"), { recursive: true });
        await Deno.writeTextFile(join(snapshot, relative), await Deno.readTextFile(source));
        return relative;
      },
    } as Parameters<typeof __internal.encodePlan>[1];
    const encoded = await __internal.encodePlan(
      plan,
      archive,
      (_provider, source) => ({ schema: "fixture.v1", payload: source }),
      4,
    ) as Record<string, unknown>;
    const step = (encoded.steps as Array<Record<string, Record<string, unknown>>>)[0];
    assertEquals(step.environment_manager.kind, "script");
    const decoded = await __internal.decodePlan(encoded, snapshot, clusterDirectory, importer);
    assertEquals(decoded.steps[0].environmentManager?.kind, "script");
    assertEquals(
      decoded.steps[0].environmentManager?.kind === "script"
        ? decoded.steps[0].environmentManager.stop !== undefined
        : false,
      true,
    );

    delete step.environment_manager.stop;
    const error = await assertRejects(
      () => __internal.decodePlan(encoded, snapshot, clusterDirectory, importer),
      ConfigurationError,
    );
    assertEquals(error.message, "environment_manager 字段不匹配");
  });
});
