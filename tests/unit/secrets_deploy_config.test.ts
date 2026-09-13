import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { buildPlan, loadCluster } from "../../src/mod.ts";
import { ConfigurationError } from "../../src/errors.ts";

async function withSecretsCluster(
  root: string,
  secrets: string,
  mutations: (directory: string) => Promise<void> = () => Promise.resolve(),
): Promise<string> {
  const directory = await writeCluster(root);
  const clusterPath = join(directory, "cluster.yaml");
  await Deno.writeTextFile(clusterPath, `${await Deno.readTextFile(clusterPath)}${secrets}\n`);
  await mutations(directory);
  return directory;
}

Deno.test("unit/secrets config: cluster placements accept lists and wildcard with kinds", async () => {
  await withTempDir(async (root) => {
    const directory = await withSecretsCluster(
      root,
      "secrets:\n  DB_PASSWORD:\n    kind: value\n    machines: [node-a]\n" +
        "  TLS_KEY:\n    kind: file\n    machines: '*'\n",
    );
    const cluster = await loadCluster(directory);
    assertEquals(cluster.secrets.size, 2);
    assertEquals(cluster.secrets.get("DB_PASSWORD")?.kind, "value");
    assertEquals(cluster.secrets.get("TLS_KEY")?.machines, ["node-a"]);
    assertEquals(cluster.machines.get("node-a")?.secretsDir, undefined);
  });
});

Deno.test("unit/secrets config: invalid kinds, machines and duplicates fail closed", async () => {
  await withTempDir(async (root) => {
    await assertRejects(
      async () =>
        await loadCluster(
          await withSecretsCluster(
            root,
            "secrets:\n  BAD_KIND:\n    kind: env\n    machines: '*'",
          ),
        ),
      ConfigurationError,
      "only value or file",
    );
    await assertRejects(
      async () =>
        await loadCluster(
          await withSecretsCluster(
            root,
            "secrets:\n  MISSING_MACHINE:\n    kind: value\n    machines: [ghost]\n",
          ),
        ),
      ConfigurationError,
      "unknown machines",
    );
    await assertRejects(
      async () =>
        await loadCluster(
          await withSecretsCluster(
            root,
            "secrets:\n  bad_name:\n    kind: value\n    machines: '*'\n",
          ),
        ),
      ConfigurationError,
      "secret name",
    );
  });
});

Deno.test("unit/secrets config: app.yaml top-level secret declarations are rejected", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const appYaml = join(directory, "apps", "demo", "app.yaml");
    await Deno.writeTextFile(
      appYaml,
      (await Deno.readTextFile(appYaml)).replace(
        "management:\n",
        "secret_values: [DB_PASSWORD]\nmanagement:\n",
      ),
    );
    const error = await assertRejects(
      () => loadCluster(directory),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "secrets are declared only in cluster.yaml.secrets");
  });
});

Deno.test("unit/secrets config: environment definition top-level secret declarations are rejected", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const environmentYaml = join(directory, "environments", "base", "environment.yaml");
    await Deno.writeTextFile(
      environmentYaml,
      (await Deno.readTextFile(environmentYaml)).replace(
        "scripts:\n",
        "secret_values: [DB_PASSWORD]\nscripts:\n",
      ),
    );
    const error = await assertRejects(
      () => loadCluster(directory),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "secrets are declared only in cluster.yaml.secrets");
  });
});

Deno.test("unit/secrets config: machine secrets_dir accepts ~/ and absolute POSIX paths only", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const machines = join(directory, "machines.yaml");
    await Deno.writeTextFile(
      machines,
      `schema_version: 1\nmachines:\n  - name: node-a\n    private_ip: [10.0.0.1]\n    public_ip: 203.0.113.10\n    region: local\n    ssh_user: deploy\n    ssh_port: 22\n    deno: /usr/bin/deno\n    secrets_dir: ~/.sfo-deploy/secrets/\n`,
    );
    const cluster = await loadCluster(directory);
    assertEquals(cluster.machines.get("node-a")?.secretsDir, "~/.sfo-deploy/secrets/");

    await Deno.writeTextFile(
      machines,
      `schema_version: 1\nmachines:\n  - name: node-a\n    private_ip: [10.0.0.1]\n    public_ip: 203.0.113.10\n    region: local\n    ssh_user: deploy\n    ssh_port: 22\n    deno: /usr/bin/deno\n    secrets_dir: relative/path\n`,
    );
    await assertRejects(
      () => loadCluster(directory),
      ConfigurationError,
      "must be a ~/ path or a safe absolute",
    );
  });
});

Deno.test("unit/secrets planning: steps carry only their declared secret subset", async () => {
  await withTempDir(async (root) => {
    const directory = await withSecretsCluster(
      root,
      "secrets:\n  DB_PASSWORD:\n    kind: value\n    machines: [node-a]\n" +
        "  TLS_KEY:\n    kind: file\n    machines: [node-a]\n",
    );
    const cluster = await loadCluster(directory);
    const plan = buildPlan(cluster, "deploy", { machines: ["node-a"] });
    for (const action of ["stage", "activate"] as const) {
      const step = plan.steps.find((item) => item.kind === "app" && item.action === action)!;
      assertEquals(step.secretValues, ["DB_PASSWORD"]);
      assertEquals(step.secretFiles, ["TLS_KEY"]);
    }
  });
});
