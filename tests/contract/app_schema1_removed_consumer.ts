import type { AppManagementDefinition } from "../../src/mod.ts";

// 独立旧消费者：schema 1 后 `management.actions` 不再存在于公开类型上。
export type RemovedAppManagementActions = AppManagementDefinition["actions"];
export const oldActions: RemovedAppManagementActions | undefined = undefined;
