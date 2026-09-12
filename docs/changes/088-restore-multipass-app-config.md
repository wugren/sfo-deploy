# 恢复 Multipass App 配置

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/088-restore-multipass-app-config/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/088-restore-multipass-app-config/proposal.md
- Affected paths: examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml、jx-server/application.yml、jx-server/application-local.yml、jx-web/app.yaml、jx-web/templates/jx-web.conf
- Explicit tier override: 用户确认“按简单任务恢复”，采用 standard
- Expanded high-risk packet: none

## Approach

恢复源为 `/tmp/opencode/multipass-fixed/apps` 的 2026-09-11 22:01 副本。
恢复前将当前 apps 和恢复源分别复制到 `.harness/recovery/088-restore-multipass-app-config/before-apps`
和 `source-apps`，备份根权限为 0700。恢复五文件后依据 084 变更记录将
working_directory 改为 `${LATEST_DIRECTORY}`；两个业务配置文件设为 0600。
只改本地 apps，不修改模板、prepare、机器配置及密钥，不执行部署。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: yes
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

恢复会改变后续部署的安装目录及服务参数，已在提案告知；按用户选择 standard 执行。
业务配置不输出秘密、不提交 Git；备份根目录限制访问。

## Verification

- Targeted check: `deno run --quiet --allow-read --allow-env=HOME,USERPROFILE src/cli.ts validate --config-root examples/eleph-server-multipass/clusters --cluster multipass`
- Result: passed

1 台机器、4 个环境实例、2 个 App 配置校验通过。
- Residual risk or follow-up: 候选副本不能证明等于覆盖前最后一刻；未恢复未知后续修改。
  没有执行真实部署；再次运行 prepare 仍会覆盖本地 apps。
