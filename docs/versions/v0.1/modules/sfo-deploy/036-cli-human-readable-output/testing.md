---
task_manifest: task.yaml
status: approved
---

# CLI 按步骤输出人类可读信息测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md`。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py
sfo-deploy/036-cli-human-readable-output all`：先执行仓库编译契约
C1，再按 unit、 dv、integration 顺序执行并写出运行工件。

## Submodule Tests

无独立业务子模块层；执行事件（src/execution.ts）、事件转换（src/integration.ts）与 CLI
渲染（src/cli.ts）按文件级覆盖登记。

## Module-Level Tests

`tests/dv/execution.test.ts` 覆盖 `DeploymentExecutor` 的 onStep：成功路径事件顺序与
总步数、失败/跳过路径事件、预取消路径事件，均与最终 `DeploymentResult` 的步骤一致。

## External Interface Tests

- CLI 默认输出：人可读分步行与汇总，stdout 不再输出 JSON 文档。
- `--json` 契约：`serializeResult` 结构、键名与排序不变，错误对象同走既有 redactor。
- 公开 API：`RunDependencies.onProgress` 与 `ExecuteOptions.onStep` 均为可选新增， 缺省不改变
  `run()`/`executePlan()` 行为。
- 文档：README 与帮助文本说明默认人可读输出与 `--json`。

## Direct Change Coverage

| change_id                 | design_source                                                                       | validation_id                     | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ------------------------- | ----------------------------------------------------------------------------------- | --------------------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-cli-step-human-output | design.md File-Level Interfaces、Key Flows、State and Ownership、Risks and Rollback | VAL-1、VAL-6、VAL-7               | dv             | D1               | no  | -                 |
| CHG-cli-json-flag         | design.md File-Level Interfaces、Key Flows、API and Build Surface Impact            | VAL-2、VAL-3、VAL-4、VAL-8、VAL-9 | integration    | I1               | no  | -                 |
| CHG-cli-output-docs       | design.md API and Build Surface Impact、Consumer Migration Closure、Design Notes    | VAL-4、VAL-5、VAL-9、VAL-10       | unit           | U1               | no  | -                 |

## Validation Rationale

测试由 proposal PI-1/PI-2/PI-3 与 design.md 的 `--json` 参数域、默认/JSON 两条输出
分支、步骤事件发射点、错误脱敏与 README 迁移说明派生。单元覆盖渲染与解析分支；DV
覆盖真实执行链的步骤事件；集成覆盖既有 JSON 消费方显式 `--json` 后的契约不回归。

## Case-Type Coverage

| change_id                 | case_type     | required | validation_id       | level       | status  | gap_manual_reason |
| ------------------------- | ------------- | -------- | ------------------- | ----------- | ------- | ----------------- |
| CHG-cli-step-human-output | normal        | yes      | VAL-1、VAL-6        | unit        | covered | -                 |
| CHG-cli-step-human-output | boundary      | yes      | VAL-7               | dv          | covered | -                 |
| CHG-cli-step-human-output | negative      | no       | VAL-7               | dv          | covered | -                 |
| CHG-cli-step-human-output | error         | yes      | VAL-3               | unit        | covered | -                 |
| CHG-cli-step-human-output | compatibility | yes      | VAL-6               | dv          | covered | -                 |
| CHG-cli-step-human-output | lifecycle     | yes      | VAL-6、VAL-7        | dv          | covered | -                 |
| CHG-cli-step-human-output | cross-module  | no       | VAL-6               | dv          | covered | -                 |
| CHG-cli-json-flag         | normal        | yes      | VAL-2、VAL-8        | unit        | covered | -                 |
| CHG-cli-json-flag         | boundary      | yes      | VAL-4               | unit        | covered | -                 |
| CHG-cli-json-flag         | negative      | yes      | VAL-3               | unit        | covered | -                 |
| CHG-cli-json-flag         | error         | yes      | VAL-3               | unit        | covered | -                 |
| CHG-cli-json-flag         | compatibility | yes      | VAL-2、VAL-8、VAL-9 | integration | covered | -                 |
| CHG-cli-json-flag         | lifecycle     | no       | VAL-9               | integration | covered | -                 |
| CHG-cli-json-flag         | cross-module  | no       | VAL-9               | integration | covered | -                 |
| CHG-cli-output-docs       | normal        | yes      | VAL-4、VAL-5        | unit        | covered | -                 |
| CHG-cli-output-docs       | boundary      | no       | VAL-4               | unit        | covered | -                 |
| CHG-cli-output-docs       | negative      | no       | VAL-9               | integration | covered | -                 |
| CHG-cli-output-docs       | error         | no       | VAL-9               | integration | covered | -                 |
| CHG-cli-output-docs       | compatibility | yes      | VAL-5、VAL-8        | integration | covered | -                 |
| CHG-cli-output-docs       | lifecycle     | no       | VAL-4               | unit        | covered | -                 |
| CHG-cli-output-docs       | cross-module  | no       | VAL-9、VAL-10       | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                             | derived_cases                                              | level | status  | gap_manual_reason |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------- | ----- | ------- | ----------------- |
| parameter-domain | File-Level Interfaces 的 --json 输入域                    | --json 缺省、显式出现、内联值拒绝                          | unit  | covered | -                 |
| state-transition | Key Flows 的 默认/--json 输出分支                         | 事件行 + 人可读汇总；--json 单一 JSON 文档                 | unit  | covered | -                 |
| failure-path     | Key Flows 与 Risks and Rollback 的失败处理                | 错误默认可读、--json 错误对象、redactor 生效               | unit  | covered | -                 |
| error-handling   | Risks and Rollback 的错误类别                             | 退出码 2/3/4/0 不回归，错误分类文案一致                    | unit  | covered | -                 |
| invariant        | State and Ownership：事件顺序与步骤一致、--json JSON 稳定 | 成功/失败/跳过/取消事件顺序与结果一致；JSON 结构与键名稳定 | unit  | covered | -                 |
| concurrency      | State and Ownership：事件同步 await 保证顺序              | 多步串行执行的事件序与结果序一致                           | dv    | covered | -                 |

## Unit Tests

| function_or_unit                  | branch_or_condition                | covered_behavior                                         | test_file                                                             | status  | gap_manual_reason |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- | ------- | ----------------- |
| parseArguments                    | --json 缺省/出现/内联拒绝          | 默认 false、显式 true、`--json=x` 返回 2                 | tests/unit/cli_human_output.test.ts                                   | covered | -                 |
| writeProgressLine + humanStepLine | succeeded/skipped/failed           | 中文字符串行、序号、跳过原因、失败详情                   | tests/unit/cli_human_output.test.ts                                   | covered | -                 |
| writeHumanResult                  | DeploymentResult/InstallDenoResult | 状态与目标汇总、install-deno 逐机行                      | tests/unit/cli_human_output.test.ts                                   | covered | -                 |
| createCli 成功路径                | human vs --json                    | 默认 stdout 无 JSON；--json 可 JSON.parse 且键名稳定     | tests/unit/cli_human_output.test.ts                                   | covered | -                 |
| createCli 错误路径                | human vs --json                    | 默认 stderr 人可读；--json stderr 为错误对象且秘密被脱敏 | tests/unit/cli_human_output.test.ts、tests/unit/transport_cli.test.ts | covered | -                 |
| usage/actionUsage                 | --json 帮助                        | 全局与动作帮助均包含 --json 与默认人可读说明             | tests/unit/cli_human_output.test.ts                                   | covered | -                 |
| 文档契约                          | README 输出段                      | README 写明默认分步输出与 --json 稳定契约                | tests/unit/cli_human_output.test.ts                                   | covered | -                 |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
|---|---|---|---|---|---| | onStep-success-order | main | executePlan 全量成功计划 |
事件与结果步骤一一对应、index/total 正确 | tests/dv/execution.test.ts | covered | - | |
onStep-failed-skipped | failure | MemoryTransport 目标失败 | FAILED/SKIPPED
步骤同样触发事件且顺序一致 | tests/dv/execution.test.ts | covered | - | | onStep-cancelled |
lifecycle | 预取消的 PreparedExecution | 全部步骤为 CANCELLED 且事件完整 |
tests/dv/execution.test.ts | covered | - | | onProgress-缺省回归 | main | 无 onProgress 的既有 run()
路径 | 行为不变、测试不回归 | tests/dv/execution.test.ts（16 项全通过） | covered | - |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status |
gap_manual_reason | |---|---|---|---|---|---| | fetch --json 契约 | cli → integration →
package_cache | 下载与缓存两种 stdout 均可 JSON.parse | 未知 App/非法过滤默认可读错误且退出码 2 |
tests/integration/fetch_package.test.ts | covered | - | | install-deno --json 契约 | cli →
integration → InstallDenoResult | stdout JSON kind/status/exit_code/machines 稳定 |
preflight/transport 退出码 3/4 由 unit 覆盖 | tests/integration/install_deno_cli.test.ts | covered
| - | | 仓库编译契约 | 生产 + 测试文件 | deno check --frozen 全量编译通过 | 编译失败即告警 |
testplan C1（repository-compile-closure） | covered | - | | 文档契约 | src/cli.ts ↔ README |
README/帮助包含默认人可读与 --json 说明 | 缺标记即退出非零 | testplan C2（documentation-examples） |
covered | - |

## Definition of Done

- `test-run.py sfo-deploy/036-cli-human-readable-output all` 全部通过并写运行工件。
- `deno task check`、lint、fmt 通过；全量测试 160+ 项通过。
- 真实 multipass prepare 冒烟留作 manual_gap。
