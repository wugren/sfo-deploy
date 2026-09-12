---
task_manifest: task.yaml
status: approved
---

# Environment install/manager Testing

Risk profile: ./risk-profile.yaml

## Test Document Index

| Document | Topic | Scope |
|----------|-------|-------|
| testing.md | Environment install/manager 行为 | 全部变更 |

## Unified Test Entry

- Machine-readable task plan: `testplan.yaml`
- Task all: `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/071-declarative-environment-install all`
- Single-task boundary: only `sfo-deploy/071-declarative-environment-install`.

## Repository Consumer Closure

| Old Symbol | New Path | Repository Consumer File | Consumer Kind | Migration Status | Contract Check ID |
|------------|----------|--------------------------|---------------|------------------|-------------------|
| Environment scripts install docs | Environment `install`/`manager` docs | README.md | documentation | migrated | C2 |
| Environment scripts install guide | Environment `install`/`manager` guide | docs/guides/sfo-deploy-cluster-configuration.md | documentation | migrated | C2 |
| Environment scripts skill reference | Environment `install`/`manager` reference | skills/sfo-deploy-cluster/references/environment.md | documentation | migrated | C2 |

## Submodule Tests

| Submodule | Responsibility | Detailed Test Doc | Required Behaviors | Edge/Failure Cases | Test Type | Test Files | Status | Gap / Manual Reason |
|-----------|----------------|-------------------|--------------------|--------------------|-----------|------------|--------|---------------------|
| environment-lifecycle | install/manager 装载、计划与执行 | testing.md | package/script、system/script、manager 缺省 | 缺失工具、失败状态、冲突 | unit/dv/integration | testplan.yaml | covered | - |

## Module-Level Tests

| Test Item | Covered Boundary | Entry | Expected Result | Test Type | Test File/Script | Status | Gap / Manual Reason |
|-----------|------------------|-------|-----------------|-----------|------------------|--------|---------------------|
| schema v1 additive contract | scripts/install-manager 互斥 | task all | 非法混用失败关闭 | unit | tests/unit/environment_management_config.test.ts | covered | - |
| manager optional | 只安装不管理 | task all | 不生成服务步骤 | unit/dv | tests/unit/environment_management_planning.test.ts | covered | - |

## External Interface Tests

| Interface | Responsibility | Success Cases | Failure/Edge Cases | Test Type | Test Doc/File | Status | Gap / Manual Reason |
|-----------|----------------|---------------|--------------------|-----------|---------------|--------|---------------------|
| environment.yaml | 新生命周期装载 | package/system、script/script | 未知 kind/tool、非法包名、冲突 | unit | tests/unit/environment_management_config.test.ts | covered | - |
| plan v4 | 声明持久化 | package/system round-trip | 无脚本步骤必须携带内置声明 | integration | tests/integration/environment_management_history.test.ts | covered | - |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | gap | gap_manual_reason |
|-----------|---------------|---------------|----------------|------------------|-----|-------------------|
| CHG-declarative-environment-install | `design.md` File-Level Interfaces、`design/environment-lifecycle.md` | C1/C2/U1/U2/U3/D1/I1 | unit | U1 | no | 多步骤共用同一 change_id；完整入口为 task all |
| CHG-declarative-environment-service | `design/environment-lifecycle.md` Execution Contract | C1/U3/D1/I1 | dv | D1 | no | - |
| CHG-declarative-environment-conflicts | `design.md` Design Scope | U1/U2/I1 | unit | U1 | no | - |
| CHG-declarative-environment-docs | `design.md` API and Build Surface Impact | C2/U1 | unit | U1 | no | C2 是附加契约检查，映射到 task all 的 unit 阶段 |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
|-----------|-----------|----------|---------------|-------|--------|-------------------|
| CHG-declarative-environment-install | normal | yes | U1 | unit | covered | - |
| CHG-declarative-environment-install | boundary | yes | U1 | unit | covered | - |
| CHG-declarative-environment-install | negative | yes | U1 | unit | covered | - |
| CHG-declarative-environment-install | error | yes | U3 | unit | covered | - |
| CHG-declarative-environment-install | compatibility | yes | I1 | integration | covered | - |
| CHG-declarative-environment-install | lifecycle | yes | D1 | dv | covered | - |
| CHG-declarative-environment-install | cross-module | yes | I1 | integration | covered | - |
| CHG-declarative-environment-service | normal | yes | U3 | unit | covered | - |
| CHG-declarative-environment-service | boundary | yes | U3 | unit | covered | - |
| CHG-declarative-environment-service | negative | yes | U3 | unit | covered | - |
| CHG-declarative-environment-service | error | yes | U3 | unit | covered | - |
| CHG-declarative-environment-service | compatibility | yes | I1 | integration | covered | - |
| CHG-declarative-environment-service | lifecycle | yes | D1 | dv | covered | - |
| CHG-declarative-environment-service | cross-module | yes | I1 | integration | covered | - |
| CHG-declarative-environment-conflicts | normal | yes | U1 | unit | covered | - |
| CHG-declarative-environment-conflicts | boundary | yes | U1 | unit | covered | - |
| CHG-declarative-environment-conflicts | negative | yes | U1 | unit | covered | - |
| CHG-declarative-environment-conflicts | error | yes | U1 | unit | covered | - |
| CHG-declarative-environment-conflicts | compatibility | yes | U1 | unit | covered | - |
| CHG-declarative-environment-conflicts | lifecycle | yes | U2 | unit | covered | - |
| CHG-declarative-environment-conflicts | cross-module | yes | I1 | integration | covered | - |
| CHG-declarative-environment-docs | normal | yes | C2 | integration | covered | - |
| CHG-declarative-environment-docs | boundary | yes | C2 | integration | covered | - |
| CHG-declarative-environment-docs | negative | yes | C2 | integration | covered | - |
| CHG-declarative-environment-docs | error | yes | C2 | integration | covered | - |
| CHG-declarative-environment-docs | compatibility | yes | C2 | integration | covered | - |
| CHG-declarative-environment-docs | lifecycle | yes | C2 | integration | covered | - |
| CHG-declarative-environment-docs | cross-module | yes | C2 | integration | covered | - |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
|--------------|---------------|---------------|-------|--------|-------------------|
| parameter-domain | `design/environment-lifecycle.md` Configuration Shape | U1 package/script、tool/kind 枚举、包名边界 | unit | covered | - |
| state-transition | `design.md` State and Ownership | D1 首次 start 与既有版本 restart | dv | covered | - |
| failure-path | `design.md` Key Flows | U3 探测/命令/状态失败 | unit | covered | - |
| error-handling | `design/environment-lifecycle.md` Execution Contract | U3 非零退出与失败关闭 | unit | covered | - |
| invariant | `design.md` Design Scope | U1 旧 scripts 不变、新契约互斥；I1 旧快照 | unit | covered | - |
| concurrency | `design.md` State and Ownership | U2 步骤依赖线性化 | unit | covered | - |

## Validation Rationale

| Behavior or Risk | Validation Signal | Why This Is Sufficient | Gap / Manual Reason |
|------------------|-------------------|------------------------|---------------------|
| 配置契约与计划语义 | U1/U2 | 涵盖合法形态、边界、冲突和失败关闭 | - |
| 固定远端命令 | U3/D1 | 检查 argv、提权、顺序与状态收敛 | - |
| 计划重放兼容性 | I1 | 证明 plan v4 往返保留新声明 | - |
| 真实发行版兼容性 | manual | 无真实 Ubuntu/CentOS 目标 | manual gap：真实包管理器与 init 语义需要实机验证 |

## Unit Tests

| Function or Unit | Branch or Condition | Covered Behavior | Test File | Status | Gap / Manual Reason |
|------------------|---------------------|------------------|-----------|--------|---------------------|
| `environmentInstall`/`environmentManager` | kind/tool/包名/路径 | 合法与非法装载 | tests/unit/environment_management_config.test.ts | covered | - |
| `environmentActionsFor` | prepare/install/start/restart | 无 check、manager 可缺省、依赖顺序 | tests/unit/environment_management_planning.test.ts | covered | - |
| `installEnvironmentPackages` | package present/missing, apt/yum | 固定命令、update_cache、提权 | tests/unit/environment_management.test.ts | covered | - |
| `convergeEnvironmentService` | systemctl/service, success/failure | 动作、enable、状态确认 | tests/unit/environment_management.test.ts | covered | - |

## DV Tests

| Workflow | Kind | Entry | Expected Result | Test File or Script | Status | Gap / Manual Reason |
|----------|------|-------|-----------------|---------------------|--------|---------------------|
| prepare install + manager | lifecycle | task all | install 成功后 start，restart 被选择逻辑跳过 | tests/dv/environment_management_execution.test.ts | covered | - |
| prepare install + manager | main | task all | install 成功后 start，restart 被选择逻辑跳过 | tests/dv/environment_management_execution.test.ts | covered | - |
| prepare install/service failure | failure | task all | 任一动作失败时步骤失败 | tests/unit/environment_management.test.ts | gap | 失败分支已在 unit 运行时覆盖；未重复建立 DV 故障注入用例 |

## Integration Tests

| Contract or Flow | Modules Involved | Success Case | Failure Case | Test File | Status | Gap / Manual Reason |
|------------------|------------------|--------------|--------------|-----------|--------|---------------------|
| planner/history contract | planning/history | plan v4 round-trip | 无脚本步骤缺少内置声明被拒 | tests/integration/environment_management_history.test.ts | covered | - |

## Regression Focus

- 旧顶层 `scripts` 配置必须完全不受新字段影响。
- 历史 plan v3 不允许新字段，v4 新字段必须可选。

## Definition of Done

- [x] 配置、计划、执行、历史和文档行为均有直接验证或 gap 记录。
- [x] 新增/修改测试全部通过 `testplan.yaml` 的 task-scoped unified entrypoint 可达。
- [x] `deno task check` 作为仓库编译闭包执行。
- [x] 真实 Ubuntu/CentOS 实机验证缺失已记录为 manual gap。
