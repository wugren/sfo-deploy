---
task_manifest: task.yaml
status: draft
---

# sfo-deploy App schema 1 Testing

Risk profile: ./risk-profile.yaml

## Test Document Index

| Document | Topic        | Scope                                                   |
| -------- | ------------ | ------------------------------------------------------- |
| none     | 单一测试文档 | App schema 1 配置、服务生命周期、历史序列化、文档与示例 |

## Submodule Tests

| Submodule         | Responsibility                  | Detailed Test Doc | Required Behaviors                            | Edge/Failure Cases                   | Test Type | Test Files                                                                                          | Status  | Gap / Manual Reason   |
| ----------------- | ------------------------------- | ----------------- | --------------------------------------------- | ------------------------------------ | --------- | --------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| config loader     | schema 1 严格装载和归一          | 本文件             | 只接受 v1；configs/management 分型；唯一性       | 旧 schema、重复、冲突、越界、非法服务       | unit      | tests/unit/app_management_config.test.ts                                                              | covered |                       |
| planning          | 配置和服务步骤排序               | 本文件             | configure/stage/activate/restart 依赖           | 缺服务、on_change 冲突、空对象             | unit      | tests/unit/config_planning.test.ts                                                                    | covered |                       |
| service runtime   | system/script 服务收敛           | 本文件             | auto/systemctl/service 与脚本命令               | 失败、未收敛、tool service 限制             | unit/dv   | tests/unit/service_management.test.ts; tests/dv/app_management_execution.test.ts                      | covered | 真实主机不可用         |
| execution         | 文件事务、脚本、秘密和恢复        | 本文件             | 发布、提交、恢复、脱敏                           | hook 失败、取消、清理失败                   | dv        | tests/dv/app_management_execution.test.ts                                                             | covered |                       |
| history           | 新管理字段序列化和回滚           | 本文件             | 快照往返、required scripts、rollback             | 篡改、旧快照、不完整关闭                    | unit      | tests/unit/history.test.ts; tests/unit/history_regressions.test.ts                                    | covered |                       |

## Unified Test Entry

- Machine-readable task plan:
  `docs/versions/v0.1/modules/sfo-deploy/072-app-config-lifecycle/testplan.yaml`
- Task all:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/072-app-config-lifecycle all`
- Single-task boundary: 不运行 package/module 作用域、`all all`、根快捷方式或 quality gates。
- Registration: 本任务新增/修改的测试文件都出现在 `testplan.yaml` 的 test_targets 或 contract run
  中。

## Repository Consumer Closure

| Old Symbol              | New Path                                   | Repository Consumer File                                                   | Consumer Kind             | Migration Status | Contract Check ID |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------- | ------------------------- | ---------------- | ----------------- |
| App schema 2/3/4 loader | `src/config.ts` schema 1 loader            | `tests/unit/config_planning.test.ts`                                       | negative/positive fixture | migrated         | C1-C5             |
| `management.actions`    | top-level `configs` + `management.service` | `tests/unit/app_management_config.test.ts`                                 | unit test                 | migrated         | C1-C5             |
| fixed systemd primitive | `AppServiceManagement`                     | `src/service_management.ts`                                                | runtime                   | migrated         | C1-C5             |
| v4 app examples         | schema 1 examples                          | `examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml` | example                   | migrated         | C5                |
| v4 skill guidance       | schema 1 skill guidance                    | `skills/sfo-deploy-cluster/references/app.md`                              | documentation             | migrated         | C5                |

## Validation Rationale

| Behavior or Risk                                           | Validation Signal            | Why This Is Sufficient                                      | Gap / Manual Reason                   |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| 只装载 App schema 1，configs 以 `kind` 分型且不声明 `name` | 装载正负例和旧 schema 拒收   | 覆盖合法形状、旧版本、未知字段、重复目标和脚本。            |                                       |
| system/script 服务互斥，工具可选 auto/systemctl/service    | 计划和 runtime 替身          | 覆盖服务归一、命令形状、失败语义和 Ubuntu/CentOS 工具路径。 | 真实发行版主机不可用，见 manual gap。 |
| 受管文件事务、脚本权限、秘密隔离和失败关闭                 | DV 文件发布、hook 失败和脱敏 | 伪会话验证顺序、恢复和输出边界。                            |                                       |
| 发布历史可解码、回滚可推导                                 | 历史单元与版本发布集成       | 覆盖新字段、旧快照、篡改拒绝和 rollback lineage。           |                                       |
| 破坏性公开类型不保留旧路径                                 | 编译正负例和符号扫描         | 编译器证明新路径可用、旧路径失败；扫描确认残留闭包。        |                                       |

## Direct Change Coverage

| change_id | design_source                                                                                               | validation_id | testplan_level | testplan_step_id | Gap? | Gap / Manual Reason         |
| --------- | ----------------------------------------------------------------------------------------------------------- | ------------- | -------------- | ---------------- | ---- | --------------------------- |
| CHG-001   | `design.md` File-Level Interfaces; `src/config.ts`, `src/planning.ts`, `src/execution.ts`, `src/history.ts` | VAL-CHG-001   | unit           | U1               | no   |                             |
| CHG-002   | `design.md` File-Level Interfaces and Key Flows; `src/service_management.ts`, `src/execution.ts`            | VAL-CHG-002   | dv             | D1               | no   | 真实发行版服务为 manual gap |
| CHG-003   | `design.md` Consumer Migration Closure; README, guide, skill, examples                                      | VAL-CHG-003   | unit           | U1               | no   |                             |

## Case-Type Coverage

| change_id | case_type     | required | validation_id | level       | status  | gap_manual_reason                                           |
| --------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------------------------------------------------- |
| CHG-001   | normal        | yes      | VAL-CHG-001   | unit        | covered |                                                             |
| CHG-001   | boundary      | yes      | VAL-CHG-001   | unit        | covered |                                                             |
| CHG-001   | negative      | yes      | VAL-CHG-001   | unit        | covered |                                                             |
| CHG-001   | error         | yes      | VAL-CHG-001   | unit        | covered |                                                             |
| CHG-001   | compatibility | yes      | C3            | unit        | covered | 旧 schema 拒收和历史快照读取在 unit 层覆盖                  |
| CHG-001   | lifecycle     | yes      | VAL-CHG-001   | dv          | covered |                                                             |
| CHG-001   | cross-module  | yes      | VAL-CHG-001   | integration | covered |                                                             |
| CHG-002   | normal        | yes      | VAL-CHG-002   | dv          | covered |                                                             |
| CHG-002   | boundary      | yes      | VAL-CHG-002   | unit        | covered |                                                             |
| CHG-002   | negative      | yes      | VAL-CHG-002   | unit        | covered |                                                             |
| CHG-002   | error         | yes      | VAL-CHG-002   | dv          | covered |                                                             |
| CHG-002   | compatibility | yes      | C1            | unit        | covered | 工具枚举与旧 schema 拒收在 unit/contract 覆盖               |
| CHG-002   | lifecycle     | yes      | VAL-CHG-002   | dv          | covered |                                                             |
| CHG-002   | cross-module  | yes      | VAL-CHG-002   | integration | covered |                                                             |
| CHG-003   | normal        | yes      | VAL-CHG-003   | unit        | covered |                                                             |
| CHG-003   | boundary      | yes      | C4            | unit        | covered | 文档/示例编译闭包在 contract 检查，运行层级由 unit 计划承载 |
| CHG-003   | negative      | yes      | C2            | unit        | covered | 移除旧类型由 contract 断言，运行层级由 unit 计划承载        |
| CHG-003   | error         | yes      | C2            | unit        | covered | 编译失败必须包含期望错误                                    |
| CHG-003   | compatibility | yes      | C3            | unit        | covered |                                                             |
| CHG-003   | lifecycle     | yes      | C5            | unit        | covered | 文档示例契约随 schema 生命周期更新                          |
| CHG-003   | cross-module  | yes      | C4            | unit        | covered |                                                             |

## Design Element Coverage

| element_type     | design_source                                      | derived_cases                                                                           | level | status         | gap_manual_reason                               |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- | ----- | -------------- | ----------------------------------------------- |
| parameter-domain | `design.md` File-Level Interfaces                  | `app_management_config` 的 kind、目标、格式、owner/mode、permissions、service tool 枚举 | unit  | covered        |                                                 |
| state-transition | `design.md` State and Ownership                    | stage/activate/restart、备份恢复、版本标记不写                                          | dv    | covered        |                                                 |
| failure-path     | `design.md` Key Flows                              | 脚本失败、hook 失败、服务失败、marker 失败、restore 失败                                | dv    | covered        |                                                 |
| error-handling   | loader/runtime 错误类别                            | 旧 schema、重复、冲突、路径越界、无效服务、超时/取消                                    | unit  | covered        |                                                 |
| invariant        | `design.md` Design Notes                           | 所有权唯一、schema 破坏性切换、秘密不内联、失败关闭                                     | unit  | covered        |                                                 |
| concurrency      | `design.md` State and Ownership 明确不新增持久状态 | no                                                                                      | unit  | not-applicable | 设计未引入并发/重入状态；历史锁仍由既有测试覆盖 |

## Module-Level Tests

| Test Item                          | Covered Boundary                     | Entry                    | Expected Result                            | Test Type | Test File/Script                            | Status  | Gap / Manual Reason |
| ---------------------------------- | ------------------------------------ | ------------------------ | ------------------------------------------ | --------- | -------------------------------------------- | ------- | ------------------- |
| schema 1 配置装载                   | 配置段类型、唯一性与所有权             | unit/App schema 1         | 合法声明归一，非法声明失败                    | unit      | tests/unit/app_management_config.test.ts      | covered |                     |
| system/script 服务                  | 服务管理互斥和工具选择                 | unit/service management   | 固定 argv 正确，失败显式暴露                  | unit      | tests/unit/service_management.test.ts         | covered | 真实主机不可用       |
| 配置发布与恢复                      | 受管候选、提交、备份和清理             | dv/app-management         | changed/unchanged 正确，失败恢复              | dv        | tests/dv/app_management_execution.test.ts     | covered |                     |
| 版本发布生命周期                    | stage/activate/restart/recovery       | dv/versioned-deploy-order | 顺序和补偿正确                                | dv        | tests/dv/versioned_deploy_order.test.ts       | covered |                     |
| 发布历史                            | 快照往返、完整性、回滚 lineage         | unit/history              | 新字段可读，篡改拒绝                          | unit      | tests/unit/history*.test.ts                   | covered |                     |

## External Interface Tests

| Interface                    | Responsibility                         | Success Cases                    | Failure/Edge Cases                          | Test Type | Test Doc/File                                    | Status  | Gap / Manual Reason |
| ---------------------------- | -------------------------------------- | -------------------------------- | -------------------------------------------- | --------- | -------------------------------------------------- | ------- | ------------------- |
| public module types          | schema 1 管理类型导出                    | external consumer 编译通过         | 旧 actions 路径编译失败                       | contract  | tests/contract/app_management_consumer.ts          | covered |                     |
| YAML App contract            | 文档、技能与示例一致性                   | schema 1 示例装载                  | 旧字段或缺失声明被拒收                         | contract  | tests/contract/verify_app_management_contract.ts    | covered |                     |
| versioned release transport  | 版本根路径、成员完整性和事务边界         | 普通发布成功                        | traversal、symlink、篡改失败                   | integration | tests/integration/versioned_*.test.ts             | covered |                     |

## Unit Tests

| Function or Unit   | Branch or Condition         | Covered Behavior                                              | Test File                                                          | Status  | Gap / Manual Reason |
| ------------------ | --------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ | ------- | ------------------- |
| `appSchemaVersion` | `!== 1`                     | App v2/v3/v4 明确拒收                                         | tests/unit/app_management_config.test.ts                           | covered |                     |
| `appConfigs`       | file/script branches        | file 归一、脚本调用、重复脚本拒收                             | tests/unit/app_management_config.test.ts                           | covered |                     |
| `appService`       | system/script branches      | systemd 与脚本管理归一、旧 service 限制                       | tests/unit/app_management_config.test.ts                           | covered |                     |
| `appManagement`    | ownership/conflict branches | config/configure、script/start-stop-restart、unit target 冲突 | tests/unit/app_management_config.test.ts                           | covered |                     |
| `buildPlan`        | config/service presence     | configure、stage/activate、restart、on-change 依赖            | tests/unit/config_planning.test.ts                                 | covered |                     |
| systemd converge   | enabled/daemon_reload/tool  | fixed argv、首次部署基线、失败状态、恢复、auto→service 回退      | tests/unit/service_management.test.ts                              | covered | 真实主机不可用       |
| history codec      | systemd/script branches     | configScripts、service 快照往返、旧快照兼容读取               | tests/unit/history.test.ts, tests/unit/history_regressions.test.ts | covered |                     |

未覆盖的已改动分支：无。基于 072
直接改动文件的条件分支逐项映射到上表；全仓库既有遗留分支不在本任务新增责任内。

## DV Tests

| Workflow                 | Kind      | Entry                     | Expected Result                      | Test File or Script                       | Status  | Gap / Manual Reason |
| ------------------------ | --------- | ------------------------- | ------------------------------------ | ----------------------------------------- | ------- | ------------------- |
| fetch + prepare + bundle | lifecycle | dv/app-management         | 只读 packageCache，单一 bundle       | tests/dv/app_management_execution.test.ts | covered |                     |
| 配置发布                 | main      | dv/app-management         | 批量候选发布，unchanged 正确提交     | tests/dv/app_management_execution.test.ts | covered |                     |
| hook 失败                | failure   | dv/app-management         | 恢复整批配置并记录 recovery          | tests/dv/app_management_execution.test.ts | covered |                     |
| activate 服务            | lifecycle | dv/app-management         | 发布 unit、daemon-reload/restart     | tests/dv/app_management_execution.test.ts | covered |                     |
| 版本部署顺序             | main      | dv/versioned-deploy-order | prepare barrier、切换、service、恢复 | tests/dv/versioned_deploy_order.test.ts   | covered |                     |

## Integration Tests

| Contract or Flow             | Modules Involved                     | Success Case                 | Failure Case                    | Test File                                              | Status  | Gap / Manual Reason |
| ---------------------------- | ------------------------------------ | ---------------------------- | ------------------------------- | ------------------------------------------------------ | ------- | ------------------- |
| versioned release            | planning/execution/transport/history | stage/activate/cleanup 成功  | marker 失败回滚、坏包拒收       | tests/integration/versioned_release.test.ts            | covered |                     |
| versioned transport boundary | transport/versioned release          | 正常 release resources 发布  | traversal/sibling/symlink 拒绝  | tests/integration/versioned_transport_boundary.test.ts | covered |                     |
| managed transport security   | execution/transport/runtime          | 固定 argv 和环境隔离         | flock、取消和恶意内层失败       | tests/integration/managed_transport_security.test.ts   | covered |                     |
| config fingerprint           | config/runtime                       | unchanged candidate 指纹一致 | 秘密/服务变化触发 serviceChange | tests/integration/config_fingerprint.test.ts           | covered |                     |

## Regression Focus

- 旧 App schema 必须在装载期拒绝，不能部分解码。
- `service` 工具不得执行 daemon-reload 或 enable。
- 脚本服务只由退出码表达结果，失败立即停止。
- 历史快照的新管理字段必须往返且旧快照仍可读取。

## Definition of Done

- [x] 三个 change_id 在 proposal、design、testing 与 testplan 中直接映射。
- [x] `testplan.yaml` 与 unified entry 一致，任务范围 only 072。
- [x] 新契约测试位于 `tests/`，未在 production source 中新增 inline tests。
- [x] Unit/DV/Integration 分别覆盖分支、主流程/失败流程和跨模块契约。
- [x] Breaking API、crate-root、文档示例契约检查齐备。
- [ ] 真实 Ubuntu/CentOS 主机服务行为：manual gap，本环境不可用。
