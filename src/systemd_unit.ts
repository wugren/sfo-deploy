/** 确定性 systemd unit 渲染；输入必须是 loader 已解析的安全绝对路径。 */

import { createHash } from "node:crypto";
import { basename } from "jsr:@std/path@1.1.6";
import { PreflightError } from "./errors.ts";
import type { GeneratedConfigSkeleton } from "./config_generation.ts";
import type { AppServiceManagement, ManagedConfigFile } from "./types.ts";

const TEXT_ENCODER = new TextEncoder();
const MAX_UNIT_BYTES = 64 * 1024;

/** 生成 unit 的运行用户：显式 unit_config.user，缺省取机器 SSH 用户；root SSH 必须显式声明。 */
export function resolveUnitUser(service: AppServiceManagement, sshUser: string): string {
  const declared = service.unitConfig?.user;
  if (declared !== undefined) return declared;
  if (sshUser === "root") {
    throw new PreflightError(
      "systemd unit must declare unit_config.user when the SSH user is root",
    );
  }
  return sshUser;
}

/** 把 service.unitConfig 归一为现有 managed config 发布事务可消费的候选描述。 */
export function serviceUnitManagedConfig(
  service: AppServiceManagement,
): ManagedConfigFile | undefined {
  const unitConfig = service.unitConfig;
  if (unitConfig === undefined) return undefined;
  if (basename(unitConfig.target) !== service.unit) {
    throw new PreflightError(`systemd unit target does not match unit: ${unitConfig.target}`);
  }
  return Object.freeze({
    name: serviceUnitConfigName(service.unit),
    relativePath: `systemd/${service.unit}`,
    source: unitConfig.target,
    target: unitConfig.target,
    targetRoot: "absolute",
    owner: "root",
    group: "root",
    mode: 0o644,
    variables: Object.freeze([]),
    format: "systemd",
    secretReferences: new Map(),
    onChange: "restart",
  });
}

export function generateSystemdUnitSkeleton(
  config: ManagedConfigFile,
  service: AppServiceManagement,
  user: string,
): GeneratedConfigSkeleton {
  const unitConfig = service.unitConfig;
  if (unitConfig === undefined) {
    throw new PreflightError(`systemd service ${service.unit} is missing unit_config`);
  }
  const content = TEXT_ENCODER.encode(renderUnit(service, user));
  if (content.byteLength > MAX_UNIT_BYTES) {
    throw new PreflightError(
      `systemd unit ${service.unit} exceeds the ${MAX_UNIT_BYTES} byte limit`,
    );
  }
  return Object.freeze({
    name: config.name,
    format: "systemd",
    content,
    size: content.byteLength,
    sha256: sha256Bytes(content),
    secretBindings: Object.freeze([]),
  });
}

function renderUnit(
  service: AppServiceManagement,
  user: string,
): string {
  const unitConfig = service.unitConfig!;
  const command = quoteExecStartArgument(unitConfig.command, "command");
  const args = unitConfig.args.map((argument, index) =>
    quoteExecStartArgument(argument, `args[${index}]`)
  );
  return [
    "[Unit]",
    `Description=sfo-deploy managed ${service.unit}`,
    "After=network.target",
    ...(unitConfig.startLimitIntervalSec === undefined
      ? []
      : [`StartLimitIntervalSec=${unitConfig.startLimitIntervalSec}s`]),
    ...(unitConfig.startLimitBurst === undefined
      ? []
      : [`StartLimitBurst=${unitConfig.startLimitBurst}`]),
    "",
    "[Service]",
    "Type=simple",
    ...(unitConfig.restartPolicy === undefined ? [] : [`Restart=${unitConfig.restartPolicy}`]),
    ...(unitConfig.restartSec === undefined ? [] : [`RestartSec=${unitConfig.restartSec}s`]),
    `User=${user}`,
    `WorkingDirectory=${quoteUnitPath(unitConfig.workingDirectory, "working_directory")}`,
    `ExecStart=${[command, ...args].join(" ")}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function serviceUnitConfigName(unit: string): string {
  const safe = unit.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");
  return `sfo-systemd-${safe}`;
}

function quoteUnitPath(value: string, label: string): string {
  assertUnitText(value, label);
  // systemd 的 WorkingDirectory 解析不剥离双引号，无法安全表示含空白的路径；失败关闭。
  if (/\s/u.test(value)) {
    throw new PreflightError(`systemd unit ${label} must not contain whitespace`);
  }
  return value;
}

function quoteExecStartArgument(value: string, label: string): string {
  if (value === "") return '""';
  assertUnitText(value, label);
  // 单引号会被 systemd 视为引用起始，分号在 systemd 254+ 会被视为命令分隔符；
  // 两者都需用双引号包裹以保留字面值。
  if (/[\s';]/u.test(value)) return `"${value}"`;
  return value;
}

function assertUnitText(value: string, label: string): void {
  if (value.length === 0) throw new PreflightError(`systemd unit ${label} must not be empty`);
  if (
    /[\0\r\n]/u.test(value) || [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new PreflightError(`systemd unit ${label} contains control characters`);
  }
  if (value.includes("$") || value.includes("%") || value.includes("\\") || value.includes('"')) {
    throw new PreflightError(
      `systemd unit ${label} contains unsupported systemd expansion or quote characters`,
    );
  }
}

function sha256Bytes(content: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}
