/** Generic and project-bound command-line entrypoints. */

import { resolve } from "jsr:@std/path@1.1.6";
import { NAME_RE } from "./config.ts";
import {
  CancelledError,
  ConfigurationError,
  DeploymentError,
  DownloadError,
  PlanningError,
  PreflightError,
  TransportError,
} from "./errors.ts";
import {
  CLI_ACTIONS,
  type CliAction,
  type ProgressEvent,
  runAction,
  type RunDependencies,
  RunOptions,
  type RunResult,
  ValidationResult,
} from "./integration.ts";
import { ReleaseHistoryResult, type ReleaseRecord } from "./history.ts";
import {
  DeploymentResult,
  type FetchPackageResult,
  FetchResult,
  InstallDenoResult,
  type MachineDenoOutcome,
  SecretsDeployResult,
  StepStatus,
} from "./results.ts";
import { ProjectBindings, Redactor } from "./secrets.ts";
import type { ExecutionPlan } from "./types.ts";
import { loadUserConfig } from "./user_config.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Writer {
  write(data: Uint8Array): number | Promise<number>;
}

export interface Reader {
  read(data: Uint8Array): number | null | Promise<number | null>;
  isTerminal?(): boolean;
}

export interface CliDependencies extends RunDependencies {
  readonly runAction?: typeof runAction;
  readonly stdout?: Writer;
  readonly stderr?: Writer;
  readonly stdin?: Reader;
  readonly cwd?: () => string;
  /** A fixed project root removes the generic `--config-root` option. */
  readonly configRoot?: string | URL;
  /** 测试与自定义运行时注入用户主目录；默认使用 Deno.homeDir()。 */
  readonly homeDir?: string | (() => string);
}

interface ParsedArguments {
  readonly help: boolean;
  readonly action?: CliAction;
  readonly cluster?: string;
  readonly configRoot?: string;
  readonly machines: readonly string[];
  readonly apps: readonly string[];
  readonly environments: readonly string[];
  readonly executorRegion?: string;
  readonly addressKind?: "private" | "public";
  readonly withDependencies: boolean;
  readonly releaseId?: string;
  readonly yes: boolean;
  readonly denoVersion?: string;
  readonly installTo?: string;
  readonly json: boolean;
  readonly remove: readonly string[];
  readonly check: boolean;
}

class ArgumentError extends Error {}

/** Create an isolated CLI invocation with injectable I/O and runtime adapters. */
export function createCli(
  dependencies: Partial<CliDependencies> = {},
): (args: readonly string[]) => Promise<number> {
  const stdout = dependencies.stdout ?? Deno.stdout;
  const stderr = dependencies.stderr ?? Deno.stderr;
  const stdin = dependencies.stdin ?? Deno.stdin;
  const invoke = dependencies.runAction ?? runAction;
  const cwd = dependencies.cwd ?? Deno.cwd;
  const fixedRoot = dependencies.configRoot === undefined
    ? undefined
    : pathFromStringOrUrl(dependencies.configRoot);

  return async (args: readonly string[] = Deno.args): Promise<number> => {
    let parsed: ParsedArguments;
    try {
      parsed = parseArguments(args, fixedRoot !== undefined);
    } catch (cause) {
      await writeText(
        stderr,
        `${cause instanceof Error ? cause.message : String(cause)}\n\n${
          usage(fixedRoot === undefined)
        }`,
      );
      return 2;
    }
    if (parsed.help) {
      await writeText(
        stdout,
        parsed.action === undefined
          ? usage(fixedRoot === undefined)
          : actionUsage(parsed.action, fixedRoot === undefined),
      );
      return 0;
    }

    const bindings = dependencies.bindings ?? new ProjectBindings();
    try {
      const homeDir = typeof dependencies.homeDir === "function"
        ? dependencies.homeDir()
        : dependencies.homeDir;
      const userConfig = await loadUserConfig({ homeDir });
      const configRoot = fixedRoot ?? await resolveGenericConfigRoot(
        parsed.cluster!,
        parsed.configRoot,
        cwd(),
      );
      const options = new RunOptions({
        configRoot,
        cluster: parsed.cluster!,
        action: parsed.action!,
        machines: parsed.machines,
        apps: parsed.apps,
        environments: parsed.environments,
        executorRegion: parsed.executorRegion,
        addressKind: parsed.addressKind,
        withDependencies: parsed.withDependencies,
        releaseId: parsed.releaseId,
        denoVersion: parsed.denoVersion,
        installTo: parsed.installTo,
        removeNames: parsed.remove,
        check: parsed.check,
      });
      const defaultConfirmMachines = (machines: readonly string[]) =>
        confirmMachineTargets(machines, stdin, stderr);
      const confirmPlan = parsed.yes ? undefined : dependencies.confirmPlan ??
        ((plan: ExecutionPlan) => confirmExecutionPlan(plan, stdin, stderr));
      const confirmMachines = parsed.yes
        ? undefined
        : dependencies.confirmMachines ?? defaultConfirmMachines;
      const invokeDependencies: RunDependencies = {
        bindings,
        downloadProviders: dependencies.downloadProviders,
        transport: dependencies.transport,
        knownHosts: dependencies.knownHosts,
        packagesDir: userConfig.packagesDir,
        keepVersions: userConfig.keepVersions,
        confirmPlan,
        confirmMachines,
        signal: dependencies.signal,
        ...(!parsed.json
          ? {
            onProgress: dependencies.onProgress ??
              ((event: ProgressEvent) => writeProgressLine(stdout, event)),
          }
          : {}),
      };
      const result = await invoke(options, invokeDependencies);
      if (parsed.json) {
        await writeJson(stdout, serializeResult(result));
      } else {
        await writeHumanResult(stdout, result);
      }
      return result instanceof DeploymentResult || result instanceof ReleaseHistoryResult ||
          result instanceof FetchResult || result instanceof InstallDenoResult ||
          result instanceof SecretsDeployResult
        ? result.exitCode
        : 0;
    } catch (cause) {
      const normalized = normalizeError(cause);
      const redactor = staticRedactor(bindings);
      if (parsed.json) {
        await writeJson(stderr, {
          error: {
            category: normalized.category,
            message: redactor.redact(normalized.message),
          },
        });
      } else {
        await writeText(
          stderr,
          `错误（${normalized.category}）: ${redactor.redact(normalized.message)}\n`,
        );
      }
      return normalized.exitCode;
    }
  };
}

export async function main(args: readonly string[] = Deno.args): Promise<number> {
  return await createCli()(args);
}

export async function resolveGenericConfigRoot(
  cluster: string,
  explicitRoot: string | undefined,
  currentDirectory: string = Deno.cwd(),
): Promise<string> {
  if (typeof cluster !== "string" || !NAME_RE.test(cluster)) {
    throw new ConfigurationError(`集群选择名称不合法: ${JSON.stringify(cluster)}`);
  }
  if (explicitRoot !== undefined) return resolve(currentDirectory, explicitRoot);
  const candidates = [
    resolve(currentDirectory, cluster),
    resolve(currentDirectory, "clusters", cluster),
  ];
  for (const candidate of candidates) {
    try {
      if ((await Deno.stat(candidate)).isDirectory) return resolve(candidate, "..");
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) {
        throw new ConfigurationError(`无法检查集群目录: ${candidate}`, { cause });
      }
    }
  }
  throw new ConfigurationError(`当前目录下未找到集群 ${cluster}，已搜索: ${candidates.join("、")}`);
}

function parseArguments(args: readonly string[], fixedRoot: boolean): ParsedArguments {
  const machines: string[] = [];
  const apps: string[] = [];
  const environments: string[] = [];
  let action: CliAction | undefined;
  let cluster: string | undefined;
  let configRoot: string | undefined;
  let executorRegion: string | undefined;
  let addressKind: "private" | "public" | undefined;
  let withDependencies = false;
  let releaseId: string | undefined;
  let yes = false;
  let help = false;
  let denoVersion: string | undefined;
  let installTo: string | undefined;
  const remove: string[] = [];
  let check = false;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      if (action !== undefined) throw new ArgumentError(`无法识别的额外参数: ${argument}`);
      if (!(CLI_ACTIONS as readonly string[]).includes(argument)) {
        throw new ArgumentError(`不支持的 CLI 动作: ${argument}`);
      }
      action = argument as CliAction;
      continue;
    }
    const [name, inline] = splitOption(argument);
    switch (name) {
      case "--cluster":
        cluster = optionValue(args, ++index, name, inline);
        if (inline !== undefined) index--;
        break;
      case "--config-root":
        if (fixedRoot) throw new ArgumentError("项目绑定 CLI 不支持 --config-root");
        configRoot = optionValue(args, ++index, name, inline);
        if (inline !== undefined) index--;
        break;
      case "--machine":
        machines.push(optionValue(args, ++index, name, inline));
        if (inline !== undefined) index--;
        break;
      case "--app":
        apps.push(optionValue(args, ++index, name, inline));
        if (inline !== undefined) index--;
        break;
      case "--environment":
        environments.push(optionValue(args, ++index, name, inline));
        if (inline !== undefined) index--;
        break;
      case "--env":
        environments.push(optionValue(args, ++index, name, inline));
        if (inline !== undefined) index--;
        break;
      case "--executor-region":
        executorRegion = optionValue(args, ++index, name, inline);
        if (inline !== undefined) index--;
        break;
      case "--address-kind": {
        const value = optionValue(args, ++index, name, inline);
        if (inline !== undefined) index--;
        if (value !== "private" && value !== "public") {
          throw new ArgumentError("--address-kind 只支持 private 或 public");
        }
        addressKind = value;
        break;
      }
      case "--release-id":
        releaseId = optionValue(args, ++index, name, inline);
        if (inline !== undefined) index--;
        break;
      case "--with-dependencies":
        rejectInline(name, inline);
        withDependencies = true;
        break;
      case "--yes":
        rejectInline(name, inline);
        yes = true;
        break;
      case "--deno-version":
        denoVersion = optionValue(args, ++index, name, inline);
        if (inline !== undefined) index--;
        break;
      case "--install-to":
        installTo = optionValue(args, ++index, name, inline);
        if (inline !== undefined) index--;
        break;
      case "--remove":
        remove.push(optionValue(args, ++index, name, inline));
        if (inline !== undefined) index--;
        break;
      case "--check":
        rejectInline(name, inline);
        check = true;
        break;
      case "--json":
        rejectInline(name, inline);
        json = true;
        break;
      default:
        throw new ArgumentError(`无法识别的选项: ${name}`);
    }
  }
  if (!help && action === undefined) throw new ArgumentError("缺少动作参数");
  if (!help && cluster === undefined) throw new ArgumentError("缺少必需选项: --cluster");
  return Object.freeze({
    help,
    action,
    cluster,
    configRoot,
    machines: Object.freeze(machines),
    apps: Object.freeze(apps),
    environments: Object.freeze(environments),
    executorRegion,
    addressKind,
    withDependencies,
    releaseId,
    yes,
    denoVersion,
    installTo,
    remove: Object.freeze(remove),
    check,
    json,
  });
}

function splitOption(argument: string): readonly [string, string | undefined] {
  const equal = argument.indexOf("=");
  return equal < 0 ? [argument, undefined] : [argument.slice(0, equal), argument.slice(equal + 1)];
}

function optionValue(
  args: readonly string[],
  index: number,
  name: string,
  inline?: string,
): string {
  const value = inline ?? args[index];
  if (
    value === undefined || value.length === 0 || (inline === undefined && value.startsWith("--"))
  ) {
    throw new ArgumentError(`${name} 需要一个值`);
  }
  return value;
}

function rejectInline(name: string, inline?: string): void {
  if (inline !== undefined) throw new ArgumentError(`${name} 不接受值`);
}

async function confirmExecutionPlan(
  plan: ExecutionPlan,
  stdin: Reader,
  stderr: Writer,
): Promise<boolean> {
  if (plan.requestedAction === "deploy") {
    const steps = plan.steps.map((step) =>
      `${step.kind}:${step.machine.machine.name}/${step.resource}:${step.action}`
    );
    await writeText(
      stderr,
      `部署将处理 ${steps.length} 个步骤（内置 versioned App 先完成全部 stage，再执行 activate）：${
        steps.join("、")
      }\n`,
    );
  } else if (plan.requestedAction === "prepare") {
    const targets = [
      ...new Set(
        plan.steps
          .filter((step) => step.kind === "environment")
          .map((step) => `${step.machine.machine.name}/${step.resource}`),
      ),
    ].sort();
    await writeText(
      stderr,
      `缺省全量环境准备将处理 ${targets.length} 个环境应用：${targets.join("、")}\n`,
    );
  } else {
    const targets = [
      ...new Set(
        plan.steps
          .filter((step) => step.kind === "environment")
          .map((step) => `${step.machine.machine.name}/${step.resource}`),
      ),
    ].sort();
    await writeText(
      stderr,
      `缺省全量安装将处理 ${targets.length} 个环境：${targets.join("、")}\n`,
    );
  }
  if (stdin.isTerminal && !stdin.isTerminal()) return false;
  await writeText(
    stderr,
    plan.requestedAction === "deploy"
      ? "确认执行部署？输入 yes 继续，其它内容取消: "
      : plan.requestedAction === "prepare"
      ? "确认执行缺省全量环境准备？输入 yes 继续，其它内容取消: "
      : "确认执行缺省全量安装？输入 yes 继续，其它内容取消: ",
  );
  const buffer = new Uint8Array(1024);
  const count = await stdin.read(buffer);
  if (count === null) return false;
  const answer = decoder.decode(buffer.subarray(0, count)).split(/\r?\n/, 1)[0].trim()
    .toLowerCase();
  return answer === "yes" || answer === "y";
}

async function confirmMachineTargets(
  machines: readonly string[],
  stdin: Reader,
  stderr: Writer,
): Promise<boolean> {
  await writeText(
    stderr,
    `缺省全量操作将处理 ${machines.length} 台机器：${machines.join("、")}\n`,
  );
  if (stdin.isTerminal && !stdin.isTerminal()) return false;
  await writeText(
    stderr,
    "确认对全部机器执行？输入 yes 继续，其它内容取消: ",
  );
  const buffer = new Uint8Array(1024);
  const count = await stdin.read(buffer);
  if (count === null) return false;
  const answer = decoder.decode(buffer.subarray(0, count)).split(/\r?\n/, 1)[0].trim()
    .toLowerCase();
  return answer === "yes" || answer === "y";
}

function skipReasonText(reason: string, message?: string): string {
  switch (reason) {
    case "up-to-date":
      return "已是最新";
    case "check-satisfied":
      return "检查已满足";
    case "using-start":
      return "复用 start 步骤";
    case "using-restart":
      return "复用 restart 步骤";
    case "target-fail-fast":
      return "目标机器已失败";
    case "dependency-failed":
      return message ?? "依赖未成功";
    default:
      return message ?? reason;
  }
}

function humanStepLine(event: Extract<ProgressEvent, { readonly kind: "step-result" }>): string {
  const step = event.step;
  const action = ACTION_LABELS[step.action] ?? step.action;
  const base = `[${step.machine}] ${step.resource} ${action}（${
    event.index + 1
  }/${event.total}）... ${STATUS_LABELS[step.status]}`;
  if (step.status === StepStatus.SKIPPED) {
    return `${base}（${skipReasonText(step.skipReason ?? "", step.message)}）`;
  }
  if (step.status === StepStatus.FAILED || step.status === StepStatus.BLOCKED) {
    const recovery = step.recovery === undefined
      ? ""
      : step.recovery.succeeded
      ? "；恢复成功"
      : "；恢复不完整";
    const detail = `${step.message ?? step.skipReason ?? ""}${recovery}`;
    return detail === "" ? base : `${base}：${detail}`;
  }
  const managed = [
    step.changed === undefined ? undefined : step.changed ? "配置已变更" : "配置未变",
    step.service === undefined ? undefined : `服务动作 ${step.service.action}`,
    step.bundle === undefined ? undefined : step.bundle.reused ? "部署包已复用" : "部署包已上传",
    step.recovery === undefined ? undefined : step.recovery.succeeded ? "恢复成功" : "恢复不完整",
  ].filter((item): item is string => item !== undefined);
  const detail = [step.message, ...managed].filter((item): item is string => item !== undefined);
  if (detail.length > 0) return `${base}（${detail.join("；")}）`;
  return base;
}

function humanMachineLine(machine: MachineDenoOutcome): string {
  const base = `[${machine.machine}] install-deno ... ${
    machine.status === "present" ? "已满足" : machine.status === "installed" ? "已安装" : "失败"
  }`;
  if (machine.status === "failed") {
    const detail = machine.message ?? "";
    return detail === "" ? base : `${base}（${machine.errorCategory ?? "execution"}）：${detail}`;
  }
  const version = machine.version === undefined ? "" : ` ${machine.version}`;
  return `${base}（${machine.denoPath}${version}）`;
}

function humanPackageLine(pkg: FetchPackageResult): string {
  return `[${pkg.app}] fetch ${pkg.version} ... ${
    pkg.status === "downloaded" ? "已下载" : "命中缓存"
  }（${pkg.path}）`;
}

async function writeProgressLine(writer: Writer, event: ProgressEvent): Promise<void> {
  if (event.kind === "step-result") {
    await writeText(writer, `${humanStepLine(event)}\n`);
  } else if (event.kind === "machine-result") {
    await writeText(writer, `${humanMachineLine(event.machine)}\n`);
  } else {
    await writeText(writer, `${humanPackageLine(event.package)}\n`);
  }
}

async function writeHumanResult(writer: Writer, result: RunResult): Promise<void> {
  if (result instanceof ValidationResult) {
    await writeText(
      writer,
      `配置校验通过：集群 ${result.cluster}（目录 ${result.directory}，机器 ${result.machines.length} 台、环境实例 ${result.environments.length} 个、App ${result.apps.length} 个）\n`,
    );
    return;
  }
  if (result instanceof FetchResult) {
    const downloaded = result.packages.filter((pkg) => pkg.status === "downloaded").length;
    const cached = result.packages.length - downloaded;
    let summary = `抓取完成：集群 ${result.cluster}，${downloaded} 个已下载、${cached} 个命中缓存`;
    if (result.appsWithoutPackage.length > 0) {
      summary += `；${result.appsWithoutPackage.length} 个 App 无安装包：${
        result.appsWithoutPackage.join("、")
      }`;
    }
    await writeText(writer, `${summary}\n`);
    return;
  }
  if (result instanceof ReleaseHistoryResult) {
    await writeText(writer, `发布历史：集群 ${result.cluster}\n`);
    for (const record of result.releases) {
      const status = RELEASE_STATUS_LABELS[record.status] ?? record.status;
      const finished = record.finishedAt === undefined ? "" : `，完成 ${record.finishedAt}`;
      await writeText(
        writer,
        `- ${record.releaseId}（${record.operation}，${status}${finished}）\n`,
      );
    }
    return;
  }
  if (result instanceof InstallDenoResult) {
    const present = result.machines.filter((item) => item.status === "present").length;
    const installed = result.machines.filter((item) => item.status === "installed").length;
    const failed = result.machines.length - present - installed;
    await writeText(
      writer,
      `install-deno 完成：集群 ${result.cluster}，${
        result.succeeded ? "成功" : "失败"
      }（${result.machines.length} 台机器：已满足 ${present}、已安装 ${installed}、失败 ${failed}）\n`,
    );
    return;
  }
  if (result instanceof SecretsDeployResult) {
    const operationLabel = result.operation === "check"
      ? "校验"
      : result.operation === "remove"
      ? "移除"
      : "部署";
    await writeText(
      writer,
      `secrets ${operationLabel} 完成：集群 ${result.cluster}，${
        result.succeeded ? "成功" : "失败"
      }（${result.machines.length} 台机器）\n`,
    );
    for (const machine of result.machines) {
      const detail = machine.issues !== undefined && machine.issues.length > 0
        ? "；问题: " + machine.issues.map((issue) => `${issue.name}=${issue.kind}`).join("、")
        : machine.entries !== undefined
        ? "；写入 " +
          machine.entries.filter((entry) => entry.status === "written").length +
          "、未变 " +
          machine.entries.filter((entry) => entry.status === "unchanged").length
        : "";
      const outcome = machine.status === "succeeded" ? "通过" : "失败";
      const message = machine.message === undefined ? "" : `：${machine.message}`;
      await writeText(
        writer,
        `- [${machine.machine}] ${operationLabel} ${outcome}${detail}${message}\n`,
      );
    }
    return;
  }
  if (result instanceof DeploymentResult) {
    await writeText(
      writer,
      `集群：${result.cluster}\n动作：${result.requestedAction}\n状态：${
        result.succeeded ? "成功" : "失败"
      }\n`,
    );
    if (result.releaseId !== undefined) await writeText(writer, `发布 ID：${result.releaseId}\n`);
    if (result.sourceReleaseId !== undefined) {
      await writeText(writer, `来源发布 ID：${result.sourceReleaseId}\n`);
    }
    for (const target of result.targets) {
      const counts = new Map<StepStatus, number>();
      for (const step of target.steps) {
        counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
      }
      const breakdown = [...counts.entries()]
        .map(([status, count]) => `${STATUS_LABELS[status]} ${count}`)
        .join("、");
      await writeText(
        writer,
        `目标：${target.machine}（${
          STATUS_LABELS[target.status]
        }）${target.steps.length} 步，${breakdown}\n`,
      );
    }
    return;
  }
  await writeText(
    writer,
    `计划：集群 ${result.cluster} · 动作 ${result.requestedAction} · ${result.steps.length} 步\n`,
  );
  for (const step of result.steps) {
    await writeText(
      writer,
      `- [${step.machine.machine.name}] ${step.kind}:${step.resource} ${step.action}\n`,
    );
  }
}

export function serializeResult(result: RunResult): Record<string, unknown> {
  if (result instanceof ValidationResult) {
    return {
      kind: "validation",
      status: "succeeded",
      cluster: result.cluster,
      directory: result.directory,
      machines: [...result.machines],
      environments: [...result.environments],
      apps: [...result.apps],
    };
  }
  if (result instanceof FetchResult) {
    return {
      kind: "fetch",
      cluster: result.cluster,
      apps: [...result.apps],
      packages: result.packages.map((pkg) => ({
        app: pkg.app,
        version: pkg.version,
        provider: pkg.provider,
        status: pkg.status,
        path: pkg.path,
        hash_algorithm: pkg.hashAlgorithm,
        hash_value: pkg.hashValue,
        size: pkg.size,
      })),
      apps_without_package: [...result.appsWithoutPackage],
    };
  }
  if (result instanceof ReleaseHistoryResult) {
    return {
      kind: "release-history",
      cluster: result.cluster,
      releases: result.releases.map(serializeReleaseRecord),
    };
  }
  if (result instanceof InstallDenoResult) {
    return {
      kind: "install-deno",
      cluster: result.cluster,
      status: result.succeeded ? "succeeded" : "failed",
      exit_code: result.exitCode,
      machines: result.machines.map((machine: MachineDenoOutcome) => ({
        machine: machine.machine,
        status: machine.status,
        deno_path: machine.denoPath,
        version: machine.version ?? null,
        error_category: machine.errorCategory ?? null,
        message: machine.message ?? null,
        cleanup_errors: [...machine.cleanupErrors],
      })),
    };
  }
  if (result instanceof SecretsDeployResult) {
    return {
      kind: "secrets",
      operation: result.operation,
      cluster: result.cluster,
      status: result.succeeded ? "succeeded" : "failed",
      exit_code: result.exitCode,
      machines: result.machines.map((machine) => ({
        machine: machine.machine,
        status: machine.status,
        operation: machine.operation,
        entries: machine.entries === undefined ? null : machine.entries.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          status: entry.status,
        })),
        issues: machine.issues === undefined ? null : machine.issues.map((issue) => ({
          name: issue.name,
          kind: issue.kind,
          detail: issue.detail ?? null,
        })),
        error_category: machine.errorCategory ?? null,
        message: machine.message ?? null,
        cleanup_errors: [...machine.cleanupErrors],
      })),
    };
  }
  if (result instanceof DeploymentResult) {
    return {
      kind: "result",
      cluster: result.cluster,
      requested_action: result.requestedAction,
      release_id: result.releaseId ?? null,
      source_release_id: result.sourceReleaseId ?? null,
      status: result.succeeded ? "succeeded" : "failed",
      exit_code: result.exitCode,
      targets: result.targets.map((target) => ({
        machine: target.machine,
        status: target.status,
        cleanup_errors: [...target.cleanupErrors],
        steps: target.steps.map((step) => ({
          id: step.stepId,
          resource_kind: step.kind,
          resource: step.resource,
          action: step.action,
          status: step.status,
          exit_code: step.exitCode ?? null,
          message: step.message ?? null,
          error_category: step.errorCategory ?? null,
          skip_reason: step.skipReason ?? null,
          cleanup_errors: [...step.cleanupErrors],
          ...serializeStepManagement(step),
        })),
      })),
    };
  }
  return {
    kind: "plan",
    cluster: result.cluster,
    requested_action: result.requestedAction,
    steps: result.steps.map((step) => ({
      id: step.id,
      machine: step.machine.machine.name,
      address: step.machine.address,
      addresses: [...step.machine.addresses],
      address_kind: step.machine.addressKind,
      resource_kind: step.kind,
      resource: step.resource,
      action: step.action,
      script_runtime: {
        kind: step.machine.machine.scriptRuntime.kind,
        executable: step.machine.machine.scriptRuntime.executable,
      },
      scripts: step.scripts.map((invocation) => ({
        source: invocation.source,
        permissions: {
          run: [...invocation.permissions.run],
          net: [...invocation.permissions.net],
        },
      })),
      package_provider: step.package?.provider ?? null,
      deployment: step.deployment ?? null,
      secret_values: [...step.secretValues],
      secret_files: [...step.secretFiles],
      depends_on: [...step.dependsOn],
      ...(step.management === undefined
        ? {}
        : { management: serializeManagement(step.management) }),
      ...(step.deliveryInputs === undefined ? {} : {
        delivery_inputs: {
          scripts: step.deliveryInputs.scripts.map((script) => script.relativePath),
          files: step.deliveryInputs.files.map((file) => file.relativePath),
        },
      }),
    })),
  };
}

function serializeStepManagement(step: {
  readonly changed?: boolean;
  readonly service?: import("./results.ts").StepServiceResult;
  readonly recovery?: import("./results.ts").StepRecoveryResult;
  readonly bundle?: import("./results.ts").StepBundleResult;
}): Record<string, unknown> {
  return {
    ...(step.changed === undefined ? {} : { changed: step.changed }),
    ...(step.service === undefined ? {} : {
      service: {
        unit: step.service.unit,
        action: step.service.action,
        daemon_reloaded: step.service.daemonReloaded,
        enable_action: step.service.enableAction,
        before: { ...step.service.before },
        after: { ...step.service.after },
      },
    }),
    ...(step.recovery === undefined ? {} : {
      recovery: {
        attempted: step.recovery.attempted,
        succeeded: step.recovery.succeeded,
        config_attempted: step.recovery.configAttempted,
        service_attempted: step.recovery.serviceAttempted,
      },
    }),
    ...(step.bundle === undefined ? {} : {
      bundle: {
        sha256: step.bundle.sha256,
        size: step.bundle.size,
        reused: step.bundle.reused,
      },
    }),
  };
}

function serializeManagement(
  management: NonNullable<import("./types.ts").AppDefinition["management"]>,
): Record<string, unknown> {
  return {
    configs: management.configs.map((config) => ({
      name: config.name,
      target: config.target,
      format: config.format,
      on_change: config.onChange,
      secret_references: [...config.secretReferences.entries()].map(([secret, reference]) => ({
        secret,
        kind: reference.kind,
        type: reference.valueType,
      })),
    })),
    service: management.service === undefined ? null : {
      kind: management.service.kind,
      unit: management.service.unit,
      enabled: management.service.enabled ?? null,
      daemon_reload: management.service.daemonReload,
      on_deploy: management.service.onDeploy,
      ...(management.service.unitConfig === undefined ? {} : {
        unit_config: {
          target: management.service.unitConfig.target,
          working_directory: management.service.unitConfig.workingDirectory,
          command: management.service.unitConfig.command,
          args: [...management.service.unitConfig.args],
        },
      }),
    },
    hooks: [...management.hooks.keys()].sort(),
  };
}

function serializeReleaseRecord(record: ReleaseRecord): Record<string, unknown> {
  return {
    release_id: record.releaseId,
    operation: record.operation,
    source_release_id: record.sourceReleaseId ?? null,
    status: record.status,
    started_at: record.startedAt,
    finished_at: record.finishedAt ?? null,
    selection: {
      machines: [...record.selection.machines],
      apps: [...record.selection.apps],
      environments: [...record.selection.environments],
      executor_region: record.selection.executorRegion ?? null,
      address_kind: record.selection.addressKind ?? null,
      with_dependencies: record.selection.withDependencies,
    },
    apps: [...record.apps],
    machines: [...record.machines],
    app_versions: { ...record.appVersions },
    rollback_eligible: record.rollbackEligible,
    execution_result: record.executionResult === undefined ? null : {
      exit_code: record.executionResult.exitCode,
      targets: record.executionResult.targets.map((target) => ({
        machine: target.machine,
        status: target.status,
        cleanup_errors: [...target.cleanupErrors],
        steps: target.steps.map((step) => ({
          id: step.stepId,
          machine: step.machine,
          resource_kind: step.kind,
          resource: step.resource,
          action: step.action,
          status: step.status,
          exit_code: step.exitCode ?? null,
          message: step.message ?? null,
          error_category: step.errorCategory ?? null,
          skip_reason: step.skipReason ?? null,
          cleanup_errors: [...step.cleanupErrors],
          ...serializeStepManagement(step),
        })),
      })),
    },
    error: record.error === undefined
      ? null
      : { category: record.error.category, message: record.error.message },
  };
}

function normalizeError(cause: unknown): { category: string; message: string; exitCode: number } {
  if (
    cause instanceof CancelledError ||
    (cause instanceof DOMException && cause.name === "AbortError")
  ) {
    return { category: "cancelled", message: cause.message || "用户取消", exitCode: 130 };
  }
  if (cause instanceof ConfigurationError || cause instanceof PlanningError) {
    return { category: "configuration", message: cause.message, exitCode: 2 };
  }
  if (cause instanceof PreflightError) {
    return { category: "preflight", message: cause.message, exitCode: 3 };
  }
  if (cause instanceof DownloadError) {
    return { category: "download", message: cause.message, exitCode: 4 };
  }
  if (cause instanceof TransportError) {
    return { category: "transport", message: cause.message, exitCode: 4 };
  }
  if (cause instanceof DeploymentError) {
    return { category: "execution", message: cause.message, exitCode: 4 };
  }
  return {
    category: "execution",
    message: cause instanceof Error ? cause.message : String(cause),
    exitCode: 4,
  };
}

function staticRedactor(bindings: ProjectBindings): Redactor {
  return new Redactor(
    [...bindings.configSecrets.values()].filter((value): value is string =>
      typeof value === "string"
    ),
  );
}

async function writeJson(writer: Writer, value: Record<string, unknown>): Promise<void> {
  await writeText(writer, `${JSON.stringify(value, objectKeyOrder)}\n`);
}

function objectKeyOrder(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

async function writeText(writer: Writer, text: string): Promise<void> {
  const bytes = encoder.encode(text);
  let offset = 0;
  while (offset < bytes.length) {
    const count = await writer.write(bytes.subarray(offset));
    if (!Number.isInteger(count) || count <= 0) throw new Error("输出流没有接受数据");
    offset += count;
  }
}

function pathFromStringOrUrl(value: string | URL): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") throw new ConfigurationError("配置根目录必须是本地文件路径");
    return resolve(decodeURIComponent(value.pathname));
  }
  return resolve(value);
}

/** 每个 CLI 动作在帮助文本中的一行中文描述。 */
const ACTION_DESCRIPTIONS: Readonly<Record<CliAction, string>> = {
  validate: "装载并校验集群配置",
  plan: "预览 deploy 计划，不执行远端步骤",
  check: "检查所选环境是否满足要求",
  install: "安装或初始化所选环境",
  configure: "配置环境或 App（投递密钥与模板）",
  prepare: "部署/更新所选环境应用（检查、按需安装、配置、启动或重启）",
  deploy: "部署所选 App 并归档发布快照",
  fetch: "下载 App 安装包到本地部署包缓存",
  start: "启动目标环境或 App",
  stop: "停止目标环境或 App",
  restart: "重启目标环境或 App",
  history: "浏览发布历史或查看指定发布",
  rollback: "回退到 --release-id 指定的发布",
  "install-deno": "通过纯 SSH 安装固定版本 Deno 到目标机器",
  "secrets-deploy": "把已声明密钥部署/移除到集群机器安全目录，或只读校验漂移",
};

const RELEASE_STATUS_LABELS: Readonly<Record<string, string>> = {
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  incomplete: "未完成",
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  check: "检查",
  install: "安装",
  configure: "配置",
  start: "启动",
  stop: "停止",
  restart: "重启",
  deploy: "部署",
};

const STATUS_LABELS: Readonly<Record<StepStatus, string>> = {
  [StepStatus.SUCCEEDED]: "通过",
  [StepStatus.FAILED]: "失败",
  [StepStatus.SKIPPED]: "跳过",
  [StepStatus.BLOCKED]: "阻塞",
  [StepStatus.CANCELLED]: "已取消",
};

interface HelpOption {
  readonly option: string;
  readonly description: string;
}

interface ActionHelp {
  readonly usageSuffix: string;
  readonly options: readonly HelpOption[];
  readonly notes?: readonly string[];
}

function helpOption(option: string, description: string): HelpOption {
  return Object.freeze({ option, description });
}

const CLUSTER_OPTION = helpOption("--cluster NAME", "配置根目录下的集群目录名");
const CONFIG_ROOT_OPTION = helpOption(
  "--config-root PATH",
  "配置根目录；省略时搜索 ./NAME 和 ./clusters/NAME",
);
const MACHINE_OPTION = helpOption("--machine NAME", "仅选择指定机器；可重复");
const APP_OPTION = helpOption("--app NAME", "仅选择指定 App；可重复");
const ENVIRONMENT_OPTION = helpOption(
  "--environment [MACHINE/]NAME",
  "仅选择指定环境实例；可重复",
);
const ENV_OPTION = helpOption(
  "--env [MACHINE/]NAME",
  "仅选择指定环境应用；与 --environment 等价，可重复",
);
const REGION_OPTION = helpOption("--executor-region REGION", "覆盖部署执行器区域");
const ADDRESS_OPTION = helpOption(
  "--address-kind private|public",
  "显式选择机器地址类型",
);
const WITH_DEPENDENCIES_OPTION = helpOption(
  "--with-dependencies",
  "定向 App 时同时执行环境依赖",
);
const GLOBAL_RELEASE_ID_OPTION = helpOption(
  "--release-id ID",
  "查看发布或指定回退来源",
);
const HISTORY_RELEASE_ID_OPTION = helpOption(
  "--release-id ID",
  "查看指定发布记录；省略时列出全部记录",
);
const ROLLBACK_RELEASE_ID_OPTION = helpOption(
  "--release-id ID",
  "要回退到的发布 ID（必填）",
);
const DENO_VERSION_OPTION = helpOption(
  "--deno-version VERSION",
  "安装的 Deno 版本；省略时安装最新稳定版",
);
const INSTALL_TO_OPTION = helpOption(
  "--install-to PATH",
  "远端安装目录（绝对 POSIX 路径）；默认 /usr/local",
);
const REMOVE_OPTION = helpOption(
  "--remove NAME",
  "从目标机器安全目录显式移除该密钥；可重复",
);
const CHECK_OPTION = helpOption(
  "--check",
  "只读校验安全目录权限与清单哈希，不写任何文件",
);
const JSON_OPTION = helpOption(
  "--json",
  "以稳定 JSON 输出结果与错误（默认输出人类可读的分步进度）",
);
const YES_OPTION = helpOption("--yes", "跳过 deploy、缺省全量安装与 install-deno 确认");
const GLOBAL_HELP_OPTION = helpOption("-h, --help", "显示帮助");
const ACTION_HELP_OPTION = helpOption("-h, --help", "显示该动作帮助");

const SELECTOR_OPTIONS: readonly HelpOption[] = Object.freeze([
  MACHINE_OPTION,
  APP_OPTION,
  ENVIRONMENT_OPTION,
  REGION_OPTION,
  ADDRESS_OPTION,
]);
const SELECTOR_OPTIONS_WITH_DEPENDENCIES: readonly HelpOption[] = Object.freeze([
  ...SELECTOR_OPTIONS,
  WITH_DEPENDENCIES_OPTION,
]);
const APP_ONLY_OPTIONS: readonly HelpOption[] = Object.freeze([
  MACHINE_OPTION,
  APP_OPTION,
  REGION_OPTION,
  ADDRESS_OPTION,
]);
const ENVIRONMENT_ONLY_OPTIONS: readonly HelpOption[] = Object.freeze([
  MACHINE_OPTION,
  ENVIRONMENT_OPTION,
  REGION_OPTION,
  ADDRESS_OPTION,
]);

const ACTION_HELP: Readonly<Record<CliAction, ActionHelp>> = {
  validate: { usageSuffix: "", options: Object.freeze([]) },
  plan: {
    usageSuffix: "",
    options: APP_ONLY_OPTIONS,
    notes: Object.freeze([
      "预览 deploy 动作；不建立 SSH 连接、不下载包、不解析秘密值",
      "只处理 App；环境准备使用 prepare，不支持 --environment/--with-dependencies",
    ]),
  },
  check: {
    usageSuffix: "",
    options: ENVIRONMENT_ONLY_OPTIONS,
    notes: Object.freeze(["环境动作，不支持 --app"]),
  },
  install: {
    usageSuffix: "",
    options: Object.freeze([...ENVIRONMENT_ONLY_OPTIONS, YES_OPTION]),
    notes: Object.freeze([
      "环境动作，不支持 --app",
      "省略 --environment 时覆盖所选范围内的全部环境；缺省全量安装会请求确认",
    ]),
  },
  configure: { usageSuffix: "", options: SELECTOR_OPTIONS_WITH_DEPENDENCIES },
  prepare: {
    usageSuffix: "",
    options: Object.freeze([
      MACHINE_OPTION,
      ENV_OPTION,
      REGION_OPTION,
      ADDRESS_OPTION,
      YES_OPTION,
    ]),
    notes: Object.freeze([
      "环境动作，不支持 --app",
      "步骤：check → 按需 install；声明 configure 时追加；首次安装成功后 start，更新成功后 restart",
      "同版本且检查通过时跳过；未声明 start/restart 脚本的环境应用自动跳过并提示",
      "省略 --env 时覆盖所选范围内的全部环境应用；缺省全量会请求确认",
    ]),
  },
  deploy: {
    usageSuffix: "",
    options: Object.freeze([...APP_ONLY_OPTIONS, YES_OPTION]),
    notes: Object.freeze([
      "每次部署写入发布历史，成功结果包含 release_id",
      "执行前会请求确认；自动化调用需传 --yes",
      "只处理 App；环境准备使用 prepare，不支持 --environment/--with-dependencies",
    ]),
  },
  fetch: {
    usageSuffix: "",
    options: Object.freeze([APP_OPTION]),
    notes: Object.freeze([
      "只处理 App 安装包，不支持环境、机器、区域、地址或依赖过滤",
      "缓存目录由 ~/.sfo-deploy/config.yaml 的 packages_dir 配置（缺省 ~/.sfo-deploy/packages）",
    ]),
  },
  start: { usageSuffix: "", options: SELECTOR_OPTIONS_WITH_DEPENDENCIES },
  stop: { usageSuffix: "", options: SELECTOR_OPTIONS_WITH_DEPENDENCIES },
  restart: { usageSuffix: "", options: SELECTOR_OPTIONS_WITH_DEPENDENCIES },
  history: {
    usageSuffix: " [--release-id ID]",
    options: Object.freeze([HISTORY_RELEASE_ID_OPTION]),
    notes: Object.freeze([
      "不能与 --machine/--app/--environment/--executor-region/--address-kind/--with-dependencies 混用",
    ]),
  },
  rollback: {
    usageSuffix: " --release-id ID",
    options: Object.freeze([ROLLBACK_RELEASE_ID_OPTION]),
    notes: Object.freeze([
      "不能与 --machine/--app/--environment/--executor-region/--address-kind/--with-dependencies 混用",
    ]),
  },
  "install-deno": {
    usageSuffix: " [--deno-version VERSION] [--install-to PATH]",
    options: Object.freeze([
      MACHINE_OPTION,
      REGION_OPTION,
      ADDRESS_OPTION,
      DENO_VERSION_OPTION,
      INSTALL_TO_OPTION,
      YES_OPTION,
    ]),
    notes: Object.freeze([
      "只支持 --machine 筛选，不支持 --app/--environment/--with-dependencies",
      "缺省安装到远端 /usr/local/bin/deno；已最新则跳过，旧版本升级",
      "显式 --deno-version 时只在该精确版本已存在时跳过",
      "省略 --machine 时覆盖全部机器并请求确认；纯 SSH 直连，不要求远端预装 Deno",
    ]),
  },
  "secrets-deploy": {
    usageSuffix: " [--machine NAME ...] [--remove NAME ...] [--check]",
    options: Object.freeze([
      MACHINE_OPTION,
      REMOVE_OPTION,
      CHECK_OPTION,
      REGION_OPTION,
      ADDRESS_OPTION,
      YES_OPTION,
    ]),
    notes: Object.freeze([
      "只支持 --machine 筛选，不支持 --app/--environment/--with-dependencies",
      "部署时读取集群目录内 secrets.yaml；顶层键对应密钥名，文件密钥值为相对路径",
      "缺省覆盖 cluster.yaml.secrets 声明需要密钥的全部机器并请求确认；--check 无需确认",
      "目录默认 ~/.sfo-deploy/secrets/（0700，文件 0600）；消息与错误不输出秘密值",
      "--check 报告缺失/漂移/未声明残留且返回非零退出码；不允许与 --remove 混用",
    ]),
  },
};

function optionLine(entry: HelpOption): string {
  return `  ${entry.option.padEnd(32)}${entry.description}`;
}

function usage(generic: boolean): string {
  const root = generic ? " [--config-root PATH]" : "";
  const actions = CLI_ACTIONS.map((action) =>
    `  ${action.padEnd(14)}${ACTION_DESCRIPTIONS[action]}`
  ).join("\n");
  const options = [
    CLUSTER_OPTION,
    ...(generic ? [CONFIG_ROOT_OPTION] : []),
    MACHINE_OPTION,
    APP_OPTION,
    ENVIRONMENT_OPTION,
    REGION_OPTION,
    ADDRESS_OPTION,
    WITH_DEPENDENCIES_OPTION,
    GLOBAL_RELEASE_ID_OPTION,
    YES_OPTION,
    JSON_OPTION,
    GLOBAL_HELP_OPTION,
  ].map(optionLine).join("\n");
  return `用法: sfo-deploy <action> --cluster NAME${root} [选项]\n\n` +
    "校验、规划或串行执行一个自包含集群部署。\n\n" +
    "动作:\n" +
    `${actions}\n\n` +
    "运行 sfo-deploy <action> --help 查看该动作参数。\n\n" +
    "选项:\n" +
    `${options}\n`;
}

function actionUsage(action: CliAction, generic: boolean): string {
  const help = ACTION_HELP[action];
  const root = generic ? " [--config-root PATH]" : "";
  const options = [
    ...help.options,
    CLUSTER_OPTION,
    ...(generic ? [CONFIG_ROOT_OPTION] : []),
    JSON_OPTION,
    ACTION_HELP_OPTION,
  ].map(optionLine).join("\n");
  const notes = help.notes ?? [];
  return `用法: sfo-deploy ${action} --cluster NAME${help.usageSuffix}${root}\n\n` +
    `${ACTION_DESCRIPTIONS[action]}\n\n` +
    "参数:\n" +
    `${options}\n` +
    (notes.length > 0 ? `\n限制:\n${notes.map((note) => `  ${note}`).join("\n")}\n` : "");
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
