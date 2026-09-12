---
task_manifest: task.yaml
status: approved
---

# versioned 配置父目录测试

Risk profile: ./risk-profile.yaml

## Test Document Index

本任务没有独立产品子模块；本文档覆盖 transport 的发布路径、versioned 部署协作与文档契约。

## Unified Test Entry

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/077-fix-versioned-config-parent all
```

该命令只执行本任务 testplan 声明的契约、DV 和 integration 步骤，不运行全仓库维护套件。

## Submodule Tests

not-applicable: 本任务不拆分独立产品子模块，发布边界在 RemoteTransport 模块级验证。

## Module-Level Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| 缺失版本内父目录 | runtime | task all I1 | 候选版本内逐级创建目录并继续发布 | tests/integration/versioned_transport_boundary.test.ts | covered | |
| 父目录安全边界 | security | task all I1 | 越界、发布根符号链接和中间符号链接拒绝且不修改目标 | tests/integration/versioned_transport_boundary.test.ts | covered | |

## External Interface Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| versioned release -> managed config publication | execution, versioned release management, transport | stage 在候选版本内创建 `resources/` 等父目录并发布 | 父目录逃逸或符号链接逃逸在写入前失败 | tests/dv/versioned_deploy_order.test.ts, tests/integration/versioned_transport_boundary.test.ts | covered | |
| App 配置示例契约 | config, examples | 示例 versioned App 配置契约保持可装载 | 配置契约破坏时检查失败 | tests/contract/verify_app_management_contract.ts | covered | |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | gap | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-versioned-config-parent | design.md | VAL-077-RELEASE-PARENT, VAL-077-DEPLOY-ORDER, VAL-077-COMPILE, VAL-077-DOCS | integration | I1 | no | |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-versioned-config-parent | normal | yes | VAL-077-RELEASE-PARENT | integration | covered | |
| CHG-versioned-config-parent | boundary | yes | VAL-077-RELEASE-PARENT | integration | covered | |
| CHG-versioned-config-parent | negative | yes | VAL-077-RELEASE-PARENT | integration | covered | |
| CHG-versioned-config-parent | error | yes | VAL-077-RELEASE-PARENT | integration | covered | |
| CHG-versioned-config-parent | compatibility | yes | VAL-077-DEPLOY-ORDER | dv | covered | 无发布根行为、现有边界用例和示例契约继续验证兼容性 |
| CHG-versioned-config-parent | lifecycle | yes | VAL-077-DEPLOY-ORDER | dv | covered | |
| CHG-versioned-config-parent | cross-module | yes | VAL-077-DEPLOY-ORDER | dv | covered | |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | design.md Overall Approach | 缺失一级父目录、缺失多级父目录、无 `runAs`、有 `runAs` | integration | covered | |
| state-transition | design.md State and Ownership | 候选版本目录到受管配置父目录，再原子发布 | dv | covered | |
| failure-path | design.md Key Flows | 中间符号链接、发布根符号链接、路径越界拒绝 | integration | covered | |
| error-handling | design.md Risks and Rollback | 目录创建失败与旧路径父目录缺失都会失败，不触发目标修改 | integration | covered | |
| invariant | design.md Overall Approach | 已存在父目录不创建；真实父路径必须等于或位于真实发布根内 | integration | covered | |
| concurrency | design.md Risks and Rollback | 本任务未新增并发写入；沿用单 App 操作锁和串行发布 | not-applicable | not-applicable | 设计明确未新增并发路径 |

## Validation Rationale

integration 是能验证真实远端命令参数、返回码和操作顺序的最低有效层级；DV 验证 executor、发布管理和配置发布的协作顺序；编译闭包锁定消费方可编译性；示例契约检查锁定文档示例与 App 配置行为一致。

## Unit Tests

| function_or_unit | branch_or_condition | covered_behavior | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| `publishManagedConfigs` / `#ensureReleaseParent` | 公有/私有远端发布路径 | 命令边界与远端副作用在 integration 验证 | tests/integration/versioned_transport_boundary.test.ts | covered | 方法依赖远端会话命令边界，伪单元无法证明该契约 |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| stage 后 activate | main | task all D1 | 所有 stage 成功后按目标执行 activate 和服务动作 | tests/dv/versioned_deploy_order.test.ts | covered | |
| 发布/服务/标记失败 | failure | task all D1 | 失败不留下新激活状态并恢复配置 | tests/dv/versioned_deploy_order.test.ts | covered | |
| stage 到 activate 生命周期 | lifecycle | task all D1 | 候选版本先完成准备，激活阶段再切换 latest | tests/dv/versioned_deploy_order.test.ts | covered | |
| 显式 configure | config | task all D1 | 无候选 release 时保持原 target 行为 | tests/dv/versioned_deploy_order.test.ts | covered | |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| release parent creation | execution, transport, versioned release | 缺失 `resources/config` 逐级创建并使用 `run_as`；无 `runAs` 时保持特权账户 | 目录已存在时未重复创建 | tests/integration/versioned_transport_boundary.test.ts | covered | |
| release parent containment | execution, transport, versioned release | 普通版本内父目录通过 `realpath` 校验 | 兄弟目录、穿越、发布根符号链接和中间符号链接拒绝 | tests/integration/versioned_transport_boundary.test.ts | covered | |

## Definition of Done

- 任务统一入口 `all` 成功并生成机器可读运行工件。
- 缺失父目录有绿色回归，且旧实现已复现红色失败。
- 不执行真实 SSH、Multipass 或 systemd 部署；真实环境启动仍需外部验证。
