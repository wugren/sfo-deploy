---
task_manifest: task.yaml
status: approved
---

# App management.kind 配置契约测试

Risk profile: ./risk-profile.yaml

## Test Document Index

本任务不拆分独立产品子模块；本文档覆盖 App schema 1 装载、计划、执行、历史快照、文档示例与仓库消费者闭包。

## Unified Test Entry

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/076-remove-app-scripts-node all
```

该命令只执行本任务 testplan 声明的 contract、unit、DV 和 integration 步骤，不运行全仓库维护套件。

## Submodule Tests

not-applicable: 本任务不拆分独立产品子模块；配置装载、计划执行、历史与传输契约在模块级验证。

## Module-Level Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| management.kind 分派 | config | task all U1 | script 和 service 归一为 `manager`；旧包装与顶层 scripts 拒收 | tests/unit/app_management_config.test.ts | covered | |
| App package 归属 | planning | task all U3 | App stage 携带 App package；activate/restart 不携带 | tests/unit/config_planning.test.ts | covered | |
| 历史快照 | history | task all U2 | manager 往返一致，旧 service/hooks 快照不再构成合法输入 | tests/unit/history.test.ts, tests/unit/history_regressions.test.ts | covered | |

## External Interface Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| App management 契约 | config, planning, execution | script/service 管理器生成正确步骤 | 顶层 scripts、旧 service 包装或非法字段拒绝 | tests/unit/app_management_config.test.ts, tests/integration/env_prepare_cli.test.ts | covered | |
| versioned release | planning, execution, transport, versioned release | stage 全局准备后 activate，script manager restart 不重复也不遗漏 | 发布/切换/服务失败可恢复 | tests/dv/versioned_deploy_order.test.ts | covered | |
| 文档与示例 | docs, examples, config | 文档示例仅使用 configs/management.kind | 顶层 scripts 或旧 kind 出现在示例时失败 | tests/contract/verify_app_management_contract.ts | covered | |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | gap | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-remove-app-scripts-node | design.md | VAL-076-MANAGEMENT-KIND | unit | U1 | no | |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-remove-app-scripts-node | normal | yes | VAL-076-MANAGEMENT-KIND | unit | covered | |
| CHG-remove-app-scripts-node | boundary | yes | VAL-076-MANAGEMENT-KIND | unit | covered | |
| CHG-remove-app-scripts-node | negative | yes | VAL-076-MANAGEMENT-KIND | unit | covered | |
| CHG-remove-app-scripts-node | error | yes | VAL-076-MANAGEMENT-KIND | integration | covered | |
| CHG-remove-app-scripts-node | compatibility | yes | VAL-076-MANAGEMENT-KIND | unit | covered | |
| CHG-remove-app-scripts-node | lifecycle | yes | VAL-076-MANAGEMENT-KIND | dv | covered | |
| CHG-remove-app-scripts-node | cross-module | yes | VAL-076-MANAGEMENT-KIND | integration | covered | |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | design.md Design Scope | `kind: script`、`kind: service`、旧 `service` 包装、顶层 scripts、缺 run_as/manager | unit | covered | |
| state-transition | design.md State and Ownership | service manager stage→activate；script manager configure→stage→activate→restart | dv | covered | |
| failure-path | design.md Key Flows | 发布、切换、配置或脚本动作失败时保留既有恢复语义 | dv | covered | |
| error-handling | design.md Risks and Rollback | 旧 schema、旧包装、重复目标、非法 kind、缺 run_as 失败关闭 | unit | covered | |
| invariant | design.md Overall Approach | 顶层 `scripts` 消失；内部只消费 `management.manager`；App package 归属不变 | unit | covered | |
| concurrency | design.md State and Ownership | 本任务未新增并发路径；沿用既有 App/目标操作锁 | not-applicable | not-applicable | 既有 operation lock 测试覆盖串行语义，本任务未修改锁算法 |

## Validation Rationale

unit 暴露管理器分派、旧契约拒收、历史归一和 App package 归属；DV 证明 script/service
管理器的完整部署顺序与失败恢复；integration 覆盖跨模块 CLI、placement 和 fetch 契约。
breaking API 通过新类型正例、旧类型负例、removed-symbol scan 和仓库编译闭包锁定。

## Unit Tests

| function_or_unit | branch_or_condition | covered_behavior | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| appManagement | `kind: script` | start/stop/restart 归一为 `AppScriptManagement` | tests/unit/app_management_config.test.ts | covered | |
| appManagement | `kind: service` | name/tool/unit_config 归一为 `AppServiceManagement` | tests/unit/app_management_config.test.ts | covered | |
| rejectTopLevelAppScripts | 顶层 scripts | 装载前定向拒收 | tests/unit/app_management_config.test.ts | covered | |
| loadApps | packageless | 不生成 check，只生成受管 configure | tests/unit/config_planning.test.ts | covered | |
| decodeManagement | manager 空值/分支 | 历史快照使用 `manager` 归一形状 | tests/unit/history.test.ts | covered | |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| App 生命周期执行 | main | task all D1 | config/script/service 步骤成功 | tests/dv/app_management_execution.test.ts | covered | |
| versioned 发布失败恢复 | failure | task all D2 | 发布/切换/服务失败时恢复既有状态 | tests/dv/versioned_deploy_order.test.ts | covered | |
| versioned deploy 顺序 | lifecycle | task all D2 | stage 全局屏障、activate 原子切换、script manager restart 执行 | tests/dv/versioned_deploy_order.test.ts | covered | |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| lifecycle control attempt | CLI, history, execution, transport | start/deploy/rollback 记录完整 attempt | 缺 managed 原语时失败关闭 | tests/integration/env_prepare_cli.test.ts | covered | |
| placement 与 versioned 计划 | config, planning, history | configure/deploy 依赖顺序与旧快照回退一致 | 过滤器排除了必需依赖时失败 | tests/integration/environment_placement.test.ts | covered | |
| package cache | config, planning, package cache | fetch 跳过 packageless；deploy 缺缓存预检失败 | package 不可用时零副作用 | tests/integration/fetch_package.test.ts | covered | |

## Definition of Done

- 任务统一入口 `all` 成功，并生成机器可读运行工件。
- breaking API 的 external positive/negative、removed-symbol scan、compile closure 和文档契约均通过。
- 未执行真实 SSH、Multipass、systemd 或业务服务部署；真实节点行为仍需外部验收。
