---
task_manifest: task.yaml
status: draft
---

# 配置秘密占位符测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`，覆盖 sfo-deploy 装载、渲染、执行、持久化和文档契约。
- 子模块测试文档：无独立子模块层；文件级分解见 `design.md`。
- 机器可读执行计划：`testplan.yaml`。

## Submodule Tests

本任务在 sfo-deploy 模块内按文件级职责分解，不建立独立业务子模块；文件级覆盖由下方
Unit/DV/Integration 表登记。

## Module-Level Tests

模块级行为由 `tests/unit/app_management_config.test.ts`、
`tests/unit/managed_config_generation.test.ts`、`tests/unit/history.test.ts`、
`tests/dv/app_management_execution.test.ts`、`tests/integration/config_updater.test.ts`、
`tests/integration/managed_transport_security.test.ts`、
`tests/integration/remote_deployment.test.ts` 和 `deno task test` 全量回归覆盖。文档/示例、
旧符号扫描与编译闭包由 testplan contract steps 执行。

## External Interface Tests

- `app.yaml` / `cluster.yaml` 装载契约：format、`${SECRET_NAME}`、type 缺省与 file path 语义。
- 远端渲染协议：skeleton/bindings + `--secret-root`，只输出受限候选。
- 计划/历史持久契约：新 v4 shape encode/decode，旧 updater 快照定向拒收。
- 文档/公共导出契约：README/guide/examples 与 `ManagedSecretReference` 编译闭包。

## Unified Test Entry

任务作用域统一入口为：
`python3 harness/scripts/test-run.py sfo-deploy/051-secret-placeholder-config all`。它先执行
`testplan.yaml` 的 contract steps，再执行 unit/DV/integration 步骤并写出机器制品。

## Direct Change Coverage

| change_id                         | design_source                                            | validation_id                                               | testplan_level | testplan_step_id | gap | gap_manual_reason |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-secret-placeholder-schema     | design.md P-001、File-Level Interfaces、Key Flows        | value 秘密类型缺省/显式/非法、file type 拒收、未声明/未放置 | unit           | U1               | no  | -                 |
| CHG-placeholder-rendering-runtime | design.md P-002、Overall Approach、Key Flows             | 四格式占位符、类型、file path、失败关闭、执行与传输         | integration    | I3               | no  | -                 |
| CHG-placeholder-plan-history-cli  | design.md P-003、State and Ownership、Risks and Rollback | 新计划/快照形状与旧 updater 快照拒收                        | unit           | U4               | no  | -                 |
| CHG-placeholder-docs-tests        | design.md P-004、Consumer Migration Closure              | 文档示例、公共类型闭包、编译闭包                            | integration    | I5               | no  | -                 |

## Case-Type Coverage

| change_id                         | case_type     | required | validation_id                                | level       | status  | gap_manual_reason |
| --------------------------------- | ------------- | -------- | -------------------------------------------- | ----------- | ------- | ----------------- |
| CHG-secret-placeholder-schema     | normal        | yes      | 四格式装载与计划、缺省 string                | unit        | covered | -                 |
| CHG-secret-placeholder-schema     | boundary      | yes      | 显式 integer、file 无 type、未知/未放置      | unit        | covered | -                 |
| CHG-secret-placeholder-schema     | negative      | yes      | 非法 type/value/占位符                       | unit        | covered | -                 |
| CHG-secret-placeholder-schema     | error         | yes      | 定向错误不输出秘密值                         | unit        | covered | -                 |
| CHG-secret-placeholder-schema     | compatibility | yes      | schema v2/v3 legacy 回归                     | unit        | covered | -                 |
| CHG-secret-placeholder-schema     | lifecycle     | no       | U1                                           | unit        | covered | -                 |
| CHG-secret-placeholder-schema     | cross-module  | yes      | I3 removed-symbol scan                       | integration | covered | -                 |
| CHG-placeholder-rendering-runtime | normal        | yes      | 四格式特殊字符串、类型化整值、file path      | integration | covered | -                 |
| CHG-placeholder-rendering-runtime | boundary      | yes      | 嵌入字符串仅 string、重复/缺失占位符         | unit        | covered | -                 |
| CHG-placeholder-rendering-runtime | negative      | yes      | 非法格式、未知秘密、无效候选                 | unit        | covered | -                 |
| CHG-placeholder-rendering-runtime | error         | yes      | 渲染失败不写候选、发布失败恢复               | dv          | covered | -                 |
| CHG-placeholder-rendering-runtime | compatibility | no       | 旧 bundle 成员/协议路径回归                  | integration | covered | -                 |
| CHG-placeholder-rendering-runtime | lifecycle     | yes      | managed deploy 事务、锁、systemd 合并        | dv          | covered | -                 |
| CHG-placeholder-rendering-runtime | cross-module  | yes      | OpenSSH 固定 argv 与 bundle 形状             | integration | covered | -                 |
| CHG-placeholder-plan-history-cli  | normal        | yes      | 新 v4 encode/decode format/secret_references | unit        | covered | -                 |
| CHG-placeholder-plan-history-cli  | boundary      | yes      | 空秘密引用、无 service                       | unit        | covered | -                 |
| CHG-placeholder-plan-history-cli  | negative      | yes      | 旧 updater 快照定向拒收                      | unit        | covered | -                 |
| CHG-placeholder-plan-history-cli  | error         | yes      | 快照字段非法错误                             | unit        | covered | -                 |
| CHG-placeholder-plan-history-cli  | compatibility | no       | 旧 updater 快照拒绝属已确认破坏性策略        | unit        | covered | -                 |
| CHG-placeholder-plan-history-cli  | lifecycle     | yes      | 回滚计划推导回归                             | unit        | covered | -                 |
| CHG-placeholder-plan-history-cli  | cross-module  | yes      | CLI 序列化随历史/计划回归                    | unit        | covered | -                 |
| CHG-placeholder-docs-tests        | normal        | yes      | README/guide 新契约                          | integration | covered | -                 |
| CHG-placeholder-docs-tests        | negative      | yes      | removed-symbol scan                          | integration | covered | -                 |
| CHG-placeholder-docs-tests        | error         | no       | I3/I4                                        | integration | covered | -                 |
| CHG-placeholder-docs-tests        | boundary      | no       | I4                                           | integration | covered | -                 |
| CHG-placeholder-docs-tests        | compatibility | yes      | `deno task check` 仓库编译闭包               | integration | covered | -                 |
| CHG-placeholder-docs-tests        | lifecycle     | no       | I5                                           | integration | covered | -                 |
| CHG-placeholder-docs-tests        | cross-module  | yes      | 公共导出/文档/示例闭包                       | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                               | derived_cases                                             | level       | status  | gap_manual_reason |
| ---------------- | ------------------------------------------- | --------------------------------------------------------- | ----------- | ------- | ----------------- |
| parameter-domain | design.md File-Level Interfaces             | 四格式、四种类型、缺省/非法类型、整值/嵌入占位符          | unit        | covered | -                 |
| state-transition | design.md State and Ownership               | 候选未发布/已发布/指纹未提交/提交由 DV 事务与发布测试覆盖 | dv          | covered | -                 |
| failure-path     | design.md Key Flows、Risks and Rollback     | 未放置秘密、渲染失败、hook 失败、发布失败恢复             | dv          | covered | -                 |
| error-handling   | design.md Key Flows                         | 定向错误、复解析失败、残留 marker                         | unit        | covered | -                 |
| invariant        | design.md State and Ownership、Design Notes | 秘密不进 bundle/argv/env/输出；候选原子发布；新快照往返   | integration | covered | -                 |
| concurrency      | design.md State and Ownership               | App/目标 flock、锁释放与争用由 managed 传输回归           | integration | covered | -                 |

## Unit Tests

| function_or_unit                           | branch_or_condition                        | covered_behavior       | test_file                                    | status  | gap_manual_reason |
| ------------------------------------------ | ------------------------------------------ | ---------------------- | -------------------------------------------- | ------- | ----------------- |
| secretDeclarations/managedSecretReferences | type 缺省/显式/file                        | 装载归一与引用生成     | tests/unit/app_management_config.test.ts     | covered | -                 |
| managedConfigFiles                         | updater 存在、format 非法、未知/非法占位符 | 定向拒收               | tests/unit/app_management_config.test.ts     | covered | -                 |
| generateConfigSkeleton                     | 四格式、marker、file/path、缺失/非法       | 骨架与失败关闭         | tests/unit/managed_config_generation.test.ts | covered | -                 |
| loadClusterSecretSource                    | 实际秘密类型校验                           | integer 值类型错误拒绝 | tests/unit/app_management_config.test.ts     | covered | -                 |
| encode/decodeManagement                    | 新快照、旧 updater 快照                    | 新形状与旧契约拒收     | tests/unit/history.test.ts                   | covered | -                 |

## DV Tests

| workflow                   | kind      | entry                        | expected_result                            | test_file_or_script                       | status  | gap_manual_reason |
| -------------------------- | --------- | ---------------------------- | ------------------------------------------ | ----------------------------------------- | ------- | ----------------- |
| managed 配置生命周期       | main      | managedPlan + fake transport | 批量候选、事务发布、systemd 合并、失败恢复 | tests/dv/app_management_execution.test.ts | covered | -                 |
| 发布后 hook 失败与配置恢复 | lifecycle | managedPlan + fake transport | 恢复旧配置并记录 recovery                  | tests/dv/app_management_execution.test.ts | covered | -                 |
| 执行器失败与隔离           | failure   | 执行器 DV 回归               | 单目标失败不破坏其他目标                   | tests/dv/execution.test.ts                | covered | -                 |

## Integration Tests

| contract_or_flow    | modules_involved             | success_case                                               | failure_case                   | test_file                                                                                         | status  | gap_manual_reason |
| ------------------- | ---------------------------- | ---------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- | ------- | ----------------- |
| 远端渲染协议        | transport/remote updater     | 四格式、类型、file path、无效候选                          | 输入非法、缺失秘密、复解析失败 | tests/integration/config_updater.test.ts                                                          | covered | -                 |
| OpenSSH argv/bundle | transport/deployment bundle  | 无控制字符、固定 deny flags                                | 非法参数/成员/路径导致传输失败 | tests/integration/managed_transport_security.test.ts, tests/integration/remote_deployment.test.ts | covered | -                 |
| 文件秘密变更指纹    | transport/config transaction | 相同候选首次建立指纹并触发 serviceChange；提交后不重复触发 | 指纹缺失/漂移即 serviceChange  | tests/integration/config_fingerprint.test.ts                                                      | covered | -                 |
| 集群示例/文档契约   | config/docs/examples         | 示例可装载，文档一致                                       | 文档偏离契约即失败             | tests/integration/environment_placement.test.ts, tests/contract/verify_app_management_contract.ts | covered | -                 |
| 仓库编译闭包        | 全部生产入口                 | `deno task check` 通过                                     | 类型/导出漂移即失败            | testplan C5                                                                                       | covered | -                 |
| 旧符号闭包          | src/tests/docs/examples      | 已删除 updater 类型无残留                                  | 残留即失败                     | testplan C4                                                                                       | covered | -                 |

## Validation Rationale

风险档案中 `contract`、`data`、`security`、`runtime`、`build`、`harness` 的 required_checks
分别由装载/渲染正负例、计划快照回归、秘密隔离与失败关闭、运行时事务、`deno task check`/ bundle
产物检查以及统一入口制品覆盖。`ui` 不适用。已实现全量 `deno task test` 通过（230 例）。

## Definition of Done

- 任务作用域统一入口成功并生成 run artifact；
- testplan 所有启用步骤与 contract checks 通过；
- 每个 change_id 均有直接覆盖，无未解释 gap；
- `deno task check`、`deno task lint`、格式检查通过。
