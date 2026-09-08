---
task_manifest: task.yaml
status: approved
---

# 分阶段 App deploy 测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`，覆盖计划屏障、内置 stage/activate、历史兼容和文档契约。
- 子模块测试文档：无独立业务子模块；文件级分解见 `design.md`。
- 机器可读执行计划：`testplan.yaml`。

## Submodule Tests

任务在 sfo-deploy 模块内按文件级职责分解，不建立独立业务子模块；覆盖由 Unit/DV/Integration 表登记。

## Module-Level Tests

模块级行为由 `tests/unit/app_management_config.test.ts`、`tests/unit/history.test.ts`、
`tests/unit/history_regressions.test.ts`、`tests/dv/app_management_execution.test.ts`、
`tests/dv/execution.test.ts` 和 `tests/integration/versioned_release.test.ts` 覆盖。

## External Interface Tests

- deploy 计划契约：所有内置 versioned `stage` 先于所有 `activate`，activate 依赖全部 stage。
- 内置远端脚本契约：stage 不切 `latest`/不写当前标记；activate 消费已暂存版本并发布。
- 自定义 deploy、packageless App、环境 prepare 和旧发布快照语义保持不变。
- README 与配置指南描述两阶段、准备屏障、非分布式原子事务和 custom deploy 例外。

## Unified Test Entry

任务作用域统一入口为：
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/056-phased-app-deploy all`。
它执行 contract、unit、DV 和 integration 步骤并写出机器制品。

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | Gap? | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-phased-deploy-planning | design.md File-Level Interfaces、Key Flows | U1/C1/C2 | unit | U1 | no | - |
| CHG-phased-deploy-execution | design.md Overall Approach、State and Ownership | I1/U2/D1/C1 | integration | I1 | no | - |
| CHG-phased-deploy-docs-tests | design.md Risks and Rollback、Implementation Order | I2/C2/C3 | integration | I2 | no | - |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-phased-deploy-planning | normal | yes | U1 | unit | covered | - |
| CHG-phased-deploy-planning | boundary | yes | U1 | unit | covered | - |
| CHG-phased-deploy-planning | negative | yes | U1 | unit | covered | - |
| CHG-phased-deploy-planning | error | yes | U1 | unit | covered | - |
| CHG-phased-deploy-planning | compatibility | yes | U2/C1 | unit | covered | - |
| CHG-phased-deploy-planning | lifecycle | yes | I1 | integration | covered | - |
| CHG-phased-deploy-planning | cross-module | yes | C1/C2 | integration | covered | - |
| CHG-phased-deploy-execution | normal | yes | I1 | integration | covered | - |
| CHG-phased-deploy-execution | boundary | yes | I1 | integration | covered | - |
| CHG-phased-deploy-execution | negative | yes | I1 | integration | covered | - |
| CHG-phased-deploy-execution | error | yes | I1/D1 | dv | covered | - |
| CHG-phased-deploy-execution | compatibility | yes | U2 | unit | covered | - |
| CHG-phased-deploy-execution | lifecycle | yes | I1/D1 | integration | covered | - |
| CHG-phased-deploy-execution | cross-module | yes | D1 | dv | covered | - |
| CHG-phased-deploy-docs-tests | normal | yes | I2/C2 | integration | covered | - |
| CHG-phased-deploy-docs-tests | boundary | no | I1 | integration | covered | - |
| CHG-phased-deploy-docs-tests | negative | yes | C2/C3 | integration | covered | - |
| CHG-phased-deploy-docs-tests | error | no | I1 | integration | covered | - |
| CHG-phased-deploy-docs-tests | compatibility | yes | C3 | integration | covered | - |
| CHG-phased-deploy-docs-tests | lifecycle | no | I1 | integration | covered | - |
| CHG-phased-deploy-docs-tests | cross-module | yes | C2/C3 | integration | covered | - |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | design.md File-Level Interfaces | stage/activate、package、install_directory、run_as、keep_versions | unit | covered | - |
| state-transition | design.md State and Ownership | stage 只建版本目录；activate 切 latest/标记/清理 | integration | covered | - |
| failure-path | design.md Key Flows、Risks and Rollback | stage 失败阻断 activate；activate 标记失败回滚；执行器失败隔离 | dv | covered | - |
| error-handling | design.md Key Flows | 非法版本目录、包类型和计划动作 | integration | covered | - |
| invariant | design.md State and Ownership | custom deploy/packageless 不变；旧快照可读；服务在发布后收敛 | unit | covered | - |
| concurrency | design.md Design Notes | 串行执行、App/目标锁、release attempt | dv | covered | - |

## Unit Tests

| Function or Unit | Branch or Condition | Covered Behavior | Test File | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- |
| effectiveAppScripts/buildPlan | builtin/custom/packageless | builtin 生成 stage/activate；custom 不拆分 | tests/unit/app_management_config.test.ts | covered | - |
| phased activation barrier | stage zero/one/many | 所有 activate 依赖全部 stage | tests/unit/app_management_config.test.ts | covered | - |
| history codec | deploy/stage/activate 与旧 schema | 新旧计划快照可解码 | tests/unit/history.test.ts, tests/unit/history_regressions.test.ts | covered | - |

## DV Tests

| Workflow | Kind | Entry | Expected Result | Test File or Script | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| managed App 事务 | main | fake transport | 配置/unit 发布和 systemd 收敛语义保留 | tests/dv/app_management_execution.test.ts | covered | - |
| 执行器生命周期 | lifecycle | fake transport | 取消、失败隔离、清理和锁语义保留 | tests/dv/execution.test.ts | covered | - |
| 执行器失败恢复 | failure | fake transport | 单目标失败不掩盖恢复或清理错误 | tests/dv/app_management_execution.test.ts | covered | - |

## Integration Tests

| Contract or Flow | Modules Involved | Success Case | Failure Case | Test File | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| 内置发布生命周期 | planning/execution/remote runtime/filesystem | stage 不激活；activate 消费暂存版本；legacy deploy 可回放 | 非法包类型、路径或版本目录失败 | tests/integration/versioned_release.test.ts | covered | - |
| 文档与消费者契约 | planning/history/CLI/docs | plan/CLI 文本和文档一致 | 文档或 CLI 漂移 | tests/contract/verify_app_management_contract.ts | covered | - |

## Validation Rationale

风险档案 contract/data/security/runtime/harness 的 required_checks 分别由消费者编译、计划/历史往返、
最小权限脚本、stage/activate 行为和统一入口覆盖。`ui` 与 `build` 不适用；无第三方依赖变化。
真实多机 SSH/持久化 rollback 不是本地自动化验收范围，作为残余风险记录。

## Definition of Done

- [x] 任务作用域统一入口成功并生成 run artifact。
- [x] testplan 所有启用步骤与 contract checks 通过。
- [x] 每个 change_id 均有直接覆盖，无未解释 gap。
- [x] `deno task check`、`deno task lint`、格式检查通过。
