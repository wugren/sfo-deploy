# Multipass jx-server 改为 systemd service 启动

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/054-jx-server-systemd-start/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/054-jx-server-systemd-start/proposal.md
- Affected paths: examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml,
  examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml,
  examples/eleph-server-multipass/cluster-template/apps/nginx/scripts/update-config.ts,
  examples/eleph-server-multipass/cluster-template/apps/nginx/templates/nginx.conf.tpl,
  examples/eleph-server-multipass/README.md, tests/contract/verify_app_management_contract.ts,
  tests/contract/verify_independent_remote_scripts.ts, tests/integration/deploy_version_skip.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- 将 `jx-server` 迁移到 App schema v4，用 `management.actions[kind: service]` 声明
  `jx-server.service`。
- 通过 `unit_config` 把工作目录设为 `current/app`，命令解析为
  `/usr/bin/java -jar /home/ubuntu/eleph-server/current/app/jx-server.jar`，由 systemd
  在每次启动时跟随 `latest` 软链。
- 设置 `enabled: true`、`daemon_reload: true`、`on_deploy: restart`，让框架在部署事务中发布
  unit、重载 systemd 并重启服务。
- 移除 v4 不支持的 `after_deploy` hook 和不再被引用的
  `verify-deploy.ts`；版本发布脚本已在成功路径原子切换 `latest` 并写版本标记。
- 同步 template 与 live 集群副本，更新 README 中 App schema、部署后启动和生命周期命令说明。
- 清理 053 已声明不再使用的 template-side nginx updater 脚本与旧 conf 模板，使 template/live
  远端脚本集合一致。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: yes
  - Multipass 示例的 jx-server 部署行为从“只发布”改为“发布后由 systemd
    收敛”。这是本次用户请求的预期行为，框架实现不变。
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

If any answer becomes `yes`, record the evidence. When it changes the confirmed requirement, scope,
or acceptance boundary, return the existing packet's `proposal.md` to draft, recommend the
appropriate tier, and obtain proposal/tier reconfirmation before further project mutation. When it
is newly discovered risk inside the unchanged confirmed scope, keep the user-selected tier and
record the residual risk instead of silently upgrading.

Answer `yes` only for confirmed material consequences. A documentation/configuration change or
matching path alone is not sufficient; documentation-only and configuration-only corrections remain
lower-tier when they do not change governed intent or runtime behavior.

If an explicit current-user lower-tier override applies, record the user's instruction in
`Explicit tier override`, keep the selected tier, and describe the known risk under
`Residual risk or follow-up`.

## Verification

- Targeted check: `python3 harness/scripts/test-run.py --scope unit/integration/contract`
- Result: pending
- Residual risk or follow-up: 真实 Multipass VM 上的 Java 路径、JAR
  启动行为和服务健康状态仍需用户执行真实部署验收。
