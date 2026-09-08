---
task_manifest: task.yaml
status: draft
---

# 旧版本自动清理测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；文件级覆盖见单元/集成测试表。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

本任务通过统一入口运行：`harness/scripts/test-run.py`（快捷方式 `test-run.sh`/`test-run.bat`），
任务作用域命令
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/027-old-version-cleanup all`，
先执行 contract steps，再按 unit/dv/integration 执行任务测试。

## Submodule Tests

本任务按文件级分解（用户配置、执行 metadata、示例清理脚本），无独立业务子模块，不建立 submodule
测试文档。

## Module-Level Tests

执行链整体由 `tests/dv/execution.test.ts` 与 `tests/integration/deploy_version_skip.test.ts`
覆盖：配置值从用户配置进入执行器，注入 metadata，再由脚本消费并完成清理。

## External Interface Tests

用户配置契约（`keep_versions` 默认/合法/非法）由 `tests/unit/user_config.test.ts` 验证；远端脚本输入
契约（metadata.keep_versions）由 DV 与集成测试验证；文档契约由 contract docs 步骤验证。

## Direct Change Coverage

| change_id                    | design_source                               | validation_id       | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ---------------------------- | ------------------------------------------- | ------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-version-retention-config | design.md File-Level Interfaces / Key Flows | VAL-1, VAL-2, VAL-3 | unit           | U1               | no  | -                 |
| CHG-cleanup-execution        | design.md State and Ownership / Key Flows   | VAL-4               | integration    | I1               | no  | -                 |
| CHG-cleanup-docs             | design.md Consumer Migration Closure        | VAL-5               | integration    | I2               | no  | -                 |

## Case-Type Coverage

| change_id                    | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| ---------------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-version-retention-config | normal        | yes      | VAL-1         | unit        | covered | -                 |
| CHG-version-retention-config | boundary      | yes      | VAL-1         | unit        | covered | -                 |
| CHG-version-retention-config | negative      | yes      | VAL-2         | dv          | covered | -                 |
| CHG-version-retention-config | error         | yes      | VAL-3         | dv          | covered | -                 |
| CHG-version-retention-config | compatibility | yes      | VAL-1         | unit        | covered | -                 |
| CHG-version-retention-config | lifecycle     | no       | VAL-4         | integration | covered | -                 |
| CHG-version-retention-config | cross-module  | yes      | VAL-4         | integration | covered | -                 |
| CHG-cleanup-execution        | normal        | yes      | VAL-4         | integration | covered | -                 |
| CHG-cleanup-execution        | boundary      | yes      | VAL-4         | integration | covered | -                 |
| CHG-cleanup-execution        | negative      | yes      | VAL-4         | integration | covered | -                 |
| CHG-cleanup-execution        | error         | yes      | VAL-4         | integration | covered | -                 |
| CHG-cleanup-execution        | compatibility | no       | VAL-4         | integration | covered | -                 |
| CHG-cleanup-execution        | lifecycle     | yes      | VAL-4         | integration | covered | -                 |
| CHG-cleanup-execution        | cross-module  | yes      | VAL-4         | integration | covered | -                 |
| CHG-cleanup-docs             | normal        | yes      | VAL-5         | integration | covered | -                 |
| CHG-cleanup-docs             | boundary      | no       | VAL-5         | integration | covered | -                 |
| CHG-cleanup-docs             | negative      | no       | VAL-5         | integration | covered | -                 |
| CHG-cleanup-docs             | error         | no       | VAL-5         | integration | covered | -                 |
| CHG-cleanup-docs             | compatibility | yes      | VAL-5         | integration | covered | -                 |
| CHG-cleanup-docs             | lifecycle     | no       | VAL-5         | integration | covered | -                 |
| CHG-cleanup-docs             | cross-module  | yes      | VAL-5         | integration | covered | -                 |

说明：contract steps 由统一入口按 integration 前置阶段执行，表中以 integration 作为其 level。

## Design Element Coverage

| element_type     | design_source                                          | derived_cases                                                 | level       | status  | gap_manual_reason |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------- | ----------- | ------- | ----------------- |
| parameter-domain | design.md File-Level Interfaces（keep_versions 1-100） | 默认 5、3/100 合法、0/-1/101/2.5/字符串拒绝                   | unit        | covered | -                 |
| state-transition | design.md State and Ownership                          | 成功→published→cleanup；失败/回滚/跳过→不清理                 | integration | covered | -                 |
| failure-path     | design.md Key Flows                                    | 健康失败不清理、清理时 rm 失败抛错                            | integration | covered | -                 |
| error-handling   | design.md Risks and Rollback                           | 非法 keep_versions 在执行器构造与用户配置处拒绝               | dv          | covered | -                 |
| invariant        | design.md Design Notes                                 | latest/当前版本与 VERSION 标记匹配目录永不删除；data 目录保留 | integration | covered | -                 |
| concurrency      | design.md State and Ownership                          | 清理在写标记后单线程执行，无并发窗口                          | integration | covered | -                 |

## Validation Rationale

风险档案 required_checks 全部映射到可运行验证：contract/data/security 由 U1/I1 覆盖配置与删除边界；
runtime 由 I1 覆盖成功/失败生命周期；harness 由统一入口任务作用域与 contract steps 覆盖。

## Unit Tests

| function_or_unit                   | branch_or_condition     | covered_behavior                           | test_file                      | status  | gap_manual_reason |
| ---------------------------------- | ----------------------- | ------------------------------------------ | ------------------------------ | ------- | ----------------- |
| loadConfigFile / keepVersionsValue | 缺失/合法/非法值        | keep_versions 默认 5、边界 1/100、非法拒绝 | tests/unit/user_config.test.ts | covered | -                 |
| SfoDeployUserConfig                | schema 不变与新字段共存 | packages_dir 与 keep_versions 同时装载     | tests/unit/user_config.test.ts | covered | -                 |

## DV Tests

| workflow             | kind      | entry                                                 | expected_result                        | test_file_or_script        | status  | gap_manual_reason |
| -------------------- | --------- | ----------------------------------------------------- | -------------------------------------- | -------------------------- | ------- | ----------------- |
| 执行器 metadata 注入 | main      | tests/dv/execution.test.ts（MemoryTransport）         | app deploy context 含 keep_versions: 5 | tests/dv/execution.test.ts | covered | -                 |
| 非法参数拒绝         | failure   | tests/dv/execution.test.ts（DeploymentExecutor 构造） | keepVersions 越界抛错                  | tests/dv/execution.test.ts | covered | -                 |
| 取消/清理生命周期    | lifecycle | tests/dv/execution.test.ts（CancellingTransport）     | 取消后资源完整清理，既有行为不回归     | tests/dv/execution.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow   | modules_involved                      | success_case                                                         | failure_case   | test_file                                             | status  | gap_manual_reason |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------- | -------------- | ----------------------------------------------------- | ------- | ----------------- |
| 成功清理契约       | deploy 脚本 + 安装目录/安装包存储     | keep_versions=2 时最旧版本目录与安装包被删、latest/当前/数据目录保留 | 无             | tests/integration/deploy_version_skip.test.ts         | covered | -                 |
| 失败不清理契约     | deploy 脚本                           | keep_versions=1 且健康失败回滚后旧版本目录与安装包仍在               | 无             | tests/integration/deploy_version_skip.test.ts         | covered | -                 |
| 模板/live 一致契约 | cluster-template ↔ clusters/multipass | deploy 脚本与 app.yaml 逐字节一致                                    | 不一致即失败   | tests/integration/deploy_version_skip.test.ts         | covered | -                 |
| 文档契约           | README、指南、示例 README             | docs 模式契约通过                                                    | 断言失败即失败 | tests/contract/verify_environment_placement_config.ts | covered | -                 |

## Definition of Done

- testplan.yaml 的 unit/dv/integration 与 contract steps 全部可运行且通过；
- 统一入口任务作用域 `sfo-deploy/027-old-version-cleanup all` 成功并产出 run artifact；
- 每个 change_id 至少一条 Direct Change Coverage 记录且无未解释 gap；
- `deno task check`、`deno lint`、`deno fmt --check` 通过。
