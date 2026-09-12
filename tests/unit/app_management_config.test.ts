import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  withTempDir,
} from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { loadCluster } from "../../src/config.ts";
import { ConfigurationError } from "../../src/errors.ts";
import { PreflightError } from "../../src/errors.ts";
import { buildPlan } from "../../src/planning.ts";
import { generateSystemdUnitSkeleton, serviceUnitManagedConfig } from "../../src/systemd_unit.ts";

async function addFile(
  directory: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(directory, relativePath);
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, content);
}

async function schemaApp(
  root: string,
  appBody: string,
  files: { readonly path: string; readonly content: string }[] = [],
  appName = "demo",
): Promise<string> {
  const directory = await writeCluster(root, { appConfigure: false });
  const appDirectory = join(directory, "apps", appName);
  for (const file of files) await addFile(appDirectory, file.path, file.content);
  await Deno.writeTextFile(join(appDirectory, "app.yaml"), appBody);
  if (appName !== "demo") {
    await Deno.writeTextFile(
      join(directory, "app_versions.yaml"),
      `schema_version: 1\napps: {}\n`,
    );
    await Deno.writeTextFile(
      join(directory, "cluster.yaml"),
      (await Deno.readTextFile(join(directory, "cluster.yaml"))).replace(
        "apps:\n  demo: [node-a]",
        `apps:\n  demo: [node-a]\n  ${appName}: [node-a]`,
      ),
    );
  }
  return directory;
}

const fileConfig = `schema_version: 1
name: demo
install_directory: /srv/demo
depends_on: [base]
deployment:
  kind: versioned
configs:
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    owner: deploy
    group: deploy
    mode: "0600"
    format: json
    on_change: restart
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: auto
  enabled: true
  daemon_reload: true
  on_deploy: restart
  timeout_ms: 2000
`;

Deno.test("unit/app schema 1: file config and system service normalize without entry name", async () => {
  await withTempDir(async (root) => {
    const directory = await schemaApp(root, fileConfig, [{
      path: "templates/application.json",
      content: '{"listen":"127.0.0.1:8080"}\n',
    }]);
    const cluster = await loadCluster(directory);
    const app = cluster.apps.get("demo")!;
    assertEquals(app.management?.configs.length, 1);
    assertEquals(app.management?.configScripts.length, 0);
    assertEquals(app.management?.manager?.kind, "service");
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(plan.steps.map((step) => step.action), ["stage", "activate"]);
    assertEquals(plan.steps[0].management?.configs[0]?.name, "file-0");
  });
});

Deno.test("unit/app schema 1: nginx file config loads as raw text and rejects bindings", async () => {
  const nginxBody = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
configs:
  - kind: file
    source: templates/jx-web.conf
    target: /etc/nginx/conf.d/jx-web.conf
    owner: root
    group: root
    mode: "0644"
    format: nginx
    on_change: reload
management:
  run_as: deploy
  kind: service
  name: nginx.service
  tool: systemctl
  daemon_reload: false
  on_deploy: none
`;
  await withTempDir(async (root) => {
    const directory = await schemaApp(root, nginxBody, [{
      path: "templates/jx-web.conf",
      content: "server { listen 80; root /srv/demo/latest; }\n",
    }]);
    const cluster = await loadCluster(directory);
    const config = cluster.apps.get("demo")!.management?.configs[0];
    assertEquals(config?.format, "nginx");
    assertEquals(config?.onChange, "reload");
    assertEquals(config?.secretReferences.size, 0);
    assertEquals(config?.variables, []);
  });

  await withTempDir(async (root) => {
    const directory = await schemaApp(root, nginxBody, [{
      path: "templates/jx-web.conf",
      content: "server { error_log /tmp/${DB_PASSWORD}; }\n",
    }]);
    const error = await assertRejects(() => loadCluster(directory), PreflightError);
    assertStringIncludes(error.message, "不支持占位符");
  });

  await withTempDir(async (root) => {
    const variableBody = nginxBody.replace(
      "format: nginx",
      `format: nginx
    variables:
      - name: SERVER_NAME
        path: [server_name]
        type: string`,
    );
    const directory = await schemaApp(root, variableBody, [{
      path: "templates/jx-web.conf",
      content: "server { listen 80; }\n",
    }]);
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "variables 与 format: nginx 不兼容");
  });
});

Deno.test("unit/app schema 1: script and file configs plan configure then versioned staging", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
configs:
  - kind: script
    path: scripts/configure.ts
    permissions:
      run: [/usr/bin/test]
      net: []
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    format: json
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
`;
    const directory = await schemaApp(root, body, [{
      path: "templates/application.json",
      content: '{"listen":"127.0.0.1:8080"}\n',
    }, {
      path: "scripts/configure.ts",
      content: "Deno.exit(0);\n",
    }]);
    const cluster = await loadCluster(directory);
    const app = cluster.apps.get("demo")!;
    assertEquals(app.management?.configScripts.length, 1);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(plan.steps.map((step) => step.action), [
      "configure",
      "stage",
      "activate",
    ]);
    assertEquals(plan.steps[0].scripts[0]?.relativePath, "scripts/configure.ts");
  });
});

Deno.test("unit/app schema 1: directory variables bind managed config targets", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
configs:
  - kind: file
    source: templates/application.json
    target: ${"${INSTALL_DIRECTORY}/shared/application.json"}
    format: json
  - kind: file
    source: templates/application.current.json
    target: ${"${CURRENT_VERSION_DIRECTORY}/resources/application.json"}
    format: json
  - kind: file
    source: templates/application.latest.json
    target: ${"${LATEST_DIRECTORY}/resources/application-latest.json"}
    format: json
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
`;
    const directory = await schemaApp(root, body, [{
      path: "templates/application.json",
      content: "{}\n",
    }, {
      path: "templates/application.current.json",
      content: "{}\n",
    }, {
      path: "templates/application.latest.json",
      content: "{}\n",
    }]);
    const cluster = await loadCluster(directory);
    const configs = cluster.apps.get("demo")!.management?.configs ?? [];
    assertEquals(configs.map((config) => [config.target, config.targetRoot]), [
      ["/srv/demo/shared/application.json", "install"],
      ["/srv/demo/latest/resources/application.json", "current"],
      ["/srv/demo/latest/resources/application-latest.json", "latest"],
    ]);
  });
});

Deno.test("unit/app schema 1: install directory variable requires install_directory", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
packageless: true
configs:
  - kind: file
    source: templates/application.json
    target: ${"${INSTALL_DIRECTORY}/resources/application.json"}
    format: json
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
`;
    const directory = await schemaApp(root, body, [{
      path: "templates/application.json",
      content: "{}\n",
    }]);
    await Deno.writeTextFile(join(directory, "app_versions.yaml"), "schema_version: 1\napps: {}\n");
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(
      error.message,
      "app[demo].configs.file[0].target 使用安装目录变量，但 App 缺少 install_directory",
    );
  });
});

Deno.test("unit/app schema 1: directory variables are single prefix values", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
configs:
  - kind: file
    source: templates/application.json
    target: ${"${INSTALL_DIRECTORY}/x/${LATEST_DIRECTORY}/app.json"}
    format: json
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
`;
    const directory = await schemaApp(root, body, [{
      path: "templates/application.json",
      content: "{}\n",
    }]);
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "只能包含一个目录变量");
  });
});

Deno.test("unit/app schema 1: script service supplies lifecycle commands and deploy restarts", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  run_as: deploy
  kind: script
  start: {path: scripts/start.ts, permissions: {run: [], net: []}}
  stop: {path: scripts/stop.ts, permissions: {run: [], net: []}}
  restart: {path: scripts/restart.ts, permissions: {run: [], net: []}}
`;
    const files = ["start", "stop", "restart"].map((name) => ({
      path: `scripts/${name}.ts`,
      content: "Deno.exit(0);\n",
    }));
    const cluster = await loadCluster(await schemaApp(root, body, files));
    const deploy = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(deploy.steps.map((step) => step.action), ["stage", "activate", "restart"]);
    assertEquals(deploy.steps.at(-1)?.scripts[0]?.relativePath, "scripts/restart.ts");
    const restart = buildPlan(cluster, { action: "restart", apps: ["demo"] });
    assertEquals(restart.steps[0].scripts[0]?.relativePath, "scripts/restart.ts");
  });
});

Deno.test("unit/app schema 1: unit_config resolves latest paths", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
configs:
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    format: json
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
  unit_config:
    working_directory: latest
    command: bin/server
    args: []
`;
    const directory = await schemaApp(root, body, [{
      path: "templates/application.json",
      content: "{}\n",
    }]);
    const cluster = await loadCluster(directory);
    const service = cluster.apps.get("demo")!.management?.manager;
    assertEquals(
      service?.kind === "service" ? service.unitConfig?.workingDirectory : "",
      "/srv/demo/latest",
    );
  });
});

Deno.test("unit/app schema 1: unit_config resolves directory variables in working_directory", async () => {
  const cases: readonly [string, string][] = [
    [`working_directory: ${"${LATEST_DIRECTORY}"}`, "/srv/demo/latest"],
    [`working_directory: ${"${CURRENT_VERSION_DIRECTORY}"}`, "/srv/demo/latest"],
    [`working_directory: ${"${INSTALL_DIRECTORY}"}`, "/srv/demo"],
    [`working_directory: ${"${LATEST_DIRECTORY}/resources"}`, "/srv/demo/latest/resources"],
    [`working_directory: ${"${INSTALL_DIRECTORY}/lib"}`, "/srv/demo/lib"],
  ];
  for (const [workingDirectory, expected] of cases) {
    await withTempDir(async (root) => {
      const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
  unit_config:
    ${workingDirectory}
    command: bin/server
    args: []
`;
      const directory = await schemaApp(root, body);
      const cluster = await loadCluster(directory);
      const manager = cluster.apps.get("demo")!.management?.manager;
      assertEquals(
        manager?.kind === "service" ? manager.unitConfig?.workingDirectory : "",
        expected,
      );
    });
  }
});

Deno.test("unit/app schema 1: unit_config rejects invalid working_directory variables", async () => {
  const cases: readonly { readonly workingDirectory: string; readonly message: string }[] = [
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/${INSTALL_DIRECTORY}"}`,
      message: "只能包含一个目录变量",
    },
    {
      workingDirectory: `x/${"${LATEST_DIRECTORY}"}`,
      message: "只支持以",
    },
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/../x"}`,
      message: "目录变量后必须是规范相对路径",
    },
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/"}`,
      message: "目录变量后必须是规范相对路径",
    },
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/a/./b"}`,
      message: "目录变量后必须是规范相对路径",
    },
    {
      workingDirectory: `${"${UNKNOWN}"}`,
      message: "只支持",
    },
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/x${MORE}"}`,
      message: "目录变量后必须是规范相对路径",
    },
  ];
  for (const { workingDirectory, message } of cases) {
    await withTempDir(async (root) => {
      const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
  unit_config:
    working_directory: ${workingDirectory}
    command: bin/server
    args: []
`;
      const error = await assertRejects(
        async () => await loadCluster(await schemaApp(root, body)),
        ConfigurationError,
      );
      assertStringIncludes(error.message, message);
    });
  }
});

Deno.test("unit/app schema 1: unit_config directory variable renders systemd unit", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
  unit_config:
    working_directory: ${"${LATEST_DIRECTORY}"}
    command: bin/server
    args: []
`;
    const directory = await schemaApp(root, body);
    const cluster = await loadCluster(directory);
    const manager = cluster.apps.get("demo")!.management?.manager;
    if (manager?.kind !== "service" || manager.unitConfig === undefined) {
      throw new Error("expected service management with unit_config");
    }
    const skeleton = generateSystemdUnitSkeleton(
      serviceUnitManagedConfig(manager)!,
      manager,
      "deploy",
    );
    const text = new TextDecoder().decode(skeleton.content);
    assertStringIncludes(text, "WorkingDirectory=/srv/demo/latest");
  });
});

Deno.test("unit/app schema 1: unit_config directory variable requires install_directory", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
packageless: true
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
  unit_config:
    working_directory: ${"${LATEST_DIRECTORY}"}
    command: bin/server
    args: []
`;
    const directory = await schemaApp(root, body);
    await Deno.writeTextFile(join(directory, "app_versions.yaml"), "schema_version: 1\napps: {}\n");
    const error = await assertRejects(
      async () => await loadCluster(directory),
      ConfigurationError,
    );
    assertStringIncludes(error.message, "缺少 install_directory");
  });
});

Deno.test("unit/app schema 1: unit_config normalizes restart policy fields", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
  unit_config:
    working_directory: latest
    command: bin/server
    args: []
    restart_policy: on-failure
    restart_sec: 5
    start_limit_interval_sec: 0
    start_limit_burst: 5
`;
    const cluster = await loadCluster(await schemaApp(root, body));
    const service = cluster.apps.get("demo")!.management?.manager;
    const unitConfig = service?.kind === "service" ? service.unitConfig : undefined;
    assertEquals(unitConfig?.restartPolicy, "on-failure");
    assertEquals(unitConfig?.restartSec, 5);
    assertEquals(unitConfig?.startLimitIntervalSec, 0);
    assertEquals(unitConfig?.startLimitBurst, 5);
  });
});

Deno.test("unit/app schema 1: restart policy values and bounds fail closed", async () => {
  const base = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
  daemon_reload: true
  unit_config:
    working_directory: latest
    command: bin/server
    args: []
`;
  const cases = [
    ["restart_policy", "sometimes", "restart_policy"],
    ["restart_sec", "-1", "restart_sec"],
    ["restart_sec", "86401", "restart_sec"],
    ["start_limit_interval_sec", "-1", "start_limit_interval_sec"],
    ["start_limit_interval_sec", "86401", "start_limit_interval_sec"],
    ["start_limit_burst", "-1", "start_limit_burst"],
    ["start_limit_burst", "10001", "start_limit_burst"],
  ] as const;
  for (const [field, value, label] of cases) {
    await withTempDir(async (root) => {
      const body = `${base}    ${field}: ${value}\n`;
      const error = await assertRejects(
        async () => await loadCluster(await schemaApp(root, body)),
        ConfigurationError,
      );
      assertStringIncludes(error.message, `unit_config.${label}`);
    });
  }
});

Deno.test("unit/app schema 1: old app schemas are rejected", async () => {
  await withTempDir(async (root) => {
    const directory = await schemaApp(root, fileConfig, [{
      path: "templates/application.json",
      content: "{}\n",
    }]);
    for (const version of [2, 3, 4]) {
      const path = join(directory, "apps", "demo", "app.yaml");
      await Deno.writeTextFile(
        path,
        (await Deno.readTextFile(path)).replace("schema_version: 1", `schema_version: ${version}`),
      );
      const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
      assertStringIncludes(error.message, "app[demo].schema_version 只支持 1");
    }
  });
});

Deno.test("unit/app schema 1: top-level scripts are rejected", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
scripts:
  check: [{path: scripts/check.ts, permissions: {run: [], net: []}}]
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
`;
    const directory = await schemaApp(root, body);
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "顶层 scripts 已移除");
  });
});

Deno.test("unit/app schema 1: old management.service wrapper is rejected", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  run_as: deploy
  service:
    kind: system
    name: demo.service
    tool: systemctl
`;
    const directory = await schemaApp(root, body);
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "app[demo].management 包含未知字段: service");
  });
});

Deno.test("unit/app schema 1: ownership, duplicate and invalid service rules fail closed", async () => {
  const cases: readonly [string, string][] = [
    [
      "name",
      `configs:\n  - kind: file\n    name: application\n    source: templates/a.json\n    target: /etc/a.json\n    format: json\n`,
    ],
    [
      "kind",
      `configs:\n  - name: application\n    source: templates/a.json\n    target: /etc/a.json\n    format: json\n`,
    ],
    ["unknown-kind", `configs:\n  - kind: directory\n`],
    [
      "service-tool",
      `management:\n  run_as: deploy\n  kind: service\n  name: demo.service\n  tool: rc-service\n`,
    ],
    [
      "service-unit-tool",
      `management:\n  run_as: deploy\n  kind: service\n  name: demo.service\n  tool: service\n  unit_config:\n    working_directory: latest\n    command: bin/server\n`,
    ],
  ];
  for (const [label, extra] of cases) {
    await withTempDir(async (root) => {
      const body = `schema_version: 1\nname: demo\ninstall_directory: /srv/demo\n${extra}`;
      const directory = await schemaApp(root, body);
      const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
      assertStringIncludes(error.message, "app[demo]");
    });
  }
});

Deno.test("unit/app schema 1: duplicate file targets and scripts are rejected", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
configs:
  - kind: file
    source: templates/a.json
    target: /etc/a.json
    format: json
  - kind: file
    source: templates/b.json
    target: /etc/a.json
    format: json
management:
  run_as: deploy
  kind: service
  name: demo.service
  tool: systemctl
`;
    const directory = await schemaApp(root, body, [
      { path: "templates/a.json", content: "{}\n" },
      { path: "templates/b.json", content: "{}\n" },
      { path: "scripts/check.ts", content: "Deno.exit(0);\n" },
    ]);
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "重复目标路径");
  });
});
