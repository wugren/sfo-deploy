---
task_manifest: task.yaml
status: approved
---

Risk profile: ./risk-profile.yaml

## Test Document Index

| Document   | Level               | Scope                                             | Owner |
| ---------- | ------------------- | ------------------------------------------------- | ----- |
| testing.md | unit/dv/integration | 可选 configure、Multipass 资产裁剪与 App 发布行为 | root  |

## Unified Test Entry

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py deployment-framework/042-optional-multipass-configure all
```

所有变更测试都通过 `testplan.yaml` 在统一入口注册；任务外不使用临时命令作为完成证据。

## Submodule Tests

| Submodule                | Level       | Focus                                     | Validation |
| ------------------------ | ----------- | ----------------------------------------- | ---------- |
| Lifecycle planner        | unit        | 显式/省略 configure 的动作序列            | U1         |
| Multipass cluster assets | integration | 资源装载、依赖图和 configure-era 资产缺失 | I1/I2      |
| App publisher            | integration | 哈希、发布、版本跳过、失败回滚            | I1         |

## Module-Level Tests

| Module               | Level       | Focus                            | Validation  |
| -------------------- | ----------- | -------------------------------- | ----------- |
| deployment-framework | dv          | 执行器、依赖、失败与取消路径回归 | D1          |
| deployment-framework | integration | 示例配置、文档契约和 CLI 构建面  | I1/I2/C1/C2 |

## External Interface Tests

| Interface                | Kind          | Success                | Failure                              | Validation |
| ------------------------ | ------------- | ---------------------- | ------------------------------------ | ---------- |
| `scripts.configure` 声明 | Cluster YAML  | 存在时保持旧顺序       | 省略时计划不生成且不失败             | U1         |
| Multipass `plan --app`   | CLI planning  | 三个环境依赖直连 App   | 缺失依赖仍失败关闭                   | I1         |
| App deploy package       | Remote script | 哈希通过后发布并写标记 | 哈希错、标记写失败、清理前失败均失败 | I1         |

## Direct Change Coverage

| change_id                        | design_source | validation_id     | testplan_level | testplan_step_id | gap | gap_manual_reason |
| -------------------------------- | ------------- | ----------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-optional-multipass-configure | design.md     | C1/C2/U1/D1/I1/I2 | integration    | I2               | no  | -                 |

## Case-Type Coverage

| change_id                        | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| -------------------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-optional-multipass-configure | normal        | yes      | U1/I1         | unit        | covered | -                 |
| CHG-optional-multipass-configure | boundary      | yes      | U1            | unit        | covered | -                 |
| CHG-optional-multipass-configure | negative      | yes      | I1            | integration | covered | -                 |
| CHG-optional-multipass-configure | error         | yes      | D1/I1         | integration | covered | -                 |
| CHG-optional-multipass-configure | compatibility | yes      | C1/U1/I1      | integration | covered | -                 |
| CHG-optional-multipass-configure | lifecycle     | yes      | D1/I1         | dv          | covered | -                 |
| CHG-optional-multipass-configure | cross-module  | yes      | I1/I2/C2      | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                   | derived_cases                                       | level       | status  | gap_manual_reason |
| ---------------- | ------------------------------- | --------------------------------------------------- | ----------- | ------- | ----------------- |
| parameter-domain | design.md File-Level Interfaces | 显式 configure、省略 configure、有/无 start/restart | unit        | covered | -                 |
| state-transition | design.md Overall Approach      | 计划动作集合随 YAML 声明变化                        | unit        | covered | -                 |
| failure-path     | design.md Key Flows             | 哈希错误、版本标记失败、依赖排除                    | integration | covered | -                 |
| error-handling   | design.md Risks and Rollback    | 未知动作与缺失依赖保持 PlanningError                | integration | covered | -                 |
| invariant        | design.md Design Notes          | 已有 configure 集群的顺序不变；Multipass 无删除资产 | unit        | covered | -                 |
| concurrency      | design.md State and Ownership   | 现有串行计划与失败/取消回归                         | dv          | covered | -                 |

## Validation Rationale

单元层直接覆盖规划器在 configure 存在与省略两种输入域下的动作序列。DV
层确认执行器的步骤依赖、失败和取消路径未被计划形状变化破坏。集成层验证 Multipass
模板可装载、依赖顺序正确、删除资产不残留、App 发布不再依赖配置文件或
systemd。合同检查覆盖编译闭包与文档示例。

## Unit Tests

| function_or_unit         | branch_or_condition     | covered_behavior                | test_file                               | status  | gap_manual_reason |
| ------------------------ | ----------------------- | ------------------------------- | --------------------------------------- | ------- | ----------------- |
| `planEnvironmentActions` | configure 存在/省略     | prepare 动作序列分别为三步/两步 | tests/unit/env_prepare_planning.test.ts | covered | -                 |
| `buildExecutionPlan`     | App configure 存在/省略 | deploy 前是否加入 configure     | tests/unit/config_planning.test.ts      | covered | -                 |
| `buildExecutionPlan`     | 依赖过滤                | 省略依赖仍失败关闭              | tests/unit/config_planning.test.ts      | covered | -                 |

## DV Tests

| workflow     | kind      | entry       | expected_result                    | test_file_or_script        | status  | gap_manual_reason |
| ------------ | --------- | ----------- | ---------------------------------- | -------------------------- | ------- | ----------------- |
| 部署执行器   | main      | taskplan D1 | 依赖、状态、取消和资源清理回归通过 | tests/dv/execution.test.ts | covered | -                 |
| 部署生命周期 | lifecycle | taskplan D1 | 步骤依赖和状态推进保持稳定         | tests/dv/execution.test.ts | covered | -                 |
| 部署失败     | failure   | taskplan D1 | 单机失败不破坏其他目标且资源关闭   | tests/dv/execution.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow     | modules_involved         | success_case                   | failure_case                   | test_file                                            | status  | gap_manual_reason |
| -------------------- | ------------------------ | ------------------------------ | ------------------------------ | ---------------------------------------------------- | ------- | ----------------- |
| Multipass 配置与依赖 | config/planner/CLI       | 7 步 deploy 计划且无 configure | 缺失依赖和非法配置失败         | tests/integration/environment_placement.test.ts      | covered | -                 |
| App 发布生命周期     | app script/package cache | 发布、跳过、清理和回滚通过     | 哈希错、写标记失败、清理前失败 | tests/integration/deploy_version_skip.test.ts        | covered | -                 |
| 删除资产契约         | example assets/docs      | 无 configure/unit/config 资产  | 保留删除资产即失败             | tests/integration/independent_remote_scripts.test.ts | covered | -                 |
| 编译与文档闭包       | framework/tests/docs     | C1/C2 通过                     | 编译或文档契约失败             | testplan C1/C2                                       | covered | -                 |

## Definition of Done

- 唯一 change_id 有直接覆盖和 testplan 步骤。
- 统一入口执行 C1/C2 和全部启用层级。
- 所有测试通过；文档不再声明 Multipass 交付已删除职责。
