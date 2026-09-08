---
task_manifest: task.yaml
status: draft
---

# App 版本配置、重打包与版本目录测试设计

Risk profile: ./risk-profile.yaml

## Test Document Index

- 根文档：`testing.md`（本文件），覆盖 sfo-deploy 模块整体。
- 子模块测试文档：无独立子模块层；模块分解见 `design.md` 的 Layered Design Document Index。
- 机器可读执行计划：`testplan.yaml`，由统一测试入口按任务作用域执行。

## Unified Test Entry

本任务全部测试通过仓库统一入口运行：`harness/scripts/test-run.py`（根目录快捷方式 `test-run.sh` /
`test-run.bat`）。任务作用域命令为
`UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/026-versioned-app-layout all`，
它先执行 testplan.yaml 的 contract steps，再按 `unit`、`dv`、`integration` 声明顺序执行任务测试。

## Submodule Tests

本任务在 sfo-deploy 模块下按文件级分解（配置装载、计划/历史、执行 metadata、示例脚本），没有独立
业务子模块，因此不建立 submodule 测试文档；文件级覆盖由单元测试表逐文件登记。

## Module-Level Tests

模块级行为由 `tests/dv/execution.test.ts`（执行器预检与 metadata）与
`tests/integration/deploy_version_skip.test.ts`（发布/跳过/hash/回滚契约）覆盖，并配合
`tests/integration/fetch_package.test.ts` 与 `tests/integration/independent_remote_scripts.test.ts`
验证跨组件数据流与脚本独立运行契约。

## External Interface Tests

远端脚本输入契约（context metadata 的 `package_hash`、`install_directory`、`scripts`、`templates`）
由独立脚本集成测试与执行器 DV 测试验证；示例集群配置契约（app_versions.yaml、app.yaml v2、
install_directory 校验）由配置单元测试与文档/闭包契约步骤验证。

## Direct Change Coverage

| change_id                | design_source                                                   | validation_id                          | testplan_level | testplan_step_id | gap | gap_manual_reason |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------- | -------------- | ---------------- | --- | ----------------- |
| CHG-versioned-app-layout | design.md P-001、State and Ownership、Key Flows                 | VAL-1, VAL-2, VAL-4, VAL-5, VAL-6      | integration    | I1               | no  | -                 |
| CHG-remote-package-hash  | design.md P-002、Key Flows、File-Level Interfaces               | VAL-7, VAL-8                           | integration    | I1               | no  | -                 |
| CHG-release-config       | design.md P-004、Module Relationship UML、File-Level Interfaces | VAL-9, VAL-10                          | unit           | U1               | no  | -                 |
| CHG-repackage            | design.md P-005、Key Flows、External Interface Tests            | VAL-11, VAL-12, VAL-13, VAL-14, VAL-15 | integration    | I1               | no  | -                 |
| CHG-docs                 | design.md P-003、Consumer Migration Closure                     | VAL-16, VAL-17                         | integration    | I4               | no  | -                 |

## Case-Type Coverage

| change_id                | case_type     | required | validation_id | level       | status  | gap_manual_reason |
| ------------------------ | ------------- | -------- | ------------- | ----------- | ------- | ----------------- |
| CHG-versioned-app-layout | normal        | yes      | VAL-5         | integration | covered | -                 |
| CHG-versioned-app-layout | boundary      | yes      | VAL-1         | unit        | covered | -                 |
| CHG-versioned-app-layout | negative      | yes      | VAL-1         | unit        | covered | -                 |
| CHG-versioned-app-layout | error         | yes      | VAL-5         | integration | covered | -                 |
| CHG-versioned-app-layout | compatibility | yes      | VAL-2         | unit        | covered | -                 |
| CHG-versioned-app-layout | lifecycle     | yes      | VAL-5         | integration | covered | -                 |
| CHG-versioned-app-layout | cross-module  | yes      | VAL-6         | integration | covered | -                 |
| CHG-remote-package-hash  | normal        | yes      | VAL-7         | integration | covered | -                 |
| CHG-remote-package-hash  | boundary      | no       | VAL-7         | integration | covered | -                 |
| CHG-remote-package-hash  | negative      | yes      | VAL-7         | integration | covered | -                 |
| CHG-remote-package-hash  | error         | yes      | VAL-7         | integration | covered | -                 |
| CHG-remote-package-hash  | compatibility | no       | VAL-8         | dv          | covered | -                 |
| CHG-remote-package-hash  | lifecycle     | no       | VAL-7         | integration | covered | -                 |
| CHG-remote-package-hash  | cross-module  | no       | VAL-8         | dv          | covered | -                 |
| CHG-release-config       | normal        | yes      | VAL-9         | unit        | covered | -                 |
| CHG-release-config       | boundary      | yes      | VAL-9         | unit        | covered | -                 |
| CHG-release-config       | negative      | yes      | VAL-9         | unit        | covered | -                 |
| CHG-release-config       | error         | yes      | VAL-10        | integration | covered | -                 |
| CHG-release-config       | compatibility | yes      | VAL-9         | unit        | covered | -                 |
| CHG-release-config       | lifecycle     | no       | VAL-10        | integration | covered | -                 |
| CHG-release-config       | cross-module  | yes      | VAL-10        | integration | covered | -                 |
| CHG-repackage            | normal        | yes      | VAL-13        | integration | covered | -                 |
| CHG-repackage            | boundary      | yes      | VAL-11        | unit        | covered | -                 |
| CHG-repackage            | negative      | yes      | VAL-13        | integration | covered | -                 |
| CHG-repackage            | error         | yes      | VAL-13        | integration | covered | -                 |
| CHG-repackage            | compatibility | yes      | VAL-12        | dv          | covered | -                 |
| CHG-repackage            | lifecycle     | yes      | VAL-13        | integration | covered | -                 |
| CHG-repackage            | cross-module  | yes      | VAL-14        | integration | covered | -                 |
| CHG-docs                 | normal        | yes      | VAL-16        | integration | covered | -                 |
| CHG-docs                 | boundary      | no       | VAL-16        | integration | covered | -                 |
| CHG-docs                 | negative      | no       | VAL-17        | integration | covered | -                 |
| CHG-docs                 | error         | no       | VAL-17        | integration | covered | -                 |
| CHG-docs                 | compatibility | yes      | VAL-17        | integration | covered | -                 |
| CHG-docs                 | lifecycle     | no       | VAL-17        | integration | covered | -                 |
| CHG-docs                 | cross-module  | yes      | VAL-16        | integration | covered | -                 |

说明：contract steps 由统一入口按 integration 前置阶段执行，表中以 integration 作为其 level。

## Design Element Coverage

| element_type     | design_source                                                               | derived_cases                                                     | level       | status  | gap_manual_reason |
| ---------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------- | ------- | ----------------- |
| parameter-domain | design.md File-Level Interfaces（install_directory、package_hash、version） | v2 合并装载、v1 兼容、相对/`..` 路径拒绝、hash 格式拒绝、空包拒绝 | unit        | covered | -                 |
| state-transition | design.md State and Ownership                                               | current→publishing→published、失败→rollback→failed、同版本跳过    | integration | covered | -                 |
| failure-path     | design.md Key Flows                                                         | 远端 sha256 不匹配、健康检查失败回滚、tar/gzip 失败清理           | integration | covered | -                 |
| error-handling   | design.md Risks and Rollback                                                | gzip 拒绝（SSH 前）、配置缺失/多余 App 拒绝、回滚聚合错误         | unit        | covered | -                 |
| invariant        | design.md Design Notes                                                      | app_versions.yaml 与 app 目录全量闭合；模板/live 副本逐字节一致   | unit        | covered | -                 |
| concurrency      | design.md Key Flows                                                         | 执行器取消/资源清理顺序、原子 latest 切换幂等                     | dv          | covered | -                 |

## Validation Rationale

本计划把风险档案 required_checks 映射为可直接运行的验证：contract/data 由 U1/I2 覆盖配置契约与
文件一致性；security 由 U3/I1 覆盖 gzip 与 sha256sum 双门禁及路径拒绝；runtime 由 I1/D1 覆盖
发布/跳过/回滚与清理；harness 由统一入口任务作用域与 contract steps 覆盖。文档变更以
`documentation-examples` contract steps 校验示例编译与文档边界。

## Unit Tests

| function_or_unit           | branch_or_condition                               | covered_behavior                         | test_file                            | status  | gap_manual_reason |
| -------------------------- | ------------------------------------------------- | ---------------------------------------- | ------------------------------------ | ------- | ----------------- |
| loadAppVersions / loadApps | v2 合并、v1 只读兼容、v1+v2 混用拒绝              | app_versions.yaml 装载合并与 fail-closed | tests/unit/config_planning.test.ts   | covered | -                 |
| loadApps                   | install_directory 相对路径与 `..`                 | 非绝对 POSIX 路径 SSH 前拒绝             | tests/unit/config_planning.test.ts   | covered | -                 |
| loadAppVersions            | 缺失/多余 App 映射                                | 全量闭合检查                             | tests/unit/config_planning.test.ts   | covered | -                 |
| assertGzipTar              | gzip 魔数命中/未命中/短文件                       | App 包格式门禁                           | tests/unit/downloads_secrets.test.ts | covered | -                 |
| encodeStep / decodeStep    | install_directory/bundle_scripts 往返、旧快照缺省 | v3 codec 新字段与兼容                    | tests/unit/history.test.ts           | covered | -                 |

## DV Tests

| workflow                   | kind      | entry                                                       | expected_result                                                       | test_file_or_script        | status  | gap_manual_reason |
| -------------------------- | --------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------- | ------- | ----------------- |
| 执行器 metadata 注入与预检 | main      | tests/dv/execution.test.ts（executePlan + MemoryTransport） | package_hash/install_directory/templates 注入，gzip 门禁在 SSH 前生效 | tests/dv/execution.test.ts | covered | -                 |
| 取消/清理与资源生命周期    | lifecycle | tests/dv/execution.test.ts（CancellingTransport）           | 取消后清理全部远端与本地资源                                          | tests/dv/execution.test.ts | covered | -                 |
| 上传失败与准备失败         | failure   | tests/dv/execution.test.ts（ContextUploadFailingTransport） | 失败步骤隔离且资源清理完整                                            | tests/dv/execution.test.ts | covered | -                 |

## Integration Tests

| contract_or_flow             | modules_involved                       | success_case                                    | failure_case                             | test_file                                             | status  | gap_manual_reason |
| ---------------------------- | -------------------------------------- | ----------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- | ------- | ----------------- |
| 版本目录发布/latest/回滚契约 | jx-server deploy 脚本 + 框架 metadata  | 新版本发布到版本目录、切换 latest、重启并写标记 | 健康失败回滚重建 latest、hash 不匹配拒绝 | tests/integration/deploy_version_skip.test.ts         | covered | -                 |
| 同版本跳过契约               | 框架 + deploy 脚本                     | 版本标记一致时零远端修改                        | 无                                       | tests/integration/deploy_version_skip.test.ts         | covered | -                 |
| 模板与 live 副本一致契约     | cluster-template ↔ clusters/multipass  | 模板与 live deploy 脚本/app.yaml 逐字节一致     | 不一致即失败                             | tests/integration/deploy_version_skip.test.ts         | covered | -                 |
| fetch gzip 与缓存契约        | cli/integration + downloads + fixtures | gzip 包下载并缓存复用                           | 非 gzip 包在 fetch 时拒绝                | tests/integration/fetch_package.test.ts               | covered | -                 |
| 独立远端脚本契约             | 示例脚本 + context JSON                | 配置渲染/安装目录准备与上下文严格校验           | 缺字段/权限失败显式报错                  | tests/integration/independent_remote_scripts.test.ts  | covered | -                 |
| 文档与示例闭包契约           | README、指南、示例集群                 | 示例 TS 可编译且文档边界完整                    | 编译或文档断言失败                       | tests/contract/verify_environment_placement_config.ts | covered | -                 |

## Definition of Done

- testplan.yaml 的 unit/dv/integration 与 contract steps 全部可运行且通过；
- 统一入口任务作用域 `sfo-deploy/026-versioned-app-layout all` 成功并产出 run artifact；
- 每个 change_id 至少一条 Direct Change Coverage 记录且无未解释 gap；
- `deno task check`、`deno lint`、`deno fmt --check` 通过。
