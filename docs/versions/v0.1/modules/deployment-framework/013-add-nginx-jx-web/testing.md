---
task_manifest: task.yaml
status: approved
---

# packageless App 与 Multipass Nginx/jx-web 测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 App 生命周期和 Multipass 示例。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md`。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py
deployment-framework/013-add-nginx-jx-web all`。任务作用域始终使用
canonical packet module；先执行合同检查，再执行 unit、dv、integration。

## Submodule Tests

无独立业务子模块层。App 装载/规划（`src/config.ts`、`src/planning.ts`）、
发布历史（`src/history.ts`、`src/integration.ts`）、Multipass `nginx` 与 `jx-web` 脚本在文件级覆盖。

## Module-Level Tests

- `tests/unit/config_planning.test.ts` 覆盖 packageless YAML 装载、非法组合、 check/configure
  计划和普通 App 兼容。
- `tests/unit/history.test.ts` 覆盖 packageless 发布快照回退计划。
- `tests/integration/packageless_app_scripts.test.ts` 覆盖 Nginx 成功/重启失败 恢复，以及 jx-web
  发布、清理、链接拒绝。
- `tests/integration/environment_placement.test.ts` 覆盖模板集群装载和执行计划。

## External Interface Tests

- `fetch` 对 packageless App 输出 `apps_without_package`，仍下载普通 App。
- 发布历史接受 App `check/configure` 的 deploy 与 rollback 语义。
- Multipass 模板/live 集群可 validate；`nginx` 生成 check/configure，`jx-web` 生成 deploy。
- 远端脚本契约要求模板/live 脚本一致且不导入框架。

## Direct Change Coverage

| change_id           | design_source                                                                       | validation_id  | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ------------------- | ----------------------------------------------------------------------------------- | -------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-packageless-app | design.md File-Level Interfaces、Key Flows、State and Ownership、Risks and Rollback | VAL-01..VAL-11 | integration    | I1               | no  | -                 |
| CHG-nginx-app       | design.md Key Flows、State and Ownership、Consumer Migration Closure                | VAL-07..VAL-13 | integration    | I3               | no  | -                 |
| CHG-jx-web-app      | design.md Key Flows、State and Ownership、Risks and Rollback                        | VAL-09..VAL-13 | integration    | I3               | no  | -                 |

## Validation Rationale

测试由 proposal 的 packageless、Nginx 配置、代理和 jx-web 安全发布需求，以及 design.md
的接口、状态、失败路径和回退语义派生。单元验证 schema 和计划； DV 验证模板装载和依赖顺序；集成验证
fetch、历史、远端脚本、失败恢复和危险归档。

## Case-Type Coverage

| change_id           | case_type     | required | validation_id          | level       | status  | gap_manual_reason |
| ------------------- | ------------- | -------- | ---------------------- | ----------- | ------- | ----------------- |
| CHG-packageless-app | normal        | yes      | VAL-01、VAL-04、VAL-06 | unit        | covered | -                 |
| CHG-packageless-app | boundary      | yes      | VAL-02、VAL-03         | unit        | covered | -                 |
| CHG-packageless-app | negative      | yes      | VAL-03、VAL-05         | unit        | covered | -                 |
| CHG-packageless-app | error         | yes      | VAL-05、VAL-08         | integration | covered | -                 |
| CHG-packageless-app | compatibility | yes      | VAL-02、VAL-08、C2     | integration | covered | -                 |
| CHG-packageless-app | lifecycle     | yes      | VAL-04、VAL-06、VAL-08 | integration | covered | -                 |
| CHG-packageless-app | cross-module  | yes      | VAL-07、VAL-08、C2     | integration | covered | -                 |
| CHG-nginx-app       | normal        | yes      | VAL-09、VAL-12         | integration | covered | -                 |
| CHG-nginx-app       | boundary      | yes      | VAL-10                 | integration | covered | -                 |
| CHG-nginx-app       | negative      | yes      | VAL-10、C2             | integration | covered | -                 |
| CHG-nginx-app       | error         | yes      | VAL-10                 | integration | covered | -                 |
| CHG-nginx-app       | compatibility | yes      | C1、C2                 | integration | covered | -                 |
| CHG-nginx-app       | lifecycle     | yes      | VAL-09、VAL-10         | integration | covered | -                 |
| CHG-nginx-app       | cross-module  | yes      | VAL-11、C2             | integration | covered | -                 |
| CHG-jx-web-app      | normal        | yes      | VAL-11、VAL-12         | integration | covered | -                 |
| CHG-jx-web-app      | boundary      | yes      | VAL-11、VAL-13         | integration | covered | -                 |
| CHG-jx-web-app      | negative      | yes      | VAL-13                 | integration | covered | -                 |
| CHG-jx-web-app      | error         | yes      | VAL-10、VAL-13         | integration | covered | -                 |
| CHG-jx-web-app      | compatibility | yes      | C1、C2                 | integration | covered | -                 |
| CHG-jx-web-app      | lifecycle     | yes      | VAL-11                 | integration | covered | -                 |
| CHG-jx-web-app      | cross-module  | yes      | C2                     | integration | covered | -                 |

## Design Element Coverage

| element_type     | design_source                                                  | derived_cases                                             | level       | status  | gap_manual_reason |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------- | ----------- | ------- | ----------------- |
| parameter-domain | File-Level Interfaces 的 packageless/version/package 输入域    | true、false/缺失、多余版本、缺 check/configure、多 deploy | unit        | covered | -                 |
| state-transition | State and Ownership 的 packageless 展开、发布状态、latest 指针 | check→configure、同版本跳过、版本切换、旧版本清理         | integration | covered | -                 |
| failure-path     | Key Flows 的 nginx 重启失败与静态包失败                        | 重启失败恢复、危险成员拒绝、哈希不匹配                    | integration | covered | -                 |
| error-handling   | Risks and Rollback 的错误类别                                  | 非法 schema、脚本失败、tar 危险成员、配置恢复             | integration | covered | -                 |
| invariant        | State and Ownership 的旧配置与 latest 保护                     | 失败保留旧配置，发布失败不切换 latest                     | integration | covered | -                 |
| concurrency      | design.md（确定性串行执行）                                    | 串行计划与依赖顺序                                        | dv          | covered | -                 |

## Unit Tests

| function_or_unit   | branch_or_condition                        | covered_behavior                                            | test_file                          | status  | gap_manual_reason |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------- | ---------------------------------- | ------- | ----------------- |
| loadApps           | packageless true/false、版本条目、动作组合 | 显式 schema、禁止版本/包、强制 check/configure、禁止 deploy | tests/unit/config_planning.test.ts | covered | -                 |
| buildPlan          | packageless 与 package App                 | packageless 生成 check/configure，普通 App 不回归           | tests/unit/config_planning.test.ts | covered | -                 |
| deriveRollbackPlan | 有 deploy 与 packageless                   | 普通 rollback 不回归，packageless 保留 check/configure      | tests/unit/history.test.ts         | covered | -                 |

## DV Tests

| workflow                            | kind      | entry              | expected_result                   | test_file_or_script                             | status  | gap_manual_reason |
| ----------------------------------- | --------- | ------------------ | --------------------------------- | ----------------------------------------------- | ------- | ----------------- |
| multipass shared-definition cluster | main      | 模板复制为临时集群 | v2 装载、环境共享、App 放置可计划 | tests/integration/environment_placement.test.ts | covered | -                 |
| filters and dependency ordering     | failure   | 定向依赖与非法排除 | 非法依赖失败关闭                  | tests/integration/environment_placement.test.ts | covered | -                 |
| multipass rollback snapshot         | lifecycle | 归档发布计划       | 回退计划不读取当前目录布局        | tests/integration/environment_placement.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow              | modules_involved                | success_case                  | failure_case             | test_file                                            | status  | gap_manual_reason |
| ----------------------------- | ------------------------------- | ----------------------------- | ------------------------ | ---------------------------------------------------- | ------- | ----------------- |
| fetch 与 packageless 跳过     | cli → config → package cache    | 普通 App 下载并缓存           | 哨兵/缺缓存不连接 SSH    | tests/integration/fetch_package.test.ts              | covered | -                 |
| 远端脚本契约                  | config ↔ templates/live scripts | 模板/live 一致且可 Deno check | 数量或内容漂移失败       | tests/integration/independent_remote_scripts.test.ts | covered | -                 |
| nginx 生命周期                | planner → nginx configure       | 验证/替换/重启成功            | 重启失败恢复旧配置       | tests/integration/packageless_app_scripts.test.ts    | covered | -                 |
| jx-web 发布                   | planner → tar/sudo/文件系统     | 复验、解包、latest 切换、清理 | 符号链接或哈希不匹配拒绝 | tests/integration/packageless_app_scripts.test.ts    | covered | -                 |
| 发布历史 packageless rollback | planning → history              | check/configure 回放保留      | 缺少可回退 App 时失败    | tests/unit/history.test.ts                           | covered | -                 |

## Manual Gaps

| gap                                   | owner                           | reason                                     | acceptance impact                                                                            |
| ------------------------------------- | ------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 真实 Multipass VM 上部署 nginx/jx-web | 具备隔离 Multipass 环境的运维者 | 自动测试不启动真实 VM/systemd/filehub 服务 | 本地替身覆盖脚本逻辑和失败路径；真实网络、软件源、systemd 与宿主 HTTP 验收留作发布前人工验收 |

## Definition of Done

- `test-run.py deployment-framework/013-add-nginx-jx-web all` 全部通过并写运行工件。
- fmt/check/lint 通过；相关单元、DV、集成、合同检查通过。
- 真实 Multipass/systemd 验收记录为 manual gap，不由自动测试宣称完成。
