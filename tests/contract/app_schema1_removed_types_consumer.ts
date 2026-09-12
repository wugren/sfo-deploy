import type { AppDefinition, AppManagementDefinition } from "../../src/mod.ts";

// 独立旧消费者：App schema 1 已移除顶层 scripts 与旧 management 包装形状。
export type RemovedAppScripts = AppDefinition["scripts"];
export type RemovedManagementService = AppManagementDefinition["service"];
export const oldScripts: RemovedAppScripts | undefined = undefined;
export const oldService: RemovedManagementService | undefined = undefined;
