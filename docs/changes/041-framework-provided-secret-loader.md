# sfo-secret-loader 由 sfo-deploy 提供

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  `docs/versions/v0.1/modules/deployment-framework/041-framework-provided-secret-loader/task.yaml`
- Approved proposal:
  `docs/versions/v0.1/modules/deployment-framework/041-framework-provided-secret-loader/proposal.md`
- Affected paths: `examples/eleph-server-multipass/cluster-template/**`,
  `examples/eleph-server-multipass/clusters/**`, `tests/integration/**`,
  `tests/contract/verify_independent_remote_scripts.ts`, `README.md`,
  `docs/guides/sfo-deploy-cluster-configuration.md`, `examples/eleph-server-multipass/README.md`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

保留 `src/execution.ts` 现有运行时上传行为：需要秘密的 Deno 步骤从 `src/secret_loader/deno.ts`
上传真实文件为远端 workspace 内的 `sfo-secret-loader.ts`。集群模板不再包含根级
loader，脚本目录也不再放置薄封装。示例脚本继续使用
`./sfo-secret-loader.ts`，该相对导入只描述远端上传后的布局。

集成测试和契约验证改为模拟“loader 已由框架上传”的 workspace：脚本旁边放置
`src/secret_loader/deno.ts` 的副本。文档和检查器明确集群目录不得定义该文件。

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

若任何答案变为 `yes`，在此记录证据；如改变已确认需求或范围，先回到提案并重新确认。

## Verification

- Targeted check:
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/integration/independent_remote_scripts.test.ts tests/integration/secret_loader_contract.test.ts`；`deno run --allow-read --allow-write --allow-run --allow-env tests/contract/verify_independent_remote_scripts.ts closure`；`deno run --allow-read --allow-write --allow-run --allow-env tests/contract/verify_environment_placement_config.ts docs`；定向
  `deno lint`
- Result: passed
- Residual risk or follow-up: none
