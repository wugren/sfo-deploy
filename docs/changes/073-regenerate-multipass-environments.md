# 重新生成 multipass 环境配置

- Status: complete
- Owner module: sfo-deploy
- Task manifest:
  docs/versions/v0.1/modules/sfo-deploy/073-regenerate-multipass-environments/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/sfo-deploy/073-regenerate-multipass-environments/proposal.md
- Affected paths: examples/eleph-server-multipass/cluster-template/environments/**,
  examples/eleph-server-multipass/README.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

将 multipass 模板环境从旧顶层 `scripts` 生命周期迁移为新 `install`/`manager` 生命周期。包管理器
和服务工具优先使用 `auto`；Nginx 使用内置 package/system。JRE、Redis 与 MySQL 的跨发行版包名或
服务名差异由新契约内的自包含 TypeScript 脚本探测，仍调用 apt-get/yum 或 systemctl。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

If any answer becomes `yes`, record the evidence. When it changes the confirmed requirement, scope,
or acceptance boundary, return the existing packet's `proposal.md` to draft, recommend the
appropriate tier, and obtain proposal/tier reconfirmation before further project mutation. When it
is newly discovered risk inside the unchanged confirmed scope, keep the user-selected tier and
record the residual risk instead of silently upgrading. If the user reconfirms `high-risk`, set
`Status: upgraded`, update the existing `task.yaml`, add the risk profile and downstream lifecycle
artifacts to the same packet, record that expansion above, and continue from the earliest
responsible stage.

Answer `yes` only for confirmed material consequences. A documentation/configuration change or
matching path alone is not sufficient; documentation-only and configuration-only corrections remain
lower-tier when they do not change governed intent or runtime behavior.

If an explicit current-user lower-tier override applies, record the user's instruction in
`Explicit tier override`, keep the selected tier, and describe the known risk under
`Residual risk or follow-up`.

## Verification

- Targeted check: `deno task check`；环境脚本 `deno check/lint/fmt --check`；临时模板
  `sfo-deploy validate` 与三个 App 的 `sfo-deploy plan`；环境管理相关单元测试和契约检查；
  `git diff --check`。
- Result: passed
- Residual risk or follow-up: 本地配置验证不证明 CentOS/Ubuntu 真实软件源、包安装、服务启动或 App
  部署成功。
