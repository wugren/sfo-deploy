# 旧版本自动清理变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/027-old-version-cleanup/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/027-old-version-cleanup/proposal.md
- Design: docs/versions/v0.1/modules/sfo-deploy/027-old-version-cleanup/design.md
- Risk profile: docs/versions/v0.1/modules/sfo-deploy/027-old-version-cleanup/risk-profile.yaml
- Affected paths:
  - `src/user_config.ts`
  - `src/cli.ts`
  - `src/integration.ts`
  - `src/execution.ts`
  - `examples/eleph-server-multipass/cluster-template/apps/jx-server/scripts/deploy.ts`
  - `examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml`
  - `examples/eleph-server-multipass/clusters/multipass/`（同一批文件的 live 副本）
  - `README.md`
  - `docs/guides/sfo-deploy-cluster-configuration.md`
  - `examples/eleph-server-multipass/README.md`
  - `tests/unit/user_config.test.ts`
  - `tests/dv/execution.test.ts`
  - `tests/integration/deploy_version_skip.test.ts`
  - `docs/changes/027-old-version-cleanup.md`
- Explicit tier override: none（用户确认 high-risk）
- Expanded high-risk packet: existing task packet 027-old-version-cleanup

## Approach

- 用户配置：`~/.sfo-deploy/config.yaml` schema v1 新增可选 `keep_versions`（默认 5、1-100 整数）；
  `src/user_config.ts` 严格校验，CLI 与公共 API `RunDependencies` 透传，执行器在 App deploy metadata
  注入 `keep_versions`；不改集群配置 schema 与 plan codec。
- 清理执行：jx-server deploy.ts 在成功发布并写版本标记后，用 `/usr/bin/ls -1A` 列出安装目录，仅接受
  目录内 VERSION 标记与目录名一致的版本目录，按版本字符串降序保留最新 N 个，删除更旧版本目录与
  `~/.sfo-deploy/apps/<version>/` 安装包；版本名经保守字符集校验，`latest`/`data` 等目录天然排除；
  deploy run 白名单增加 `/usr/bin/ls`。
- 触发与安全：同版本跳过、失败、回滚路径不清理；清理路径成分校验拒绝 `.`/`..`/绝对路径；被清理
  版本不可回滚，文档明确。

## Risk Screen

- Public contract, protocol, or CLI change: no（CLI 动作与输出不变；`RunDependencies` 新增可选字段）
- Persistent data, schema, or migration change: yes（用户级配置新增 `keep_versions`；目标机版本目录
  与安装包按策略删除；旧配置缺失时按默认 5，无迁移）
- Security, privacy, or trust-boundary change: yes（删除路径校验、VERSION 标记验证、命令白名单）
- Concurrency, lifecycle, or runtime integration change: yes（成功路径后的清理生命周期）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: yes（保留策略影响可回滚版本集合）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

## Verification

- 定向测试：用户配置默认/合法/非法值、执行器 metadata 注入与非法值拒绝、清理/不清理/数据目录保护
  集成用例，全部通过。
- 全量门禁：`deno task check`、`deno lint`、`deno fmt --check`、全量 `deno test` 通过；模板与 live
  副本逐字节一致。
- Result: pass
- Residual risk or follow-up: 被清理版本不可回滚（默认保留 5 个最新版本）；真实 SSH 目标机部署仍由
  testplan manual_gaps 记录为人工验证项。
