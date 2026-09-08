# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/062-fix-activate-service-unit.md

## Delivery Summary

- Outcome: 内置 versioned App 的 `activate` 阶段现在会解析
  `management.service`，把 `unit_config` 生成的 systemd unit 加入 managed
  config 事务发布，并执行 `daemon-reload`、`enable` 和 `on_deploy: restart`。
  首次部署中 unit 先处于 `not-found/inactive`、发布后收敛为
  `enabled/active` 的路径已被执行级回归覆盖。
- Handoff: 可重新执行 Multipass `deploy`。本任务只完成本地执行级和全量自动
  化验证；实际远端状态应在下一次部署时确认。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-activate-service-unit | `activate` 发布 `unit_config` 生成的 systemd unit | proposal.md P-001 | `src/execution.ts` 将 `activate` 加入 service 解析；`tests/dv/app_management_execution.test.ts` 断言 unit 候选进入发布批次 | matches | pass |
| CHG-activate-service-unit | `activate` 遵循 systemd 收敛字段并覆盖首次部署状态转换 | proposal.md P-002 | 回归测试模拟 `not-found/inactive`，断言 `daemon-reload`、`enable`、`restart` 后结果为 `enabled/active` | matches | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | 执行器 service 解析、unit config 生成、managed config 发布和 systemd 收敛路径；diff 审阅 | 确认 `activate` 只消费计划中已有的 managed service 数据；检查没有把 service 加回 `stage`，也没有额外触发第二次重启 | 交付与计划语义一致；service 收敛每类副作用仍至多执行一次 | pass |
| boundaries-and-failure-paths | 首次部署 `not-found`、已有 unit、发布变更和失败恢复相关测试 | 检查 missing unit 状态是否被接受、发布后 enable 是否收敛、发布失败是否仍进入现有恢复路径 | 首次部署路径通过；systemd 服务管理的既有失败收敛与补偿测试未回归 | pass |
| regression-and-side-effects | `deno task test` 全部 247 个测试、`deno task lint`、Deno 类型检查和格式检查 | 检查 stage/activate/restart 顺序、versioned release、计划快照、回退行为和 CLI/配置契约 | 247 passed / 0 failed；lint、类型检查和格式检查通过；未发现计划格式、部署顺序或回退行为变化 | pass |

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/dv/app_management_execution.test.ts`；`deno check --frozen src/mod.ts src/main.ts src/cli.ts src/remote_runtime/config_updater.ts`；`deno fmt --check src tests`；`deno task lint`；`deno task test`
- Result: passed
- Exception reason: not-applicable

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-1 | low | completion-report.md Delivery Summary 与 Handoff | 未执行真实 Multipass deploy，不能在本任务中确认远端 systemd 状态 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与已确认提案一致；执行级回归覆盖 unit 发布、首次 enable 和
  systemd 收敛，全量测试、lint、类型与格式检查通过。
