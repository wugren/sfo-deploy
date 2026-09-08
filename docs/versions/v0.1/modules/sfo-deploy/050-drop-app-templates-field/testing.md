---
task_manifest: task.yaml
status: draft
---

# 删除顶层 templates 字段测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行，含 external-positive、
  external-negative、removed-symbol-scan、repository-compile-closure 与 documentation-examples 五类
  contract steps。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行：`harness/scripts/test-run.py`（根目录快捷方式 `test-run.sh` /
`test-run.bat`）。任务作用域命令为
`python3 ./harness/scripts/test-run.py sfo-deploy/050-drop-app-templates-field all`（或
`--scan-run all`），它先执行 testplan.yaml 的 contract steps，再按 `unit`、`integration`
声明顺序执行任务测试，并写出 `.harness/test-results/test-runs/` 下的机器制品。

## Submodule Tests

本任务在 sfo-deploy 模块下按文件级分解（装载拒收、环境夹具、快照编解码、文档与契约），没有独立
业务子模块，因此不建立 submodule 测试文档；文件级覆盖由单元/集成测试表逐文件登记。

## Module-Level Tests

模块级行为由
`tests/unit/app_management_config.test.ts`、`tests/unit/environment_placement.test.ts`、
`tests/unit/history.test.ts` 与 `deno task test` 集成回归覆盖（顶层字段拒收、环境夹具回归、新快照
不写 templates、旧快照 decode 兼容），并配合 `tests/contract/verify_app_management_contract.ts`
验证文档契约与编译闭包。

## External Interface Tests

- 装载契约（新路径）：app.yaml / environment.yaml 不含顶层 `templates`，v3 `management.configs`
  模板交付与既有 v2/v3 装载结果逐字段不变（`tests/unit/app_management_config.test.ts`）。
- 装载契约（旧路径拒收）：app.yaml 与环境定义顶层 `templates` 装载即报定向迁移错误 （「顶层
  templates 已移除：模板文件交付请改用 management.configs」）
  （`tests/unit/app_management_config.test.ts`）。
- 快照契约（方案 A）：新计划步骤不再写 `templates`；`decodeStep` 对 `templates` 可选（缺省空数组），
  plan-v1/2/3 与旧 v4 快照仍可解码用于回滚（`tests/unit/history.test.ts`）。
- 文档示例：指南与 README 收敛为「模板交付统一走 management.configs」，顶层 `templates` 字段从
  schema 表与旧脚本模式说明中移除，由 `documentation-examples` contract step 校验。
- 编译闭包：`deno task check` 覆盖 ScriptDefinition 类型收窄后的全部生产入口
  （`repository-compile-closure`）。

## Direct Change Coverage

| change_id                            | design_source                                                      | validation_id                                                         | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-templates-config-load            | design.md P-001、File-Level Interfaces、Consumer Migration Closure | contract（装载正负例、定向拒收、编译闭包）                            | unit           | U1               | no  | -                 |
| CHG-templates-planning-serialization | design.md P-002、Key Flows、State and Ownership                    | data（新快照不写 templates、旧快照 decode 兼容）、runtime（集成回归） | unit           | U3               | no  | -                 |
| CHG-templates-docs-tests             | design.md P-003、Consumer Migration Closure                        | contract（文档契约与旧符号删除扫描）、harness（统一入口与覆盖映射）   | integration    | I2               | no  | -                 |

## Case-Type Coverage

| change_id                            | case_type     | required | validation_id                                                  | level       | status  | gap_manual_reason |
| ------------------------------------ | ------------- | -------- | -------------------------------------------------------------- | ----------- | ------- | ----------------- |
| CHG-templates-config-load            | normal        | yes      | 新路径装载：无顶层 templates 的 v2/v3 逐字段回归（U1/I1 回归） | unit        | covered | -                 |
| CHG-templates-config-load            | boundary      | yes      | 环境定义顶层 templates 拒收（U1）                              | unit        | covered | -                 |
| CHG-templates-config-load            | negative      | yes      | app.yaml/app_versions 顶层 templates 定向拒收（U1）            | unit        | covered | -                 |
| CHG-templates-config-load            | error         | yes      | 定向迁移错误文案（U1）                                         | unit        | covered | -                 |
| CHG-templates-config-load            | compatibility | no       | repository-compile-closure（类型收窄后全仓编译）               | unit        | covered | -                 |
| CHG-templates-config-load            | lifecycle     | no       | U1                                                             | unit        | covered | -                 |
| CHG-templates-config-load            | cross-module  | yes      | removed-symbol-scan（ScriptDefinition.templates 无仓库级残留） | integration | covered | -                 |
| CHG-templates-planning-serialization | normal        | yes      | 新步骤 templates 恒空、deliveryInputs.files 恒空（U3, I1）     | unit        | covered | -                 |
| CHG-templates-planning-serialization | boundary      | yes      | 旧 plan-v1/2/3/旧 v4 快照 decode 缺省空数组（U3）              | unit        | covered | -                 |
| CHG-templates-planning-serialization | negative      | yes      | 新快照往返不含 templates（U3）                                 | unit        | covered | -                 |
| CHG-templates-planning-serialization | compatibility | yes      | 既有快照 decode 回归不变（U3）                                 | unit        | covered | -                 |
| CHG-templates-planning-serialization | lifecycle     | yes      | 回滚执行仍可交付旧模板（I1 集成回归）                          | integration | covered | -                 |
| CHG-templates-planning-serialization | cross-module  | no       | I1 集成回归                                                    | integration | covered | -                 |
| CHG-templates-docs-tests             | normal        | yes      | 指南/README schema 表移除 templates 字段（I2）                 | integration | covered | -                 |
| CHG-templates-docs-tests             | negative      | yes      | 旧符号删除扫描（removed-symbol-scan）                          | integration | covered | -                 |
| CHG-templates-docs-tests             | compatibility | yes      | management.configs source/templates 目录文档边界保持（I2）     | integration | covered | -                 |
| CHG-templates-docs-tests             | boundary      | no       | I2                                                             | integration | covered | -                 |
| CHG-templates-docs-tests             | error         | no       | I2                                                             | integration | covered | -                 |
| CHG-templates-docs-tests             | lifecycle     | no       | I2                                                             | integration | covered | -                 |
| CHG-templates-docs-tests             | cross-module  | no       | I2                                                             | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                     | derived_cases                                                                            | level       | status         | gap_manual_reason              |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------- | -------------- | ------------------------------ |
| parameter-domain | design.md File-Level Interfaces（顶层字段域收窄） | `templates` 在 app.yaml 与环境定义两处均拒收，错误文案指引改走 management.configs        | unit        | covered        | -                              |
| state-transition | design.md State and Ownership                     | 计划发射与快照编解码为装载期纯函数，无运行时状态机                                       | unit        | not-applicable | 装载与编解码期无并发状态可断言 |
| failure-path     | design.md Overall Approach、Risks and Rollback    | 含顶层 templates 配置装载失败关闭；decode 缺省空数组不误伤旧快照                         | unit        | covered        | -                              |
| error-handling   | design.md File-Level Interfaces                   | 定向迁移文案不含任何秘密值                                                               | unit        | covered        | -                              |
| invariant        | design.md Design Notes、Key Flows                 | 新快照往返稳定（无 templates）；DeploymentStep.templates 保留 legacy-compat 但新计划恒空 | unit        | covered        | -                              |
| concurrency      | design.md State and Ownership                     | 无并发租约或共享可变状态可断言                                                           | integration | not-applicable | 单进程顺序装载/编解码流程      |

## Validation Rationale

风险档案 required_checks 映射如下：`contract` 由 U1（顶层声明定向拒收与既有格式回归）、
U2（环境夹具回归）、I2（指南/README 模板交付收敛与 contract 校验）覆盖；`data` 由 U3（新快照不写
templates、旧快照 decode 兼容、往返稳定）覆盖；`runtime` 由 I1（`deno
task test`
集成回归覆盖管理配置模板交付与旧快照回滚执行）覆盖；`harness` 由统一入口任务作用域、 run 制品与
testplan 精确映射覆盖；`security`/`ui`/`build` 均不适用（见 risk-profile）。

本任务实现阶段删除了 app.yaml/environment.yaml 顶层 `templates` 解析与 `ScriptDefinition.templates`
类型，`buildPlan` 步骤 `templates`/`deliveryInputs.files` 恒空，history `encodeStep` 不再写
`templates` 且 `decodeStep` 可选缺省空；`tests/_support/environment_placement.ts` 原模板夹具改写为
去模板回归，`tests/unit/app_management_config.test.ts` 新增顶层字段定向拒收正例；仓库全量
`deno task test` 现全绿（234 通过）。

## Unit Tests

| function_or_unit           | branch_or_condition                             | covered_behavior                                                         | test_file                                                            | status  | gap_manual_reason |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------- | ----------------- |
| rejectTopLevelTemplates    | app.yaml 顶层 templates                         | 装载即拒收，文案指明「顶层 templates 已移除：请改用 management.configs」 | tests/unit/app_management_config.test.ts                             | covered | -                 |
| rejectTopLevelTemplates    | 环境定义顶层 templates                          | 装载即拒收，同一文案族                                                   | tests/unit/app_management_config.test.ts                             | covered | -                 |
| scripts()/ScriptDefinition | 顶层 templates 不再解析                         | 无该字段时行为回归；脚本动作与逻辑不受影响                               | tests/unit/app_management_config.test.ts                             | covered | -                 |
| buildPlan                  | NewSteps 恒空 templates/空 deliveryInputs.files | 计划步骤不再携带模板旁路                                                 | tests/unit/history.test.ts, tests/unit/environment_placement.test.ts | covered | -                 |
| encodeStep                 | 新发布快照                                      | 不再写入 templates 键                                                    | tests/unit/history.test.ts                                           | covered | -                 |
| decodeStep                 | templates 可选（缺省空数组）                    | 缺省空数组；旧 plan-v1/2/3/旧 v4 快照仍可解码回滚                        | tests/unit/history.test.ts                                           | covered | -                 |

## DV Tests

| workflow                                                                                                                                                                                   | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----- | --------------- | ------------------- | ------ | ----------------- |
| not-applicable: 本任务为配置装载与计划/快照序列化的确定性分支，顶层模板交付为被消灭的旁路；deno dv 执行/内存工作流并入 I1（`deno task test`，含 dv/execution 与 app_management_execution） | -    | -     | -               | -                   | -      | -                 |

## Integration Tests

| contract_or_flow            | modules_involved                      | success_case                                                              | failure_case                            | test_file                                              | status  | gap_manual_reason |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------ | ------- | ----------------- |
| 集群装载→计划→历史→执行链路 | sfo-deploy 装载/计划/历史/执行        | 管理配置模板交付与旧快照回滚执行回归全绿                                  | 任何含顶层 templates 的配置装载失败关闭 | `deno task test`（testplan I1）                        | covered | -                 |
| 文档契约                    | README、配置指南与 managed 装载       | 指南/README 模板交付收敛到 management.configs 且既有 managed 文档边界一致 | 文档与实现契约偏离即失败                | tests/contract/verify_app_management_contract.ts（I2） | covered | -                 |
| 旧符号删除扫描              | 仓库级 src/tests/examples/docs 消费者 | `ScriptDefinition.templates` 与顶层声明符号无仓库级残留                   | 残留引用即失败并列出位置                | consumer-closure-check.py（removed-symbol-scan）       | covered | -                 |

## Definition of Done

- testplan.yaml 的 unit/integration 与五类 contract steps 全部可运行且通过；
- 统一入口任务作用域 `sfo-deploy/050-drop-app-templates-field all` 成功并产出 run artifact；
- 每个 change_id 至少一条 Direct Change Coverage 记录且无未解释 gap；
- `deno task check`、`deno lint`、`deno fmt --check` 通过；
- 仓库全量 `deno task test` 全绿（含改写后的环境夹具与新增强制拒收/快照兼容用例）。
