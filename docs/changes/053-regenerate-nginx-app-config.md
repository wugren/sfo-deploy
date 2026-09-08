# 按 App v4 重新生成 Multipass nginx 配置变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/053-regenerate-nginx-app-config/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/sfo-deploy/053-regenerate-nginx-app-config/proposal.md
- Affected paths:
  - `examples/eleph-server-multipass/clusters/multipass/apps/nginx/app.yaml`
  - `examples/eleph-server-multipass/clusters/multipass/apps/nginx/templates/nginx.yaml`
  - `examples/eleph-server-multipass/clusters/multipass/apps/nginx/templates/nginx.conf.tpl`
  - `examples/eleph-server-multipass/clusters/multipass/apps/nginx/scripts/update-config.ts`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- 将生成集群中的 nginx App 迁移到 App v4 统一 `management.actions` 声明。
- 配置源使用结构化 `templates/nginx.yaml`，目标改为 `/etc/nginx/nginx.yaml`。
- service action 不带 `unit_config`，不生成 systemd unit；只控制目标机已有的
  `nginx.service`，并在配置变化时执行 restart。
- 移除旧 v3 声明专属的 `updater` 脚本和 nginx conf 模板。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: yes（生成示例集群的后续 nginx
  配置发布路径和服务重启流程会切换到当前 v4 内置管理行为）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

## Verification

- Targeted check:
  `deno run --quiet --allow-read src/cli.ts validate --config-root examples/eleph-server-multipass/clusters --cluster multipass`
- Result: passed
- Residual risk or follow-up: 本任务只做本地严格校验，不连接 Multipass VM；目标机实际配置发布和
  nginx 重启需在后续 deploy 时验证。
