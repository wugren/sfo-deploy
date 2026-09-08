---
task_manifest: task.yaml
status: approved
---

# 内置 versioned 发布测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`，覆盖 v4 装载、计划注入、历史往返、内置发布执行、示例契约与文档。
- 子模块测试文档：无独立业务子模块；文件级分解见 `design.md`。
- 机器可读执行计划：`testplan.yaml`。

## Submodule Tests

任务在 sfo-deploy 模块内按文件级职责分解，不建立独立业务子模块；覆盖由 Unit/DV/Integration 表登记。

## Module-Level Tests

模块级行为由 `tests/unit/app_management_config.test.ts`、`tests/unit/history.test.ts`、
`tests/unit/history_regressions.test.ts`、`tests/dv/execution.test.ts`、
`tests/dv/app_management_execution.test.ts` 和 `tests/integration/versioned_release.test.ts` 覆盖。
公共类型、文档示例与仓库编译闭包由 testplan contract checks 执行。

## External Interface Tests

- `app.yaml` v4 `deployment.kind` 装载契约：默认启用、显式声明、非法 kind 和所有权冲突失败关闭。
- 计划/历史持久契约：`deployment` encode/decode，旧 v1/v2/v3/v4 快照继续解码。
- 内置远端发布契约：validated-directory、版本目录、`VERSION`、`latest`、当前标记、清理和回滚。
- 示例契约：jx-server 与 jx-web 使用内置发布；jx-server 的 service 从 `current` 启动。
- README 与配置指南描述默认启用、自定义 deploy 逃生门和路径布局。

## Unified Test Entry

任务作用域统一入口为：
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/054-jx-server-systemd-start all`。
它执行 contract、unit、DV 和 integration 步骤并写出机器制品。

## Direct Change Coverage

| change_id                            | design_source                                                            | validation_id  | testplan_level | testplan_step_id | Gap? | Gap / Manual Reason |
| ------------------------------------ | ------------------------------------------------------------------------ | -------------- | -------------- | ---------------- | ---- | ------------------- |
| CHG-versioned-deployment-schema      | design.md File-Level Interfaces、Directly Mapped Change Items            | U1/C1/C2       | unit           | U1               | no   | -                   |
| CHG-versioned-deployment-execution   | design.md Key Flows、State and Ownership                                 | U2/D1/I1/C2/C3 | unit           | U2               | no   | -                   |
| CHG-packaged-app-versioned-migration | design.md Consumer Migration Closure、File-Level Implementation Sequence | I1/C2          | integration    | I1               | no   | -                   |
| CHG-versioned-deployment-docs-tests  | design.md Implementation Order、Risks and Rollback                       | I2/C2/C3/C4    | integration    | I2               | no   | -                   |

## Case-Type Coverage

| change_id                            | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| ------------------------------------ | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-versioned-deployment-schema      | normal        | yes      | U1            | unit        | covered | -                 |
| CHG-versioned-deployment-schema      | boundary      | yes      | U1            | unit        | covered | -                 |
| CHG-versioned-deployment-schema      | negative      | yes      | U1            | unit        | covered | -                 |
| CHG-versioned-deployment-schema      | error         | yes      | U1            | unit        | covered | -                 |
| CHG-versioned-deployment-schema      | compatibility | yes      | U2            | unit        | covered | -                 |
| CHG-versioned-deployment-schema      | lifecycle     | yes      | D1            | dv          | covered | -                 |
| CHG-versioned-deployment-schema      | cross-module  | yes      | C1/C2         | integration | covered | -                 |
| CHG-versioned-deployment-execution   | normal        | yes      | I1            | integration | covered | -                 |
| CHG-versioned-deployment-execution   | boundary      | yes      | I1            | integration | covered | -                 |
| CHG-versioned-deployment-execution   | negative      | yes      | I1            | integration | covered | -                 |
| CHG-versioned-deployment-execution   | error         | yes      | I1            | integration | covered | -                 |
| CHG-versioned-deployment-execution   | compatibility | yes      | U2            | unit        | covered | -                 |
| CHG-versioned-deployment-execution   | lifecycle     | yes      | I1/D1         | integration | covered | -                 |
| CHG-versioned-deployment-execution   | cross-module  | yes      | D1/C3         | dv          | covered | -                 |
| CHG-packaged-app-versioned-migration | normal        | yes      | I1/C2         | integration | covered | -                 |
| CHG-packaged-app-versioned-migration | boundary      | yes      | I1            | integration | covered | -                 |
| CHG-packaged-app-versioned-migration | negative      | yes      | I1            | integration | covered | -                 |
| CHG-packaged-app-versioned-migration | error         | yes      | I1            | integration | covered | -                 |
| CHG-packaged-app-versioned-migration | compatibility | yes      | C2            | integration | covered | -                 |
| CHG-packaged-app-versioned-migration | lifecycle     | yes      | D1            | dv          | covered | -                 |
| CHG-packaged-app-versioned-migration | cross-module  | yes      | I2/C3         | integration | covered | -                 |
| CHG-versioned-deployment-docs-tests  | normal        | yes      | C2/C4         | integration | covered | -                 |
| CHG-versioned-deployment-docs-tests  | boundary      | no       | I2            | integration | covered | -                 |
| CHG-versioned-deployment-docs-tests  | negative      | yes      | C4            | integration | covered | -                 |
| CHG-versioned-deployment-docs-tests  | error         | no       | I2            | integration | covered | -                 |
| CHG-versioned-deployment-docs-tests  | compatibility | yes      | C3            | integration | covered | -                 |
| CHG-versioned-deployment-docs-tests  | lifecycle     | no       | I2            | integration | covered | -                 |
| CHG-versioned-deployment-docs-tests  | cross-module  | yes      | C2/C3/C4      | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                           | derived_cases                                                     | level       | status  | gap_manual_reason |
| ---------------- | --------------------------------------- | ----------------------------------------------------------------- | ----------- | ------- | ----------------- |
| parameter-domain | design.md File-Level Interfaces         | deployment kind、包根、版本名、发布根、run_as、keep_versions      | unit        | covered | -                 |
| state-transition | design.md State and Ownership           | 同版本、新版本、latest 切换、标记更新、旧版本清理                 | integration | covered | -                 |
| failure-path     | design.md Key Flows、Risks and Rollback | 包类型非法、发布根非法、标记失败回滚、managed 恢复                | dv          | covered | -                 |
| error-handling   | design.md Key Flows                     | 配置冲突、非法 kind、无 run_as、安装包/目录失败                   | unit        | covered | -                 |
| invariant        | design.md State and Ownership           | 自定义 deploy 不变、旧快照可读、固定 run 白名单、服务在发布后收敛 | integration | covered | -                 |
| concurrency      | design.md State and Ownership           | App/目标锁、release attempt 与执行器隔离回归                      | dv          | covered | -                 |

## Unit Tests

| Function or Unit              | Branch or Condition                            | Covered Behavior             | Test File                                | Status  | Gap / Manual Reason |
| ----------------------------- | ---------------------------------------------- | ---------------------------- | ---------------------------------------- | ------- | ------------------- |
| deploymentDefinition/loadApps | 默认、显式、packageless、custom deploy、run_as | v4 deployment 装载和冲突校验 | tests/unit/app_management_config.test.ts | covered | -                   |
| effectiveAppScripts/buildPlan | 有/无 deployment、无 scripts.deploy            | 注入内置脚本且不带无关秘密   | tests/unit/app_management_config.test.ts | covered | -                   |
| encode/decodeStep             | deployment 存在/缺失/旧 schema                 | 快照往返与旧计划兼容         | tests/unit/history.test.ts               | covered | -                   |

## DV Tests

| Workflow         | Kind      | Entry          | Expected Result                       | Test File or Script                       | Status  | Gap / Manual Reason |
| ---------------- | --------- | -------------- | ------------------------------------- | ----------------------------------------- | ------- | ------------------- |
| managed App 事务 | main      | fake transport | deploy 脚本成功后发布配置/unit 并收敛 | tests/dv/app_management_execution.test.ts | covered | -                   |
| App/目标锁定发布 | lifecycle | fake transport | release attempt 与 flock 租约语义     | tests/dv/execution.test.ts                | covered | -                   |
| 执行器失败隔离   | failure   | fake transport | 资源清理、单目标失败隔离              | tests/dv/execution.test.ts                | covered | -                   |

## Integration Tests

| Contract or Flow | Modules Involved                    | Success Case                  | Failure Case                     | Test File                                           | Status  | Gap / Manual Reason |
| ---------------- | ----------------------------------- | ----------------------------- | -------------------------------- | --------------------------------------------------- | ------- | ------------------- |
| 内置发布生命周期 | execution/remote runtime/filesystem | 同版本跳过、发布、清理        | 包类型、路径、标记失败、清理禁止 | tests/integration/versioned_release.test.ts         | covered | -                   |
| 示例与文档契约   | config/planning/docs/examples       | jx-server/jx-web 使用 builtin | 配置/文档漂移失败                | tests/contract/verify_app_management_contract.ts    | covered | -                   |
| 仓库消费者闭包   | src/tests/examples/docs             | 全仓编译与远端脚本闭合        | 类型/脚本漂移失败                | tests/contract/verify_independent_remote_scripts.ts | covered | -                   |

## Validation Rationale

风险档案 contract/data/security/runtime/harness 的 required_checks 分别由 schema 正负例、快照往返、
权限白名单与发布根失败关闭、内置发布/managed 顺序、统一入口和文档闭包覆盖。`ui` 与 `build`
不适用；无第三方依赖变化。真实 Multipass SSH 部署不是本地自动化验收范围，作为残余风险记录。

## Definition of Done

- [x] 任务作用域统一入口成功并生成 run artifact。
- [x] testplan 所有启用步骤与 contract checks 通过。
- [x] 每个 change_id 均有直接覆盖，无未解释 gap。
- [x] `deno task check`、`deno task lint`、格式检查通过。
