import { join } from "jsr:@std/path@1.1.6";
import { assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { loadCluster } from "../../src/config.ts";
import { ConfigurationError, PreflightError } from "../../src/errors.ts";
import { buildPlan } from "../../src/planning.ts";
import { generateConfigSkeleton } from "../../src/config_generation.ts";

async function clusterWithMachines(root: string): Promise<string> {
  const directory = await writeCluster(root);
  const machinesPath = join(directory, "machines.yaml");
  await Deno.writeTextFile(
    machinesPath,
    (await Deno.readTextFile(machinesPath)) +
      "  - name: db-1\n    private_ip: [10.2.0.8, 10.2.0.9]\n    public_ip: 203.0.113.8\n    region: local\n    ssh_user: deploy\n" +
      "  - name: DB_HOST\n    private_ip: 10.2.0.10\n    public_ip: 203.0.113.10\n    region: local\n    ssh_user: deploy\n",
  );
  const clusterPath = join(directory, "cluster.yaml");
  await Deno.writeTextFile(
    clusterPath,
    (await Deno.readTextFile(clusterPath)) +
      "secrets:\n  DB_HOST:\n    kind: value\n    machines: [node-a]\n",
  );
  return directory;
}

Deno.test("dv/machine-config: cluster load binds referenced machine, secret and built-in version", async () => {
  await withTempDir(async (root) => {
    const directory = await clusterWithMachines(root);
    await Deno.writeTextFile(
      join(directory, "apps", "demo", "templates", "application.json"),
      '{"db":"${db-1}","secret":"${DB_HOST}","version":"${APP_VERSION}"}\n',
    );
    const cluster = await loadCluster(directory);
    const config = cluster.apps.get("demo")!.management!.configs[0];
    assertEquals([...config.machineReferences!.keys()], ["db-1"]);
    assertEquals(config.machineReferences!.get("db-1")?.privateIp, ["10.2.0.8", "10.2.0.9"]);
    assertEquals([...config.secretReferences.keys()], ["DB_HOST"]);
    const step = buildPlan(cluster, { action: "deploy", apps: ["demo"] }).steps
      .find((item) => item.kind === "app")!;
    const skeleton = await generateConfigSkeleton(config, step.parameters, step.machine.machine.region);
    const text = new TextDecoder().decode(skeleton.content);
    assertEquals(text.includes("10.2.0.8"), true);
    assertEquals(text.includes("1.0.0"), true);
    assertEquals(text.includes("${DB_HOST}"), false);
    assertEquals(skeleton.secretBindings.map((item) => item.secret), ["DB_HOST"]);
  });
});

Deno.test("dv/machine-config: unknown machine fails during cluster load", async () => {
  await withTempDir(async (root) => {
    const directory = await clusterWithMachines(root);
    const source = join(directory, "apps", "demo", "templates", "application.json");
    await Deno.writeTextFile(source, '{"db":"${missing-db}"}\n');
    await assertRejects(() => loadCluster(directory), ConfigurationError, "neither a declared secret nor a cluster machine");
  });
});

Deno.test("dv/machine-config: nginx accepts machine names but keeps secret restriction", async () => {
  await withTempDir(async (root) => {
    const directory = await clusterWithMachines(root);
    const appPath = join(directory, "apps", "demo", "app.yaml");
    await Deno.writeTextFile(
      appPath,
      (await Deno.readTextFile(appPath)).replace("format: json", "format: nginx"),
    );
    const source = join(directory, "apps", "demo", "templates", "application.json");
    await Deno.writeTextFile(source, "upstream db { server ${db-1}:3306; }\n");
    const cluster = await loadCluster(directory);
    const config = cluster.apps.get("demo")!.management!.configs[0];
    assertEquals([...config.machineReferences!.keys()], ["db-1"]);
    await Deno.writeTextFile(source, "upstream db { server ${DB_HOST}:3306; }\n");
    await assertRejects(() => loadCluster(directory), PreflightError, "does not support the placeholder");
  });
});
