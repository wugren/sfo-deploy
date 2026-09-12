import { type CommandResult, commandResult } from "../../src/results.ts";
import type {
  DeploySecretResult,
  RemoteRunOptions,
  RemoteSecretState,
  RemoteSecretUpload,
  RemoteSession,
  Transport,
} from "../../src/transport.ts";
import type { ResolvedMachine, ScriptPermissions } from "../../src/types.ts";

export interface FakeRunCall {
  readonly argv: readonly string[];
  readonly options: RemoteRunOptions;
}

/** 记录 run 调用并按固定脚本模拟远端行为的测试替身。 */
export class FakeSession implements RemoteSession {
  readonly calls: FakeRunCall[] = [];
  readonly pmCalls: FakeRunCall[] = [];
  readonly uploads: string[] = [];
  readonly removedSecrets: string[] = [];
  versionCalls = 0;
  installCalls = 0;
  checksumExitCode = 0;
  downloadedVersion = "2.7.8";
  checksumChecked = false;
  installSkipped = false;
  closed = false;
  tools: string[];
  checkState: RemoteSecretState = Object.freeze({
    dirMode: "700",
    entries: Object.freeze([] as string[]),
    manifest: Object.freeze([]),
    sha256: Object.freeze({}),
  });

  constructor(
    readonly probeExitCode = 127,
    readonly probeVersion = "",
    readonly installExitCode = 0,
    readonly verifyExitCode = 0,
    readonly verifyVersion = "deno 2.2.11\n",
    readonly home = "/home/deploy",
    tools: readonly string[] = ["curl", "wget", "unzip", "7z"],
    readonly packageManager = "/usr/bin/apt-get",
    readonly packageUpdateExitCode = 0,
    readonly packageInstallExitCode = 0,
    readonly installFixesTools = true,
    readonly privilegedError?: Error,
    readonly environmentDpkgQueryExitCode = 0,
    readonly environmentRpmExitCode = 0,
    readonly environmentServiceActive = true,
    readonly environmentServiceEnabled = true,
    readonly environmentServiceActionExitCode = 0,
  ) {
    this.tools = [...tools];
  }

  run(
    argv: readonly string[],
    options: RemoteRunOptions = {},
  ): Promise<CommandResult> {
    if (options.privileged && this.privilegedError !== undefined) {
      return Promise.reject(this.privilegedError);
    }
    this.calls.push({ argv: [...argv], options });
    const joined = argv.join(" ");
    if (argv[0] === "/bin/sh" && argv[1] === "-c") {
      const script = String(argv[2] ?? "");
      if (script.includes("$HOME")) {
        return Promise.resolve(commandResult(0, `${this.home}\n`));
      }
      if (script.includes("github.com/denoland/deno/releases/")) {
        this.installCalls++;
        this.checksumChecked = script.includes("sha256sum -c");
        if (this.checksumExitCode !== 0) {
          return Promise.resolve(commandResult(
            this.checksumExitCode,
            "",
            "fake checksum failed",
          ));
        }
        const requested = /requested_version='([^']*)'/.exec(script)?.[1] ?? "";
        const existing = /existing_version='([^']*)'/.exec(script)?.[1] ?? "";
        this.installSkipped = requested === "" && existing !== "" &&
          existing === this.downloadedVersion;
        return Promise.resolve(commandResult(
          this.installExitCode,
          this.installSkipped ? `sfo-deno-present:${this.downloadedVersion}\n` : "",
          this.installExitCode === 0 ? "" : "fake install failed",
        ));
      }
      if (script.includes("for tool in curl wget unzip 7z")) {
        return Promise.resolve(commandResult(0, `${this.tools.join("\n")}\n`));
      }
      if (script.includes("for path in /usr/bin/apt-get")) {
        if (this.packageManager.length === 0) return Promise.resolve(commandResult(1));
        return Promise.resolve(commandResult(0, `${this.packageManager}\n`));
      }
      if (script.includes("for path in /usr/bin/systemctl")) {
        return Promise.resolve(commandResult(0, "/usr/bin/systemctl\n"));
      }
      if (script.includes("for path in /usr/bin/service")) {
        return Promise.resolve(commandResult(0, "/usr/sbin/service\n"));
      }
      if (script.includes("for path in /usr/sbin/chkconfig")) {
        return Promise.resolve(commandResult(0, "/usr/sbin/chkconfig\n"));
      }
    }
    const binary = String(argv[0]).split("/").pop() ?? "";
    const packageManagers = ["apt-get", "apk", "dnf", "yum"];
    if (packageManagers.includes(binary) && argv[0] === this.packageManager) {
      if (argv[1] === "update") {
        this.pmCalls.push({ argv: [...argv], options });
        return Promise.resolve(commandResult(
          this.packageUpdateExitCode,
          "",
          this.packageUpdateExitCode === 0 ? "" : "fake apt update failed",
        ));
      }
      if (argv[1] === "install" || argv[1] === "add") {
        this.pmCalls.push({ argv: [...argv], options });
        if (this.packageInstallExitCode !== 0) {
          return Promise.resolve(commandResult(
            this.packageInstallExitCode,
            "",
            "fake package install failed",
          ));
        }
        if (this.installFixesTools) {
          const packages = argv.slice(2).filter((arg) => arg === "curl" || arg === "unzip");
          this.tools = [...new Set([...this.tools, ...packages])];
        }
        return Promise.resolve(commandResult(0));
      }
    }
    if (argv[0] === "/usr/bin/dpkg-query") {
      const packages = argv.slice(argv.indexOf("--") + 1);
      const missing = this.environmentDpkgQueryExitCode === 1
        ? packages.map((item, index) => `rc\t${item}\tnot-installed\t${index}`)
        : packages.map((item) => `ii\t${item}`);
      return Promise.resolve(commandResult(
        this.environmentDpkgQueryExitCode,
        missing.join("\n"),
      ));
    }
    if (argv[0] === "/usr/bin/rpm") {
      return Promise.resolve(commandResult(this.environmentRpmExitCode, ""));
    }
    if (argv[0] === "/usr/bin/systemctl" || argv[0] === "/bin/systemctl") {
      if (argv[1] === "is-active") {
        return Promise.resolve(commandResult(this.environmentServiceActive ? 0 : 3));
      }
      if (argv[1] === "is-enabled") {
        return Promise.resolve(commandResult(this.environmentServiceEnabled ? 0 : 1));
      }
      return Promise.resolve(commandResult(this.environmentServiceActionExitCode));
    }
    if (argv[0] === "service") {
      if (argv[2] === "status") {
        return Promise.resolve(commandResult(this.environmentServiceActive ? 0 : 3));
      }
      return Promise.resolve(commandResult(this.environmentServiceActionExitCode));
    }
    if (argv[0] === "/usr/sbin/chkconfig") {
      return Promise.resolve(commandResult(this.environmentServiceActionExitCode));
    }
    if (joined.includes("--version")) {
      this.versionCalls++;
      if (this.versionCalls === 1) {
        return Promise.resolve(commandResult(this.probeExitCode, this.probeVersion));
      }
      return Promise.resolve(commandResult(this.verifyExitCode, this.verifyVersion));
    }
    return Promise.resolve(commandResult(0));
  }

  createWorkspace(): Promise<string> {
    return Promise.resolve("/tmp/sfo-deploy-fake");
  }

  upload(_local: string, _remote: string): Promise<void> {
    return Promise.resolve();
  }

  uploadFile(local: string, remote: string): Promise<void> {
    this.uploads.push(`${local} -> ${remote}`);
    return Promise.resolve();
  }

  deploySecrets(
    files: readonly RemoteSecretUpload[],
    _directory: string,
  ): Promise<readonly DeploySecretResult[]> {
    return Promise.resolve(
      files.map((file) =>
        Object.freeze({
          name: file.name,
          kind: file.kind,
          sha256: file.sha256,
          status: "written" as const,
        })
      ),
    );
  }

  removeSecret(name: string): Promise<void> {
    this.removedSecrets.push(name);
    return Promise.resolve();
  }

  checkSecrets(): Promise<RemoteSecretState> {
    return Promise.resolve(this.checkState);
  }

  exposeStepSecrets(
    _secretNames: readonly string[],
    _directory: string,
    workspace: string,
  ): Promise<string> {
    return Promise.resolve(`${workspace}/secrets`);
  }

  preflightPython(): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }

  preflightDeno(): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }

  preflightPrivilege(): Promise<void> {
    return Promise.resolve();
  }

  executePython(): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }

  executeDeno(
    _executable: string,
    _script: string,
    _options: {
      readonly workspace: string;
      readonly metadataPath: string;
      readonly secretDir?: string;
      readonly permissions: ScriptPermissions;
      readonly privileged?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }

  readEnvironmentVersion(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  writeEnvironmentVersion(): Promise<void> {
    return Promise.resolve();
  }

  removeFile(): Promise<void> {
    return Promise.resolve();
  }

  removeTree(): Promise<void> {
    return Promise.resolve();
  }

  cleanupWorkspace(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

export class FakeTransport implements Transport {
  readonly sessions: FakeSession[] = [];
  connectCalls = 0;

  constructor(
    readonly sessionFactory: (index: number) => FakeSession = () => new FakeSession(),
    readonly connectError?: Error,
  ) {}

  connect(_target: ResolvedMachine): Promise<FakeSession> {
    this.connectCalls++;
    if (this.connectError !== undefined) throw this.connectError;
    const session = this.sessionFactory(this.sessions.length);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}
