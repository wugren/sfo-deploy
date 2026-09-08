# 识别 Ubuntu 缺失 unit 的 inactive/exit 4 状态

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/064-fix-missing-unit-active-state/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/064-fix-missing-unit-active-state/proposal.md
- Affected paths: src/service_management.ts, tests/unit/service_management.test.ts, tests/dv/app_management_execution.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

Ubuntu systemd 对缺失 unit 的行为是：`systemctl is-enabled` 返回
`not-found`/exit 4，`systemctl is-active` 返回 `inactive`/exit 4。状态读取器
现在以 enabled 查询明确确认 unit 缺失为前提，接受 active 查询的
`inactive` 或 `not-found` 且 exit 4 组合，并将其解释为未运行。随后仍复用
managed unit 发布、`daemon-reload`、enable 和 `on_deploy` 收敛路径。其他
退出码或输出继续失败关闭。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: yes
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

说明：active 的异常不会被单独放宽；必须在同一状态读取中先确认 unit 的
`not-found` 基线。

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/service_management.test.ts tests/dv/app_management_execution.test.ts`；`deno task check`；`deno task lint`；`deno fmt --check src tests`；`deno task test`；`git diff --check`
- Result: passed
- Residual risk or follow-up: 真实 Multipass deploy 不在本地自动化范围；修复后
  可由用户重新执行部署确认远端结果。
