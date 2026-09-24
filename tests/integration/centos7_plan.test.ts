import { join } from "jsr:@std/path@1.1.6";
import { PlanningError } from "../../src/errors.ts";
import { run, RunOptions } from "../../src/integration.ts";
import type { Transport } from "../../src/transport.ts";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";

const noNetwork: Transport = {
  connect() {
    throw new Error("plan must remain offline");
  },
};

async function writeScriptlessCluster(root: string): Promise<string> {
  const cluster = await writeCluster(root);
  await Deno.writeTextFile(
    join(cluster, "environments", "base", "environment.yaml"),
    'schema_version: 1\nname: base\nversion: "1"\ndepends_on: []\nscripts: {}\n',
  );
  return cluster;
}

async function disableDeno(cluster: string): Promise<void> {
  const path = join(cluster, "machines.yaml");
  await Deno.writeTextFile(
    path,
    (await Deno.readTextFile(path)).replace(
      "    deno: /usr/bin/deno\n",
      "    deno: /usr/bin/deno\n    enable_deno: false\n",
    ),
  );
}

Deno.test("integration/machine-deno-policy: scriptless release plans offline when disabled", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeScriptlessCluster(root);
    await disableDeno(cluster);
    const result = await run(
      new RunOptions({ configRoot: root, cluster: "demo", action: "plan", apps: ["demo"] }),
      { transport: noNetwork },
    );
    assertEquals("steps" in result, true);
  });
});

Deno.test("integration/machine-deno-policy: secret rendering is rejected without SSH", async () => {
  await withTempDir(async (root) => {
    const cluster = await writeScriptlessCluster(root);
    await disableDeno(cluster);
    const clusterPath = join(cluster, "cluster.yaml");
    await Deno.writeTextFile(
      clusterPath,
      `${await Deno.readTextFile(
        clusterPath,
      )}secrets:\n  DB_PASSWORD:\n    kind: value\n    machines: [node-a]\n`,
    );
    await Deno.writeTextFile(
      join(cluster, "apps", "demo", "templates", "application.json"),
      '{"password":"${DB_PASSWORD}"}\n',
    );
    const error = await assertRejects(
      () =>
        run(
          new RunOptions({ configRoot: root, cluster: "demo", action: "plan", apps: ["demo"] }),
          { transport: noNetwork },
        ),
      PlanningError,
    );
    assertStringIncludes(error.message, "node-a");
    assertStringIncludes(error.message, "/etc/demo/application.json");
    assertStringIncludes(error.message, "DB_PASSWORD");
  });
});

Deno.test("integration/machine-deno-policy: default-enabled plan stays offline", async () => {
  await withTempDir(async (root) => {
    await writeScriptlessCluster(root);
    const result = await run(
      new RunOptions({ configRoot: root, cluster: "demo", action: "plan", apps: ["demo"] }),
      { transport: noNetwork },
    );
    assertEquals("steps" in result, true);
  });
});
