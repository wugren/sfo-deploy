---
task_manifest: task.yaml
status: approved
---

# 提案：删除 v1 配置形态（app.yaml schema v1 与 cluster v1 环境布局）

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务删除两条文档化的只读兼容配置契约（app.yaml schema v1
  内联 version/package，cluster v1 每机环境布局），对既有 v1
  集群配置构成兼容性破坏、无自动迁移与回退后门，命中公共契约与兼容/回滚边界；仓库先例中同类
  cluster/app 配置 schema 变更（020、026、046）均按 high-risk 全生命周期执行。
- Proposal and tier confirmation: 用户于 2026-09-05 通过工作中问答确认「environment.yaml v1 逻辑」按
  cluster v1 每机环境布局理解（environment.yaml 自身 schema_version: 1 校验保留），并确认按
  high-risk 执行。

## Background and Goal

当前 `src/config.ts` 保留两条 legacy 读入路径：一是 app.yaml `schema_version: 1`，在 app.yaml 内联
`version`/`package`，且整体与 `app_versions.yaml` 互斥（纯 v1 只读兼容）；二是 cluster.yaml
`schema_version: 1` 环境布局，从 `environments/<机器名>/<环境名>/environment.yaml`
按机器放置环境。v1 形态自 020/026
起仅维持「只读兼容、不自动迁移」，长期双读入路径增加装载分支与测试维护成本。

目标是把受支持配置形态收敛为唯一现代形态：`cluster.yaml` 只支持 schema_version 2（共享环境定义 +
`cluster.yaml.environments` 集中放置），`app.yaml` 只支持 schema_version 2/3（version/package
一律来自集群根 `app_versions.yaml`），`environment.yaml` 保持 schema_version 1。

## Scope

### In scope

- 删除 app.yaml schema v1 读入：`appSchemaVersion` 仅接受 2|3，错误文案明确；移除 `APP_V1_FIELDS` 与
  `loadApps` 的 v1 分支；无 `app_versions.yaml` 时任何 App 一律报错。
- 删除 cluster v1 环境布局读入：`clusterSchemaVersion` 仅接受 2，错误文案明确；移除
  `loadV1MachineEnvironments` 与 `loadCluster` 的 v1 分支（v1 clusterFields/clusterRequired）。
- 保留 fail-closed 守卫：v2 装载检测到 `environments/<机器>/<环境>/` v1
  每机布局目录仍明确报错，避免静默歧义。
- 同步改写依赖 legacy
  行为的测试夹具（`tests/_support/fixtures.ts`、`environment_placement.ts`）与用例，把「v1
  可读」改为「v1 被拒收」负例。
- 同步更新
  README、`docs/guides/sfo-deploy-cluster-configuration.md`、`examples/eleph-server-multipass/README.md`
  的 v1 兼容/迁移/降级表述。

### Out of scope / explicit non-goals

- 不删除 `app_versions.yaml`、`machines.yaml`、用户配置或发布历史等其它 schema_version: 1
  文件及校验。
- 不删除 `environment.yaml` 自身的 `schema_version: 1` 校验（该文件无 v2）。
- 不新增、不移除 v2/v3/packageless/managed 功能。
- 不提供自动迁移工具或降级后门；既有 v1 集群只是不再可读，装载即失败并给出升级方向。
- 不自动改写任何既有 v1 集群文件。

## Requirement Review

- 请求合理：v1 仅剩只读兼容负担，收敛到唯一形态符合工具演进；删除是本次请求的明确意图。
- 主要风险/权衡：兼容性破坏（外部 v1
  集群需人工迁移文件布局）是有意取舍，通过文档与清晰错误信息缓解；测试夹具 v1 选项调用点分散（约 12
  处），删除成本集中在夹具与用例改写。
- 选定方向：删除两条 v1 读入并按版本拒收，保留 v2 装载的 v1-布局 fail-closed 守卫；不动其它 schema
  v1 文件。

## Proposal Items

| proposal_id | change_id                        | requirement                                                                                                                | boundary                                                                                                   | tradeoff                                                                                       | success_evidence                                                                          | non_goal                                                                                                                  |
| ----------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P-001       | CHG-drop-app-v1                  | 删除 app.yaml schema v1 读入：`appSchemaVersion` 仅接受 2                                                                  | 3；移除 `APP_V1_FIELDS` 与 `loadApps` v1 分支；`app_versions.yaml` 存在时所有 App 强制 v2/v3，缺失即报错。 | 只改 `src/config.ts` App 装载面；不改变 v2/v3/packageless/managed 语义与公开 TypeScript 形状。 | 收敛到单一路径换取契约清晰，代价是 v1 内联集群不再可读。                                  | `schema_version: 1` 的 app.yaml 装载即报错且信息指出受支持版本；v2/v3 装载结果与删除前逐字段一致；相关单测/契约用例跑绿。 |
| P-002       | CHG-drop-cluster-v1-environments | 删除 cluster v1 环境布局读入：`clusterSchemaVersion` 仅接受 2；移除 `loadV1MachineEnvironments` 与 `loadCluster` v1 分支。 | 保留 v2 装载对 `environments/<机器>/<环境>/` 每机布局目录的 fail-closed 报错；环境定义语义不变。           | 移除整支每机放置路径，换取单一共享定义+集中放置语义。                                          | cluster.yaml schema 1 装载即报错；v2 共享定义/集中放置结果不变；v1 布局目录仍被明确拒绝。 | 不提供 v1 布局到 v2 的自动改写。                                                                                          |
| P-003       | CHG-v1-doc-tests                 | 改写依赖 legacy 行为的夹具与用例为「v1 拒收」负例，并同步收敛 README、集群配置指南与示例说明中的 v1 兼容/迁移/降级表述。   | 只覆盖本任务涉及的测试与文档文件；其它测试套件语义不变。                                                   | 验证面较大但兼容回归需要契约级覆盖。                                                           | 全量 `deno task check` 通过；文档不再宣称 v1 只读兼容；错误信息与文档一致。               | 不为已删除的 v1 形态保留示例或迁移手册。                                                                                  |

## Success Criteria

- 可见结果：装载 `schema_version: 1` 的 app.yaml 或 cluster.yaml
  立即失败，错误信息指明受支持版本与升级方向。
- 必要证据：`deno task check`（含类型检查与测试）通过；相关 unit/integration/contract
  用例改写并跑绿；变更记录与验收证据完整。
- 显式非目标：不支持混合或降级读取 v1 配置；不提供自动迁移工具。

## Risks

- 兼容性/迁移：删除只读兼容后，外部 v1
  集群升级需人工迁移，属有意取舍；通过文档更新与清晰错误信息缓解，不提供回退后门。
- 测试面：夹具依赖 v1 选项，改写范围较大；逐一收敛 `writeCluster`/`writePlacementCluster`
  调用并以负例断言兜底。
- 边界遗漏：环境/App 装载的其它版本分支可能被误伤；通过全量测试套件与独立缺陷扫描验证。
- Risk profile: ./risk-profile.yaml
