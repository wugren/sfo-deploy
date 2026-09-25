import { assertEquals } from "../_support/assert.ts";
import { PreflightError } from "../../src/errors.ts";
import {
  generateSystemdUnitSkeleton,
  resolveUnitUser,
  serviceUnitManagedConfig,
} from "../../src/systemd_unit.ts";
import type { AppServiceManagement } from "../../src/types.ts";

async function systemdAnalyze(): Promise<string | undefined> {
  try {
    const probe = await new Deno.Command("sh", {
      args: ["-c", "command -v systemd-analyze"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!probe.success) return undefined;
    const path = new TextDecoder().decode(probe.stdout).trim();
    return path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

function service(
  overrides: Partial<AppServiceManagement> = {},
): AppServiceManagement {
  return Object.freeze({
    kind: "service",
    unit: "demo.service",
    tool: "auto",
    enabled: true,
    daemonReload: true,
    onDeploy: "restart",
    timeoutMs: 30_000,
    unitConfig: Object.freeze({
      target: "/etc/systemd/system/demo.service",
      workingDirectory: "/srv/demo/current",
      command: "/srv/demo/current/bin/server",
      args: Object.freeze(["--config", "config/application.ini"]),
    }),
    ...overrides,
  });
}

Deno.test("unit/systemd-unit: service unit_config becomes root-owned managed candidate", () => {
  const config = serviceUnitManagedConfig(service())!;
  assertEquals(config.name, "sfo-systemd-demo.service");
  assertEquals(config.target, "/etc/systemd/system/demo.service");
  assertEquals(config.owner, "root");
  assertEquals(config.group, "root");
  assertEquals(config.mode, 0o644);
  assertEquals(config.format, "systemd");
  assertEquals(config.onChange, "restart");
  assertEquals(
    serviceUnitManagedConfig({
      ...service(),
      unitConfig: undefined,
    }),
    undefined,
  );
});

Deno.test("unit/systemd-unit: renders deterministic absolute ExecStart and WorkingDirectory", () => {
  const config = serviceUnitManagedConfig(service())!;
  const skeleton = generateSystemdUnitSkeleton(config, service(), "deploy");
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(
    text,
    `[Unit]
Description=sfo-deploy managed demo.service
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/demo/current
ExecStart=/srv/demo/current/bin/server --config config/application.ini

[Install]
WantedBy=multi-user.target
`,
  );
  assertEquals(skeleton.format, "systemd");
  assertEquals(skeleton.secretBindings, []);
});

Deno.test("unit/systemd-unit: renders optional restart policy directives", () => {
  const unitConfig = {
    ...service().unitConfig!,
    restartPolicy: "on-failure" as const,
    restartSec: 5,
    startLimitIntervalSec: 30,
    startLimitBurst: 5,
  };
  const config = serviceUnitManagedConfig(service({ unitConfig }))!;
  const skeleton = generateSystemdUnitSkeleton(config, service({ unitConfig }), "deploy");
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(text.includes("StartLimitIntervalSec=30s"), true);
  assertEquals(text.includes("StartLimitBurst=5"), true);
  assertEquals(text.includes("Restart=on-failure"), true);
  assertEquals(text.includes("RestartSec=5s"), true);
  const unitIndex = text.indexOf("[Unit]");
  const serviceIndex = text.indexOf("[Service]");
  assertEquals(
    text.indexOf("StartLimitIntervalSec") > unitIndex &&
      text.indexOf("StartLimitIntervalSec") < serviceIndex,
    true,
  );
  assertEquals(text.indexOf("Restart=on-failure") > serviceIndex, true);
});

Deno.test("unit/systemd-unit: explicit no and zero restart directives are preserved", () => {
  const unitConfig = {
    ...service().unitConfig!,
    restartPolicy: "no" as const,
    restartSec: 0,
    startLimitIntervalSec: 0,
    startLimitBurst: 0,
  };
  const config = serviceUnitManagedConfig(service({ unitConfig }))!;
  const skeleton = generateSystemdUnitSkeleton(config, service({ unitConfig }), "deploy");
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(text.includes("Restart=no"), true);
  assertEquals(text.includes("RestartSec=0s"), true);
  assertEquals(text.includes("StartLimitIntervalSec=0s"), true);
  assertEquals(text.includes("StartLimitBurst=0"), true);
});

Deno.test("unit/systemd-unit: omitted restart policy fields preserve legacy output", () => {
  const config = serviceUnitManagedConfig(service())!;
  const skeleton = generateSystemdUnitSkeleton(config, service(), "deploy");
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(/^(Restart|RestartSec|StartLimit)/m.test(text), false);
});

Deno.test("unit/systemd-unit: quotes ExecStart arguments and rejects systemd metacharacters", () => {
  const unitConfig = {
    target: "/etc/systemd/system/demo.service",
    workingDirectory: "/srv/demo/current",
    command: "/srv/demo/my app/bin/server",
    args: ["", "--message=hello world"],
  };
  const config = serviceUnitManagedConfig(service({ unitConfig }))!;
  const skeleton = generateSystemdUnitSkeleton(config, service({ unitConfig }), "deploy");
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(text.includes("WorkingDirectory=/srv/demo/current"), true);
  assertEquals(
    text.includes('ExecStart="/srv/demo/my app/bin/server" "" "--message=hello world"'),
    true,
  );
  for (const argument of ["$HOME", "%p", "bad\nline", "bad\\path", 'bad"quote']) {
    const config = serviceUnitManagedConfig(service({
      unitConfig: {
        target: "/etc/systemd/system/demo.service",
        workingDirectory: "/srv/demo/current",
        command: "/srv/demo/current/bin/server",
        args: [argument],
      },
    }))!;
    let rejected = false;
    try {
      generateSystemdUnitSkeleton(
        config,
        service({
          unitConfig: {
            target: "/etc/systemd/system/demo.service",
            workingDirectory: "/srv/demo/current",
            command: "/srv/demo/current/bin/server",
            args: [argument],
          },
        }),
        "deploy",
      );
    } catch (error) {
      if (!(error instanceof PreflightError)) throw error;
      rejected = true;
    }
    assertEquals(rejected, true);
  }
});

Deno.test("unit/systemd-unit: single-quote ExecStart arguments are double quoted and paths stay literal", () => {
  const unitConfig = {
    target: "/etc/systemd/system/demo.service",
    workingDirectory: "/srv/deploy/it's",
    command: "/srv/deploy/it's/bin/server",
    args: ["--path=it's"],
  };
  const config = serviceUnitManagedConfig(service({ unitConfig }))!;
  const skeleton = generateSystemdUnitSkeleton(config, service({ unitConfig }), "deploy");
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(text.includes(`WorkingDirectory=/srv/deploy/it's`), true);
  assertEquals(text.includes(`WorkingDirectory="/srv/deploy/it's"`), false);
  assertEquals(
    text.includes(`ExecStart="/srv/deploy/it's/bin/server" "--path=it's"`),
    true,
  );
});

Deno.test("unit/systemd-unit: semicolon ExecStart arguments are double quoted to stay literal", () => {
  const unitConfig = {
    target: "/etc/systemd/system/demo.service",
    workingDirectory: "/srv/demo/current",
    command: "/srv/demo/current/bin/server",
    args: ["--rule=name=value;other=1", "plain"],
  };
  const config = serviceUnitManagedConfig(service({ unitConfig }))!;
  const skeleton = generateSystemdUnitSkeleton(config, service({ unitConfig }), "deploy");
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(
    text.includes('ExecStart=/srv/demo/current/bin/server "--rule=name=value;other=1" plain'),
    true,
  );
  assertEquals(
    text.includes("ExecStart=/srv/demo/current/bin/server --rule=name=value;other=1"),
    false,
  );
});

Deno.test("unit/systemd-unit: whitespace working directory fails closed", () => {
  for (const workingDirectory of ["/srv/demo/my app", "/srv/de\tmo"]) {
    const unitConfig = {
      target: "/etc/systemd/system/demo.service",
      workingDirectory,
      command: "/srv/demo/current/bin/server",
      args: [],
    };
    const config = serviceUnitManagedConfig(service({ unitConfig }))!;
    let rejected = false;
    try {
      generateSystemdUnitSkeleton(config, service({ unitConfig }), "deploy");
    } catch (error) {
      if (!(error instanceof PreflightError)) throw error;
      rejected = true;
    }
    assertEquals(rejected, true);
  }
});

Deno.test("unit/systemd-unit: generated unit with single-quote path passes systemd-analyze verify", async () => {
  const unitConfig = {
    target: "/etc/systemd/system/demo.service",
    workingDirectory: "/srv/deploy/it's",
    command: "/bin/echo",
    args: ["it's", "hello world", ""],
  };
  const config = serviceUnitManagedConfig(service({ unitConfig }))!;
  const skeleton = generateSystemdUnitSkeleton(config, service({ unitConfig }), "deploy");
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(text.includes(`ExecStart=/bin/echo "it's" "hello world" ""`), true);
  const analyze = await systemdAnalyze();
  if (analyze === undefined) return;
  const directory = await Deno.makeTempDir({ prefix: "sfo-deploy-unit-" });
  try {
    const path = `${directory}/demo.service`;
    await Deno.writeTextFile(path, text);
    const result = await new Deno.Command(analyze, {
      args: ["verify", path],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `systemd-analyze verify rejected the generated unit: ${
          new TextDecoder().decode(result.stderr).trim()
        }`,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("unit/systemd-unit: unit user defaults to SSH identity including root", () => {
  assertEquals(resolveUnitUser(service(), "deploy"), "deploy");
  assertEquals(resolveUnitUser(service(), "root"), "root");
  assertEquals(
    resolveUnitUser(
      service({
        unitConfig: {
          target: "/etc/systemd/system/demo.service",
          workingDirectory: "/srv/demo/current",
          command: "/srv/demo/current/bin/server",
          args: [],
          user: "app",
        },
      }),
      "root",
    ),
    "app",
  );
  const rootService = service({ unitConfig: { ...service().unitConfig!, user: "root" } });
  assertEquals(resolveUnitUser(rootService, "deploy"), "root");
  const candidate = serviceUnitManagedConfig(rootService)!;
  const text = new TextDecoder().decode(
    generateSystemdUnitSkeleton(candidate, rootService, resolveUnitUser(rootService, "deploy"))
      .content,
  );
  assertEquals(text.includes("\nUser=root\n"), true);
});
