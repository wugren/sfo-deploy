---
task_manifest: task.yaml
status: draft
---

# App v4 managed 资源测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`，覆盖 v4 装载、unit 渲染、执行事务、快照和文档契约。
- 子模块测试文档：无独立业务子模块；文件级分解见 `design.md`。
- 机器可读执行计划：`testplan.yaml`。

## Submodule Tests

任务在 sfo-deploy 模块内按文件级职责分解，不建立独立业务子模块；文件级覆盖由 Unit/DV/Integration
表登记。

## Module-Level Tests

模块级行为由 `tests/unit/app_management_config.test.ts`、
`tests/unit/systemd_unit.test.ts`、`tests/unit/history.test.ts`、
`tests/dv/app_management_execution.test.ts`、`tests/dv/execution.test.ts` 和 `deno task test`
全量回归覆盖。公共导出、文档示例和编译闭包由 testplan contract steps 执行。

## External Interface Tests

- `app.yaml` schema v4 `management.actions` 装载契约：只接受 config/service，动作所有权唯一。
- service unit_config 契约：working directory/命令路径解析、固定参数、unit target 和安全字符边界。
- 计划/历史持久契约：unitConfig encode/decode，旧快照无 unitConfig 时继续 decode。
- 公共导出契约：`ManagedFileFormat`、`SystemdUnitConfig` 可从 `src/mod.ts` 消费。
- README、指南和 nginx 示例与 loader 契约一致。

## Unified Test Entry

任务作用域统一入口为：
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/052-unify-app-management-schema all`。
它先执行 contract checks，再执行 unit/DV/integration 步骤并写出机器制品。

## Direct Change Coverage

| change_id                         | design_source                                                             | validation_id     | testplan_level | testplan_step_id | Gap? | Gap / Manual Reason |
| --------------------------------- | ------------------------------------------------------------------------- | ----------------- | -------------- | ---------------- | ---- | ------------------- |
| CHG-unified-app-action-schema     | design.md File-Level Interfaces、State and Ownership、Key Flows           | U1/U2/C1/C2       | unit           | U1               | no   | -                   |
| CHG-unified-app-action-consumers  | design.md Overall Approach、Key Flows、File-Level Implementation Sequence | U2/U3/D1/I1/C1/C2 | dv             | D1               | no   | -                   |
| CHG-unified-app-action-docs-tests | design.md Consumer Migration Closure、Implementation Order                | C3/I2/I3/I4       | integration    | I3               | no   | -                   |

## Case-Type Coverage

| change_id                         | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| --------------------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-unified-app-action-schema     | normal        | yes      | U1            | unit        | covered | -                 |
| CHG-unified-app-action-schema     | boundary      | yes      | U1/U2         | unit        | covered | -                 |
| CHG-unified-app-action-schema     | negative      | yes      | U1            | unit        | covered | -                 |
| CHG-unified-app-action-schema     | error         | yes      | U1/U2         | unit        | covered | -                 |
| CHG-unified-app-action-schema     | compatibility | yes      | U1            | unit        | covered | -                 |
| CHG-unified-app-action-schema     | lifecycle     | yes      | D1            | dv          | covered | -                 |
| CHG-unified-app-action-schema     | cross-module  | yes      | I2/C2         | integration | covered | -                 |
| CHG-unified-app-action-consumers  | normal        | yes      | U2/U3/D1      | dv          | covered | -                 |
| CHG-unified-app-action-consumers  | boundary      | yes      | U2            | unit        | covered | -                 |
| CHG-unified-app-action-consumers  | negative      | yes      | U2            | unit        | covered | -                 |
| CHG-unified-app-action-consumers  | error         | yes      | D1            | dv          | covered | -                 |
| CHG-unified-app-action-consumers  | compatibility | yes      | U3            | unit        | covered | -                 |
| CHG-unified-app-action-consumers  | lifecycle     | yes      | D1            | dv          | covered | -                 |
| CHG-unified-app-action-consumers  | cross-module  | yes      | I1/C2         | integration | covered | -                 |
| CHG-unified-app-action-docs-tests | normal        | yes      | C3            | integration | covered | -                 |
| CHG-unified-app-action-docs-tests | boundary      | no       | I2            | integration | covered | -                 |
| CHG-unified-app-action-docs-tests | negative      | yes      | C2            | integration | covered | -                 |
| CHG-unified-app-action-docs-tests | error         | no       | I3            | integration | covered | -                 |
| CHG-unified-app-action-docs-tests | compatibility | yes      | I3            | integration | covered | -                 |
| CHG-unified-app-action-docs-tests | lifecycle     | no       | I3            | integration | covered | -                 |
| CHG-unified-app-action-docs-tests | cross-module  | yes      | I2/I4         | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                           | derived_cases                                                           | level | status  | gap_manual_reason |
| ---------------- | --------------------------------------- | ----------------------------------------------------------------------- | ----- | ------- | ----------------- |
| parameter-domain | design.md File-Level Interfaces         | v2/v3/v4 schema、config/service kind、相对/绝对路径、空/含空格/危险参数 | unit  | covered | -                 |
| state-transition | design.md State and Ownership           | unit 候选 changed/unchanged、daemon-reload/restart、备份/恢复           | dv    | covered | -                 |
| failure-path     | design.md Key Flows、Risks and Rollback | 装载失败、渲染失败、发布/服务收敛失败恢复                               | dv    | covered | -                 |
| error-handling   | design.md Key Flows                     | 未知字段、未知 kind、路径越界、target 冲突、systemd 元字符              | unit  | covered | -                 |
| invariant        | design.md State and Ownership           | v2/v3 行为不变；快照往返；unit root/root/0644；on_change restart        | unit  | covered | -                 |
| concurrency      | design.md State and Ownership           | App/目标锁、release attempt 与执行器隔离回归                            | dv    | covered | -                 |

## Unit Tests

| Function or Unit                   | Branch or Condition                                       | Covered Behavior                  | Test File                                | Status  | Gap / Manual Reason |
| ---------------------------------- | --------------------------------------------------------- | --------------------------------- | ---------------------------------------- | ------- | ------------------- |
| appManagementV4                    | config/service/unknown kind、重复 service、冲突与路径校验 | v4 actions 归一和 fail closed     | tests/unit/app_management_config.test.ts | covered | -                   |
| systemdServiceV4/systemdUnitConfig | unit_config 有无、target、working directory、command      | 默认 target、相对/绝对路径解析    | tests/unit/app_management_config.test.ts | covered | -                   |
| serviceUnitManagedConfig           | unitConfig 有无                                           | root/root/0644 candidate 与 no-op | tests/unit/systemd_unit.test.ts          | covered | -                   |
| generateSystemdUnitSkeleton        | 普通路径、空格、空参数、危险字符                          | 确定性渲染和 fail closed          | tests/unit/systemd_unit.test.ts          | covered | -                   |
| encode/decodeManagement            | service 有/无 unitConfig                                  | 新快照往返与旧快照兼容            | tests/unit/history.test.ts               | covered | -                   |

## DV Tests

| Workflow                | Kind      | Entry                        | Expected Result                        | Test File or Script                       | Status  | Gap / Manual Reason |
| ----------------------- | --------- | ---------------------------- | -------------------------------------- | ----------------------------------------- | ------- | ------------------- |
| managed config 生命周期 | main      | managedPlan + fake transport | 批量发布、systemd 合并、unchanged 语义 | tests/dv/app_management_execution.test.ts | covered | -                   |
| service unit 发布       | lifecycle | fake transport               | 静态候选、daemon-reload、restart       | tests/dv/app_management_execution.test.ts | covered | -                   |
| hook 失败恢复           | failure   | fake transport               | 恢复配置并记录 recovery                | tests/dv/app_management_execution.test.ts | covered | -                   |
| 执行器隔离与取消        | failure   | executor DV 回归             | 单目标失败不破坏其他目标，资源清理     | tests/dv/execution.test.ts                | covered | -                   |

## Integration Tests

| Contract or Flow | Modules Involved     | Success Case                    | Failure Case           | Test File                                                                                         | Status  | Gap / Manual Reason |
| ---------------- | -------------------- | ------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- | ------- | ------------------- |
| 文档/示例契约    | config/docs/examples | README、指南、nginx v4 示例一致 | 不一致即失败           | tests/contract/verify_app_management_contract.ts                                                  | covered | -                   |
| 传输/bundle 安全 | execution/transport  | 固定 argv、成员摘要和路径校验   | 非法路径/成员/参数失败 | tests/integration/managed_transport_security.test.ts, tests/integration/remote_deployment.test.ts | covered | -                   |
| 示例集群装载     | config/planning      | nginx v4 示例可装载计划         | 非法布局失败           | tests/integration/environment_placement.test.ts                                                   | covered | -                   |
| 全量回归         | 全模块               | 已有生命周期和 CLI 行为保持     | 行为漂移失败           | deno task test                                                                                    | covered | -                   |

## Validation Rationale

风险档案中 contract/data/security/runtime/build/harness 的 required_checks 分别由 v4 装载
正负例、unit 渲染安全边界、快照往返、执行事务、`deno task check`/lint 和任务级统一入口覆盖。 `ui`
不适用。测试在变更后运行；任务级运行制品由 `test-run.py` 生成。

## Definition of Done

- [x] 任务作用域统一入口成功并生成 run artifact。
- [x] testplan 所有启用步骤与 contract checks 通过。
- [x] 每个 change_id 均有直接覆盖，无未解释 gap。
- [x] `deno task check`、`deno task lint`、格式检查通过。
