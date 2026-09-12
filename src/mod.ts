/** Public Deno/TypeScript API for sfo-deploy. */

export { createCli, main, resolveGenericConfigRoot, serializeResult } from "./cli.ts";
export type { CliDependencies, Reader, Writer } from "./cli.ts";

export { loadCluster, NAME_RE, SECRET_RE, validateScriptRuntimeExecutable } from "./config.ts";
export { loadUserConfig } from "./user_config.ts";
export type { LoadUserConfigOptions, SfoDeployUserConfig } from "./user_config.ts";

export {
  DownloadProviderRegistry,
  DownloadRequest,
  FilehubDownloadProvider,
  HTTPDownloadProvider,
  HttpDownloadProvider,
  VerifiedArtifact,
} from "./downloads.ts";
export type { DownloadProvider, DownloadRequestOptions, ReleaseSourceCodec } from "./downloads.ts";

export {
  CancelledError,
  ConfigurationError,
  DeploymentError,
  DownloadError,
  ExecutionError,
  PlanningError,
  PreflightError,
  TransportError,
} from "./errors.ts";
export type { DeploymentErrorCode } from "./errors.ts";

export { PackageCache } from "./package_cache.ts";
export type {
  CachePolicy,
  FetchedPackage,
  PackageCacheOptions,
  PackageMetadata,
} from "./package_cache.ts";

export { configVariableMarker, generateConfigSkeleton } from "./config_generation.ts";
export type { ConfigSkeletonSecretBinding, GeneratedConfigSkeleton } from "./config_generation.ts";

export { buildDeploymentBundle } from "./deployment_bundle.ts";
export type {
  BuildDeploymentBundleOptions,
  BuiltDeploymentBundle,
  DeploymentBundleConfigInput,
  DeploymentBundleFileInput,
  DeploymentBundleManifest,
  DeploymentBundleManifestEntry,
  DeploymentBundlePackageInput,
  DeploymentBundlePurpose,
} from "./deployment_bundle.ts";

export {
  REMOTE_CONFIG_UPDATER_BUNDLE_PATH,
  REMOTE_CONFIG_UPDATER_SOURCE,
  stageDeploymentBundle,
} from "./remote_deployment.ts";
export type {
  BuiltinConfigCandidateRequest,
  ManagedConfigPublication,
  ManagedConfigPublishRequest,
  RemoteConfigCandidate,
  RemoteDeploymentChannel,
  StagedDeploymentBundle,
  StageDeploymentBundleOptions,
} from "./remote_deployment.ts";

export {
  DeploymentExecutor,
  executePlan,
  executePrepared,
  PreparedExecution,
  prepareExecution,
} from "./execution.ts";
export type {
  ExecuteOptions,
  PreparedStep,
  PrepareOptions,
  StepProgress,
  StepProgressListener,
} from "./execution.ts";

export {
  deriveRollbackPlan,
  PendingRelease,
  PLAN_SCHEMA_VERSION,
  RELEASE_SCHEMA_VERSION,
  ReleaseHistoryResult,
  ReleaseSelection,
  ReleaseStore,
} from "./history.ts";
export type {
  DeploymentResultLike,
  DeploymentStepLike,
  DeploymentTargetLike,
  ReleaseErrorSummary,
  ReleaseExecutionSummary,
  ReleaseOperation,
  ReleaseRecord,
  ReleaseSelectionOptions,
  ReleaseStepBundleSummary,
  ReleaseStepRecoverySummary,
  ReleaseStepServiceSummary,
  ReleaseStepSummary,
  ReleaseTargetSummary,
  SourceExporter,
  SourceImporter,
} from "./history.ts";

export { CLI_ACTIONS, run, runAction, RunOptions, ValidationResult } from "./integration.ts";
export type {
  CliAction,
  ProgressEvent,
  ProgressListener,
  RunDependencies,
  RunOptionsInit,
  RunResult,
} from "./integration.ts";

export { buildPlan, resolveMachine } from "./planning.ts";
export { convergeSystemd, inspectSystemd, restoreSystemd } from "./service_management.ts";
export type {
  SystemdConvergence,
  SystemdConvergeRequest,
  SystemdExecutedAction,
  SystemdOperation,
  SystemdState,
} from "./service_management.ts";
export {
  commandResult,
  DeploymentResult,
  FetchResult,
  InstallDenoResult,
  SecretsDeployResult,
  StepResult,
  StepStatus,
  TargetResult,
} from "./results.ts";
export type {
  CommandResult,
  DeploymentResultOptions,
  FetchPackageResult,
  MachineDenoOutcome,
  SecretCheckIssue,
  SecretsMachineOutcome,
  StepBundleResult,
  StepRecoveryResult,
  StepResultOptions,
  StepServiceResult,
  StepServiceState,
} from "./results.ts";

export {
  declaredSecretNamesForMachine,
  DEFAULT_SECRETS_DIR,
  prepareSecretDeployments,
  ProjectBindings,
  Redactor,
  resolveSecretsForMachine,
  SECRET_NAME_RE,
  validateSecretKind,
  validateSecretName,
  validateSshPrivateKey,
} from "./secrets.ts";
export type {
  ConfigSecretProvider,
  ProjectBindingsOptions,
  ResolvedFileSecret,
  ResolvedSecret,
  ResolvedValueSecret,
  SecretDeploymentFile,
} from "./secrets.ts";

export {
  OpenSshRemoteSession,
  OpenSshTransport,
  quotePosix,
  SSHTransport,
  validateArgv,
} from "./transport.ts";
export type {
  CommandFactory,
  DeploySecretResult,
  RemoteRunOptions,
  RemoteSecretState,
  RemoteSecretUpload,
  RemoteSession,
  SecretManifestEntry,
  SpawnedCommand,
  Transport,
} from "./transport.ts";

export type {
  AddressKind,
  AppDefinition,
  AppManagementDefinition,
  AppManagerDefinition,
  AppScriptManagement,
  AppServiceManagement,
  AppServiceTool,
  ClusterConfig,
  ClusterDefinition,
  ConfigTemplate,
  DeploymentDefinition,
  DeploymentKind,
  EnvironmentDefinition,
  EnvironmentInstance,
  ExecutionPlan,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  Machine,
  ManagedConfigChangeAction,
  ManagedConfigFile,
  ManagedConfigFormat,
  ManagedConfigIniSelector,
  ManagedConfigPathSegment,
  ManagedConfigPathSelector,
  ManagedConfigSelector,
  ManagedConfigValidator,
  ManagedConfigValueType,
  ManagedConfigVariableBinding,
  ManagedFileFormat,
  ManagedSecretReference,
  PackageSpec,
  PlanAction,
  PlanDeliveryInputs,
  PlanRequest,
  PlanStep,
  ResolvedMachine,
  ResourceKind,
  ScriptDefinition,
  ScriptInvocation,
  ScriptPermissions,
  ScriptRuntime,
  ScriptRuntimeKind,
  SecretDeclaration,
  SecretKind,
  SystemdDeployAction,
  SystemdUnitConfig,
} from "./types.ts";
