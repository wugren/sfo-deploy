# 修复 activate 阶段发布受管 systemd unit

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/062-fix-activate-service-unit/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/062-fix-activate-service-unit/proposal.md
- Affected paths: src/execution.ts, tests/dv/app_management_execution.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

内置 versioned App 的 deploy 已拆分为 `stage` 与 `activate`，计划在
`activate` 中保留 `management.service` 和 `unit_config`，但执行器只对
`deploy/configure/start/stop/restart` 解析 service，因此首次部署不会发布
systemd unit，后续 restart 读取 enable 状态时得到 `not-found`。

本次把 `activate` 加入执行器的 service 动作集合。unit 候选继续由
`systemd_unit.ts` 渲染，并复用 managed config 的候选生成、批量发布、
`daemon-reload`/`enable`/`restart` 收敛和失败补偿路径。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: yes
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

说明：本修复改变 `activate` 对既有 `unit_config` 的运行时处理，使计划语义与
执行语义一致；不改变计划 schema、unit 渲染、阶段顺序或 systemd 补偿状态机。

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/dv/app_management_execution.test.ts`；
  `deno check --frozen src/mod.ts src/main.ts src/cli.ts src/remote_runtime/config_updater.ts`；
  `deno fmt --check src tests`；`deno task lint`；`deno task test`
- Result: passed
- Residual risk or follow-up: 本任务未执行真实 Multipass deploy；重新部署时应由
  `activate` 输出和远端 `systemctl is-enabled jx-server.service` 确认修复。
