---
task_manifest: task.yaml
status: approved
---

# App 安装目录变量测试

Risk profile: ./risk-profile.yaml

## Test Document Index

本任务没有独立子模块；本文档覆盖 config loader、planning/executor 和 transport 的变更契约。

## Unified Test Entry

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/070-app-install-directory-variable all
```

该命令只执行本任务 testplan 声明的契约、unit、DV 和 integration 步骤，不运行全仓库维护套件。

## Submodule Tests

not-applicable: 本任务不拆分独立产品子模块，装载、计划执行与传输契约在模块级验证。

## Module-Level Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| 变量装载 | config | task all C1/U1 | 绝对路径兼容、变量展开为 latest 选择器、非法输入本地拒绝 | tests/unit/app_management_config.test.ts | covered | |

## External Interface Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| managed config 目标契约 | config, planning, execution, transport | 变量目标经 loader 归一，内置 deploy 映射到候选版本 | 缺 install_directory、路径穿越或非前缀变量拒绝 | tests/unit/app_management_config.test.ts, tests/dv/versioned_deploy_order.test.ts, tests/integration/versioned_transport_boundary.test.ts | covered | |
| 文档示例契约 | docs, config | 文档描述与实现契约一致 | 文档缺关键边界时检查失败 | tests/contract/verify_app_management_contract.ts | covered | |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | gap | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-install-directory-variable | design.md | VAL-070-INSTALL-DIRECTORY | unit | U1 | no | |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-install-directory-variable | normal | yes | VAL-070-INSTALL-DIRECTORY | unit | covered | |
| CHG-install-directory-variable | boundary | yes | VAL-070-INSTALL-DIRECTORY | unit | covered | |
| CHG-install-directory-variable | negative | yes | VAL-070-INSTALL-DIRECTORY | unit | covered | |
| CHG-install-directory-variable | error | yes | VAL-070-INSTALL-DIRECTORY | integration | covered | |
| CHG-install-directory-variable | compatibility | yes | VAL-070-INSTALL-DIRECTORY | unit | covered | |
| CHG-install-directory-variable | lifecycle | yes | VAL-070-INSTALL-DIRECTORY | dv | covered | |
| CHG-install-directory-variable | cross-module | yes | VAL-070-INSTALL-DIRECTORY | integration | covered | |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | design.md Overall Approach | 绝对路径、合法变量、空片段、双斜杠、`.`、`..`、反斜杠、重复变量、缺 install_directory | unit | covered | |
| state-transition | design.md State and Ownership | latest 选择器到候选版本、configure 写当前版本 | dv | covered | |
| failure-path | design.md Key Flows | 发布根/父目录校验失败不越过版本根 | integration | covered | |
| error-handling | design.md Risks and Rollback | 缺声明、路径逃逸、重复展开、类型检查失败 | unit | covered | |
| invariant | design.md Overall Approach | 绝对 target 不被变量逻辑重解释，合法变量目标归一到发布根选择器 | unit | covered | |
| concurrency | design.md State and Ownership | 本任务未新增并发路径；沿用既有串行部署事务 | not-applicable | not-applicable | 未新增并发状态，既有 DV 已覆盖串行部署顺序 |

## Validation Rationale

unit 直接暴露 `managedConfigTarget` 的每个新增分支；DV 证明该选择器在内置 deploy 中仍按 069 顺序映射到真实版本并在 configure 时写当前版本；integration 验证真实发布根路径边界和恢复语义。契约步骤锁定编译闭包与文档示例。

## Unit Tests

| function_or_unit | branch_or_condition | covered_behavior | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| managedConfigTarget | 无变量 | 绝对路径保持既有校验与取值 | tests/unit/app_management_config.test.ts | covered | |
| managedConfigTarget | 合法前缀 | 展开为 `<install>/latest/<relative>` 并进入计划 | tests/unit/app_management_config.test.ts | covered | |
| managedConfigTarget | 变量不在前缀 | 拒绝非开头的变量引用 | tests/unit/app_management_config.test.ts | covered | |
| managedConfigTarget | 多次变量 | 拒绝重复变量引用 | tests/unit/app_management_config.test.ts | covered | |
| managedConfigTarget | 缺少 install_directory | packageless App 使用变量时本地失败 | tests/unit/app_management_config.test.ts | covered | |
| managedConfigTarget | 空/`/`/`//`/`.`/`..`/反斜杠/尾斜杠片段 | 全部按规范相对路径失败关闭 | tests/unit/app_management_config.test.ts | covered | |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| 内置 stage 到 activate 主流程 | main | task all D1 | 全部准备成功后按序切换并立即服务动作 | tests/dv/versioned_deploy_order.test.ts | covered | |
| 发布/服务/标记失败 | failure | task all D1 | 不留下新版本激活状态，恢复旧 latest 与配置 | tests/dv/versioned_deploy_order.test.ts | covered | |
| stage 准备和 activate 切换 | lifecycle | task all D1 | 配置先写入候选版本，切换后立刻服务动作，失败可恢复 | tests/dv/versioned_deploy_order.test.ts | covered | |
| explicit configure | config | task all D1 | 无切换时写当前 latest 目标版本 | tests/dv/versioned_deploy_order.test.ts | covered | |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| release target containment | planning, execution, transport, versioned release | release resources 内目标接受发布 | 穿越兄弟目录、release/resources 软链逃逸拒绝 | tests/integration/versioned_transport_boundary.test.ts | covered | |
| managed config transaction | execution, transport, secret loader | 发布、恢复和候选状态一致 | 发布/恢复失败返回可恢复事务 | tests/integration/managed_transport_security.test.ts, tests/integration/versioned_transport_boundary.test.ts | covered | |

## Definition of Done

- 任务统一入口 `all` 成功，并生成机器可读运行工件。
- 每个新增分支都有断言或明确理由。
- 未执行真实 SSH、Multipass、systemd 或业务服务部署；真实制品启动仍需外部环境验证。
