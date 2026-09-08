# 新增 Multipass Nginx 环境

- Status: complete
- Owner module: deployment-framework
- Task manifest: docs/versions/v0.1/modules/deployment-framework/061-add-nginx-environment/task.yaml
- Approved proposal: docs/versions/v0.1/modules/deployment-framework/061-add-nginx-environment/proposal.md
- Affected paths: examples/eleph-server-multipass/cluster-template/**, examples/eleph-server-multipass/clusters/multipass/**, examples/eleph-server-multipass/README.md, tests/integration/environment_placement.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

沿用现有 environment 模式：新增 packageless `nginx` 环境只提供 `check` 和 `install`。检查使用
`/usr/bin/test -x /usr/sbin/nginx`；安装通过 APT 的 `--no-install-recommends nginx` 完成。模板和当前
生成集群同步更新，避免必须重跑 Multipass prepare 才能使用新环境。CLI 的 `plan` 只处理 App，因此
环境安装证据使用 `check --env nginx` 和 `prepare --env nginx`。nginx App 保持只负责配置发布与
systemd 服务管理，软件安装继续由 `prepare --env nginx` 显式触发。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

`prepare` 会显式访问 APT 源并改变目标机软件包状态，但这正是用户请求的边界内行为；`deploy` 不会隐式
安装环境。APT 安装使用 Ubuntu 当前可用版本，不新增版本锁定契约。

## Verification

- Targeted check: `src/cli.ts validate`、`check --env nginx`、`prepare --env nginx`、
  `environment_placement`/`env_prepare_cli` 相关测试、新环境脚本 `deno check`、
  `deno fmt --check` 和 `deno lint`。
- Result: passed
- Residual risk or follow-up: nginx 环境已在真实 Multipass 目标机安装并复查通过；本次未重跑 nginx App 的
  `deploy`，可在需要时执行 `deno task eleph-deploy deploy --cluster multipass --app nginx --yes`。
