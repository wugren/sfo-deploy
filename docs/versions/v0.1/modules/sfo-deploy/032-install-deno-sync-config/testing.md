---
task_manifest: task.yaml
status: approved
---

# install-deno 自动同步 machines.yaml 测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行。任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py
sfo-deploy/032-install-deno-sync-config all`：先执行
`docs-contract` 步骤，再按 unit、dv、integration 声明顺序执行任务测试，并写出机器可读运行工件。

## Submodule Tests

本任务在 sfo-deploy 模块内按文件级分解（`src/config.ts` 的 `syncMachineDenos` 与
`src/integration.ts` 的 `runInstallDeno`），没有独立业务子模块层；文件级覆盖由单元、 DV
与集成测试表逐文件登记，不建立 submodule 测试文档。

## Module-Level Tests

模块级行为由 `tests/dv/install_deno.test.ts` 覆盖：真实装载临时集群后经 `run()` 串起 集成层 →
`installDenoOnMachine`（FakeSession 替身）→ `syncMachineDenos` → `InstallDenoResult`
的完整数据流：缺省安装后配置被同步、present 跳过也同步、失败机器 不更新、flow-style
配置导致的同步失败映射到 cleanup_errors 与退出码 4。

## External Interface Tests

- 公开 CLI 契约：`CLI_ACTIONS`/帮助文本/`--deno-version`/`--install-to` 参数不变， RunOptions
  拒绝混用筛选，由 `tests/unit/install_deno_cli.test.ts` 回归保护。
- 公开模块导出：`src/mod.ts` 不新增/删除公开符号，`InstallDenoResult` 与 `MachineDenoOutcome`
  序列化语义不变，由 `tests/integration/install_deno_cli.test.ts` 覆盖。
- CLI JSON 输出：`serializeResult` 输出稳定 `kind/status/exit_code/machines` 字段； 同步失败复用既有
  `cleanup_errors`，不新增字段。
- 文档同步契约：README、集群配置指南与示例 README 同时包含可执行示例与“自动同步
  machines.yaml”说明，由 `tests/contract/verify_install_deno_contract.ts` 覆盖。

## Direct Change Coverage

| change_id                    | design_source                                                                          | validation_id  | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-install-deno-sync-config | design.md File-Level Interfaces、Key Flows、State and Ownership、Risks and Rollback    | VAL-1..VAL-15  | integration    | I1               | no  | -                 |
| CHG-install-deno-sync-docs   | design.md API and Build Surface Impact、Consumer Migration Closure、Risks and Rollback | VAL-12、VAL-13 | integration    | I1               | no  | -                 |

## Validation Rationale

测试由 proposal PI-1/PI-2 与 design.md 的 Key Flows、State and Ownership、File-Level
Interfaces、Risks and Rollback、API and Build Surface Impact 直接派生。单元层覆盖 `syncMachineDenos`
的输入域、替换/插入、CRLF、临时文件清理与 fail-closed；DV 层覆盖
安装/present/失败/同步失败主链路和配置持久化；集成与契约层覆盖公开 CLI/JSON 契约与
三份文档说明。对应 risk-profile 的 contract/data/security/runtime required_checks 均
有测试步骤；真实 SSH 目标机与权限型 rename 失败留作 manual_gaps。

## Case-Type Coverage

| change_id                    | case_type     | required | validation_id              | level       | status  | gap_manual_reason |
| ---------------------------- | ------------- | -------- | -------------------------- | ----------- | ------- | ----------------- |
| CHG-install-deno-sync-config | normal        | yes      | VAL-1、VAL-7、VAL-8        | unit        | covered | -                 |
| CHG-install-deno-sync-config | boundary      | yes      | VAL-2、VAL-3、VAL-4、VAL-5 | unit        | covered | -                 |
| CHG-install-deno-sync-config | negative      | yes      | VAL-3                      | unit        | covered | -                 |
| CHG-install-deno-sync-config | error         | yes      | VAL-10                     | dv          | covered | -                 |
| CHG-install-deno-sync-config | compatibility | yes      | VAL-6、VAL-12              | unit        | covered | -                 |
| CHG-install-deno-sync-config | lifecycle     | yes      | VAL-7、VAL-8、VAL-9        | dv          | covered | -                 |
| CHG-install-deno-sync-config | cross-module  | yes      | VAL-7、VAL-10              | dv          | covered | -                 |
| CHG-install-deno-sync-docs   | normal        | yes      | VAL-13                     | integration | covered | -                 |
| CHG-install-deno-sync-docs   | boundary      | no       | VAL-13                     | integration | covered | -                 |
| CHG-install-deno-sync-docs   | negative      | no       | VAL-13                     | integration | covered | -                 |
| CHG-install-deno-sync-docs   | error         | no       | VAL-13                     | integration | covered | -                 |
| CHG-install-deno-sync-docs   | compatibility | yes      | VAL-12、VAL-13             | integration | covered | -                 |
| CHG-install-deno-sync-docs   | lifecycle     | no       | VAL-13                     | integration | covered | -                 |
| CHG-install-deno-sync-docs   | cross-module  | no       | VAL-13                     | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                                       | derived_cases                                                                              | level | status         | gap_manual_reason        |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----- | -------------- | ------------------------ |
| parameter-domain | File-Level Interfaces 的 MachineDenoUpdate 输入域                   | 空列表、重复机器、相对/非规范路径、block/flow 布局、CRLF                                   | unit  | covered        | -                        |
| state-transition | State and Ownership 的 InstalledOrPresent → ConfigSynced/SyncFailed | 安装成功同步、present 同步、失败不更新、同步失败                                           | dv    | covered        | -                        |
| failure-path     | Key Flows 的同步失败处理                                            | flow-style 配置无法定位机器块 → cleanup_errors + exit 4                                    | dv    | covered        | -                        |
| error-handling   | Risks and Rollback 的错误类别                                       | machines.yaml 同步失败文案与 cleanup_errors 语义                                           | dv    | covered        | -                        |
| invariant        | State and Ownership、Design Notes 的严格重载与字段保留              | 替换/插入后注释、字段顺序与其他机器不变；同步后 loadCluster 可读                           | unit  | covered        | -                        |
| concurrency      | State and Ownership（不引入跨进程锁/并行排序）                      | not-applicable: 设计未声明并发或并行共享状态；写回在同一进程内串行执行，无共享可变状态可测 | unit  | not-applicable | 无并发或并行共享状态可测 |

## Unit Tests

| function_or_unit | branch_or_condition | covered_behavior | test_file | status | gap_manual_reason
| |---|---|---|---|---| | syncMachineDenos | 空更新早退 | 空列表不读/不写目标文件 |
tests/unit/config_planning.test.ts | covered | - | | syncMachineDenos | 更新输入校验 |
重复机器名、未知机器、非规范绝对路径 fail-closed | tests/unit/config_planning.test.ts | covered | -
| | syncMachineDenos | 已存在 deno 行 | 只替换目标机器 deno 值并保留行尾注释 |
tests/unit/config_planning.test.ts | covered | - | | syncMachineDenos | 缺失 deno 行 |
在多机器文件中按后部优先插入且不重排其它字段 | tests/unit/config_planning.test.ts | covered | - | |
syncMachineDenos | 不支持的 YAML 布局 | flow-style 机器条目明确失败并提示 block 条目 |
tests/unit/config_planning.test.ts | covered | - | | syncMachineDenos | CRLF 与 EOL 保持 |
空更新无副作用、CRLF 行尾数量保持 | tests/unit/config_planning.test.ts | covered | - | |
syncMachineDenos | 原子提交与清理 | 成功后不留 .sfo-deno-* 临时文件；strict 重载可读 |
tests/unit/config_planning.test.ts | covered | - | | syncMachineDenos | 已存在相同路径 |
路径一致时不重写文件 | tests/unit/config_planning.test.ts | covered | - | | syncMachineDenos |
裸命令而非绝对路径 | 拒绝 `deno` 等非绝对路径输入 | tests/unit/config_planning.test.ts | covered | -
| | syncMachineDenos | rename/权限级提交失败 | 容器以 root 运行无法可靠构造目标目录不可写或 rename
失败的权限场景 | tests/unit/config_planning.test.ts | manual | root 环境下权限/rename
失败无法稳定复现；失败路径由 flow-style 同步失败 DV 和代码级原子替换设计覆盖 | | InstallDenoResult |
cleanup_errors → exit 4 | 既有结果类把 cleanupErrors 作为执行失败且不改变机器 status |
tests/unit/install_deno_cli.test.ts | covered | - |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
|---|---|---|---|---|---| | install-deno-main-config | main | 缺省安装临时集群 | installed +
machines.yaml 更新为 /home/deploy/.deno/bin/deno + exit 0 | tests/dv/install_deno.test.ts | covered
| - | | install-deno-privileged-config | config | --install-to /usr/local | installed +
machines.yaml 更新为 /usr/local/bin/deno | tests/dv/install_deno.test.ts | covered | - | |
install-deno-present-config | lifecycle | 已满足版本 | present 跳过安装且配置更新为探测路径 |
tests/dv/install_deno.test.ts | covered | - | | install-deno-failed-config-stable | failure |
远端安装失败 | failed + exit 4 + machines.yaml 保持原值 | tests/dv/install_deno.test.ts | covered
| - | | install-deno-sync-failure | failure | flow-style machines.yaml 无法定位机器块 | installed +
cleanup_errors 含同步失败 + exit 4 | tests/dv/install_deno.test.ts | covered | - | |
install-deno-tools-config | lifecycle | 缺失工具自动补齐后安装 | installed + 配置同步为默认路径 |
tests/dv/install_deno.test.ts | covered | - |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status |
gap_manual_reason | |---|---|---|---|---|---| | CLI_ACTIONS/公开导出/JSON 输出 | cli → integration →
results | 集合包含 install-deno、InstallDenoResult 可构造且 JSON 字段稳定 | 参数错误/preflight
退出码由单元覆盖 | tests/integration/install_deno_cli.test.ts | covered | - | | 文档同步契约 | docs
↔ config/integration 行为 | 三份文档含同步说明与可执行示例 | 任一文档缺标记时脚本抛错 fail |
tests/contract/verify_install_deno_contract.ts | covered | - |

## Definition of Done

- 任务作用域命令 `test-run.py sfo-deploy/032-install-deno-sync-config all` 全部步骤退出码 0并写入
  机器可读运行工件。
- `deno task check`、`deno task lint`、`deno task fmt` 通过。
- 除 root 权限型 rename 失败为 manual 外，设计派生用例均已覆盖；真实 SSH 目标机作为 manual_gap 在
  testplan 记录。
