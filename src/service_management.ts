/** systemd 的固定 argv 生命周期编排、状态确认与有界补偿。 */

import { PreflightError, TransportError } from "./errors.ts";
import type { CommandResult } from "./results.ts";
import type { RemoteSession } from "./transport.ts";
import type {
  ManagedConfigChangeAction,
  SystemdDeployAction,
  SystemdServiceManagement,
} from "./types.ts";

const SYSTEMCTL = "systemctl";
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/;

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
  service: SystemdServiceManagement,
  signal?: AbortSignal,
): Promise<SystemdState> {
  validateService(service);
  await session.preflightPrivilege(signal);
  requireSuccess(
    await session.run([SYSTEMCTL, "--version"], { signal, timeoutMs: service.timeoutMs }),
    "目标节点不可使用 systemd",
  );
  return await readState(session, service, signal);
}

/** 合并配置通知、on_deploy 和显式命令；每类副作用最多执行一次。 */
export async function convergeSystemd(
  session: RemoteSession,
  service: SystemdServiceManagement,
  request: SystemdConvergeRequest,
  before: SystemdState,
  signal?: AbortSignal,
): Promise<SystemdConvergence> {
  validateService(service);
  const action = selectedAction(service.onDeploy, request);
  const daemonReloaded = service.daemonReload &&
    (request.operation === "deploy" || request.changed);
  let enableAction: SystemdConvergence["enableAction"] = "none";
  try {
    if (daemonReloaded) {
      await systemctl(session, service, ["daemon-reload"], signal, "systemd daemon-reload 失败");
    }
    if (service.enabled !== undefined && service.enabled !== before.enabled) {
      enableAction = service.enabled ? "enable" : "disable";
      await systemctl(
        session,
        service,
        [enableAction, "--", service.unit],
        signal,
        `systemd ${enableAction} 失败`,
      );
    }
    if (action !== "none") {
      await systemctl(
        session,
        service,
        [action, "--", service.unit],
        signal,
        `systemd ${action} 失败`,
      );
    }
    const after = await readState(session, service, signal);
    if (service.enabled !== undefined && after.enabled !== service.enabled) {
      throw new TransportError(`systemd enable 状态未收敛: ${after.enabledState}`);
    }
    if (
      ((action === "start" || action === "reload" || action === "restart") && !after.active) ||
      (action === "stop" && after.active)
    ) {
      throw new TransportError(`systemd active 状态未收敛: ${after.activeState}`);
    }
    return Object.freeze({ before, after, daemonReloaded, enableAction, action });
  } catch (cause) {
    const actual = await readState(session, service, undefined).catch(() => undefined);
    const suffix = actual === undefined
      ? "；无法读取实际状态"
      : `；实际 enabled=${actual.enabledState} active=${actual.activeState}`;
    throw new TransportError(`systemd 服务 ${service.unit} 收敛失败${suffix}`, { cause });
  }
}

/** 配置或服务动作失败后的单次补偿；只恢复框架事前读取到的 enable/active 状态。 */
export async function restoreSystemd(
  session: RemoteSession,
  service: SystemdServiceManagement,
  before: SystemdState,
  daemonReload: boolean,
  signal?: AbortSignal,
): Promise<SystemdState> {
  validateService(service);
  await session.preflightPrivilege(signal);
  if (daemonReload) {
    await systemctl(session, service, ["daemon-reload"], signal, "恢复时 daemon-reload 失败");
  }
  let current = await readState(session, service, signal);
  if (current.active !== before.active) {
    const action = before.active ? "start" : "stop";
    await systemctl(
      session,
      service,
      [action, "--", service.unit],
      signal,
      `恢复 systemd ${action} 状态失败`,
    );
  }
  current = await readState(session, service, signal);
  if (current.enabled !== before.enabled) {
    const action = before.enabled ? "enable" : "disable";
    await systemctl(
      session,
      service,
      [action, "--", service.unit],
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
  service: SystemdServiceManagement,
  signal?: AbortSignal,
): Promise<SystemdState> {
  const enabled = await session.run([SYSTEMCTL, "is-enabled", "--", service.unit], {
    signal,
    timeoutMs: service.timeoutMs,
    privileged: true,
  });
  const active = await session.run([SYSTEMCTL, "is-active", "--", service.unit], {
    signal,
    timeoutMs: service.timeoutMs,
    privileged: true,
  });
  const enabledState = stateText(enabled, "unknown-enabled");
  const activeState = stateText(active, "unknown-active");
  const isMissingUnit = enabled.exitCode === 4 && enabledState === "not-found";
  const isMissingUnitActive = isMissingUnit && active.exitCode === 4 &&
    (activeState === "inactive" || activeState === "not-found");
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

async function systemctl(
  session: RemoteSession,
  service: SystemdServiceManagement,
  argv: readonly string[],
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  requireSuccess(
    await session.run([SYSTEMCTL, ...argv], {
      signal,
      timeoutMs: service.timeoutMs,
      privileged: true,
    }),
    label,
  );
}

function stateText(result: CommandResult, fallback: string): string {
  const value = result.stdout.trim();
  if (/^[a-z][a-z-]*$/u.test(value)) return value;
  return fallback;
}

function validateService(service: SystemdServiceManagement): void {
  if (
    service?.kind !== "systemd" || !UNIT_RE.test(service.unit) || service.unit.includes("..") ||
    !Number.isFinite(service.timeoutMs) || service.timeoutMs <= 0
  ) {
    throw new PreflightError("systemd 管理声明不合法");
  }
}

function requireSuccess(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) throw new TransportError(label);
}
