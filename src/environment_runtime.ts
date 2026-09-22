/** Environment 内置安装与服务管理的固定远端命令编排。 */

import { TransportError } from "./errors.ts";
import type { CommandResult } from "./results.ts";
import type { RemoteSession } from "./transport.ts";
import type {
  EnvironmentPackageInstall,
  EnvironmentPackageManagerKind,
  EnvironmentServiceTool,
  EnvironmentSystemManager,
} from "./types.ts";
import { setServiceEnabled } from "./service_enable.ts";

const PACKAGE_MANAGER_PROBE_SCRIPT =
  'for path in /usr/bin/apt-get /usr/bin/yum /bin/yum; do if test -x "$path"; then printf "%s" "$path"; exit 0; fi; done; exit 1';
const SERVICE_TOOL_PROBE_SCRIPT =
  'for path in /usr/bin/systemctl /bin/systemctl /usr/bin/service /usr/sbin/service /sbin/service; do if test -x "$path"; then printf "%s" "$path"; exit 0; fi; done; exit 1';

interface DetectedTool {
  readonly kind: EnvironmentPackageManagerKind | EnvironmentServiceTool | "chkconfig";
  readonly path: string;
}

function requireSuccess(
  result: CommandResult,
  label: string,
): CommandResult {
  if (result.exitCode !== 0) {
    throw new TransportError(
      `${label} failed (exit code ${result.exitCode}): ${
        [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" ")
      }`.trim(),
    );
  }
  return result;
}

async function probeTool(
  session: RemoteSession,
  script: string,
  signal: AbortSignal | undefined,
  label: string,
): Promise<DetectedTool> {
  const result = await session.run(["/bin/sh", "-c", script], { signal });
  requireSuccess(result, label);
  const path = result.stdout.trim();
  if (!path.startsWith("/") || /\s/.test(path)) {
    throw new TransportError(`${label} returned an invalid path`);
  }
  const kind = path.split("/").pop() ?? "";
  if (!["apt-get", "yum", "systemctl", "service", "chkconfig"].includes(kind)) {
    throw new TransportError(`${label} returned an unsupported tool: ${kind}`);
  }
  return Object.freeze({ kind: kind as DetectedTool["kind"], path });
}

async function detectPackageManager(
  session: RemoteSession,
  manager: EnvironmentPackageManagerKind,
  signal?: AbortSignal,
): Promise<DetectedTool> {
  const script = manager === "auto"
    ? PACKAGE_MANAGER_PROBE_SCRIPT
    : manager === "apt-get"
    ? 'if test -x /usr/bin/apt-get; then printf "%s" /usr/bin/apt-get; exit 0; fi; exit 1'
    : 'for path in /usr/bin/yum /bin/yum; do if test -x "$path"; then printf "%s" "$path"; exit 0; fi; done; exit 1';
  return await probeTool(session, script, signal, "package manager probe");
}

async function packagesInstalled(
  session: RemoteSession,
  manager: DetectedTool,
  packages: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (manager.kind === "apt-get") {
    const result = await session.run([
      "/usr/bin/dpkg-query",
      "-W",
      "-f=${db:Status-Abbrev}\\t${Package}\\n",
      "--",
      ...packages,
    ], { signal });
    if (result.exitCode !== 0) return false;
    const installed = new Set(
      result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        const [status, name] = line.split("\t");
        return status !== undefined && status.startsWith("ii") && name ? [name] : [];
      }),
    );
    return packages.every((item) => installed.has(item));
  }
  const result = await session.run(["/usr/bin/rpm", "-q", "--", ...packages], { signal });
  return result.exitCode === 0;
}

/** 查询缺失包并执行固定安装模板；调用方通过 requires_privilege 控制提权。 */
export async function installEnvironmentPackages(
  session: RemoteSession,
  install: EnvironmentPackageInstall,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const manager = await detectPackageManager(session, install.manager, signal);
  if (await packagesInstalled(session, manager, install.packages, signal)) {
    return Object.freeze({ exitCode: 0, stdout: "", stderr: "" });
  }
  if (install.updateCache) {
    if (manager.kind === "apt-get") {
      requireSuccess(
        await session.run([manager.path, "update"], { signal, privileged: true }),
        "refresh apt package index",
      );
    } else {
      requireSuccess(
        await session.run([manager.path, "makecache"], { signal, privileged: true }),
        "refresh yum package index",
      );
    }
  }
  const argv = manager.kind === "apt-get"
    ? [manager.path, "install", "-y", "--no-install-recommends", ...install.packages]
    : [manager.path, "install", "-y", ...install.packages];
  return requireSuccess(
    await session.run(argv, { signal, privileged: true }),
    "install environment packages",
  );
}

export async function detectServiceTool(
  session: RemoteSession,
  tool: EnvironmentServiceTool,
  signal?: AbortSignal,
): Promise<DetectedTool> {
  const script = tool === "auto"
    ? SERVICE_TOOL_PROBE_SCRIPT
    : tool === "systemctl"
    ? 'if test -x /usr/bin/systemctl; then printf "%s" /usr/bin/systemctl; exit 0; fi; if test -x /bin/systemctl; then printf "%s" /bin/systemctl; exit 0; fi; exit 1'
    : 'for path in /usr/bin/service /usr/sbin/service /sbin/service; do if test -x "$path"; then printf "%s" "$path"; exit 0; fi; done; exit 1';
  return await probeTool(session, script, signal, "service manager probe");
}

function systemctlUnit(name: string): string {
  return name.includes(".") ? name : `${name}.service`;
}

async function verifySystemdState(
  session: RemoteSession,
  path: string,
  manager: EnvironmentSystemManager,
  signal?: AbortSignal,
): Promise<void> {
  const unit = systemctlUnit(manager.name);
  const active = await session.run([path, "is-active", "--quiet", "--", unit], {
    signal,
    timeoutMs: manager.timeoutMs,
    privileged: true,
  });
  if (active.exitCode !== 0) {
    throw new TransportError(
      `systemd service is not active (exit code ${active.exitCode})`,
    );
  }
  if (manager.enabled !== undefined) {
    const enabled = await session.run([path, "is-enabled", "--quiet", "--", unit], {
      signal,
      timeoutMs: manager.timeoutMs,
      privileged: true,
    });
    const matched = manager.enabled ? enabled.exitCode === 0 : enabled.exitCode === 1;
    if (!matched) {
      throw new TransportError(
        `systemd service enable state did not converge (exit code ${enabled.exitCode})`,
      );
    }
  }
}

async function verifyServiceState(
  session: RemoteSession,
  manager: EnvironmentSystemManager,
  signal?: AbortSignal,
): Promise<void> {
  const status = await session.run(["service", manager.name, "status"], {
    signal,
    timeoutMs: manager.timeoutMs,
    privileged: true,
  });
  if (status.exitCode !== 0) {
    throw new TransportError(
      `service is not active (exit code ${status.exitCode})`,
    );
  }
  if (manager.enabled !== undefined) {
    await setServiceEnabled(
      session,
      {
        tool: "service",
        path: "service",
        unit: manager.name,
        timeoutMs: manager.timeoutMs,
      },
      manager.enabled,
      signal,
    );
  }
}

/** 通过 systemctl 或 SysV service 入口收敛 Environment 服务状态。 */
export async function convergeEnvironmentService(
  session: RemoteSession,
  manager: EnvironmentSystemManager,
  operation: "start" | "restart",
  signal?: AbortSignal,
): Promise<void> {
  const tool = await detectServiceTool(session, manager.tool, signal);
  if (tool.kind === "systemctl") {
    if (manager.enabled !== undefined) {
      await setServiceEnabled(
        session,
        {
          tool: "systemctl",
          path: tool.path,
          unit: systemctlUnit(manager.name),
          timeoutMs: manager.timeoutMs,
        },
        manager.enabled,
        signal,
      );
    }
    requireSuccess(
      await session.run([tool.path, operation, "--", systemctlUnit(manager.name)], {
        signal,
        timeoutMs: manager.timeoutMs,
        privileged: true,
      }),
      `run systemd ${operation}`,
    );
    await verifySystemdState(session, tool.path, manager, signal);
    return;
  }
  if (tool.kind !== "service") {
    throw new TransportError(`Service manager probe returned an unsupported tool: ${tool.kind}`);
  }
  requireSuccess(
    await session.run([tool.path, manager.name, operation], {
      signal,
      timeoutMs: manager.timeoutMs,
      privileged: true,
    }),
    `run service ${operation}`,
  );
  await verifyServiceState(session, manager, signal);
}

/** 仅收敛 Environment 系统服务的开机状态；不启动或重启服务。 */
export async function enableEnvironmentService(
  session: RemoteSession,
  manager: EnvironmentSystemManager,
  signal?: AbortSignal,
): Promise<void> {
  const tool = await detectServiceTool(session, manager.tool, signal);
  if (tool.kind !== "systemctl" && tool.kind !== "service") {
    throw new TransportError(`Service manager probe returned an unsupported tool: ${tool.kind}`);
  }
  await setServiceEnabled(
    session,
    {
      tool: tool.kind,
      path: tool.path,
      unit: systemctlUnit(manager.name),
      timeoutMs: manager.timeoutMs,
    },
    manager.enabled ?? true,
    signal,
  );
}
