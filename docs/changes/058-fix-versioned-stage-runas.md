# Fix versioned stage run_as snapshot validation

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/058-fix-versioned-stage-runas/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/058-fix-versioned-stage-runas/proposal.md
- Affected paths: src/history.ts, tests/unit/history_regressions.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

内置 versioned App 的 deploy 计划会让 `stage` 步骤只携带
package/deployment/install_directory/run_as，而 `management` 缺省。发布快照
校验此前只把 `management` 视为允许 `run_as` 的条件，导致合法 stage 在保存
快照时失败。本次只在 App stage 且 `deployment.kind: versioned` 的组合上开放
身份声明，并继续强制规范非 root `run_as`；普通非 managed 步骤仍拒绝。

该修复不改变 plan-v4 字段结构、部署顺序、远端执行器或回退推导算法。
stage 快照仍会写入空的 lifecycle secret 字段，因此完整的 plan-v4 新字段组
约束不变；旧快照中同类的非 versioned/非 stage `run_as` 仍失败关闭。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

说明：这是部署计划快照校验的运行时缺陷修复。虽然其作用位置在 deploy 流程，
但不扩大身份权限边界，不改变持久 schema、执行顺序或回退行为；受影响行为
可由发布快照往返测试直接验证。

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/history_regressions.test.ts`；
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/history.test.ts`；
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/app_management_config.test.ts`；
  `deno fmt --check src tests`；`deno task lint`；`deno task test`；
  `deno check --frozen src/mod.ts src/main.ts src/cli.ts src/remote_runtime/config_updater.ts`
- Result: passed
- Residual risk or follow-up: 真实 Multipass 目标机上的完整部署未在本任务
  中执行；应在下一次实际 deploy 中验证 stage -> activate -> restart。
