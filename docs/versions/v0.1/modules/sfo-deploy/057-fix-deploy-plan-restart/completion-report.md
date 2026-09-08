# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/057-fix-deploy-plan-restart.md

## Delivery Summary

- Outcome: builtin versioned App 的 deploy 计划现在接受受管 service 生成的
  `restart` 步骤；phased deploy 推导出的 rollback 计划也接受其现有的
  `stage`/`activate` 步骤。deploy 与 rollback 校验白名单分别与计划生成器和
  `deriveRollbackPlan` 的既有输出一致，白名单之外的步骤仍被拒绝。
- Handoff: 后续可重新执行 Multipass `deploy`。本任务只做本地计划/快照校验
  和自动化测试，未连接 VM；实际 stage、activate 和 systemd restart 行为应
  由该部署运行验证。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-fix-deploy-plan-restart | deploy 计划中的 App `restart` 步骤可被持久化校验接受 | proposal.md P-001 | `PLAN_STEP_ACTIONS.deploy.app` 包含 `restart`；`unit/history codec: phased deploy accepts managed restart` 通过 `archivePlans` 并解码出 `stage -> activate -> restart` | matches | pass |
| CHG-fix-deploy-plan-restart | rollback 计划中的 App `stage`/`activate` 步骤可被持久化校验接受 | proposal.md P-002 | `PLAN_STEP_ACTIONS.rollback.app` 包含 `stage` 和 `activate`；同一定向测试在 `archivePlans` 中完成实际与 rollback 快照编码、完整性校验和读取 | matches | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `src/history.ts` 白名单、`archivePlans`/`deriveRollbackPlan`、planning 的 phased 步骤生成、定向历史回归 | 检查 deploy 是否只新增执行器实际生成的 restart；检查 rollback 是否只接受现有推导保留的 stage/activate；运行全量测试确认 phase 屏障、恢复和执行顺序未变 | 定向测试显示 phased deploy 可完成计划归档，旧 rollback 推导可被编码；未发现执行顺序或 rollback 目标变化 | pass |
| boundaries-and-failure-paths | deploy 白名单反例测试、snapshot integrity/tamper 测试、operation lock 测试和快照一致性测试 | 用 `stop` 动作确认 deploy 白名单仍 fail closed；检查失败 attempt、篡改快照、未登记文件、动作不一致和锁争用仍被拒绝 | deploy 非法动作抛出预期 `ConfigurationError`；历史/快照错误路径未因白名单扩展放宽 | pass |
| regression-and-side-effects | `deno task test` 全部 244 个测试、`deno task lint`、Deno 类型检查和格式检查 | 检查计划 schema、发布历史格式、CLI、环境部署、配置管理、packageless、versioned release 与旧快照兼容性 | 244 passed / 0 failed；lint、类型检查和格式检查通过；未发现计划 schema、历史格式或非目标行为回归 | pass |

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/history_regressions.test.ts`；`deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/history.test.ts`；`deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/app_management_config.test.ts`；`deno check --frozen src/mod.ts src/main.ts src/cli.ts src/remote_runtime/config_updater.ts`；`deno fmt --check src tests`；`deno task lint`；`deno task test`
- Result: passed
- Exception reason: not-applicable

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-1 | low | completion-report.md Delivery Summary 与 Handoff | 未执行真实 Multipass deploy，无法在本任务中确认远端 systemd restart 结果 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与已确认提案一致；定向回归覆盖合法 phased deploy/rollback 计划和非法动作反例，全量测试、lint、类型与格式检查通过。
