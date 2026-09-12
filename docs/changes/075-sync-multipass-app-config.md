# 同步 multipass App 配置到最新格式

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/075-sync-multipass-app-config/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/075-sync-multipass-app-config/proposal.md
- Affected paths:
  - `examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml`
  - `examples/eleph-server-multipass/clusters/multipass/apps/jx-server/application.yml`
  - `examples/eleph-server-multipass/clusters/multipass/apps/nginx/app.yaml`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

按当前 App schema 1 审计三个 App。`jx-web` 和 `nginx` 无行为性迁移；`nginx` 仅将顶层
`configs` 移到 `management` 前以保持与模板和指南示例一致。`jx-server` 的版本内配置目标改用
`${INSTALL_DIRECTORY}`，基础配置的 Redis 密码改用已声明的 `${ELEPH_REDIS_PASSWORD}`。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: yes
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

安全项只涉及把 `jx-server/application.yml` 中遗留明文密码改为集群已声明秘密占位符，不放宽
秘密边界。若目标 Redis 当前密码与集群秘密不同，真实部署前必须先确认或调整 Redis 配置。

## Verification

- Targeted check: `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/075-sync-multipass-app-config all`；其中覆盖 `deno task check`、schema 1 配置 unit 测试、版本化部署 DV 测试、transport 边界/受管配置 integration 测试，以及 multipass `validate`/`plan`。
- Result: passed。统一入口运行工件为
  `.harness/test-results/test-runs/20260909T165241Z-sfo-deploy+075-sync-multipass-app-config-all.json`。
- Residual risk or follow-up: 本地校验不证明真实 Multipass 节点上的 Redis 密码、包内容或
  服务可用性。目标 Redis 必须接受 `ELEPH_REDIS_PASSWORD`；建议另开任务将
  `jx-server/application.yml` 中的明文 `token.secret` 迁移到 `ELEPH_TOKEN_SECRET`。
