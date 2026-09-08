---
task_manifest: task.yaml
status: approved
---

# 旧版本自动清理策略提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务在部署成功路径上**删除**旧版本目录与
  `~/.sfo-deploy/apps/<version>/` 安装包，属于 release/deployment、data-schema 与
  compatibility/rollback 边界的物质性影响；配置新增保留策略字段并被脚本消费，删除语义必须与
  latest/回滚语义严格互斥。默认按 `high-risk` 提案；用户确认后保留该层级。
- Proposal and tier confirmation: 已确认。用户回答全部未决问题并指示自动完成：保留最新 N 个版本 且 N
  可配置（默认 5）；保留个数为全局配置，放入 sfo-deploy 用户配置
  （`~/.sfo-deploy/config.yaml`）；清理范围包含 `~/.sfo-deploy/apps/<version>/`；按版本字符串
  排序；仅在成功发布并写入版本标记后清理，失败/回滚/同版本跳过不清理。

## Background and Goal

026-versioned-app-layout 交付后，jx-server 每次成功发布都会新增版本目录
`<install_directory>/<version>/`，并把重打包后的安装包放入 `~/.sfo-deploy/apps/<version>/`；
旧版本不会被删除，磁盘占用随时间线性增长（026 明确记录为 non-goal）。用户要求“继续旧版本自动
清理策略”：在部署成功后自动清理超过保留数量的最旧版本目录与对应安装包，同时保证当前版本 （`latest`
指向的版本）与可回滚版本不被误删。

目标：sfo-deploy 用户配置提供全局 `keep_versions`（默认 5），执行器在 App deploy metadata 注入该
值，jx-server 部署成功后按“保留最新 N 个”自动清理最旧版本目录及 `~/.sfo-deploy/apps/<version>/`
安装包；失败、回滚、同版本跳过时一律不清理。

## Scope

### In scope

- 用户配置：`~/.sfo-deploy/config.yaml` schema v1 增加可选 `keep_versions`（正整数，默认 5，
  合法范围 1-100）；`src/user_config.ts` 严格校验并从 CLI/公共 API 依赖注入执行链。
- 执行 metadata：`src/execution.ts` 在 App deploy 步骤 metadata 注入 `keep_versions` （缺省
  5）；不改 context schema 主版本、不改 PlanStep/历史快照 codec（策略为全局运行参数而非
  每步骤持久数据）。
- 清理执行（jx-server deploy 脚本）：
  - 仅在“重新打包 → 发布版本目录 → 切换 latest → 重启 → 健康通过 → 写入版本标记”全部成功后执行；
  - 用 `/usr/bin/ls -1A` 收集安装目录直接子项，过滤出带 `VERSION` 标记且内容与目录名一致的
    版本目录，按版本字符串降序排序，保留最新 `keep_versions` 个，删除其余版本目录；
  - 对每个被删除版本同时删除 `~/.sfo-deploy/apps/<version>/` 对应安装包目录；
  - 绝不删除 `latest`、`data` 等非版本目录与版本标记指向的当前版本；同版本跳过、失败、回滚路径
    不触发清理。
- 安全约束：删除目标必须是安装目录或 HOME/.sfo-deploy/apps 下的“版本名直接子目录”，版本名经
  保守字符集校验且必须与目录内 VERSION 标记一致；`/usr/bin/rm -rf`、`/usr/bin/ls` 加入 deploy run
  白名单。
- 文档与测试：README、集群配置指南、示例 README 与 change record 同步 `keep_versions` 与清理
  语义；单元（用户配置默认/合法/非法值）、DV（metadata 注入）与集成（保留 1/2/N、超过保留数清理、
  最新与 latest 不删、失败不清理、路径逃逸拒绝）测试覆盖；模板与 live 副本逐字节一致契约。

### Out of scope

- 不做按天数的年龄策略（如“保留 30 天”）；只做“保留最新 N 个”的数量策略。
- 不做跨 App 差异化策略：`keep_versions` 是全局用户配置；不做集群级或 App 级覆盖（用户未要求）。
- 不自动迁移/清理 026 之前遗留的平铺布局；不改发布历史（`.sfo-deploy/releases/`）；不压缩、备份
  或归档被清理版本；不清理本地 fetch 缓存（`~/.sfo-deploy/packages/`）。

### Boundary with neighboring modules

- 配置模块：`src/user_config.ts` 严格校验 `keep_versions`（可选、正整数、1-100，缺失时默认 5）； CLI
  与公共 API（`RunDependencies`）透传；集群配置 schema 不变。
- 执行模块：`src/execution.ts` 在 App deploy metadata 注入 `keep_versions`；删除动作由示例脚本
  负责（与“装什么/怎么装由脚本负责”一致）。
- 示例/在线集群：模板与 live 副本的 app.yaml、deploy.ts 必须逐字节一致；deploy run 白名单增加
  `/usr/bin/ls`、`/usr/bin/rm`。
- 历史/回退：回滚只保证回滚到仍被保留的版本；被清理版本不可回滚（文档明确）。

## Requirement Review

需求合理：版本目录与安装包若只增不删，磁盘持续增长；数量策略简单可控。风险点在于“删除”与“回滚”
的语义冲突——若保留数太小，回滚目标可能已被删除。缓解：默认 `keep_versions: 5`、可全局配置，且
清理只在成功发布并写标记后执行，因此发布失败的步骤执行时上一版本仍完整保留。版本排序按版本字符串
（要求版本号可排序，如 `2.0.0`），文档明确。

## Proposal Items

| proposal_id | change_id                    | requirement                                                                                                                        | boundary                                               | tradeoff                               | success_evidence                                      | non_goal                      |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------- | ----------------------------- |
| P-001       | CHG-version-retention-config | 用户配置 `~/.sfo-deploy/config.yaml` 可选 `keep_versions`（默认 5、1-100）严格校验并经 CLI/公共 API/执行器注入 App deploy metadata | sfo-deploy 用户配置与执行链；不改集群配置与 plan codec | 全局策略实现简单；App 级差异化留给后续 | 配置装载/默认值/非法值拒绝/metadata 注入测试通过      | 不做 per-App/年龄策略         |
| P-002       | CHG-cleanup-execution        | 成功后按 keep_versions 清理最旧版本目录与 `~/.sfo-deploy/apps/<version>/` 安装包；latest/当前/保留版本不删；失败回滚不触发         | jx-server 示例与框架 metadata；删除仅作用于受控路径    | 删除即时释放磁盘但被清理版本不可回滚   | 保留/清理/不删 latest/失败不清理/路径逃逸拒绝测试通过 | 不清理 release 历史与本地缓存 |
| P-003       | CHG-cleanup-docs             | README、指南、示例 README 与 change record 记录 keep_versions 与清理语义                                                           | 文档与实现一致                                         | 无                                     | 文档契约与行为一致、模板/live 副本一致                | 不重写部署教程主体            |

## Success Criteria

- 部署成功且版本数大于 `keep_versions` 时，最旧版本目录与对应 `~/.sfo-deploy/apps/<version>/`
  安装包被删除；`latest`、版本标记指向的当前版本与保留范围内版本不受影响。
- 同版本跳过、部署失败、回滚成功/失败路径均不触发清理。
- 用户配置 `keep_versions` 非法（0、负数、非整数、超上限、未知字段冲突）时失败关闭；缺失时默认 5。
- `deno task check`、lint、fmt、全量测试与任务级统一入口运行通过；README/指南/示例/change record
  同步。

## Risks

- 数据删除不可恢复：被清理的版本目录与安装包无法找回。缓解：默认保留 5 个最新版本、仅清理保留数
  之外的最旧版本；清理前逐路径与 VERSION 标记校验；文档明确被清理版本不可回滚。
- 回滚兼容：被清理版本不可回滚。缓解：默认 5 个；清理仅在成功发布后执行。
- 误删非版本目录：安装目录下存在 `data/uploadPath` 等业务目录。缓解：只接受带匹配 VERSION 标记的
  直接子目录，`latest`/隐藏项/业务目录天然排除。
- 配置 schema：`keep_versions` 为新增可选字段，旧用户配置缺失时按默认 5；非法值在装载时拒绝。

## Confirmed Decisions

1. 保留策略：保留最新 N 个版本，`keep_versions` 可配置，默认 5，合法范围 1-100。
2. 配置位置：全局用户配置 `~/.sfo-deploy/config.yaml`，经 CLI 与公共 API `RunDependencies` 注入
   执行链；不放集群或 App 配置。
3. 清理范围：同时删除 `<install_directory>/<version>/` 版本目录与 `~/.sfo-deploy/apps/<version>/`
   安装包。
4. 版本排序：按版本字符串排序（保留最新 N 个；文档要求版本号可排序）。
5. 触发时机：仅在成功发布并写入版本标记后清理；失败、回滚、同版本跳过不清理。
