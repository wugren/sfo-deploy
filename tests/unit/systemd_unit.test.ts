import { assertEquals } from "../_support/assert.ts";
import { PreflightError } from "../../src/errors.ts";
import { generateSystemdUnitSkeleton, serviceUnitManagedConfig } from "../../src/systemd_unit.ts";
import type { SystemdServiceManagement } from "../../src/types.ts";

function service(
  overrides: Partial<SystemdServiceManagement> = {},
): SystemdServiceManagement {
  return Object.freeze({
    kind: "systemd",
    unit: "demo.service",
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

Deno.test("unit/systemd-unit: quotes arguments and rejects systemd metacharacters", () => {
  const config = serviceUnitManagedConfig(service({
    unitConfig: {
      target: "/etc/systemd/system/demo.service",
      workingDirectory: "/srv/demo/my app",
      command: "/srv/demo/my app/bin/server",
      args: ["", "--message=hello world"],
    },
  }))!;
  const skeleton = generateSystemdUnitSkeleton(
    config,
    service({
      unitConfig: {
        target: "/etc/systemd/system/demo.service",
        workingDirectory: "/srv/demo/my app",
        command: "/srv/demo/my app/bin/server",
        args: ["", "--message=hello world"],
      },
    }),
    "deploy",
  );
  const text = new TextDecoder().decode(skeleton.content);
  assertEquals(text.includes('WorkingDirectory="/srv/demo/my app"'), true);
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
