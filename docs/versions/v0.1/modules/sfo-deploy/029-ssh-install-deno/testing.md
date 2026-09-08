---
task_manifest: task.yaml
status: approved
---

# 纯 SSH 安装 Deno 命令测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行。任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py
sfo-deploy/029-ssh-install-deno all`：先执行
`docs-contract` 步骤，再按 unit、dv、 integration 声明顺序执行任务测试，并写出机器可读运行工件。

## Submodule Tests

本任务在 sfo-deploy 模块内按文件级分解（`src/ssh_install.ts`、`src/integration.ts`、
`src/cli.ts`、`src/results.ts`），没有独立业务子模块层；文件级覆盖由单元/DV/集成测试表
逐文件登记，不建立 submodule 测试文档。

## Module-Level Tests

模块级行为由 `tests/dv/install_deno.test.ts` 覆盖：真实装载临时集群后经 `run()` 串起集成层 →
`installDenoOnMachine`（FakeSession 替身）→ `InstallDenoResult`
的完整数据流，验证安装、已满足跳过、提权配置、失败关闭与缺省全量确认门禁。

## External Interface Tests

- 公开 CLI 契约：`CLI_ACTIONS`/帮助文本包含 `install-deno`，`--deno-version` 与 `--install-to`
  参数可用，RunOptions 拒绝 apps/environments/withDependencies 混用， 由
  `tests/unit/install_deno_cli.test.ts` 覆盖。
- 公开模块导出：`src/mod.ts` 导出 `InstallDenoResult` 与 `MachineDenoOutcome`， `RunResult` 联合包含
  `InstallDenoResult`，由 `tests/integration/install_deno_cli.test.ts` 覆盖。
- CLI JSON 输出：`serializeResult` 输出稳定 `kind/status/exit_code/machines` 字段，
  由单元与集成测试覆盖。
- 文档示例契约：README、集群配置指南与示例 README 的可执行示例与动作列表一致，由
  `tests/contract/verify_install_deno_contract.ts` 覆盖。

## Direct Change Coverage

| change_id            | design_source                                                      | validation_id         | testplan_level | testplan_step_id | gap | gap_manual_reason |
| -------------------- | ------------------------------------------------------------------ | --------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-ssh-deno-install | design.md File-Level Interfaces、Key Flows、Risks and Rollback     | VAL-1..VAL-12         | dv             | D1               | no  | -                 |
| CHG-ssh-deno-docs    | design.md API and Build Surface Impact、Consumer Migration Closure | VAL-8, VAL-13, VAL-14 | integration    | I1               | no  | -                 |

## Validation Rationale

测试由 proposal PI-1/PI-2 与 design.md 的 Key Flows、State and Ownership、Risks and
Rollback、File-Level Interfaces 直接派生。单元层覆盖公开校验函数、安装编排每个分支与 CLI
参数/帮助/序列化；DV 层用真实集群装载 + FakeTransport 替身验证单模块主流程与失败
流程；集成层验证公开动作、导出与 JSON 输出契约；文档契约步骤固定验证三份文档中的 `install-deno`
示例与动作列表一致。对应 risk-profile 的 contract/security/runtime/build required_checks
均有对应测试步骤；真实 SSH 目标机留作 manual_gaps。

## Case-Type Coverage

| change_id            | case_type     | required | validation_id               | level       | status  | gap_manual_reason |
| -------------------- | ------------- | -------- | --------------------------- | ----------- | ------- | ----------------- |
| CHG-ssh-deno-install | normal        | yes      | VAL-1, VAL-4, VAL-9, VAL-10 | dv          | covered | -                 |
| CHG-ssh-deno-install | boundary      | yes      | VAL-1, VAL-2                | unit        | covered | -                 |
| CHG-ssh-deno-install | negative      | yes      | VAL-1, VAL-2, VAL-7         | unit        | covered | -                 |
| CHG-ssh-deno-install | error         | yes      | VAL-5, VAL-12, VAL-15       | dv          | covered | -                 |
| CHG-ssh-deno-install | compatibility | yes      | VAL-13                      | integration | covered | -                 |
| CHG-ssh-deno-install | lifecycle     | yes      | VAL-3, VAL-10               | dv          | covered | -                 |
| CHG-ssh-deno-install | cross-module  | yes      | VAL-9, VAL-10               | integration | covered | -                 |
| CHG-ssh-deno-docs    | normal        | yes      | VAL-14                      | integration | covered | -                 |
| CHG-ssh-deno-docs    | boundary      | no       | VAL-8, VAL-14               | integration | covered | -                 |
| CHG-ssh-deno-docs    | negative      | no       | VAL-14                      | integration | covered | -                 |
| CHG-ssh-deno-docs    | error         | no       | VAL-14                      | integration | covered | -                 |
| CHG-ssh-deno-docs    | compatibility | yes      | VAL-13                      | integration | covered | -                 |
| CHG-ssh-deno-docs    | lifecycle     | no       | VAL-14                      | integration | covered | -                 |
| CHG-ssh-deno-docs    | cross-module  | no       | VAL-14                      | integration | covered | -                 |

## Unit Tests

| function_or_unit     | branch_or_condition                      | covered_behavior                                  | test_file                           | status  | gap_manual_reason |
| -------------------- | ---------------------------------------- | ------------------------------------------------- | ----------------------------------- | ------- | ----------------- |
| normalizeDenoVersion | 合法 x.y.z / vx.y.z                      | 规范化返回 x.y.z                                  | tests/unit/ssh_install.test.ts      | covered | -                 |
| normalizeDenoVersion | 缺段、主版本 <2、注入字符                | 拒绝 ConfigurationError                           | tests/unit/ssh_install.test.ts      | covered | -                 |
| validateInstallTo    | 绝对路径/缺省                            | 返回原值或 undefined                              | tests/unit/ssh_install.test.ts      | covered | -                 |
| validateInstallTo    | 相对路径、`..`、空白/控制字符            | 拒绝 ConfigurationError                           | tests/unit/ssh_install.test.ts      | covered | -                 |
| installDenoOnMachine | 探测已有满足版本                         | present 跳过安装                                  | tests/unit/ssh_install.test.ts      | covered | -                 |
| installDenoOnMachine | 探测缺失/过低后安装                      | installed + DENO_INSTALL/privileged 正确          | tests/unit/ssh_install.test.ts      | covered | -                 |
| installDenoOnMachine | 安装命令非零退出                         | TransportError 安装失败                           | tests/unit/ssh_install.test.ts      | covered | -                 |
| installDenoOnMachine | 安装后版本不一致 / 验证失败              | TransportError 版本不匹配                         | tests/unit/ssh_install.test.ts      | covered | -                 |
| installDenoOnMachine | 远端 HOME 非法                           | fail-closed TransportError                        | tests/unit/ssh_install.test.ts      | covered | -                 |
| parseArguments       | --deno-version/--install-to/--machine    | RunOptions 字段正确                               | tests/unit/install_deno_cli.test.ts | covered | -                 |
| RunOptions           | install-deno 混用过滤/其它动作带安装选项 | 拒绝 ConfigurationError                           | tests/unit/install_deno_cli.test.ts | covered | -                 |
| ACTION_HELP          | install-deno 帮助条目                    | 帮助包含版本/目录/纯 SSH 语义                     | tests/unit/install_deno_cli.test.ts | covered | -                 |
| serializeResult      | InstallDenoResult 分支                   | 稳定 kind/status/exit_code/machines JSON          | tests/unit/install_deno_cli.test.ts | covered | -                 |
| InstallDenoResult    | 失败类别分支                             | preflight → 退出码 3；transport → 4；全部成功 → 0 | tests/unit/install_deno_cli.test.ts | covered | -                 |

## DV Tests

| workflow                     | kind      | entry                        | expected_result                               | test_file_or_script           | status  | gap_manual_reason |
| ---------------------------- | --------- | ---------------------------- | --------------------------------------------- | ----------------------------- | ------- | ----------------- |
| install-deno-main            | main      | run() 对临时集群 node-a 安装 | installed + exitCode 0 + 会话关闭             | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-present         | lifecycle | 已满足版本探测               | present 跳过安装                              | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-privileged-root | config    | --install-to /usr/local      | 提权安装调用与 DENO_INSTALL 正确              | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-failure         | failure   | 安装命令失败                 | failed + exitCode 4 + 会话仍关闭              | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-preflight-exit  | failure   | SSH 预检失败（known_hosts）  | failed + errorCategory preflight + exitCode 3 | tests/dv/install_deno.test.ts | covered | -                 |
| install-deno-confirm-gate    | main      | 缺省全量未确认               | CancelledError 且零连接                       | tests/dv/install_deno.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow         | modules_involved                  | success_case                                 | failure_case                            | test_file                                      | status  | gap_manual_reason |
| ------------------------ | --------------------------------- | -------------------------------------------- | --------------------------------------- | ---------------------------------------------- | ------- | ----------------- |
| CLI_ACTIONS 公共动作集合 | cli → integration                 | 集合包含 install-deno                        | 既有导出断言（不适用）                  | tests/integration/install_deno_cli.test.ts     | covered | -                 |
| 公开模块导出             | mod → results                     | InstallDenoResult 可构造且 toJSON 语义稳定   | 无失败语义（不适用）                    | tests/integration/install_deno_cli.test.ts     | covered | -                 |
| CLI JSON 输出链          | cli → runAction → serializeResult | stdout 输出 kind/status/machines 完整字段    | 参数错误路径由 unit RunOptions 拒绝覆盖 | tests/integration/install_deno_cli.test.ts     | covered | -                 |
| 文档示例契约             | docs → cli 动作列表               | README/指南/示例均含可执行 install-deno 示例 | 文档或动作列表缺失时非零退出            | tests/contract/verify_install_deno_contract.ts | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                                     | derived_cases                                                     | level       | status         | gap_manual_reason        |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | ----------- | -------------- | ------------------------ |
| parameter-domain | design.md File-Level Interfaces（version/installTo 值域）         | 合法/非法版本、合法/非法目录、缺省/显式安装目录                   | unit        | covered        | -                        |
| state-transition | design.md State and Ownership（present/installed/failed）         | 已满足→present、缺失→installed、失败→failed                       | dv          | covered        | -                        |
| failure-path     | design.md Key Flows 与 Risks and Rollback（安装/验证/主目录失败） | 安装命令失败、版本不匹配、HOME 非法                               | unit        | covered        | -                        |
| error-handling   | design.md Risks and Rollback（错误分类与退出码）                  | transport 错误、preflight、ConfigurationError、退出码 0/2/3/4/130 | integration | covered        | -                        |
| invariant        | design.md State and Ownership（会话必然关闭、不写持久状态）       | 每机器失败后 session.close 仍执行；run() 不产生发布记录           | dv          | covered        | -                        |
| concurrency      | design.md（无并发声明；串行逐机器执行）                           | not-applicable: 设计未声明并发/并行；执行按机器串行               | unit        | not-applicable | 无并发或并行共享状态可测 |

## Definition of Done

- 两个 change_id 均有直接验证映射（Direct Change Coverage），无未覆盖或 gap。
- `sfo-deploy/029-ssh-install-deno all` 统一入口运行通过：docs 契约、unit、DV、 integration
  步骤全部成功并写出运行工件。
- 全量 `deno task check`、`deno lint`、`deno fmt --check` 通过；既有测试无新增回归。
- 真实 SSH 目标机部署留作 manual_gaps（real-ssh-install），不影响本任务测试完成结论。
