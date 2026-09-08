---
task_manifest: task.yaml
status: approved
---

# Proposal：删除 app.yaml / environment.yaml 顶层 templates 字段

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务删除 app.yaml（APP_V2_FIELDS）与 environment.yaml
  顶层 `templates` 字段声明契约，收窄 v2/v3
  配置文件的合法字段集，属公开配置契约的破坏性变更；同时改持久化计划步骤序列化 emit 面并需保持旧快照
  decode 兼容。与 047/049 同类 schema/装载契约变更一致，按 high-risk 全生命周期执行。
- Proposal and tier confirmation: 用户于 2026-09-06 确认「high-risk，方案 A」——decode 保留读取旧快照
  `templates`（可选/缺省空数组）以保证回滚兼容；按 high-risk 全生命周期执行。

## Background and Goal

`templates` 是 app.yaml（schema v2 起）与 environment.yaml 顶层可选字段，`src/config.ts` 的
`scriptDefinition`
读取它把额外资源文件捆绑进部署包（config.ts:788-809）。当前示例集群与文档均不使用该字段；v3 的
`management.configs[].source`（040/045/048 引入的内置配置管理）已覆盖「打包模板文件 +
装载绑定」场景，且 delivery_inputs.files 复用同一个 ConfigTemplate
传输通道。用户确认该字段不再需要，故从公开 schema 契约中移除。

目标是收敛 app.yaml / environment.yaml 顶层声明面：`templates` 作为顶层字段废弃，模板文件交付统一走
management.configs（内置配置管理）机制。

## Scope

### In scope

- 删除 app.yaml `APP_V2_FIELDS` 与 environment.yaml 允许字段中的 `templates`，删除
  `scriptDefinition` 对 `data.templates` 的解析/校验/去重（config.ts）。
- 删除 `ScriptDefinition.templates` 与 `DeploymentStep.templates` 公开类型（types.ts）。
- emit 面停止写入步骤 `templates`：planning step 构造、execution 暂存与远端模板元数据、history/cli
  序列化同步移除。
- decode 面保持旧持久化快照兼容：history `decodeStep` 对 `templates`
  改为可选（缺省空数组），可继续解码 plan-v1/2/3 与旧 v4 发布快照。
- 对已被移除的顶层字段给出定向拒收错误文案（指明「模板改用 management.configs 交付」）。
- 同步测试夹具与用例（fixtures、dv/execution、environment_placement、history）、README
  与集群配置指南。

### Out of scope / explicit non-goals

- 不改 `ConfigTemplate` 类型与 `deliveryInputs.files`：管理配置（management.configs source）与
  delivery 已用同一类型和新通道，保持不变。
- 不改 management.configs、远端 config_updater 协议、bundle 成员形态与 048 失败关闭行为。
- 不改 cluster.yaml、app_versions.yaml、machine/environment 布局。
- 不提供自动迁移工具；既有含顶层 `templates` 的 v2/v3 文件装载即失败并给出迁移方向。

## Requirement Review

- 请求合理：`templates` 顶层字段在 v3
  内置配置管理（040/045/048）成熟后成为废弃旁路，示例与文档均不使用；删除它减少一处声明面，方向成立。
- 主要权衡（需用户知情确认）：含顶层 `templates` 的既有 v2/v3
  集群配置升级后装载失败（有定向错误文案，无自动迁移）。持久化旧发布快照在 decode
  阶段仍需容忍该字段以保证回滚可用；新计划不再写入。
- 选定方向：删除 app.yaml / environment.yaml 顶层 `templates`，交付统一到 management.configs；先在
  schema 内收窄（变未知字段并定向报错）而非新增 schema 版本（与 047/049 先例一致）。

## Proposal Items

| proposal_id | change_id                            | requirement                                                                                                                                                                                              | boundary                                                                                                                                  | tradeoff                                                                                     | success_evidence                                                                                            | non_goal                                                                                |
| ----------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P-001       | CHG-templates-config-load            | 删除 app.yaml 与 environment.yaml 顶层 templates 字段的解析、校验与去重；对已移除字段定向拒收并指引「改用 management.configs 交付模板」。                                                                | 只改 src/config.ts 装载面与 src/types.ts 公开类型；不动 management.configs/config_updater/远端协议。                                      | 收窄 v2/v3 合法字段集，破坏含该字段的既有配置；换取单一声明面。                              | 含顶层 templates 的 app.yaml/environment.yaml 装载即报定向迁移错误；其余 v2/v3 配置装载结果回归逐字段不变。 | 不自动改写任何既有配置文件。                                                            |
| P-002       | CHG-templates-planning-serialization | 停止在计划步骤 emit 面写入 templates（planning/execution/history/cli）；decodeStep 对 templates 改为可选（缺省空数组）保持旧快照兼容；删除 ScriptDefinition.templates 与 DeploymentStep.templates 类型。 | 只改 src/planning.ts、src/execution.ts、src/history.ts、src/cli.ts、src/types.ts；计划 schema 字段形状 emit 面收窄，decode 保持向前兼容。 | 放弃计划步骤内的模板旁路字段，换取声明面收敛；deliveryInputs.files/management 清单不受影响。 | 新生成计划步骤不再含 templates；plan-v1/2/3 与旧 v4 快照 decode/回滚回归通过；history 校验不变量保持成立。  | 不改 plan schema 主版本号；远端执行器能继续消费既有通道（management/delivery_inputs）。 |
| P-003       | CHG-templates-docs-tests             | 夹具与用例删除顶层 templates 声明与步骤 templates 断言；README 与配置指南收敛为「模板交付统一走 management.configs」。                                                                                   | 只覆盖本任务相关测试与文档；plan 历史 fixtures 保留 templates 字段以印证 decode 兼容（引导为历史快照，不属于新 emit）。                   | 测试面较大但契约级覆盖与回滚兼容是回归底线。                                                 | 全量 `deno task check` 通过；相关 unit/integration/dv/contract 用例跑绿；文档与错误文案一致。               | 不为旧顶层 templates 保留新配置示例。                                                   |

## Success Criteria

- 可见结果：app.yaml / environment.yaml 不再接受也不再需要顶层
  `templates`；含该字段的配置装载即报定向错误并指引改走 management.configs；新计划不再写入步骤
  templates，旧发布快照仍可 decode 用于回滚。
- 必要证据：`deno task check` 通过；相关 unit/integration/dv
  用例与统一入口运行制品全绿；变更记录与验收报告完整。
- 显式非目标：不迁移既有文件、不新增 schema 版本、不动 management.configs/delivery_inputs 通道。

## 已确认问题（Confirmed Decisions）

1. **旧快照 decode 兼容**（方案）：**已确认方案 A**——decodeStep 对 step `templates`
   保留读取且改为可选（缺省空数组），plan-v1/2/3 与旧 v4 发布快照仍可解码回滚；新计划 emit
   面不再写入 `templates`。
2. **tier**：**已确认 high-risk**，按全生命周期执行（design → implementation → testing →
   acceptance）。

## Risks

- 契约破坏：既有 v2/v3 集群若使用顶层 templates，升级后装载失败（有定向错误文案，无自动迁移）。
- 回滚兼容：若方案 A 命中，decode 面必须保留 templates 读取，否则旧快照回滚失败；需在 design
  明确测试覆盖。
- 交付通道歧义：必须确保 management.configs/delivery_inputs.files 通道不受影响，drop
  只作用于顶层声明与步骤旁路。
