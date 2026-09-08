---
task_manifest: task.yaml
status: draft
---

# template 占位符更新器测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行，含 external-positive、
  repository-compile-closure 与 documentation-examples 三类 contract steps。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行：`harness/scripts/test-run.py`（根目录快捷方式 `test-run.sh` /
`test-run.bat`）。任务作用域命令为
`python3 ./harness/scripts/test-run.py sfo-deploy/048-text-placeholder-updater all`， 它先执行
testplan.yaml 的 contract steps，再按 `unit`、`integration` 声明顺序执行任务测试， 并写出
`.harness/test-results/test-runs/` 下的机器制品。

## Submodule Tests

本任务在 sfo-deploy 模块下按文件级分解（装载、骨架生成、快照编解码、执行面类型、远端替换、
契约与文档），没有独立业务子模块，因此不建立 submodule 测试文档；文件级覆盖由单元/集成测试表
逐文件登记。

## Module-Level Tests

模块级行为由
`tests/unit/app_management_config.test.ts`、`tests/unit/managed_config_generation.test.ts`、
`tests/unit/history.test.ts` 与 `tests/integration/config_updater.test.ts` 覆盖（装载规范化、
骨架失败关闭、快照往返、远端全量替换），并配合 `tests/contract/verify_app_management_contract.ts`
验证文档契约与既有格式回归。

## External Interface Tests

- 装载契约：`app.yaml` schema v3 `updater.type: template` 从集群目录外部视角装载成功，既有
  yaml/json/toml/ini/script 装载结果逐字段不变（`tests/unit/app_management_config.test.ts`）。
- 部署包契约：template 骨架 + 绑定清单（`selector: null`、`type: string`、`updater: template`）
  可被远端 `config_updater` 接受并产出候选（`tests/integration/config_updater.test.ts`）。
- 文档示例：指南与 README 的 template 声明、占位符语法（仅 `${NAME}` + `$$`、无裸 `$NAME`）
  与失败关闭表述由 `documentation-examples` contract step 校验。
- 编译闭包：`deno task check` 覆盖 `src/mod.ts`、`src/main.ts`、`src/cli.ts` 与远端
  `src/remote_runtime/config_updater.ts`（`repository-compile-closure`）。

## Direct Change Coverage

| change_id                       | design_source                                                        | validation_id                     | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ------------------------------- | -------------------------------------------------------------------- | --------------------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-template-updater-control    | design.md P-001、File-Level Interfaces、Implementation Order I-1~I-4 | VAL-1, VAL-2, VAL-3, VAL-4, VAL-6 | unit           | U1               | no  | -                 |
| CHG-template-updater-remote     | design.md P-002、Key Flows、Implementation Order I-5                 | VAL-5, VAL-7                      | integration    | I1               | no  | -                 |
| CHG-template-updater-docs-tests | design.md P-003、Consumer Migration Closure                          | VAL-8                             | integration    | I2               | no  | -                 |

## Case-Type Coverage

| change_id                       | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| ------------------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-template-updater-control    | normal        | yes      | VAL-1, VAL-2  | unit        | covered | -                 |
| CHG-template-updater-control    | boundary      | yes      | VAL-2         | unit        | covered | -                 |
| CHG-template-updater-control    | negative      | yes      | VAL-1, VAL-2  | unit        | covered | -                 |
| CHG-template-updater-control    | error         | yes      | VAL-1         | unit        | covered | -                 |
| CHG-template-updater-control    | compatibility | yes      | VAL-3, VAL-4  | unit        | covered | -                 |
| CHG-template-updater-control    | lifecycle     | no       | VAL-3         | unit        | covered | -                 |
| CHG-template-updater-control    | cross-module  | no       | VAL-6         | unit        | covered | -                 |
| CHG-template-updater-remote     | normal        | yes      | VAL-5         | integration | covered | -                 |
| CHG-template-updater-remote     | boundary      | yes      | VAL-5         | integration | covered | -                 |
| CHG-template-updater-remote     | negative      | yes      | VAL-5         | integration | covered | -                 |
| CHG-template-updater-remote     | error         | yes      | VAL-5         | integration | covered | -                 |
| CHG-template-updater-remote     | compatibility | yes      | VAL-7         | integration | covered | -                 |
| CHG-template-updater-remote     | lifecycle     | no       | VAL-7         | integration | covered | -                 |
| CHG-template-updater-remote     | cross-module  | no       | VAL-7         | integration | covered | -                 |
| CHG-template-updater-docs-tests | normal        | yes      | VAL-8         | integration | covered | -                 |
| CHG-template-updater-docs-tests | boundary      | no       | VAL-8         | integration | covered | -                 |
| CHG-template-updater-docs-tests | negative      | yes      | VAL-8         | integration | covered | -                 |
| CHG-template-updater-docs-tests | error         | no       | VAL-8         | integration | covered | -                 |
| CHG-template-updater-docs-tests | compatibility | yes      | VAL-8         | integration | covered | -                 |
| CHG-template-updater-docs-tests | lifecycle     | no       | VAL-8         | integration | covered | -                 |
| CHG-template-updater-docs-tests | cross-module  | no       | VAL-8         | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                   | derived_cases                                                              | level       | status         | gap_manual_reason            |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------- | ----------- | -------------- | ---------------------------- |
| parameter-domain | design.md File-Level Interfaces（占位符语法域） | `[A-Z][A-Z0-9_]*` 占位符域、`$$` 转义、非法名称与缺右括号拒收              | unit        | covered        | -                            |
| state-transition | design.md State and Ownership                   | 骨架/候选/发布为一次性确定性转换，无运行时状态机                           | unit        | not-applicable | 装载与生成期无并发状态可断言 |
| failure-path     | design.md Overall Approach、Risks and Rollback  | 未声明/重复占位符、保留前缀、声明未出现、marker 缺失、非法绑定全部失败关闭 | unit        | covered        | -                            |
| error-handling   | design.md File-Level Interfaces                 | 错误信息指明配置名、占位符与失败原因，且不含秘密或候选内容                 | unit        | covered        | -                            |
| invariant        | design.md Design Notes                          | marker 由身份 JSON 确定性派生；秘密值绝不进入骨架；远端候选无残留 marker   | integration | covered        | -                            |
| concurrency      | design.md State and Ownership                   | 无并发租约或共享可变状态可断言                                             | integration | not-applicable | 单进程顺序装载/替换流程      |

## Validation Rationale

风险档案 required_checks 映射如下：`contract` 由 VAL-1（装载成功/失败与既有格式回归）、
VAL-5（部署包 template 成员形态被远端接受）、VAL-8（指南/README 表述与 contract 校验）覆盖； `data`
由 VAL-3（template 快照 encode/decode 往返、旧快照解码不回归）覆盖；`security` 由
VAL-2（骨架无秘密、失败关闭矩阵）、VAL-5（远端 deny 面与残留/UTF-8/大小校验）、VAL-6（步骤
最小秘密集合归一）覆盖；`runtime` 由 VAL-7（`--format template` 端到端候选产出与离线执行）覆盖；
`build` 由 VAL-7 附带的 `deno task check`/bundle 重生成与 contract step `repository-compile-closure`
覆盖；`harness` 由统一入口任务作用域、run 制品与 testplan 精确映射覆盖。
三项先存失败用例（`tests/unit/secrets_deploy_config.test.ts` 的顶层文件秘密作用域断言、
`tests/integration/packageless_app_scripts.test.ts` 的两个已删除示例脚本用例）已在本任务实现阶段
按当前生命周期语义修复/移除：文件秘密现随 `configure`/`deploy` 步骤传播（历史校验不变量要求），
nginx 示例已迁移为 schema v3 managed App，旧脚本职责由框架管理面接管；仓库全量 `deno task test`
现全绿。

## Unit Tests

| function_or_unit                     | branch_or_condition                        | covered_behavior                                          | test_file                                                               | status  | gap_manual_reason |
| ------------------------------------ | ------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------- | ------- | ----------------- |
| managedTemplateBindings              | placeholder 缺省/重复/非法、秘密未声明     | 缺省占位符等于秘密名；重复/非法/未声明均失败关闭          | tests/unit/app_management_config.test.ts                                | covered | -                 |
| managedUpdater + managedConfigFiles  | type: template 与 variables 互斥           | 共存即 ConfigurationError，错误文案指明替代方案           | tests/unit/app_management_config.test.ts                                | covered | -                 |
| renderTemplateSkeleton               | `$$`/`${NAME}`/裸 `$`/未声明/缺席/保留前缀 | 全部分支逐字符验证并断言错误文案                          | tests/unit/managed_config_generation.test.ts                            | covered | -                 |
| templateBindings                     | marker 身份派生                            | 同输入 marker 确定、不同绑定 marker 互异                  | tests/unit/managed_config_generation.test.ts                            | covered | -                 |
| encode/decodeConfigUpdater           | kind: template 往返                        | 快照逐字段一致；既有 yaml/json/toml/ini/script 解码不回归 | tests/unit/history.test.ts                                              | covered | -                 |
| managedSecrets / serializeManagement | template 绑定归一为 `kind: value`          | planning 秘密集合与 CLI 序列化含 template 配置            | tests/unit/config_planning.test.ts, tests/unit/cli_human_output.test.ts | covered | -                 |

## DV Tests

| workflow                                                                               | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| -------------------------------------------------------------------------------------- | ---- | ----- | --------------- | ------------------- | ------ | ----------------- |
| not-applicable: 本任务为装载/生成/替换的确定性文本分支，无 deno dv 执行/内存传输工作流 | -    | -     | -               | -                   | -      | -                 |

## Integration Tests

| contract_or_flow       | modules_involved                          | success_case                                      | failure_case                          | test_file                                           | status  | gap_manual_reason |
| ---------------------- | ----------------------------------------- | ------------------------------------------------- | ------------------------------------- | --------------------------------------------------- | ------- | ----------------- |
| 远端 template 全量替换 | config_generation + remote config_updater | 多次出现占位符全部替换、原文注入不转义、mode 0600 | marker 缺失或绑定非法即失败且不落候选 | tests/integration/config_updater.test.ts            | covered | -                 |
| 文档/示例契约          | 指南 + README + 契约脚本                  | template 声明与占位符语法表述齐全                 | 文档缺失 template 表述即失败          | tests/contract/verify_app_management_contract.ts    | covered | -                 |
| 编译闭包               | src 全部入口 + 远端 runtime               | `deno task check` 通过                            | 任一消费者类型错误即失败              | testplan contract step `repository-compile-closure` | covered | -                 |

## Definition of Done

- testplan.yaml 的 unit/integration 与三类 contract steps 全部可运行且通过；
- 统一入口任务作用域 `sfo-deploy/048-text-placeholder-updater all` 成功并产出 run artifact；
- 每个 change_id 至少一条 Direct Change Coverage 记录且无未解释 gap；
- `deno task check`、`deno lint`、`deno fmt --check` 通过；
- 仓库全量 `deno task test` 全绿（含实现阶段修复/移除的三项先存失败用例）。
