---
task_manifest: task.yaml
status: approved
---

# 内置 versioned 单顶层目录剥离测试

Risk profile: ./risk-profile.yaml

## Test Document Index

not-applicable: 改动集中在 versioned release runtime 与 Multipass App 契约，不新增产品子模块。

## Unified Test Entry

```bash
UV_CACHE_DIR=.harness/uv-cache uv run --active python ./harness/scripts/test-run.py sfo-deploy/080-remove-jx-server-package-root all
```

该命令执行本任务的 contract、unit、DV 和 integration 步骤，并生成机器可读运行工件。

## Submodule Tests

not-applicable: 无新增业务子模块。

## Module-Level Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| app 配置路径 | runtime | task all U1 | 安装目录变量解析为版本根路径；服务声明装载正确 | tests/unit/app_management_config.test.ts | covered | |
| 部署事务 | lifecycle | task all D1 | stage/activate/restore 顺序不变 | tests/dv/versioned_deploy_order.test.ts | covered | |
| 单顶层剥离 | boundary | task all I1 | `package/server/app` 发布为 `version/app`，无 `version/server` | tests/integration/versioned_release.test.ts | covered | |
| 多顶层保留 | compatibility | task all I1 | 多顶层包保持 `version/server` 与 `version/other` | tests/integration/versioned_release.test.ts | covered | |
| 内层包安全校验 | security | task all I1 | 恶意 tar 在解包前失败关闭 | tests/integration/remote_deployment.test.ts | covered | |
| Multipass 配置契约 | integration | task all I1 | jx-server 使用 `latest/jx-server.jar` 和 `latest/resources/`，jx-web 载荷在 latest 根 | tests/integration/versioned_release.test.ts | covered | |
| 真实 Multipass 部署 | manual | 2026-09-11 deploy log | 新版本无 `server`/`web` 层，部署成功 | shell session evidence | covered | 用户授权的真实部署只执行一次作为最终验收证据 |

## External Interface Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| executor -> versioned release | execution, remote runtime | validated directory stage 到版本根；单顶层目录自动剥离 | package kind 或目录边界非法时失败 | tests/integration/versioned_release.test.ts | covered | |
| transport -> validated package | remote deployment, execution | tar 列表/类型/路径校验后安全解包 | 绝对路径、父目录、链接、设备或重复成员失败 | tests/integration/remote_deployment.test.ts | covered | |

## Direct Change Coverage

| change_id | design_source | validation_id | testplan_level | testplan_step_id | gap | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-remove-jx-server-package-root | design.md | VAL-080-CONFIG, VAL-080-STRIP, VAL-080-PRESERVE, VAL-080-SECURITY, VAL-080-COMPILE | unit | U1 | no | VAL-080-PRESERVE、VAL-080-SECURITY 映射到 I1；VAL-080-COMPILE 映射到 C1/C2 |

## Case-Type Coverage

| change_id | case_type | required | validation_id | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| CHG-remove-jx-server-package-root | normal | yes | VAL-080-STRIP | integration | covered | |
| CHG-remove-jx-server-package-root | boundary | yes | VAL-080-PRESERVE | integration | covered | |
| CHG-remove-jx-server-package-root | negative | yes | VAL-080-PRESERVE | integration | covered | 旧实现复制整个包时 `version/server` 存在，新断言失败 |
| CHG-remove-jx-server-package-root | error | yes | VAL-080-SECURITY | integration | covered | |
| CHG-remove-jx-server-package-root | compatibility | yes | VAL-080-PRESERVE | integration | covered | |
| CHG-remove-jx-server-package-root | lifecycle | yes | VAL-080-TRANSACTION | dv | covered | |
| CHG-remove-jx-server-package-root | cross-module | yes | VAL-080-CONFIG | integration | covered | 配置契约在 I1 与编译闭包共同覆盖 |

## Design Element Coverage

| element_type | design_source | derived_cases | level | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| parameter-domain | design.md File-Level Interfaces | `resolveSingleRootPayload` 的单顶层/多顶层/平铺分支 | integration | covered | |
| error-handling | design.md Overall Approach | 隐藏文件、普通文件或多目录阻止剥离 | integration | covered | |
| state-transition | design.md State and Ownership | stage 后 activate/restore 不重复解释布局 | dv | covered | |
| failure-path | design.md Key Flows | 内层 tar 非法在解包前失败 | integration | covered | |
| invariant | design.md Design Notes | transport 校验和 versioned stage 职责边界 | integration | covered | |
| concurrency | design.md Design Notes | 未新增并发路径；沿用单 App 操作锁 | not-applicable | not-applicable | 设计明确未引入并发修改 |

## Validation Rationale

integration 使用真实本地文件系统和受限 Deno runtime，可以直接验证复制结果而不是仅断言命令；
DV 保持既有 stage/activate/restore 顺序证据；contract 编译闭包确认配置契约与导出类型没有漂移。
真实 Multipass 是用户要求的最终系统证据，但不可重复自动化，因此单独记录。

## Unit Tests

| function_or_unit | branch_or_condition | covered_behavior | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- |
| app config normalization | `${INSTALL_DIRECTORY}` 与 service config | 版本根配置路径和 run_as 解析 | tests/unit/app_management_config.test.ts | covered | |

## DV Tests

| workflow | kind | entry | expected_result | test_file_or_script | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| stage and activate | main | task all D1 | validated package stages then activates | tests/dv/versioned_deploy_order.test.ts | covered | |
| stage/activate/restore | lifecycle | task all D1 | 事务顺序与失败恢复不变 | tests/dv/versioned_deploy_order.test.ts | covered | |
| restore on later failure | failure | task all D1 | 服务/marker 失败恢复 latest/marker | tests/dv/versioned_deploy_order.test.ts | covered | |

## Integration Tests

| contract_or_flow | modules_involved | success_case | failure_case | test_file | status | gap_manual_reason |
| --- | --- | --- | --- | --- | --- | --- |
| unique wrapper root | versioned release | `server/` 或 `web/` 内容提升到版本根 | 不满足单顶层目录时不剥离 | tests/integration/versioned_release.test.ts | covered | |
| multi-root preservation | versioned release | 多顶层成员原样复制 | 无 | tests/integration/versioned_release.test.ts | covered | |
| inner archive security | remote deployment | 安全 tar 解包为 validated directory | 非法成员在 extract 前拒绝 | tests/integration/remote_deployment.test.ts | covered | |
| Multipass app contract | config, remote runtime | jx-server/jx-web 路径契约一致 | 配置漂移时失败 | tests/integration/versioned_release.test.ts | covered | |

## Definition of Done

- 任务统一入口 `all` 成功并生成机器可读运行工件。
- `deno task check` 通过；任务相关 fmt/lint 通过。
- 全量 `deno task test` 通过（308 passed / 0 failed）。
- 真实 Multipass 部署成功，并复核 `latest/jx-server.jar`、`latest/resources/`、
  `/home/projects/ui/latest/index.html` 存在且新版本无 `server`/`web` 层。
