/** sfo-deploy 的 Deno/TypeScript 领域值类型。 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ResourceKind = "environment" | "app";
export type AddressKind = "private" | "public";
export type ScriptRuntimeKind = "deno" | "python";
export type PlanAction =
  | "check"
  | "install"
  | "configure"
  | "deploy"
  | "start"
  | "stop"
  | "restart"
  | "stage"
  | "activate";

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

/** app.yaml v3 内置配置管理支持的结构化格式。 */
export type ManagedConfigFormat = "yaml" | "json" | "toml" | "ini";
/** 内部受管文件格式；systemd 只由框架生成的 service unit 候选使用。 */
export type ManagedFileFormat = ManagedConfigFormat | "systemd";
export type ManagedConfigChangeAction = "none" | "reload" | "restart";
export type ManagedConfigValueType = "string" | "integer" | "number" | "boolean";
export type ManagedConfigPathSegment = string | number;

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
  readonly owner?: string;
  readonly group?: string;
  readonly mode: number;
  readonly variables: readonly ManagedConfigVariableBinding[];
  readonly format: ManagedFileFormat;
  /** 源配置解析后发现的 `${SECRET_NAME}` 引用；App 配置引用即授权。 */
  readonly secretReferences: ReadonlyMap<string, ManagedSecretReference>;
  readonly validator?: ManagedConfigValidator;
  readonly onChange: ManagedConfigChangeAction;
}

export type SystemdDeployAction = "none" | "start" | "reload" | "restart";

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
}

export interface SystemdServiceManagement {
  readonly kind: "systemd";
  readonly unit: string;
  /** undefined 表示保留目标节点当前 enable 状态。 */
  readonly enabled?: boolean;
  readonly daemonReload: boolean;
  readonly onDeploy: SystemdDeployAction;
  readonly timeoutMs: number;
  readonly unitConfig?: SystemdUnitConfig;
}

export type AppManagementHook =
  | "before_install"
  | "after_install"
  | "before_configure"
  | "after_configure"
  | "before_deploy"
  | "after_deploy"
  | "before_start"
  | "after_start"
  | "before_stop"
  | "after_stop"
  | "before_restart"
  | "after_restart";

/** app.yaml v3 的显式内置管理声明。缺省时完整保持 legacy 脚本行为。 */
export interface AppManagementDefinition {
  /**
   * 运行 App updater/hook 的目标节点非 root Linux 用户。
   * app.yaml v3 的 management 装载时必填；可选性仅供旧 plan-v4 快照在 I-5 迁移前解码。
   */
  readonly runAs?: string;
  readonly configs: readonly ManagedConfigFile[];
  readonly service?: SystemdServiceManagement;
  readonly hooks: ReadonlyMap<AppManagementHook, readonly ScriptInvocation[]>;
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
}

export interface AppDefinition {
  readonly name: string;
  readonly directory: string;
  readonly installDirectory?: string;
  readonly version?: string;
  readonly package?: PackageSpec;
  /** 显式声明无安装包、check/configure 型 App；普通 App 必须为 false。 */
  readonly packageless: boolean;
  /** v4 内置版本化发布；自定义 scripts.deploy 时保持 undefined。 */
  readonly deployment?: DeploymentDefinition;
  readonly scripts: ScriptDefinition;
  readonly dependsOn: readonly string[];
  readonly management?: AppManagementDefinition;
}

export interface ClusterConfig {
  readonly name: string;
  readonly directory: string;
  readonly executorRegion: string;
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
  /** managed App 的固定非 root 运行身份；旧计划与非 managed 步骤缺省。 */
  readonly runAs?: string;
  /** App v4 内置发布声明；旧计划缺省。 */
  readonly deployment?: DeploymentDefinition;
  /** App v3 显式 opt-in 的内置管理声明；旧计划和非 App 步骤保持缺省。 */
  readonly management?: AppManagementDefinition;
  /** 控制端构建单一部署包所需的、已严格装载的非秘密 App 输入。 */
  readonly deliveryInputs?: PlanDeliveryInputs;
  /** @deprecated plan-v3 兼容字段；新执行器优先使用 deliveryInputs.scripts。 */
  readonly bundleScripts?: readonly ScriptInvocation[];
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
