---
task_manifest: task.yaml
status: approved
---

# install-deno 缺省安装到 PATH 目录测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md`。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py
sfo-deploy/035-deno-home-fallback all`：先执行
docs-contract，再按 unit、dv、 integration 顺序执行并写出运行工件。

## Submodule Tests

无独立业务子模块层；安装编排（src/ssh_install.ts）、CLI/结果（src/cli.ts、
src/results.ts）按文件级覆盖登记。

## Module-Level Tests

`tests/dv/install_deno.test.ts` 覆盖 run() 全链：缺省安装返回 `/usr/local/bin/deno`、显式 /usr/local
提权、present 跳过、安装失败、preflight 确认门禁等。

## External Interface Tests

- CLI 帮助与公开动作：install-deno 参数/帮助包含缺省 /usr/local/bin/deno。
- InstallDenoResult JSON/退出码：安装失败 4、preflight 3、成功 0。
- 文档契约：README/指南/示例包含缺省命令与自动默认路径说明。

## Direct Change Coverage

| change_id                     | design_source                                                                       | validation_id  | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ----------------------------- | ----------------------------------------------------------------------------------- | -------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-install-deno-path-default | design.md File-Level Interfaces、Key Flows、State and Ownership、Risks and Rollback | VAL-1..VAL-9   | integration    | I1               | no  | -                 |
| CHG-install-deno-path-docs    | design.md API and Build Surface Impact、Consumer Migration Closure、Design Notes    | VAL-10..VAL-12 | integration    | I1               | no  | -                 |

## Validation Rationale

测试由 proposal PI-1/PI-2 与 design.md 的缺省根逻辑、提权判定、帮助/文档契约派生。 单元覆盖默认
/usr/local、显式 home 免提权、present 探针与 CLI 帮助；DV 覆盖缺省
安装全链；契约固定三份文档的缺省命令。

## Case-Type Coverage

| change_id                     | case_type     | required | validation_id  | level       | status  | gap_manual_reason |
| ----------------------------- | ------------- | -------- | -------------- | ----------- | ------- | ----------------- |
| CHG-install-deno-path-default | normal        | yes      | VAL-1          | unit        | covered | -                 |
| CHG-install-deno-path-default | normal        | yes      | VAL-7          | dv          | covered | -                 |
| CHG-install-deno-path-default | boundary      | yes      | VAL-2、VAL-3   | unit        | covered | -                 |
| CHG-install-deno-path-default | negative      | yes      | VAL-3          | unit        | covered | -                 |
| CHG-install-deno-path-default | negative      | yes      | VAL-6          | dv          | covered | -                 |
| CHG-install-deno-path-default | error         | yes      | VAL-8          | dv          | covered | -                 |
| CHG-install-deno-path-default | compatibility | yes      | VAL-4          | unit        | covered | -                 |
| CHG-install-deno-path-default | compatibility | yes      | VAL-9          | dv          | covered | -                 |
| CHG-install-deno-path-default | lifecycle     | yes      | VAL-5          | unit        | covered | -                 |
| CHG-install-deno-path-default | lifecycle     | yes      | VAL-7          | dv          | covered | -                 |
| CHG-install-deno-path-default | cross-module  | yes      | VAL-9          | dv          | covered | -                 |
| CHG-install-deno-path-docs    | normal        | yes      | VAL-10、VAL-11 | integration | covered | -                 |
| CHG-install-deno-path-docs    | boundary      | no       | VAL-10、VAL-11 | integration | covered | -                 |
| CHG-install-deno-path-docs    | negative      | no       | VAL-12         | integration | covered | -                 |
| CHG-install-deno-path-docs    | error         | no       | VAL-12         | integration | covered | -                 |
| CHG-install-deno-path-docs    | compatibility | yes      | VAL-10、VAL-12 | integration | covered | -                 |
| CHG-install-deno-path-docs    | lifecycle     | no       | VAL-11         | integration | covered | -                 |
| CHG-install-deno-path-docs    | cross-module  | no       | VAL-12         | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                    | derived_cases                                                   | level | status         | gap_manual_reason        |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------------- | ----- | -------------- | ------------------------ |
| parameter-domain | File-Level Interfaces 的 installTo 输入域        | 缺省 undefined、显式 /usr/local、显式 $HOME 目录                | unit  | covered        | -                        |
| state-transition | Key Flows 的 缺省→probe→privilege→install 状态   | present 跳过、缺省安装、提权失败                                | unit  | covered        | -                        |
| failure-path     | Key Flows 的 preflightPrivilege 失败             | 提权失败映射 preflight 退出 3                                   | dv    | covered        | -                        |
| error-handling   | Risks and Rollback 的错误类别                    | preflight 3、执行失败 4、成功 0                                 | dv    | covered        | -                        |
| invariant        | State and Ownership：不写 machines.yaml/发布历史 | DV 主流程断言配置内容不变                                       | dv    | covered        | -                        |
| concurrency      | design.md（无并发声明）                          | not-applicable: 未声明并发/并行共享状态，串行执行无共享可变状态 | unit  | not-applicable | 无并发或并行共享状态可测 |

## Unit Tests

| function_or_unit | branch_or_condition | covered_behavior | test_file | status | gap_manual_reason
| |---|---|---|---|---| | installDenoOnMachine | 缺省 installTo undefined |
DENO_INSTALL=/usr/local + privileged=true | tests/unit/ssh_install.test.ts | covered | - | |
installDenoOnMachine | installTo 指向 $HOME | DENO_INSTALL=home + privileged=false |
tests/unit/ssh_install.test.ts | covered | - | | installDenoOnMachine | 已满足版本 | present +
denoPath=/usr/local/bin/deno | tests/unit/ssh_install.test.ts | covered | - | |
actionUsage/parseArguments | install-deno 帮助 | 帮助包含缺省 /usr/local/bin/deno |
tests/unit/install_deno_cli.test.ts | covered | - | | InstallDenoResult | 成功/失败/预检 | 退出码
0/4/3 不回归 | tests/unit/install_deno_cli.test.ts | covered | - |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
|---|---|---|---|---|---| | install-deno-default-path | main | 缺省安装 | installed +
denoPath=/usr/local/bin/deno + exit 0 | tests/dv/install_deno.test.ts | covered | - | |
install-deno-privileged-root | config | installTo=/usr/local | installed + privileged true |
tests/dv/install_deno.test.ts | covered | - | | install-deno-present | lifecycle | 已满足 |
present、跳过安装、版本正确 | tests/dv/install_deno.test.ts | covered | - | | install-deno-failure |
failure | 安装命令失败 | failed + exit 4 + 会话关闭 | tests/dv/install_deno.test.ts | covered | - |
| install-deno-preflight | failure | 预检/提权失败 | failed + preflight + exit 3 |
tests/dv/install_deno.test.ts | covered | - |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status |
gap_manual_reason | |---|---|---|---|---|---| | CLI 动作/JSON/退出码 | cli → integration → results |
InstallDenoResult JSON 稳定 | preflight 映射退出 3 | tests/integration/install_deno_cli.test.ts |
covered | - | | 文档契约 | docs ↔ cli/ssh_install | 三份文档含缺省命令与不修改 machines.yaml |
缺标记时抛错 | tests/contract/verify_install_deno_contract.ts | covered | - |

## Definition of Done

- `test-run.py sfo-deploy/035-deno-home-fallback all` 全部通过并写运行工件。
- `deno task check`、lint、fmt 通过；全量测试通过。
- 真实 SSH/multipass 安装留作 manual_gap。
