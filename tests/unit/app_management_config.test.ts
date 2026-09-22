import { join } from "jsr:@std/path@1.1.6";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
  withTempDir,
} from "../_support/assert.ts";
import { writeCluster } from "../_support/fixtures.ts";
import { loadCluster } from "../../src/config.ts";
import { ConfigurationError } from "../../src/errors.ts";
import { PlanningError } from "../../src/errors.ts";
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

Deno.test("unit/app schema 1: root mode loads into plan and fails closed for invalid values", async () => {
  const body = (extra: string, install = "install_directory: /srv/demo\n") =>
    `schema_version: 1
name: demo
${install}${extra}deployment:
  kind: versioned
configs:
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    format: json
management:
  kind: service
  name: demo.service
  tool: systemctl
`;

  await withTempDir(async (root) => {
    const directory = await schemaApp(root, body('mode: "0644"\n'), [{
      path: "templates/application.json",
      content: "{}\n",
    }]);
    const cluster = await loadCluster(directory);
    assertEquals(cluster.apps.get("demo")!.mode, "0644");
    const deploy = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(deploy.steps[0].mode, "0644");
    const restart = buildPlan(cluster, { action: "restart", apps: ["demo"] });
    assertEquals(restart.steps[0].mode, "0644");
  });

  for (const invalid of ["8888", "4755", "07000", "rwxr", ""]) {
    await withTempDir(async (root) => {
      const directory = await schemaApp(root, body(`mode: "${invalid}"\n`));
      const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
      assertStringIncludes(error.message, "app[demo].mode");
    });
  }

  await withTempDir(async (root) => {
    const packageless = `schema_version: 1
name: demo
mode: "0644"
packageless: true
management:
  kind: service
  name: demo.service
  tool: systemctl
`;
    const directory = await schemaApp(root, packageless);
    await Deno.writeTextFile(
      join(directory, "app_versions.yaml"),
      "schema_version: 1\napps: {}\n",
    );
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "app[demo].mode requires a versioned deployment");
  });
});

Deno.test("unit/app schema 1: removed run_as/access_group fields fail closed", async () => {
  const body = (managementExtra: string) =>
    `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  kind: service
  name: demo.service
  tool: systemctl
${managementExtra}`;

  for (
    const [extra, field] of [["  run_as: deploy\n", "run_as"], [
      "  access_group: www-data\n",
      "access_group",
    ]] as const
  ) {
    await withTempDir(async (root) => {
      const directory = await schemaApp(root, body(extra));
      const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
      assertStringIncludes(error.message, field);
      assertStringIncludes(error.message, "unknown field");
    });
  }
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
    assertStringIncludes(error.message, "does not support the placeholder");
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
    assertStringIncludes(error.message, "is incompatible with format: nginx");
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
      read: [/etc/demo/input.json]
      write: [/srv/demo/state]
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    format: json
management:
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
    assertEquals(plan.steps[0].scripts[0]?.permissions.read, ["/etc/demo/input.json"]);
    assertEquals(plan.steps[0].scripts[0]?.permissions.write, ["/srv/demo/state"]);
  });
});

Deno.test("unit/app schema 1: script and file configs plan configure and stage without activation", async () => {
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
      read: [/etc/demo/input.json]
      write: [/srv/demo/state]
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    format: json
management:
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
    const plan = buildPlan(cluster, {
      action: "deploy",
      apps: ["demo"],
      activate: false,
    });
    assertEquals(plan.steps.map((step) => step.action), ["configure", "stage"]);
    assertEquals(plan.steps[0].scripts[0]?.relativePath, "scripts/configure.ts");
    assertEquals(plan.steps.at(-1)?.dependsOn, ["app:node-a/demo:configure"]);
  });
});

Deno.test("unit/app schema 1: script file permissions fail closed", async () => {
  const cases: readonly [string, string, string][] = [
    [
      "relative read path",
      "      read: [etc/demo/input.json]\n      write: []\n",
      "must be a canonical absolute POSIX file path",
    ],
    [
      "root write path",
      "      read: []\n      write: [/]\n",
      "must be a canonical absolute POSIX file path",
    ],
    [
      "comma-containing path",
      "      read: []\n      write: ['/srv/a,b']\n",
      "contains whitespace, control characters, or commas",
    ],
    [
      "duplicate read paths",
      "      read: [/etc/a, /etc/a]\n      write: []\n",
      "contains a duplicate value",
    ],
    [
      "unknown permission field",
      "      file: []\n",
      "contains unknown fields: file",
    ],
  ];
  for (const [label, permissionExtra, message] of cases) {
    await withTempDir(async (root) => {
      const body = `schema_version: 1
name: demo
install_directory: /srv/demo
configs:
  - kind: script
    path: scripts/configure.ts
    permissions:
      run: [/usr/bin/test]
      net: []
${permissionExtra}management:
  kind: service
  name: demo.service
  tool: systemctl
`;
      const directory = await schemaApp(root, body, [{
        path: "scripts/configure.ts",
        content: "Deno.exit(0);\n",
      }]);
      const error = await assertRejects(
        () => loadCluster(directory),
        ConfigurationError,
      );
      assertStringIncludes(
        error.message,
        message,
        `${label}: ${error.message}`,
      );
    });
  }
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
      "app[demo].configs.file[0].target uses an install directory variable, but the App is missing install_directory",
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
    assertStringIncludes(error.message, "must contain exactly one directory variable");
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
    const staged = buildPlan(cluster, {
      action: "deploy",
      apps: ["demo"],
      activate: false,
    });
    assertEquals(staged.steps.map((step) => step.action), ["stage"]);
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
      message: "must contain exactly one directory variable",
    },
    {
      workingDirectory: `x/${"${LATEST_DIRECTORY}"}`,
      message: "supports only values starting with",
    },
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/../x"}`,
      message: "must be followed by a canonical relative path after the directory variable",
    },
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/"}`,
      message: "must be followed by a canonical relative path after the directory variable",
    },
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/a/./b"}`,
      message: "must be followed by a canonical relative path after the directory variable",
    },
    {
      workingDirectory: `${"${UNKNOWN}"}`,
      message: "supports only the",
    },
    {
      workingDirectory: `${"${LATEST_DIRECTORY}/x${MORE}"}`,
      message: "must be followed by a canonical relative path after the directory variable",
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
    assertStringIncludes(error.message, "missing install_directory");
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
      assertStringIncludes(error.message, "app[demo].schema_version supports only 1");
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
  kind: service
  name: demo.service
  tool: systemctl
`;
    const directory = await schemaApp(root, body);
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "Top-level scripts in");
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
  service:
    kind: system
    name: demo.service
    tool: systemctl
`;
    const directory = await schemaApp(root, body);
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "app[demo].management contains unknown fields: service");
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
      `management:\n  kind: service\n  name: demo.service\n  tool: rc-service\n`,
    ],
    [
      "service-unit-tool",
      `management:\n  kind: service\n  name: demo.service\n  tool: service\n  unit_config:\n    working_directory: latest\n    command: bin/server\n`,
    ],
  ];
  for (const [_label, extra] of cases) {
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
    assertStringIncludes(error.message, "contains a duplicate target path");
  });
});

Deno.test("unit/app schema 1: service defaults to enabled on boot unless explicitly disabled", async () => {
  const body = (management: string) =>
    `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
${management}`;
  await withTempDir(async (root) => {
    const directory = await schemaApp(
      root,
      body(`management:\n  kind: service\n  name: demo.service\n  tool: systemctl\n`),
    );
    const manager = (await loadCluster(directory)).apps.get("demo")!.management!.manager!;
    assertEquals(manager.kind, "service");
    if (manager.kind !== "service") throw new Error("expected service manager");
    assertEquals(manager.enabled, true);
    assertEquals(manager.enabledExplicit, false);
  });
  await withTempDir(async (root) => {
    const directory = await schemaApp(
      root,
      body(
        `management:\n  kind: service\n  name: demo.service\n  tool: systemctl\n  enabled: false\n`,
      ),
    );
    const manager = (await loadCluster(directory)).apps.get("demo")!.management!.manager!;
    assertEquals(manager.kind, "service");
    if (manager.kind !== "service") throw new Error("expected service manager");
    assertEquals(manager.enabled, false);
    assertEquals(manager.enabledExplicit, true);
  });
});

Deno.test("unit/app schema 1: tool service accepts the enabled declaration", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
management:
  kind: service
  name: demo.service
  tool: service
  enabled: true
`;
    const directory = await schemaApp(root, body);
    const manager = (await loadCluster(directory)).apps.get("demo")!.management!.manager!;
    assertEquals(manager.kind, "service");
    if (manager.kind !== "service") throw new Error("expected service manager");
    assertEquals(manager.tool, "service");
    assertEquals(manager.enabled, true);
    assertEquals(manager.enabledExplicit, true);
  });
});

const configOnlyVersioned = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
configs:
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    format: json
  - kind: script
    path: scripts/configure.ts
    permissions: {run: [], net: []}
`;

const configOnlyFiles = [
  { path: "templates/application.json", content: '{"listen":"127.0.0.1:8080"}\n' },
  { path: "scripts/configure.ts", content: "Deno.exit(0);\n" },
];

Deno.test("unit/app schema 1: configs without management are retained and planned (117)", async () => {
  await withTempDir(async (root) => {
    const directory = await schemaApp(root, configOnlyVersioned, configOnlyFiles);
    const cluster = await loadCluster(directory);
    const app = cluster.apps.get("demo")!;
    assertEquals(app.management?.configs.length, 1);
    assertEquals(app.management?.configScripts.length, 1);
    assertEquals(app.management?.manager, undefined);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(plan.steps.map((step) => step.action), ["configure", "stage", "activate"]);
    for (const step of plan.steps) {
      assertEquals(step.management?.configs.length, 1);
      assertEquals(step.management?.configScripts.length, 1);
      assertEquals(step.management?.manager, undefined);
    }
    assertEquals(plan.steps[0].scripts.length, 1);
    assertEquals(plan.steps[0].scripts[0].relativePath, "scripts/configure.ts");
  });
});

Deno.test("unit/app schema 1: file-only configs without management publish during stage phases (117)", async () => {
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
`;
    const directory = await schemaApp(root, body, [{
      path: "templates/application.json",
      content: '{"listen":"127.0.0.1:8080"}\n',
    }]);
    const cluster = await loadCluster(directory);
    const app = cluster.apps.get("demo")!;
    assertEquals(app.management?.manager, undefined);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(plan.steps.map((step) => step.action), ["stage", "activate"]);
    for (const step of plan.steps) {
      assertEquals(step.management?.configs.length, 1);
      assertEquals(step.management?.manager, undefined);
    }
  });
});

Deno.test("unit/app schema 1: packageless configs without management plan configure delivery (117)", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
packageless: true
configs:
  - kind: file
    source: templates/application.json
    target: /etc/demo/application.json
    format: json
`;
    const directory = await schemaApp(root, body, [{
      path: "templates/application.json",
      content: '{"listen":"127.0.0.1:8080"}\n',
    }]);
    await Deno.writeTextFile(
      join(directory, "app_versions.yaml"),
      "schema_version: 1\napps: {}\n",
    );
    const cluster = await loadCluster(directory);
    const app = cluster.apps.get("demo")!;
    assertEquals(app.packageless, true);
    assertEquals(app.management?.configs.length, 1);
    assertEquals(app.management?.manager, undefined);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(plan.steps.map((step) => step.action), ["configure"]);
    assertEquals(plan.steps[0].management?.configs.length, 1);
    assertEquals(plan.steps[0].management?.manager, undefined);
  });
});

Deno.test("unit/app schema 1: no configs and no management keep management undefined (117)", async () => {
  await withTempDir(async (root) => {
    const body = `schema_version: 1
name: demo
install_directory: /srv/demo
deployment:
  kind: versioned
`;
    const directory = await schemaApp(root, body);
    const cluster = await loadCluster(directory);
    assertEquals(cluster.apps.get("demo")!.management, undefined);
    const plan = buildPlan(cluster, { action: "deploy", apps: ["demo"] });
    assertEquals(plan.steps.map((step) => step.action), ["stage", "activate"]);
    for (const step of plan.steps) assertEquals(step.management, undefined);
  });
});

Deno.test("unit/app schema 1: on_change without management still fails closed (117)", async () => {
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
    on_change: restart
`;
    const directory = await schemaApp(root, body, [{
      path: "templates/application.json",
      content: "{}\n",
    }]);
    const error = await assertRejects(() => loadCluster(directory), ConfigurationError);
    assertStringIncludes(error.message, "on_change requires management.kind: service");
  });
});

Deno.test("unit/app schema 1: configs-only apps reject lifecycle actions without a manager (117)", async () => {
  await withTempDir(async (root) => {
    const directory = await schemaApp(root, configOnlyVersioned, configOnlyFiles);
    const cluster = await loadCluster(directory);
    for (const action of ["start", "stop", "restart"]) {
      const error = assertThrows(
        () => buildPlan(cluster, { action, apps: ["demo"] }),
        PlanningError,
      );
      assertStringIncludes(error.message, `has no action script: ${action}`);
    }
  });
});
