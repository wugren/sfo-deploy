# 修复 versioned 空 management 快照解码

- Status: complete
- Owner module: deployment-framework
- Task manifest: docs/versions/v0.1/modules/deployment-framework/060-fix-empty-versioned-management/task.yaml
- Approved proposal: docs/versions/v0.1/modules/deployment-framework/060-fix-empty-versioned-management/proposal.md
- Affected paths: src/history.ts, tests/unit/history_regressions.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

schema v4 的 versioned App 允许 `management.actions: []`，以便只声明部署运行账号；
但发布快照解码器把 configs、service、hooks 全空的 management 一律判定为非法，
导致确认后的 deploy 在读取 activate 步骤时失败。本次把快照解码器与 v4 装载
规则对齐：只有声明 versioned deployment 且已提供 run_as 的步骤才接受空
management 声明。不改变计划顺序、执行语义、发布快照字段或非 versioned
App 的空声明限制。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: yes
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

持久化字段集合不变；这是装载器和快照解码器对同一已允许配置的一致性修复。
旧格式仍保持兼容，新解码只放宽“versioned + run_as”的空声明组合。

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/history_regressions.test.ts`；
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/history.test.ts`；
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/app_management_config.test.ts`；
  `deno check --frozen src/mod.ts src/main.ts src/cli.ts src/remote_runtime/config_updater.ts`；
  `deno fmt --check src tests`；`deno task lint`；`deno task test`
- Result: passed
- Residual risk or follow-up: 真实 Multipass 部署目标机未在本任务中重新执行；
  后续部署时由实际 stage/activate 流程确认端到端结果。
