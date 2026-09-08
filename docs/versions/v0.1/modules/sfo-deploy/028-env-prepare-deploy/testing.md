---
task_manifest: task.yaml
status: draft
---

# 环境应用 prepare 测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行：`harness/scripts/test-run.py`。任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/028-env-prepare-deploy all`，
它先执行 testplan 的 contract 步骤，再按 unit、dv、integration
声明顺序执行任务测试，并写出运行工件。

## Submodule Tests

本任务在 sfo-deploy 模块下按文件级分解（CLI/集成、计划、执行状态机、传输标记接口），没有独立业务
子模块，不建立 submodule 测试文档；文件级覆盖由单元/DV/集成测试表逐文件登记。

## Module-Level Tests

模块级行为由 `tests/dv/execution.test.ts` 的 prepare 状态机用例与
`tests/integration/env_prepare_cli.test.ts` 的 run() 全链路用例覆盖，验证跨组件数据流 （RunOptions →
集群装载 → buildPlan → executePlan → DeploymentResult）与版本标记生命周期。

## External Interface Tests

- `RemoteSession.readEnvironmentVersion`/`writeEnvironmentVersion`（新增接口）由 OpenSSH 与内存
  传输实现的 DV/集成测试覆盖：存在/缺失读取、写入、路径与资源名校验。
- 公开 CLI 契约（`prepare` 动作、`--env` 别名、拒绝 `--app`、缺省全量确认、帮助文本）由
  `tests/unit/env_prepare_cli.test.ts` 与 `tests/integration/env_prepare_cli.test.ts` 覆盖。
- App 前置门禁提示由 DV 测试断言失败消息包含 `sfo-deploy prepare`。

## Direct Change Coverage

| change_id               | design_source                                                              | validation_id               | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ----------------------- | -------------------------------------------------------------------------- | --------------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-env-prepare-command | design.md Key Flows、File-Level Interfaces（CLI/Integration/Planning）     | VAL-1, VAL-2, VAL-3, VAL-10 | unit           | U1               | no  | -                 |
| CHG-env-app-lifecycle   | design.md Key Flows、State and Ownership（start/restart 跳过与标记时机）   | VAL-4, VAL-5, VAL-6, VAL-11 | dv             | D1               | no  | -                 |
| CHG-env-app-update      | design.md State and Ownership、File-Level Interfaces（Transport 标记接口） | VAL-4, VAL-7, VAL-12        | dv             | D1               | no  | -                 |
| CHG-app-env-ready-gate  | design.md Risks and Rollback、Key Flows（阻断与提示）                      | VAL-8                       | dv             | D2               | no  | -                 |
| CHG-docs-tests          | design.md API and Build Surface Impact、Consumer Migration Closure         | VAL-9, VAL-13               | integration    | I2               | no  | -                 |

## Validation Rationale

测试用例由 proposal PI-1 至 PI-5 与 design.md 的 Key Flows、State and Ownership、Risks and
Rollback、File-Level Interfaces 直接派生：每次运行验证 prepare 计划/CLI 契约与执行状态机，DV
用例逐一覆盖 up-to-date、首次安装 start、更新 restart、缺脚本跳过与失败不写标记，集成用例验证 run()
跨模块链与缺省全量确认门禁；文档契约步骤验证 README/指南/示例 README 的 prepare 示例边界。 对应
risk-profile 的 contract/data/runtime/harness required_checks 均落实为具体步骤。

## Definition of Done

- 五个 change_id 均有直接验证映射（Direct Change Coverage），无未覆盖或 gap。
- `sfo-deploy/028-env-prepare-deploy all` 统一入口运行通过：docs 契约、unit、DV、integration
  全部步骤成功并写出运行工件。
- 全量 `deno task check`、`deno lint`、`deno fmt --check`、`deno task test` 通过。
- 真实 SSH 目标机部署留作 manual_gaps（real-ssh-prepare），不影响本任务测试完成结论。

## Case-Type Coverage

| change_id               | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| ----------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-env-prepare-command | normal        | yes      | VAL-1         | unit        | covered | -                 |
| CHG-env-prepare-command | boundary      | yes      | VAL-2         | unit        | covered | -                 |
| CHG-env-prepare-command | negative      | yes      | VAL-2         | unit        | covered | -                 |
| CHG-env-prepare-command | error         | yes      | VAL-10        | integration | covered | -                 |
| CHG-env-prepare-command | compatibility | yes      | VAL-3         | unit        | covered | -                 |
| CHG-env-prepare-command | lifecycle     | no       | VAL-10        | integration | covered | -                 |
| CHG-env-prepare-command | cross-module  | yes      | VAL-10        | integration | covered | -                 |
| CHG-env-app-lifecycle   | normal        | yes      | VAL-5         | dv          | covered | -                 |
| CHG-env-app-lifecycle   | boundary      | yes      | VAL-4         | dv          | covered | -                 |
| CHG-env-app-lifecycle   | negative      | yes      | VAL-6         | dv          | covered | -                 |
| CHG-env-app-lifecycle   | error         | yes      | VAL-6         | dv          | covered | -                 |
| CHG-env-app-lifecycle   | compatibility | no       | VAL-4         | dv          | covered | -                 |
| CHG-env-app-lifecycle   | lifecycle     | yes      | VAL-5         | dv          | covered | -                 |
| CHG-env-app-lifecycle   | cross-module  | no       | VAL-11        | integration | covered | -                 |
| CHG-env-app-update      | normal        | yes      | VAL-5         | dv          | covered | -                 |
| CHG-env-app-update      | boundary      | yes      | VAL-7         | dv          | covered | -                 |
| CHG-env-app-update      | negative      | yes      | VAL-7         | dv          | covered | -                 |
| CHG-env-app-update      | error         | yes      | VAL-4         | dv          | covered | -                 |
| CHG-env-app-update      | compatibility | no       | VAL-5         | dv          | covered | -                 |
| CHG-env-app-update      | lifecycle     | yes      | VAL-7         | dv          | covered | -                 |
| CHG-env-app-update      | cross-module  | no       | VAL-12        | integration | covered | -                 |
| CHG-app-env-ready-gate  | normal        | yes      | VAL-8         | dv          | covered | -                 |
| CHG-app-env-ready-gate  | boundary      | no       | VAL-8         | dv          | covered | -                 |
| CHG-app-env-ready-gate  | negative      | yes      | VAL-8         | dv          | covered | -                 |
| CHG-app-env-ready-gate  | error         | yes      | VAL-8         | dv          | covered | -                 |
| CHG-app-env-ready-gate  | compatibility | no       | VAL-8         | dv          | covered | -                 |
| CHG-app-env-ready-gate  | lifecycle     | no       | VAL-8         | dv          | covered | -                 |
| CHG-app-env-ready-gate  | cross-module  | no       | VAL-8         | dv          | covered | -                 |
| CHG-docs-tests          | normal        | yes      | VAL-9         | integration | covered | -                 |
| CHG-docs-tests          | boundary      | yes      | VAL-13        | integration | covered | -                 |
| CHG-docs-tests          | negative      | no       | VAL-9         | integration | covered | -                 |
| CHG-docs-tests          | error         | no       | VAL-9         | integration | covered | -                 |
| CHG-docs-tests          | compatibility | yes      | VAL-13        | integration | covered | -                 |
| CHG-docs-tests          | lifecycle     | no       | VAL-9         | integration | covered | -                 |
| CHG-docs-tests          | cross-module  | no       | VAL-13        | integration | covered | -                 |

## Unit Tests

| function_or_unit  | branch_or_condition                               | covered behavior                                            | test file                                                            | status  | gap_manual_reason |
| ----------------- | ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ------- | ----------------- |
| buildPlan         | prepare 环境序列分支                              | check/install/configure 与声明式 start/restart 顺序及依赖链 | tests/unit/env_prepare_planning.test.ts                              | covered | -                 |
| buildPlan         | 未声明 lifecycle 分支                             | 不生成 start/restart 步骤；不选择任何 App                   | tests/unit/env_prepare_planning.test.ts                              | covered | -                 |
| buildPlan         | 环境筛选分支                                      | environments 过滤只保留指定环境应用                         | tests/unit/env_prepare_planning.test.ts                              | covered | -                 |
| parseArguments    | --env 分支                                        | --env 与 --environment 同栈解析、可重复                     | tests/unit/env_prepare_cli.test.ts                                   | covered | -                 |
| RunOptions        | prepare 环境动作约束分支                          | prepare 拒绝 --app                                          | tests/unit/env_prepare_cli.test.ts                                   | covered | -                 |
| ACTION_HELP       | prepare 帮助条目                                  | 帮助包含 --env、首次 start/更新 restart 说明                | tests/unit/env_prepare_cli.test.ts                                   | covered | -                 |
| 既有配置/CLI 回归 | config_planning 与 transport_cli 全部既有用例分支 | 无回归                                                      | tests/unit/config_planning.test.ts, tests/unit/transport_cli.test.ts | covered | -                 |

## DV Tests

| workflow                  | kind      | entry                         | expected_result                                                       | test_file_or_script        | status  | gap_manual_reason |
| ------------------------- | --------- | ----------------------------- | --------------------------------------------------------------------- | -------------------------- | ------- | ----------------- |
| prepare-up-to-date        | lifecycle | prepare 同版本且健康          | 只跑 check，跳过 install/configure/start/restart，不重写标记          | tests/dv/execution.test.ts | covered | -                 |
| prepare-first-install     | main      | prepare 首次安装              | check 未满足 → install → configure → start，成功后写标记              | tests/dv/execution.test.ts | covered | -                 |
| prepare-update            | main      | prepare 版本更新              | 版本不同 → configure → restart，start 以 using-restart 跳过，标记更新 | tests/dv/execution.test.ts | covered | -                 |
| prepare-no-lifecycle      | config    | prepare 缺 start/restart 脚本 | 计划无生命周期步骤，prepare 成功并写标记                              | tests/dv/execution.test.ts | covered | -                 |
| prepare-lifecycle-failure | failure   | prepare 生命周期失败          | start 失败 → prepare 失败且不写标记                                   | tests/dv/execution.test.ts | covered | -                 |
| app-gate-hint             | failure   | App 门禁失败提示              | 定向部署环境 check 失败消息包含 sfo-deploy prepare                    | tests/dv/execution.test.ts | covered | -                 |
| cancellation-regression   | main      | 取消/清理回归                 | 既有执行器取消与资源清理全量用例                                      | tests/dv/execution.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow        | modules_involved                            | success case                              | failure case                                | test file                                 | status  | gap_manual_reason |
| ----------------------- | ------------------------------------------- | ----------------------------------------- | ------------------------------------------- | ----------------------------------------- | ------- | ----------------- |
| CLI_ACTIONS 公共导出    | cli → integration                           | prepare 出现在动作集合                    | 导出断言无失败语义（不适用）                | tests/integration/env_prepare_cli.test.ts | covered | -                 |
| run() prepare 跨模块链  | integration → config → planning → execution | 装载→计划→执行→DeploymentResult，标记写入 | RunOptions 拒绝 --app 抛 ConfigurationError | tests/integration/env_prepare_cli.test.ts | covered | -                 |
| 缺省全量确认门禁        | cli → integration → execution               | 无 --env 时调用 confirmPlan 且放行后成功  | 拒绝路径已有 unit/deploy-confirm 既有覆盖   | tests/integration/env_prepare_cli.test.ts | covered | -                 |
| 公共 CLI 安装与帮助回归 | main → cli                                  | deno install 全局入口可打印帮助           | 既有用例覆盖失败语义                        | tests/integration/package_cli.test.ts     | covered | -                 |

## Design Element Coverage

| element_type     | design source                                        | derived cases                                                     | level | status  | gap_manual_reason |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ----- | ------- | ----------------- |
| parameter-domain | design.md Key Flows（version、resource、--env 值域） | 版本一致/不一致/缺失标记、资源名合法值、--env 重复与等价长参      | unit  | covered | -                 |
| state-transition | design.md State and Ownership                        | up-to-date/首次/更新/失败后保持旧标记                             | dv    | covered | -                 |
| failure-path     | design.md Key Flows 与 Risks and Rollback            | check 失败→安装、生命周期失败→不写标记、标记读写失败 fail-closed  | dv    | covered | -                 |
| error-handling   | design.md Risks and Rollback                         | 生命周期脚本非零退出、RunOptions --app 拒绝、CLI 参数错误退出码 2 | dv    | covered | -                 |
| invariant        | design.md State and Ownership（失败不更新标记）      | 生命周期失败后 environmentVersions 保持 undefined                 | dv    | covered | -                 |
| concurrency      | design.md（无并发声明；按序执行不可变计划）          | 步骤依赖链按声明顺序执行，跳过步骤满足依赖                        | unit  | covered | -                 |
