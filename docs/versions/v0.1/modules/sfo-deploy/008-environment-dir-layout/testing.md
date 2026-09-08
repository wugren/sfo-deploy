---
task_manifest: task.yaml
status: draft
---

# 环境目录按机器组织测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

| Document        | Topic                       | Scope                                 |
| --------------- | --------------------------- | ------------------------------------- |
| `testing.md`    | 装载/规划/契约/集成测试设计 | 整个部署框架模块与 multipass 示例     |
| `testplan.yaml` | 机器可读任务级测试计划      | sfo-deploy/008-environment-dir-layout |

## Unified Test Entry

- Machine-readable task plan:
  `docs/versions/v0.1/modules/sfo-deploy/008-environment-dir-layout/testplan.yaml`
- Task all:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/008-environment-dir-layout all`
- Single-task boundary：只运行任务测试计划；不运行 `sfo-deploy all`、`all all` 或根快捷方式。
- Registration：新增/修改的测试断言都通过 `testplan.yaml` 步骤注册到统一入口。

## Repository Consumer Closure

| Old Symbol                                        | New Path                                                 | Repository Consumer File                                             | Consumer Kind | Migration Status | Contract Check ID   |
| ------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | ------------- | ---------------- | ------------------- |
| `cluster.environments["database"]`                | `cluster.environments["<machine>/<env>"]`                | `tests/unit/test_config_planning.py`                                 | test          | migrated         | removed-symbol-scan |
| `set(cluster.environments) == {"jre", ...}`       | `set(cluster.environments) == {"eleph-server/jre", ...}` | `examples/eleph-server-multipass/tests/test_config_contract.py`      | test          | migrated         | removed-symbol-scan |
| 共享定义式 environments/<定义名>/environment.yaml | 每机 environments/<机器名>/<环境名>/environment.yaml     | `tests/conftest.py`                                                  | test fixture  | migrated         | removed-symbol-scan |
| machines.yaml 环境实例列表字段                    | machines.yaml 无环境字段（目录即声明）                   | `examples/eleph-server-multipass/cluster-template/machines.yaml.tpl` | data template | migrated         | removed-symbol-scan |

## Submodule Tests

| Submodule    | Responsibility                                                    | Detailed Test Doc                | Required Behaviors       | Edge/Failure Cases       | Test Type        | Test Files                              | Status  | Gap / Manual Reason |
| ------------ | ----------------------------------------------------------------- | -------------------------------- | ------------------------ | ------------------------ | ---------------- | --------------------------------------- | ------- | ------------------- |
| 无独立子模块 | not-applicable: 变更仅落在 config.py 与数据模板，未引入业务子模块 | not-applicable: 无子模块测试文档 | not-applicable: 无子模块 | not-applicable: 无子模块 | unit/integration | `tests/unit/test_config_planning.py` 等 | covered |                     |

## Module-Level Tests

| Test Item           | Covered Boundary                                                        | Entry                                                                   | Expected Result                              | Test Type   | Test File/Script                                                | Status  | Gap / Manual Reason                                                                                   |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- | ----------- | --------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| 新布局装载契约      | machines.yaml 无环境字段；环境目录按机器枚举                            | pytest `test_config_contract`                                           | 装载成功且 environments 键为 `机器名/环境名` | integration | `examples/eleph-server-multipass/tests/test_config_contract.py` | covered |                                                                                                       |
| 旧布局拒绝          | machines.yaml 含 environments 字段/环境目录非机器名/缺 environment.yaml | pytest `test_environment_declarations_live_only_in_machine_directories` | ConfigurationError 且不连接 SSH              | unit        | `tests/unit/test_config_planning.py`                            | covered |                                                                                                       |
| PowerShell 引导契约 | pwsh 解析与带空格密钥生成                                               | pytest `test_bootstrap.py` 中两个 pwsh 用例                             | pwsh 存在时通过                              | integration | `examples/eleph-server-multipass/tests/test_bootstrap.py`       | gap     | 本机无 pwsh（既有环境缺口，与本任务无关）；已由 bash prepare 集成测试与中文 contract 测试覆盖等价行为 |

## External Interface Tests

| Interface                       | Responsibility                      | Success Cases                                                           | Failure/Edge Cases                                            | Test Type   | Test Doc/File                                                     | Status  | Gap / Manual Reason |
| ------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- | ----------- | ----------------------------------------------------------------- | ------- | ------------------- |
| `load_cluster(directory)`       | 新布局装载与旧布局拒绝              | 新模板/夹具装载成功；各机器环境独立参数                                 | 旧字段/未知机器目录/缺 environment.yaml 的 ConfigurationError | unit        | `tests/unit/test_config_planning.py`                              | covered |                     |
| `build_plan(cluster, action)`   | 依赖排序与节点 id 不变              | jre/mysql/redis 先于 jx-runtime；环境先于 App；节点 id 保持 `机器/环境` | 循环依赖、未知依赖、剔除必需依赖的 PlanningError              | unit        | `tests/unit/test_config_planning.py`、`examples/.../test_plan.py` | covered |                     |
| CLI validate/plan/check/install | 环境 id 保持 `机器/环境` 且不含密钥 | bound/generic CLI 从任意 cwd 规划成功                                   | 未知机器、歧义选择返回稳定退出码 2                            | integration | `tests/integration/test_project_cli.py`                           | covered |                     |

## Direct Change Coverage

| change_id                  | design_source                                                                                                                    | validation_id                                                   | testplan_level | testplan_step_id    | Gap? | Gap / Manual Reason |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------- | ------------------- | ---- | ------------------- |
| CHG-environment-dir-layout | `design.md` Overall Approach / File-Level Interfaces / Key Flows；具体验证 id 见 Design Element Coverage 与 Validation Rationale | VAL-001,VAL-002,VAL-003,VAL-004,VAL-005,VAL-006,VAL-007,VAL-008 | unit           | unit-config-loading | no   |                     |

## Case-Type Coverage

| change_id                  | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| -------------------------- | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-environment-dir-layout | normal        | yes      | VAL-001       | unit        | covered |                   |
| CHG-environment-dir-layout | boundary      | yes      | VAL-002       | unit        | covered |                   |
| CHG-environment-dir-layout | negative      | yes      | VAL-003       | unit        | covered |                   |
| CHG-environment-dir-layout | error         | yes      | VAL-004       | unit        | covered |                   |
| CHG-environment-dir-layout | compatibility | yes      | VAL-005       | integration | covered |                   |
| CHG-environment-dir-layout | lifecycle     | no       | VAL-006       | dv          | covered |                   |
| CHG-environment-dir-layout | cross-module  | yes      | VAL-007       | integration | covered |                   |

## Design Element Coverage

| element_type     | design_source                                                                                     | derived_cases                                                 | level       | status         | gap_manual_reason |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------- | -------------- | ----------------- |
| parameter-domain | `design.md` File-Level Interfaces（version/parameters/depends_on 自包含）                         | 每机 database 参数 port 5432/5433、版本 15 断言               | unit        | covered        |                   |
| state-transition | `design.md` State and Ownership（无运行期状态转换）                                               | not-applicable: 设计明确无状态转换图，装载是纯函数校验        | unit        | not-applicable | 无状态转换可测    |
| failure-path     | `design.md` Key Flows alt 分支                                                                    | 旧字段、非机器目录、缺 environment.yaml、循环依赖失败路径     | unit        | covered        |                   |
| error-handling   | `design.md` Risks；data-schema 触发规则                                                           | ConfigurationError 类别与关键错误文案断言                     | unit        | covered        |                   |
| invariant        | `design.md` State and Ownership（机器名↔目录 1:1；id 恒为 machine/env；machines.yaml 无环境字段） | 装载后 environments 键、实例依赖、CLI 输出不变                | integration | covered        |                   |
| concurrency      | `design.md`（无并发声明）                                                                         | not-applicable: 装载/规划保持串行纯函数，无并发或重入语义变化 | unit        | not-applicable | 无并发语义        |

## Validation Rationale

| Behavior or Risk   | Validation Signal                                          | Why This Is Sufficient                          | Gap / Manual Reason                                  |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| 新布局装载正确     | 新夹具与示例模板装载断言                                   | 覆盖每机多环境、参数/版本/依赖自包含与 key 语义 |                                                      |
| 旧布局明确拒绝     | `environments:` 字段、非机器目录、缺 environment.yaml 负例 | 验证 clean break 的失败关闭路径                 |                                                      |
| 依赖顺序不回归     | plan 步骤 id 与拓扑断言                                    | 直接绑定执行顺序与节点标识                      |                                                      |
| CLI 公共输出不回归 | validate/plan integration 用例                             | 环境 id 与退出码保持不变                        |                                                      |
| 信任包生成一致性   | prepare fake-multipass 集成测试                            | 验证模板→发布事务产生新布局                     | pwsh 解析/密钥用例需 pwsh 环境，本机缺失（既有缺口） |
| 文档示例一致性     | README contract 测试                                       | 验证文档命令与路径未漂移                        |                                                      |

## Unit Tests

| Function or Unit             | Branch or Condition        | Covered Behavior                                            | Test File                                                               | Status  | Gap / Manual Reason |
| ---------------------------- | -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- | ------- | ------------------- |
| `_load_machines`             | 未知环境字段分支           | machines.yaml 含 `environments:` 被 ConfigurationError 拒绝 | `tests/unit/test_config_planning.py`                                    | covered |                     |
| `_load_machine_environments` | 机器目录未知分支           | `environments/<非机器名>` 被拒绝                            | `tests/unit/test_config_planning.py`                                    | covered |                     |
| `_load_machine_environments` | 缺少 environment.yaml 分支 | 空环境子目录失败关闭                                        | `tests/unit/test_config_planning.py`                                    | covered |                     |
| `load_cluster`               | 多机同名环境实例           | east-host/west-host 各 database 参数独立且 key 不冲突       | `tests/unit/test_config_planning.py`                                    | covered |                     |
| `_validate_dependencies`     | 自依赖环分支               | 环境自依赖在规划期报 PlanningError                          | `tests/unit/test_config_planning.py`                                    | covered |                     |
| `build_plan`                 | 定向 App 依赖检查分支      | 不带 with-dependencies 时仅 check 环境且不 install          | `tests/unit/test_config_planning.py`                                    | covered |                     |
| 示例环境脚本                 | 新路径 glob/import         | 脚本可解析且密钥/模板契约成立                               | `examples/.../test_environment_scripts.py`、`test_lifecycle_scripts.py` | covered |                     |

## DV Tests

| Workflow       | Kind        | Entry                                                                         | Expected Result                                    | Test File or Script                         | Status         | Gap / Manual Reason |
| -------------- | ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- | -------------- | ------------------- |
| 执行器生命周期 | lifecycle   | pytest `tests/dv`                                                             | 依赖门、check/install/configure 顺序与失败传播正确 | `tests/dv/test_execution.py`                | covered        |                     |
| 主流程         | main        | pytest `tests/dv`                                                             | 串行计划按依赖顺序执行并采集结果                   | `tests/dv/test_execution.py`                | covered        |                     |
| 失败流程       | failure     | pytest `tests/dv`                                                             | 步骤失败阻断后续依赖步骤                           | `tests/dv/test_execution.py`                | covered        |                     |
| 配置变体       | config      | pytest `tests/unit/test_config_planning.py`                                   | 每机参数覆盖与版本传递                             | `tests/unit/test_config_planning.py`        | covered        |                     |
| 持久状态恢复   | persistence | not-applicable: 本任务不引入持久状态，集群目录由 prepare 原子发布机制另行验证 | not-applicable                                     | `examples/.../test_prepare_multipass_sh.py` | not-applicable | 无新增持久状态      |

## Integration Tests

| Contract or Flow                | Modules Involved                          | Success Case                             | Failure Case                 | Test File                                                           | Status  | Gap / Manual Reason         |
| ------------------------------- | ----------------------------------------- | ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------- | ------- | --------------------------- |
| CLI validate/plan/check/install | config → planning → cli                   | bound/generic CLI 生成正确环境 id 的计划 | 未知机器/配置错误返回 2      | `tests/integration/test_project_cli.py`                             | covered |                             |
| 远程模板渲染                    | config → planning → execution → transport | 新夹具下远程 configure 渲染模板成功      | 脚本失败以执行结果返回       | `tests/integration/test_remote_runtime.py`                          | covered |                             |
| 示例生成集群                    | cluster-template → config → planning      | 新布局 generate 集群装载并生成 14 步计划 | 旧布局/占位哈希在 SSH 前被拒 | `examples/.../test_config_contract.py`、`test_artifact_contract.py` | covered |                             |
| prepare 信任包                  | prepare 脚本 → cluster-template → 发布    | bash fake-multipass 生成新布局 bundle    | IP/host key/权限/锁失败关闭  | `examples/.../test_prepare_multipass_sh.py`                         | covered |                             |
| README/CLI 一致                 | 示例 README ↔ eleph-deploy                | 文档命令与生成路径可执行                 | 文档漂移导致断言失败         | `examples/.../test_readme_contract.py`                              | covered |                             |
| pwsh 解析与密钥生成             | prepare-multipass.ps1                     | pwsh 存在时解析/生成通过                 | 无 pwsh 时用例失败           | `examples/.../test_bootstrap.py`                                    | gap     | 本机无 pwsh（既有环境缺口） |

## Regression Focus

- 回归面：`cluster.environments` 键语义（环境名 →
  机器名/环境名）、环境脚本相对路径（`scripts/`、`templates/` 不变）、CLI 环境 id 输出（保持
  `机器/环境`）、依赖拓扑顺序（与旧布局完全一致）。
- 已知历史相关：旧 `.state/clusters/multipass` 迁移与 prepare 原子发布断言保持通过（bash prepare
  测试覆盖）。

## Definition of Done

- [x] 覆盖所有直接变更项与对应风险档案中的 `required_checks`（KR-001 至 KR-004 由
      VAL-001/VAL-003/VAL-001/VAL-007 落地）。
- [x] 每个实现的 `change_id` 有 direct change 行、case-type 行与可运行 testplan 步骤。
- [x] 所有新增/修改测试通过统一测试入口的运行证据记录。
- [x] 明确记录环境缺口（pwsh 不可用）及其验收影响。
