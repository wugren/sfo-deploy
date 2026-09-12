---
task_manifest: task.yaml
status: approved
---

Risk profile: ./risk-profile.yaml

# Testing：App service unit 崩溃拉起策略

## Test Document Index

| Document   | Topic        | Scope                                                        |
| ---------- | ------------ | ------------------------------------------------------------ |
| testing.md | 单一测试文档 | `unit_config` 重启策略装载、systemd unit 渲染、文档/模板契约 |

## Submodule Tests

| Submodule                   | Responsibility                          | Detailed Test Doc | Required Behaviors                       | Edge/Failure Cases                       | Test Type | Test Files                                       | Status  | Gap / Manual Reason |
| --------------------------- | --------------------------------------- | ----------------- | ---------------------------------------- | ---------------------------------------- | --------- | ------------------------------------------------ | ------- | ------------------- |
| App configuration loader    | YAML 字段白名单、枚举、整数边界和归一化 | testing.md        | 合法策略与限流字段可读取；非法值失败关闭 | 未知字段、负值、越界、非法策略、缺失字段 | unit      | tests/unit/app_management_config.test.ts         | covered |                     |
| systemd unit renderer       | 受管 unit 的确定性输出                  | testing.md        | 显式指令写入正确 section；缺省不写入     | `no`、`0`、部分字段、全部缺省            | unit      | tests/unit/systemd_unit.test.ts                  | covered |                     |
| plan history codec          | `unit_config` 快照往返与旧快照兼容        | testing.md        | 新字段 encode/decode 不丢失；缺省字段读取为 undefined | 新字段往返、旧四字段快照、非法策略/越界 | unit | tests/unit/history.test.ts | covered | |
| configuration contract docs | README 与集群配置技能模板一致           | testing.md        | 模板展示推荐崩溃拉起字段                 | 契约断言失败即失败                       | contract  | tests/contract/verify_app_management_contract.ts | covered |                     |

## Unified Test Entry

- Machine-readable task plan:
  `docs/versions/v0.1/modules/sfo-deploy/081-add-service-crash-restart-policy/testplan.yaml`
- Task all:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/081-add-service-crash-restart-policy all`
- Single-task boundary: 不运行 package/module 作用域、`all all`、根快捷方式或 quality gates。
- Registration: 新增/修改的单元与契约测试均出现在 `testplan.yaml` 的 `test_targets` 或 contract
  run。

## Module-Level Tests

| Test Item                  | Covered Boundary                          | Entry                             | Expected Result                    | Test Type | Test File/Script                                 | Status  | Gap / Manual Reason |
| -------------------------- | ----------------------------------------- | --------------------------------- | ---------------------------------- | --------- | ------------------------------------------------ | ------- | ------------------- |
| `unit_config` 重启策略装载 | 字段白名单、枚举和安全整数边界            | unit / restart policy loader      | 合法字段归一；非法字段失败关闭     | unit      | tests/unit/app_management_config.test.ts         | covered |                     |
| systemd unit 渲染          | `[Unit]` / `[Service]` 指令位置与缺省输出 | unit / unit renderer              | 显式字段输出，缺省字段保持旧行为   | unit      | tests/unit/systemd_unit.test.ts                  | covered |                     |
| App service 配置契约       | 文档、技能模板与实现声明一致              | contract / documentation examples | 模板包含推荐字段并继续通过既有契约 | contract  | tests/contract/verify_app_management_contract.ts | covered |                     |

## External Interface Tests

| Interface                   | Responsibility                         | Success Cases                  | Failure/Edge Cases                 | Test Type | Test Doc/File                                    | Status  | Gap / Manual Reason |
| --------------------------- | -------------------------------------- | ------------------------------ | ---------------------------------- | --------- | ------------------------------------------------ | ------- | ------------------- |
| App service `unit_config`   | 声明可选 systemd 崩溃拉起策略          | 合法枚举、0 值和限流字段装载   | 非法策略、负值、越界、未知字段拒收 | unit      | tests/unit/app_management_config.test.ts         | covered |                     |
| managed systemd unit        | 确定性输出 `Restart*` 与 `StartLimit*` | 显式 `on-failure` 和零值输出   | 缺省字段不产生新指令               | unit      | tests/unit/systemd_unit.test.ts                  | covered |                     |
| configuration documentation | 用户可见示例与框架契约同步             | 模板和 README 可被静态契约读取 | 字段缺失或示例漂移失败             | contract  | tests/contract/verify_app_management_contract.ts | covered |                     |

## Validation Rationale

| Behavior or Risk             | Validation Signal      | Why This Is Sufficient                              | Gap / Manual Reason                       |
| ---------------------------- | ---------------------- | --------------------------------------------------- | ----------------------------------------- |
| 用户可声明崩溃拉起和启动限流 | 合法装载测试           | 覆盖策略枚举、秒数边界、次数边界和归一化结果。      |                                           |
| 非法配置不能进入部署         | 负值/越界/非法策略拒收 | 装载期失败关闭，不产生部分计划。                    |                                           |
| 旧配置保持不变               | 缺省渲染测试           | 缺省字段不产生 `Restart*`/`StartLimit*` 指令。      |                                           |
| 显式指令正确落到 systemd     | unit 渲染测试          | 覆盖 section 位置、`no`、`0` 与推荐字段。           |                                           |
| 文档与模板可发现             | contract 契约          | 静态契约绑定模板字段和既有 App 管理示例。           |                                           |
| 目标机 systemd 行为          | 本任务不执行远端部署   | 框架只生成/发布 unit；实际重启由目标 systemd 保证。 | manual gap：没有真实 Linux 主机部署验证。 |

## Direct Change Coverage

| change_id                               | design_source                                                 | validation_id | testplan_level | testplan_step_id | Gap? | Gap / Manual Reason                          |
| --------------------------------------- | ------------------------------------------------------------- | ------------- | -------------- | ---------------- | ---- | -------------------------------------------- |
| CHG-service-restart-policy-schema       | `design.md` File-Level Interfaces and Key Flows               | U1            | unit           | U1               | no   |                                              |
| CHG-service-restart-policy-template-doc | `design.md` Overall Approach and Directly Mapped Change Items | U2            | unit           | U2               | no   | C1 额外执行风险触发的 documentation contract |

## Case-Type Coverage

| change_id                               | case_type     | required | validation_id | level | status         | gap_manual_reason                                    |
| --------------------------------------- | ------------- | -------- | ------------- | ----- | -------------- | ---------------------------------------------------- |
| CHG-service-restart-policy-schema       | normal        | yes      | U1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-schema       | boundary      | yes      | U1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-schema       | negative      | yes      | U1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-schema       | error         | yes      | U1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-schema       | compatibility | yes      | U1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-schema       | lifecycle     | yes      | U1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-schema       | cross-module  | yes      | U1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-template-doc | normal        | yes      | C1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-template-doc | boundary      | yes      | C1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-template-doc | negative      | no       | C1            | unit  | not-applicable | 文档示例不含非法策略；非法值由 schema 单元测试覆盖。 |
| CHG-service-restart-policy-template-doc | error         | no       | C1            | unit  | not-applicable | 文档示例只表达成功用法；装载错误路径由 U1 覆盖。     |
| CHG-service-restart-policy-template-doc | compatibility | yes      | C1            | unit  | covered        |                                                      |
| CHG-service-restart-policy-template-doc | lifecycle     | no       | C1            | unit  | not-applicable | 文档示例不执行部署生命周期。                         |
| CHG-service-restart-policy-template-doc | cross-module  | yes      | C1            | unit  | covered        |                                                      |

## Design Element Coverage

| element_type     | design_source                                      | derived_cases                                            | level | status         | gap_manual_reason                    |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------- | ----- | -------------- | ------------------------------------ |
| parameter-domain | `design.md` File-Level Interfaces                  | 策略枚举、0..86400 秒、0..10000 次、最小/最大/越界       | unit  | covered        |                                      |
| state-transition | `design.md` State and Ownership                    | 缺省到显式指令、显式 `no`、零值限流                      | unit  | covered        |                                      |
| failure-path     | `design.md` Key Flows                              | 装载失败阻止计划生成                                     | unit  | covered        |                                      |
| error-handling   | `design.md` Design Notes                           | 未知策略、负值、上限外整数失败关闭                       | unit  | covered        |                                      |
| invariant        | `design.md` Design Notes                           | 缺省字段不写入新指令；目标/工具/daemon_reload 不变量保持 | unit  | covered        |                                      |
| concurrency      | `design.md` State and Ownership 明确不新增持久状态 | no                                                       | unit  | not-applicable | 设计未引入并发、重入或共享可变状态。 |

## Unit Tests

| Function or Unit    | Branch or Condition     | Covered Behavior                                  | Test File                                | Status  | Gap / Manual Reason |
| ------------------- | ----------------------- | ------------------------------------------------- | ---------------------------------------- | ------- | ------------------- |
| `systemdUnitConfig` | optional restart fields | 策略、秒数、限流窗口和次数归一                    | tests/unit/app_management_config.test.ts | covered |                     |
| `systemdUnitConfig` | invalid enum/bounds     | 非法策略、负值和上限外值失败关闭                  | tests/unit/app_management_config.test.ts | covered |                     |
| `renderUnit`        | explicit directives     | `Restart`、`RestartSec` 和 `StartLimit*` 输出位置 | tests/unit/systemd_unit.test.ts          | covered |                     |
| `renderUnit`        | explicit `no`/zero      | 显式禁用重启和禁用限流窗口被保留                  | tests/unit/systemd_unit.test.ts          | covered |                     |
| `renderUnit`        | omitted fields          | 旧配置继续输出旧 unit 文本                        | tests/unit/systemd_unit.test.ts          | covered |                     |
| `encodeManagement` / `decodeSystemdUnitConfig` | optional restart fields and legacy snapshot | 新字段完整往返；旧快照缺省字段保持 undefined | tests/unit/history.test.ts | covered | |

未覆盖的已改动分支：无。`renderUnit` 的每个新条件分支都有显式值和缺省值两侧覆盖。

## DV Tests

| Workflow                  | Kind      | Entry          | Expected Result                                                 | Test File or Script                      | Status         | Gap / Manual Reason                               |
| ------------------------- | --------- | -------------- | --------------------------------------------------------------- | ---------------------------------------- | -------------- | ------------------------------------------------- |
| module lifecycle          | lifecycle | not applicable | 本次不新增部署生命周期、远端状态或持久化流程                    | none                                     | not-applicable | 装载失败在计划前发生；unit 发布沿用既有 DV 覆盖。 |
| configuration to renderer | main      | not applicable | 归一后的 `SystemdUnitConfig` 被 renderer 消费，无模块级远端流程 | tests/unit/systemd_unit.test.ts          | not-applicable | 该消费关系由 unit 层直接覆盖；DV 不提供额外边界。 |
| invalid configuration     | failure   | not applicable | 非法策略或越界字段在计划前失败                                  | tests/unit/app_management_config.test.ts | not-applicable | 失败发生在装载期，跨单元执行流程不参与。          |

## Integration Tests

| Contract or Flow       | Modules Involved              | Success Case         | Failure Case         | Test File                                        | Status  | Gap / Manual Reason |
| ---------------------- | ----------------------------- | -------------------- | -------------------- | ------------------------------------------------ | ------- | ------------------- |
| documentation contract | loader/renderer/docs/template | 模板字段可被契约读取 | 字段漂移导致契约失败 | tests/contract/verify_app_management_contract.ts | covered |                     |

## Definition of Done

- [x] 两个 `change_id` 在 proposal、design、testing 和 `testplan.yaml` 中直接映射。
- [x] 新增/修改测试可通过 task-scoped unified entrypoint 执行。
- [x] 配置装载、非法值、缺省兼容、systemd 渲染和文档契约均有直接验证。
- [x] 真实 systemd 主机行为记录为 manual gap，不作为本任务通过证据。
