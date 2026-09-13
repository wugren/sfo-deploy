---
task_manifest: task.yaml
status: approved
---

# Testing：生命周期脚本文件权限与 Deno-only 运行时

Risk profile: ./risk-profile.yaml

## Test Document Index

| Document   | Topic                                              | Scope                                  |
| ---------- | -------------------------------------------------- | -------------------------------------- |
| testing.md | 脚本 read/write 权限、快照往返与 Python 运行时移除 | 配置装载、计划快照、远端执行、文档契约 |

## Unified Test Entry

- Machine-readable task plan:
  `docs/versions/v0.1/modules/sfo-deploy/089-lifecycle-file-permissions/testplan.yaml`
- Task all:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/089-lifecycle-file-permissions all`
- Single-task boundary: 只运行本任务计划；不运行 module 作用域、`all all`、根快捷方式或 quality
  gates。
- Registration: 新增/修改测试、契约检查与文档示例均由 `testplan.yaml` 注册。

## Repository Consumer Closure

| Old Symbol                                       | New Path                              | Repository Consumer File | Consumer Kind            | Migration Status | Contract Check ID |
| ------------------------------------------------ | ------------------------------------- | ------------------------ | ------------------------ | ---------------- | ----------------- |
| `ScriptRuntimeKind` 的 Deno 或 Python union      | `src/types.ts` 的 Deno-only union     | `src/execution.ts`       | internal type consumer   | migrated         | C1/C3             |
| Python-only remote preflight and execute methods | removed / `executeDeno()`             | `src/transport.ts`       | remote session interface | migrated         | C1/C3             |
| Python secret loader file                        | removed / `src/secret_loader/deno.ts` | `src/execution.ts`       | runtime loader consumer  | migrated         | C1/C3             |
| Python v1 snapshot reader                        | `src/history.ts` 的明确拒绝路径       | `src/history.ts`         | plan snapshot consumer   | migrated         | C1/C3             |
| `ScriptPermissions` 的 run/net-only 形状         | `src/types.ts` 增加可选 read/write    | `src/config.ts`          | configuration loader     | migrated         | C2/C3             |

## Submodule Tests

| Submodule                 | Responsibility                               | Detailed Test Doc | Required Behaviors                                           | Edge/Failure Cases                         | Test Type   | Test Files                                                                                     | Status  | Gap / Manual Reason |
| ------------------------- | -------------------------------------------- | ----------------- | ------------------------------------------------------------ | ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------- | ------- | ------------------- |
| Script permissions loader | 装载并校验 `read/write` 绝对路径             | testing.md        | 合法扩展路径归一；workspace 缺省不变；非法路径失败关闭       | 相对路径、`/`、逗号、重复路径、未知字段    | unit        | `tests/unit/app_management_config.test.ts`, `tests/unit/environment_management_config.test.ts` | covered |                     |
| Plan history codec        | v4 快照保存新权限；旧 Deno 快照兼容；v1 拒绝 | testing.md        | read/write round-trip；旧 v2 快照可重新归档；旧快照缺省空数组；Python v1 明确拒绝 | 非法路径、缺失字段、重复路径、空相对路径、v1 快照 | unit        | `tests/unit/history.test.ts`, `tests/unit/history_regressions.test.ts`                         | covered |                     |
| Remote Deno execution     | 合并 workspace 与用户扩展授权                | testing.md        | workspace 始终授权；read/write 精确追加；重复 workspace 去重 | 相对路径、重复用户路径、越界路径           | unit        | `tests/unit/transport_cli.test.ts`                                                             | covered |                     |
| Actual Deno sandbox       | Deno 原生授权行为                            | testing.md        | 授权读/写成功；越界写拒绝；只读不能删除                      | allowed path、outside path、read-only path | integration | `tests/integration/script_file_permissions.test.ts`                                            | covered |                     |
| Runtime removal           | 新计划只接受 Deno；Python loader 不存在      | testing.md        | Python loader 缺失；Python-only 方法编译失败；v1 快照拒绝    | removed API、legacy fixture                | contract    | `tests/contract/verify_deno_contract.ts`                                                       | covered |                     |

## Module-Level Tests

| Test Item                      | Covered Boundary                          | Entry                     | Expected Result                                   | Test Type   | Test File/Script                                    | Status  | Gap / Manual Reason |
| ------------------------------ | ----------------------------------------- | ------------------------- | ------------------------------------------------- | ----------- | --------------------------------------------------- | ------- | ------------------- |
| app script permissions         | 合法/非法 read、write 路径                | unit / app config loader  | 合法路径进入计划；非法路径失败关闭                | unit        | `tests/unit/app_management_config.test.ts`          | covered |                     |
| environment script permissions | 合法 read/write 进 environment invocation | unit / environment loader | 合法路径进入 install invocation                   | unit        | `tests/unit/environment_management_config.test.ts`  | covered |                     |
| execution permission handoff   | invocation permissions 传递到 session     | dv / executor             | executeDeno 收到新权限                            | dv          | `tests/dv/execution.test.ts`                        | covered |                     |
| actual Deno allow/deny         | Deno 运行时权限                           | integration / child Deno  | 授权成功、越界拒绝、只读不能删除                  | integration | `tests/integration/script_file_permissions.test.ts` | covered |                     |
| documentation contract         | 用户可见边界一致                          | contract / documentation  | README/guide/example 描述 read/write 与 Deno-only | contract    | `tests/contract/verify_deno_contract.ts`            | covered |                     |

## External Interface Tests

| Interface                      | Responsibility               | Success Cases                           | Failure/Edge Cases                   | Test Type        | Test Doc/File                                   | Status  | Gap / Manual Reason |
| ------------------------------ | ---------------------------- | --------------------------------------- | ------------------------------------ | ---------------- | ----------------------------------------------- | ------- | ------------------- |
| `ScriptPermissions.read/write` | 外部消费者声明 Deno 文件授权 | positive consumer 编译；loader 归一字段 | 非法路径被 loader 拒绝               | contract         | `tests/contract/script_permissions_consumer.ts` | covered |                     |
| plan v4 permissions            | 重放时保留授权               | v4 round-trip                           | 非法路径、重复路径、v1 snapshot 拒绝 | unit             | `tests/unit/history.test.ts`                    | covered |                     |
| OpenSSH executeDeno argv       | 最终 Deno 权限边界           | workspace + user paths 合并             | 不安全路径失败；缺失权限由 Deno 拒绝 | unit/integration | `tests/unit/transport_cli.test.ts`              | covered |                     |

## Direct Change Coverage

| change_id                      | design_source                                                     | validation_id        | testplan_level      | testplan_step_id     | Gap? | Gap / Manual Reason |
| ------------------------------ | ----------------------------------------------------------------- | -------------------- | ------------------- | -------------------- | ---- | ------------------- |
| CHG-lifecycle-file-permissions | `design.md` File-Level Interfaces、Key Flows、State and Ownership | U1             | unit           | U1             | no   | 其他层级覆盖见 Case-Type Coverage。 |
| CHG-remove-python-runtime      | `design.md` Overall Approach、Consumer Migration Closure          | U3             | unit           | U3             | no   | 其他层级覆盖见 Case-Type Coverage。 |

## Case-Type Coverage

| change_id                      | case_type     | required | validation_id | level            | status         | gap_manual_reason                                       |
| ------------------------------ | ------------- | -------- | ------------- | ---------------- | -------------- | ------------------------------------------------------- |
| CHG-lifecycle-file-permissions | normal        | yes      | U1            | unit             | covered        |                                                         |
| CHG-lifecycle-file-permissions | boundary      | yes      | U1            | unit             | covered        |                                                         |
| CHG-lifecycle-file-permissions | negative      | yes      | U1            | unit             | covered        |                                                         |
| CHG-lifecycle-file-permissions | error         | yes      | U1            | unit             | covered        |                                                         |
| CHG-lifecycle-file-permissions | compatibility | yes      | U1            | unit             | covered        |                                                         |
| CHG-lifecycle-file-permissions | lifecycle     | yes      | I1            | integration      | covered        |                                                         |
| CHG-lifecycle-file-permissions | cross-module  | yes      | I2            | integration      | covered        |                                                         |
| CHG-remove-python-runtime      | normal        | yes      | U3            | unit             | covered        |                                                         |
| CHG-remove-python-runtime      | boundary      | yes      | U3            | unit             | covered        |                                                         |
| CHG-remove-python-runtime      | negative      | yes      | U3/C3         | unit             | covered        |                                                         |
| CHG-remove-python-runtime      | error         | yes      | U3            | unit             | covered        |                                                         |
| CHG-remove-python-runtime      | compatibility | yes      | C1            | integration      | covered        |                                                         |
| CHG-remove-python-runtime      | lifecycle     | no       | U3            | unit             | not-applicable | 运行时类型移除在装载/重放入口失败关闭，无新增生命周期。 |
| CHG-remove-python-runtime      | cross-module  | yes      | I3            | integration      | covered        |                                                         |

## Design Element Coverage

| element_type     | design_source                                  | derived_cases                                                        | level            | status         | gap_manual_reason                                             |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------- | ---------------- | -------------- | ------------------------------------------------------------- |
| parameter-domain | `design.md` File-Level Interfaces              | 合法绝对路径、相对路径、根路径、`.`/`..`、逗号、重复值               | unit             | covered        |                                                               |
| state-transition | `design.md` State and Ownership                | 新 v4 编码、旧 v2/v3 缺省、v1 拒绝、workspace+扩展路径合并           | unit             | covered        |                                                               |
| failure-path     | `design.md` Key Flows                          | Deno 越界写拒绝、只读删除拒绝                              | integration | covered        | 装载与 argv 拒绝由 U1/U2 覆盖。 |
| error-handling   | `design.md` Design Notes and Risks             | Deno NotCapable/PermissionDenied                              | integration | covered        | 配置/快照错误由 U1 覆盖。       |
| invariant        | `design.md` State and Ownership / Design Notes | workspace 始终授权；只读不授予写/删除；v4 权限完整往返               | unit        | covered        |                                   |
| concurrency      | `design.md` State and Ownership                | not-applicable                                                       | unit             | not-applicable | 权限是 immutable plan value，本任务未新增并发或共享可变状态。 |

## Validation Rationale

| Behavior or Risk             | Validation Signal                         | Why This Is Sufficient                                                      | Gap / Manual Reason                                 |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| 用户可精确扩展 Deno 文件授权 | 配置装载、argv 合并与真实 Deno 测试       | 从 YAML 到最终 argv 再到实际运行授权都有直接证据。                          |                                                     |
| 未授权写/删除失败            | 实际子 Deno 越界写与只读删除              | 使用 Deno 2 子进程验证 NotCapable/PermissionDenied 行为，而非仅 mock argv。 |                                                     |
| 旧配置和旧 Deno 快照兼容     | 缺省 read/write 与 v2/v3 codec 测试       | 缺省保持 workspace 行为；旧快照缺失新字段时归一为空数组。                   |                                                     |
| Python v1 快照明确拒绝       | v1 fixture decoder 测试                   | 触达新 rejection 路径并断言明确错误信息。                                   |                                                     |
| Python 运行时移除完整        | removed-symbol scan 和 repository closure | 机器检查受影响输入树，编译闭包证明新代码可编译。                            |                                                     |
| 子进程绕过 Deno 文件沙箱     | 文档说明；不提供 OS 隔离验证              | 属于提案明确非目标，不把 run 权限误报为沙箱保证。                           | manual boundary: 文档契约覆盖，不验证外部程序能力。 |

## Unit Tests

| Function or Unit                         | Branch or Condition                | Covered Behavior                                 | Test File                                          | Status  | Gap / Manual Reason |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------ | -------------------------------------------------- | ------- | ------------------- |
| `pathPermission`                         | valid/invalid absolute POSIX paths | 合法路径归一；相对、根、`.`/`..`、逗号、重复拒绝 | `tests/unit/app_management_config.test.ts`         | covered |                     |
| `scriptInvocation`                       | optional read/write                | 未配置为空数组；配置后保留路径                   | `tests/unit/app_management_config.test.ts`         | covered |                     |
| environment invocation parser            | read/write normalization           | environment install invocation 保留扩展路径      | `tests/unit/environment_management_config.test.ts` | covered |                     |
| `encodeInvocation` / `decodePermissions` | v4 permissions/legacy absence      | 新字段完整往返；旧字段缺省空数组；非法路径拒绝   | `tests/unit/history.test.ts`                       | covered |                     |
| `decodePlan`                             | schema 1 rejection                 | Python v1 fixture 返回明确 unsupported 错误      | `tests/unit/history_regressions.test.ts`           | covered |                     |
| `encodePlanInvocation`                   | legacy empty relative path         | 旧 v2 快照重新归档为 v4 时保留空 `relativePath` | `tests/unit/history_regressions.test.ts`           | covered |                     |
| `executeDeno`                            | file path merging                  | workspace 始终授权并合并 read/write              | `tests/unit/transport_cli.test.ts`                 | covered |                     |
| `prepareExecution` / executor            | Deno-only runtime                  | 只接受 deno；Python-only runtime 不再执行        | `tests/dv/execution.test.ts`                       | covered |                     |

未覆盖的已改动分支：无。旧 schema v1 的 Python 解码分支已随代码删除，negative fixture 直接证明
rejection。

## DV Tests

| Workflow                       | Kind    | Entry                         | Expected Result                          | Test File or Script                         | Status  | Gap / Manual Reason |
| ------------------------------ | ------- | ----------------------------- | ---------------------------------------- | ------------------------------------------- | ------- | ------------------- |
| Deno runtime preflight         | lifecycle | `prepareExecution` + executor | 每个 Deno runtime key 只预检一次并复用结果 | `tests/dv/execution.test.ts`                | covered |                     |
| plan preparation and execution | main    | `prepareExecution` + executor | invocation 权限完整传递到 remote session | `tests/dv/execution.test.ts`                | covered |                     |
| managed App execution          | main    | app deployment executor       | managed script hook 收到 permissions     | `tests/dv/app_management_execution.test.ts` | covered |                     |
| execution failure/cleanup      | failure | executor failure paths        | 失败仍走既有结果和清理路径               | `tests/dv/execution.test.ts`                | covered |                     |

## Integration Tests

| Contract or Flow                | Modules Involved                         | Success Case                 | Failure Case                          | Test File                                              | Status  | Gap / Manual Reason |
| ------------------------------- | ---------------------------------------- | ---------------------------- | ------------------------------------- | ------------------------------------------------------ | ------- | ------------------- |
| Deno native file permissions    | config loader -> transport -> Deno child | 授权读/写成功                | 越界写、只读删除失败                  | `tests/integration/script_file_permissions.test.ts`    | covered |                     |
| secret loader / runtime removal | execution -> remote runtime loader       | Deno loader 通过既有契约     | Python loader 缺失，Deno-only closure | `tests/integration/secret_loader_contract.test.ts`     | covered |                     |
| managed transport execution     | execution -> OpenSSH transport           | Deno argv 使用 verified HOME | Python-only path removed              | `tests/integration/managed_transport_security.test.ts` | covered |                     |
| documentation contract          | implementation -> README/guide/example   | 文档描述新权限与 Deno-only   | 文档漂移导致失败                      | `tests/contract/verify_deno_contract.ts`               | covered |                     |

## Regression Focus

- 防止把 `read` 授权误解为 `write` 或删除授权。
- 防止旧快照缺失新字段时丢失 workspace 权限。
- 防止旧 v2/v3 快照重新归档时把合法空 `relativePath` 误判为非法。
- 防止 Python v1 快照被静默转换或部分回放。
- 防止文档声称子进程继承 Deno 沙箱。

## Definition of Done

- [x] 两个 `change_id` 在 proposal、design、testing 和 `testplan.yaml` 中直接映射。
- [x] 新增/修改测试可通过 task-scoped unified entrypoint 执行。
- [x] 配置装载、非法路径、快照往返、Deno 实际授权/拒绝、运行时移除与文档契约均有验证。
- [x] 子进程隔离按提案作为非目标记录，不作为通过证据。
