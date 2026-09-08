# 允许首次部署时受管 systemd unit not-found

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/063-fix-systemd-initial-state/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/063-fix-systemd-initial-state/proposal.md
- Affected paths: src/service_management.ts, tests/unit/service_management.test.ts, tests/dv/app_management_execution.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

`systemctl is-enabled` 对不存在的 unit 输出 `not-found` 并返回退出码 4。首次
部署在 managed unit 发布前读取状态，这是合法状态而不是传输或权限故障。状态
读取器将这一明确组合解释为 `enabled=false`、`active=false`，让执行器继续走
现有 managed unit 发布、`daemon-reload`、enable 和 `on_deploy` 收敛路径。
其他退出码或未知输出仍保持失败关闭。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: yes
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

说明：该修复只放宽 `systemctl` 明确输出的 `not-found` 组合，用于首次受管服务
发布；其他 systemd 状态和后续收敛要求保持失败关闭。

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/service_management.test.ts tests/dv/app_management_execution.test.ts`；`deno task check`；`deno task lint`；`deno fmt --check src tests`；`deno task test`；`git diff --check`
- Result: passed
- Residual risk or follow-up: 真实 Multipass 部署不在本地自动化范围内；重新部署
  时可确认端到端结果。
