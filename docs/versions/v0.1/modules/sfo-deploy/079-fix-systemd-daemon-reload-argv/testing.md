---
task_manifest: task.yaml
status: approved
---

# multipass deploy 成功链路测试

Risk profile: ./risk-profile.yaml

## Test Document Index

not-applicable: 本任务不拆分独立产品子模块；测试覆盖 service management、deployment
execution 和 multipass 配置契约。

## Unified Test Entry

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/079-fix-systemd-daemon-reload-argv all
```

该命令只执行本任务 testplan 声明的契约、unit、DV 和 integration 步骤。

## Submodule Tests

not-applicable: 无新增业务子模块。

## Module-Level Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| systemctl 命令形状 | runtime | task all U1 | `daemon-reload` 无 unit；其他动作有 unit | tests/unit/service_management.test.ts | covered | |
| failed unit 恢复 | lifecycle | task all U1 | prepare/restore 清除 failed 状态并恢复既有 enabled/active | tests/unit/service_management.test.ts | covered | |
| 静态服务延迟 | lifecycle | task all D1 | `enabled` 未声明且 `on_deploy: none` 不发 start/restart | tests/dv/versioned_deploy_order.test.ts | covered | |
| multipass 布局 | integration | task all I1 | 实际包使用 `server/jx-server.jar` 和 `server/resources/` | tests/integration/versioned_release.test.ts | covered | |
| 真实 multipass deploy | manual | 2026-09-10 deploy log | 5/5 succeeded | shell session evidence | covered | 用户授权的真实部署只执行一次作为最终验收证据 |

## External Interface Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| executor -> systemd convergence | execution, service management | stage 只准备；activate 切换后执行一次服务动作 | 服务失败时恢复 latest/marker 和 enabled/active | tests/dv/versioned_deploy_order.test.ts | covered | |
| versioned release -> multipass App config | versioned release, config | unit/config 路径匹配实际制品布局 | 旧 `base-entry.jar` 断言不再适用于 live 包 | tests/integration/versioned_release.test.ts | covered | |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | gap | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-multipass-deploy-success | design.md | VAL-079-ARGV, VAL-079-FAILED-STATE, VAL-079-STATIC-SERVICE, VAL-079-LAYOUT, VAL-079-COMPILE | unit | U1 | no | 其余 VAL 分别映射到 D1/I1/C1 的 Case-Type Coverage |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-multipass-deploy-success | normal | yes | VAL-079-ARGV | unit | covered | |
| CHG-multipass-deploy-success | normal | yes | VAL-079-LAYOUT | integration | covered | |
| CHG-multipass-deploy-success | boundary | yes | VAL-079-FAILED-STATE | unit | covered | missing unit + failed record |
| CHG-multipass-deploy-success | negative | yes | VAL-079-ARGV | unit | covered | 旧实现误加 unit 导致红色失败 |
| CHG-multipass-deploy-success | error | yes | VAL-079-FAILED-STATE | unit | covered | reset-failed 失败路径由共同 serviceCommand 拒绝非零返回 |
| CHG-multipass-deploy-success | compatibility | yes | VAL-079-STATIC-SERVICE | dv | covered | 既有服务动作和模板演示包契约保留 |
| CHG-multipass-deploy-success | compatibility | yes | VAL-079-LAYOUT | integration | covered | 既有服务动作和模板演示包契约保留 |
| CHG-multipass-deploy-success | lifecycle | yes | VAL-079-FAILED-STATE | unit | covered | |
| CHG-multipass-deploy-success | lifecycle | yes | VAL-079-STATIC-SERVICE | dv | covered | |
| CHG-multipass-deploy-success | cross-module | yes | VAL-079-STATIC-SERVICE | dv | covered | |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | design.md File-Level Interfaces | daemon-reload 与 unit 子命令、missing/not-found/failed active state | unit | covered | |
| state-transition | design.md State and Ownership | failed -> reset -> start | unit | covered | |
| state-transition | design.md State and Ownership | latest/marker 失败恢复 | dv | covered | |
| failure-path | design.md Key Flows | service/publish/switch/marker/restore 故障注入 | dv | covered | |
| error-handling | design.md Risks and Rollback | systemctl 非零返回、active/enable 未收敛 | unit | covered | |
| invariant | design.md State and Ownership | 只有 enabled 服务才强启动；静态包不提交服务动作 | dv | covered | |
| concurrency | design.md Design Notes | 未新增并发路径；沿用单 App 操作锁 | not-applicable | not-applicable | 设计明确未引入并发修改 |

## Validation Rationale

unit 能以完整 argv 和记录型状态机直接暴露 systemctl 参数与 failed 状态缺陷；DV 验证
executor、发布事务和服务管理在正常/失败路径中的顺序；integration 固定实际 multipass
制品布局契约。真实部署是用户要求的最终系统证据，但不可重复自动化，因此单独记录。

## Unit Tests

| function_or_unit | branch_or_condition | covered_behavior | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| `serviceCommand` | `daemon-reload` / 其他 systemctl 动作 | unitless 子命令不追加 `-- unit` | tests/unit/service_management.test.ts | covered | |
| `prepareSystemd` / `restoreSystemd` | active state `failed` | 执行 `reset-failed -- unit` 后继续收敛 | tests/unit/service_management.test.ts | covered | |
| `readState` | enabled not-found + active failed/4 | 接受为可重置的未激活状态，不提前失败 | tests/unit/service_management.test.ts | covered | |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| stage 后 activate | main | task all D1 | 先全局准备，再按目标切换并执行动作 | tests/dv/versioned_deploy_order.test.ts | covered | |
| 静态 versioned service | config | task all D1 | 无 enabled/on_deploy 动作时不调用 start/restart | tests/dv/versioned_deploy_order.test.ts | covered | |
| failed unit 恢复生命周期 | lifecycle | task all D1 | failed 状态可在 prepare/restore 后重置，再收敛到配置状态 | tests/unit/service_management.test.ts | covered | unit 直接覆盖状态机；DV 保留既有恢复故障注入 |
| 发布与恢复故障 | failure | task all D1 | 恢复 latest/marker 并保留备份或报告恢复失败 | tests/dv/versioned_deploy_order.test.ts | covered | |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| live multipass layout | config, versioned release | `server/jx-server.jar`、`server/resources` 契约成立 | 配置目标或 JAR 名漂移时失败 | tests/integration/versioned_release.test.ts | covered | |
| template compatibility | config, examples | 模板继续支持演示 `base-entry.jar` 布局 | 两者契约被误合并时失败 | tests/integration/versioned_release.test.ts | covered | |

## Definition of Done

- 任务统一入口 `all` 成功并生成机器可读运行工件。
- 全量 `deno task test` 通过（306 passed / 0 failed）。
- 真实 multipass deploy 5/5 succeeded 的日志与目标机状态检查已记录。
