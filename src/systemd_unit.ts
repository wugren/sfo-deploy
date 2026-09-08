/** 确定性 systemd unit 渲染；输入必须是 loader 已解析的安全绝对路径。 */

import { createHash } from "node:crypto";
import { basename } from "jsr:@std/path@1.1.6";
import { PreflightError } from "./errors.ts";
import type { GeneratedConfigSkeleton } from "./config_generation.ts";
import type { ManagedConfigFile, SystemdServiceManagement } from "./types.ts";

const TEXT_ENCODER = new TextEncoder();
const MAX_UNIT_BYTES = 64 * 1024;

/** 把 service.unitConfig 归一为现有 managed config 发布事务可消费的候选描述。 */
export function serviceUnitManagedConfig(
  service: SystemdServiceManagement,
): ManagedConfigFile | undefined {
  const unitConfig = service.unitConfig;
  if (unitConfig === undefined) return undefined;
  if (basename(unitConfig.target) !== service.unit) {
    throw new PreflightError(`systemd unit target 与 unit 不匹配: ${unitConfig.target}`);
  }
  return Object.freeze({
    name: serviceUnitConfigName(service.unit),
    relativePath: `systemd/${service.unit}`,
    source: unitConfig.target,
    target: unitConfig.target,
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
  service: SystemdServiceManagement,
  runAs: string,
): GeneratedConfigSkeleton {
  const unitConfig = service.unitConfig;
  if (unitConfig === undefined) {
    throw new PreflightError(`systemd service ${service.unit} 缺少 unit_config`);
  }
  const content = TEXT_ENCODER.encode(renderUnit(service, runAs));
  if (content.byteLength > MAX_UNIT_BYTES) {
    throw new PreflightError(`systemd unit ${service.unit} 超过 ${MAX_UNIT_BYTES} 字节限制`);
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
  service: SystemdServiceManagement,
  runAs: string,
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
    "",
    "[Service]",
    "Type=simple",
    `User=${runAs}`,
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
  return /\s/.test(value) ? `"${value}"` : value;
}

function quoteExecStartArgument(value: string, label: string): string {
  if (value === "") return '""';
  assertUnitText(value, label);
  if (/\s/.test(value)) return `"${value}"`;
  return value;
}

function assertUnitText(value: string, label: string): void {
  if (value.length === 0) throw new PreflightError(`systemd unit ${label} 不能为空`);
  if (
    /[\0\r\n]/u.test(value) || [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new PreflightError(`systemd unit ${label} 包含控制字符`);
  }
  if (value.includes("$") || value.includes("%") || value.includes("\\") || value.includes('"')) {
    throw new PreflightError(`systemd unit ${label} 包含不支持的 systemd 展开或引号字符`);
  }
}

function sha256Bytes(content: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}
