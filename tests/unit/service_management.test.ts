import { assertEquals, assertRejects, assertStringIncludes } from "../_support/assert.ts";
import { FakeSession } from "../_support/fake_session.ts";
import { type CommandResult, commandResult } from "../../src/results.ts";
import {
  convergeSystemd,
  inspectSystemd,
  restoreSystemd,
  type SystemdState,
} from "../../src/service_management.ts";
import { TransportError } from "../../src/errors.ts";
import type { RemoteRunOptions } from "../../src/transport.ts";
import type { SystemdServiceManagement } from "../../src/types.ts";

class SystemdSession extends FakeSession {
  readonly systemdCalls: Array<{ argv: readonly string[]; options: RemoteRunOptions }> = [];
  enabled = false;
  active = true;
  enabledExitCode?: number;
  enabledOutput?: string;
  activeExitCode?: number;
  activeOutput?: string;
  failAction?: string;
  ignoreAction?: string;

  override run(argv: readonly string[], options: RemoteRunOptions = {}): Promise<CommandResult> {
    if (argv[0] !== "systemctl") return super.run(argv, options);
    this.systemdCalls.push({ argv: [...argv], options });
    const action = argv[1];
    if (action === "--version") return Promise.resolve(commandResult(0, "systemd 255\n"));
    if (action === "is-enabled") {
      return Promise.resolve(
        commandResult(
          this.enabledExitCode ?? (this.enabled ? 0 : 1),
          this.enabledOutput ?? (this.enabled ? "enabled\n" : "disabled\n"),
        ),
      );
    }
    if (action === "is-active") {
      return Promise.resolve(
        commandResult(
          this.activeExitCode ?? (this.active ? 0 : 3),
          this.activeOutput ?? (this.active ? "active\n" : "inactive\n"),
        ),
      );
    }
    if (this.failAction === action) {
      this.failAction = undefined;
      return Promise.resolve(commandResult(1, "", "failure"));
    }
    if (this.ignoreAction !== action) {
      if (action === "enable") this.enabled = true;
      if (action === "disable") this.enabled = false;
      if (action === "start" || action === "reload" || action === "restart") this.active = true;
      if (action === "stop") this.active = false;
    }
    return Promise.resolve(commandResult(0));
  }
}

function service(overrides: Partial<SystemdServiceManagement> = {}): SystemdServiceManagement {
  return Object.freeze({
    kind: "systemd" as const,
    unit: "demo.service",
    enabled: true,
    daemonReload: true,
    onDeploy: "reload" as const,
    timeoutMs: 900,
    ...overrides,
  });
}

Deno.test("unit/systemd: deploy 合并 daemon-reload、enable 与 restart 且各执行一次", async () => {
  const session = new SystemdSession();
  const definition = service();
  const before = await inspectSystemd(session, definition);
  const result = await convergeSystemd(
    session,
    definition,
    { operation: "deploy", changed: true, configAction: "restart" },
    before,
  );
  assertEquals(result.action, "restart");
  assertEquals(result.enableAction, "enable");
  assertEquals(result.daemonReloaded, true);
  assertEquals(session.systemdCalls.map((call) => call.argv.slice(0, 2)), [
    ["systemctl", "--version"],
    ["systemctl", "is-enabled"],
    ["systemctl", "is-active"],
    ["systemctl", "daemon-reload"],
    ["systemctl", "enable"],
    ["systemctl", "restart"],
    ["systemctl", "is-enabled"],
    ["systemctl", "is-active"],
  ]);
  assertEquals(
    session.systemdCalls.filter((call) => call.argv[1] !== "--version").every((call) =>
      call.options.timeoutMs === 900
    ),
    true,
  );
});

Deno.test("unit/systemd: not-found 是首次部署的未启用/未运行基线", async () => {
  const session = new SystemdSession();
  session.enabledExitCode = 4;
  session.enabledOutput = "not-found\n";
  session.activeExitCode = 4;
  session.activeOutput = "inactive\n";
  let state = await inspectSystemd(session, service());
  assertEquals(state, {
    enabled: false,
    enabledState: "not-found",
    active: false,
    activeState: "inactive",
  });

  session.activeExitCode = 4;
  session.activeOutput = "not-found\n";
  state = await inspectSystemd(session, service());
  assertEquals(state, {
    enabled: false,
    enabledState: "not-found",
    active: false,
    activeState: "not-found",
  });

  session.enabledExitCode = 4;
  session.enabledOutput = "failed\n";
  session.activeExitCode = 3;
  session.activeOutput = "inactive\n";
  await assertRejects(
    () => inspectSystemd(session, service()),
    TransportError,
    "读取 systemd enable 状态失败: failed",
  );

  session.enabledExitCode = 1;
  session.enabledOutput = "disabled\n";
  session.activeExitCode = 4;
  session.activeOutput = "inactive\n";
  await assertRejects(
    () => inspectSystemd(session, service()),
    TransportError,
    "读取 systemd active 状态失败: inactive",
  );
});

Deno.test("unit/systemd: unchanged 配置不触发服务动作", async () => {
  const session = new SystemdSession();
  const definition = service({ enabled: undefined, daemonReload: false, onDeploy: "none" });
  const before: SystemdState = Object.freeze({
    enabled: false,
    enabledState: "disabled",
    active: true,
    activeState: "active",
  });
  const result = await convergeSystemd(
    session,
    definition,
    { operation: "configure", changed: false, configAction: "restart" },
    before,
  );
  assertEquals(result.action, "none");
  assertEquals(
    session.systemdCalls.some((call) => ["reload", "restart"].includes(call.argv[1])),
    false,
  );
});

Deno.test("unit/systemd: 命令失败和状态未收敛均给出实际状态", async () => {
  const before: SystemdState = Object.freeze({
    enabled: false,
    enabledState: "disabled",
    active: false,
    activeState: "inactive",
  });
  const failed = new SystemdSession();
  failed.active = false;
  failed.failAction = "start";
  const commandError = await assertRejects(
    () =>
      convergeSystemd(failed, service({ enabled: undefined }), {
        operation: "start",
        changed: false,
      }, before),
    TransportError,
  );
  assertStringIncludes(commandError.message, "实际 enabled=");

  const stale = new SystemdSession();
  stale.active = false;
  stale.ignoreAction = "start";
  await assertRejects(
    () =>
      convergeSystemd(stale, service({ enabled: undefined }), {
        operation: "start",
        changed: false,
      }, before),
    TransportError,
    "实际 enabled=disabled active=inactive",
  );
});

Deno.test("unit/systemd: restore 按事前 active/enable 状态执行有界补偿", async () => {
  const session = new SystemdSession();
  session.enabled = true;
  session.active = false;
  const restored = await restoreSystemd(
    session,
    service(),
    Object.freeze({
      enabled: false,
      enabledState: "disabled",
      active: true,
      activeState: "active",
    }),
    true,
  );
  assertEquals(restored.enabled, false);
  assertEquals(restored.active, true);
  assertEquals(
    session.systemdCalls.filter((call) => ["start", "disable"].includes(call.argv[1])).map((call) =>
      call.argv[1]
    ),
    [
      "start",
      "disable",
    ],
  );
});
