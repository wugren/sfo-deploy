---
task_manifest: task.yaml
status: approved
---

# deploy 二次确认与版本一致跳过部署提案

Risk profile: not-created（仅在高风险确认后替换为 ./risk-profile.yaml）

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 需求明确且集中在 `sfo-deploy` 单模块：(1) `deploy`
  执行前增加与既有 `install` 缺省全量确认同构的确认门禁；(2) jx-server App 的 `deploy`
  脚本在远端维护版本标记，版本一致时跳过一切修改，不一致时按既有原子发布+重启用例执行并记录新版本；(3)
  同步 README、配置指南与示例文档。命中 contract-protocol 与 release/deployment
  触发器，属于筛查证据：公共 CLI 的 deploy 行为与远端脚本行为确实变化，但无配置
  schema、发布历史格式、协议或信任边界变化，改动有定向测试与模板/实例脚本一致性契约覆盖，风险受控，因此按
  bounded 的 `standard` 层级执行；如需完整分阶段生命周期可替换为 high-risk。
- Proposal and tier confirmation: 用户已回复“确认”，确认本提案、`standard`
  层级，并按提示中的默认答案确认三个未决问题：版本以 `app.yaml.version` 为唯一比对来源；远端标记使用
  `${WORK_DIRECTORY}/.jx-server.version`；版本一致跳过时仍生成 `succeeded` 的本地 release 记录。

## Background and Goal

当前 `sfo-deploy deploy` 会直接执行真实部署：构建计划后立即创建发布 attempt 并连接远端执行
`configure`/`deploy` 脚本，没有任何执行前确认；自动/非交互调用只有 `install` 有 `--yes` 语义。远端
jx-server 的 `deploy.ts` 每次都会复制 JAR 并执行 `systemctl restart` +
健康检查，即使部署版本与远端当前版本相同也会产生无意义变更与重启。

目标：用户执行 `deploy`
时必须再做一次确认，确认后才真正执行远端部署；部署时若待部署版本与远端当前版本一致则不做任何修改；版本不同则在原子发布新版本后重启应用完成切换，并记录新版本供下次比对。

## Scope

### In scope

- `deploy` 动作的执行路径：计划生成后、任何 SSH 连接与发布 attempt 创建前进入确认；`--yes`
  显式跳过确认（与现有 `install`
  确认门禁同一套标志）；拒绝/EOF/非交互未同意时按取消退出（130）且不产生历史发布记录。
- 既有 `confirmPlan` 注入回调对 `deploy`
  生效；`plan`/`check`/`configure`/`start`/`stop`/`restart`/`rollback` 等其它动作不加确认。
- jx-server 部署脚本：远端持久版本标记为 `${WORK_DIRECTORY}/.jx-server.version`（内容为
  `app.yaml.version`，经 `metadata.parameters.version` 传入）；一致则跳过 JAR
  复制、系统服务重启与健康检查并成功返回；不一致则保留现有原子发布/备份/健康检查流程，发布成功后原子写入新版本标记；失败回滚时同时恢复
  JAR 与版本标记。
- App 配置：`cluster-template` 与 live cluster 的 `app.yaml` deploy 权限列表增加
  `/usr/bin/cat`（读取版本标记的最小权限），模板与实例脚本保持逐字节一致。
- 文档：README、集群配置指南、示例 README 同步 deploy 确认、`--yes` 与版本一致跳过语义。
- 测试：确认门禁（拒绝路径不连 SSH、不创建发布记录；`--yes`
  跳过）、脚本版本一致跳过/新版发布/回滚一致性、模板与实例脚本契约。

### Out of scope

- 不改变配置 schema、App/环境模型、执行计划格式或发布历史（`intent/outcome/snapshot`）结构。
- 不为所有 App 引入框架级“远端当前版本”自动追踪；版本比对由各 App
  脚本按自身持久目录实现，本任务只实现 jx-server 示例/在线集群。
- 不加 dry-run、不加 `status`/`logs` 动作，不改变 `configure`/`start`/`stop`/`restart` 动作与脚本。
- 版本一致时不自动跳过本地下载与远端 workspace
  暂存（只是远端持久状态不做修改）；也不改其它环境脚本或其它示例。

### Boundary with neighboring modules

- CLI/集成模块：`src/cli.ts` 的确认提示与 `--yes` 帮助文本、`src/integration.ts` 的 `runDeploy`
  确认时序；公开 `run()`/`RunDependencies` 行为变化仅限 deploy 路径。
- 示例/在线集群：`cluster-template` 与 `clusters/multipass` 的 jx-server
  脚本必须内容一致（既有契约测试强制）；`app.yaml` 的 deploy `run` 白名单是唯一权限变化。
- 历史/回退：历史快照保留脚本与计划，回退继续重放快照内的旧脚本，不受本任务新脚本影响。

## Requirement Review

需求合理：部署属于高影响操作，执行前二次确认能显著减少误触发的真实部署；版本一致跳过可让重复 deploy
幂等且不打扰运行中的服务；新版本发布后重启应用是版本切换的必要收尾。三个要求相互一致：只在版本不同时“发布+重启”，版本一致时连重启也不做。

主要取舍：

- “版本”以 `app.yaml.version` 为准并持久化为标记文件；当前示例的 version 仍是哨兵值
  `external-url`，上线前必须替换为真实版本号，否则比对无意义。
- 版本一致即跳过，即使同名版本下 JAR 内容已变化也不会重发（按用户“版本一致不做修改”的要求语义）。
- 首次部署或标记缺失时视为“版本不一致”执行完整部署，保证既有机器可收敛。
- 确认门禁会让现有自动化脚本在未传 `--yes` 时取消退出，属本次明确要求的兼容性变化。
- 版本一致跳过后发布历史仍记录一次 `succeeded` release（本地审计记录，远端无修改）。

## Proposal Items

| proposal_id | change_id                       | requirement                                                                                              | boundary                                                     | tradeoff                                 | success_evidence                                                              | non_goal                                 |
| ----------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| P-001       | CHG-deploy-confirm              | `deploy` 执行前必须二次确认；`--yes` 跳过；取消时不执行任何远端步骤且不产生发布 attempt                  | 仅 deploy 路径；其它动作不加确认                             | 每次部署多一次确认；自动化需显式 `--yes` | 拒绝路径无 SSH 连接/无 release 目录，`--yes` 路径不提示；CLI 测试通过         | 不加 dry-run、不加新参数（沿用 `--yes`） |
| P-002       | CHG-deploy-version-skip-restart | jx-server 版本一致则不做任何修改；不一致则原子发布并重启应用切换到新版本；标记成功更新、失败回滚同步恢复 | 仅 jx-server App 脚本与 live 镜像；权限列表加 `/usr/bin/cat` | 版本标签语义决定是否重发                 | 版本一致跳过/新版发布重启/回滚恢复标记的行为与结构测试、模板-实例一致契约通过 | 不实现框架级通用版本追踪                 |
| P-003       | CHG-deploy-docs                 | README、配置指南、示例 README 记录 deploy 确认、`--yes` 与版本一致跳过语义                               | 文档与行为一致                                               | 无                                       | 文档描述与实现/测试一致                                                       | 不重写安装/生命周期文档                  |

## Success Criteria

- Concrete user-visible or system-visible result: 交互或非交互终端执行 `sfo-deploy deploy` 且未传
  `--yes` 时先展示目标范围并要求确认，拒绝即退出 130 且远端无任何变化、历史无 attempt；传入 `--yes`
  直接执行。远端 `.jx-server.version` 与待部署版本一致时 deploy 成功返回且
  JAR/服务/健康检查均不触碰；不一致时发布新 JAR、重启服务、通过健康检查并更新标记；健康失败回滚时
  JAR 与标记一起恢复。
- Required evidence: 确认门禁单元/集成测试、jx-server 部署脚本行为测试（跳过/发布/回滚）、模板与
  live 脚本一致契约、`deno task check` 通过；README 与指南同步。
- Explicit non-goals: 版本一致时仍会产生本地 release 记录；不做通用框架级版本追踪；不改变其它动作。

## Risks

- 版本字段仍是哨兵值时，比对可能把不同 JAR 视为“一致”或把同 JAR 视为“不一致”。缓解：文档明确要求
  `app.yaml.version` 必须是真实发布版本，标记缺失/非法时一律完整发布。
- 自动化兼容：未传 `--yes` 的现有 deploy 调用会取消。缓解：README/指南说明 `--yes`，取消退出码沿用
  130。
- 标记文件原子性/权限：写入失败会使脚本报错但新 JAR
  已生效。实现把标记写入纳入发布事务（成功发布后写标记；失败回滚同时恢复旧标记），并设置 0640
  权限；残余不一致由下次 deploy 收敛。
- live cluster 脚本必须与模板一致：实现时同步两份并运行既有 `verify_independent_remote_scripts`
  契约。

## Open Questions

1. 版本来源：是否确认以 `app.yaml.version`（经 `metadata.parameters.version`
   注入）作为“部署版本”的唯一比对来源？当前模板/live 的 version 仍是 `external-url`
   哨兵，需要改用真实版本号后该能力才有意义。
2. 标记位置：是否确认远端版本标记使用 `${WORK_DIRECTORY}/.jx-server.version`（与 JAR
   同目录、0640、原子写入）？
3. 发布记录：版本一致跳过时，`deploy` 仍会生成一条 `succeeded` 的本地 release
   记录（远端不做修改）。是否认可该审计语义？
