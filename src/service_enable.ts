/** 共享的系统服务开机状态读写：systemd 与 SysV(chkconfig)。 */

import { TransportError } from "./errors.ts";
import type { CommandResult } from "./results.ts";
import type { RemoteSession } from "./transport.ts";

export const CHKCONFIG_PROBE_SCRIPT =
  'for path in /usr/sbin/chkconfig /sbin/chkconfig /usr/bin/chkconfig; do if test -x "$path"; then printf "%s" "$path"; exit 0; fi; done; exit 1';

const ENABLED_STATES = new Set([
  "enabled",
  "enabled-runtime",
  "linked",
  "linked-runtime",
  "alias",
]);
const CHKCONFIG_RUNLEVELS = ["2", "3", "4", "5"];

export interface ServiceEnableTarget {
  readonly tool: "systemctl" | "service";
  readonly path: string;
  readonly unit: string;
  readonly timeoutMs: number;
}

export interface ServiceEnableState {
  readonly enabled: boolean;
  readonly enabledState: string;
}

/** SysV/chkconfig 服务名：去掉 systemd 的 .service 后缀。 */
export function chkconfigName(unit: string): string {
  return unit.endsWith(".service") ? unit.slice(0, -".service".length) : unit;
}

/** 定位目标机上的 chkconfig；缺失时 fail closed。 */
export async function probeChkconfig(
  session: RemoteSession,
  signal?: AbortSignal,
): Promise<string> {
  const result = await session.run(["/bin/sh", "-c", CHKCONFIG_PROBE_SCRIPT], { signal });
  const path = result.stdout.trim();
  if (result.exitCode !== 0 || !path.startsWith("/") || /\s/.test(path)) {
    throw new TransportError("chkconfig is not available on the target node");
  }
  return path;
}

/** systemctl: is-enabled；SysV: chkconfig --list。无法判定时 fail closed。 */
export async function readServiceEnabled(
  session: RemoteSession,
  target: ServiceEnableTarget,
  signal?: AbortSignal,
): Promise<ServiceEnableState> {
  if (target.tool === "systemctl") {
    const result = await session.run([target.path, "is-enabled", "--", target.unit], {
      signal,
      timeoutMs: target.timeoutMs,
      privileged: true,
    });
    const enabledState = enabledStateText(result, "unknown-enabled");
    const missingUnit = result.exitCode === 4 && enabledState === "not-found";
    if (result.exitCode !== 0 && result.exitCode !== 1 && !missingUnit) {
      throw new TransportError(`Failed to read systemd enable state: ${enabledState}`);
    }
    return Object.freeze({
      enabled: result.exitCode === 0 && ENABLED_STATES.has(enabledState),
      enabledState,
    });
  }
  const path = await probeChkconfig(session, signal);
  const result = await session.run([path, "--list", chkconfigName(target.unit)], {
    signal,
    timeoutMs: target.timeoutMs,
    privileged: true,
  });
  if (result.exitCode !== 0) {
    throw new TransportError(
      `Failed to read service enable state: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const enabled = parseChkconfig(result.stdout);
  if (enabled === undefined) {
    throw new TransportError("Failed to parse service enable state");
  }
  return Object.freeze({ enabled, enabledState: enabled ? "enabled" : "disabled" });
}

/** systemctl: enable/disable；SysV: chkconfig on/off（幂等）。 */
export async function setServiceEnabled(
  session: RemoteSession,
  target: ServiceEnableTarget,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (target.tool === "systemctl") {
    requireSuccess(
      await session.run(
        [target.path, enabled ? "enable" : "disable", "--", target.unit],
        { signal, timeoutMs: target.timeoutMs, privileged: true },
      ),
      `set systemd service ${enabled ? "enabled" : "disabled"}`,
    );
    return;
  }
  const path = await probeChkconfig(session, signal);
  requireSuccess(
    await session.run([path, chkconfigName(target.unit), enabled ? "on" : "off"], {
      signal,
      timeoutMs: target.timeoutMs,
      privileged: true,
    }),
    `set service ${enabled ? "enabled" : "disabled"}`,
  );
}

function parseChkconfig(stdout: string): boolean | undefined {
  const text = stdout.trim();
  if (text.length === 0) return undefined;
  const runlevels = [...text.matchAll(/([0-6]):(on|off)/gu)];
  if (runlevels.length > 0) {
    const on = new Set(
      runlevels.filter((match) => match[2] === "on").map((match) => match[1]),
    );
    return CHKCONFIG_RUNLEVELS.every((level) => on.has(level));
  }
  const words = text.split(/\s+/u);
  const last = words[words.length - 1];
  if (last === "on") return true;
  if (last === "off") return false;
  return undefined;
}

function enabledStateText(result: CommandResult, fallback: string): string {
  const value = result.stdout.trim();
  return /^[a-z][a-z-]*$/u.test(value) ? value : fallback;
}

function requireSuccess(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) throw new TransportError(label);
}
