---
task_manifest: task.yaml
status: approved
---

# install-deno 最新稳定版与发布包校验测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块的远端 Deno 引导行为。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行，任务作用域命令为：

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py \
  sfo-deploy/044-install-deno-pinned-verified all
```

该命令先执行文档契约，再按 unit、dv、integration 顺序执行任务测试，并写入机器可读运行工件。

## Submodule Tests

本任务在 sfo-deploy 模块内按文件级分解（`src/ssh_install.ts` 远端引导、 `src/integration.ts`
编排、`src/cli.ts` 帮助契约），没有独立业务子模块层。 文件级覆盖由下方 Unit/DV/Integration
表登记，不建立 submodule 测试文档。

## Module-Level Tests

模块级行为由 `tests/dv/install_deno.test.ts` 覆盖：真实装载临时集群后经 `run()` 串起集成层 →
`installDenoOnMachine`（FakeSession 替身）→ `InstallDenoResult` 的
完整链路，覆盖最新版安装/升级、已最新跳过、显式精确版本跳过、工具补齐、失败分类、
取消门禁与会话关闭。

## External Interface Tests

- CLI 参数：`install-deno` 仍只接受 `--machine` 筛选；`--deno-version` 和 `--install-to`
  不新增参数。帮助文本改为说明缺省最新稳定版与升级语义。
- JSON 输出：`InstallDenoResult` 的 `kind`、`machines[]`、`status`、`exit_code`
  和机器字段保持不变；`present`/`installed` 语义按新版本比较规则解释。
- 文档契约：README 中的可执行示例、提权前提、GitHub Release + `.sha256sum` 信任边界和“不修改
  machines.yaml”说明由契约脚本校验。

## Direct Change Coverage

| change_id                        | design_source                                                                                         | validation_id | testplan_level | testplan_step_id | gap | gap_manual_reason |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-install-deno-latest-verified | design.md Overall Approach、File-Level Interfaces、Key Flows、State and Ownership、Risks and Rollback | VAL-1..VAL-16 | integration    | I1               | no  | -                 |

## Validation Rationale

测试由 proposal PI-1 和 design 的版本模式、URL 选择、校验状态机、CLI 兼容边界直接 派生。单元层用
FakeSession 覆盖分支与脚本形态；DV 层验证真实集群装载和结果编排； 集成层验证公开
CLI/JSON/文档契约。真实 SSH、发行版工具链和 latest Release 竞态 作为 manual gaps 记录。

## Case-Type Coverage

| change_id                        | case_type     | required | validation_id                | level       | status  | gap_manual_reason |
| -------------------------------- | ------------- | -------- | ---------------------------- | ----------- | ------- | ----------------- |
| CHG-install-deno-latest-verified | normal        | yes      | VAL-12                       | integration | covered | -                 |
| CHG-install-deno-latest-verified | boundary      | yes      | VAL-2、VAL-3、VAL-4、VAL-9   | unit        | covered | -                 |
| CHG-install-deno-latest-verified | negative      | yes      | VAL-4、VAL-11                | unit        | covered | -                 |
| CHG-install-deno-latest-verified | error         | yes      | VAL-13、VAL-14               | dv          | covered | -                 |
| CHG-install-deno-latest-verified | compatibility | yes      | VAL-16                       | integration | covered | -                 |
| CHG-install-deno-latest-verified | lifecycle     | yes      | VAL-5、VAL-6、VAL-12、VAL-13 | dv          | covered | -                 |
| CHG-install-deno-latest-verified | cross-module  | yes      | VAL-12                       | dv          | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                                    | derived_cases                                                      | level | status         | gap_manual_reason |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ----- | -------------- | ----------------- |
| parameter-domain | File-Level Interfaces 的 `version?: string` 输入域               | undefined latest、合法 x.y.z/vx.y.z、非法/低版本、不匹配显式版本   | unit  | covered        | -                 |
| state-transition | Key Flows 的 Needs latest or update → Installed / Already latest | 旧版本升级、最新版本 present、显式版本精确跳过、复验失败           | dv    | covered        | -                 |
| failure-path     | Key Flows 的 checksum failure                                    | 校验命令失败后整体安装失败且不进入 installed                       | unit  | covered        | -                 |
| error-handling   | Risks and Rollback 的网络/工具失败                               | 安装失败、缺失包管理器、提权失败、复验失败                         | dv    | covered        | -                 |
| invariant        | State and Ownership 的 fail-closed 与临时目录清理                | 官方 URL、`.sha256sum` 前置、sha256sum 存在性检查、Linux 目标映射  | unit  | covered        | -                 |
| concurrency      | State and Ownership（串行机器循环）                              | not-applicable: 设计为按机器串行执行，未声明并行安装或共享安装状态 | dv    | not-applicable | 无并行状态可测    |

## Unit Tests

| function_or_unit     | branch_or_condition        | covered_behavior                                                     | test_file                           | status  | gap_manual_reason                                        |
| -------------------- | -------------------------- | -------------------------------------------------------------------- | ----------------------------------- | ------- | -------------------------------------------------------- |
| normalizeDenoVersion | 输入域                     | 接受 x.y.z/vx.y.z，拒绝非 semver、Deno 1 和注入字符                  | tests/unit/ssh_install.test.ts      | covered | -                                                        |
| installDenoOnMachine | 显式精确版本               | 已有相同版本返回 present 且不调用安装脚本                            | tests/unit/ssh_install.test.ts      | covered | -                                                        |
| installDenoOnMachine | latest + 旧版本            | 调用 latest 脚本、记录旧版本、复验并返回 installed                   | tests/unit/ssh_install.test.ts      | covered | -                                                        |
| installDenoOnMachine | latest + 相同版本          | 校验后脚本输出 present 标记，返回 present 且不覆盖                   | tests/unit/ssh_install.test.ts      | covered | -                                                        |
| installDenoOnMachine | checksum failure           | 安装脚本返回失败并映射 TransportError                                | tests/unit/ssh_install.test.ts      | covered | -                                                        |
| installerScript      | URL 与目标映射             | latest/download、pinned /v<version>/、sha256sum、x86_64/aarch64 目标 | tests/unit/ssh_install.test.ts      | covered | -                                                        |
| installDenoOnMachine | 提权判定                   | /usr/local 提权，$HOME 安装不提权                                    | tests/unit/ssh_install.test.ts      | covered | -                                                        |
| runInstallDeno / CLI | 参数与结果                 | `--deno-version` 解析、帮助最新语义、JSON 字段稳定                   | tests/unit/install_deno_cli.test.ts | covered | -                                                        |
| 真实远端 shell       | mktemp/trap/cp/mv/unzip/7z | 真实发行版 shell 和工具链执行                                        | tests/unit/ssh_install.test.ts      | manual  | 无真实 SSH 目标机；由 FakeSession 编排测试和受控环境验证 |

## DV Tests

| workflow                      | kind      | entry            | expected_result                                      | test_file_or_script           | status  | gap_manual_reason |
| ----------------------------- | --------- | ---------------- | ---------------------------------------------------- | ----------------------------- | ------- | ----------------- |
| install-deno-latest-upgrade   | main      | 缺省安装临时集群 | installed + 2.7.8 + exit 0 + 会话关闭                | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-privileged-root  | config    | 缺省 /usr/local  | installer privileged=true 且 DENO_INSTALL=/usr/local | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-explicit-present | lifecycle | 显式相同版本     | present + installCalls=0                             | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-latest-present   | lifecycle | 缺省最新且已最新 | present + checksumChecked=true + installSkipped=true | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-install-failure  | failure   | 安装脚本失败     | failed + exit 4 + 会话关闭                           | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-tool-remediation | failure   | 缺失 curl/unzip  | apt update/install 后继续，失败时按错误类别返回      | tests/dv/install_deno.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow          | modules_involved            | success_case                                     | failure_case                    | test_file                                      | status  | gap_manual_reason |
| ------------------------- | --------------------------- | ------------------------------------------------ | ------------------------------- | ---------------------------------------------- | ------- | ----------------- |
| CLI_ACTIONS/公开导出/JSON | cli → integration → results | 集合包含 install-deno、结果可构造、JSON 字段稳定 | 参数错误由 unit/DV 错误分类覆盖 | tests/integration/install_deno_cli.test.ts     | covered | -                 |
| install-deno 文档契约     | docs ↔ cli/ssh_install 行为 | README 含示例、信任边界、不写 machines.yaml 说明 | 缺少标记时契约脚本抛错          | tests/contract/verify_install_deno_contract.ts | covered | -                 |

## Definition of Done

- 任务作用域 `test-run.py sfo-deploy/044-install-deno-pinned-verified all` 成功并写入
  机器可读运行工件。
- `deno check`、定向 unit/DV/契约测试通过。
- 真实 SSH 目标机、发行版工具链和 latest Release 竞态作为 manual gaps 记录。
