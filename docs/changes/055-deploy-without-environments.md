# deploy 只处理 App 的变更记录

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  docs/versions/v0.1/modules/deployment-framework/055-deploy-without-environments/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/deployment-framework/055-deploy-without-environments/proposal.md
- Affected paths:
  src/planning.ts、src/integration.ts、src/cli.ts、tests/unit/config_planning.test.ts、tests/unit/deploy_confirm.test.ts、tests/unit/app_management_config.test.ts、tests/integration/environment_placement.test.ts、README.md、docs/guides/sfo-deploy-cluster-configuration.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

`buildPlan` 在 `action: deploy` 时不创建 environment 节点，并把 App
对环境的依赖从执行依赖中移除；因此 `deploy` 和作为 deploy 预览的 `plan` 只包含 App
步骤。`RunOptions` 对 `deploy`/`plan` 拒绝 `--environment` 与
`--with-dependencies`，在配置校验期失败，不建立 SSH 连接。CLI 帮助、README
和集群配置指南同步说明环境准备仍由 `prepare` 负责。

## Risk Screen

- Public contract, protocol, or CLI change: yes（`deploy`/`plan`
  计划语义变化；`deploy --environment` 和 `deploy --with-dependencies` 从可执行变为配置错误）
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: yes（依赖自动化 deploy
  部署环境的脚本需要改用 prepare；新 deploy 快照不再包含环境检查步骤）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

风险已按 approved standard proposal 记录为兼容性/顺序风险；没有发现需要升级 tier
的新增安全、数据或跨项目边界。

## Verification

- Targeted check:
  `deno task test`、`deno task check`、`deno task lint`、`deno task fmt`、`tests/contract/verify_cli_output_docs.ts`、`verify_environment_placement_config.ts docs/closure`、multipass
  `plan` 探针和 `--environment` 拒绝探针
- Result: passed
- Residual risk or follow-up: 用户忘记先运行 prepare 时，deploy 不会预检环境；App
  可能在远端执行阶段因缺少依赖环境失败。旧 deploy 快照仍按其归档内容回放。
