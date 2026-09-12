---
task_manifest: task.yaml
status: approved
---

# Environment script manager stop Testing

Risk profile: ./risk-profile.yaml

## Test Document Index

| Document   | Topic                                | Scope    |
| ---------- | ------------------------------------ | -------- |
| testing.md | Environment script manager stop 行为 | 全部变更 |

## Unified Test Entry

- Machine-readable task plan: `testplan.yaml`
- Task all:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/074-environment-script-manager-stop all`
- Single-task boundary: only `sfo-deploy/074-environment-script-manager-stop`.

## Repository Consumer Closure

| Old Symbol                                | New Path                                    | Repository Consumer File                                                             | Consumer Kind | Migration Status | Contract Check ID |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------- | ---------------- | ----------------- |
| two-action script manager YAML            | three-action script manager YAML            | examples/eleph-server-multipass/cluster-template/environments/mysql/environment.yaml | configuration | migrated         | C1/C2             |
| two-action script manager YAML            | three-action script manager YAML            | examples/eleph-server-multipass/cluster-template/environments/redis/environment.yaml | configuration | migrated         | C1/C2             |
| two-action script manager guide           | three-action script manager guide           | docs/guides/sfo-deploy-cluster-configuration.md                                      | documentation | migrated         | C2                |
| two-action script manager skill reference | three-action script manager skill reference | skills/sfo-deploy-cluster/references/environment.md                                  | documentation | migrated         | C2                |

## Submodule Tests

| Submodule             | Responsibility                                    | Detailed Test Doc | Required Behaviors                                  | Edge/Failure Cases                                 | Test Type           | Test Files    | Status  | Gap / Manual Reason |
| --------------------- | ------------------------------------------------- | ----------------- | --------------------------------------------------- | -------------------------------------------------- | ------------------- | ------------- | ------- | ------------------- |
| environment-lifecycle | script manager 三段生命周期装载、计划、快照与执行 | testing.md        | stop 装载、direct stop 计划、执行脚本、plan v4 兼容 | 缺 stop、system manager 不计划 stop、旧快照缺 stop | unit/dv/integration | testplan.yaml | covered | -                   |

## Module-Level Tests

| Test Item                    | Covered Boundary           | Entry    | Expected Result                | Test Type | Test File/Script                                   | Status  | Gap / Manual Reason |
| ---------------------------- | -------------------------- | -------- | ------------------------------ | --------- | -------------------------------------------------- | ------- | ------------------- |
| script manager stop contract | YAML 必需三段调用          | task all | 合法装载，缺 stop 失败         | unit      | tests/unit/environment_management_config.test.ts   | covered | -                   |
| stop selection               | script manager direct stop | task all | 生成 stop 步骤并绑定 stop 脚本 | unit      | tests/unit/environment_management_planning.test.ts | covered | -                   |
| stop execution               | script manager stop 步骤   | task all | 执行成功且不跳过               | dv        | tests/dv/environment_management_execution.test.ts  | covered | -                   |

## External Interface Tests

| Interface        | Responsibility      | Success Cases      | Failure/Edge Cases             | Test Type   | Test Doc/File                                            | Status  | Gap / Manual Reason |
| ---------------- | ------------------- | ------------------ | ------------------------------ | ----------- | -------------------------------------------------------- | ------- | ------------------- |
| environment.yaml | script manager 装载 | start/stop/restart | 缺 stop、未知字段、路径非法    | unit        | tests/unit/environment_management_config.test.ts         | covered | -                   |
| plan v4          | stop 声明持久化     | 三段 round-trip    | 旧快照缺 stop 的 stop 步骤失败 | integration | tests/integration/environment_management_history.test.ts | covered | -                   |

## Direct Change Coverage

| change_id                           | design_source                                                        | validation_id        | testplan_level | testplan_step_id | gap | gap_manual_reason                               |
| ----------------------------------- | -------------------------------------------------------------------- | -------------------- | -------------- | ---------------- | --- | ----------------------------------------------- |
| CHG-environment-script-manager-stop | `design.md` File-Level Interfaces、`design/environment-lifecycle.md` | C1/C2/U1/U2/U3/D1/I1 | unit           | U1               | no  | 多个步骤共用同一 change_id；完整入口为 task all |

## Case-Type Coverage

| change_id                           | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| ----------------------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-environment-script-manager-stop | normal        | yes      | U1/U2/D1      | unit        | covered | -                 |
| CHG-environment-script-manager-stop | boundary      | yes      | U1            | unit        | covered | -                 |
| CHG-environment-script-manager-stop | negative      | yes      | U1/U2         | unit        | covered | -                 |
| CHG-environment-script-manager-stop | error         | yes      | U2/I1         | unit        | covered | -                 |
| CHG-environment-script-manager-stop | compatibility | yes      | I1            | integration | covered | -                 |
| CHG-environment-script-manager-stop | lifecycle     | yes      | D1            | dv          | covered | -                 |
| CHG-environment-script-manager-stop | cross-module  | yes      | I1            | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                         | derived_cases                                        | level       | status  | gap_manual_reason |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------- | ----------- | ------- | ----------------- |
| parameter-domain | `design/environment-lifecycle.md` Configuration Shape | U1 start/stop/restart 三段、缺 stop、未知字段        | unit        | covered | -                 |
| state-transition | `design.md` State and Ownership                       | D1 direct stop 执行；system manager 不计划 stop      | dv          | covered | -                 |
| failure-path     | `design.md` Key Flows                                 | U1 缺 stop；U2 system stop 拒绝；I1 旧快照 stop 失败 | unit        | covered | -                 |
| error-handling   | `design/environment-lifecycle.md` Snapshot Contract   | I1 旧快照缺 stop 字段失败关闭                        | integration | covered | -                 |
| invariant        | `design.md` Design Scope                              | U2 prepare 不生成 stop；system manager 行为不变      | unit        | covered | -                 |
| concurrency      | `design.md` State and Ownership                       | U2 direct stop 单步骤线性化，不引入新的并发边界      | unit        | covered | -                 |

## Validation Rationale

| Behavior or Risk   | Validation Signal | Why This Is Sufficient                    | Gap / Manual Reason                  |
| ------------------ | ----------------- | ----------------------------------------- | ------------------------------------ |
| 配置契约迁移       | U1/C2             | 覆盖合法三段、缺字段失败和文档契约        | -                                    |
| direct stop 行为   | U2/D1             | 证明 stop 计划绑定脚本且执行器不跳过      | -                                    |
| 计划重放兼容性     | I1                | 证明新快照往返和旧 start/restart 快照兼容 | -                                    |
| 真实发行版服务语义 | manual            | 无真实 Ubuntu/CentOS 节点                 | manual gap：真实 stop 状态需实机验证 |

## Unit Tests

| Function or Unit           | Branch or Condition     | Covered Behavior                   | Test File                                          | Status  | Gap / Manual Reason |
| -------------------------- | ----------------------- | ---------------------------------- | -------------------------------------------------- | ------- | ------------------- |
| `environmentScriptManager` | start/stop/restart 字段 | 合法三段装载、缺 stop 失败         | tests/unit/environment_management_config.test.ts   | covered | -                   |
| planner manager selection  | action 与 manager kind  | script stop 计划；system stop 拒绝 | tests/unit/environment_management_planning.test.ts | covered | -                   |
| existing runtime           | system start/restart    | 回归确认未被 stop 扩展破坏         | tests/unit/environment_management.test.ts          | covered | -                   |

## DV Tests

| Workflow                   | Kind      | Entry    | Expected Result           | Test File or Script                                      | Status  | Gap / Manual Reason                            |
| -------------------------- | --------- | -------- | ------------------------- | -------------------------------------------------------- | ------- | ---------------------------------------------- |
| direct stop script manager | lifecycle | task all | stop 步骤执行成功         | tests/dv/environment_management_execution.test.ts        | covered | -                                              |
| direct stop script manager | main      | task all | stop 步骤按声明调用并成功 | tests/dv/environment_management_execution.test.ts        | covered | -                                              |
| old snapshot without stop  | failure   | task all | 旧快照 stop 请求失败关闭  | tests/integration/environment_management_history.test.ts | gap     | 已在集成层覆盖故障注入，不重复建立 DV 失败用例 |

## Integration Tests

| Contract or Flow         | Modules Involved | Success Case  | Failure Case           | Test File                                                | Status  | Gap / Manual Reason |
| ------------------------ | ---------------- | ------------- | ---------------------- | -------------------------------------------------------- | ------- | ------------------- |
| plan v4 manager snapshot | planning/history | stop 三段往返 | 旧快照 stop 缺字段失败 | tests/integration/environment_management_history.test.ts | covered | -                   |

## Regression Focus

- 旧顶层 `scripts` 环境不受新 stop 字段影响。
- plan v3 不携带新字段；旧 plan v4 start/restart 快照仍可回放。

## Definition of Done

- [x] 配置、计划、执行、快照和文档行为均有直接验证或 gap 记录。
- [x] 新增/修改测试全部通过 `testplan.yaml` 的 task-scoped unified entrypoint 可达。
- [x] `deno task check` 作为仓库编译闭包执行。
- [x] 真实 Ubuntu/CentOS 实机验证缺失已记录为 manual gap。
