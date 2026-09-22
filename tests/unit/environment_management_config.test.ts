import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { loadCluster } from "../../src/config.ts";
import { ConfigurationError } from "../../src/errors.ts";

async function writeLifecycleCluster(
  root: string,
  lifecycle: string,
  name = "runtime",
): Promise<string> {
  const cluster = join(root, "demo");
  const directory = join(cluster, "environments", name);
  await Deno.mkdir(join(directory, "scripts"), { recursive: true });
  await Deno.writeTextFile(join(directory, "scripts", "action.ts"), "Deno.exit(0);\n");
  await Deno.writeTextFile(join(directory, "environment.yaml"), lifecycle);
  await Deno.writeTextFile(
    join(cluster, "cluster.yaml"),
    `schema_version: 2
name: demo
executor_region: local
environments:
  ${name}: [node-a]
apps: {}
`,
  );
  await Deno.writeTextFile(
    join(cluster, "machines.yaml"),
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
  return cluster;
}

const packageLifecycle = `schema_version: 1
name: runtime
version: "1"
requires_privilege: true
install:
  kind: package
  manager: auto
  packages: [nginx]
  update_cache: false
`;

Deno.test("unit/environment management config: package install supports omitted manager", async () => {
  await withTempDir(async (root) => {
    const directory = await writeLifecycleCluster(root, packageLifecycle);
    const cluster = await loadCluster(directory);
    const definition = cluster.environments.get("node-a/runtime")!;
    assertEquals(definition.install, {
      kind: "package",
      manager: "auto",
      packages: ["nginx"],
      updateCache: false,
    });
    assertEquals(definition.manager, undefined);
    assertEquals(definition.scripts.actions.size, 0);
  });
});

Deno.test("unit/environment management config: script install and script manager normalize", async () => {
  await withTempDir(async (root) => {
    const lifecycle = `schema_version: 1
name: runtime
version: "1"
requires_privilege: true
install:
  kind: script
  path: scripts/action.ts
  permissions:
    run: [/usr/bin/apt-get]
    net: []
    read: [/etc/runtime/config.toml]
    write: [/var/lib/runtime]
manager:
  kind: script
  start:
    path: scripts/action.ts
    permissions:
      run: [/usr/bin/systemctl]
      net: []
  stop:
    path: scripts/action.ts
    permissions:
      run: [/usr/bin/systemctl]
      net: []
  restart:
    path: scripts/action.ts
    permissions:
      run: [/usr/bin/systemctl]
      net: []
`;
    const directory = await writeLifecycleCluster(root, lifecycle);
    const cluster = await loadCluster(directory);
    const definition = cluster.environments.get("node-a/runtime")!;
    if (definition.install?.kind !== "script") throw new Error("expected script install");
    assertEquals(definition.manager?.kind, "script");
    assertEquals(definition.install.invocation.permissions.read, ["/etc/runtime/config.toml"]);
    assertEquals(definition.install.invocation.permissions.write, ["/var/lib/runtime"]);
    assertEquals(
      definition.manager?.kind === "script"
        ? definition.manager.start.source.endsWith("action.ts")
        : false,
      true,
    );
  });
});

Deno.test("unit/environment management config: system manager defaults start_after_install", async () => {
  await withTempDir(async (root) => {
    const lifecycle = `${packageLifecycle}manager:
  kind: system
  name: nginx
  tool: auto
  enabled: true
  timeout_ms: 300000
`;
    const directory = await writeLifecycleCluster(root, lifecycle);
    const cluster = await loadCluster(directory);
    const definition = cluster.environments.get("node-a/runtime")!;
    assertEquals(definition.manager, {
      kind: "system",
      name: "nginx",
      tool: "auto",
      enabled: true,
      startAfterInstall: true,
      timeoutMs: 300000,
    });
  });
});

Deno.test("unit/environment management config: system manager defaults enabled on boot", async () => {
  await withTempDir(async (root) => {
    const lifecycle = `${packageLifecycle}manager:
  kind: system
  name: nginx
  tool: auto
  start_after_install: false
`;
    const directory = await writeLifecycleCluster(root, lifecycle);
    const cluster = await loadCluster(directory);
    const definition = cluster.environments.get("node-a/runtime")!;
    assertEquals(definition.manager?.kind, "system");
    if (definition.manager?.kind !== "system") throw new Error("expected system manager");
    assertEquals(definition.manager.enabled, true);
    assertEquals(definition.manager.startAfterInstall, false);
  });
});

Deno.test("unit/environment management config: system manager honors explicit disable", async () => {
  await withTempDir(async (root) => {
    const lifecycle = `${packageLifecycle}manager:
  kind: system
  name: nginx
  tool: auto
  enabled: false
`;
    const directory = await writeLifecycleCluster(root, lifecycle);
    const cluster = await loadCluster(directory);
    const definition = cluster.environments.get("node-a/runtime")!;
    assertEquals(definition.manager?.kind, "system");
    if (definition.manager?.kind !== "system") throw new Error("expected system manager");
    assertEquals(definition.manager.enabled, false);
  });
});

Deno.test("unit/environment management config: init before_start and after_start normalize", async () => {
  await withTempDir(async (root) => {
    const lifecycle = `${packageLifecycle}init:
  before_start:
    - path: scripts/action.ts
      permissions:
        run: [/usr/bin/systemctl]
        net: []
  after_start:
    - path: scripts/action.ts
      permissions:
        run: [/usr/bin/systemctl]
        net: []
`;
    const directory = await writeLifecycleCluster(root, lifecycle);
    const cluster = await loadCluster(directory);
    const definition = cluster.environments.get("node-a/runtime")!;
    assertEquals(definition.init?.beforeStart.length, 1);
    assertEquals(definition.init?.afterStart.length, 1);
    assertEquals(definition.init?.beforeStart[0].relativePath, "scripts/action.ts");
    assertEquals(definition.init?.afterStart[0].permissions.run, ["/usr/bin/systemctl"]);
  });
});

Deno.test("unit/environment management config: init without lifecycle scripts is rejected", async () => {
  const cases: readonly [string, string][] = [
    [
      "scripts and init conflict",
      `schema_version: 1\nname: runtime\nversion: "1"\nscripts:\n  check: [{path: scripts/action.ts, permissions: {run: [], net: []}}]\ninit:\n  before_start: [{path: scripts/action.ts, permissions: {run: [], net: []}}]\n`,
    ],
    [
      "init unknown field",
      `${packageLifecycle}init:\n  before_start_typo:\n    - path: scripts/action.ts\n      permissions: {run: [], net: []}\n`,
    ],
  ];
  for (const [label, lifecycle] of cases) {
    const error = await withTempDir(async (root) => {
      const directory = await writeLifecycleCluster(root, lifecycle, "runtime");
      return await assertRejects(() => loadCluster(directory), ConfigurationError);
    });
    assertStringIncludes(
      error.message,
      label.startsWith("scripts") ? "must choose exactly one of" : "contains unknown fields",
      label,
    );
  }
});

Deno.test("unit/environment management config: conflicts and invalid declarations fail closed", async () => {
  const cases: readonly [string, string, string][] = [
    [
      "scripts and lifecycle conflict",
      `schema_version: 1\nname: runtime\nversion: "1"\nscripts:\n  check: [{path: scripts/action.ts, permissions: {run: [], net: []}}]\ninstall:\n  kind: package\n  packages: [nginx]\n`,
      "must choose exactly one of",
    ],
    [
      "manager without install",
      `schema_version: 1\nname: runtime\nversion: "1"\nmanager:\n  kind: system\n  name: nginx\n`,
      "install is a required field of the new lifecycle",
    ],
    [
      "invalid package name",
      `schema_version: 1\nname: runtime\nversion: "1"\ninstall:\n  kind: package\n  packages: ["nginx;rm"]\n`,
      "is not a valid package name",
    ],
    [
      "invalid install kind",
      `schema_version: 1\nname: runtime\nversion: "1"\ninstall:\n  kind: wget\n`,
      "install.kind uses an unsupported value",
    ],
    [
      "invalid manager tool",
      `schema_version: 1\nname: runtime\nversion: "1"\ninstall:\n  kind: package\n  packages: [nginx]\nmanager:\n  kind: system\n  name: nginx\n  tool: rc-service\n`,
      "manager.tool uses an unsupported value",
    ],
    [
      "script manager without stop",
      `schema_version: 1
name: runtime
version: "1"
install:
  kind: package
  packages: [nginx]
manager:
  kind: script
  start: {path: scripts/action.ts, permissions: {run: [], net: []}}
  restart: {path: scripts/action.ts, permissions: {run: [], net: []}}
`,
      "is missing fields: stop",
    ],
  ];
  for (const [label, lifecycle, message] of cases) {
    const error = await withTempDir(async (root) => {
      const directory = await writeLifecycleCluster(root, lifecycle, "runtime");
      return await assertRejects(() => loadCluster(directory), ConfigurationError);
    });
    assertStringIncludes(error.message, message, label);
  }
});
