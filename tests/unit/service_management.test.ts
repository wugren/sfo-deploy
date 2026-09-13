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
import type { AppServiceManagement } from "../../src/types.ts";

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
  resetFailed = false;

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
    if (action === "reset-failed") {
      this.resetFailed = true;
      this.active = false;
      this.activeExitCode = undefined;
      this.activeOutput = undefined;
      return Promise.resolve(commandResult(0));
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

function service(overrides: Partial<AppServiceManagement> = {}): AppServiceManagement {
  return Object.freeze({
    kind: "service" as const,
    unit: "demo.service",
    tool: "systemctl" as const,
    enabled: true,
    daemonReload: true,
    onDeploy: "reload" as const,
    timeoutMs: 900,
    ...overrides,
  });
}

class ServiceOnlySession extends FakeSession {
  readonly serviceCalls: Array<{ argv: readonly string[]; options: RemoteRunOptions }> = [];
  active = true;

  override run(argv: readonly string[], options: RemoteRunOptions = {}): Promise<CommandResult> {
    if (argv[0] === "/bin/sh" && argv[1] === "-c" && argv[2]?.includes("/usr/bin/service")) {
      this.calls.push({ argv: [...argv], options });
      return Promise.resolve(commandResult(0, "/usr/bin/service\n"));
    }
    if (argv[0].endsWith("/service")) {
      this.serviceCalls.push({ argv: [...argv], options });
      if (argv[2] === "status") {
        return Promise.resolve(
          commandResult(this.active ? 0 : 3, this.active ? "active\n" : "inactive\n"),
        );
      }
      if (argv[2] === "start" || argv[2] === "restart") this.active = true;
      if (argv[2] === "stop") this.active = false;
      return Promise.resolve(commandResult(0));
    }
    return super.run(argv, options);
  }
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
  assertEquals(session.systemdCalls.map((call) => call.argv), [
    ["systemctl", "--version"],
    ["systemctl", "is-enabled", "--", "demo.service"],
    ["systemctl", "is-active", "--", "demo.service"],
    ["systemctl", "daemon-reload"],
    ["systemctl", "enable", "--", "demo.service"],
    ["systemctl", "restart", "--", "demo.service"],
    ["systemctl", "is-enabled", "--", "demo.service"],
    ["systemctl", "is-active", "--", "demo.service"],
  ]);
  assertEquals(
    session.systemdCalls.filter((call) => call.argv[1] !== "--version").every((call) =>
      call.options.timeoutMs === 900
    ),
    true,
  );
});

Deno.test("unit/systemd: prepare and restore clear a failed unit before recovery", async () => {
  const session = new SystemdSession();
  session.active = false;
  session.activeExitCode = 1;
  session.activeOutput = "failed\n";
  const definition = service();
  const before = await inspectSystemd(session, definition);
  assertEquals(before.activeState, "failed");
  await convergeSystemd(
    session,
    definition,
    { operation: "start", changed: false },
    before,
  );
  assertEquals(session.systemdCalls.map((call) => call.argv), [
    ["systemctl", "--version"],
    ["systemctl", "is-enabled", "--", "demo.service"],
    ["systemctl", "is-active", "--", "demo.service"],
    ["systemctl", "reset-failed", "--", "demo.service"],
    ["systemctl", "enable", "--", "demo.service"],
    ["systemctl", "start", "--", "demo.service"],
    ["systemctl", "is-enabled", "--", "demo.service"],
    ["systemctl", "is-active", "--", "demo.service"],
  ]);

  const restoreSession = new SystemdSession();
  restoreSession.active = false;
  restoreSession.activeExitCode = 1;
  restoreSession.activeOutput = "failed\n";
  await restoreSystemd(
    restoreSession,
    definition,
    { enabled: true, enabledState: "enabled", active: false, activeState: "inactive" },
    false,
  );
  assertEquals(
    restoreSession.systemdCalls.some((call) =>
      JSON.stringify(call.argv) === JSON.stringify([
        "systemctl",
        "reset-failed",
        "--",
        "demo.service",
      ])
    ),
    true,
  );
});

Deno.test("unit/systemd: missing unit with failed systemd record is resettable", async () => {
  const session = new SystemdSession();
  session.enabledExitCode = 4;
  session.enabledOutput = "not-found\n";
  session.activeExitCode = 4;
  session.activeOutput = "failed\n";
  const state = await inspectSystemd(session, service());
  assertEquals(state, {
    enabled: false,
    enabledState: "not-found",
    active: false,
    activeState: "failed",
  });
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
    "Failed to read systemd enable state: failed",
  );

  session.enabledExitCode = 1;
  session.enabledOutput = "disabled\n";
  session.activeExitCode = 4;
  session.activeOutput = "inactive\n";
  await assertRejects(
    () => inspectSystemd(session, service()),
    TransportError,
    "Failed to read systemd active state: inactive",
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
  assertStringIncludes(commandError.message, "actual enabled=");

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
    "actual enabled=disabled active=inactive",
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

Deno.test("unit/systemd: auto falls back to service for prepare, action, and restore", async () => {
  const session = new ServiceOnlySession();
  session.active = false;
  const definition = service({
    tool: "auto",
    enabled: undefined,
    daemonReload: false,
    onDeploy: "none",
  });
  const before = await inspectSystemd(session, definition);
  const result = await convergeSystemd(
    session,
    definition,
    { operation: "start", changed: false },
    before,
  );
  assertEquals(result.action, "start");
  assertEquals(result.after.active, true);
  assertEquals(
    session.serviceCalls.map((call) => call.argv[2]),
    ["status", "start", "status"],
  );

  session.active = false;
  const restored = await restoreSystemd(session, definition, before, false);
  assertEquals(restored.active, false);
  assertEquals(
    session.serviceCalls.map((call) => call.argv[2]),
    ["status", "start", "status", "status", "status", "status"],
  );
  assertEquals(session.serviceCalls.every((call) => call.argv[0].endsWith("/service")), true);
  assertEquals(session.calls.some((call) => call.argv[0] === "systemctl"), false);
});
