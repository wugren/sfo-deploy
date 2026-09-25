import { join } from "jsr:@std/path@1.1.6";
import { assert, assertEquals, withTempDir } from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { loadCluster } from "../../src/config.ts";
import { prepareExecution } from "../../src/execution.ts";
import { buildPlan } from "../../src/planning.ts";

Deno.test("integration/app service user: loaded config and prepared bundle inherit or select root", async () => {
  for (
    const { sshUser, unitUser, expected } of [
      { sshUser: "deploy", unitUser: undefined, expected: "deploy" },
      { sshUser: "root", unitUser: undefined, expected: "root" },
      { sshUser: "deploy", unitUser: "root", expected: "root" },
    ]
  ) {
    await withTempDir(async (root) => {
      const clusterDirectory = await writeCluster(root);
      const machinePath = join(clusterDirectory, "machines.yaml");
      await Deno.writeTextFile(
        machinePath,
        (await Deno.readTextFile(machinePath)).replace("ssh_user: deploy", `ssh_user: ${sshUser}`),
      );
      await Deno.writeTextFile(
        join(clusterDirectory, "apps", "demo", "app.yaml"),
        `schema_version: 1
name: demo
packageless: true
management:
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
  unit_config:
    working_directory: /srv/demo
    command: /srv/demo/bin/server
${unitUser === undefined ? "" : `    user: ${unitUser}\n`}`,
      );
      await Deno.writeTextFile(
        join(clusterDirectory, "app_versions.yaml"),
        "schema_version: 1\napps: {}\n",
      );
      const cluster = await loadCluster(clusterDirectory);
      const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
      const step = plan.steps.find((item) => item.kind === "app" && item.resource === "demo");
      assert(step !== undefined);
      assertEquals(step.machine.machine.sshUser, sshUser);
      const manager = step.management?.manager;
      assert(manager?.kind === "service");
      assertEquals(manager.unitConfig?.user, unitUser);

      const prepared = await prepareExecution(plan);
      try {
        const bundle = prepared.steps.get(step.id)?.deliveryBundle;
        assert(bundle !== undefined);
        const unitEntry = bundle.manifest.entries.find((item) =>
          item.purpose === "config-skeleton" && item.path.includes("sfo-systemd-demo.service")
        );
        assert(unitEntry !== undefined);
        const output = await new Deno.Command("tar", {
          args: ["-xOzf", bundle.path, unitEntry.path],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assertEquals(output.code, 0);
        const unit = new TextDecoder().decode(output.stdout);
        assertEquals(unit.includes(`\nUser=${expected}\n`), true);
      } finally {
        await prepared.close();
      }
    });
  }
});
