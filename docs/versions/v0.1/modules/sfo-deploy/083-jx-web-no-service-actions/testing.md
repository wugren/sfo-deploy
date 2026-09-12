---
task_manifest: task.yaml
status: approved
---

Risk profile: ./risk-profile.yaml

# Testing：Nginx 原生配置格式与 jx-web 站点发布

## Test Document Index

| Document | Topic | Scope |
| --- | --- | --- |
| testing.md | 单一测试文档 | nginx 格式契约、原文渲染、计划兼容、部署 reload 顺序和文档/集群一致性 |

## Submodule Tests

| Submodule | Responsibility | Detailed Test Doc | Required Behaviors | Edge/Failure Cases | Test Type | Test Files | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| App configuration loader | `format: nginx` 归一化 | testing.md | 原文格式装载；无秘密/变量；reload 映射 | `${...}`、variables、保留标记 | unit | tests/unit/app_management_config.test.ts | covered | |
| Config skeleton generator | 控制端原文骨架 | testing.md | UTF-8 原文、无 bindings、哈希稳定 | 残留 marker、变量 | unit | tests/unit/managed_config_generation.test.ts | covered | |
| plan history codec | 快照保存/恢复 format | testing.md | `nginx` 往返；旧快照仍可读 | 非法 format | unit | tests/unit/history.test.ts | covered | |
| versioned deploy executor | stage/activate/reload 顺序 | testing.md | 配置变化 reload 在 switch 后；不 start/restart | publish/switch/service 失败恢复 | dv | tests/dv/versioned_deploy_order.test.ts | covered | 真实主机验收为 manual gap |
| remote config updater | 远端候选渲染 | testing.md | nginx 原样生成候选；拒绝 bindings | 残留 marker、占位符 | integration | tests/integration/config_updater.test.ts | covered | |
| Multipass cluster config | jx-web 承载 server 片段 | testing.md | validate/plan 可装载，目标和服务正确 | 集群漂移 | integration | task plan I2 | covered | |
| configuration contract docs | README/指南/技能与示例一致 | testing.md | nginx 格式和 latest 根可见 | 文档漂移 | contract | tests/contract/verify_app_management_contract.ts | covered | |

## Unified Test Entry

- Machine-readable task plan:
  `docs/versions/v0.1/modules/sfo-deploy/083-jx-web-no-service-actions/testplan.yaml`
- Task all:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/083-jx-web-no-service-actions all`
- Single-task boundary: 不运行 package/module 作用域、`all all`、根快捷方式或 quality gates。
- Registration: 新增/修改的 unit、DV、integration 测试和 contract step 均登记在 `testplan.yaml`。

## Module-Level Tests

| Test Item | Covered Boundary | Entry | Expected Result | Test Type | Test File/Script | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nginx config loader | raw text 与禁止绑定 | unit / config loader | format/onChange 正确，秘密和变量失败 | unit | tests/unit/app_management_config.test.ts | covered | |
| raw skeleton | 原文保持和哈希 | unit / config generation | 原文稳定，bindings 为空 | unit | tests/unit/managed_config_generation.test.ts | covered | |
| plan snapshot | 新格式与旧快照 | unit / history codec | `nginx` 往返，旧快照兼容 | unit | tests/unit/history.test.ts | covered | |
| deploy ordering | switch/reload/no start/stop | dv / versioned executor | switch 后 reload，无启停 | dv | tests/dv/versioned_deploy_order.test.ts | covered | |
| remote renderer | nginx candidate | integration / config updater | 原文候选，mode 0600 | integration | tests/integration/config_updater.test.ts | covered | |
| example cluster | validate/plan | integration / CLI | jx-web config/service 正确装载 | integration | task plan I2 | covered | |
| documentation contract | 用户契约 | contract / documentation examples | README、指南、技能、示例一致 | contract | tests/contract/verify_app_management_contract.ts | covered | |

## External Interface Tests

| Interface | Responsibility | Success Cases | Failure/Edge Cases | Test Type | Test Doc/File | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `format: nginx` | Nginx 原生片段受管发布 | UTF-8 原文装载/渲染 | `${...}`、`__SFO_`、variables 拒绝 | unit/integration | U1/U2/I1 | covered | |
| versioned managed config | stage 发布，activate reload | 配置变化后 switch → reload | 发布/切换/服务失败恢复 | dv | D1 | covered | |
| nginx.service 管理外壳 | 静态站点不启停 | enabled 缺省，on_deploy none | 无配置变化不执行服务动作 | dv | D1 | covered | |
| Multipass cluster plan | `/etc/nginx/conf.d/jx-web.conf` | validate 和 plan 通过 | 集群配置漂移失败 | integration | I2 | covered | |
| real Nginx runtime | `nginx -t`、页面、API | 部署后 HTTP 可访问 | 语法/代理错误失败 | acceptance | manual | 真实部署在验收阶段执行。 |

## Validation Rationale

| Behavior or Risk | Validation Signal | Why This Is Sufficient | Gap / Manual Reason |
| --- | --- | --- | --- |
| Nginx 原文不被结构化 parser 改写 | raw skeleton/updater 哈希与内容 | 控制端和目标端分别保留原文。 | |
| 文本格式不引入秘密注入面 | loader 和 updater 拒绝 `${...}`/marker | 两侧失败关闭，不把无结构文本当作安全解析边界。 | |
| jx-web 不启停自身服务 | DV 服务事件 | enabled 缺省、on_deploy none、无配置变化动作 none。 | |
| 配置变化后才生效 | switch/reload 顺序 | DV 验证 switch 后 reload；失败由既有补偿。 | |
| 集群可发布 | validate/plan | YAML 装载、目标、服务和计划在本地通过。 | |
| Nginx 语法与实际访问 | 真实 `nginx -t`/HTTP | 本地不解析 DSL，必须由目标环境验证。 | manual gap：验收阶段执行。 |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | Gap? | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-jx-web-nginx-server-config | `design.md` File-Level Interfaces, Key Flows, API and Build Surface Impact | U1-U3/D1/I1-I2/C1-C3 | unit | U1 | no | 表格限制每个 change_id 一行；完整映射见 `testplan.yaml`。 |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-jx-web-nginx-server-config | normal | yes | U1/I2 | unit | covered | |
| CHG-jx-web-nginx-server-config | boundary | yes | U2 | unit | covered | |
| CHG-jx-web-nginx-server-config | negative | yes | U1/I1 | unit | covered | |
| CHG-jx-web-nginx-server-config | error | yes | U1/I1 | unit | covered | |
| CHG-jx-web-nginx-server-config | compatibility | yes | U3/C1 | unit | covered | |
| CHG-jx-web-nginx-server-config | lifecycle | yes | D1 | dv | covered | |
| CHG-jx-web-nginx-server-config | cross-module | yes | C2 | unit | covered | |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | `design.md` File-Level Interfaces | `nginx`、既有四格式、空/非空原文、非法变量 | unit | covered | |
| state-transition | `design.md` State and Ownership | skeleton → candidate → 发布 → reload | dv | covered | |
| failure-path | `design.md` Key Flows | candidate 生成失败、发布/切换/服务失败 | dv | covered | |
| error-handling | `design.md` Design Notes | `${...}`、保留 marker、variables 拒绝 | unit | covered | |
| invariant | `design.md` Overall Approach | 原文保留；switch 后 reload；不 start/stop | dv | covered | |
| concurrency | `design.md` State and Ownership | 不新增共享可变状态 | unit | not-applicable | 设计未引入并发、重入或共享可变状态。 |

## Unit Tests

| Function or Unit | Branch or Condition | Covered Behavior | Test File | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- |
| `managedSecretReferences` | nginx | 文本边界检查并返回空秘密引用 | tests/unit/app_management_config.test.ts | covered | |
| `managedConfigFiles` | variables + nginx | 声明 variables 失败关闭 | tests/unit/app_management_config.test.ts | covered | |
| `validateManagedPlainText` | `${...}`/marker | 任意占位符和保留标记失败 | tests/unit/managed_config_generation.test.ts | covered | |
| `generateConfigSkeleton` | nginx | UTF-8 原文、空 bindings、哈希稳定 | tests/unit/managed_config_generation.test.ts | covered | |
| plan v4 codec | nginx format | 编码与解码往返 | tests/unit/history.test.ts | covered | |
| 旧计划快照 | 无 nginx | 既有四格式/旧 schema 可读 | tests/unit/history.test.ts | covered | |

未覆盖的已改动分支：无。`nginx` 与既有结构化格式的分叉通过 U1/U2/I1 的成功和失败用例覆盖；
旧快照兼容由 U3 的既有 history 测试继续覆盖。

## DV Tests

| Workflow | Kind | Entry | Expected Result | Test File or Script | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| nginx reload deploy | lifecycle | `dv/083` | 配置变化时 switch 后 `reload nginx.service` | tests/dv/versioned_deploy_order.test.ts | covered | |
| static versioned app | lifecycle | `dv/069: static` | 不 start/restart 服务 | tests/dv/versioned_deploy_order.test.ts | covered | |
| nginx raw config deploy | main | `dv/083` | 原文配置候选写入受管目标 | tests/dv/versioned_deploy_order.test.ts | covered | |
| publication failure | failure | `dv/069` fault fixtures | 不切换 latest，恢复配置和服务 | tests/dv/versioned_deploy_order.test.ts | covered | |
| real Multipass deploy | lifecycle | not applicable | `nginx -t`、latest、页面、API | none | manual | 验收阶段执行真实部署。 |

## Integration Tests

| Contract or Flow | Modules Involved | Success Case | Failure Case | Test File | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| remote config updater | loader/bundle/updater | nginx 原文候选 | bindings/marker/占位符拒绝 | tests/integration/config_updater.test.ts | covered | |
| Multipass cluster CLI | cluster config/CLI | validate 通过并显示 2 个 App | 集群漂移失败 | task plan I2 | covered | |
| compile closure | exported types/consumers | `deno task check` 通过 | 类型漂移编译失败 | contract C1 | covered | |
| remote bundle sync | updater/bundle | 重新 bundle 后无 diff | 产物漂移失败 | contract C3 | covered | |

## Definition of Done

- [x] `CHG-jx-web-nginx-server-config` 在 proposal、design、testing 和 `testplan.yaml` 中直接映射。
- [x] 新增/修改测试可通过 task-scoped unified entrypoint 执行。
- [x] Nginx 格式、原文渲染、安全边界、快照兼容、reload 顺序和集群契约均有直接验证。
- [x] 真实 Multipass 部署行为记录为验收阶段动作，不作为本测试计划通过证据。
