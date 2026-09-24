/** 以严格 argv 边界调用系统 OpenSSH 的传输实现。 */

import * as posix from "jsr:@std/path@1.1.6/posix";
import { join, resolve } from "jsr:@std/path@1.1.6";
import { CancelledError, PreflightError, TransportError } from "./errors.ts";
import {
  type BuiltinConfigCandidateRequest,
  type ExtractAppPackageRequest,
  type ExtractedAppPackage,
  extractValidatedAppPackage,
  type ManagedConfigPublication,
  ManagedConfigPublicationError,
  type ManagedConfigPublishRequest,
  REMOTE_CONFIG_UPDATER_BUNDLE_PATH,
  type RemoteConfigCandidate,
  type RemoteOperationLease,
  type RemoteOperationLockRequest,
  type ScopedSecretCopy,
  type ScopedSecretCopyRequest,
  type StagedDeploymentBundle,
  stageDeploymentBundle as stageBundle,
  type StageDeploymentBundleOptions,
} from "./remote_deployment.ts";
import { SECRET_NAME_RE } from "./secrets.ts";
import type { BuiltDeploymentBundle } from "./deployment_bundle.ts";
import { type InfoLogger, type SafeInfoLogger, safeInfoLogger } from "./logging.ts";
import type { ResolvedMachine, ScriptPermissions, SecretKind } from "./types.ts";
import { type CommandResult, commandResult } from "./results.ts";

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
export const DEFAULT_TERMINATE_TIMEOUT_MS = 2_000;
export const DEFAULT_OPERATION_LEASE_TTL_MS = 600_000;
export const DEFAULT_OPERATION_HEARTBEAT_INTERVAL_MS = 30_000;
export const OPERATION_LEASE_EXPIRED_EXIT_CODE = 74;
export const WORKSPACE_PREFIX = "/tmp/sfo-deploy-";
const CONTROL_PERSIST_SECONDS = 1800;

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENVIRONMENT_RESOURCE_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9.:%-]*$/;
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SAFE_REMOTE_PATH_RE = /^\/[A-Za-z0-9_@%+=:,./~-]+$/;

export interface RemoteRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly privileged?: boolean;
  readonly cwd?: string;
}

export interface SecretManifestEntry {
  readonly name: string;
  readonly kind: SecretKind;
  readonly sha256: string;
}

export interface RemoteSecretUpload {
  readonly name: string;
  readonly kind: SecretKind;
  readonly source: string;
  readonly sha256: string;
}

export interface DeploySecretResult extends SecretManifestEntry {
  readonly status: "written" | "unchanged";
}

export interface RemoteSecretState {
  readonly dirMode: string;
  readonly entries: readonly string[];
  readonly manifest: readonly SecretManifestEntry[];
  readonly sha256: Readonly<Record<string, string>>;
}

export interface RemoteSession extends AsyncDisposable {
  createWorkspace(signal?: AbortSignal): Promise<string>;
  /** 恢复失败时保留工作目录，移出 close 自动清理集合。 */
  preserveWorkspace?(path: string): void;
  stageDeploymentBundle?(
    bundle: BuiltDeploymentBundle,
    options: StageDeploymentBundleOptions,
  ): Promise<StagedDeploymentBundle>;
  createManagedConfigCandidate?(
    request: BuiltinConfigCandidateRequest,
    signal?: AbortSignal,
  ): Promise<RemoteConfigCandidate>;
  publishManagedConfigs?(
    requests: readonly ManagedConfigPublishRequest[],
    signal?: AbortSignal,
  ): Promise<readonly ManagedConfigPublication[]>;
  restoreManagedConfigs?(
    publications: readonly ManagedConfigPublication[],
    signal?: AbortSignal,
  ): Promise<void>;
  commitManagedConfigs?(
    publications: readonly ManagedConfigPublication[],
    signal?: AbortSignal,
  ): Promise<void>;
  acquireOperationLock?(
    request: RemoteOperationLockRequest,
    signal?: AbortSignal,
  ): Promise<RemoteOperationLease>;
  releaseOperationLock?(lease: RemoteOperationLease): Promise<void>;
  createScopedSecretCopy?(
    request: ScopedSecretCopyRequest,
    signal?: AbortSignal,
  ): Promise<ScopedSecretCopy>;
  cleanupScopedSecretCopy?(copy: ScopedSecretCopy): Promise<void>;
  extractAppPackage?(
    request: ExtractAppPackageRequest,
  ): Promise<ExtractedAppPackage>;
  exposeStepSecrets(
    secretNames: readonly string[],
    directory: string,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<string>;
  upload(localPath: string, remotePath: string, signal?: AbortSignal, mode?: number): Promise<void>;
  uploadFile(
    localPath: string,
    remotePath: string,
    options?: { readonly signal?: AbortSignal; readonly mode?: number },
  ): Promise<void>;
  run(argv: readonly string[], options?: RemoteRunOptions): Promise<CommandResult>;
  deploySecrets(
    files: readonly RemoteSecretUpload[],
    directory: string,
    signal?: AbortSignal,
  ): Promise<readonly DeploySecretResult[]>;
  removeSecret(name: string, directory: string, signal?: AbortSignal): Promise<void>;
  checkSecrets(directory: string, signal?: AbortSignal): Promise<RemoteSecretState>;
  preflightDeno(
    executable: string,
    signal?: AbortSignal,
    minimumMajor?: number,
  ): Promise<CommandResult>;
  preflightPrivilege(signal?: AbortSignal): Promise<void>;
  executeDeno(executable: string, script: string, options: {
    readonly workspace: string;
    readonly metadataPath: string;
    readonly secretDir?: string;
    readonly permissions: ScriptPermissions;
    readonly privileged?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<CommandResult>;
  readEnvironmentVersion(resource: string, signal?: AbortSignal): Promise<string | undefined>;
  writeEnvironmentVersion(resource: string, version: string, signal?: AbortSignal): Promise<void>;
  removeFile(path: string, signal?: AbortSignal): Promise<void>;
  removeTree(path: string, signal?: AbortSignal): Promise<void>;
  cleanupWorkspace(path: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface Transport {
  connect(machine: ResolvedMachine, signal?: AbortSignal): Promise<RemoteSession>;
}

export interface SpawnedCommand {
  output(): Promise<Deno.CommandOutput>;
  kill(signo?: Deno.Signal): void;
  readonly pid?: number;
}

export type CommandFactory = (
  command: string,
  args: readonly string[],
) => SpawnedCommand;

function defaultCommandFactory(command: string, args: readonly string[]): SpawnedCommand {
  return new Deno.Command(command, {
    args: [...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

interface OpenSshTransportOptions {
  readonly knownHosts?: string;
  readonly sshExecutable?: string;
  readonly scpExecutable?: string;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly terminateTimeoutMs?: number;
  readonly commandFactory?: CommandFactory;
  /** 可选 info 过程日志；未提供时保持静默。 */
  readonly onInfo?: InfoLogger;
}

/** 系统 OpenSSH 传输；本地命令进程通过会话专用控制套接字复用主连接。 */
export class OpenSshTransport implements Transport {
  readonly knownHosts?: string;
  readonly sshExecutable: string;
  readonly scpExecutable: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly terminateTimeoutMs: number;
  readonly #commandFactory: CommandFactory;
  readonly #info: SafeInfoLogger;

  constructor(options: OpenSshTransportOptions = {}) {
    this.knownHosts = options.knownHosts;
    this.sshExecutable = localExecutable(options.sshExecutable ?? "ssh", "ssh");
    this.scpExecutable = localExecutable(options.scpExecutable ?? "scp", "scp");
    this.connectTimeoutMs = positiveTimeout(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "SSH connection",
    );
    this.commandTimeoutMs = positiveTimeout(
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      "SSH command",
    );
    this.terminateTimeoutMs = positiveTimeout(
      options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS,
      "SSH process termination",
    );
    this.#commandFactory = options.commandFactory ?? defaultCommandFactory;
    this.#info = safeInfoLogger(options.onInfo);
  }

  async connect(target: ResolvedMachine, signal?: AbortSignal): Promise<OpenSshRemoteSession> {
    throwIfAborted(signal);
    const knownHosts = await this.#knownHostsPath();
    const machine = target.machine;
    const user = sshUser(machine.sshUser);
    const port = sshPort(machine.sshPort);
    const key = machine.sshPrivateKey === undefined
      ? undefined
      : await regularLocalFile(machine.sshPrivateKey, "SSH private key");
    const addresses = target.addresses.length > 0 ? target.addresses : [target.address];
    const failures: string[] = [];
    await this.#info("SSH connection started", {
      machine: machine.name,
      user,
      addresses: addresses.length,
    });
    for (const rawAddress of addresses) {
      const address = sshAddress(rawAddress);
      const controlDirectory = await Deno.makeTempDir({ prefix: "sfo-ssh-" });
      const controlPath = join(controlDirectory, "control");
      if (new TextEncoder().encode(controlPath).length >= 100) {
        await Deno.remove(controlDirectory);
        throw new PreflightError("SSH control socket path is too long");
      }
      try {
        await Deno.chmod(controlDirectory, 0o700);
      } catch (cause) {
        await Deno.remove(controlDirectory);
        throw new PreflightError("Failed to secure SSH control socket directory", { cause });
      }
      const session = new OpenSshRemoteSession({
        address,
        user,
        port,
        privateKey: key,
        knownHosts,
        controlDirectory,
        controlPath,
        sshExecutable: this.sshExecutable,
        scpExecutable: this.scpExecutable,
        connectTimeoutMs: this.connectTimeoutMs,
        commandTimeoutMs: this.commandTimeoutMs,
        terminateTimeoutMs: this.terminateTimeoutMs,
        commandFactory: this.#commandFactory,
        onInfo: this.#info,
      });
      let connected = false;
      try {
        const result = await session.run(["true"], {
          signal,
          timeoutMs: this.connectTimeoutMs,
        });
        if (result.exitCode === 0) {
          await session.verifyMultiplexing(signal);
          connected = true;
          await this.#info("SSH connection completed", {
            machine: machine.name,
            address,
          });
          return session;
        }
        failures.push(`${address}: ${diagnostic(result)}`);
      } catch (cause) {
        if (cause instanceof CancelledError) throw cause;
        failures.push(`${address}: ${errorText(cause)}`);
      } finally {
        if (!connected) {
          try {
            await session.close();
          } catch (cause) {
            failures.push(`${address} cleanup: ${errorText(cause)}`);
          }
        }
      }
    }
    if (failures.length === 1) {
      await this.#info("SSH connection failed", {
        machine: machine.name,
        addresses: addresses.length,
      });
      throw new TransportError(
        `SSH connection failed ${machine.name}@${addresses[0]}: ${
          failures[0].split(": ").slice(1).join(": ")
        }`,
      );
    }
    throw new TransportError(
      `SSH connection failed ${machine.name}; no candidate address is usable: ${
        failures.join("; ")
      }`,
    );
  }

  async #knownHostsPath(): Promise<string> {
    let raw = this.knownHosts;
    if (!raw) {
      try {
        const home = Deno.env.get(Deno.build.os === "windows" ? "USERPROFILE" : "HOME");
        if (home) raw = `${home.replace(/[\\/]+$/, "")}/.ssh/known_hosts`;
      } catch (cause) {
        throw new PreflightError("Failed to read HOME to locate known_hosts", { cause });
      }
    }
    if (!raw) {
      throw new PreflightError(
        "known_hosts must be provided explicitly, or created at HOME/.ssh/known_hosts",
      );
    }
    return await regularLocalFile(raw, "known_hosts");
  }
}

interface SessionOptions {
  readonly address: string;
  readonly user: string;
  readonly port: number;
  readonly privateKey?: string;
  readonly knownHosts: string;
  readonly controlDirectory?: string;
  readonly controlPath?: string;
  readonly sshExecutable: string;
  readonly scpExecutable: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly terminateTimeoutMs: number;
  readonly commandFactory: CommandFactory;
  readonly onInfo?: InfoLogger;
}

interface HeldOperationLease {
  readonly lease: RemoteOperationLease;
  readonly child: SpawnedCommand;
  readonly output: Promise<Deno.CommandOutput>;
  readonly readyPath: string;
  readonly stopPath: string;
  readonly leasePath: string;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  heartbeatRunning: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  lost: boolean;
  /** 已进入正常释放流程：holder 退出是预期结果，不应判定为失锁。 */
  releasing: boolean;
}

export class OpenSshRemoteSession implements RemoteSession {
  readonly #options: SessionOptions;
  readonly #workspaces = new Set<string>();
  /** 本会话创建的消费者秘密拷贝：path -> workspace，用于限定清理边界。 */
  readonly #scopedSecretCopies = new Map<string, string>();
  readonly #operationLeases = new Map<string, HeldOperationLease>();
  /** 会话级失锁广播：失锁时中止所有在途受保护操作，旧执行方不能继续写共享目标。 */
  readonly #leaseAbort = new AbortController();
  #leaseLostReason?: TransportError;
  #privilegePrefix?: readonly string[];
  #home?: string;
  #closed = false;
  readonly #info: SafeInfoLogger;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#info = safeInfoLogger(options.onInfo);
  }

  /** 首次探测后确认 OpenSSH 已保留可供 ssh/scp 共用的主连接。 */
  async verifyMultiplexing(signal?: AbortSignal): Promise<void> {
    if (!this.#options.controlPath) {
      throw new PreflightError("SSH control connection is not configured");
    }
    const result = await this.#runLocal(
      this.#options.sshExecutable,
      [...this.#sshOptions(false), "-O", "check", this.#sshDestination()],
      signal,
      this.#options.connectTimeoutMs,
      "SSH control connection check",
    );
    requireSuccess(result, "SSH control connection was not established");
  }

  async run(argv: readonly string[], options: RemoteRunOptions = {}): Promise<CommandResult> {
    this.#ensureOpen();
    this.#ensureLeaseUsable();
    try {
      const result = await this.#runRemote(argv, {
        ...options,
        signal: this.#protectedSignal(options.signal),
      });
      this.#ensureLeaseUsable();
      return result;
    } catch (cause) {
      if (cause instanceof CancelledError && this.#leaseLostReason !== undefined) {
        throw this.#leaseLostReason;
      }
      throw cause;
    }
  }

  async #runRemote(
    argv: readonly string[],
    options: RemoteRunOptions = {},
  ): Promise<CommandResult> {
    this.#ensureOpen();
    const arguments_ = validateArgv(argv);
    const startedAt = Date.now();
    const command: string[] = [];
    if (options.privileged) {
      await this.preflightPrivilege(options.signal);
      command.push(...(this.#privilegePrefix ?? []));
    }
    if (options.environment) {
      command.push("env");
      command.push(...environmentAssignments(options.environment));
    }
    command.push(...arguments_);
    const renderedCommand = `exec ${command.map(quotePosix).join(" ")}`;
    const rendered = options.cwd === undefined
      ? renderedCommand
      : `cd ${quotePosix(this.#registeredWorkspace(options.cwd))} && ${renderedCommand}`;
    try {
      const result = await this.#runLocal(
        this.#options.sshExecutable,
        [...this.#sshOptions(false), this.#sshDestination(), rendered],
        options.signal,
        options.timeoutMs ?? this.#options.commandTimeoutMs,
        "remote command",
      );
      return result;
    } catch (cause) {
      await this.#info("remote command failed", {
        address: this.#options.address,
        command: arguments_[0],
        durationMs: Date.now() - startedAt,
      });
      throw cause;
    }
  }

  async createWorkspace(signal?: AbortSignal): Promise<string> {
    this.#ensureOpen();
    const startedAt = Date.now();
    await this.#info("remote workspace creation started", { address: this.#options.address });
    for (let attempt = 0; attempt < 8; attempt++) {
      const workspace = `${WORKSPACE_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
      const result = await this.run(["mkdir", "-m", "0700", "--", workspace], { signal });
      if (result.exitCode !== 0) continue;
      const permission = await this.run(["chmod", "0700", "--", workspace], { signal });
      if (permission.exitCode !== 0) {
        await this.run(["rm", "-rf", "--", workspace], { signal }).catch(() => undefined);
        continue;
      }
      this.#workspaces.add(workspace);
      await this.#info("remote workspace created", {
        address: this.#options.address,
        workspace,
        durationMs: Date.now() - startedAt,
      });
      return workspace;
    }
    throw new TransportError("Failed to create a unique remote temporary workspace");
  }

  stageDeploymentBundle(
    bundle: BuiltDeploymentBundle,
    options: StageDeploymentBundleOptions,
  ): Promise<StagedDeploymentBundle> {
    this.#ensureOpen();
    const workspace = this.#registeredWorkspace(options.workspace);
    return stageBundle(this, bundle, { ...options, workspace });
  }

  async extractAppPackage(
    request: ExtractAppPackageRequest,
  ): Promise<ExtractedAppPackage> {
    const workspace = this.#registeredWorkspace(request.workspace);
    const extracted = await extractValidatedAppPackage(this, { ...request, workspace });
    try {
      requireSuccess(
        await this.run(["chmod", "0700", "--", extracted.root], {
          signal: request.signal,
        }),
        "Failed to restrict App unpack directory permissions",
      );
      return extracted;
    } catch (cause) {
      await this.run(["rm", "-rf", "--", extracted.root]).catch(() => undefined);
      throw cause;
    }
  }

  async createManagedConfigCandidate(
    request: BuiltinConfigCandidateRequest,
    signal?: AbortSignal,
  ): Promise<RemoteConfigCandidate> {
    this.#ensureOpen();
    const workspace = this.#registeredWorkspace(request.workspace);
    const updater = workspaceMember(workspace, request.updaterScript, "framework config updater");
    assertFrameworkUpdater(workspace, updater);
    const skeleton = workspaceMember(workspace, request.skeleton, "config skeleton");
    const bindings = workspaceMember(workspace, request.bindings, "config binding manifest");
    const secretDir = workspaceMember(workspace, request.secretDir, "step secret copy directory");
    const secretRoot = await this.#expandSecretDirectory(request.secretRoot, signal);
    const fileSecrets = validateSecretNames(request.fileSecrets, "file secret");
    const candidatePath = `${workspace}/candidate-${safeConfigName(request.name)}`;
    const result = await this.run([
      runtimeExecutable(request.denoExecutable),
      "run",
      "--no-prompt",
      "--no-config",
      "--no-remote",
      "--no-npm",
      "--deny-env",
      "--deny-net",
      "--deny-run",
      "--deny-ffi",
      `--allow-read=${permissionPath(updater)},${permissionPath(skeleton)},${
        permissionPath(bindings)
      },${permissionPath(secretDir)}${
        fileSecrets.length > 0
          ? `,${fileSecrets.map((name) => permissionPath(`${secretRoot}/${name}`)).join(",")}`
          : ""
      }`,
      `--allow-write=${permissionPath(candidatePath)}`,
      updater,
      "update",
      "--format",
      request.format,
      "--input",
      skeleton,
      "--bindings",
      bindings,
      "--secrets",
      secretDir,
      "--secret-root",
      secretRoot,
      "--output",
      candidatePath,
    ], { signal, timeoutMs: request.timeoutMs });
    if (result.exitCode !== 0) {
      await this.run(["rm", "-f", "--", candidatePath]).catch(() => undefined);
      const detail = [result.stdout, result.stderr].map((text) => text.trim()).filter(Boolean)
        .join("\n");
      throw new TransportError(
        `Fixed updater for config ${request.name} failed${detail ? `: ${detail}` : ""}`,
      );
    }
    await this.#assertCandidate(candidatePath, request.name, signal);
    return Object.freeze({ name: request.name, workspace, path: candidatePath });
  }

  async publishManagedConfigs(
    requests: readonly ManagedConfigPublishRequest[],
    signal?: AbortSignal,
  ): Promise<readonly ManagedConfigPublication[]> {
    this.#ensureOpen();
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new PreflightError("Config publish transaction must not be empty");
    }
    const targets = new Set<string>();
    const publications: ManagedConfigPublication[] = [];
    try {
      for (const [index, request] of requests.entries()) {
        const workspace = this.#registeredWorkspace(request.candidate.workspace);
        const candidate = workspaceMember(workspace, request.candidate.path, "config candidate");
        await this.#assertCandidate(candidate, request.candidate.name, signal);
        const target = safeRemotePath(request.target);
        if (targets.has(target)) {
          throw new PreflightError(`Duplicate config publish target: ${target}`);
        }
        targets.add(target);
        const mode = fileMode(request.mode).toString(8).padStart(4, "0");
        const owner = request.owner === undefined ? undefined : userOrGroup(request.owner, "owner");
        const group = request.group === undefined ? undefined : userOrGroup(request.group, "group");
        if (request.validator !== undefined) {
          const argv = request.validator.argv.map((item: string) =>
            item === "{candidate}" ? candidate : item
          );
          if (!argv.includes(candidate)) {
            throw new PreflightError("Config validator is missing {candidate}");
          }
          const validation = await this.run(argv, {
            signal,
            timeoutMs: request.validator.timeoutMs,
          });
          if (validation.exitCode !== 0) {
            throw new TransportError(`Validator for config ${request.candidate.name} failed`);
          }
        }
        await this.preflightPrivilege(signal);
        const parent = posix.dirname(target);
        let resolvedRoot: string | undefined;
        if (request.releaseRoot !== undefined) {
          const root = safeRemotePath(request.releaseRoot);
          if (
            !target.startsWith(`${root}/`) || root.split("/").includes("..") ||
            target.split("/").includes("..")
          ) {
            throw new PreflightError(`Version config target is out of bounds ${target}`);
          }
          const rootLink = await this.run(["/usr/bin/test", "-L", root], {
            signal,
            privileged: true,
          });
          if (rootLink.exitCode !== 1) {
            throw new TransportError(`Version root is not a regular directory ${root}`);
          }
          const realRoot = await this.run(["realpath", "-e", "--", root], {
            signal,
            privileged: true,
          });
          requireSuccess(realRoot, `Failed to resolve the version root ${root}`);
          resolvedRoot = realRoot.stdout.trim();
          if (!resolvedRoot.startsWith("/")) {
            throw new TransportError(`Failed to resolve the version root ${root}`);
          }
        }
        const parentState = await this.run(["/usr/bin/test", "-d", parent], {
          signal,
          privileged: true,
        });
        if (parentState.exitCode === 1) {
          if (request.releaseRoot === undefined) {
            requireSuccess(parentState, `Config target parent directory does not exist ${parent}`);
          }
          await this.#ensureReleaseParent(
            safeRemotePath(request.releaseRoot!),
            parent,
            signal,
          );
        } else {
          requireSuccess(parentState, `Config target parent directory does not exist ${parent}`);
        }
        if (request.releaseRoot !== undefined) {
          const root = safeRemotePath(request.releaseRoot);
          const realParent = await this.run(["realpath", "-e", "--", parent], {
            signal,
            privileged: true,
          });
          requireSuccess(
            realParent,
            `Failed to resolve the version config parent directory ${parent}`,
          );
          const resolvedParent = realParent.stdout.trim();
          const expectedRoot = resolvedRoot;
          if (expectedRoot === undefined) {
            throw new TransportError(`Failed to resolve the version root ${root}`);
          }
          if (
            !expectedRoot.startsWith("/") ||
            (resolvedParent !== expectedRoot && !resolvedParent.startsWith(`${expectedRoot}/`))
          ) {
            throw new TransportError(`Version config parent directory escapes ${parent}`);
          }
        }
        const targetState = await this.run(["/usr/bin/test", "-e", target], {
          signal,
          privileged: true,
        });
        if (targetState.exitCode !== 0 && targetState.exitCode !== 1) {
          throw new TransportError(`Failed to check the config target ${target}`);
        }
        const existed = targetState.exitCode === 0;
        let originalMode: string | undefined;
        let originalOwner: string | undefined;
        let originalGroup: string | undefined;
        if (existed) {
          const type = await this.run(["stat", "-c", "%F", "--", target], {
            signal,
            privileged: true,
          });
          requireSuccess(type, `Failed to check the config target type ${target}`);
          if (compatibleRemoteStatField(type.stdout, 0) !== "regular file") {
            throw new TransportError(`Config target is not a regular file ${target}`);
          }
          const modeResult = await this.run(["stat", "-c", "%a", "--", target], {
            signal,
            privileged: true,
          });
          const ownerResult = await this.run(["stat", "-c", "%U", "--", target], {
            signal,
            privileged: true,
          });
          const groupResult = await this.run(["stat", "-c", "%G", "--", target], {
            signal,
            privileged: true,
          });
          requireSuccess(modeResult, `Failed to check config target permissions ${target}`);
          requireSuccess(ownerResult, `Failed to check the config target owner ${target}`);
          requireSuccess(groupResult, `Failed to check the config target group ${target}`);
          originalMode = compatibleRemoteStatField(modeResult.stdout, 1);
          originalOwner = compatibleRemoteStatField(ownerResult.stdout, 2);
          originalGroup = compatibleRemoteStatField(groupResult.stdout, 3);
          if (!/^[0-7]{3,4}$/u.test(originalMode)) {
            throw new TransportError(`Invalid config target permission output ${target}`);
          }
          userOrGroup(originalOwner, "original owner");
          userOrGroup(originalGroup, "original group");
          const compare = await this.run(["cmp", "--silent", "--", candidate, target], {
            signal,
            privileged: true,
          });
          if (compare.exitCode === 0) {
            // 内容相同仍需收敛请求的 mode/owner/group；只有元数据也一致才跳过发布。
            const metadataMatches = originalMode.padStart(4, "0") === mode &&
              (owner === undefined || owner === originalOwner) &&
              (group === undefined || group === originalGroup);
            if (metadataMatches) {
              const fingerprints = await this.#secretFingerprints(
                target,
                request.secretRoot,
                request.secretFiles,
                signal,
              );
              await this.run(["rm", "-f", "--", candidate]).catch(() => undefined);
              publications.push(Object.freeze({
                name: request.candidate.name,
                workspace,
                target,
                changed: false,
                existed: true,
                serviceChange: fingerprints?.changed,
                secretFingerprintPath: fingerprints?.path,
                secretFingerprints: fingerprints?.hashes,
              }));
              continue;
            }
          } else if (compare.exitCode !== 1) {
            throw new TransportError(`Failed to compare the config target ${target}`);
          }
        }
        const backup = existed
          ? `${workspace}/config-backup-${index}-${crypto.randomUUID()}`
          : undefined;
        if (backup !== undefined) {
          requireSuccess(
            await this.run(["cp", "--", target, backup], { signal, privileged: true }),
            `Failed to back up the config ${target}`,
          );
          requireSuccess(
            await this.run(["chown", this.#options.user, "--", backup], {
              signal,
              privileged: true,
            }),
            `Failed to restrict config backup ownership ${target}`,
          );
          requireSuccess(
            await this.run(["chmod", "0600", "--", backup], { signal, privileged: true }),
            `Failed to restrict config backup permissions ${target}`,
          );
        }
        const temporary = `${parent}/.${posix.basename(target)}.sfo-${crypto.randomUUID()}`;
        try {
          const installArgv = ["install", "-m", mode];
          const finalOwner = owner ?? originalOwner;
          const finalGroup = group ?? originalGroup;
          if (finalOwner !== undefined) installArgv.push("-o", finalOwner);
          if (finalGroup !== undefined) installArgv.push("-g", finalGroup);
          installArgv.push("--", candidate, temporary);
          requireSuccess(
            await this.run(installArgv, { signal, privileged: true }),
            `Failed to create the config publish temporary file ${target}`,
          );
          // 发送 rename 前记录补偿状态，覆盖远端成功而响应丢失的情况。
          publications.push(Object.freeze({
            name: request.candidate.name,
            workspace,
            target,
            changed: true,
            existed,
            backupPath: backup,
            originalMode,
            originalOwner,
            originalGroup,
            serviceChange: true,
          }));
          requireSuccess(
            await this.run(["mv", "-f", "-T", "--", temporary, target], {
              signal,
              privileged: true,
            }),
            `Failed to publish the config atomically ${target}`,
          );
        } finally {
          await this.run(["rm", "-f", "--", temporary], { privileged: true }).catch(
            () => undefined,
          );
          await this.run(["rm", "-f", "--", candidate]).catch(() => undefined);
        }
      }
      return Object.freeze(publications);
    } catch (cause) {
      try {
        await this.restoreManagedConfigs(publications);
      } catch (recoveryCause) {
        throw new ManagedConfigPublicationError(
          "Config publish failed and published config recovery is incomplete",
          publications,
          {
            cause: new AggregateError([cause, recoveryCause]),
          },
        );
      }
      throw cause;
    }
  }

  async #secretFingerprints(
    target: string,
    secretRoot: string,
    names: readonly string[],
    signal?: AbortSignal,
  ): Promise<
    | undefined
    | {
      readonly changed: boolean;
      readonly path: string;
      readonly hashes: Readonly<Record<string, string>>;
    }
  > {
    const unique = validateSecretNames(names, "file secret");
    if (unique.length === 0) return undefined;
    const expandedRoot = await this.#expandSecretDirectory(secretRoot, signal);
    const path = secretFingerprintPath(target);
    const hashes: Record<string, string> = {};
    for (const name of unique) {
      const source = `${expandedRoot}/${name}`;
      const result = await this.run(["sha256sum", "--", source], { signal, privileged: true });
      requireSuccess(result, `Failed to read the file secret fingerprint ${name}`);
      const hash = /^([0-9a-f]{64})\s+/.exec(result.stdout)?.[1];
      if (hash === undefined) throw new TransportError(`Invalid file secret fingerprint ${name}`);
      hashes[name] = hash;
    }
    let previous: Record<string, string> = {};
    const exists = await this.run(["/usr/bin/test", "-f", path], { signal, privileged: true });
    if (exists.exitCode === 0) {
      const content = await this.run(["cat", "--", path], { signal, privileged: true });
      requireSuccess(content, `Failed to read the config secret fingerprint ${target}`);
      try {
        const parsed = JSON.parse(content.stdout) as { files?: Record<string, string> };
        if (
          parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object"
        ) {
          previous = parsed.files;
        }
      } catch {
        throw new TransportError(`Config secret fingerprint is not valid JSON ${path}`);
      }
    } else if (exists.exitCode !== 1) {
      throw new TransportError(`Failed to check the config secret fingerprint ${path}`);
    }
    return Object.freeze({
      changed: unique.some((name) => previous[name] !== hashes[name]),
      path,
      hashes: Object.freeze(hashes),
    });
  }

  async restoreManagedConfigs(
    publications: readonly ManagedConfigPublication[],
    _signal?: AbortSignal,
  ): Promise<void> {
    this.#ensureOpen();
    const errors: unknown[] = [];
    for (const publication of [...publications].reverse()) {
      if (!publication.changed) continue;
      try {
        const workspace = this.#registeredWorkspace(publication.workspace);
        const target = safeRemotePath(publication.target);
        await this.preflightPrivilege();
        if (publication.existed) {
          if (
            publication.backupPath === undefined || publication.originalMode === undefined ||
            publication.originalOwner === undefined || publication.originalGroup === undefined
          ) {
            throw new TransportError("Config recovery record is incomplete");
          }
          const backup = workspaceMember(workspace, publication.backupPath, "config backup");
          const temporary = `${posix.dirname(target)}/.${
            posix.basename(target)
          }.restore-${crypto.randomUUID()}`;
          try {
            requireSuccess(
              await this.run([
                "install",
                "-m",
                publication.originalMode,
                "-o",
                userOrGroup(publication.originalOwner, "original owner"),
                "-g",
                userOrGroup(publication.originalGroup, "original group"),
                "--",
                backup,
                temporary,
              ], { privileged: true }),
              `Failed to restore the config temporary file ${target}`,
            );
            requireSuccess(
              await this.run(["mv", "-f", "-T", "--", temporary, target], {
                privileged: true,
              }),
              `Failed to restore the config atomically ${target}`,
            );
          } finally {
            await this.run(["rm", "-f", "--", temporary], { privileged: true }).catch(
              () => undefined,
            );
          }
        } else {
          requireSuccess(
            await this.run(["rm", "-f", "--", target], { privileged: true }),
            `Failed to delete the newly published config ${target}`,
          );
        }
        if (publication.backupPath !== undefined) {
          const backup = workspaceMember(workspace, publication.backupPath, "config backup");
          await this.run(["rm", "-f", "--", backup]).catch(() => undefined);
        }
      } catch (cause) {
        errors.push(cause);
      }
    }
    if (errors.length > 0) {
      throw new TransportError("One or more config recoveries failed", { cause: errors[0] });
    }
  }

  async commitManagedConfigs(
    publications: readonly ManagedConfigPublication[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.#ensureOpen();
    for (const publication of publications) {
      if (
        publication.secretFingerprintPath !== undefined &&
        publication.secretFingerprints !== undefined
      ) {
        await this.#writeSecretFingerprint(
          publication.workspace,
          publication.secretFingerprintPath,
          publication.secretFingerprints,
          signal,
        );
      }
      if (publication.backupPath === undefined) continue;
      const workspace = this.#registeredWorkspace(publication.workspace);
      const backup = workspaceMember(workspace, publication.backupPath, "config backup");
      requireSuccess(
        await this.run(["rm", "-f", "--", backup], { signal }),
        `Failed to clean up the config backup ${publication.name}`,
      );
    }
  }

  async #ensureReleaseParent(
    root: string,
    parent: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!parent.startsWith(`${root}/`)) {
      throw new PreflightError(`Version config target is out of bounds ${parent}`);
    }
    const relative = parent.slice(root.length + 1);
    const segments = relative.split("/");
    if (
      relative.length === 0 ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new PreflightError(`Invalid version config parent directory ${parent}`);
    }
    let current = root;
    for (const segment of segments) {
      current += `/${segment}`;
      const existing = await this.run(["/usr/bin/test", "-e", current], {
        signal,
        privileged: true,
      });
      if (existing.exitCode === 1) {
        const argv = [
          "/usr/bin/install",
          "-d",
          "-m",
          "0750",
          "-o",
          userOrGroup(this.#options.user, "SSH user"),
        ];
        argv.push("--", current);
        requireSuccess(
          await this.run(argv, { signal, privileged: true }),
          `Failed to create the config target parent directory ${current}`,
        );
        continue;
      }
      requireSuccess(existing, `Failed to check the config target parent directory ${current}`);
      const link = await this.run(["/usr/bin/test", "-L", current], {
        signal,
        privileged: true,
      });
      if (link.exitCode !== 1) {
        throw new TransportError(
          `Version config parent directory is not a regular directory ${current}`,
        );
      }
      const directory = await this.run(["/usr/bin/test", "-d", current], {
        signal,
        privileged: true,
      });
      requireSuccess(
        directory,
        `Version config parent directory is not a regular directory ${current}`,
      );
    }
  }

  async #writeSecretFingerprint(
    workspace: string,
    destination: string,
    hashes: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<void> {
    const registered = this.#registeredWorkspace(workspace);
    const local = await Deno.makeTempFile({ prefix: "sfo-config-fingerprint-" });
    await Deno.chmod(local, 0o600);
    const staged = `${registered}/config-fingerprint.json`;
    let temporary: string | undefined;
    try {
      await Deno.writeTextFile(
        local,
        `${JSON.stringify({ schema_version: 1, files: hashes }, null, 2)}\n`,
      );
      await this.uploadFile(local, staged, { signal, mode: 0o600 });
      temporary = `${destination}.tmp`;
      requireSuccess(
        await this.run(["install", "-m", "0600", "--", staged, temporary], {
          signal,
          privileged: true,
        }),
        `Failed to install the config secret fingerprint ${destination}`,
      );
      requireSuccess(
        await this.run(["mv", "-f", "-T", "--", temporary, destination], {
          signal,
          privileged: true,
        }),
        `Failed to publish the config secret fingerprint ${destination}`,
      );
      temporary = undefined;
    } finally {
      await Deno.remove(local).catch(() => undefined);
      await this.run(["rm", "-f", "--", staged]).catch(() => undefined);
      if (temporary !== undefined) {
        await this.run(["rm", "-f", "--", temporary], { privileged: true }).catch(() => undefined);
      }
    }
  }

  async #assertCandidate(path: string, name: string, signal?: AbortSignal): Promise<void> {
    const type = await this.run(["stat", "-c", "%F", "--", path], { signal });
    requireSuccess(type, `Failed to check the type of config ${name} candidate`);
    const typeOutput = type.stdout.trim();
    const combinedType = typeOutput.split("\t");
    if (
      typeOutput !== "regular file" &&
      !(combinedType.length === 2 && combinedType[0] === "regular file" &&
        /^(?:0|[1-9][0-9]*)$/u.test(combinedType[1]))
    ) {
      throw new TransportError(`Config ${name} candidate is not a restricted regular file`);
    }
    const size = await this.run(["stat", "-c", "%s", "--", path], { signal });
    requireSuccess(size, `Failed to check the length of config ${name} candidate`);
    const sizeOutput = size.stdout.trim();
    const combinedSize = sizeOutput.split("\t");
    const sizeText = /^(?:0|[1-9][0-9]*)$/u.test(sizeOutput)
      ? sizeOutput
      : combinedSize.length === 2 && combinedSize[0] === "regular file" &&
          /^(?:0|[1-9][0-9]*)$/u.test(combinedSize[1])
      ? combinedSize[1]
      : undefined;
    if (sizeText === undefined) {
      throw new TransportError(`Invalid length output for config ${name} candidate`);
    }
    const sizeValue = Number(sizeText);
    if (!Number.isSafeInteger(sizeValue) || sizeValue > 16 * 1024 * 1024) {
      throw new TransportError(`Config ${name} candidate is not a restricted regular file`);
    }
    requireSuccess(
      await this.run(["chmod", "0600", "--", path], { signal }),
      `Failed to restrict permissions of config ${name} candidate`,
    );
  }

  async upload(
    localPath: string,
    remotePath: string,
    signal?: AbortSignal,
    mode = 0o600,
  ): Promise<void> {
    await this.uploadFile(localPath, remotePath, { signal, mode });
  }

  async uploadFile(
    localPath: string,
    remotePath: string,
    options: { readonly signal?: AbortSignal; readonly mode?: number } = {},
  ): Promise<void> {
    this.#ensureOpen();
    this.#ensureLeaseUsable();
    const source = await regularLocalFile(localPath, "upload source");
    const sourceSize = (await Deno.stat(source)).size;
    const remote = safeRemotePath(remotePath);
    const mode = fileMode(options.mode ?? 0o600);
    const startedAt = Date.now();
    await this.#info("file upload started", {
      address: this.#options.address,
      source,
      remote,
      mode,
      size: sourceSize,
    });
    let result: CommandResult;
    try {
      result = await this.#runLocal(
        this.#options.scpExecutable,
        [...this.#sshOptions(true), "--", source, this.#scpDestination(remote)],
        this.#protectedSignal(options.signal),
        this.#options.commandTimeoutMs,
        "upload file",
      );
    } catch (cause) {
      await this.#info("file upload failed", {
        address: this.#options.address,
        remote,
        durationMs: Date.now() - startedAt,
      });
      if (cause instanceof CancelledError && this.#leaseLostReason !== undefined) {
        throw this.#leaseLostReason;
      }
      throw cause;
    }
    this.#ensureLeaseUsable();
    requireSuccess(result, `Failed to upload file ${source} -> ${remote}`);
    await this.#info("file upload completed", {
      address: this.#options.address,
      remote,
      mode,
      size: sourceSize,
      durationMs: Date.now() - startedAt,
    });
    requireSuccess(
      await this.run(["chmod", mode.toString(8).padStart(4, "0"), "--", remote], {
        signal: options.signal,
      }),
      `Failed to set remote file permissions ${remote}`,
    );
  }

  async #expandSecretDirectory(rawDirectory: string, signal?: AbortSignal): Promise<string> {
    const raw = typeof rawDirectory === "string" && rawDirectory.length > 0
      ? rawDirectory
      : (() => {
        throw new PreflightError("Secure directory path must not be empty");
      })();
    const home = await this.#homeDirectory(signal);
    let absolute: string;
    if (raw === "~") absolute = home;
    else if (raw.startsWith("~/")) absolute = `${home}/${raw.slice(2)}`;
    else if (raw.startsWith("/")) absolute = raw;
    else {throw new PreflightError(
        `Secure directory must be a ~/ path or an absolute POSIX path: ${JSON.stringify(raw)}`,
      );}
    absolute = absolute.replace(/\/+$/, "") || "/";
    const safe = safeRemotePath(absolute);
    if (safe.split("/").includes("..")) {
      throw new PreflightError(
        `Secure directory must not contain .. segments: ${JSON.stringify(raw)}`,
      );
    }
    return safe;
  }

  async #secretCommandsPrivileged(directory: string, signal?: AbortSignal): Promise<boolean> {
    const home = await this.#homeDirectory(signal);
    return directory !== home && !directory.startsWith(`${home}/`);
  }

  async #readSecretManifest(
    directory: string,
    privileged: boolean,
    signal?: AbortSignal,
  ): Promise<SecretManifestEntry[]> {
    const manifest = `${directory}/manifest.json`;
    const exists = await this.run(["/usr/bin/test", "-f", manifest], {
      signal,
      privileged,
    });
    if (exists.exitCode === 1) return [];
    requireSuccess(exists, `Failed to check the secret manifest ${manifest}`);
    const content = await this.run(["/usr/bin/cat", "--", manifest], { signal, privileged });
    requireSuccess(content, `Failed to read the secret manifest ${manifest}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.stdout);
    } catch {
      throw new TransportError(`Secret manifest is not valid JSON: ${manifest}`);
    }
    if (!Array.isArray(parsed)) {
      throw new TransportError(`Secret manifest must be a JSON list: ${manifest}`);
    }
    const entries: SecretManifestEntry[] = [];
    for (const item of parsed as unknown[]) {
      if (
        !item || typeof item !== "object" || !("name" in item) || !("kind" in item) ||
        !("sha256" in item)
      ) {
        throw new TransportError(`Secret manifest entry is corrupted: ${manifest}`);
      }
      const record = item as Record<string, unknown>;
      const name = String(record.name);
      const kind = String(record.kind);
      const sha256 = String(record.sha256);
      if (!SECRET_NAME_RE.test(name) || (kind !== "value" && kind !== "file")) {
        throw new TransportError(`Invalid secret manifest entry identity: ${manifest}`);
      }
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw new TransportError(`Invalid secret manifest hash: ${manifest}`);
      }
      entries.push(Object.freeze({ name, kind: kind as SecretKind, sha256 }));
    }
    return entries;
  }

  async #writeSecretManifest(
    directory: string,
    workspace: string,
    entries: readonly SecretManifestEntry[],
    privileged: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const stagedManifest = `${workspace}/secret-manifest.json`;
    let temporary: string | undefined;
    try {
      temporary = await Deno.makeTempFile({ prefix: "sfo-secret-manifest-" });
      await Deno.chmod(temporary, 0o600);
      await Deno.writeTextFile(temporary, JSON.stringify(entries, null, 2) + "\n");
      await this.uploadFile(temporary, stagedManifest, { signal, mode: 0o600 });
      const destination = `${directory}/manifest.json`;
      const temporaryRemote = `${directory}/.manifest.json.tmp`;
      requireSuccess(
        await this.run(["install", "-m", "0600", "--", stagedManifest, temporaryRemote], {
          signal,
          privileged,
        }),
        `Failed to install the secret manifest ${destination}`,
      );
      requireSuccess(
        await this.run(["mv", "-f", "-T", "--", temporaryRemote, destination], {
          signal,
          privileged,
        }),
        `Failed to update the secret manifest atomically ${destination}`,
      );
    } finally {
      if (temporary !== undefined) {
        try {
          await Deno.remove(temporary);
        } catch {
          // 本地临时清单清理失败不影响主结果。
        }
      }
    }
  }

  async deploySecrets(
    files: readonly RemoteSecretUpload[],
    rawDirectory: string,
    signal?: AbortSignal,
  ): Promise<readonly DeploySecretResult[]> {
    this.#ensureOpen();
    const directory = await this.#expandSecretDirectory(rawDirectory, signal);
    const privileged = await this.#secretCommandsPrivileged(directory, signal);
    requireSuccess(
      await this.run(["mkdir", "-p", "-m", "0700", "--", directory], { signal, privileged }),
      `Failed to create the secure directory ${directory}`,
    );
    const mode = await this.run(["stat", "-c", "%a", "--", directory], {
      signal,
      privileged,
    });
    requireSuccess(mode, `Failed to check secure directory permissions ${directory}`);
    if (mode.stdout.trim() !== "700") {
      throw new PreflightError(
        `Secure directory permissions must be 0700; actual ${mode.stdout.trim()}: ${directory}`,
      );
    }
    const workspace = await this.createWorkspace(signal);
    const cleanup = async (): Promise<void> => {
      try {
        await this.cleanupWorkspace(workspace);
      } catch {
        // 清理失败不应遮蔽部署结果；保留 close() 兜底。
      }
    };
    try {
      const manifest = await this.#readSecretManifest(directory, privileged, signal);
      const byName = new Map(manifest.map((entry) => [entry.name, entry]));
      const results: DeploySecretResult[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (!SECRET_NAME_RE.test(file.name) || (file.kind !== "value" && file.kind !== "file")) {
          throw new PreflightError(`Invalid secret name or type: ${file.name}`);
        }
        if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
          throw new PreflightError(`Invalid hash for secret ${file.name}`);
        }
        const existing = byName.get(file.name);
        const destination = `${directory}/${file.name}`;
        if (
          existing !== undefined && existing.kind === file.kind &&
          existing.sha256 === file.sha256
        ) {
          // 清单命中仍需校验实际内容；漂移或缺失时重新发布，避免成功结果掩盖内容不一致。
          const actual = await this.run(["sha256sum", "--", destination], { signal, privileged });
          if (actual.exitCode === 0) {
            const hash = /^([0-9a-f]{64})\s+/u.exec(actual.stdout)?.[1];
            if (hash === undefined) {
              throw new TransportError(`Invalid secret hash output for ${file.name}`);
            }
            if (hash === file.sha256) {
              requireSuccess(
                await this.run(["chmod", "0600", "--", destination], { signal, privileged }),
                `Failed to fix secret permissions ${destination}`,
              );
              results.push(Object.freeze({
                name: file.name,
                kind: file.kind,
                sha256: file.sha256,
                status: "unchanged",
              }));
              continue;
            }
          } else if (actual.exitCode !== 1) {
            throw new TransportError(`Failed to read the secret ${destination}`);
          }
        }
        const staged = `${workspace}/secret-${index}`;
        await this.uploadFile(file.source, staged, { signal, mode: 0o600 });
        const temporary = `${directory}/.${file.name}.deployment-${
          crypto.randomUUID().replaceAll("-", "")
        }`;
        try {
          requireSuccess(
            await this.run(["install", "-m", "0600", "--", staged, temporary], {
              signal,
              privileged,
            }),
            `Failed to create the secret temporary file ${file.name}`,
          );
          requireSuccess(
            await this.run(["mv", "-f", "-T", "--", temporary, destination], {
              signal,
              privileged,
            }),
            `Failed to install the secret atomically ${file.name}`,
          );
        } finally {
          await this.run(["rm", "-f", "--", staged], { signal }).catch(() => undefined);
          await this.run(["rm", "-f", "--", temporary], { signal, privileged }).catch(
            () => undefined,
          );
        }
        byName.set(file.name, {
          name: file.name,
          kind: file.kind,
          sha256: file.sha256,
        });
        results.push(Object.freeze({
          name: file.name,
          kind: file.kind,
          sha256: file.sha256,
          status: "written",
        }));
      }
      const nextManifest = [...byName.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
      ).map((entry) =>
        Object.freeze({
          ...entry,
          updated_at: new Date().toISOString(),
        })
      );
      await this.#writeSecretManifest(directory, workspace, nextManifest, privileged, signal);
      return freezeSecretResults(results);
    } finally {
      await cleanup();
    }
  }

  async removeSecret(name: string, rawDirectory: string, signal?: AbortSignal): Promise<void> {
    this.#ensureOpen();
    if (!SECRET_NAME_RE.test(name)) {
      throw new PreflightError(`Invalid secret name: ${JSON.stringify(name)}`);
    }
    const directory = await this.#expandSecretDirectory(rawDirectory, signal);
    const privileged = await this.#secretCommandsPrivileged(directory, signal);
    const target = `${directory}/${name}`;
    const exists = await this.run(["/usr/bin/test", "-f", target], { signal, privileged });
    if (exists.exitCode !== 0 && exists.exitCode !== 1) {
      requireSuccess(exists, `Failed to check the secret file ${target}`);
    }
    const manifest = await this.#readSecretManifest(directory, privileged, signal);
    const inManifest = manifest.some((entry) => entry.name === name);
    if (exists.exitCode === 1 && !inManifest) {
      throw new PreflightError(`Secret is not deployed on this machine: ${name} (${directory})`);
    }
    if (exists.exitCode === 0) {
      requireSuccess(
        await this.run(["rm", "-f", "--", target], { signal, privileged }),
        `Failed to delete the secret ${target}`,
      );
    }
    const remaining = manifest.filter((entry) => entry.name !== name).map((entry) =>
      Object.freeze({ ...entry, updated_at: new Date().toISOString() })
    );
    const workspace = await this.createWorkspace(signal);
    try {
      await this.#writeSecretManifest(directory, workspace, remaining, privileged, signal);
    } finally {
      try {
        await this.cleanupWorkspace(workspace);
      } catch {
        // close() 会兜底清理。
      }
    }
  }

  async checkSecrets(rawDirectory: string, signal?: AbortSignal): Promise<RemoteSecretState> {
    this.#ensureOpen();
    const directory = await this.#expandSecretDirectory(rawDirectory, signal);
    const privileged = await this.#secretCommandsPrivileged(directory, signal);
    const exists = await this.run(["/usr/bin/test", "-d", directory], { signal, privileged });
    if (exists.exitCode === 1) {
      return Object.freeze({
        dirMode: "missing",
        entries: freezeStringArray([]),
        manifest: [],
        sha256: Object.freeze({}),
      });
    }
    requireSuccess(exists, `Failed to check the secure directory ${directory}`);
    const mode = await this.run(["stat", "-c", "%a", "--", directory], { signal, privileged });
    requireSuccess(mode, `Failed to check secure directory permissions ${directory}`);
    const manifest = await this.#readSecretManifest(directory, privileged, signal);
    const listing = await this.run(["ls", "-1", "-A", "--", directory], { signal, privileged });
    requireSuccess(listing, `Failed to list the secure directory ${directory}`);
    const entries = listing.stdout.split(/\r?\n/).map((item) => item.trim())
      .filter((item) => item.length > 0 && item !== "manifest.json");
    const sha256: Record<string, string> = {};
    for (const name of [...new Set([...manifest.map((entry) => entry.name), ...entries])].sort()) {
      const path = `${directory}/${name}`;
      const result = await this.run(["sha256sum", "--", path], { signal, privileged });
      if (result.exitCode === 0) {
        const match = /^([0-9a-f]{64})\s+/.exec(result.stdout);
        if (match) sha256[name] = match[1];
      }
    }
    return Object.freeze({
      dirMode: mode.stdout.trim(),
      entries: freezeStringArray(entries),
      manifest,
      sha256: Object.freeze(sha256),
    });
  }

  /**
   * 为单个消费者（生命周期脚本或配置渲染器）建立只含其声明秘密的拷贝目录。
   * 身份统一为 SSH 登录用户：秘密来自 home 内时直接复制，来自特权目录时提权读取后归还属主。
   */
  async createScopedSecretCopy(
    request: ScopedSecretCopyRequest,
    signal?: AbortSignal,
  ): Promise<ScopedSecretCopy> {
    this.#ensureOpen();
    const workspace = this.#registeredWorkspace(request.workspace);
    const sourceDirectory = await this.#expandSecretDirectory(request.sourceDirectory, signal);
    const sourcePrivileged = await this.#secretCommandsPrivileged(sourceDirectory, signal);
    const names = validateSecretNames(request.names, "consumer");
    const path = `${workspace}/consumer-secrets-${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      requireSuccess(
        await this.run(["mkdir", "-m", "0700", "--", path], { signal }),
        "Failed to create the consumer secret copy directory",
      );
      for (const name of names) {
        const source = `${sourceDirectory}/${name}`;
        const destination = `${path}/${name}`;
        const type = await this.run(["stat", "-c", "%F", "--", source], {
          signal,
          privileged: sourcePrivileged,
        });
        requireSuccess(type, `Secret is not deployed on this machine: ${name}`);
        if (compatibleRemoteStatField(type.stdout, 0) !== "regular file") {
          throw new PreflightError(`Secret source is not a regular file: ${name}`);
        }
        requireSuccess(
          await this.run(["install", "-m", "0600", "--", source, destination], {
            signal,
            privileged: sourcePrivileged,
          }),
          `Failed to copy the consumer secret: ${name}`,
        );
        if (sourcePrivileged) {
          requireSuccess(
            await this.run(["chown", this.#options.user, "--", destination], {
              signal,
              privileged: true,
            }),
            `Failed to set the consumer secret owner: ${name}`,
          );
        }
        const mode = await this.run(["stat", "-c", "%a", "--", destination], { signal });
        requireSuccess(mode, `Failed to check consumer secret permissions: ${name}`);
        if (compatibleRemoteStatField(mode.stdout, 1) !== "600") {
          throw new TransportError(`Consumer secret permissions are not 0600: ${name}`);
        }
      }
      const directoryMode = await this.run(["stat", "-c", "%a", "--", path], { signal });
      requireSuccess(directoryMode, "Failed to check consumer secret directory permissions");
      if (compatibleRemoteStatField(directoryMode.stdout, 1) !== "700") {
        throw new TransportError("Consumer secret copy directory permissions are not 0700");
      }
      this.#scopedSecretCopies.set(path, workspace);
      return Object.freeze({ workspace, path });
    } catch (cause) {
      await this.run(["rm", "-rf", "--", path]).catch(() => undefined);
      throw cause;
    }
  }

  async cleanupScopedSecretCopy(copy: ScopedSecretCopy): Promise<void> {
    this.#ensureOpen();
    const workspace = this.#registeredWorkspace(copy.workspace);
    const path = workspaceMember(workspace, copy.path, "consumer secret copy directory");
    if (this.#scopedSecretCopies.get(path) !== workspace) {
      throw new TransportError("Consumer secret copy is not registered in the current session");
    }
    requireSuccess(
      await this.run(["rm", "-rf", "--", path]),
      "Failed to clean up the consumer secret copy",
    );
    this.#scopedSecretCopies.delete(path);
  }

  async acquireOperationLock(
    request: RemoteOperationLockRequest,
    signal?: AbortSignal,
  ): Promise<RemoteOperationLease> {
    this.#ensureOpen();
    const app = lockComponent(request.app, "App");
    const target = lockComponent(request.target, "target");
    const timeoutMs = positiveTimeout(request.timeoutMs, "target operation lock");
    const leaseTtlMs = positiveTimeout(
      request.leaseTtlMs ?? DEFAULT_OPERATION_LEASE_TTL_MS,
      "target operation lock lease TTL",
    );
    const digest = await sha256Text(`${app}\0${target}`);
    const id = crypto.randomUUID().replaceAll("-", "");
    const lockPath = `/tmp/sfo-deploy-operation-${digest}.lock`;
    const readyPath = `/tmp/sfo-deploy-lock-ready-${id}`;
    const stopPath = `/tmp/sfo-deploy-lock-stop-${id}`;
    const leasePath = `/tmp/sfo-deploy-lock-lease-${id}`;
    const seconds = Math.max(0.001, timeoutMs / 1000).toFixed(3);
    const leaseTtlSeconds = Math.max(1, Math.ceil(leaseTtlMs / 1000)).toFixed(0);
    const heartbeatIntervalMs = Math.max(
      1_000,
      Math.min(DEFAULT_OPERATION_HEARTBEAT_INTERVAL_MS, Math.floor(leaseTtlMs / 4)),
    );
    const holderArgv = validateArgv([
      "flock",
      "--exclusive",
      "--wait",
      seconds,
      "--conflict-exit-code",
      "73",
      lockPath,
      "/usr/bin/sh",
      "-c",
      'umask 077; : > "$1"; : > "$2"; : > "$3"; while test -f "$2"; do lease_mtime=$(/usr/bin/stat -c %Y "$3" 2>/dev/null || echo 0); now=$(/usr/bin/date +%s); if test -z "$lease_mtime" || test "$lease_mtime" -eq 0 || test $((now - lease_mtime)) -ge "$4"; then exit 74; fi; /usr/bin/sleep 0.1; done',
      "sfo-lock-holder",
      readyPath,
      stopPath,
      leasePath,
      leaseTtlSeconds,
    ]);
    const rendered = `exec ${holderArgv.map(quotePosix).join(" ")}`;
    let child: SpawnedCommand;
    try {
      child = this.#options.commandFactory(
        this.#options.sshExecutable,
        [...this.#sshOptions(false), this.#sshDestination(), rendered],
      );
    } catch (cause) {
      throw new TransportError("Failed to start the target operation lock process", { cause });
    }
    const output = child.output();
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() <= deadline) {
        throwIfAborted(signal);
        const state = await Promise.race([
          output.then((value) => ({ kind: "exit" as const, value })),
          pollDelay(25).then(() => ({ kind: "poll" as const })),
        ]);
        if (state.kind === "exit") {
          if (state.value.code === 73) {
            throw new PreflightError("Target operation lock acquisition timed out");
          }
          throw new TransportError("Target operation lock holder exited early");
        }
        const ready = await this.#runRemote(["/usr/bin/test", "-f", readyPath], {
          signal,
          timeoutMs: Math.min(timeoutMs, this.#options.connectTimeoutMs),
        });
        if (ready.exitCode === 0) {
          const lease = Object.freeze({ id, app, target });
          const held: HeldOperationLease = {
            lease,
            child,
            output,
            readyPath,
            stopPath,
            leasePath,
            leaseTtlMs,
            heartbeatIntervalMs,
            heartbeatRunning: false,
            timer: undefined,
            lost: false,
            releasing: false,
          };
          this.#operationLeases.set(id, held);
          this.#watchOperationLease(held);
          held.timer = setInterval(() => {
            void this.#heartbeatOperationLease(held);
          }, heartbeatIntervalMs);
          return lease;
        }
        if (ready.exitCode !== 1) {
          throw new TransportError("Failed to check the target operation lock state");
        }
      }
      throw new PreflightError("Target operation lock acquisition timed out");
    } catch (cause) {
      await terminateAndReap(child, output, this.#options.terminateTimeoutMs);
      await this.#runRemote(["rm", "-f", "--", readyPath]).catch(() => undefined);
      await this.#runRemote(["rm", "-f", "--", stopPath]).catch(() => undefined);
      await this.#runRemote(["rm", "-f", "--", leasePath]).catch(() => undefined);
      throw cause;
    }
  }

  async #heartbeatOperationLease(held: HeldOperationLease): Promise<void> {
    if (held.heartbeatRunning || held.lost || !this.#operationLeases.has(held.lease.id)) return;
    held.heartbeatRunning = true;
    try {
      const result = await this.#runRemote(["/usr/bin/touch", "--", held.leasePath], {
        timeoutMs: Math.max(1_000, Math.min(held.leaseTtlMs / 4, 30_000)),
      });
      void result;
    } catch {
      // 心跳是软操作：瞬时失败不应终止 managed 步骤；holder 依赖 TTL 缓冲继续持锁。
    } finally {
      held.heartbeatRunning = false;
    }
  }

  async releaseOperationLock(lease: RemoteOperationLease): Promise<void> {
    const held = this.#operationLeases.get(lease.id);
    if (
      held === undefined || held.lease.app !== lease.app || held.lease.target !== lease.target
    ) {
      throw new TransportError(
        "Target operation lock lease is not registered in the current session",
      );
    }
    if (held.timer !== undefined) {
      clearInterval(held.timer);
      held.timer = undefined;
    }
    held.releasing = true;
    let notifyError: unknown;
    try {
      requireSuccess(
        await this.#runRemote(["rm", "-f", "--", held.stopPath]),
        "Failed to notify the target operation lock to release",
      );
    } catch (cause) {
      notifyError = cause;
    }
    const outcome = await Promise.race([
      held.output.then(
        (value) => ({ exited: true as const, code: value.code }),
        () => ({ exited: true as const, code: undefined }),
      ),
      pollDelay(this.#options.terminateTimeoutMs).then(() => ({
        exited: false as const,
        code: undefined,
      })),
    ]);
    let reclaimed = outcome.exited;
    if (!reclaimed) {
      await terminateAndReap(held.child, held.output, this.#options.terminateTimeoutMs);
      reclaimed = await Promise.race([
        held.output.then(() => true, () => true),
        pollDelay(this.#options.terminateTimeoutMs).then(() => false),
      ]);
    }
    if (!reclaimed) {
      // 未确认回收时保留跟踪，让 close 或后续 release 仍能兜底处理。
      throw this.#leaseLostReason ?? new TransportError(
        `Target operation lock ${held.lease.app}@${held.lease.target} could not be reclaimed before release`,
      );
    }
    this.#operationLeases.delete(lease.id);
    let cleanupError: unknown;
    try {
      requireSuccess(
        await this.#runRemote(["rm", "-f", "--", held.readyPath, held.stopPath, held.leasePath]),
        "Failed to clean up the target operation lock state",
      );
    } catch (cause) {
      cleanupError = cause;
    }
    const lost = held.lost || (outcome.exited && outcome.code !== 0);
    if (lost) {
      const reason = this.#leaseLostReason ?? new TransportError(
        `Target operation lock ${held.lease.app}@${held.lease.target} was lost before release` +
          (outcome.code === undefined ? "" : ` (holder exit code ${outcome.code})`),
      );
      if (this.#leaseLostReason === undefined) this.#leaseLostReason = reason;
      if (notifyError !== undefined || cleanupError !== undefined) {
        throw new AggregateError(
          [reason, notifyError, cleanupError].filter((error) => error !== undefined),
          "Target operation lock release failed",
        );
      }
      throw reason;
    }
    if (notifyError !== undefined) throw notifyError;
    if (cleanupError !== undefined) throw cleanupError;
  }

  async exposeStepSecrets(
    secretNames: readonly string[],
    rawDirectory: string,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.#ensureOpen();
    const directory = await this.#expandSecretDirectory(rawDirectory, signal);
    const privileged = await this.#secretCommandsPrivileged(directory, signal);
    const remoteWorkspace = this.#registeredWorkspace(workspace);
    const copyDirectory = `${remoteWorkspace}/secrets`;
    requireSuccess(
      await this.run(["mkdir", "-m", "0700", "--", copyDirectory], { signal }),
      `Failed to create the step secret copy directory ${copyDirectory}`,
    );
    const seen = new Set<string>();
    for (const rawName of secretNames) {
      if (typeof rawName !== "string" || !SECRET_NAME_RE.test(rawName)) {
        throw new PreflightError(`Invalid secret name: ${JSON.stringify(rawName)}`);
      }
      if (seen.has(rawName)) {
        throw new PreflightError(`Duplicate step secret declaration: ${rawName}`);
      }
      seen.add(rawName);
      const source = `${directory}/${rawName}`;
      const destination = `${copyDirectory}/${rawName}`;
      const exists = await this.run(["/usr/bin/test", "-f", source], {
        signal,
        privileged,
      });
      if (exists.exitCode === 1) {
        throw new PreflightError(`Secret is not deployed on this machine: ${rawName}`);
      }
      requireSuccess(exists, `Failed to check the secret source ${rawName}`);
      requireSuccess(
        await this.run(["install", "-m", "0600", "--", source, destination], {
          signal,
          privileged,
        }),
        `Failed to copy the step secret ${rawName}`,
      );
      if (privileged) {
        requireSuccess(
          await this.run(["chown", this.#options.user, "--", destination], {
            signal,
            privileged: true,
          }),
          `Failed to fix step secret ownership ${rawName}`,
        );
      }
      requireSuccess(
        await this.run(["chmod", "0600", "--", destination], { signal }),
        `Failed to fix step secret permissions ${rawName}`,
      );
    }
    return copyDirectory;
  }

  async preflightDeno(
    executable: string,
    signal?: AbortSignal,
    minimumMajor = 2,
  ): Promise<CommandResult> {
    if (!Number.isInteger(minimumMajor) || minimumMajor < 1) {
      throw new TransportError("Deno minimum major version must be a positive integer");
    }
    const checked = runtimeExecutable(executable);
    const result = await this.run([checked, "--version"], { signal });
    const version = `${result.stdout}\n${result.stderr}`.trim();
    const firstLine = version.split(/\r?\n/, 1)[0] ?? "";
    const match = /^deno (\d+)\.[0-9]+\.[0-9]+(?:[-+][^\s]+)?(?: \([^\r\n]+\))?$/.exec(firstLine);
    if (result.exitCode !== 0 || !match || Number(match[1]) < minimumMajor) {
      throw new PreflightError(
        `Remote Deno ${minimumMajor}+ runtime is unavailable ${
          JSON.stringify(executable)
        }: ${version}`,
      );
    }
    return result;
  }

  async preflightPrivilege(signal?: AbortSignal): Promise<void> {
    if (this.#privilegePrefix !== undefined) return;
    const identity = await this.run(["id", "-u"], { signal });
    if (identity.exitCode === 0 && identity.stdout.trim() === "0") {
      this.#privilegePrefix = Object.freeze([]);
      return;
    }
    const sudo = await this.run(["sudo", "-n", "--", "true"], { signal });
    if (sudo.exitCode !== 0) {
      throw new PreflightError(
        "Remote identity is neither root nor able to use non-interactive sudo",
      );
    }
    this.#privilegePrefix = Object.freeze(["sudo", "-n", "--"]);
  }

  async executeDeno(
    executable: string,
    script: string,
    options: {
      readonly workspace: string;
      readonly metadataPath: string;
      readonly secretDir?: string;
      readonly permissions: ScriptPermissions;
      readonly privileged?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<CommandResult> {
    const workspace = this.#registeredWorkspace(options.workspace);
    const remoteScript = workspaceMember(workspace, script, "Deno script");
    const metadata = workspaceMember(workspace, options.metadataPath, "step metadata");
    const secretCopy = options.secretDir === undefined
      ? undefined
      : workspaceMember(workspace, options.secretDir, "step secret copy directory");
    const run = permissionValues(options.permissions.run, "Deno run permission", true);
    const net = permissionValues(options.permissions.net, "Deno net permission", false);
    const read = filePermissionPaths(
      workspace,
      options.permissions.read ?? [],
      "Deno read permission",
    );
    const write = filePermissionPaths(
      workspace,
      options.permissions.write ?? [],
      "Deno write permission",
    );
    net.forEach(validateNetPermission);
    const executablePath = runtimeExecutable(executable);
    const argv = [
      executablePath,
      "run",
      "--no-prompt",
      "--no-config",
      "--no-remote",
      "--no-npm",
      "--deny-ffi",
      "--allow-env=DEPLOYMENT_METADATA_PATH,DEPLOYMENT_SECRETS_DIR,HOME",
      `--allow-read=${read.join(",")}`,
      `--allow-write=${write.join(",")}`,
      run.length > 0 ? `--allow-run=${run.join(",")}` : "--deny-run",
      net.length > 0 ? `--allow-net=${net.join(",")}` : "--deny-net",
      remoteScript,
    ];
    const environment: Record<string, string> = { DEPLOYMENT_METADATA_PATH: metadata };
    if (secretCopy !== undefined) environment.DEPLOYMENT_SECRETS_DIR = secretCopy;
    return await this.run(argv, {
      signal: options.signal,
      environment,
      cwd: workspace,
      privileged: options.privileged,
    });
  }

  async removeFile(path: string, signal?: AbortSignal): Promise<void> {
    const remote = workspaceMemberOfAny(this.#workspaces, path, "remote temporary file");
    requireSuccess(
      await this.run(["rm", "-f", "--", remote], { signal }),
      `Failed to clean up the remote file ${remote}`,
    );
  }

  async readEnvironmentVersion(
    resource: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    this.#ensureOpen();
    const name = environmentVersionsResource(resource);
    const home = await this.#homeDirectory(signal);
    const path = `${home}/.sfo-deploy/environments/${name}.version`;
    const exists = await this.run(["/usr/bin/test", "-f", path], { signal });
    if (exists.exitCode !== 0) {
      if (exists.exitCode === 1) return undefined;
      throw new TransportError(
        `Failed to check the environment app version marker ${path}: ${diagnostic(exists)}`,
      );
    }
    const content = await this.run(["/usr/bin/cat", "--", path], { signal });
    requireSuccess(content, `Failed to read the environment app version marker ${path}`);
    const version = content.stdout.trim();
    return version.length === 0 ? undefined : version;
  }

  async writeEnvironmentVersion(
    resource: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#ensureOpen();
    const name = environmentVersionsResource(resource);
    if (
      typeof version !== "string" || version.length === 0 || hasControl(version) ||
      /\s/.test(version) || version !== version.trim()
    ) {
      throw new TransportError("Invalid environment app version value");
    }
    const home = await this.#homeDirectory(signal);
    const directory = `${home}/.sfo-deploy/environments`;
    const path = `${directory}/${name}.version`;
    requireSuccess(
      await this.run(["mkdir", "-p", "--", directory], { signal }),
      `Failed to create the environment app version marker directory ${directory}`,
    );
    const temporary = await Deno.makeTempFile({ prefix: "sfo-env-version-" });
    try {
      await Deno.writeTextFile(temporary, `${version}\n`, { mode: 0o600 });
      await this.uploadFile(temporary, path, { signal, mode: 0o600 });
    } finally {
      try {
        await Deno.remove(temporary);
      } catch {
        // 临时文件清理失败不影响版本标记写入结果。
      }
    }
  }

  async removeTree(path: string, signal?: AbortSignal): Promise<void> {
    await this.cleanupWorkspace(path, signal);
  }

  preserveWorkspace(path: string): void {
    this.#ensureOpen();
    const workspace = this.#registeredWorkspace(path);
    this.#workspaces.delete(workspace);
    for (const [copy, owner] of this.#scopedSecretCopies) {
      if (owner === workspace) this.#scopedSecretCopies.delete(copy);
    }
  }

  async cleanupWorkspace(path: string, signal?: AbortSignal): Promise<void> {
    const workspace = this.#registeredWorkspace(path);
    const result = await this.#runRemote(["rm", "-rf", "--", workspace], { signal });
    requireSuccess(result, `Failed to clean up the remote workspace ${workspace}`);
    for (const [copy, owner] of this.#scopedSecretCopies) {
      if (owner === workspace) this.#scopedSecretCopies.delete(copy);
    }
    this.#workspaces.delete(workspace);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const errors: string[] = [];
    for (const held of [...this.#operationLeases.values()]) {
      try {
        await this.releaseOperationLock(held.lease);
      } catch (cause) {
        errors.push(errorText(cause));
      }
    }
    for (const workspace of [...this.#workspaces]) {
      try {
        await this.cleanupWorkspace(workspace);
      } catch (cause) {
        errors.push(errorText(cause));
      }
    }
    this.#closed = true;
    if (this.#options.controlPath && this.#options.controlDirectory) {
      let controlExited = true;
      try {
        await Deno.lstat(this.#options.controlPath);
        const result = await this.#runLocal(
          this.#options.sshExecutable,
          [...this.#sshOptions(false), "-O", "exit", this.#sshDestination()],
          undefined,
          this.#options.connectTimeoutMs,
          "SSH control connection exit",
        );
        if (result.exitCode !== 0) {
          const check = await this.#runLocal(
            this.#options.sshExecutable,
            [...this.#sshOptions(false), "-O", "check", this.#sshDestination()],
            undefined,
            this.#options.connectTimeoutMs,
            "SSH control connection check",
          );
          if (check.exitCode === 0) {
            throw new TransportError(
              `Failed to close SSH control connection: ${diagnostic(result)}`,
            );
          }
        }
      } catch (cause) {
        if (!(cause instanceof Deno.errors.NotFound)) {
          controlExited = false;
          errors.push(errorText(cause));
        }
      }
      if (controlExited) {
        try {
          await Deno.remove(this.#options.controlDirectory, { recursive: true });
        } catch (cause) {
          errors.push(errorText(cause));
        }
      }
    }
    if (errors.length > 0) {
      throw new TransportError(`SSH session cleanup failed: ${errors.join("; ")}`);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #homeDirectory(signal?: AbortSignal): Promise<string> {
    if (this.#home !== undefined) return this.#home;
    const result = await this.run(
      ["/usr/bin/sh", "-c", 'printf "%s" "$HOME"'],
      { signal },
    );
    const home = result.stdout.trim();
    if (result.exitCode !== 0 || home.length === 0 || home === "/" || !home.startsWith("/")) {
      throw new TransportError(
        `Failed to determine the remote user home directory: ${result.stdout}${result.stderr}`,
      );
    }
    this.#home = home;
    return home;
  }

  #sshOptions(scp: boolean): string[] {
    const timeoutSeconds = Math.max(1, Math.ceil(this.#options.connectTimeoutMs / 1000));
    const result = [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${this.#options.knownHosts}`,
      "-o",
      `ConnectTimeout=${timeoutSeconds}`,
      scp ? "-P" : "-p",
      String(this.#options.port),
    ];
    if (this.#options.controlPath) {
      result.push(
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
        "-o",
        `ControlPath=${this.#options.controlPath}`,
      );
    }
    if (this.#options.privateKey) {
      result.push("-o", "IdentitiesOnly=yes", "-i", this.#options.privateKey);
    }
    if (!scp) result.push("-T");
    return result;
  }

  #sshDestination(): string {
    return `${this.#options.user}@${this.#options.address}`;
  }

  #scpDestination(path: string): string {
    const host = this.#options.address.includes(":")
      ? `[${this.#options.address}]`
      : this.#options.address;
    return `${this.#options.user}@${host}:${path}`;
  }

  async #runLocal(
    executable: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
    label: string,
  ): Promise<CommandResult> {
    throwIfAborted(signal);
    let child: SpawnedCommand;
    try {
      child = this.#options.commandFactory(executable, args);
    } catch (cause) {
      throw new TransportError(`Failed to start the ${label} process`, { cause });
    }
    const outputPromise = child.output();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new TransportError(`${label} timed out`)),
        positiveTimeout(timeoutMs, label),
      );
    });
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
        abortHandler = () => reject(new CancelledError(`${label} was cancelled`));
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      })
      : new Promise<never>(() => undefined);
    try {
      const output = await Promise.race([outputPromise, timeout, aborted]);
      if (signal?.aborted) throw new CancelledError(`${label} was cancelled`);
      return commandResult(
        output.code,
        new TextDecoder().decode(output.stdout),
        new TextDecoder().decode(output.stderr),
      );
    } catch (cause) {
      await terminateAndReap(child, outputPromise, this.#options.terminateTimeoutMs);
      if (cause instanceof CancelledError || cause instanceof TransportError) throw cause;
      throw new TransportError(`${label} process failed`, { cause });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    }
  }

  #registeredWorkspace(path: string): string {
    const workspace = safeRemotePath(path);
    if (!workspace.startsWith(WORKSPACE_PREFIX) || !this.#workspaces.has(workspace)) {
      throw new TransportError(
        `Remote workspace is not registered in the current session: ${workspace}`,
      );
    }
    return workspace;
  }

  #ensureOpen(): void {
    if (this.#closed) throw new TransportError("SSH session is already closed");
  }

  #ensureLeaseUsable(): void {
    if (this.#leaseLostReason !== undefined) throw this.#leaseLostReason;
  }

  /** 合并调用方信号与会话失锁信号；仅用于 run/uploadFile 等受保护写入口。 */
  #protectedSignal(signal?: AbortSignal): AbortSignal {
    if (signal === undefined || this.#leaseAbort.signal.aborted) return this.#leaseAbort.signal;
    return AbortSignal.any([signal, this.#leaseAbort.signal]);
  }

  #watchOperationLease(held: HeldOperationLease): void {
    held.output.then(
      (value) => this.#onOperationLeaseExit(held, value.code),
      () => this.#onOperationLeaseExit(held, undefined),
    );
  }

  #onOperationLeaseExit(held: HeldOperationLease, code: number | undefined): void {
    if (held.releasing || !this.#operationLeases.has(held.lease.id) || held.lost) return;
    held.lost = true;
    if (held.timer !== undefined) {
      clearInterval(held.timer);
      held.timer = undefined;
    }
    const detail = code === 74
      ? "lease expired before the operation finished"
      : `holder exited unexpectedly (code ${code ?? "unknown"})`;
    const reason = new TransportError(
      `Target operation lock ${held.lease.app}@${held.lease.target} was lost: ${detail}`,
    );
    if (this.#leaseLostReason === undefined) this.#leaseLostReason = reason;
    if (!this.#leaseAbort.signal.aborted) this.#leaseAbort.abort(reason);
  }
}

async function terminateAndReap(
  child: SpawnedCommand,
  output: Promise<Deno.CommandOutput>,
  terminateTimeoutMs: number,
): Promise<void> {
  const descendants = trackDescendants(child);
  signalProcessTree(child, descendants, "SIGTERM");
  await Promise.race([
    output.then(() => undefined, () => undefined),
    pollDelay(terminateTimeoutMs),
  ]);
  signalProcessTree(child, trackDescendants(child, descendants), "SIGKILL");
  await Promise.race([
    output.then(() => undefined, () => undefined),
    pollDelay(terminateTimeoutMs),
  ]);
}

/** 采集被跟踪进程的后代 pid；无 pid 的测试替身返回既有集合。 */
function trackDescendants(child: SpawnedCommand, existing: readonly number[] = []): number[] {
  const tracked = new Set<number>(existing);
  if (typeof child.pid === "number" && Number.isInteger(child.pid) && child.pid > 0) {
    for (const pid of descendantPids(child.pid)) tracked.add(pid);
  }
  return [...tracked];
}

function signalProcessTree(
  child: SpawnedCommand,
  descendants: readonly number[],
  signo: Deno.Signal,
): void {
  try {
    child.kill(signo);
  } catch {
    // 进程可能已在竞态中退出；仍需等待 output 以回收。
  }
  for (const pid of descendants) {
    try {
      Deno.kill(pid, signo);
    } catch {
      // 后代可能已退出或不允许操作；终止为 best-effort。
    }
  }
}

/** 枚举 rootPid 的全部后代；无 /proc 且 ps 不可用时返回空数组。 */
function descendantPids(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  if (!readProcessChildren(children) && !readProcessChildrenViaPs(children)) return [];
  const result: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}

function readProcessChildren(children: Map<number, number[]>): boolean {
  try {
    for (const entry of Deno.readDirSync("/proc")) {
      if (!entry.isDirectory || !/^\d+$/.test(entry.name)) continue;
      const stat = Deno.readTextFileSync(`/proc/${entry.name}/stat`);
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const fields = stat.slice(close + 2).split(" ");
      const ppid = Number(fields[1]);
      if (!Number.isInteger(ppid)) continue;
      const pid = Number(entry.name);
      const list = children.get(ppid);
      if (list === undefined) children.set(ppid, [pid]);
      else list.push(pid);
    }
    return true;
  } catch {
    return false;
  }
}

function readProcessChildrenViaPs(children: Map<number, number[]>): boolean {
  try {
    const output = new Deno.Command("ps", {
      args: ["-A", "-o", "pid=,ppid="],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!output.success) return false;
    for (const line of new TextDecoder().decode(output.stdout).split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (match === null) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const list = children.get(ppid);
      if (list === undefined) children.set(ppid, [pid]);
      else list.push(pid);
    }
    return true;
  } catch {
    return false;
  }
}

export function quotePosix(value: string): string {
  if (typeof value !== "string" || hasControl(value)) {
    throw new TransportError(`Invalid remote shell argument: ${JSON.stringify(value)}`);
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function validateArgv(argv: readonly string[]): readonly string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TransportError("Remote command must not be empty");
  }
  const result = argv.map((value) => {
    if (typeof value !== "string" || value.length === 0 || hasControl(value)) {
      throw new TransportError(`Invalid remote command argument: ${JSON.stringify(value)}`);
    }
    return value;
  });
  return Object.freeze(result);
}

function environmentAssignments(
  environment: Readonly<Record<string, string>>,
  first: readonly string[] = [],
): readonly string[] {
  const priority = new Map(first.map((name, index) => [name, index]));
  const entries = Object.entries(environment);
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name) || typeof value !== "string" || hasControl(value)) {
      throw new TransportError(
        `Invalid remote command environment variable: ${JSON.stringify(name)}`,
      );
    }
  }
  entries.sort(([left], [right]) => {
    const leftPriority = priority.get(left);
    const rightPriority = priority.get(right);
    if (leftPriority !== undefined || rightPriority !== undefined) {
      return (leftPriority ?? Number.MAX_SAFE_INTEGER) -
        (rightPriority ?? Number.MAX_SAFE_INTEGER);
    }
    return left.localeCompare(right);
  });
  return Object.freeze(entries.map(([name, value]) => `${name}=${value}`));
}

function compatibleRemoteStatField(output: string, index: number): string {
  const text = output.trim();
  const fields = text.split("\t");
  return fields.length > index ? fields[index] : text;
}

function assertFrameworkUpdater(workspace: string, path: string): void {
  const relative = path.slice(`${workspace}/`.length);
  const escaped = REMOTE_CONFIG_UPDATER_BUNDLE_PATH.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^deployment-[0-9a-f]{64}/scripts/${escaped}$`, "u").test(relative)) {
    throw new PreflightError(
      "Framework config updater must come from a reserved member of the verified deployment bundle",
    );
  }
}

function validateSecretNames(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) {
    throw new PreflightError(`${label} secret declarations must be a list`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !SECRET_NAME_RE.test(value)) {
      throw new PreflightError(`Invalid ${label} secret name`);
    }
    if (seen.has(value)) {
      throw new PreflightError(`Duplicate ${label} secret declaration: ${value}`);
    }
    seen.add(value);
    result.push(value);
  }
  return Object.freeze(result);
}

function lockComponent(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 128 ||
    !/^[A-Za-z0-9_@%+=,:.-]+$/u.test(value)
  ) {
    throw new PreflightError(`Invalid ${label} lock key`);
  }
  return value;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pollDelay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function environmentVersionsResource(value: string): string {
  if (typeof value !== "string" || !ENVIRONMENT_RESOURCE_RE.test(value)) {
    throw new TransportError(`Invalid environment app name: ${JSON.stringify(value)}`);
  }
  return value;
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

function safeRemotePath(value: string): string {
  if (
    typeof value !== "string" || !SAFE_REMOTE_PATH_RE.test(value) || value === "/" ||
    value.startsWith("//") || posix.normalize(value) !== value || value.split("/").includes("..")
  ) {
    throw new TransportError(`Unsafe remote path: ${JSON.stringify(value)}`);
  }
  return value;
}

function workspaceMember(workspace: string, rawPath: string, label: string): string {
  const path = safeRemotePath(rawPath);
  if (!path.startsWith(`${workspace}/`)) {
    throw new TransportError(`${label} must be inside the current step workspace: ${path}`);
  }
  return path;
}

function workspaceMemberOfAny(
  workspaces: ReadonlySet<string>,
  rawPath: string,
  label: string,
): string {
  const path = safeRemotePath(rawPath);
  if (![...workspaces].some((workspace) => path.startsWith(`${workspace}/`))) {
    throw new TransportError(`${label} must be inside the current session workspace: ${path}`);
  }
  return path;
}

function runtimeExecutable(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value ||
    value.includes(",") || value.includes("\\") || hasControl(value) || /\s/.test(value)
  ) {
    throw new TransportError(`Invalid script runtime command: ${JSON.stringify(value)}`);
  }
  if (!value.includes("/")) {
    if (!COMMAND_RE.test(value) || value === "." || value === "..") {
      throw new TransportError(
        `Invalid script runtime bare command name: ${JSON.stringify(value)}`,
      );
    }
    return value;
  }
  return safeRemotePath(value);
}

function safeConfigName(value: string): string {
  if (typeof value !== "string" || !ENVIRONMENT_RESOURCE_RE.test(value)) {
    throw new TransportError(`Invalid config name: ${JSON.stringify(value)}`);
  }
  return value;
}

function userOrGroup(value: string, label: string): string {
  if (typeof value !== "string" || !USER_RE.test(value)) {
    throw new TransportError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function permissionPath(value: string): string {
  const path = safeRemotePath(value);
  if (path.includes(",")) throw new TransportError("Deno permission paths must not contain commas");
  return path;
}

function permissionValues(
  values: readonly string[],
  label: string,
  absolute: boolean,
): readonly string[] {
  if (!Array.isArray(values)) throw new TransportError(`${label} must be a sequence of strings`);
  const result: string[] = [];
  for (const value of values) {
    if (
      typeof value !== "string" || value.length === 0 || value.trim() !== value ||
      value.includes(",") || /\s/.test(value) || hasControl(value)
    ) {
      throw new TransportError(`Invalid ${label} value: ${JSON.stringify(value)}`);
    }
    if (absolute) safeRemotePath(value);
    if (result.includes(value)) {
      throw new TransportError(`${label} contains a duplicate value: ${value}`);
    }
    result.push(value);
  }
  return Object.freeze(result);
}

function filePermissionPaths(
  workspace: string,
  values: readonly string[],
  label: string,
): readonly string[] {
  const userPaths = permissionValues(values, label, true);
  return Object.freeze([...new Set([safeRemotePath(workspace), ...userPaths])]);
}

function validateNetPermission(value: string): void {
  if (["//", "@", "/", "*", "?", "#", "\\"].some((marker) => value.includes(marker))) {
    throw new TransportError(
      `Deno net permission is not a valid host or IP: ${JSON.stringify(value)}`,
    );
  }
  let port: string | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:]+)\](?::([0-9]+))?$/.exec(value);
    if (!match || !match[1].includes(":")) {
      throw new TransportError(`Invalid Deno net permission IPv6 format: ${JSON.stringify(value)}`);
    }
    port = match[2];
  } else if ((value.match(/:/g) ?? []).length > 1) {
    if (!/^[0-9A-Fa-f:]+$/.test(value)) {
      throw new TransportError(
        `Invalid Deno net permission IPv6 address: ${JSON.stringify(value)}`,
      );
    }
  } else {
    const match = /^([A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(value);
    if (!match) {
      throw new TransportError(`Invalid Deno net permission host format: ${JSON.stringify(value)}`);
    }
    port = match[2];
  }
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    throw new TransportError(`Invalid Deno net permission port: ${JSON.stringify(value)}`);
  }
}

function fileMode(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new TransportError(`Invalid remote file mode: ${JSON.stringify(value)}`);
  }
  return value;
}

function secretFingerprintPath(target: string): string {
  const safe = safeRemotePath(target);
  return `${posix.dirname(safe)}/.${posix.basename(safe)}.sfo-secret-hashes.json`;
}

function localExecutable(value: string, label: string): string {
  if (COMMAND_RE.test(value)) return value;
  if (value.startsWith("/") && !value.includes("\\") && !hasControl(value) && !/\s/.test(value)) {
    return value;
  }
  throw new TypeError(`Invalid executable file name for ${label}`);
}

function sshUser(value: string): string {
  if (!USER_RE.test(value)) {
    throw new PreflightError(`Invalid SSH user name: ${JSON.stringify(value)}`);
  }
  return value;
}

function sshAddress(value: string): string {
  if (!ADDRESS_RE.test(value) || value.startsWith("-") || hasControl(value)) {
    throw new PreflightError(`Invalid SSH address: ${JSON.stringify(value)}`);
  }
  return value;
}

function sshPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new PreflightError(`Invalid SSH port: ${value}`);
  }
  return value;
}

async function regularLocalFile(rawPath: string, label: string): Promise<string> {
  try {
    const path = await Deno.realPath(resolve(rawPath));
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) {
      throw new PreflightError(`${label} is not a regular file: ${path}`);
    }
    return path;
  } catch (cause) {
    if (cause instanceof PreflightError) throw cause;
    throw new PreflightError(`${label} does not exist or is not accessible`, { cause });
  }
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} timeout must be a positive number`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError("Deployment cancelled");
}

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.exitCode !== 0) throw new TransportError(`${operation}: ${diagnostic(result)}`);
}

function diagnostic(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit=${result.exitCode}`;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function freezeStringArray(values: Iterable<string>): readonly string[] {
  return Object.freeze([...values]);
}

function freezeSecretResults(values: DeploySecretResult[]): readonly DeploySecretResult[] {
  return Object.freeze([...values]);
}

export const SSHTransport = OpenSshTransport;
