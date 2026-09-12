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
    assertEquals(definition.install?.kind, "script");
    assertEquals(definition.manager?.kind, "script");
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

Deno.test("unit/environment management config: conflicts and invalid declarations fail closed", async () => {
  const cases: readonly [string, string, string][] = [
    [
      "scripts and lifecycle conflict",
      `schema_version: 1\nname: runtime\nversion: "1"\nscripts:\n  check: [{path: scripts/action.ts, permissions: {run: [], net: []}}]\ninstall:\n  kind: package\n  packages: [nginx]\n`,
      "只能选择",
    ],
    [
      "manager without install",
      `schema_version: 1\nname: runtime\nversion: "1"\nmanager:\n  kind: system\n  name: nginx\n`,
      "install 是新生命周期的必需字段",
    ],
    [
      "invalid package name",
      `schema_version: 1\nname: runtime\nversion: "1"\ninstall:\n  kind: package\n  packages: ["nginx;rm"]\n`,
      "不是合法包名",
    ],
    [
      "invalid install kind",
      `schema_version: 1\nname: runtime\nversion: "1"\ninstall:\n  kind: wget\n`,
      "install.kind 使用不支持的值",
    ],
    [
      "invalid manager tool",
      `schema_version: 1\nname: runtime\nversion: "1"\ninstall:\n  kind: package\n  packages: [nginx]\nmanager:\n  kind: system\n  name: nginx\n  tool: rc-service\n`,
      "manager.tool 使用不支持的值",
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
      "缺少字段: stop",
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
