import { join } from "jsr:@std/path@1.1.6";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { loadCluster } from "../../src/config.ts";
import { ConfigurationError, PreflightError } from "../../src/errors.ts";
import { loadClusterSecretSource } from "../../src/secrets.ts";
import { buildPlan } from "../../src/planning.ts";

type Format = "yaml" | "json" | "toml" | "ini";

function sourceFor(format: Format, variableMarker: string): string {
  if (format === "yaml") {
    return `database:\n  password: \${DB_PASSWORD}\nserver:\n  port: ${variableMarker}\n`;
  }
  if (format === "json") {
    return `{"database":{"password":"\${DB_PASSWORD}"},"server":{"port":"${variableMarker}"}}\n`;
  }
  if (format === "toml") {
    return `[database]\npassword = "\${DB_PASSWORD}"\n[server]\nport = "${variableMarker}"\n`;
  }
  return `[database]\npassword=\${DB_PASSWORD}\n[server]\nport=${variableMarker}\n`;
}

async function managedCluster(
  root: string,
  format: Format,
  options: {
    readonly updater?: boolean;
    readonly source?: string;
    readonly secretType?: string;
    readonly variables?: boolean;
  } = {},
): Promise<string> {
  const directory = await writeCluster(root, { appConfigure: false });
  const appDirectory = join(directory, "apps", "demo");
  const source = options.source ?? sourceFor(format, "__SFO_CONFIG_VAR_V1_APP_VERSION__");
  await Deno.mkdir(join(appDirectory, "templates"), { recursive: true });
  await Deno.writeTextFile(join(appDirectory, "templates", "application.conf"), source);
  const secretType = options.secretType === undefined ? "" : `    type: ${options.secretType}\n`;
  await Deno.writeTextFile(
    join(directory, "cluster.yaml"),
    (await Deno.readTextFile(join(directory, "cluster.yaml"))) +
      `secrets:\n  DB_PASSWORD:\n    kind: value\n${secretType}    machines: [node-a]\n`,
  );
  await Deno.writeTextFile(
    join(appDirectory, "app.yaml"),
    `schema_version: 3
name: demo
install_directory: /srv/demo
depends_on: [base]
scripts:
  deploy: [{path: scripts/action.ts, permissions: {run: [], net: []}}]
management:
  run_as: deploy
  configs:
    - name: application
      source: templates/application.conf
      target: /etc/demo/application.conf
      owner: deploy
      group: deploy
      mode: "0600"
      format: ${format}
${options.updater ? "      updater: {type: script, path: scripts/action.ts, secrets: []}\n" : ""}${
      options.variables === false
        ? ""
        : `      variables:\n        - {name: APP_VERSION, path: [version], type: integer}\n`
    }
      validator:
        argv: [/usr/bin/test, -s, "{candidate}"]
        timeout_ms: 1000
      on_change: restart
  service:
    type: systemd
    unit: demo.service
    enabled: true
    daemon_reload: true
    on_deploy: reload
    timeout_ms: 2000
`,
  );
  return directory;
}

Deno.test("unit/app-v3: 四种格式解析占位符并生成 managed 计划", async () => {
  for (const format of ["yaml", "json", "toml", "ini"] as const) {
    await withTempDir(async (root) => {
      const cluster = await loadCluster(await managedCluster(root, format));
      const app = cluster.apps.get("demo")!;
      const config = app.management?.configs[0];
      assertEquals(config?.format, format);
      assertEquals(config?.secretReferences.get("DB_PASSWORD"), {
        kind: "value",
        valueType: "string",
      });
      assertEquals(config?.mode, 0o600);
      const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
      const step = plan.steps.find((item) => item.kind === "app" && item.action === "deploy")!;
      assertEquals(plan.schemaVersion, 4);
      assertEquals(step.runAs, "deploy");
      assertEquals(step.secretValues, ["DB_PASSWORD"]);
      assertEquals(step.deliveryInputs?.scripts.map((item) => item.relativePath), [
        "scripts/action.ts",
      ]);
    });
  }
});

Deno.test("unit/app-v3: value 秘密类型由 cluster.yaml 决定并校验实际值", async () => {
  await withTempDir(async (root) => {
    const cluster = await loadCluster(
      await managedCluster(root, "json", {
        secretType: "integer",
      }),
    );
    assertEquals(
      cluster.apps.get("demo")!.management?.configs[0].secretReferences.get("DB_PASSWORD"),
      { kind: "value", valueType: "integer" },
    );
  });
  await withTempDir(async (root) => {
    const directory = await managedCluster(root, "json", {
      secretType: "integer",
      variables: false,
    });
    await Deno.writeTextFile(join(directory, "secrets.yaml"), 'DB_PASSWORD: "abc"\n', {
      mode: 0o600,
    });
    const cluster = await loadCluster(directory);
    const error = await assertRejects(
      () => loadClusterSecretSource(cluster, directory),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "不符合 integer 类型");
  });
});

Deno.test("unit/app-v3: 未知、非法和已移除 updater 声明失败关闭", async () => {
  await withTempDir(async (root) => {
    const directory = await managedCluster(root, "json", {
      source: `{"password":"\${UNDECLARED}"}`,
      variables: false,
    });
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "未在 cluster.yaml.secrets 声明");
  });
  await withTempDir(async (root) => {
    const directory = await managedCluster(root, "yaml", { updater: true });
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "updater 已移除");
  });
  await withTempDir(async (root) => {
    const directory = await managedCluster(root, "yaml", {
      source: "database:\n  password: ${lower}\n",
      variables: false,
    });
    const error = await assertRejects(() => loadCluster(directory), PreflightError);
    assertStringIncludes(error.message, "占位符名称不合法");
  });
});

Deno.test("unit/app-v3: 未放置秘密在 App 放置校验时失败", async () => {
  await withTempDir(async (root) => {
    const directory = await managedCluster(root, "yaml");
    const path = join(directory, "cluster.yaml");
    await Deno.writeTextFile(
      path,
      (await Deno.readTextFile(path)).replace("machines: [node-a]", "machines: [node-b]"),
    );
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "引用未知机器");
  });
});

Deno.test("unit/app-v3: schema v2/v3 不声明 management 时保持 legacy 行为", async () => {
  await withTempDir(async (root) => {
    const v2 = await loadCluster(await writeCluster(root));
    assertEquals(v2.apps.get("demo")?.management, undefined);
    assertEquals(
      buildPlan(v2, { action: "deploy", apps: ["demo"] }).steps.map((step) => step.action),
      ["configure", "deploy"],
    );
  });
});

Deno.test("unit/app: 顶层 templates 仍定向拒收", async () => {
  await withTempDir(async (root) => {
    const directory = await writeCluster(root);
    const path = join(directory, "apps", "demo", "app.yaml");
    await Deno.writeTextFile(
      path,
      (await Deno.readTextFile(path)).replace("scripts:\n", "templates: [x.tpl]\nscripts:\n"),
    );
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "顶层 templates 已移除");
  });
});

async function writeV4App(root: string, management: string, scripts = "deploy"): Promise<string> {
  const directory = await writeCluster(root, { appConfigure: false });
  const appDirectory = join(directory, "apps", "demo");
  await Deno.mkdir(join(appDirectory, "templates"), { recursive: true });
  await Deno.writeTextFile(
    join(appDirectory, "templates", "application.json"),
    '{"listen":"127.0.0.1:8080"}\n',
  );
  await Deno.writeTextFile(
    join(appDirectory, "app.yaml"),
    `schema_version: 4
name: demo
install_directory: /srv/demo
depends_on: [base]
scripts:
  ${scripts}: [{path: scripts/action.ts, permissions: {run: [], net: []}}]
${management}
`,
  );
  return directory;
}

const V4_CONFIG_AND_SERVICE = `management:
  run_as: deploy
  actions:
    - kind: config
      name: application
      source: templates/application.json
      target: /etc/demo/application.json
      owner: deploy
      group: deploy
      mode: "0600"
      format: json
      on_change: restart
    - kind: service
      type: systemd
      unit: demo.service
      enabled: true
      daemon_reload: true
      on_deploy: restart
      timeout_ms: 2000
      unit_config:
        working_directory: current
        command: bin/server
        args: ["--config", "config/application.ini"]
`;

Deno.test("unit/app-v4: actions 归一 config/service 并解析 working directory", async () => {
  await withTempDir(async (root) => {
    const directory = await writeV4App(root, V4_CONFIG_AND_SERVICE);
    const cluster = await loadCluster(directory);
    const app = cluster.apps.get("demo")!;
    assertEquals(app.management?.runAs, "deploy");
    assertEquals(app.management?.configs[0]?.name, "application");
    assertEquals(app.management?.service?.unitConfig, {
      target: "/etc/systemd/system/demo.service",
      workingDirectory: "/srv/demo/current",
      command: "/srv/demo/current/bin/server",
      args: ["--config", "config/application.ini"],
    });
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(
      plan.steps.filter((step) => step.kind === "app").map((step) => step.action),
      ["deploy"],
    );
    const configurePlan = buildPlan(cluster, { action: "configure", apps: ["demo"] });
    assertEquals(
      configurePlan.steps.filter((step) => step.kind === "app").map((step) => step.action),
      ["configure"],
    );
    assertEquals(
      plan.steps.at(-1)?.management?.service?.unitConfig?.workingDirectory,
      "/srv/demo/current",
    );
  });
});

Deno.test("unit/app-v4: service 可只控制已有 unit 且 target 可显式声明", async () => {
  await withTempDir(async (root) => {
    const directory = await writeV4App(
      root,
      `management:
  run_as: deploy
  actions:
    - kind: service
      type: systemd
      unit: demo.service
      daemon_reload: true
      on_deploy: restart
      timeout_ms: 2000
      unit_config:
        target: /etc/systemd/system/demo.service
        working_directory: /srv/demo/current
        command: /srv/demo/current/bin/server
        args: []
`,
    );
    const cluster = await loadCluster(directory);
    assertEquals(cluster.apps.get("demo")?.management?.configs.length, 0);
    assertEquals(
      cluster.apps.get("demo")?.management?.service?.unitConfig?.target,
      "/etc/systemd/system/demo.service",
    );
  });
});

Deno.test("unit/app-v4: builtin versioned deployment defaults, plans and conflicts", async () => {
  await withTempDir(async (root) => {
    const directory = await writeV4App(
      root,
      "management:\n  run_as: deploy\n  actions: []\n",
      "check",
    );
    const cluster = await loadCluster(directory);
    assertEquals(cluster.apps.get("demo")?.deployment, { kind: "versioned" });
    const step = buildPlan(cluster, { action: "deploy", apps: ["demo"] }).steps.at(-1)!;
    assertEquals(step.deployment, { kind: "versioned" });
    assertEquals(step.scripts[0]?.relativePath, "sfo-versioned-release.ts");
    assertEquals(step.secretValues.length, 0);

    const appPath = join(directory, "apps", "demo", "app.yaml");
    await Deno.writeTextFile(
      appPath,
      `schema_version: 4
name: demo
install_directory: /srv/demo
depends_on: [base]
deployment:
  kind: versioned
scripts:
  deploy: [{path: scripts/action.ts, permissions: {run: [], net: []}}]
management:
  run_as: deploy
  actions: []
`,
    );
    const conflict = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(conflict.message, "deployment 与 scripts.deploy");

    await Deno.writeTextFile(
      appPath,
      `schema_version: 4
name: demo
install_directory: /srv/demo
depends_on: [base]
deployment:
  kind: versioned
scripts: {}
management:
  run_as: deploy
  actions: []
`,
    );
    const loaded = await loadCluster(directory);
    assertEquals(loaded.apps.get("demo")?.deployment, { kind: "versioned" });
  });
});

Deno.test("unit/app-v4: builtin versioned deploy stages all apps before any activation", async () => {
  await withTempDir(async (root) => {
    const directory = await writeV4App(
      root,
      `management:
  run_as: deploy
  actions:
    - kind: service
      type: systemd
      unit: demo.service
      daemon_reload: true
      on_deploy: restart
      timeout_ms: 2000
`,
      "check",
    );
    const alphaDirectory = join(directory, "apps", "alpha");
    await Deno.mkdir(alphaDirectory, { recursive: true });
    await Deno.writeTextFile(
      join(alphaDirectory, "app.yaml"),
      `schema_version: 4
name: alpha
install_directory: /srv/alpha
deployment:
  kind: versioned
scripts: {}
management:
  run_as: deploy
  actions: []
`,
    );
    await Deno.writeTextFile(
      join(directory, "app_versions.yaml"),
      `schema_version: 1
apps:
  alpha:
    version: "1.0.0"
    package:
      provider: http
      source: {url: "https://example.invalid/alpha.bin"}
      hash: {algorithm: sha256, value: "${"00".repeat(32)}"}
  demo:
    version: "1.0.0"
    package:
      provider: http
      source: {url: "https://example.invalid/demo.bin"}
      hash: {algorithm: sha256, value: "${"00".repeat(32)}"}
`,
    );
    await Deno.writeTextFile(
      join(directory, "cluster.yaml"),
      (await Deno.readTextFile(join(directory, "cluster.yaml"))).replace(
        "apps:\n  demo: [node-a]",
        "apps:\n  demo: [node-a]\n  alpha: [node-b]",
      ),
    );
    await Deno.writeTextFile(
      join(directory, "machines.yaml"),
      (await Deno.readTextFile(join(directory, "machines.yaml"))).replace(
        "    deno: /usr/bin/deno\n",
        "    deno: /usr/bin/deno\n  - name: node-b\n    private_ip: [10.0.0.3]\n    public_ip: 203.0.113.11\n    region: local\n    ssh_user: deploy\n    ssh_port: 22\n    deno: /usr/bin/deno\n",
      ),
    );
    const cluster = await loadCluster(directory);
    const plan = buildPlan(cluster, { action: "deploy" });
    assertEquals(plan.steps.map((step) => step.id), [
      "app:node-a/demo:stage",
      "app:node-b/alpha:stage",
      "app:node-a/demo:activate",
      "app:node-b/alpha:activate",
      "app:node-a/demo:restart",
    ]);
    const stageIds = new Set(["app:node-a/demo:stage", "app:node-b/alpha:stage"]);
    for (const step of plan.steps.filter((step) => step.action === "activate")) {
      assertEquals(new Set(step.dependsOn), stageIds);
    }
    assert(plan.steps[0].package !== undefined);
    assert(plan.steps[1].package !== undefined);
    assertEquals(plan.steps[2].package, undefined);
    assertEquals(plan.steps[3].package, undefined);
    assertEquals(plan.steps[0].management, undefined);
    assertEquals(plan.steps[2].management?.runAs, "deploy");
    assertEquals(plan.steps[4].management?.service?.onDeploy, "restart");
    assertEquals(plan.steps[4].deployment, undefined);
    assertEquals(plan.steps[4].package, undefined);
  });
});

Deno.test("unit/app-v4: 未知字段、kind、所有权和路径冲突失败关闭", async () => {
  const cases: readonly [string, string][] = [
    ["旧 configs 字段", `management:\n  run_as: deploy\n  configs: []\n  actions: []\n`],
    ["未知 kind", `management:\n  run_as: deploy\n  actions:\n    - kind: hook\n`],
    [
      "config 冲突",
      `management:\n  run_as: deploy\n  actions:\n    - kind: config\n      name: application\n      source: templates/application.json\n      target: /etc/demo/application.json\n      format: json\n`,
    ],
    [
      "service 冲突",
      `management:\n  run_as: deploy\n  actions:\n    - kind: service\n      type: systemd\n      unit: demo.service\n      daemon_reload: true\n`,
    ],
    [
      "相对路径越界",
      `management:\n  run_as: deploy\n  actions:\n    - kind: service\n      type: systemd\n      unit: demo.service\n      daemon_reload: true\n      unit_config:\n        working_directory: ../outside\n        command: bin/server\n`,
    ],
    [
      "daemon_reload 缺失",
      `management:\n  run_as: deploy\n  actions:\n    - kind: service\n      type: systemd\n      unit: demo.service\n      daemon_reload: false\n      unit_config:\n        working_directory: current\n        command: bin/server\n`,
    ],
    [
      "重复 service",
      `management:\n  run_as: deploy\n  actions:\n    - kind: service\n      type: systemd\n      unit: demo.service\n      daemon_reload: true\n    - kind: service\n      type: systemd\n      unit: demo.service\n      daemon_reload: true\n`,
    ],
    [
      "unit target 冲突",
      `management:\n  run_as: deploy\n  actions:\n    - kind: config\n      name: unit\n      source: templates/application.json\n      target: /etc/systemd/system/demo.service\n      format: json\n    - kind: service\n      type: systemd\n      unit: demo.service\n      daemon_reload: true\n      unit_config:\n        working_directory: current\n        command: bin/server\n`,
    ],
    [
      "target 文件名不匹配",
      `management:\n  run_as: deploy\n  actions:\n    - kind: service\n      type: systemd\n      unit: demo.service\n      daemon_reload: true\n      unit_config:\n        target: /etc/systemd/system/other.service\n        working_directory: current\n        command: bin/server\n`,
    ],
  ];
  for (const [label, management] of cases) {
    await withTempDir(async (root) => {
      const scripts = label === "config 冲突"
        ? "configure"
        : label === "service 冲突"
        ? "start"
        : "deploy";
      const directory = await writeV4App(root, management, scripts);
      const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
      assertStringIncludes(error.message, "app[demo].management");
    });
  }
});
