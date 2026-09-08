# 删除 app.yaml / environment.yaml 顶层 templates 字段变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/050-drop-app-templates-field/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/050-drop-app-templates-field/proposal.md
- Design: docs/versions/v0.1/modules/sfo-deploy/050-drop-app-templates-field/design.md
- Risk profile: docs/versions/v0.1/modules/sfo-deploy/050-drop-app-templates-field/risk-profile.yaml
- Affected paths:
  - `src/types.ts`
  - `src/config.ts`
  - `src/planning.ts`
  - `src/history.ts`
  - `src/execution.ts`（核查：步骤模板暂存/上传/fallback 保留为 legacy-compat，零改动）
  - `src/cli.ts`（核查：只序列化 delivery_inputs.files，零改动）
  - `tests/_support/environment_placement.ts`
  - `tests/unit/environment_placement.test.ts`
  - `tests/unit/app_management_config.test.ts`
  - `tests/unit/history.test.ts`
  - `README.md`
  - `docs/guides/sfo-deploy-cluster-configuration.md`
  - `docs/changes/050-drop-app-templates-field.md`
- Explicit tier override: none（用户确认 high-risk，方案 A——decode 保留读取旧快照 `templates`
  兼容回滚）
- Expanded high-risk packet: existing task packet 050-drop-app-templates-field

## Approach

- 装载面：app.yaml（`APP_V2_FIELDS`）与环境定义允许字段移除顶层 `templates`；`scripts()` 停止解析
  `data.templates` 并删除 `ScriptDefinition.templates` 类型；App/环境装载在 `fields()` 之前对命中
  `templates` 键定向拒收，文案为「顶层 templates 已移除：模板文件交付请改用 management.configs」。
- 发射面（方案 A）：`buildPlan` 新步骤 `templates` 与 `deliveryInputs.files` 恒空（scripts 保持， 供
  app deploy 重打包）；`history.encodeStep` 不再写 `templates`，`decodeStep` 对 `templates`
  可选（缺省空数组）；`DeploymentStep.templates` 保留为 legacy-compat 字段——decode 旧快照填充，
  新计划恒空，execution fallback 对无 delivery_inputs 的旧 schema 步骤仍按原逻辑交付模板。
- 文档面：README 与集群配置指南从环境/App schema 表中移除 `templates` 字段行，旧脚本模式 `templates`
  说明改写为「兼容性移除、模板交付统一走 management.configs」；management.configs source/bindings 与
  `templates/` 目录、`metadata.templates`（legacy 快照执行）边界保持。

## Verification

- 统一测试入口任务作用域：contract（新路径装载/旧路径拒收/removed-symbol-scan via
  consumer-closure-check/repository-compile-closure/documentation-examples）+ unit（U1 装载拒收与
  management 路由回归、U2 环境夹具回归、U3 快照编解码）+ integration（I1 全量 `deno task test`、 I2
  文档契约）。
- 全仓 `deno task test` 234 通过 / 0 失败；`deno task check`、`deno task lint`、 `deno task fmt`
  通过。
- 验收独立探针：顶层 `templates` 在 app.yaml / environment.yaml 两处定向拒收文案、无顶层字段的 v2/v3
  装载逐字段回归、management.configs 模板交付路由不受影响、新计划步骤无 templates、 旧 plan-v1/2/3
  与旧 v4 快照 decode 兼容——全部通过。

## Follow-ups

- 无阻断后续。`DeploymentStep.templates`/`metadata.templates` 作为旧快照回滚兼容面保留；如未来
  彻底清理发布历史中遗留的该字段，可另开任务在 decode/execution 两侧同步移除。
