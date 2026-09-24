import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { join } from "jsr:@std/path@1.1.6";
import { loadCluster, TOOL_VERSION } from "../../src/config.ts";
import { ConfigurationError, DownloadError } from "../../src/errors.ts";
import { run } from "../../src/integration.ts";
import type { ValidationResult } from "../../src/integration.ts";
import type { ExecutionPlan } from "../../src/types.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { FakeTransport } from "../_support/fake_session.ts";

async function writeClusterWithDeployer(root: string, optional: string): Promise<string> {
  const directory = await writeCluster(root);
  const clusterYaml = await Deno.readTextFile(`${directory}/cluster.yaml`);
  await Deno.writeTextFile(
    `${directory}/cluster.yaml`,
    clusterYaml.replace("apps:\n  demo: [node-a]\n", `apps:\n  demo: [node-a]\n${optional}`),
  );
  return directory;
}

Deno.test("unit/deployer-version: loadCluster reads deployer_version and exposes it", async () => {
  await withTempDir(async (root) => {
    const directory = await writeClusterWithDeployer(root, `deployer_version: "1.2.3"\n`);
    const cluster = await loadCluster(directory);
    assertEquals(cluster.deployerVersion, "1.2.3");
  });
});

Deno.test("unit/deployer-version: deployer_version must be a non-empty string", async () => {
  await withTempDir(async (root) => {
    const directory = await writeClusterWithDeployer(root, "deployer_version: 42\n");
    const nonString = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(
      nonString.message,
      "cluster.yaml.deployer_version must be a non-empty string",
    );

    const emptyDir = await writeClusterWithDeployer(root, 'deployer_version: ""\n');
    const empty = await assertRejects(() => loadCluster(emptyDir), ConfigurationError);
    assertStringIncludes(empty.message, "cluster.yaml.deployer_version must be a non-empty string");

    const whitespaceDir = await writeClusterWithDeployer(root, 'deployer_version: "  "\n');
    const whitespace = await assertRejects(() => loadCluster(whitespaceDir), ConfigurationError);
    assertStringIncludes(whitespace.message, "must be a non-empty string");
  });
});

Deno.test("unit/deployer-version: padded values never trim to a matching version", async () => {
  await withTempDir(async (root) => {
    const directory = await writeClusterWithDeployer(
      root,
      `deployer_version: " ${TOOL_VERSION} "\n`,
    );
    const cluster = await loadCluster(directory);
    assertEquals(cluster.deployerVersion, ` ${TOOL_VERSION} `);
    const error = await assertRejects(
      () => run({ configRoot: root, cluster: "demo", action: "validate" }),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "requires sfo-deploy");
  });
});

Deno.test("unit/deployer-version: matching version allows validate/plan to proceed", async () => {
  await withTempDir(async (root) => {
    await writeClusterWithDeployer(
      root,
      `deployer_version: "${TOOL_VERSION}"\n`,
    );
    const validated = await run({
      configRoot: root,
      cluster: "demo",
      action: "validate",
    }) as ValidationResult;
    assertEquals(validated.cluster, "demo");

    const plan = await run({
      configRoot: root,
      cluster: "demo",
      action: "plan",
      apps: ["demo"],
    }, { transport: new FakeTransport() }) as ExecutionPlan;
    assertEquals(plan.requestedAction, "deploy");
  });
});

Deno.test("unit/deployer-version: mismatching version fails closed before any remote work", async () => {
  await withTempDir(async (root) => {
    const directory = await writeClusterWithDeployer(root, 'deployer_version: "0.0.0-not"');
    const error = await assertRejects(
      () =>
        run({
          configRoot: root,
          cluster: "demo",
          action: "validate",
        }),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "requires sfo-deploy 0.0.0-not");
    assertStringIncludes(error.message, TOOL_VERSION);

    const planError = await assertRejects(
      () =>
        run({
          configRoot: root,
          cluster: "demo",
          action: "plan",
          apps: ["demo"],
        }),
      ConfigurationError,
    );
    assertStringIncludes(planError.message, "requires sfo-deploy");
    assertEquals(await Deno.stat(`${directory}/.sfo-deploy/releases`).catch(() => null), null);
  });
});

Deno.test("unit/deployer-version: deploy with mismatching version fails before transport connects", async () => {
  await withTempDir(async (root) => {
    const directory = await writeClusterWithDeployer(root, 'deployer_version: "0.0.0-not"');
    let connects = 0;
    const transport = {
      connect: () => {
        connects += 1;
        return Promise.reject(new Error("must never be reached"));
      },
    };
    const error = await assertRejects(
      () =>
        run({
          configRoot: root,
          cluster: "demo",
          action: "deploy",
          apps: ["demo"],
        }, { transport, confirmPlan: () => true }),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "requires sfo-deploy 0.0.0-not");
    assertEquals(connects, 0);
    assertEquals(await Deno.stat(`${directory}/.sfo-deploy/releases`).catch(() => null), null);
  });
});

Deno.test("unit/deployer-version: absence of the field leaves behavior unchanged", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const cluster = await loadCluster(directory);
    assertEquals(cluster.deployerVersion, undefined);
    const validated = await run({
      configRoot: root,
      cluster: "demo",
      action: "validate",
    }) as ValidationResult;
    assertEquals(validated.cluster, "demo");
  });
});

Deno.test("unit/deployer-version: TOOL_VERSION is non-empty and pass-through actions are unaffected", async () => {
  assertEquals(typeof TOOL_VERSION, "string");
  assertEquals(TOOL_VERSION.length > 0, true);
  await withTempDir(async (root) => {
    const cacheDirectory = join(root, "cache");
    await Deno.mkdir(cacheDirectory, { recursive: true });
    await writeClusterWithDeployer(root, 'deployer_version: "9.9.9"');
    const error = await assertRejects(
      () =>
        run({
          configRoot: root,
          cluster: "demo",
          action: "fetch",
        }, {
          packagesDir: cacheDirectory,
        }),
      DownloadError,
    );
    assertStringIncludes(error.message, "download");
    assertEquals(String(error).includes("requires sfo-deploy"), false);
  });
});
