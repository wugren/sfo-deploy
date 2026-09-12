---
task_manifest: task.yaml
status: approved
---

Risk profile: ./risk-profile.yaml

# Testing：App 配置目录变量

## Test Document Index

| Document | Topic | Scope |
| --- | --- | --- |
| testing.md | 单一测试文档 | 变量装载、计划快照、deploy/configure 目标重定位、文档与示例契约 |

## Submodule Tests

| Submodule | Responsibility | Detailed Test Doc | Required Behaviors | Edge/Failure Cases | Test Type | Test Files | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| App configuration loader | YAML target 变量归一为 targetRoot | testing.md | 三个前缀变量展开正确；缺声明/非法相对路径失败 | 多变量、无斜杠变量、`.`/`..`、缺 install_directory | unit | tests/unit/app_management_config.test.ts | covered | |
| plan history codec | 计划快照保存/恢复 targetRoot | testing.md | 新字段完整往返；旧快照缺省 absolute | 旧快照、非法枚举 | unit | tests/unit/history.test.ts | covered | |
| versioned deploy executor | deploy 时按 targetRoot 决定重定位 | testing.md | current 重定位；latest/install 不重定位 | 发布失败、配置路径边界 | dv | tests/dv/versioned_deploy_order.test.ts | covered | 真实远端部署为 manual gap |
| versioned remote runtime | 示例契约与远端脚本边界 | testing.md | Multipass 示例保持 builtin 布局 | 制品、路径、marker 失败 | integration | tests/integration/versioned_release.test.ts | covered | 不执行真实 SSH |
| managed config renderer | 既有渲染器接受新内部类型 | testing.md | 四格式渲染/秘密注入不变 | 缺席秘密、无效候选 | integration | tests/integration/config_updater.test.ts | covered | |
| configuration contract docs | README/指南/技能与示例一致 | testing.md | 三个变量语义可见且迁移说明明确 | 变量缺失或漂移 | contract | tests/contract/verify_app_management_contract.ts | covered | |

## Unified Test Entry

- Machine-readable task plan:
  `docs/versions/v0.1/modules/sfo-deploy/082-app-directory-variables/testplan.yaml`
- Task all:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/082-app-directory-variables all`
- Single-task boundary: 不运行 package/module 作用域、`all all`、根快捷方式或 quality gates。
- Registration: 新增/修改的 unit、DV、integration 测试和四个风险触发 contract step 都在
  `testplan.yaml` 中登记。

## Module-Level Tests

| Test Item | Covered Boundary | Entry | Expected Result | Test Type | Test File/Script | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| directory variable loader | 前缀、相对路径、install_directory | unit / config loader | current/latest 展开为 latest，install 展开为安装根 | unit | tests/unit/app_management_config.test.ts | covered | |
| targetRoot snapshot | 编码/解码与旧快照 | unit / history codec | `current` 往返；旧快照缺省 `absolute` | unit | tests/unit/history.test.ts | covered | |
| versioned deployment | current/latest/install target | dv / deploy executor | current 写候选版本；latest 写软链；install 写安装根 | dv | tests/dv/versioned_deploy_order.test.ts | covered | |
| example/runtime contract | 示例配置与远端脚本 | integration / versioned release | Multipass 示例通过 builtin 契约 | integration | tests/integration/versioned_release.test.ts | covered | |
| documentation contract | README/指南变量语义 | contract / documentation examples | 三个变量和迁移语义可发现 | contract | tests/contract/verify_app_management_contract.ts | covered | |

## External Interface Tests

| Interface | Responsibility | Success Cases | Failure/Edge Cases | Test Type | Test Doc/File | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| managed config target | 内置目录变量声明 | install/current/latest 正确装载 | 多变量、缺斜杠、非法相对路径、缺声明 | unit | tests/unit/app_management_config.test.ts | covered | |
| plan snapshot `target_root` | 保存部署重定位语义 | current 可往返；旧快照兼容 | 非法枚举拒收 | unit | tests/unit/history.test.ts | covered | |
| versioned deploy target | deploy/configure 目标选择 | current 候选重定位 | install/latest 不被误重定位 | dv | tests/dv/versioned_deploy_order.test.ts | covered | |
| configuration documentation | 用户迁移说明 | 新旧语义差异可见 | 文档漂移失败 | contract | tests/contract/verify_app_management_contract.ts | covered | |

## Validation Rationale

| Behavior or Risk | Validation Signal | Why This Is Sufficient | Gap / Manual Reason |
| --- | --- | --- | --- |
| `INSTALL_DIRECTORY` 精确表示安装根 | 装载结果断言 | 展开/类型/重复路径检查在同一 loader 边界验证。 | |
| current 与 latest 可区分 | targetRoot + DV | 装载展开值相同，快照保留语义后执行器分别重定位/保持。 | |
| 旧计划可读 | codec 缺省测试 | 旧快照缺 `target_root` 时读取为 `absolute`。 | |
| 非法配置不触达远端 | loader 失败路径 | 多变量、缺声明和非法路径在本地计划前失败。 | |
| 文档不误导用户 | contract 断言 | README/指南绑定三个变量和 breaking 迁移说明。 | |
| 真实远端主机行为 | 不执行 SSH | 本地执行器仍验证路径选择与发布顺序。 | manual gap：没有真实 Linux 主机部署验证。 |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | Gap? | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-app-directory-variable-contract | `design.md` File-Level Interfaces, Key Flows, API and Build Surface Impact | U1/D1/I1/C1-C4 | unit | U1 | no | 表格限制每个 change_id 一行；完整步骤映射见 `testplan.yaml` 与上方分层测试表。 |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-app-directory-variable-contract | normal | yes | U1 | unit | covered | |
| CHG-app-directory-variable-contract | boundary | yes | U1 | unit | covered | |
| CHG-app-directory-variable-contract | negative | yes | U1 | unit | covered | |
| CHG-app-directory-variable-contract | error | yes | U1 | unit | covered | |
| CHG-app-directory-variable-contract | compatibility | yes | U2 | unit | covered | |
| CHG-app-directory-variable-contract | lifecycle | yes | D1 | dv | covered | |
| CHG-app-directory-variable-contract | cross-module | yes | C3 | unit | covered | |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | `design.md` File-Level Interfaces | 三个变量、裸变量、多次变量、`.`/`..`、缺声明 | unit | covered | |
| state-transition | `design.md` State and Ownership | absolute 默认、install/current/latest 显式目标根 | unit | covered | |
| failure-path | `design.md` Key Flows | 装载失败、发布/恢复既有失败路径 | dv | covered | |
| error-handling | `design.md` Design Notes | 非法枚举、非法路径、无效候选 | unit | covered | |
| invariant | `design.md` Overall Approach | 绝对 latest 兼容重定位；install/latest 不重定位 | dv | covered | |
| concurrency | `design.md` State and Ownership 明确不新增共享可变状态 | no | unit | not-applicable | 设计未引入并发、重入或共享可变状态。 |

## Unit Tests

| Function or Unit | Branch or Condition | Covered Behavior | Test File | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- |
| `managedConfigTarget` | no variable | 绝对路径返回 `absolute` | tests/unit/app_management_config.test.ts | covered | |
| `managedConfigTarget` | install/current/latest | 三种目标根展开为正确绝对路径 | tests/unit/app_management_config.test.ts | covered | |
| `managedConfigTarget` | multiple variables | 多个变量失败关闭 | tests/unit/app_management_config.test.ts | covered | |
| `managedConfigTarget` | missing install_directory | 变量声明但缺安装目录失败 | tests/unit/app_management_config.test.ts | covered | |
| `encodeManagement` / `decodeManagement` | optional target_root | 新字段往返；旧快照缺省 absolute | tests/unit/history.test.ts | covered | |

未覆盖的已改动分支：无。`targetRoot` 的四个枚举值分别由 absolute/default 快照、install DV、
current DV 与 latest DV 覆盖。

## DV Tests

| Workflow | Kind | Entry | Expected Result | Test File or Script | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| versioned deploy preparation | lifecycle | `dv/069` variants | 所有目标先发布配置/unit，再切换 latest | tests/dv/versioned_deploy_order.test.ts | covered | |
| current target deploy | main | `dv/082: current` 既有 targetRoot current fixture | 写候选版本并设置 releaseRoot | tests/dv/versioned_deploy_order.test.ts | covered | |
| latest target deploy | main | `dv/082: latest target` | 写 latest 当前指向，不改候选 | tests/dv/versioned_deploy_order.test.ts | covered | |
| install root target deploy | main | `dv/082: install root` | 写安装根，不误重定位 | tests/dv/versioned_deploy_order.test.ts | covered | |
| publication failure | failure | fault fixture | 不切换 latest 并恢复配置 | tests/dv/versioned_deploy_order.test.ts | covered | |
| remote host deploy | lifecycle | not applicable | 实际 SSH/latest/服务验证 | none | manual | 本任务不执行真实远端部署。 |

## Integration Tests

| Contract or Flow | Modules Involved | Success Case | Failure Case | Test File | Status | Gap / Manual Reason |
| --- | --- | --- | --- | --- | --- | --- |
| Multipass app/runtime contract | loader/docs/versioned runtime | 示例和 builtin 布局可读 | 示例/运行时漂移失败 | tests/integration/versioned_release.test.ts | covered | |
| managed renderer compatibility | loader/history/config updater | 新类型可生成/注入/复解析 | 缺秘密、残留 marker、无效候选失败 | tests/integration/config_updater.test.ts | covered | |
| compile closure | exported types/consumers | 仓库 Deno 检查通过 | 类型漂移导致编译失败 | contract C3 | covered | |

## Definition of Done

- [x] `CHG-app-directory-variable-contract` 在 proposal、design、testing 和 `testplan.yaml` 中直接映射。
- [x] 新增/修改测试可通过 task-scoped unified entrypoint 执行。
- [x] 三类变量、快照兼容、deploy 重定位、路径失败路径和文档契约均有直接验证。
- [x] 真实远端部署行为记录为 manual gap，不作为本任务通过证据。
