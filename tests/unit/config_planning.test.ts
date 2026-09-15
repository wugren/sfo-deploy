import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { join } from "jsr:@std/path@1.1.6";
import { writeCluster } from "../_support/fixtures.ts";
import { loadCluster } from "../../src/config.ts";
import { ConfigurationError, PlanningError } from "../../src/errors.ts";
import { buildPlan, resolveMachine } from "../../src/planning.ts";

Deno.test("unit/config: strict YAML loads immutable values and preserves multiple IPs", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const cluster = await loadCluster(directory);
    assertEquals(cluster.name, "demo");
    assertEquals(cluster.machines.get("node-a")?.privateIp, ["10.0.0.1", "10.0.0.2"]);
    assertEquals((cluster.machines as Map<string, unknown>).set, undefined);
    assertEquals(resolveMachine(cluster, "node-a").address, "10.0.0.1");
    assertEquals(
      resolveMachine(cluster, "node-a", { addressKind: "public" }).address,
      "203.0.113.10",
    );
  });
});

Deno.test("unit/config: app_versions.yaml merges version/package into v2 app definitions", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const cluster = await loadCluster(directory);
    const app = cluster.apps.get("demo");
    assertEquals(app?.version, "1.0.0");
    assertEquals(app?.installDirectory, "/srv/demo");
    assertEquals(app?.package?.provider, "http");
    assertEquals(app?.package?.hashValue, "00".repeat(32));
    const appYaml = await Deno.readTextFile(`${directory}/apps/demo/app.yaml`);
    assert(!appYaml.includes('version: "1.0.0"'));
    assert(!appYaml.includes("package:"));
  });
});

Deno.test("unit/config: app without app_versions.yaml fails closed", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root, { appV1Inline: true });
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(
      error.message,
      "App demo uses schema 1, but the cluster is missing app_versions.yaml",
    );
  });
});

Deno.test("unit/config: app_versions.yaml and install_directory are fail-closed", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    await Deno.writeTextFile(
      `${directory}/apps/demo/app.yaml`,
      `schema_version: 1\nname: demo\nversion: "1.0.0"\npackage:\n  provider: http\n  source: {url: "https://example.invalid/demo.bin"}\n  hash: {algorithm: sha256, value: "${
        "00".repeat(32)
      }"}\ndepends_on: [base]\nmanagement:\n  run_as: deploy\n  kind: service\n  name: demo.service\n  tool: systemctl\n`,
    );
    const mixing = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(mixing.message, "app[demo] contains unknown fields: package, version");

    await Deno.remove(directory, { recursive: true });
    const missingEntry = await writeCluster(root);
    await Deno.writeTextFile(
      `${missingEntry}/app_versions.yaml`,
      "schema_version: 1\napps: {}\n",
    );
    const missing = await assertRejects(() => loadCluster(missingEntry), ConfigurationError);
    assertStringIncludes(missing.message, "is missing a version record for App demo");

    await Deno.writeTextFile(
      `${missingEntry}/app_versions.yaml`,
      `schema_version: 1\napps:\n  demo:\n    version: "1.0.0"\n    package:\n      provider: http\n      source: {url: "https://example.invalid/demo.bin"}\n      hash: {algorithm: sha256, value: "${
        "00".repeat(32)
      }"}\n  ghost: {version: "1.0.0", package: {provider: http, source: {url: "https://example.invalid/x"}, hash: {algorithm: sha256, value: "${
        "00".repeat(32)
      }"}}}\n`,
    );
    const extra = await assertRejects(() => loadCluster(missingEntry), ConfigurationError);
    assertStringIncludes(extra.message, "declares unknown Apps");

    const appYamlPath = join(missingEntry, "apps", "demo", "app.yaml");
    await Deno.writeTextFile(
      appYamlPath,
      (await Deno.readTextFile(appYamlPath)).replace(
        "install_directory: /srv/demo",
        "install_directory: relative/path",
      ),
    );
    const relative = await assertRejects(() => loadCluster(missingEntry), ConfigurationError);
    assertStringIncludes(relative.message, "remote absolute POSIX");
  });
});

Deno.test("unit/config: unknown YAML fields fail before planning", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root, { unknownField: true });
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "unknown fields");
  });
});

async function replaceInFile(path: string, from: string, to: string): Promise<void> {
  await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace(from, to));
}

async function addPackagelessApp(directory: string) {
  const appName = "config";
  await Deno.mkdir(join(directory, "apps", appName, "templates"), { recursive: true });
  await Deno.writeTextFile(
    join(directory, "apps", appName, "templates", "settings.json"),
    "{}\n",
  );
  await Deno.writeTextFile(
    join(directory, "apps", appName, "app.yaml"),
    `schema_version: 1\nname: ${appName}\npackageless: true\nconfigs:\n  - kind: file\n    source: templates/settings.json\n    target: /etc/${appName}/settings.json\n    format: json\nmanagement:\n  run_as: deploy\n  kind: service\n  name: ${appName}.service\n  tool: systemctl\n`,
  );
  await replaceInFile(
    join(directory, "cluster.yaml"),
    "apps:\n  demo: [node-a]",
    `apps:\n  demo: [node-a]\n  ${appName}: [node-a]`,
  );
  return directory;
}

Deno.test("unit/config: packageless app loads without version or package and plans configure", async () => {
  await withTempDir(async (root) => {
    const directory = await addPackagelessApp(await writeCluster(root));
    const cluster = await loadCluster(directory);
    const app = cluster.apps.get("config");
    assertEquals(app?.packageless, true);
    assertEquals(app?.version, undefined);
    assertEquals(app?.package, undefined);
    assertEquals(app?.installDirectory, undefined);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["config"] });
    assertEquals(plan.steps.map((step) => step.id), [
      "app:node-a/config:configure",
    ]);
    assertEquals(plan.steps.map((step) => step.package), [undefined]);
    assertEquals({ ...plan.steps[0].parameters }, {});
  });
});

Deno.test("unit/config: packageless app constraints fail closed", async () => {
  await withTempDir(async (root) => {
    const directory = await addPackagelessApp(await writeCluster(root));
    await replaceInFile(
      join(directory, "app_versions.yaml"),
      "apps:\n",
      `apps:\n  config:\n    version: "1.0.0"\n    package:\n      provider: http\n      source: {url: "https://example.invalid/x"}\n      hash: {algorithm: sha256, value: "${
        "00".repeat(32)
      }"}\n`,
    );
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "must not have app_versions.yaml version records");
  });
});

Deno.test("unit/config: duplicate YAML keys and resource path escape fail closed", async () => {
  await withTempDir(async (root) => {
    const duplicate = await writeCluster(root);
    await Deno.writeTextFile(
      `${duplicate}/cluster.yaml`,
      "schema_version: 1\nname: demo\nname: shadow\nexecutor_region: local\napps: {}\n",
    );
    await assertRejects(() => loadCluster(duplicate), ConfigurationError);

    await Deno.remove(duplicate, { recursive: true });
    const escaped = await writeCluster(root);
    const appPath = `${escaped}/apps/demo/app.yaml`;
    const app = await Deno.readTextFile(appPath);
    await Deno.writeTextFile(appPath, app.replace("templates/application.json", "../outside.json"));
    const error = await assertRejects(() => loadCluster(escaped), ConfigurationError);
    assertStringIncludes(error.message, "inside the resource directory");
  });
});

Deno.test("unit/planning: configure uses dependency order and stable action chains", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeCluster(root));
    const plan = buildPlan(cluster, {
      action: "configure",
      apps: ["demo"],
      withDependencies: true,
    });
    assertEquals(plan.schemaVersion, 4);
    assertEquals(plan.steps.map((step) => `${step.kind}:${step.action}`), [
      "environment:check",
      "environment:install",
      "environment:configure",
      "app:configure",
    ]);
    assertEquals(plan.steps.at(-1)?.dependsOn, ["env:node-a/base:configure"]);
  });
});

Deno.test("unit/planning: filters reject unknown and excluded dependencies", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeCluster(root));
    await Promise.resolve().then(() => {
      try {
        buildPlan(cluster, { action: "deploy", machines: ["missing"] });
        throw new Error("expected PlanningError");
      } catch (error) {
        if (!(error instanceof PlanningError)) throw error;
        assertStringIncludes(error.message, "Unknown machine filter");
      }
    });
    const directed = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(directed.steps.map((step) => `${step.kind}:${step.action}`), [
      "app:stage",
      "app:activate",
    ]);
  });
});

Deno.test("unit/planning: deploy plans apps only and omits environment dependencies", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(
      await writeCluster(root, {
        envActions: ["check", "install"],
        appConfigure: false,
      }),
    );
    const plan = buildPlan(cluster, {
      action: "deploy",
      apps: ["demo"],
      withDependencies: true,
    });
    assertEquals(plan.steps.map((step) => step.id), [
      "app:node-a/demo:stage",
      "app:node-a/demo:activate",
    ]);
    assertEquals(plan.steps.at(-1)?.dependsOn, ["app:node-a/demo:stage"]);
  });
});

Deno.test("unit/planning: deploy --no-activate stages only and skips activation", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(await writeCluster(root));
    const full = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(full.steps.map((step) => step.action), ["stage", "activate"]);
    const staged = buildPlan(cluster, {
      action: "deploy",
      apps: ["demo"],
      activate: false,
    });
    assertEquals(staged.steps.map((step) => step.action), ["stage"]);
    assertEquals(staged.steps.at(-1)?.dependsOn, []);
    assertEquals(staged.steps[0].machine.machine.name, "node-a");
    assertEquals(staged.steps[0].resource, "demo");
  });
});
