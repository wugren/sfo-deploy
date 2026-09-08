# Fix deploy plan managed restart whitelist

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/057-fix-deploy-plan-restart/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/057-fix-deploy-plan-restart/proposal.md
- Affected paths: src/history.ts, tests/unit/history_regressions.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

内置 versioned deploy 会为声明受管 systemd service 的 App 生成 `restart`
阶段；phased rollback 推导也会保留 `stage/activate`。快照编码前的计划语义
校验沿用旧白名单，分别漏掉这些合法步骤。本次让 deploy/rollback 白名单与现有
计划生成和推导结果一致；不改变执行、推导或回退算法。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

说明：这是部署计划校验的运行时缺陷修复，但不改变计划 schema、发布历史格式、
执行顺序或回退推导算法；旧快照仍可读取，rollback 白名单只接受现有推导已
生成的 stage/activate 步骤，不扩大回退目标。

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/history_regressions.test.ts`；
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/history.test.ts`；
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/app_management_config.test.ts`；
  `deno check --frozen src/mod.ts src/main.ts src/cli.ts src/remote_runtime/config_updater.ts`；
  `deno fmt --check src tests`；`deno task lint`；`deno task test`
- Result: passed
- Residual risk or follow-up: 真实 Multipass 部署目标机行为未在本任务执行；
  需要在后续部署时由实际 stage/activate/restart 流程验证。
