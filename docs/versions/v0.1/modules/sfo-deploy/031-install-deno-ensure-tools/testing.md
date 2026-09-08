---
task_manifest: task.yaml
status: approved
---

# install-deno 自动补齐远端 curl/unzip 测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行。任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py
sfo-deploy/031-install-deno-ensure-tools all`：先执行
`docs-contract` 步骤，再按 unit、dv、integration 声明顺序执行任务测试，并写出机器可读运行工件。

## Submodule Tests

本任务在 sfo-deploy 模块内按文件级分解（`src/ssh_install.ts`），没有独立业务子模块层；
文件级覆盖由单元/DV/集成测试表逐文件登记，不建立 submodule 测试文档。

## Module-Level Tests

模块级行为由 `tests/dv/install_deno.test.ts` 覆盖：真实装载临时集群后经 `run()` 串起 集成层 →
`installDenoOnMachine`（FakeSession 替身，含包管理命令模拟）→ `InstallDenoResult`
的完整数据流：缺工具自动补齐主流程、无包管理器失败映射、安装、
已满足跳过、提权配置、失败关闭与缺省全量确认门禁。

## External Interface Tests

- 公开 CLI 契约：`CLI_ACTIONS`/帮助文本包含 `install-deno`，`--deno-version` 与 `--install-to`
  参数可用，RunOptions 拒绝 apps/environments/withDependencies 混用， 由
  `tests/unit/install_deno_cli.test.ts` 覆盖（本任务未改 CLI，作回归保护）。
- 公开模块导出：`src/mod.ts` 导出 `InstallDenoResult` 与 `MachineDenoOutcome`， `RunResult` 联合包含
  `InstallDenoResult`，由 `tests/integration/install_deno_cli.test.ts` 覆盖。
- CLI JSON 输出：`serializeResult` 输出稳定 `kind/status/exit_code/machines` 字段，
  由单元与集成测试覆盖。
- 文档自动补齐契约：README、集群配置指南与示例 README 同时包含可执行示例与自动补齐
  说明（提权、发行版仓库信任边界、apt-get 自动安装），由
  `tests/contract/verify_install_deno_contract.ts` 覆盖。

## Direct Change Coverage

| change_id                  | design_source                                                                       | validation_id                 | testplan_level | testplan_step_id | gap | gap_manual_reason |
| -------------------------- | ----------------------------------------------------------------------------------- | ----------------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-deno-ensure-tools      | design.md File-Level Interfaces、Key Flows、Risks and Rollback、State and Ownership | VAL-1..VAL-23, VAL-27, VAL-28 | dv             | D1               | no  | -                 |
| CHG-deno-ensure-tools-docs | design.md API and Build Surface Impact、Design Notes、Risks and Rollback            | VAL-24..VAL-26                | integration    | I1               | no  | -                 |

## Validation Rationale

测试由 proposal PI-1/PI-2 与 design.md 的 Key Flows、State and Ownership、Risks and
Rollback、File-Level Interfaces、Design Notes 直接派生。单元层覆盖 ensureRemoteTools
的探测/包管理器选择/固定模板安装/失败路径每个分支，以及既有版本/路径校验与 CLI 参数回归； DV
层覆盖缺工具自动补齐与无包管理器失败的模块级全链；集成层覆盖公开动作/导出/JSON 契约
与文档示例；合同步骤固定验证三份文档的自动补齐说明。对应 risk-profile 的
contract/security/runtime/build required_checks 均有测试步骤；真实 SSH 目标机留作 manual_gaps。

## Case-Type Coverage

| change_id                  | case_type     | required | validation_id                                          | level       | status  | gap_manual_reason |
| -------------------------- | ------------- | -------- | ------------------------------------------------------ | ----------- | ------- | ----------------- |
| CHG-deno-ensure-tools      | normal        | yes      | VAL-1, VAL-2, VAL-10                                   | unit        | covered | -                 |
| CHG-deno-ensure-tools      | normal        | yes      | VAL-21                                                 | dv          | covered | -                 |
| CHG-deno-ensure-tools      | boundary      | yes      | VAL-3, VAL-4, VAL-5, VAL-6, VAL-7                      | unit        | covered | -                 |
| CHG-deno-ensure-tools      | negative      | yes      | VAL-8, VAL-9                                           | unit        | covered | -                 |
| CHG-deno-ensure-tools      | negative      | yes      | VAL-22                                                 | dv          | covered | -                 |
| CHG-deno-ensure-tools      | error         | yes      | VAL-11, VAL-12, VAL-13, VAL-14, VAL-15, VAL-27, VAL-28 | unit        | covered | -                 |
| CHG-deno-ensure-tools      | error         | yes      | VAL-27                                                 | dv          | covered | -                 |
| CHG-deno-ensure-tools      | compatibility | yes      | VAL-16, VAL-17, VAL-18, VAL-19, VAL-20                 | unit        | covered | -                 |
| CHG-deno-ensure-tools      | compatibility | yes      | VAL-24                                                 | integration | covered | -                 |
| CHG-deno-ensure-tools      | lifecycle     | yes      | VAL-10, VAL-23, VAL-25                                 | dv          | covered | -                 |
| CHG-deno-ensure-tools      | cross-module  | yes      | VAL-23                                                 | dv          | covered | -                 |
| CHG-deno-ensure-tools      | cross-module  | yes      | VAL-25                                                 | integration | covered | -                 |
| CHG-deno-ensure-tools-docs | normal        | yes      | VAL-26                                                 | integration | covered | -                 |
| CHG-deno-ensure-tools-docs | boundary      | no       | VAL-26                                                 | integration | covered | -                 |
| CHG-deno-ensure-tools-docs | negative      | no       | VAL-26                                                 | integration | covered | -                 |
| CHG-deno-ensure-tools-docs | error         | no       | VAL-26                                                 | integration | covered | -                 |
| CHG-deno-ensure-tools-docs | compatibility | yes      | VAL-24, VAL-25                                         | integration | covered | -                 |
| CHG-deno-ensure-tools-docs | lifecycle     | no       | VAL-25                                                 | integration | covered | -                 |
| CHG-deno-ensure-tools-docs | cross-module  | no       | VAL-25                                                 | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                  | derived_cases                                        | level | status         | gap_manual_reason        |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------- | ----- | -------------- | ------------------------ |
| parameter-domain | File-Level Interfaces 的 probe/包管理器输入域  | 工具集合空/单项/双项组合、四种包管理器模板、缺一补一 | unit  | covered        | -                        |
| state-transition | State and Ownership 的缺失→安装→复测→成功/失败 | 齐全跳过、缺失补齐成功、复测仍缺失败                 | unit  | covered        | -                        |
| failure-path     | Key Flows 的失败处理                           | update 失败、install 失败、无包管理器、安装后仍缺    | unit  | covered        | -                        |
| error-handling   | Risks and Rollback 的错误类别                  | 探测失败/update/install/仍缺失的 TransportError 文案 | unit  | covered        | -                        |
| invariant        | 传输层严格 argv 校验                           | 探测与安装脚本无控制字符且通过 validateArgv          | unit  | covered        | -                        |
| concurrency      | design.md（无并发声明；单会话顺序执行）        | not-applicable: 设计未声明并发/并行或排序共享状态    | unit  | not-applicable | 无并发或并行共享状态可测 |

## Unit Tests

| function_or_unit                                     | branch_or_condition          | covered_behavior                         | test_file                           | status  | gap_manual_reason |
| ---------------------------------------------------- | ---------------------------- | ---------------------------------------- | ----------------------------------- | ------- | ----------------- |
| probeTools                                           | 工具存在/为空                | 空格分隔输出解析为工具名列表             | tests/unit/ssh_install.test.ts      | covered | -                 |
| ensureRemoteTools                                    | 提权不可用（工具补齐阶段）   | 透传 PreflightError 且不执行安装脚本     | tests/unit/ssh_install.test.ts      | covered | -                 |
| detectPackageManager                                 | apt-get/apk/dnf/yum 任一存在 | 返回固定名称与绝对路径                   | tests/unit/ssh_install.test.ts      | covered | -                 |
| detectPackageManager                                 | 无包管理器/未知二进制        | 返回 undefined 使调用方 fail-closed      | tests/unit/ssh_install.test.ts      | covered | -                 |
| packageInstallArgv                                   | apt/apk/dnf/yum 模板         | 固定参数模板且包名只有 curl/unzip        | tests/unit/ssh_install.test.ts      | covered | -                 |
| installRemotePackages                                | apt update 失败              | TransportError 刷新 apt 软件源失败       | tests/unit/ssh_install.test.ts      | covered | -                 |
| installRemotePackages                                | 包安装命令非零               | TransportError 安装远端基础工具失败      | tests/unit/ssh_install.test.ts      | covered | -                 |
| installRemotePackages                                | 提权标记                     | 全部包管理命令 privileged=true           | tests/unit/ssh_install.test.ts      | covered | -                 |
| ensureRemoteTools                                    | 下载器/解压器齐全            | 不做任何包管理操作                       | tests/unit/ssh_install.test.ts      | covered | -                 |
| ensureRemoteTools                                    | 只缺下载器/只缺解压器        | 只安装对应缺失包                         | tests/unit/ssh_install.test.ts      | covered | -                 |
| ensureRemoteTools                                    | 两者都缺                     | apt-get update + install curl unzip      | tests/unit/ssh_install.test.ts      | covered | -                 |
| ensureRemoteTools                                    | 复测仍缺                     | TransportError 仍缺失并提示手工安装      | tests/unit/ssh_install.test.ts      | covered | -                 |
| installDenoOnMachine                                 | 已满足版本且无工具           | present 跳过工具补齐与安装               | tests/unit/ssh_install.test.ts      | covered | -                 |
| installDenoOnMachine                                 | 未满足版本                   | 补齐工具后执行固定版本安装并验证         | tests/unit/ssh_install.test.ts      | covered | -                 |
| installDenoOnMachine                                 | 探测/安装脚本无控制字符      | validateArgv 接受全部 sh 探测与安装 argv | tests/unit/ssh_install.test.ts      | covered | -                 |
| normalizeDenoVersion / validateInstallTo             | 合法/非法输入域              | 规范化与拒绝逻辑不回归                   | tests/unit/ssh_install.test.ts      | covered | -                 |
| parseArguments / serializeResult / InstallDenoResult | CLI 参数/JSON/退出码         | 契约不回归                               | tests/unit/install_deno_cli.test.ts | covered | -                 |

## DV Tests

| workflow                       | kind      | entry                                        | expected_result                                          | test_file_or_script           | status  | gap_manual_reason |
| ------------------------------ | --------- | -------------------------------------------- | -------------------------------------------------------- | ----------------------------- | ------- | ----------------- |
| install-deno-tools-main        | main      | 缺 curl/unzip 的临时集群经 run() 安装        | apt 补齐后 installed + exitCode 0 + 会话关闭             | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-tools-unsupported | failure   | 目标机无包管理器                             | failed + errorCategory transport + exitCode 4 + 会话关闭 | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-tools-preflight   | failure   | 工具补齐阶段提权失败（非 root/不可 sudo -n） | failed + errorCategory preflight + exitCode 3 + 会话关闭 | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-main              | main      | 工具齐全的临时集群安装                       | installed + exitCode 0 + 会话关闭                        | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-present           | lifecycle | 已满足版本探测                               | present 跳过安装                                         | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-privileged-root   | config    | --install-to /usr/local                      | 提权安装调用与 DENO_INSTALL 正确                         | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-failure           | failure   | 安装命令失败                                 | failed + exitCode 4 + 会话仍关闭                         | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-preflight-exit    | failure   | SSH 预检失败（known_hosts）                  | failed + errorCategory preflight + exitCode 3            | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-confirm-gate      | main      | 缺省全量未确认                               | CancelledError 且零连接                                  | tests/dv/install_deno.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow         | modules_involved                  | success_case                               | failure_case                            | test_file                                      | status  | gap_manual_reason |
| ------------------------ | --------------------------------- | ------------------------------------------ | --------------------------------------- | ---------------------------------------------- | ------- | ----------------- |
| CLI_ACTIONS 公共动作集合 | cli → integration                 | 集合包含 install-deno                      | 既有导出断言（不适用）                  | tests/integration/install_deno_cli.test.ts     | covered | -                 |
| 公开模块导出             | mod → results                     | InstallDenoResult 可构造且 toJSON 语义稳定 | 无失败语义（不适用）                    | tests/integration/install_deno_cli.test.ts     | covered | -                 |
| CLI JSON 输出链          | cli → runAction → serializeResult | stdout 输出 kind/status/machines 完整字段  | 参数错误路径由 unit RunOptions 拒绝覆盖 | tests/integration/install_deno_cli.test.ts     | covered | -                 |
| 文档自动补齐契约         | docs ↔ ssh_install 行为           | 三份文档含可执行示例与自动补齐/供应链说明  | 任一文档缺标记时脚本抛错 fail           | tests/contract/verify_install_deno_contract.ts | covered | -                 |

## Definition of Done

- 任务作用域命令 `test-run.py sfo-deploy/031-install-deno-ensure-tools all` 全部步骤退出码 0 并写入
  机器可读运行工件。
- `deno task check`、`deno task lint`、`deno task fmt` 通过。
- 无 design 派生用例的缺口；真实 SSH 目标机为 manual_gap 且已在 testplan 记录。
