# 删除 v1 配置形态（app.yaml v1 与 cluster v1 环境布局）变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/047-remove-v1-config-layouts/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/047-remove-v1-config-layouts/proposal.md
- Design: docs/versions/v0.1/modules/sfo-deploy/047-remove-v1-config-layouts/design.md
- Risk profile: docs/versions/v0.1/modules/sfo-deploy/047-remove-v1-config-layouts/risk-profile.yaml
- Affected paths:
  - `src/config.ts`
  - `tests/_support/fixtures.ts`
  - `tests/_support/environment_placement.ts`
  - `tests/unit/config_planning.test.ts`
  - `tests/unit/app_management_config.test.ts`
  - `tests/unit/environment_placement.test.ts`
  - `tests/integration/environment_placement.test.ts`
  - `tests/contract/verify_environment_placement_config.ts`
  - `README.md`
  - `docs/guides/sfo-deploy-cluster-configuration.md`
  - `examples/eleph-server-multipass/README.md`
  - `docs/changes/047-remove-v1-config-layouts.md`
- Explicit tier override: none（用户确认 high-risk）
- Expanded high-risk packet: existing task packet 047-remove-v1-config-layouts

## Approach

- 版本收窄：`clusterSchemaVersion` 只接受 `2`，`appSchemaVersion` 只接受 `2`/`3`，v1 配置在版本
  判断处即被拒收，错误信息指明受支持版本与迁移方向。
- 分支删除：移除 `APP_V1_FIELDS`、`loadApps` 的 v1 内联分支、`loadV1MachineEnvironments` 与
  `loadCluster` 的 v1 clusterFields/clusterRequired 三目；`app_versions.yaml`
  成为版本/包的唯一来源。
- 保留 `loadV2PlacedEnvironments` 的每机布局 fail-closed 守卫（cluster v2 + 旧目录仍明确拒绝）。
- 测试与文档：v1 可读用例改写为 v1 拒收负例；README、集群配置指南、示例 README 收敛为 「不再支持
  v1、需升级迁移、不支持降级」。

## Risk Screen

- Public contract, protocol, or CLI change: yes（app.yaml/cluster.yaml 的 v1 配置形态不再被装载， 对
  v1 配置属 breaking；对 v2/v3 配置无变化，公开 TypeScript 类型与导出不变）
- Persistent data, schema, or migration change: yes（cluster.yaml schema v2 与 app.yaml v2/v3
  成为唯一受支持形态；历史发布快照独立于当前目录布局，不回写）
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: yes（装载契约收窄即本需求主体；
  版本收窄选择在入口 fail-closed，不留降级后门）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

全部 yes 项均属于已确认 high-risk 提案范围，风险档案与设计文档覆盖相应 required_checks。

## Verification

- 实现与测试：`deno task check`、`deno lint`、`deno fmt --check` 通过；任务作用域 unit/integration
  与契约（closure/docs/v1-rejection/removed-symbol-scan/compile-closure）全部通过；v2/v3 装载结果
  与删除前逐字段一致（closure + 既有 v2 用例回归）。
- 静态门禁：harness-check 各阶段（proposal/design/implementation/testing）完成态通过；
  lower-tier、risk-profile、stage-scope、schema 检查通过。
- Result: pass
- Residual risk or follow-up: 仓库工作树存在两个与本任务无关的先存失败测试
  （`tests/integration/packageless_app_scripts.test.ts` 引用示例模板中已不存在的
  `nginx/scripts/restart.ts`；`tests/unit/secrets_deploy_config.test.ts` 顶层 secret_files 作用域
  断言），属 046 app-service-management 演进遗留，已记录为后续跟进任务，不在本任务修复范围。
