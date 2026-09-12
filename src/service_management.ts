/** systemd/SysV service 的固定 argv 生命周期编排、状态确认与有界补偿。 */

import { PreflightError, TransportError } from "./errors.ts";
import type { CommandResult } from "./results.ts";
import type { RemoteSession } from "./transport.ts";
import type {
  AppServiceManagement,
  ManagedConfigChangeAction,
  SystemdDeployAction,
} from "./types.ts";
import { detectServiceTool } from "./environment_runtime.ts";

const SYSTEMCTL = "systemctl";
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/;

export interface ServiceTool {
  readonly kind: "systemctl" | "service";
  readonly path: string;
}

export interface SystemdState {
  readonly enabled: boolean;
  readonly enabledState: string;
  readonly active: boolean;
  readonly activeState: string;
}

export type SystemdOperation = "deploy" | "configure" | "start" | "stop" | "restart";
export type SystemdExecutedAction = "none" | "start" | "stop" | "reload" | "restart";

export interface SystemdConvergeRequest {
  readonly operation: SystemdOperation;
  readonly changed: boolean;
  readonly configAction?: ManagedConfigChangeAction;
  readonly actionOverride?: SystemdExecutedAction;
}

export interface SystemdConvergence {
  readonly before: SystemdState;
  readonly after: SystemdState;
  readonly daemonReloaded: boolean;
  readonly enableAction: "none" | "enable" | "disable";
  readonly action: SystemdExecutedAction;
}

/** 在任何配置发布或 systemctl 变更前确认依赖、提权能力和当前状态。 */
export async function inspectSystemd(
  session: RemoteSession,
  service: AppServiceManagement,
  signal?: AbortSignal,
): Promise<SystemdState> {
  validateService(service);
  await session.preflightPrivilege(signal);
  const tool = await resolveServiceTool(session, service, signal);
  if (tool.kind === "systemctl") {
    requireSuccess(
      await session.run([tool.path, "--version"], { signal, timeoutMs: service.timeoutMs }),
      "目标节点不可使用 systemd",
    );
  }
  return await readState(session, service, signal);
}

export interface PreparedSystemdConvergence {
  readonly before: SystemdState;
  readonly tool: ServiceTool;
  readonly daemonReloaded: boolean;
  readonly enableAction: "none" | "enable" | "disable";
  readonly action: SystemdExecutedAction;
}

/** 所有 systemd 准备操作在版本切换之前完成。 */
export async function prepareSystemd(
  session: RemoteSession,
  service: AppServiceManagement,
  request: SystemdConvergeRequest,
  before: SystemdState,
  signal?: AbortSignal,
): Promise<PreparedSystemdConvergence> {
  validateService(service);
  await session.preflightPrivilege(signal);
  const action = request.actionOverride ?? selectedAction(service.onDeploy, request);
  const tool = await resolveServiceTool(session, service, signal);
  const daemonReloaded = service.daemonReload &&
    (request.operation === "deploy" || request.changed);
  const enableAction = service.enabled !== undefined && service.enabled !== before.enabled
    ? service.enabled ? "enable" : "disable"
    : "none";
  if (tool.kind === "systemctl" && before.activeState === "failed") {
    await serviceCommand(
      session,
      service,
      tool,
      ["reset-failed"],
      signal,
      "systemd reset-failed 失败",
    );
  }
  if (daemonReloaded) {
    await serviceCommand(
      session,
      service,
      tool,
      ["daemon-reload"],
      signal,
      "systemd daemon-reload 失败",
    );
  }
  if (enableAction !== "none") {
    await serviceCommand(
      session,
      service,
      tool,
      [enableAction],
      signal,
      `systemd ${enableAction} 失败`,
    );
  }
  return Object.freeze({ before, tool, daemonReloaded, enableAction, action });
}

/** 首条远端命令就是服务动作；调用者可在此前紧邻提交 latest。 */
export async function executePreparedSystemd(
  session: RemoteSession,
  service: AppServiceManagement,
  prepared: PreparedSystemdConvergence,
  signal?: AbortSignal,
): Promise<SystemdConvergence> {
  validateService(service);
  const tool = prepared.tool;
  const { action } = prepared;
  try {
    if (action !== "none") {
      await serviceCommand(
        session,
        service,
        tool,
        [action],
        signal,
        `systemd ${action} 失败`,
      );
    }
    const after = await readState(session, service, signal, tool);
    if (service.enabled !== undefined && after.enabled !== service.enabled) {
      throw new TransportError(`systemd enable 状态未收敛: ${after.enabledState}`);
    }
    if (
      ((action === "start" || action === "reload" || action === "restart") && !after.active) ||
      (action === "stop" && after.active)
    ) {
      throw new TransportError(`systemd active 状态未收敛: ${after.activeState}`);
    }
    return Object.freeze({ ...prepared, after });
  } catch (cause) {
    const actual = await readState(session, service, undefined, tool).catch(() => undefined);
    const suffix = actual === undefined
      ? "；无法读取实际状态"
      : `；实际 enabled=${actual.enabledState} active=${actual.activeState}`;
    throw new TransportError(`systemd 服务 ${service.unit} 收敛失败${suffix}`, { cause });
  }
}

/** 保留非版本部署及显式服务动作的公共接口。 */
export async function convergeSystemd(
  session: RemoteSession,
  service: AppServiceManagement,
  request: SystemdConvergeRequest,
  before: SystemdState,
  signal?: AbortSignal,
): Promise<SystemdConvergence> {
  const prepared = await prepareSystemd(session, service, request, before, signal);
  return await executePreparedSystemd(session, service, prepared, signal);
}

/** 配置或服务动作失败后的单次补偿；只恢复框架事前读取到的 enable/active 状态。 */
export async function restoreSystemd(
  session: RemoteSession,
  service: AppServiceManagement,
  before: SystemdState,
  daemonReload: boolean,
  signal?: AbortSignal,
  forceRestart = false,
): Promise<SystemdState> {
  validateService(service);
  await session.preflightPrivilege(signal);
  const tool = await resolveServiceTool(session, service, signal);
  if (daemonReload) {
    await serviceCommand(
      session,
      service,
      tool,
      ["daemon-reload"],
      signal,
      "恢复时 daemon-reload 失败",
    );
  }
  let current = await readState(session, service, signal);
  if (tool.kind === "systemctl" && current.activeState === "failed") {
    await serviceCommand(
      session,
      service,
      tool,
      ["reset-failed"],
      signal,
      "恢复时 systemd reset-failed 失败",
    );
    current = await readState(session, service, signal, tool);
  }
  if (current.active !== before.active || (forceRestart && before.active)) {
    const action = forceRestart && before.active ? "restart" : before.active ? "start" : "stop";
    await serviceCommand(
      session,
      service,
      tool,
      [action],
      signal,
      `恢复 systemd ${action} 状态失败`,
    );
  }
  current = await readState(session, service, signal);
  if (current.enabled !== before.enabled) {
    const action = before.enabled ? "enable" : "disable";
    await serviceCommand(
      session,
      service,
      tool,
      [action],
      signal,
      `恢复 systemd ${action} 状态失败`,
    );
  }
  const restored = await readState(session, service, signal);
  if (restored.active !== before.active || restored.enabled !== before.enabled) {
    throw new TransportError(
      `systemd 补偿未收敛: enabled=${restored.enabledState} active=${restored.activeState}`,
    );
  }
  return restored;
}

function selectedAction(
  onDeploy: SystemdDeployAction,
  request: SystemdConvergeRequest,
): SystemdExecutedAction {
  if (
    request.operation === "start" || request.operation === "stop" || request.operation === "restart"
  ) {
    return request.operation;
  }
  const candidates: SystemdExecutedAction[] = [];
  if (request.changed && request.configAction && request.configAction !== "none") {
    candidates.push(request.configAction);
  }
  if (request.operation === "deploy" && onDeploy !== "none") candidates.push(onDeploy);
  if (candidates.includes("restart")) return "restart";
  if (candidates.includes("reload")) return "reload";
  if (candidates.includes("start")) return "start";
  return "none";
}

async function readState(
  session: RemoteSession,
  service: AppServiceManagement,
  signal?: AbortSignal,
  toolInput?: ServiceTool,
): Promise<SystemdState> {
  const tool = toolInput ?? await resolveServiceTool(session, service, signal);
  const enabled = tool.kind === "systemctl"
    ? await session.run([tool.path, "is-enabled", "--", service.unit], {
      signal,
      timeoutMs: service.timeoutMs,
      privileged: true,
    })
    : Object.freeze({ exitCode: 1, stdout: "unknown-enabled", stderr: "" }) as CommandResult;
  const active = tool.kind === "systemctl"
    ? await session.run([tool.path, "is-active", "--", service.unit], {
      signal,
      timeoutMs: service.timeoutMs,
      privileged: true,
    })
    : await session.run([tool.path, service.unit, "status"], {
      signal,
      timeoutMs: service.timeoutMs,
      privileged: true,
    });
  const enabledState = stateText(enabled, "unknown-enabled");
  const activeState = stateText(active, "unknown-active");
  const isMissingUnit = enabled.exitCode === 4 && enabledState === "not-found";
  const isMissingUnitActive = isMissingUnit && active.exitCode === 4 &&
    (activeState === "inactive" || activeState === "not-found" ||
      activeState === "failed");
  if (enabled.exitCode !== 0 && enabled.exitCode !== 1 && !isMissingUnit) {
    throw new TransportError(`读取 systemd enable 状态失败: ${enabledState}`);
  }
  // systemctl is-active 对 inactive/failed 的常见退出码为 3；1 也作为非 active 状态接受。
  if (
    active.exitCode !== 0 && active.exitCode !== 1 && active.exitCode !== 3 &&
    !isMissingUnitActive
  ) {
    throw new TransportError(`读取 systemd active 状态失败: ${activeState}`);
  }
  return Object.freeze({
    enabled: enabled.exitCode === 0 &&
      (enabledState === "enabled" || enabledState === "enabled-runtime" ||
        enabledState === "linked" ||
        enabledState === "linked-runtime" || enabledState === "alias"),
    enabledState,
    active: active.exitCode === 0 && activeState === "active",
    activeState,
  });
}

async function serviceCommand(
  session: RemoteSession,
  service: AppServiceManagement,
  tool: ServiceTool,
  argv: readonly string[],
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  const command = tool.kind === "systemctl"
    ? argv[0] === "daemon-reload" ? [tool.path, ...argv] : [tool.path, ...argv, "--", service.unit]
    : [tool.path, service.unit, ...argv];
  requireSuccess(
    await session.run(command, {
      signal,
      timeoutMs: service.timeoutMs,
      privileged: true,
    }),
    label,
  );
}

async function resolveServiceTool(
  session: RemoteSession,
  service: AppServiceManagement,
  signal?: AbortSignal,
): Promise<ServiceTool> {
  if (service.tool === "systemctl") {
    return Object.freeze({ kind: "systemctl", path: SYSTEMCTL });
  }
  if (service.tool === "service") {
    return Object.freeze({ kind: "service", path: "service" });
  }
  const detected = await detectServiceTool(session, service.tool, signal);
  if (detected.kind !== "systemctl" && detected.kind !== "service") {
    throw new TransportError(`服务管理器探测返回了不支持的工具: ${detected.kind}`);
  }
  return Object.freeze({ kind: detected.kind, path: detected.path });
}

function stateText(result: CommandResult, fallback: string): string {
  const value = result.stdout.trim();
  if (/^[a-z][a-z-]*$/u.test(value)) return value;
  return fallback;
}

function validateService(service: AppServiceManagement): void {
  if (
    service?.kind !== "service" || !UNIT_RE.test(service.unit) || service.unit.includes("..") ||
    !Number.isFinite(service.timeoutMs) || service.timeoutMs <= 0
  ) {
    throw new PreflightError("service 管理声明不合法");
  }
}

function requireSuccess(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) throw new TransportError(label);
}
