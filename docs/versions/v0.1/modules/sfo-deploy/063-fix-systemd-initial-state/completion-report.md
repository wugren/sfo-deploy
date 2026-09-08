# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/063-fix-systemd-initial-state.md

## Delivery Summary

- Outcome: systemd 状态读取器现在把 `systemctl is-enabled` 明确返回的
  `not-found` 解释为受管 unit 缺失的合法基线。首次 `activate` 可以继续发布
  managed unit，并通过现有 `daemon-reload`、enable 和 `on_deploy` 收敛路径把
  服务收敛到声明状态；`systemctl is-active` 明确的 `not-found` 也视为未运行。
- Handoff: 可重新执行 Multipass `deploy` 验证真实远端首次服务发布。本任务只
  完成执行级与全量本地自动化验证；实际远端状态应在下一次部署时确认。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-systemd-initial-state | 首次部署允许受管 unit `not-found`，但不忽略未知错误 | proposal.md P-001 | `src/service_management.ts:190` 只放宽退出码 4 且输出为 `not-found` 的组合；unit 测试同时断言 `failed` 输出仍失败 | matches | pass |
| CHG-systemd-initial-state | 缺失 unit 的 activate 继续发布并收敛 | proposal.md P-002 | `tests/dv/app_management_execution.test.ts` 模拟首个状态读取为真实退出码 4，断言 unit 发布、daemon-reload、enable、restart 和 `enabled/active` 结果 | matches | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `inspectSystemd`、`convergeSystemd`、`restoreSystemd` 调用链和执行器 managed config 事务；diff 审阅 | 追踪首次部署的读取顺序和失败恢复顺序，确认 unit 缺失基线不会跳过发布、enable 或声明动作 | 交付语义与提案一致；unit 发布、收敛和补偿仍走既有单一状态机 | pass |
| boundaries-and-failure-paths | `not-found`、`failed`、unknown output、发布后仍缺失、失败恢复相关测试与远端真实命令输出 | 检查 exit 4/output `not-found` 被接受，而 exit 4/output `failed` 和 active 异常仍拒绝；发布后未收敛仍由 enable/active 收敛检查失败 | 状态识别未掩盖权限、systemd 或应用启动故障 | pass |
| regression-and-side-effects | 全量 Deno 测试、类型检查、lint、格式检查和 diff 空白检查 | 检查 stage/activate/restart 顺序、versioned release、已有服务生命周期、CLI/配置契约和回退行为未变化 | 248 passed / 0 failed；所有检查通过，未发现公共契约或部署顺序变化 | pass |

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/service_management.test.ts tests/dv/app_management_execution.test.ts`；`deno task check`；`deno task lint`；`deno fmt --check src tests`；`deno task test`；`git diff --check`
- Result: passed
- Exception reason: not-applicable

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-1 | low | completion-report.md Delivery Summary 与 Handoff | 未执行真实 Multipass deploy，不能在本任务中确认远端 systemd unit 状态 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与已确认提案一致；首次 `not-found` 分支和失败关闭边界均有回归
  覆盖，全量测试、类型、lint、格式和 diff 检查通过。
