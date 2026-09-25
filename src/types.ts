/** sfo-deploy 的 Deno/TypeScript 领域值类型。 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ResourceKind = "environment" | "app";
export type AddressKind = "private" | "public";
export type ScriptRuntimeKind = "deno";
export type PlanAction =
  | "check"
  | "install"
  | "configure"
  | "deploy"
  | "start"
  | "stop"
  | "restart"
  | "stage"
  | "activate"
  | "before-start"
  | "after-start"
  | "enable";

export interface PackageSpec {
  readonly provider: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly hashAlgorithm: string;
  readonly hashValue: string;
}

export type SecretKind = "value" | "file";

/** 集群声明中归一的密钥放置：按名称→目标机器列表（通配符在装载时展开）。 */
export interface SecretDeclaration {
  readonly name: string;
  readonly kind: SecretKind;
  /** value 秘密的注入类型；file 秘密固定注入路径字符串。 */
  readonly valueType: ManagedConfigValueType;
  readonly machines: readonly string[];
}

export interface ConfigTemplate {
  readonly relativePath: string;
  readonly source: string;
}

export interface ScriptPermissions {
  readonly run: readonly string[];
  readonly net: readonly string[];
  /** Deno --allow-read 扩展路径；空数组保持默认 workspace。 */
  readonly read?: readonly string[];
  /** Deno --allow-write 扩展路径；空数组保持默认 workspace。 */
  readonly write?: readonly string[];
}

export interface ScriptRuntime {
  readonly kind: ScriptRuntimeKind;
  readonly executable: string;
}

export interface ScriptInvocation {
  readonly source: string;
  /** app.yaml 中声明的原始相对路径；重打包时按此写入安装包。 */
  readonly relativePath: string;
  readonly permissions: ScriptPermissions;
}

export interface ScriptDefinition {
  readonly actions: ReadonlyMap<string, readonly ScriptInvocation[]>;
}

/** App managed file config 支持的结构化格式和 Nginx 原生纯文本格式。 */
export type ManagedConfigFormat = "yaml" | "json" | "toml" | "ini" | "nginx";
/** 内部受管文件格式；systemd 只由框架生成的 service unit 候选使用。 */
export type ManagedFileFormat = ManagedConfigFormat | "systemd";
export type ManagedConfigChangeAction = "none" | "reload" | "restart";
export type ManagedConfigValueType = "string" | "integer" | "number" | "boolean";
export type ManagedConfigPathSegment = string | number;

/** 受管 config target 的变量根；absolute 是无变量旧绝对路径。 */
export type ManagedConfigTargetRoot = "absolute" | "install" | "current" | "latest";

/** YAML/JSON/TOML 使用的无歧义字段路径。 */
export interface ManagedConfigPathSelector {
  readonly kind: "path";
  readonly path: readonly ManagedConfigPathSegment[];
}

/** INI 使用 section/key 定位完整值。 */
export interface ManagedConfigIniSelector {
  readonly kind: "ini";
  readonly section: string;
  readonly key: string;
}

export type ManagedConfigSelector =
  | ManagedConfigPathSelector
  | ManagedConfigIniSelector;

/** 控制端模板中一个非秘密占位符到步骤参数路径的绑定。 */
export interface ManagedConfigVariableBinding {
  readonly name: string;
  readonly parameterPath: readonly ManagedConfigPathSegment[];
  readonly valueType: ManagedConfigValueType;
}

/** 装载期解析到的集群秘密引用；这是计划内部形状，不是用户绑定声明。 */
export interface ManagedSecretReference {
  readonly kind: SecretKind;
  readonly valueType: ManagedConfigValueType;
}

/** 配置实际引用机器的最小地址快照；不包含 SSH 凭据。 */
export interface ManagedMachineReference {
  readonly region: string;
  readonly privateIp: readonly string[];
  readonly publicIp: readonly string[];
}

/** 候选配置发布前运行的固定 argv 校验；`{candidate}` 必须是独立参数。 */
export interface ManagedConfigValidator {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface ManagedConfigFile {
  readonly name: string;
  /** app 目录内的原始相对路径和已解析真实路径。 */
  readonly relativePath: string;
  readonly source: string;
  readonly target: string;
  /** target 中目录变量的语义；absolute 表示无变量绝对路径。 */
  readonly targetRoot: ManagedConfigTargetRoot;
  readonly owner?: string;
  readonly group?: string;
  readonly mode: number;
  readonly variables: readonly ManagedConfigVariableBinding[];
  readonly format: ManagedFileFormat;
  /** 源配置解析后发现的 `${SECRET_NAME}` 引用；App 配置引用即授权。 */
  readonly secretReferences: ReadonlyMap<string, ManagedSecretReference>;
  /** 源配置中被引用机器的地址快照；旧配置或归档可省略。 */
  readonly machineReferences?: ReadonlyMap<string, ManagedMachineReference>;
  readonly validator?: ManagedConfigValidator;
  readonly onChange: ManagedConfigChangeAction;
}

export type SystemdDeployAction = "none" | "start" | "reload" | "restart";

/** systemd 支持的 Restart 策略；配置装载期已收敛为白名单值。 */
export type SystemdRestartPolicy =
  | "no"
  | "on-success"
  | "on-failure"
  | "on-abnormal"
  | "on-watchdog"
  | "on-abort"
  | "always";

/** v4 内置发布方式；首版只支持版本目录发布。 */
export type DeploymentKind = "versioned";

export interface DeploymentDefinition {
  readonly kind: DeploymentKind;
}

/** v4 service.unit_config；装载期已把相对 working_directory/command 解析为绝对路径。 */
export interface SystemdUnitConfig {
  readonly target: string;
  readonly workingDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
  /** 生成 unit 的 User=；缺省使用机器 SSH 登录用户，允许规范账号名 root。 */
  readonly user?: string;
  readonly restartPolicy?: SystemdRestartPolicy;
  readonly restartSec?: number;
  readonly startLimitIntervalSec?: number;
  readonly startLimitBurst?: number;
}

/** App management.kind: service 的归一声明；unit 来自 YAML 的 name。 */
export interface AppServiceManagement {
  readonly kind: "service";
  readonly unit: string;
  /** auto 探测 systemctl/service；显式工具不回退。 */
  readonly tool: "auto" | "systemctl" | "service";
  /** 缺省 true：系统服务默认开机启动；显式 false 关闭。 */
  readonly enabled?: boolean;
  /** enabled 是否由配置显式声明；缺省 enable 不覆盖部署动作。 */
  readonly enabledExplicit?: boolean;
  readonly daemonReload: boolean;
  readonly onDeploy: SystemdDeployAction;
  readonly timeoutMs: number;
  readonly unitConfig?: SystemdUnitConfig;
}

export type EnvironmentInstallKind = "package" | "script";
export type EnvironmentPackageManagerKind = "auto" | "apt-get" | "yum";
export type EnvironmentServiceManagerKind = "system" | "script";
export type EnvironmentServiceTool = "auto" | "systemctl" | "service";

export interface EnvironmentPackageInstall {
  readonly kind: "package";
  readonly manager: EnvironmentPackageManagerKind;
  readonly packages: readonly string[];
  readonly updateCache: boolean;
}

export interface EnvironmentScriptInstall {
  readonly kind: "script";
  readonly invocation: ScriptInvocation;
}

export type EnvironmentInstallDefinition =
  | EnvironmentPackageInstall
  | EnvironmentScriptInstall;

export interface EnvironmentSystemManager {
  readonly kind: "system";
  readonly name: string;
  readonly tool: EnvironmentServiceTool;
  /** 缺省 true：系统服务默认开机启动；显式 false 关闭。 */
  readonly enabled?: boolean;
  readonly startAfterInstall: boolean;
  readonly timeoutMs: number;
}

export interface EnvironmentScriptManager {
  readonly kind: "script";
  readonly start: ScriptInvocation;
  /** 新配置必需；旧 plan-v4 快照解码后可缺失。 */
  readonly stop?: ScriptInvocation;
  readonly restart: ScriptInvocation;
}

export type EnvironmentManagerDefinition =
  | EnvironmentSystemManager
  | EnvironmentScriptManager;

/** 环境应用安装时的初始配置声明；只支持 Deno 脚本。 */
export interface EnvironmentInitializationDefinition {
  /** app 启动前执行的初始配置脚本。 */
  readonly beforeStart: readonly ScriptInvocation[];
  /** app 启动后执行的初始配置脚本。 */
  readonly afterStart: readonly ScriptInvocation[];
}

export type AppConfigKind = "script" | "file";
export type AppServiceTool = EnvironmentServiceTool;

export interface AppScriptManagement {
  readonly kind: "script";
  readonly start: ScriptInvocation;
  readonly stop: ScriptInvocation;
  readonly restart: ScriptInvocation;
}

export type AppManagerDefinition = AppScriptManagement | AppServiceManagement;

/** App schema 1 的顶层 configs/management 归一声明。 */
export interface AppManagementDefinition {
  /** @deprecated 仅用于解码旧 plan v4 快照；新配置与新计划不再产生该字段，含此字段的计划拒绝重放。 */
  readonly runAs?: string;
  /** @deprecated 仅用于解码旧 plan v4 快照；新配置与新计划不再产生该字段。 */
  readonly accessGroup?: string;
  /** 缺省表示只交付受管配置，不由框架管理系统服务。 */
  readonly manager?: AppManagerDefinition;
  /** 内部归一表示：顶层 configs 的 file 条目。 */
  readonly configs: readonly ManagedConfigFile[];
  /** 内部归一表示：顶层 configs 的 script 条目。 */
  readonly configScripts: readonly ScriptInvocation[];
}

export interface EnvironmentInstance {
  readonly name: string;
  readonly definition: string;
  readonly version: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly dependsOn: readonly string[];
  readonly requiresPrivilege?: boolean;
}

export interface Machine {
  readonly name: string;
  readonly domains: readonly string[];
  readonly privateIp: readonly string[];
  readonly publicIp: readonly string[];
  readonly region: string;
  readonly sshUser: string;
  readonly sshPort: number;
  /** 每机可选安全目录；缺省 `~/.sfo-deploy/secrets/`。 */
  readonly secretsDir?: string;
  readonly sshPrivateKey?: string;
  /** 是否允许执行远端 Deno；旧机器对象缺省允许。 */
  readonly enableDeno?: boolean;
  readonly scriptRuntime: ScriptRuntime;
  readonly environments: readonly EnvironmentInstance[];
}

export interface EnvironmentDefinition {
  readonly name: string;
  readonly directory: string;
  readonly scripts: ScriptDefinition;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly package?: PackageSpec;
  readonly requiresPrivilege: boolean;
  readonly install?: EnvironmentInstallDefinition;
  readonly manager?: EnvironmentManagerDefinition;
  /** 环境应用安装时的可选初始配置（启动前/启动后）。 */
  readonly init?: EnvironmentInitializationDefinition;
}

export interface AppDefinition {
  readonly name: string;
  readonly directory: string;
  readonly installDirectory?: string;
  /** App 根级发布权限位；仅 versioned App 可用，未声明时保持 0750 默认行为。 */
  readonly mode?: string;
  readonly version?: string;
  readonly package?: PackageSpec;
  /** 显式声明无安装包、check/configure 型 App；普通 App 必须为 false。 */
  readonly packageless: boolean;
  /** v4 内置版本化发布；自定义 scripts.deploy 时保持 undefined。 */
  readonly deployment?: DeploymentDefinition;
  readonly dependsOn: readonly string[];
  readonly management?: AppManagementDefinition;
}

export interface ClusterConfig {
  readonly name: string;
  readonly directory: string;
  readonly executorRegion: string;
  /** 要求使用的 sfo-deploy 精确版本；未声明时不启用版本门禁。 */
  readonly deployerVersion?: string;
  readonly machines: ReadonlyMap<string, Machine>;
  readonly environments: ReadonlyMap<string, EnvironmentDefinition>;
  readonly apps: ReadonlyMap<string, AppDefinition>;
  readonly placements: ReadonlyMap<string, readonly string[]>;
  /** 集群级密钥放置声明，按密钥名索引。 */
  readonly secrets: ReadonlyMap<string, SecretDeclaration>;
}

/** 设计文档中使用的公共名称。 */
export type ClusterDefinition = ClusterConfig;

export interface ResolvedMachine {
  readonly machine: Machine;
  readonly address: string;
  readonly addressKind: AddressKind;
  readonly addresses: readonly string[];
}

export interface PlanStep {
  readonly id: string;
  readonly machine: ResolvedMachine;
  readonly kind: ResourceKind;
  readonly resource: string;
  readonly action: string;
  readonly scripts: readonly ScriptInvocation[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly package?: PackageSpec;
  /** 新机制：本步骤声明需要的值密钥名。 */
  readonly secretValues: readonly string[];
  /** 新机制：本步骤声明需要的文件密钥名。 */
  readonly secretFiles: readonly string[];
  /** managed App 单次 hook/action invocation 可见的值秘密；配置 updater 不消费此集合。 */
  readonly lifecycleSecretValues?: readonly string[];
  /** managed App 单次 hook/action invocation 可见的文件秘密；配置 updater 不消费此集合。 */
  readonly lifecycleSecretFiles?: readonly string[];
  readonly templates: readonly ConfigTemplate[];
  readonly dependsOn: readonly string[];
  readonly installDirectory?: string;
  /** @deprecated 仅用于解码旧 plan v4 快照；重放前 fail closed。 */
  readonly runAs?: string;
  /** App 根级发布权限位；新计划可缺省，旧计划无该字段。 */
  readonly mode?: string;
  /** App v4 内置发布声明；旧计划缺省。 */
  readonly deployment?: DeploymentDefinition;
  /** App v3 显式 opt-in 的内置管理声明；旧计划和非 App 步骤保持缺省。 */
  readonly management?: AppManagementDefinition;
  /** 控制端构建单一部署包所需的、已严格装载的非秘密 App 输入。 */
  readonly deliveryInputs?: PlanDeliveryInputs;
  /** @deprecated plan-v3 兼容字段；新执行器优先使用 deliveryInputs.scripts。 */
  readonly bundleScripts?: readonly ScriptInvocation[];
  /** Environment 新生命周期的声明式安装定义；旧脚本和 App 步骤缺省。 */
  readonly environmentInstall?: EnvironmentInstallDefinition;
  /** Environment 可选服务管理声明；旧脚本和 App 步骤缺省。 */
  readonly environmentManager?: EnvironmentManagerDefinition;
}

export interface PlanDeliveryInputs {
  readonly scripts: readonly ScriptInvocation[];
  readonly files: readonly ConfigTemplate[];
}

export interface ExecutionPlan {
  /** 新计划的持久格式版本；旧快照 codec 由 history 模块负责。 */
  readonly schemaVersion: 3 | 4;
  readonly cluster: string;
  readonly requestedAction: string;
  /** deploy 计划是否包含激活阶段（切换 latest 并启动/重启/重载服务）；缺省或未写出表示包含。 */
  readonly activate?: boolean;
  readonly steps: readonly PlanStep[];
}

export interface PlanRequest {
  readonly action: string;
  readonly machines?: Iterable<string>;
  readonly apps?: Iterable<string>;
  readonly environments?: Iterable<string>;
  readonly executorRegion?: string;
  readonly addressKind?: AddressKind;
  readonly withDependencies?: boolean;
  /** deploy 是否包含激活阶段（切换 latest 并启动/重启服务）；缺省 true。 */
  readonly activate?: boolean;
}

export const EMPTY_SCRIPT_PERMISSIONS: ScriptPermissions = Object.freeze({
  run: Object.freeze([] as string[]),
  net: Object.freeze([] as string[]),
});

export const DEFAULT_SCRIPT_RUNTIME: ScriptRuntime = Object.freeze({
  kind: "deno",
  executable: "deno",
});

export function freezeArray<T>(values: Iterable<T>): readonly T[] {
  return Object.freeze(Array.from(values));
}

export function freezeRecord<T>(
  values: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
  return Object.freeze({ ...values });
}

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(values: Iterable<readonly [K, V]>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  keys(): MapIterator<K> {
    return this.#values.keys();
  }

  values(): MapIterator<V> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "ReadonlyMap";
  }
}

/** 创建没有 set/delete/clear 表面的运行时只读 Map 副本。 */
export function immutableMap<K, V>(
  values: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  return new ReadonlyMapView(values);
}
