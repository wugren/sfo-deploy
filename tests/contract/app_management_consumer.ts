import {
  type AppManagementDefinition,
  buildDeploymentBundle,
  buildPlan,
  type BuiltDeploymentBundle,
  configVariableMarker,
  convergeSystemd,
  type DeploymentDefinition,
  generateConfigSkeleton,
  inspectSystemd,
  type ManagedConfigFile,
  type ManagedConfigPublication,
  type ManagedFileFormat,
  PLAN_SCHEMA_VERSION,
  type RemoteSession,
  restoreSystemd,
  type StagedDeploymentBundle,
  stageDeploymentBundle,
  type SystemdServiceManagement,
  type SystemdUnitConfig,
} from "../../src/mod.ts";

// 独立消费者的编译闭包：保证公开根模块真实导出 app v3 所需类型与操作。
export const publicSurface = Object.freeze({
  PLAN_SCHEMA_VERSION,
  buildPlan,
  buildDeploymentBundle,
  generateConfigSkeleton,
  configVariableMarker,
  stageDeploymentBundle,
  inspectSystemd,
  convergeSystemd,
  restoreSystemd,
});

export type PublicManagedTypes = {
  readonly deployment: DeploymentDefinition;
  readonly management: AppManagementDefinition;
  readonly config: ManagedConfigFile;
  readonly service: SystemdServiceManagement;
  readonly fileFormat: ManagedFileFormat;
  readonly unitConfig: SystemdUnitConfig;
  readonly bundle: BuiltDeploymentBundle;
  readonly staged: StagedDeploymentBundle;
  readonly publication: ManagedConfigPublication;
  readonly session: RemoteSession;
};
