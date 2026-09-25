import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, assertRejects, withTempDir } from "../_support/assert.ts";
import { FakeTransport } from "../_support/fake_session.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { loadCluster } from "../../src/config.ts";
import { executePlan, prepareExecution } from "../../src/execution.ts";
import { PreflightError } from "../../src/errors.ts";
import { ReleaseSelection, ReleaseStore } from "../../src/history.ts";
import type { SourceExporter, SourceImporter } from "../../src/history.ts";
import { buildPlan } from "../../src/planning.ts";

const exporter: SourceExporter = (_provider, source) => ({
  schema: "http.v1",
  payload: source,
});
const importer: SourceImporter = (_provider, envelope) =>
  envelope.payload as Readonly<Record<string, unknown>>;

Deno.test("integration/machine-config: bundle contains cross-region public IP and archived rollback retains reference snapshot", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const machinePath = join(directory, "machines.yaml");
    await Deno.writeTextFile(
      machinePath,
      (await Deno.readTextFile(machinePath)).replace("region: local", "region: west") +
        "  - name: node-b\n    private_ip: 10.3.0.2\n    public_ip: 203.0.113.2\n    region: east\n    ssh_user: deploy\n" +
        "  - name: db-1\n    private_ip: 10.2.0.8\n    public_ip: 203.0.113.8\n    region: east\n    ssh_user: deploy\n",
    );
    const clusterPath = join(directory, "cluster.yaml");
    await Deno.writeTextFile(
      clusterPath,
      (await Deno.readTextFile(clusterPath)).replace(
        "demo: [node-a]",
        "demo: [node-a, node-b]",
      ),
    );
    await Deno.writeTextFile(
      join(directory, "app_versions.yaml"),
      "schema_version: 1\napps: {}\n",
    );
    await Deno.writeTextFile(
      join(directory, "apps", "demo", "app.yaml"),
      "schema_version: 1\nname: demo\npackageless: true\nconfigs:\n  - kind: file\n    source: templates/application.json\n    target: /etc/demo/application.json\n    format: json\n",
    );
    await Deno.writeTextFile(
      join(directory, "apps", "demo", "templates", "application.json"),
      '{"db":"${db-1}:5432"}\n',
    );
    const cluster = await loadCluster(directory);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    const appSteps = plan.steps.filter((step) => step.kind === "app" && step.resource === "demo");
    assertEquals(appSteps.length, 2);
    const prepared = await prepareExecution(plan);
    try {
      for (const step of appSteps) {
        const bundle = prepared.steps.get(step.id)?.deliveryBundle;
        assert(bundle !== undefined);
        const entry = bundle.manifest.entries.find((item) => item.purpose === "config-skeleton");
        assert(entry !== undefined);
        const output = await new Deno.Command("tar", {
          args: ["-xOzf", bundle.path, entry.path],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assertEquals(output.code, 0);
        const content = new TextDecoder().decode(output.stdout);
        const expected = step.machine.machine.name === "node-a" ? "203.0.113.8" : "10.2.0.8";
        assertEquals(content.includes(expected), true);
        assertEquals(content.includes("${db-1}"), false);
      }
    } finally {
      await prepared.close();
    }

    const store = new ReleaseStore(directory, {
      sourceExporter: exporter,
      sourceImporter: importer,
    });
    const pending = await store.beginAttempt({
      operation: "deploy",
      selection: new ReleaseSelection(),
    });
    try {
      await pending.archivePlans(plan);
      const snapshot = join(store.root, pending.releaseId, "snapshot");
      const archived = await store.readPlan(snapshot, "actual-plan.json");
      const rollback = await store.readPlan(snapshot, "rollback-plan.json");
      for (const restored of [archived, rollback]) {
        const reference = restored.steps.find((step) => step.kind === "app")
          ?.management?.configs[0].machineReferences?.get("db-1");
        assertEquals(reference?.region, "east");
        assertEquals(reference?.privateIp, ["10.2.0.8"]);
        assertEquals(reference?.publicIp, ["203.0.113.8"]);
      }
      const raw = await Deno.readTextFile(join(snapshot, "actual-plan.json"));
      assertEquals(raw.includes("machine_references"), true);
    } finally {
      await pending.closeIncomplete();
    }
  });
});

Deno.test("integration/machine-config: missing cross-region public IP fails before SSH", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const machinePath = join(directory, "machines.yaml");
    await Deno.writeTextFile(
      machinePath,
      (await Deno.readTextFile(machinePath)).replace("region: local", "region: west") +
        "  - name: db-1\n    private_ip: 10.2.0.8\n    region: east\n    ssh_user: deploy\n",
    );
    await Deno.writeTextFile(join(directory, "app_versions.yaml"), "schema_version: 1\napps: {}\n");
    await Deno.writeTextFile(
      join(directory, "apps", "demo", "app.yaml"),
      "schema_version: 1\nname: demo\npackageless: true\nconfigs:\n  - kind: file\n    source: templates/application.json\n    target: /etc/demo/application.json\n    format: json\n",
    );
    await Deno.writeTextFile(
      join(directory, "apps", "demo", "templates", "application.json"),
      '{"db":"${db-1}:5432"}\n',
    );
    const cluster = await loadCluster(directory);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    const transport = new FakeTransport();
    await assertRejects(
      () => executePlan(plan, { transport }),
      PreflightError,
      "no required public IP",
    );
    assertEquals(transport.connectCalls, 0);
  });
});
