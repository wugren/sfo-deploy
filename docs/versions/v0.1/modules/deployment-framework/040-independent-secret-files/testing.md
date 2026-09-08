---
task_manifest: task.yaml
status: draft
---

Risk profile: ./risk-profile.yaml

## Test Document Index

| Document   | Level               | Scope                                                | Owner |
| ---------- | ------------------- | ---------------------------------------------------- | ----- |
| testing.md | unit/dv/integration | 集群秘密来源、known_hosts 发现、Multipass 无绑定 CLI | root  |

## Unified Test Entry

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py deployment-framework/040-independent-secret-files all
```

所有变更测试都通过 `testplan.yaml` 在统一入口注册；任务外不使用临时命令作为完成证据。

## Submodule Tests

| Submodule             | Level | Focus                          | Validation |
| --------------------- | ----- | ------------------------------ | ---------- |
| ClusterSecretSource   | unit  | YAML 装载、kind 分派、路径约束 | U1         |
| SecretsDeployCLI      | unit  | 部署/校验/移除行为             | U2         |
| Generic CLI transport | unit  | 集群 known_hosts 发现          | U1         |

## Module-Level Tests

| Module               | Level       | Focus                         | Validation |
| -------------------- | ----------- | ----------------------------- | ---------- |
| deployment-framework | dv          | 执行器与安装工作流回归        | D1         |
| deployment-framework | integration | 示例脚本、文档和 CLI 集成回归 | I1/I2      |

## External Interface Tests

| Interface                   | Kind           | Success                    | Failure                     | Validation |
| --------------------------- | -------------- | -------------------------- | --------------------------- | ---------- |
| `sfo-deploy secrets-deploy` | CLI            | 读取 `secrets.yaml` 并部署 | 来源缺失或无效在 SSH 前失败 | U1/U2      |
| `<cluster>/known_hosts`     | File discovery | 存在时传给 OpenSSH         | 符号链接/目录失败关闭       | U1         |
| Multipass Deno task         | Build surface  | 调用通用 CLI               | 不再调用示例绑定脚本        | C1/C2/I1   |

## Direct Change Coverage

| change_id                    | design_source | validation_id  | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ---------------------------- | ------------- | -------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-cluster-secret-source    | design.md     | U1/U3/D1/I2/C1 | integration    | I2               | no  | -                 |
| CHG-cluster-known-hosts      | design.md     | U1/U3/D1/I2/C1 | integration    | I2               | no  | -                 |
| CHG-multipass-no-binding-cli | design.md     | U2/I1/I2/C1/C2 | integration    | I2               | no  | -                 |

## Case-Type Coverage

| change_id                    | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| ---------------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-cluster-secret-source    | normal        | yes      | U1/U2         | unit        | covered | -                 |
| CHG-cluster-secret-source    | boundary      | yes      | U1            | unit        | covered | -                 |
| CHG-cluster-secret-source    | negative      | yes      | U1            | unit        | covered | -                 |
| CHG-cluster-secret-source    | error         | yes      | U1/U2         | unit        | covered | -                 |
| CHG-cluster-secret-source    | compatibility | yes      | C1/I2         | integration | covered | -                 |
| CHG-cluster-secret-source    | lifecycle     | yes      | D1            | dv          | covered | -                 |
| CHG-cluster-secret-source    | cross-module  | yes      | I1/I2         | integration | covered | -                 |
| CHG-cluster-known-hosts      | normal        | yes      | U1            | unit        | covered | -                 |
| CHG-cluster-known-hosts      | boundary      | yes      | U1            | unit        | covered | -                 |
| CHG-cluster-known-hosts      | negative      | yes      | U1            | unit        | covered | -                 |
| CHG-cluster-known-hosts      | error         | yes      | U1            | unit        | covered | -                 |
| CHG-cluster-known-hosts      | compatibility | yes      | C1/I2         | integration | covered | -                 |
| CHG-cluster-known-hosts      | lifecycle     | yes      | D1            | dv          | covered | -                 |
| CHG-cluster-known-hosts      | cross-module  | yes      | I1/I2         | integration | covered | -                 |
| CHG-multipass-no-binding-cli | normal        | yes      | U2/I1         | integration | covered | -                 |
| CHG-multipass-no-binding-cli | boundary      | yes      | U2            | unit        | covered | -                 |
| CHG-multipass-no-binding-cli | negative      | yes      | U2            | unit        | covered | -                 |
| CHG-multipass-no-binding-cli | error         | yes      | U2            | unit        | covered | -                 |
| CHG-multipass-no-binding-cli | compatibility | yes      | C1/C2/I1      | integration | covered | -                 |
| CHG-multipass-no-binding-cli | lifecycle     | yes      | D1            | dv          | covered | -                 |
| CHG-multipass-no-binding-cli | cross-module  | yes      | I1/I2         | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                   | derived_cases                                       | level | status  | gap_manual_reason |
| ---------------- | ------------------------------- | --------------------------------------------------- | ----- | ------- | ----------------- |
| parameter-domain | design.md File-Level Interfaces | 合法值、空值、未知键、非法键名、模式 0600/0644      | unit  | covered | -                 |
| state-transition | design.md State and Ownership   | deploy 前装载、check/remove 不装载                  | unit  | covered | -                 |
| failure-path     | design.md Key Flows             | YAML 缺失、重复键、路径逃逸、known_hosts 非普通文件 | unit  | covered | -                 |
| error-handling   | design.md Risks and Rollback    | 配置错误与 preflight 错误分别失败关闭               | unit  | covered | -                 |
| invariant        | design.md State and Ownership   | 声明与来源一一对应；不输出秘密值                    | unit  | covered | -                 |
| concurrency      | design.md Key Flows             | 现有顺序执行与资源清理回归                          | dv    | covered | -                 |

## Validation Rationale

单元层验证新装载器的每个关键分支；DV
层确认执行器工作流未被秘密来源变化破坏；集成层验证示例脚本、文档和构建面迁移；合同检查覆盖编译闭包与文档示例。

## Unit Tests

| function_or_unit            | branch_or_condition       | covered_behavior                 | test_file                                | status  | gap_manual_reason |
| --------------------------- | ------------------------- | -------------------------------- | ---------------------------------------- | ------- | ----------------- |
| `loadClusterSecretSource`   | value/file 分派           | 值密钥和文件路径分别映射         | tests/unit/cluster_secret_source.test.ts | covered | -                 |
| `loadClusterSecretSource`   | 权限/缺失/未知键/路径逃逸 | 全部失败关闭                     | tests/unit/cluster_secret_source.test.ts | covered | -                 |
| `discoverClusterKnownHosts` | 存在/缺失/符号链接        | 正确发现或拒绝                   | tests/unit/cluster_secret_source.test.ts | covered | -                 |
| `runSecretsDeploy`          | deploy/check/remove       | 部署读取来源；其他操作不要求来源 | tests/unit/secrets_cli.test.ts           | covered | -                 |

## DV Tests

| workflow     | kind      | entry                         | expected_result                          | test_file_or_script           | status  | gap_manual_reason |
| ------------ | --------- | ----------------------------- | ---------------------------------------- | ----------------------------- | ------- | ----------------- |
| 部署执行器   | main      | tests/dv/execution.test.ts    | 计划、秘密副本和上传顺序不变             | tests/dv/execution.test.ts    | covered | -                 |
| 部署生命周期 | lifecycle | tests/dv/execution.test.ts    | 步骤依赖、状态推进和部分失败路径保持稳定 | tests/dv/execution.test.ts    | covered | -                 |
| 失败与取消   | failure   | tests/dv/execution.test.ts    | 资源关闭且步骤失败关闭                   | tests/dv/execution.test.ts    | covered | -                 |
| 安装工作流   | config    | tests/dv/install_deno.test.ts | 传输行为保持兼容                         | tests/dv/install_deno.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow | modules_involved          | success_case                  | failure_case          | test_file                                            | status  | gap_manual_reason |
| ---------------- | ------------------------- | ----------------------------- | --------------------- | ---------------------------------------------------- | ------- | ----------------- |
| 独立集群脚本     | framework/example scripts | 脚本、loader 和元数据契约通过 | 非法输入失败关闭      | tests/integration/independent_remote_scripts.test.ts | covered | -                 |
| 集群配置         | framework/example configs | schema v2 模板可装载          | 旧布局/非法字段被拒绝 | tests/integration/environment_placement.test.ts      | covered | -                 |
| 构建/文档面      | framework/example docs    | 编译闭包与文档契约通过        | 缺失契约失败          | testplan contract C1/C2                              | covered | -                 |

## Definition of Done

- 每个变更 ID 都有直接覆盖和 testplan 步骤。
- 统一入口执行 C1/C2 和全部启用层级。
- 所有测试通过；失败路径验证不输出秘密明文。
