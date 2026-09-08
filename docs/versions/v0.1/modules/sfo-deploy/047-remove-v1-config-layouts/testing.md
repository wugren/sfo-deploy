---
task_manifest: task.yaml
status: draft
---

# 删除 v1 配置形态测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行，含 breaking 契约所需的
  external-positive/external-negative/removed-symbol-scan/repository-compile-closure/documentation-examples
  五类 contract steps。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行：`harness/scripts/test-run.py`（根目录快捷方式 `test-run.sh` /
`test-run.bat`）。任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/047-remove-v1-config-layouts all`，
它先执行 testplan.yaml 的 contract steps，再按 `unit`、`integration` 声明顺序执行任务测试。

## Submodule Tests

本任务在 sfo-deploy 模块下按文件级分解（配置装载、测试夹具、契约脚本与文档），没有独立业务
子模块，因此不建立 submodule 测试文档；文件级覆盖由单元/集成测试表逐文件登记。

## Module-Level Tests

模块级行为由 `tests/unit/config_planning.test.ts`、`tests/unit/environment_placement.test.ts` 与
`tests/integration/environment_placement.test.ts` 覆盖（装载收窄、v2 归一、失败关闭），并配合
`tests/contract/verify_environment_placement_config.ts` 的 closure/docs/v1-rejection 模式验证
跨组件编译闭包、文档边界与移除符号的外部负例。

## External Interface Tests

- 契约层：从仓库外部视角验证 `loadCluster` 只接受 v2/v3 配置（`v1-rejection` 以自建临时目录证明
  cluster v1 与 app v1 被版本门禁拒绝）。
- 文档示例：README、集群配置指南、示例 README 的 v2 布局、移除表述与「不兼容、不支持降级」边界 由
  `documentation-examples` contract step 校验。
- 编译闭包：src、tests 与示例集群模板全部 TS 文件通过
  `deno check --frozen`（`repository-compile-closure`）。

## Direct Change Coverage

| change_id                        | design_source                                                        | validation_id       | testplan_level | testplan_step_id | gap | gap_manual_reason |
| -------------------------------- | -------------------------------------------------------------------- | ------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-drop-app-v1                  | design.md P-001、File-Level Interfaces、Implementation Order I-1/I-2 | VAL-1, VAL-2, VAL-5 | unit           | U1               | no  | -                 |
| CHG-drop-cluster-v1-environments | design.md P-002、File-Level Interfaces、Implementation Order I-1/I-2 | VAL-3, VAL-4, VAL-6 | unit           | U3               | no  | -                 |
| CHG-v1-doc-tests                 | design.md P-003、Consumer Migration Closure                          | VAL-7, VAL-8        | integration    | I3               | no  | -                 |

## Case-Type Coverage

| change_id                        | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| -------------------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-drop-app-v1                  | normal        | yes      | VAL-1         | unit        | covered | -                 |
| CHG-drop-app-v1                  | boundary      | yes      | VAL-2         | unit        | covered | -                 |
| CHG-drop-app-v1                  | negative      | yes      | VAL-1         | unit        | covered | -                 |
| CHG-drop-app-v1                  | error         | yes      | VAL-1         | unit        | covered | -                 |
| CHG-drop-app-v1                  | compatibility | yes      | VAL-2         | unit        | covered | -                 |
| CHG-drop-app-v1                  | lifecycle     | no       | VAL-5         | unit        | covered | -                 |
| CHG-drop-app-v1                  | cross-module  | no       | VAL-8         | integration | covered | -                 |
| CHG-drop-cluster-v1-environments | normal        | yes      | VAL-3         | unit        | covered | -                 |
| CHG-drop-cluster-v1-environments | boundary      | yes      | VAL-3         | unit        | covered | -                 |
| CHG-drop-cluster-v1-environments | negative      | yes      | VAL-3         | unit        | covered | -                 |
| CHG-drop-cluster-v1-environments | error         | yes      | VAL-4         | unit        | covered | -                 |
| CHG-drop-cluster-v1-environments | compatibility | yes      | VAL-6         | integration | covered | -                 |
| CHG-drop-cluster-v1-environments | lifecycle     | no       | VAL-6         | integration | covered | -                 |
| CHG-drop-cluster-v1-environments | cross-module  | yes      | VAL-8         | integration | covered | -                 |
| CHG-v1-doc-tests                 | normal        | yes      | VAL-7         | integration | covered | -                 |
| CHG-v1-doc-tests                 | boundary      | no       | VAL-7         | integration | covered | -                 |
| CHG-v1-doc-tests                 | negative      | yes      | VAL-7         | integration | covered | -                 |
| CHG-v1-doc-tests                 | error         | no       | VAL-7         | integration | covered | -                 |
| CHG-v1-doc-tests                 | compatibility | yes      | VAL-8         | integration | covered | -                 |
| CHG-v1-doc-tests                 | lifecycle     | no       | VAL-7         | integration | covered | -                 |
| CHG-v1-doc-tests                 | cross-module  | yes      | VAL-8         | integration | covered | -                 |

说明：contract steps 由统一入口按 integration 前置阶段执行，表中以 integration 作为其 level。

## Design Element Coverage

| element_type     | design_source                                                                   | derived_cases                                                          | level       | status         | gap_manual_reason                                 |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------- | -------------- | ------------------------------------------------- |
| parameter-domain | design.md File-Level Interfaces（clusterSchemaVersion/appSchemaVersion 版本域） | cluster schema 版本域收窄为 {2}、app schema 版本域 {2,3}、未知版本拒收 | unit        | covered        | -                                                 |
| state-transition | design.md State and Ownership                                                   | 不做运行时状态转换断言；装载期线性执行                                 | unit        | not-applicable | 本任务不改运行时状态机，装载为一次性失败/成功出口 |
| failure-path     | design.md Overall Approach、Risks and Rollback                                  | cluster v2 + 每机目录 fail-closed 守卫、装载失败即拒绝整个集群         | unit        | covered        | -                                                 |
| error-handling   | design.md File-Level Interfaces、Key Flows                                      | v1 配置错误信息指明受支持版本与迁移方向                                | unit        | covered        | -                                                 |
| invariant        | design.md Design Notes、Risks and Rollback                                      | v2/v3 装载结果与删除前逐字段一致；app_versions.yaml 恒必填             | integration | covered        | -                                                 |
| concurrency      | design.md State and Ownership                                                   | 无并发状态可断言                                                       | integration | not-applicable | 装载期无并发租约或共享可变状态                    |

## Validation Rationale

风险档案的 required_checks 映射如下：`contract` 由 I2（编译闭包）与 I4（v1 拒收外部负例）覆盖；
`security`（历史快照不回写、路径 fail-closed）由 U3 的每机布局守卫与既有 fail-closed 用例覆盖；
`harness` 由统一入口任务作用域与 consumer-closure（removed-symbol-scan）覆盖。breaking 契约要求
的五类 contract steps 全部实现且每条覆盖全部三个 change_id；consumer migration 以迁移后文件
（migrated）与全仓扫描（verified-none）闭合，无兼容 shim。 任务作用域不包含的两项先存失败
（`tests/integration/packageless_app_scripts.test.ts`、`tests/unit/secrets_deploy_config.test.ts`）
与本次 v1 形态删除无关，记录于 testplan.yaml 的 manual_gaps 并列入 Definition of Done
之外的后续跟进。

## Unit Tests

| function_or_unit         | branch_or_condition         | covered_behavior                                               | test_file                                | status  | gap_manual_reason |
| ------------------------ | --------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ------- | ----------------- |
| appSchemaVersion         | v1 恒拒收、2/3 接受         | app.yaml v1 内联 version/package 报「只支持 2 或 3」并指引迁移 | tests/unit/config_planning.test.ts       | covered | -                 |
| loadApps                 | appVersions 缺失 + app 存在 | v2/v3 app 缺 app_versions.yaml 即失败                          | tests/unit/config_planning.test.ts       | covered | -                 |
| loadAppVersions 全量闭合 | 缺失/多余/未知 App 条目     | 映射闭合校验拒绝配置                                           | tests/unit/config_planning.test.ts       | covered | -                 |
| clusterSchemaVersion     | 1/其它版本拒收、2 接受      | cluster v1 每机布局报「只支持 2」并指引迁移                    | tests/unit/environment_placement.test.ts | covered | -                 |
| loadV2PlacedEnvironments | cluster v2 + 每机目录共存   | 保留 v1-布局 fail-closed 守卫拒绝                              | tests/unit/environment_placement.test.ts | covered | -                 |
| App v2/v3 无 management  | legacy 行为回归             | buildPlan 步骤保持 check/configure/deploy                      | tests/unit/app_management_config.test.ts | covered | -                 |

## DV Tests

| workflow                                                                   | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| -------------------------------------------------------------------------- | ---- | ----- | --------------- | ------------------- | ------ | ----------------- |
| not-applicable: 本任务为装载期静态分支删除，无 deno dv 执行/内存传输工作流 | -    | -     | -               | -                   | -      | -                 |

## Integration Tests

| contract_or_flow          | modules_involved             | success_case                                             | failure_case                 | test_file                                             | status  | gap_manual_reason |
| ------------------------- | ---------------------------- | -------------------------------------------------------- | ---------------------------- | ----------------------------------------------------- | ------- | ----------------- |
| 公开装载/规划 API v2 归一 | config + planning + fixtures | v2 放置装载、plan 步序稳定输出                           | 引用未知机器即失败           | tests/integration/environment_placement.test.ts       | covered | -                 |
| v2 闭包编译               | config + 示例模板            | src/tests/模板全部通过 deno check                        | 任一消费者编译失败即契约失败 | tests/contract/verify_environment_placement_config.ts | covered | -                 |
| 文档/示例 v2 与移除边界   | 文档 + 契约脚本              | v2 布局与「不再支持 v1、不自动迁移、不支持降级」表述齐全 | 文档仍宣称 v1 只读可读即失败 | tests/contract/verify_environment_placement_config.ts | covered | -                 |
| v1 路径拒收（外部负例）   | config + 契约脚本            | cluster v1 与 app v1 均被版本门禁拒绝并给出迁移指引      | 任一 v1 形态仍可装载即失败   | tests/contract/verify_environment_placement_config.ts | covered | -                 |

## Definition of Done

- testplan.yaml 的 unit/integration 与五类 contract steps 全部可运行且通过；
- 统一入口任务作用域 `sfo-deploy/047-remove-v1-config-layouts all` 成功并产出 run artifact；
- 每个 change_id 至少一条 Direct Change Coverage 记录且无未解释 gap；
- `deno task check`、`deno lint`、`deno fmt --check` 通过；
- 仓库全量 `deno task test` 相对删除前无新增失败（现有 3 项与本任务无关的先存失败由 046/ secrets
  后续跟进关闭）。
