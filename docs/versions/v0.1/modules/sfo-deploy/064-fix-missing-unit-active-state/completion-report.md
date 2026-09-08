# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/064-fix-missing-unit-active-state.md

## Delivery Summary

- Outcome: 缺失 managed unit 的状态基线现在覆盖 Ubuntu 的实际输出组合：
  `systemctl is-enabled` 返回 `not-found`/exit 4，且 `systemctl is-active`
  返回 `inactive` 或 `not-found`/exit 4。该组合被解释为未启用且未运行，
  `activate` 会继续发布 unit 并通过现有 `daemon-reload`、enable 和 restart
  收敛。
- Handoff: 可重新执行 Multipass `deploy` 验证真实远端首次服务发布。本任务
  只完成本地执行级和全量自动化验证；实际远端状态应在下一次部署时确认。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-missing-unit-active-state | 仅在 enabled 确认缺失时接受 active `inactive`/exit 4 | proposal.md P-001 | `src/service_management.ts:191` 将缺失 active 判定绑定到 `isMissingUnit`，并只接受 `inactive` 或 `not-found`；单元测试保留异常输出拒绝 | matches | pass |
| CHG-missing-unit-active-state | 缺失 unit 的 activate 继续发布并收敛 | proposal.md P-002 | 执行级测试模拟 enabled `not-found`/exit 4、active `inactive`/exit 4，断言 unit 发布、daemon-reload、enable、restart 和 `enabled/active` 结果 | matches | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `readState`、`inspectSystemd`、`convergeSystemd`、`restoreSystemd` 调用链和 managed config 事务；diff 审阅 | 追踪 enabled 与 active 两阶段查询、unit 发布、失败补偿和收敛结果，确认 active 判定不能脱离 enabled 缺失基线单独成立 | 首次部署顺序与提案一致；服务和配置仍走既有单一事务/补偿状态机 | pass |
| boundaries-and-failure-paths | Ubuntu 真实 `not-found`/exit 4 与 `inactive`/exit 4 输出、已有 unit 状态、异常输出和恢复相关测试 | 检查 enabled `failed`、active `failed`、以及 enabled disabled 而 active exit 4 的情况仍失败；确认发布后未收敛仍由 enable/active 检查失败 | 状态识别未掩盖未知 systemd、权限或应用启动故障 | pass |
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
- Reason: 交付与已确认提案一致；Ubuntu 缺失 unit 的实际 active 输出、失败关闭
  边界和 activate 收敛均有回归覆盖，全量测试与静态检查通过。
