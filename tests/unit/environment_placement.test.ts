import { join } from "jsr:@std/path@1.1.6";

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { replaceInFile, writePlacementCluster } from "../_support/environment_placement.ts";
import { loadCluster } from "../../src/config.ts";
import { ConfigurationError } from "../../src/errors.ts";

async function configurationFailure(
  mutate: (cluster: string) => Promise<void>,
): Promise<ConfigurationError> {
  return await withTempDir(async (root) => {
    const cluster = await writePlacementCluster(root);
    await mutate(cluster);
    return await assertRejects(() => loadCluster(cluster), ConfigurationError);
  });
}

Deno.test("unit/environment placement v2: shared definitions normalize to stable per-machine instances", async () => {
  await withTempDir(async (root) => {
    const directory = await writePlacementCluster(root, {
      machines: ["node-b", "node-a"],
      environments: [
        {
          name: "runtime",
          machines: ["node-b", "node-a"],
          version: "2",
          defaults: { channel: "stable" },
          parameters: { flavor: "server" },
        },
        { name: "cache", machines: ["node-b"] },
      ],
      apps: [],
    });
    const cluster = await loadCluster(directory);

    assertEquals([...cluster.environments.keys()], [
      "node-b/cache",
      "node-a/runtime",
      "node-b/runtime",
    ]);
    assertEquals(cluster.machines.get("node-a")?.environments.map((item) => item.name), [
      "runtime",
    ]);
    assertEquals(cluster.machines.get("node-b")?.environments.map((item) => item.name), [
      "cache",
      "runtime",
    ]);
    assertEquals(cluster.machines.get("node-a")?.environments[0].version, "2");
    assertEquals({ ...cluster.machines.get("node-a")?.environments[0].parameters }, {
      flavor: "server",
    });
    const nodeA = cluster.environments.get("node-a/runtime")!;
    const nodeB = cluster.environments.get("node-b/runtime")!;
    assertEquals(nodeA.directory, nodeB.directory);
    assertStringIncludes(nodeA.directory, "/environments/runtime");
    assertStringIncludes(
      nodeA.scripts.actions.get("configure")![0].source,
      "/environments/runtime/scripts/action.ts",
    );
    assertEquals({ ...nodeA.defaults }, { channel: "stable" });
    assertEquals(cluster.placements.size, 0);
  });
});

Deno.test("unit/environment placement v2: an explicitly empty mapping is valid only without definitions", async () => {
  await withTempDir(async (root) => {
    const empty = await writePlacementCluster(root, { environments: [], apps: [] });
    const cluster = await loadCluster(empty);
    assertEquals(cluster.environments.size, 0);
    assertEquals(cluster.machines.get("node-a")?.environments, []);
  });

  const error = await configurationFailure(async (cluster) => {
    await replaceInFile(join(cluster, "cluster.yaml"), "  base: [node-a]", "  {}");
  });
  assertStringIncludes(error.message, 'missing=["base"]');
});

Deno.test("unit/environment placement v2: missing, extra, empty, duplicate and unknown placements fail closed", async () => {
  const cases: readonly [string, (cluster: string) => Promise<void>, string][] = [
    [
      "missing mapping",
      (cluster) =>
        replaceInFile(join(cluster, "cluster.yaml"), "  base: [node-a]", "  ghost: [node-a]"),
      'missing=["base"] unknown=["ghost"]',
    ],
    [
      "empty target list",
      (cluster) => replaceInFile(join(cluster, "cluster.yaml"), "base: [node-a]", "base: []"),
      "requires at least one target machine",
    ],
    [
      "duplicate target",
      (cluster) =>
        replaceInFile(
          join(cluster, "cluster.yaml"),
          "base: [node-a]",
          "base: [node-a, node-a]",
        ),
      "contains a duplicate value: node-a",
    ],
    [
      "unknown target",
      (cluster) => replaceInFile(join(cluster, "cluster.yaml"), "base: [node-a]", "base: [node-z]"),
      "references unknown machines: node-z",
    ],
    [
      "non-list target",
      (cluster) => replaceInFile(join(cluster, "cluster.yaml"), "base: [node-a]", "base: node-a"),
      "cluster.yaml.environments.base must be a list",
    ],
    [
      "invalid environment key",
      (cluster) =>
        replaceInFile(join(cluster, "cluster.yaml"), "base: [node-a]", "bad/name: [node-a]"),
      "is not a valid name",
    ],
    [
      "missing definition file",
      async (cluster) => {
        await Deno.remove(join(cluster, "environments", "base", "environment.yaml"));
      },
      "requires a shared definition: environments/base/environment.yaml",
    ],
  ];

  for (const [label, mutate, expected] of cases) {
    const error = await configurationFailure(mutate);
    assertStringIncludes(error.message, expected, label);
  }
});

Deno.test("unit/environment placement: unknown versions, required fields and v1 layouts are rejected at the schema gate", async () => {
  const cases: readonly [string, () => Promise<ConfigurationError>, string][] = [
    [
      "unknown schema",
      () =>
        configurationFailure((cluster) =>
          replaceInFile(join(cluster, "cluster.yaml"), "schema_version: 2", "schema_version: 3")
        ),
      "cluster.yaml.schema_version supports only 2",
    ],
    [
      "v2 missing environments field",
      () =>
        configurationFailure((cluster) =>
          replaceInFile(
            join(cluster, "cluster.yaml"),
            "environments:\n  base: [node-a]\n",
            "",
          )
        ),
      "is missing fields: environments",
    ],
    [
      "cluster v1 layout rejected",
      () =>
        withTempDir(async (root) => {
          const cluster = await writePlacementCluster(root, { schemaVersion: 1 });
          return await assertRejects(() => loadCluster(cluster), ConfigurationError);
        }),
      "cluster.yaml.schema_version supports only 2",
    ],
    [
      "cluster v1 layout with v2 field rejected at schema gate",
      () =>
        withTempDir(async (root) => {
          const cluster = await writePlacementCluster(root, { schemaVersion: 1 });
          await replaceInFile(
            join(cluster, "cluster.yaml"),
            "executor_region: local\n",
            "executor_region: local\nenvironments: {}\n",
          );
          return await assertRejects(() => loadCluster(cluster), ConfigurationError);
        }),
      "cluster.yaml.schema_version supports only 2",
    ],
    [
      "v2 rejects v1 layout",
      () =>
        configurationFailure(async (cluster) => {
          await Deno.mkdir(join(cluster, "environments", "node-a", "legacy"), {
            recursive: true,
          });
          await Deno.writeTextFile(
            join(cluster, "environments", "node-a", "legacy", "environment.yaml"),
            'schema_version: 1\nname: legacy\nversion: "1"\nscripts: {}\n',
          );
        }),
      "schema_version 2 does not allow the v1 Environment layout",
    ],
  ];

  for (const [label, run, expected] of cases) {
    const error = await run();
    assertStringIncludes(error.message, expected, label);
  }
});

Deno.test("unit/environment placement v2: definition identity and contained resources stay strict", async () => {
  const nameError = await configurationFailure((cluster) =>
    replaceInFile(
      join(cluster, "environments", "base", "environment.yaml"),
      "name: base",
      "name: renamed",
    )
  );
  assertStringIncludes(nameError.message, "Environment name renamed must match directory base");

  const pathError = await configurationFailure((cluster) =>
    replaceInFile(
      join(cluster, "environments", "base", "environment.yaml"),
      "scripts/action.ts",
      "../outside.ts",
    )
  );
  assertStringIncludes(pathError.message, "must be inside the resource directory");
});

Deno.test("unit/environment placement v2: local and explicit cross-machine dependencies resolve per placement", async () => {
  await withTempDir(async (root) => {
    const directory = await writePlacementCluster(root, {
      machines: ["node-a", "node-b"],
      environments: [
        { name: "base", machines: ["node-a", "node-b"] },
        { name: "local-runtime", machines: ["node-b"], dependsOn: ["base"] },
        { name: "remote-runtime", machines: ["node-b"], dependsOn: ["node-a/base"] },
      ],
      apps: [
        { name: "local-app", machines: ["node-b"], dependsOn: ["base"] },
        { name: "remote-app", machines: ["node-b"], dependsOn: ["node-a/base"] },
      ],
    });
    const cluster = await loadCluster(directory);
    assertEquals(cluster.machines.get("node-b")?.environments.map((item) => item.name), [
      "base",
      "local-runtime",
      "remote-runtime",
    ]);
  });

  await withTempDir(async (root) => {
    const localMissing = await writePlacementCluster(root, {
      machines: ["node-a", "node-b"],
      environments: [
        { name: "base", machines: ["node-a"] },
        { name: "runtime", machines: ["node-b"], dependsOn: ["base"] },
      ],
      apps: [],
    });
    const error = await assertRejects(() => loadCluster(localMissing), ConfigurationError);
    assertStringIncludes(
      error.message,
      "node-b/runtime references an unknown environment instance: base",
    );
  });

  await withTempDir(async (root) => {
    const explicitMissing = await writePlacementCluster(root, {
      machines: ["node-a", "node-b"],
      environments: [{ name: "base", machines: ["node-a"] }],
      apps: [{ name: "demo", machines: ["node-b"], dependsOn: ["node-z/base"] }],
    });
    const error = await assertRejects(() => loadCluster(explicitMissing), ConfigurationError);
    assertStringIncludes(
      error.message,
      "App demo on node-b references an unknown environment instance: node-z/base",
    );
  });
});

Deno.test("unit/environment placement v1: legacy per-machine layout and inline apps are rejected", async () => {
  await withTempDir(async (root) => {
    const directory = await writePlacementCluster(root, {
      schemaVersion: 1,
      machines: ["node-b", "node-a"],
      environments: [{ name: "base", machines: ["node-b", "node-a"] }],
      apps: [{ name: "demo", machines: ["node-a"], dependsOn: ["base"] }],
    });
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "cluster.yaml.schema_version supports only 2");
    assertStringIncludes(error.message, "the v1 per-machine environment layout was removed");
  });

  await withTempDir(async (root) => {
    const noEnvironmentDirectory = await writePlacementCluster(root, {
      schemaVersion: 1,
      environments: [],
      apps: [],
    });
    const error = await assertRejects(
      () => loadCluster(noEnvironmentDirectory),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "cluster.yaml.schema_version supports only 2");
  });

  await withTempDir(async (root) => {
    const v1App = await writePlacementCluster(root, {
      environments: [],
      apps: [{ name: "demo", machines: ["node-a"] }],
    });
    await Deno.writeTextFile(
      join(v1App, "apps", "demo", "app.yaml"),
      'schema_version: 1\nname: demo\nversion: "1.0.0"\npackage:\n  provider: http\n  source: {url: "https://example.invalid/app.bin"}\n  hash: {algorithm: sha256, value: "' +
        "00".repeat(32) +
        '"}\ndepends_on: []\nmanagement:\n  kind: service\n  name: demo.service\n  tool: systemctl\n',
    );
    const error = await assertRejects(() => loadCluster(v1App), ConfigurationError);
    assertStringIncludes(error.message, "app[demo] contains unknown fields: package, version");
  });
});
