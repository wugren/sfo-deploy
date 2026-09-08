---
task_manifest: task.yaml
status: draft
---

# 顶层秘密声明移除与机器范围交付测试设计

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
`python3 ./harness/scripts/test-run.py sfo-deploy/049-drop-app-secret-declaration all`， 它先执行
testplan.yaml 的 contract steps，再按 `unit`、`integration` 声明顺序执行任务测试， 并写出
`.harness/test-results/test-runs/` 下的机器制品。

## Submodule Tests

本任务在 sfo-deploy 模块下按文件级分解（装载拒收、绑定直连校验、计划集合推导、快照不变量、
文档与契约），没有独立业务子模块，因此不建立 submodule 测试文档；文件级覆盖由单元/集成测试表
逐文件登记。

## Module-Level Tests

模块级行为由
`tests/unit/app_management_config.test.ts`、`tests/unit/secrets_deploy_config.test.ts`、
`tests/unit/config_planning.test.ts`、`tests/unit/cli_human_output.test.ts`、
`tests/unit/environment_placement.test.ts`、`tests/unit/history.test.ts` 与 `deno task test`
集成回归覆盖（顶层声明拒收、绑定直连 cluster 校验、机器范围集合推导、快照往返与不变量）， 并配合
`tests/contract/verify_app_management_contract.ts` 与 `tests/contract/verify_secrets_contract.ts`
验证文档契约与旧符号删除扫描。

## External Interface Tests

- 装载契约（新路径）：`app.yaml` schema v3 managed 绑定（yaml/json/toml/ini/template 与 script
  updater secrets）直接对 `cluster.yaml.secrets` 校验通过，既有 v2/v3 无顶层声明的
  装载结果逐字段不变（`tests/unit/app_management_config.test.ts`）。
- 装载契约（旧路径拒收）：app.yaml 与环境定义顶层的 `secret_values`/`secret_files` 装载即报
  定向迁移错误（「已移除：秘密由 cluster.yaml.secrets 唯一声明」）
  （`tests/unit/secrets_deploy_config.test.ts`）。
- 交付契约（方案 A）：开启秘密交付的步骤（环境 `configure`、App `configure`/`deploy` 及含
  updater/hook 的动作）携带本机 `cluster.yaml.secrets` 声明放置的全部秘密（值/文件分集、排序、
  `machines: "*"` 归一），未开启的步骤为空集合（`tests/unit/secrets_deploy_config.test.ts`、
  `tests/unit/config_planning.test.ts`）。
- 快照契约：plan 快照 encode/decode 往返逐字段一致；managed secret ∈ 步骤集合与 lifecycle 秘密 ⊆
  步骤集合不变量在机器范围推导下成立（`tests/unit/history.test.ts`）。
- 文档示例：指南与 README 收敛为「cluster.yaml.secrets 唯一声明点 + 绑定直接引用」模型，由
  `documentation-examples` contract step 校验；已删除顶层声明符号由
  `harness/scripts/consumer-closure-check.py` 仓库级扫描。
- 编译闭包：`deno task check` 覆盖 ScriptDefinition 类型收窄后的全部生产入口
  （`repository-compile-closure`）。

## Direct Change Coverage

| change_id                    | design_source                                                      | validation_id                                                                     | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ---------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-cluster-secret-bindings  | design.md P-001、File-Level Interfaces、Consumer Migration Closure | contract（装载正负例、绑定直连校验、失败关闭）                                    | unit           | U1               | no  | -                 |
| CHG-secret-delivery-planning | design.md P-002、Key Flows、State and Ownership                    | contract（顶层拒收与机器范围推导）、data（快照往返与不变量）、runtime（集成回归） | unit           | U2               | no  | -                 |
| CHG-secret-docs-tests        | design.md P-003、Consumer Migration Closure                        | contract（文档契约与旧符号删除扫描）、harness（统一入口与覆盖映射）               | integration    | I2               | no  | -                 |

## Case-Type Coverage

| change_id                    | case_type     | required | validation_id                                           | level       | status  | gap_manual_reason |
| ---------------------------- | ------------- | -------- | ------------------------------------------------------- | ----------- | ------- | ----------------- |
| CHG-cluster-secret-bindings  | normal        | yes      | 新路径装载（U1/I2 外科正例）                            | unit        | covered | -                 |
| CHG-cluster-secret-bindings  | boundary      | yes      | 环境定义顶层声明拒收（U2）                              | unit        | covered | -                 |
| CHG-cluster-secret-bindings  | negative      | yes      | 未知秘密/未放置本机/顶层声明拒收（U1, U2, I2 外科负例） | unit        | covered | -                 |
| CHG-cluster-secret-bindings  | error         | yes      | 定向迁移错误文案（U2）                                  | unit        | covered | -                 |
| CHG-cluster-secret-bindings  | compatibility | yes      | 既有 v2/v3 装载回归逐字段不变（U1, U3）                 | unit        | covered | -                 |
| CHG-cluster-secret-bindings  | lifecycle     | no       | U1                                                      | unit        | covered | -                 |
| CHG-cluster-secret-bindings  | cross-module  | no       | repository-compile-closure                              | unit        | covered | -                 |
| CHG-secret-delivery-planning | normal        | yes      | 机器范围集合推导（U2, U3）                              | unit        | covered | -                 |
| CHG-secret-delivery-planning | boundary      | yes      | 无秘密机器/未开启交付步骤为空集合（U2, U3）             | unit        | covered | -                 |
| CHG-secret-delivery-planning | negative      | yes      | history 不变量成立（U4）                                | unit        | covered | -                 |
| CHG-secret-delivery-planning | error         | no       | U4                                                      | unit        | covered | -                 |
| CHG-secret-delivery-planning | compatibility | yes      | 快照 encode/decode 往返与既有快照解码（U4）             | unit        | covered | -                 |
| CHG-secret-delivery-planning | lifecycle     | yes      | lifecycle 秘密 = 本机集合（U4）                         | unit        | covered | -                 |
| CHG-secret-delivery-planning | cross-module  | no       | I1 集成回归                                             | integration | covered | -                 |
| CHG-secret-docs-tests        | normal        | yes      | 指南/README 唯一声明点表述（I2）                        | integration | covered | -                 |
| CHG-secret-docs-tests        | boundary      | no       | I2                                                      | integration | covered | -                 |
| CHG-secret-docs-tests        | negative      | yes      | 旧符号删除扫描（I3, removed-symbol-scan）               | integration | covered | -                 |
| CHG-secret-docs-tests        | error         | no       | I2                                                      | integration | covered | -                 |
| CHG-secret-docs-tests        | compatibility | yes      | 既有 managed/template/script 文档边界（I2）             | integration | covered | -                 |
| CHG-secret-docs-tests        | lifecycle     | no       | I2                                                      | integration | covered | -                 |
| CHG-secret-docs-tests        | cross-module  | no       | I2                                                      | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                     | derived_cases                                                                                  | level       | status         | gap_manual_reason            |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- | -------------- | ---------------------------- |
| parameter-domain | design.md File-Level Interfaces（顶层字段域收窄） | `secret_values`/`secret_files` 在 app.yaml 与环境定义两处均拒收，错误文案指明替代声明点        | unit        | covered        | -                            |
| state-transition | design.md State and Ownership                     | 计划推导为装载期纯函数，无运行时状态机                                                         | unit        | not-applicable | 装载与推导期无并发状态可断言 |
| failure-path     | design.md Overall Approach、Risks and Rollback    | 未知秘密、kind 冲突、未放置本机、顶层声明全部失败关闭                                          | unit        | covered        | -                            |
| error-handling   | design.md File-Level Interfaces                   | 定向迁移文案不含秘密值；绑定错误指明 label 与 cluster 声明点                                   | unit        | covered        | -                            |
| invariant        | design.md Design Notes、Key Flows                 | 步骤集合=本机 cluster 声明（排序、值/文件分集）；lifecycle 集合同源；managed secret ⊆ 步骤集合 | unit        | covered        | -                            |
| concurrency      | design.md State and Ownership                     | 无并发租约或共享可变状态可断言                                                                 | integration | not-applicable | 单进程顺序装载/推导流程      |

## Validation Rationale

风险档案 required_checks 映射如下：`contract` 由 U1（绑定直连装载正负例与既有格式回归）、
U2（顶层声明定向拒收）、I2（指南/README 唯一声明点表述与 contract 校验）覆盖；`data` 由 U4（快照
encode/decode 往返、不变量、旧快照解码回归）覆盖；`security` 由 U1/U2（失败关闭
矩阵与定向文案不含秘密值）、U3（机器范围集合与空集合边界）覆盖；`runtime` 由 I1（`deno
task test`
集成回归覆盖 secrets-deploy 放置与 loader 按步骤集合装载）覆盖；`harness` 由统一 入口任务作用域、run
制品与 testplan 精确映射覆盖。

本任务实现阶段删除了 `declaredManagedSecret` App 级 allowlist 与 planning 的 `managedSecrets`
绑定归一集合，改为 `loadCluster.validateSecret` 直连校验与 `machineScopedSecrets`
机器范围推导；`tests/unit/secrets_deploy_config.test.ts` 原顶层
「作用域/重叠」用例改写为顶层声明拒收正例与机器范围集合断言；仓库全量 `deno task test` 现全绿（232
通过）。

## Unit Tests

| function_or_unit                                                  | branch_or_condition                         | covered_behavior                                                              | test_file                                                                    | status  | gap_manual_reason |
| ----------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------- | ----------------- |
| rejectTopLevelSecretDeclarations                                  | app.yaml 顶层 secret_values/secret_files    | 装载即拒收，文案指明 cluster.yaml.secrets 唯一声明点                          | tests/unit/secrets_deploy_config.test.ts                                     | covered | -                 |
| rejectTopLevelSecretDeclarations                                  | 环境定义顶层 secret_values                  | 装载即拒收，同一文案族                                                        | tests/unit/secrets_deploy_config.test.ts                                     | covered | -                 |
| managedStructuredBindings / managedScriptSecrets / managedUpdater | 绑定 secret 直连 cluster 校验               | 未知秘密/未放置本机失败关闭；未知秘密文案为「未在 cluster.yaml.secrets 声明」 | tests/unit/app_management_config.test.ts                                     | covered | -                 |
| machineScopedSecrets                                              | 机器范围推导                                | 步骤集合=本机声明秘密（值/文件分集、排序）；未开启交付步骤为空                | tests/unit/secrets_deploy_config.test.ts, tests/unit/config_planning.test.ts | covered | -                 |
| encode/decode plan 快照                                           | secret_values/secret_files/lifecycle_* 往返 | 逐字段一致；旧快照解码不回归；managed secret/lifecycle 不变量成立             | tests/unit/history.test.ts                                                   | covered | -                 |
| CLI 计划序列化                                                    | human/json 输出字段形状                     | secret_values/secret_files 字段形状不变（仅推导来源变化）                     | tests/unit/cli_human_output.test.ts                                          | covered | -                 |

## DV Tests

| workflow                                                                                                                               | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- | --------------- | ------------------- | ------ | ----------------- |
| not-applicable: 本任务为装载校验与计划集合推导的确定性分支，无 deno dv 执行/内存传输工作流；dv 相关集成回归并入 I1（`deno task test`） | -    | -     | -               | -                   | -      | -                 |

## Integration Tests

| contract_or_flow       | modules_involved                      | success_case                                               | failure_case                                 | test_file                                              | status  | gap_manual_reason |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------ | ------- | ----------------- |
| 集群装载→计划→执行链路 | sfo-deploy 装载/计划/执行/历史        | 方案 A 机器范围秘密交付、secrets-deploy 放置与发布回归全绿 | 任何顶层声明或未声明秘密引用导致装载失败关闭 | deno task test（testplan I1）                          | covered | -                 |
| 文档契约               | README、配置指南与 managed 装载       | 指南/README 唯一声明点模型与既有 managed 文档边界一致      | 文档与实现契约偏离即失败                     | tests/contract/verify_app_management_contract.ts（I2） | covered | -                 |
| 旧符号删除扫描         | 仓库级 src/tests/examples/docs 消费者 | 已删除秘密机制与顶层声明符号无仓库级残留                   | 残留引用即失败并列出位置                     | tests/contract/verify_secrets_contract.ts（I3）        | covered | -                 |

## Definition of Done

- testplan.yaml 的 unit/integration 与五类 contract steps 全部可运行且通过；
- 统一入口任务作用域 `sfo-deploy/049-drop-app-secret-declaration all` 成功并产出 run artifact；
- 每个 change_id 至少一条 Direct Change Coverage 记录且无未解释 gap；
- `deno task check`、`deno lint`、`deno fmt --check` 通过；
- 仓库全量 `deno task test` 全绿（含改写后的顶层声明拒收与机器范围集合用例）。
