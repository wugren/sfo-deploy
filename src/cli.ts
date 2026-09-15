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
  readonly activate: boolean;
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
        activate: parsed.activate,
      });
      const defaultConfirmMachines = (machines: readonly string[]) =>
        confirmMachineTargets(machines, stdin, stderr);
      const confirmPlan = parsed.yes ? undefined : dependencies.confirmPlan ??
        ((plan: ExecutionPlan) => confirmExecutionPlan(plan, stdin, stderr, parsed.activate));
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
          `Error (${normalized.category}): ${redactor.redact(normalized.message)}\n`,
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
    throw new ConfigurationError(`Invalid cluster selection name: ${JSON.stringify(cluster)}`);
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
        throw new ConfigurationError(`Failed to check cluster directory: ${candidate}`, { cause });
      }
    }
  }
  throw new ConfigurationError(
    `Cluster ${cluster} not found under the current directory; searched: ${candidates.join(", ")}`,
  );
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
  let activate = true;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      if (action !== undefined) throw new ArgumentError(`Unrecognized extra argument: ${argument}`);
      if (!(CLI_ACTIONS as readonly string[]).includes(argument)) {
        throw new ArgumentError(`Unsupported CLI action: ${argument}`);
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
        if (fixedRoot) throw new ArgumentError("Project-bound CLI does not support --config-root");
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
          throw new ArgumentError("--address-kind supports only private or public");
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
      case "--no-activate":
        rejectInline(name, inline);
        activate = false;
        break;
      case "--json":
        rejectInline(name, inline);
        json = true;
        break;
      default:
        throw new ArgumentError(`Unrecognized option: ${name}`);
    }
  }
  if (!help && action === undefined) throw new ArgumentError("Missing action argument");
  if (!help && cluster === undefined) throw new ArgumentError("Missing required option: --cluster");
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
    activate,
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
    throw new ArgumentError(`${name} requires a value`);
  }
  return value;
}

function rejectInline(name: string, inline?: string): void {
  if (inline !== undefined) throw new ArgumentError(`${name} does not accept a value`);
}

async function confirmExecutionPlan(
  plan: ExecutionPlan,
  stdin: Reader,
  stderr: Writer,
  activate: boolean,
): Promise<boolean> {
  if (plan.requestedAction === "deploy") {
    const steps = plan.steps.map((step) =>
      `${step.kind}:${step.machine.machine.name}/${step.resource}:${step.action}`
    );
    const phaseText = activate
      ? "built-in versioned Apps complete every stage first, then activate"
      : "activation is skipped: versions are uploaded and deployed without switching latest or restarting";
    await writeText(
      stderr,
      `Deployment will process ${steps.length} steps (${phaseText}): ${steps.join(", ")}\n`,
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
      `Default full environment preparation will process ${targets.length} environment apps: ${
        targets.join(", ")
      }\n`,
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
      `Default full install will process ${targets.length} environments: ${targets.join(", ")}\n`,
    );
  }
  if (stdin.isTerminal && !stdin.isTerminal()) return false;
  await writeText(
    stderr,
    plan.requestedAction === "deploy"
      ? "Confirm deployment? Type yes to continue, anything else cancels: "
      : plan.requestedAction === "prepare"
      ? "Confirm default full environment preparation? Type yes to continue, anything else cancels: "
      : "Confirm default full install? Type yes to continue, anything else cancels: ",
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
    `Default full operation will process ${machines.length} machines: ${machines.join(", ")}\n`,
  );
  if (stdin.isTerminal && !stdin.isTerminal()) return false;
  await writeText(
    stderr,
    "Run on all machines? Type yes to continue, anything else cancels: ",
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
      return "already up to date";
    case "check-satisfied":
      return "check satisfied";
    case "using-start":
      return "reuse start step";
    case "using-restart":
      return "reuse restart step";
    case "target-fail-fast":
      return "target machine already failed";
    case "dependency-failed":
      return message ?? "dependency did not succeed";
    default:
      return message ?? reason;
  }
}

function humanStepLine(event: Extract<ProgressEvent, { readonly kind: "step-result" }>): string {
  const step = event.step;
  const action = ACTION_LABELS[step.action] ?? step.action;
  const base = `[${step.machine}] ${step.resource} ${action} (${
    event.index + 1
  }/${event.total})... ${STATUS_LABELS[step.status]}`;
  if (step.status === StepStatus.SKIPPED) {
    return `${base} (${skipReasonText(step.skipReason ?? "", step.message)})`;
  }
  if (step.status === StepStatus.FAILED || step.status === StepStatus.BLOCKED) {
    const recovery = step.recovery === undefined
      ? ""
      : step.recovery.succeeded
      ? "; recovery succeeded"
      : "; recovery incomplete";
    const detail = `${step.message ?? step.skipReason ?? ""}${recovery}`;
    return detail === "" ? base : `${base}: ${detail}`;
  }
  const managed = [
    step.changed === undefined ? undefined : step.changed ? "config changed" : "config unchanged",
    step.service === undefined ? undefined : `service action ${step.service.action}`,
    step.bundle === undefined
      ? undefined
      : step.bundle.reused
      ? "deployment bundle reused"
      : "deployment bundle uploaded",
    step.recovery === undefined
      ? undefined
      : step.recovery.succeeded
      ? "recovery succeeded"
      : "recovery incomplete",
  ].filter((item): item is string => item !== undefined);
  const detail = [step.message, ...managed].filter((item): item is string => item !== undefined);
  if (detail.length > 0) return `${base} (${detail.join("; ")})`;
  return base;
}

function humanMachineLine(machine: MachineDenoOutcome): string {
  const base = `[${machine.machine}] install-deno ... ${
    machine.status === "present"
      ? "already satisfied"
      : machine.status === "installed"
      ? "installed"
      : "failed"
  }`;
  if (machine.status === "failed") {
    const detail = machine.message ?? "";
    return detail === "" ? base : `${base} (${machine.errorCategory ?? "execution"}): ${detail}`;
  }
  const version = machine.version === undefined ? "" : ` ${machine.version}`;
  return `${base} (${machine.denoPath}${version})`;
}

function humanPackageLine(pkg: FetchPackageResult): string {
  return `[${pkg.app}] fetch ${pkg.version} ... ${
    pkg.status === "downloaded" ? "downloaded" : "cache hit"
  } (${pkg.path})`;
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

function planStepDetail(step: import("./types.ts").PlanStep): string[] {
  const lines: string[] = [];
  if (step.dependsOn.length > 0) {
    lines.push(`depends_on: ${step.dependsOn.join(", ")}`);
  }
  if (step.package !== undefined) {
    lines.push(`package: ${step.package.provider}`);
  }
  if (step.deployment !== undefined) {
    lines.push(`deployment: ${step.deployment.kind}`);
  }
  const runtime = step.machine.machine.scriptRuntime;
  lines.push(
    `runtime: ${runtime.kind}${
      runtime.executable && runtime.executable !== runtime.kind ? ` (${runtime.executable})` : ""
    }`,
  );
  if (step.scripts.length > 0) {
    lines.push(`scripts: ${step.scripts.map((invocation) => invocation.relativePath).join(", ")}`);
  }
  const secrets = [...step.secretValues, ...step.secretFiles];
  if (secrets.length > 0) {
    lines.push(`secrets: ${secrets.join(", ")}`);
  }
  const management = step.management;
  if (management !== undefined) {
    if (management.manager !== undefined && management.manager.kind === "service") {
      const manager = management.manager;
      const enabled = manager.enabled === undefined
        ? ""
        : `${manager.enabled ? "enabled" : "disabled"}, `;
      lines.push(`service: ${manager.unit} (${enabled}on ${manager.onDeploy})`);
    } else if (management.manager !== undefined && management.manager.kind === "script") {
      lines.push("manager: script");
    }
    if (management.configs.length > 0) {
      lines.push(
        `configs: ${
          management.configs.map((config) => `${config.target} (${config.format})`).join(", ")
        }`,
      );
    }
  }
  return lines;
}

async function writeHumanResult(writer: Writer, result: RunResult): Promise<void> {
  if (result instanceof ValidationResult) {
    await writeText(
      writer,
      `Config validation passed: cluster ${result.cluster} (directory ${result.directory}, ${result.machines.length} machines, ${result.environments.length} environment instances, ${result.apps.length} Apps)\n`,
    );
    return;
  }
  if (result instanceof FetchResult) {
    const downloaded = result.packages.filter((pkg) => pkg.status === "downloaded").length;
    const cached = result.packages.length - downloaded;
    let summary =
      `Fetch complete: cluster ${result.cluster}, ${downloaded} downloaded, ${cached} cache hits`;
    if (result.appsWithoutPackage.length > 0) {
      summary += `; ${result.appsWithoutPackage.length} Apps have no installer package: ${
        result.appsWithoutPackage.join(", ")
      }`;
    }
    await writeText(writer, `${summary}\n`);
    return;
  }
  if (result instanceof ReleaseHistoryResult) {
    await writeText(writer, `Release history: cluster ${result.cluster}\n`);
    for (const record of result.releases) {
      const status = RELEASE_STATUS_LABELS[record.status] ?? record.status;
      const finished = record.finishedAt === undefined ? "" : `, finished ${record.finishedAt}`;
      await writeText(
        writer,
        `- ${record.releaseId} (${record.operation}, ${status}${finished})\n`,
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
      `install-deno complete: cluster ${result.cluster}, ${
        result.succeeded ? "succeeded" : "failed"
      } (${result.machines.length} machines: ${present} already satisfied, ${installed} installed, ${failed} failed)\n`,
    );
    return;
  }
  if (result instanceof SecretsDeployResult) {
    const operationLabel = result.operation === "check"
      ? "check"
      : result.operation === "remove"
      ? "remove"
      : "deploy";
    await writeText(
      writer,
      `secrets ${operationLabel} complete: cluster ${result.cluster}, ${
        result.succeeded ? "succeeded" : "failed"
      } (${result.machines.length} machines)\n`,
    );
    for (const machine of result.machines) {
      const detail = machine.issues !== undefined && machine.issues.length > 0
        ? "; issues: " + machine.issues.map((issue) => `${issue.name}=${issue.kind}`).join(", ")
        : machine.entries !== undefined
        ? "; written " +
          machine.entries.filter((entry) => entry.status === "written").length +
          ", unchanged " +
          machine.entries.filter((entry) => entry.status === "unchanged").length
        : "";
      const outcome = machine.status === "succeeded" ? "passed" : "failed";
      const message = machine.message === undefined ? "" : `: ${machine.message}`;
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
      `Cluster: ${result.cluster}\nAction: ${result.requestedAction}\nStatus: ${
        result.succeeded ? "succeeded" : "failed"
      }\n`,
    );
    if (result.releaseId !== undefined) {
      await writeText(writer, `Release ID: ${result.releaseId}\n`);
    }
    if (result.sourceReleaseId !== undefined) {
      await writeText(writer, `Source release ID: ${result.sourceReleaseId}\n`);
    }
    for (const target of result.targets) {
      const counts = new Map<StepStatus, number>();
      for (const step of target.steps) {
        counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
      }
      const breakdown = [...counts.entries()]
        .map(([status, count]) => `${STATUS_LABELS[status]} ${count}`)
        .join(", ");
      await writeText(
        writer,
        `Target: ${target.machine} (${
          STATUS_LABELS[target.status]
        }) ${target.steps.length} steps, ${breakdown}\n`,
      );
    }
    return;
  }
  await writeText(
    writer,
    `Plan: cluster ${result.cluster} | action ${result.requestedAction} | ${result.steps.length} steps\n`,
  );
  for (const [index, step] of result.steps.entries()) {
    await writeText(
      writer,
      `- [${
        index + 1
      }/${result.steps.length}] ${step.machine.machine.name} (${step.machine.address}/${step.machine.addressKind}) ${step.kind}:${step.resource} ${step.action}\n`,
    );
    for (const detail of planStepDetail(step)) {
      await writeText(writer, `    ${detail}\n`);
    }
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
          read: [...invocation.permissions.read ?? []],
          write: [...invocation.permissions.write ?? []],
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
    config_scripts: management.configScripts.map((script) => script.relativePath),
    manager: management.manager === undefined ? null : {
      ...(management.manager.kind === "service"
        ? {
          kind: management.manager.kind,
          unit: management.manager.unit,
          tool: management.manager.tool,
          enabled: management.manager.enabled ?? null,
          daemon_reload: management.manager.daemonReload,
          on_deploy: management.manager.onDeploy,
          ...(management.manager.unitConfig === undefined ? {} : {
            unit_config: {
              target: management.manager.unitConfig.target,
              working_directory: management.manager.unitConfig.workingDirectory,
              command: management.manager.unitConfig.command,
              args: [...management.manager.unitConfig.args],
            },
          }),
        }
        : {
          kind: management.manager.kind,
          start: management.manager.start.relativePath,
          stop: management.manager.stop.relativePath,
          restart: management.manager.restart.relativePath,
        }),
    },
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
    return { category: "cancelled", message: cause.message || "User cancelled", exitCode: 130 };
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
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error("Output stream did not accept data");
    }
    offset += count;
  }
}

function pathFromStringOrUrl(value: string | URL): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new ConfigurationError("Config root must be a local file path");
    }
    return resolve(decodeURIComponent(value.pathname));
  }
  return resolve(value);
}

/** 每个 CLI 动作在帮助文本中的一行中文描述。 */
const ACTION_DESCRIPTIONS: Readonly<Record<CliAction, string>> = {
  validate: "Load and validate the cluster configuration",
  plan: "Preview the deploy plan without running remote steps",
  check: "Check whether the selected environments are satisfied",
  install: "Install or initialize the selected environments",
  configure: "Configure environments or Apps (deliver secrets and templates)",
  prepare:
    "Deploy/update selected environment apps (check, install on demand, configure, start or restart)",
  deploy: "Deploy selected Apps and archive release snapshots",
  fetch: "Download App installer packages into the local deployment package cache",
  start: "Start the target environment or App",
  stop: "Stop the target environment or App",
  restart: "Restart the target environment or App",
  history: "Browse release history or view a specific release",
  rollback: "Roll back to the release given by --release-id",
  "install-deno": "Install a pinned Deno version on target machines over plain SSH",
  "secrets-deploy":
    "Deploy/remove declared secrets in the cluster machine secure directory, or check drift read-only",
};

const RELEASE_STATUS_LABELS: Readonly<Record<string, string>> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  incomplete: "incomplete",
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  check: "check",
  install: "install",
  configure: "configure",
  start: "start",
  stop: "stop",
  restart: "restart",
  deploy: "deploy",
};

const STATUS_LABELS: Readonly<Record<StepStatus, string>> = {
  [StepStatus.SUCCEEDED]: "passed",
  [StepStatus.FAILED]: "failed",
  [StepStatus.SKIPPED]: "skipped",
  [StepStatus.BLOCKED]: "blocked",
  [StepStatus.CANCELLED]: "cancelled",
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

const CLUSTER_OPTION = helpOption("--cluster NAME", "Cluster directory name under the config root");
const CONFIG_ROOT_OPTION = helpOption(
  "--config-root PATH",
  "Config root; when omitted, search ./NAME and ./clusters/NAME",
);
const MACHINE_OPTION = helpOption("--machine NAME", "Select only the given machines; repeatable");
const APP_OPTION = helpOption("--app NAME", "Select only the given Apps; repeatable");
const ENVIRONMENT_OPTION = helpOption(
  "--environment [MACHINE/]NAME",
  "Select only the given environment instances; repeatable",
);
const ENV_OPTION = helpOption(
  "--env [MACHINE/]NAME",
  "Select only the given environment apps; equivalent to --environment, repeatable",
);
const REGION_OPTION = helpOption(
  "--executor-region REGION",
  "Override the deployment executor region",
);
const ADDRESS_OPTION = helpOption(
  "--address-kind private|public",
  "Explicitly select the machine address kind",
);
const WITH_DEPENDENCIES_OPTION = helpOption(
  "--with-dependencies",
  "Also run environment dependencies for targeted Apps",
);
const GLOBAL_RELEASE_ID_OPTION = helpOption(
  "--release-id ID",
  "View a release or set the rollback source",
);
const HISTORY_RELEASE_ID_OPTION = helpOption(
  "--release-id ID",
  "View the given release record; when omitted, list all records",
);
const ROLLBACK_RELEASE_ID_OPTION = helpOption(
  "--release-id ID",
  "Release ID to roll back to (required)",
);
const DENO_VERSION_OPTION = helpOption(
  "--deno-version VERSION",
  "Deno version to install; when omitted, install the latest stable version",
);
const INSTALL_TO_OPTION = helpOption(
  "--install-to PATH",
  "Remote install directory (absolute POSIX path); default /usr/local",
);
const REMOVE_OPTION = helpOption(
  "--remove NAME",
  "Explicitly remove this secret from the target machine secure directory; repeatable",
);
const CHECK_OPTION = helpOption(
  "--check",
  "Check secure directory permissions and manifest hashes read-only; write no files",
);
const NO_ACTIVATE_OPTION = helpOption(
  "--no-activate",
  "Deploy only: upload and stage the new version, but skip switching latest and restarting the service",
);
const JSON_OPTION = helpOption(
  "--json",
  "Output results and errors as stable JSON (default: step-by-step human-readable progress)",
);
const YES_OPTION = helpOption(
  "--yes",
  "Skip deploy, default full install, and install-deno confirmations",
);
const GLOBAL_HELP_OPTION = helpOption("-h, --help", "Show help");
const ACTION_HELP_OPTION = helpOption("-h, --help", "Show help for this action");

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
  NO_ACTIVATE_OPTION,
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
      "Preview the deploy action; no SSH connection, no package download, no secret resolution",
      "Handle only Apps; use prepare for environments; --environment/--with-dependencies are not supported",
    ]),
  },
  check: {
    usageSuffix: "",
    options: ENVIRONMENT_ONLY_OPTIONS,
    notes: Object.freeze(["Environment action; --app is not supported"]),
  },
  install: {
    usageSuffix: "",
    options: Object.freeze([...ENVIRONMENT_ONLY_OPTIONS, YES_OPTION]),
    notes: Object.freeze([
      "Environment action; --app is not supported",
      "When --environment is omitted, cover all environments in the selected scope; default full install asks for confirmation",
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
      "Environment action; --app is not supported",
      "Steps: check → install on demand; append configure when declared; start after the first install, restart after an update",
      "Skip when the version is unchanged and the check passes; environment apps without start/restart scripts are skipped with a notice",
      "When --env is omitted, cover all environment apps in the selected scope; default full runs ask for confirmation",
    ]),
  },
  deploy: {
    usageSuffix: "",
    options: Object.freeze([...APP_ONLY_OPTIONS, YES_OPTION]),
    notes: Object.freeze([
      "Every deployment writes release history; successful results include release_id",
      "Asks for confirmation before execution; automated calls must pass --yes",
      "--no-activate stages the new version only: it does not switch latest or restart the service",
      "Handle only Apps; use prepare for environments; --environment/--with-dependencies are not supported",
    ]),
  },
  fetch: {
    usageSuffix: "",
    options: Object.freeze([APP_OPTION]),
    notes: Object.freeze([
      "Handle only App installer packages; environment, machine, region, address, and dependency filtering are not supported",
      "The cache directory comes from packages_dir in ~/.sfo-deploy/config.yaml (default ~/.sfo-deploy/packages)",
    ]),
  },
  start: { usageSuffix: "", options: SELECTOR_OPTIONS_WITH_DEPENDENCIES },
  stop: { usageSuffix: "", options: SELECTOR_OPTIONS_WITH_DEPENDENCIES },
  restart: { usageSuffix: "", options: SELECTOR_OPTIONS_WITH_DEPENDENCIES },
  history: {
    usageSuffix: " [--release-id ID]",
    options: Object.freeze([HISTORY_RELEASE_ID_OPTION]),
    notes: Object.freeze([
      "Cannot be combined with --machine/--app/--environment/--executor-region/--address-kind/--with-dependencies",
    ]),
  },
  rollback: {
    usageSuffix: " --release-id ID",
    options: Object.freeze([ROLLBACK_RELEASE_ID_OPTION]),
    notes: Object.freeze([
      "Cannot be combined with --machine/--app/--environment/--executor-region/--address-kind/--with-dependencies",
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
      "Supports only --machine filtering; --app/--environment/--with-dependencies are not supported",
      "Installs to remote /usr/local/bin/deno by default; skips when up to date and upgrades older versions",
      "With an explicit --deno-version, skip only when that exact version already exists",
      "When --machine is omitted, cover all machines and ask for confirmation; plain SSH, no remote Deno required",
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
      "Supports only --machine filtering; --app/--environment/--with-dependencies are not supported",
      "Reads secrets.yaml in the cluster directory at deploy time; top-level keys are secret names and file secret values are relative paths",
      "By default covers all machines that need declared secrets from cluster.yaml.secrets and asks for confirmation; --check needs no confirmation",
      "Directory defaults to ~/.sfo-deploy/secrets/ (0700, files 0600); messages and errors never print secret values",
      "--check reports missing/drifted/undeclared leftovers and returns a non-zero exit code; cannot be combined with --remove",
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
  return `Usage: sfo-deploy <action> --cluster NAME${root} [options]\n\n` +
    "Validate, plan, or serially execute a self-contained cluster deployment.\n\n" +
    "Actions:\n" +
    `${actions}\n\n` +
    "Run sfo-deploy <action> --help to see action-specific arguments.\n\n" +
    "Options:\n" +
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
  return `Usage: sfo-deploy ${action} --cluster NAME${help.usageSuffix}${root}\n\n` +
    `${ACTION_DESCRIPTIONS[action]}\n\n` +
    "Arguments:\n" +
    `${options}\n` +
    (notes.length > 0 ? `\nLimits:\n${notes.map((note) => `  ${note}`).join("\n")}\n` : "");
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
