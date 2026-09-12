---
task_manifest: task.yaml
status: approved
---

# multipass App 配置与安装目录绑定测试

Risk profile: ./risk-profile.yaml

## Test Document Index

本任务不拆分独立子模块；本文档覆盖 schema 1 配置装载、版本化发布路径、传输边界、
集群秘密引用和实际 multipass 集群计划。

## Unified Test Entry

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/075-sync-multipass-app-config all
```

该命令只执行本任务 testplan 声明的契约、unit、DV 和 integration 步骤，不运行全仓库维护套件。

## Submodule Tests

not-applicable: 本任务不拆分独立产品子模块；修改集中在配置装载的参数绑定与示例集群配置。

## Module-Level Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| schema 1 安装目录变量装载 | config | task all U1 | 合法变量展开为 `<install>/latest/<relative>`；缺 install_directory 失败关闭 | tests/unit/app_management_config.test.ts | covered | |
| 版本化配置发布 | lifecycle | task all D1/I1 | 配置写入候选版本并在切换后服务；失败可恢复且路径不逃逸 | tests/dv/versioned_deploy_order.test.ts, tests/integration/versioned_transport_boundary.test.ts | covered | |
| multipass 配置装载与计划 | config | task all I2/I3 | 三个 App 通过 validate；deploy 计划包含 stage/activate/check/configure | tests/testplan inline CLI steps | covered | |

## External Interface Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| managed config 目标契约 | config, planning, versioned release, transport | schema 1 变量目标装载到 latest 选择器，部署映射到候选版本 | 缺 install_directory、路径穿越或符号链接逃逸失败 | tests/unit/app_management_config.test.ts, tests/dv/versioned_deploy_order.test.ts, tests/integration/versioned_transport_boundary.test.ts | covered | |
| managed 配置事务 | execution, transport, secret loader | 配置发布、恢复与候选状态一致 | 发布/恢复失败返回可恢复事务 | tests/integration/managed_transport_security.test.ts, tests/integration/versioned_transport_boundary.test.ts | covered | |
| cluster secret reference | cluster config, managed config | `${ELEPH_REDIS_PASSWORD}` 已在 cluster secrets 声明且配置解析通过 | 未声明秘密会本地拒绝 | tests/testplan inline CLI validate step | covered | |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | gap | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-sync-multipass-app-config | design.md | VAL-075-APP-CONFIG-SYNC | unit | U1 | no | |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-sync-multipass-app-config | normal | yes | VAL-075-APP-CONFIG-SYNC | unit | covered | |
| CHG-sync-multipass-app-config | boundary | yes | VAL-075-APP-CONFIG-SYNC | unit | covered | |
| CHG-sync-multipass-app-config | negative | yes | VAL-075-APP-CONFIG-SYNC | unit | covered | |
| CHG-sync-multipass-app-config | error | yes | VAL-075-APP-CONFIG-SYNC | integration | covered | |
| CHG-sync-multipass-app-config | compatibility | yes | VAL-075-APP-CONFIG-SYNC | dv | covered | |
| CHG-sync-multipass-app-config | lifecycle | yes | VAL-075-APP-CONFIG-SYNC | dv | covered | |
| CHG-sync-multipass-app-config | cross-module | yes | VAL-075-APP-CONFIG-SYNC | integration | covered | |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | design.md Overall Approach | 合法变量目标、缺 install_directory、旧绝对路径兼容输入 | unit | covered | |
| state-transition | design.md State and Ownership | latest 选择器到候选版本、configure 写当前版本 | dv | covered | |
| failure-path | design.md Key Flows | 发布根/父目录校验失败，配置发布恢复失败 | integration | covered | |
| error-handling | design.md Risks and Rollback | 缺声明、路径逃逸、配置格式错误 | unit | covered | |
| error-handling | design.md Risks and Rollback | 未声明秘密、发布路径逃逸、事务恢复失败 | integration | covered | |
| invariant | design.md Overall Approach | 变量仅在装载期展开 | unit | covered | |
| invariant | design.md Overall Approach | 归一目标仍受发布根与父目录路径校验 | integration | covered | |
| concurrency | design.md State and Ownership | 本任务未新增并发路径；版本化事务沿用既有串行发布语义 | not-applicable | not-applicable | 未新增并发状态，既有 DV/I1 覆盖串行发布与恢复顺序 |

## Validation Rationale

unit 直接验证 schema 1 顶层配置现在能接收并转发 `install_directory`；DV 验证 latest 选择器
在内置部署中的既有映射和失败恢复；integration 验证发布根路径边界、受管配置事务和实际
multipass 配置的计划生成。`deno task check` 锁定仓库编译闭包。

## Unit Tests

| function_or_unit | branch_or_condition | covered_behavior | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| appConfigs -> managedConfigFiles | 参数转发 | schema 1 顶层 configs 使用已解析 install_directory | tests/unit/app_management_config.test.ts | covered | |
| managedConfigTarget | 合法前缀变量 | 展开为 `<install>/latest/<relative>` | tests/unit/app_management_config.test.ts | covered | |
| managedConfigTarget | 缺少 install_directory | 本地失败并指明配置 target | tests/unit/app_management_config.test.ts | covered | |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| 内置 stage 到 activate 主流程 | main | task all D1 | 所有目标准备成功后按依赖顺序激活并立即服务动作 | tests/dv/versioned_deploy_order.test.ts | covered | |
| 内置 stage 到 activate | lifecycle | task all D1 | 配置先入候选版本，全部准备成功后切换并立即服务动作 | tests/dv/versioned_deploy_order.test.ts | covered | |
| 发布/服务/标记失败 | failure | task all D1 | 不留下新版本激活状态，恢复旧 latest 与配置 | tests/dv/versioned_deploy_order.test.ts | covered | |
| explicit configure | config | task all D1 | 无切换时写当前 latest 目标版本 | tests/dv/versioned_deploy_order.test.ts | covered | |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| release target containment | planning, execution, transport, versioned release | release resources 内目标接受发布 | 穿越兄弟目录或软链逃逸拒绝 | tests/integration/versioned_transport_boundary.test.ts | covered | |
| managed config transaction | execution, transport, secret loader | 发布、恢复和候选状态一致 | 发布/恢复失败返回可恢复事务 | tests/integration/managed_transport_security.test.ts | covered | |
| multipass validate/plan | config loader, planning | 三个 App schema 1 装载，计划包含 6 步 | 未声明秘密或非法路径在 SSH 前失败 | tests/testplan inline CLI steps | covered | |

## Definition of Done

- 任务统一入口 `all` 成功，并生成机器可读运行工件。
- schema 1 安装目录变量、路径边界、版本化发布和 multipass 计划均有可运行断言。
- 未执行真实 SSH、Multipass、systemd 或业务服务部署；真实 Redis 密码匹配仍需外部确认。
