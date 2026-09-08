# App v4 managed 资源统一声明验收报告

## Findings

| ID    | Severity | Owning Stage | Correctness Category | Evidence                                                                                                                                                                                                                                                                                                                                     | Problem                            | Blocking |
| ----- | -------- | ------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------- |
| F-000 | none     | none         | overall              | `proposal.md`、`design.md`、`src/config.ts`、`src/systemd_unit.ts`、`src/execution.ts`、`src/history.ts`、`tests/unit/app_management_config.test.ts`、`tests/unit/systemd_unit.test.ts`、`tests/dv/app_management_execution.test.ts`、`.harness/test-results/test-runs/20260906T094537Z-sfo-deploy+052-unify-app-management-schema-all.json` | 独立缺陷搜索未发现阻断或非阻断缺陷 | no       |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-06
- In-scope implementation: `app.yaml` schema v4 的 `management.actions` 统一声明；`kind: config` 与
  `kind: service` 两类 managed 资源；service `unit_config` 的 working directory、固定命令/参数和
  systemd unit 渲染/发布；计划快照、执行事务、文档示例与测试。
- Review mode: independent falsification; conclusion selected after findings and category review

## Requirement Coverage

| change_id                         | Requirement or Boundary                                                                 | Source                                                      | Implementation Evidence                                                                                                                                                                                          | Finding                                   | Status |
| --------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------ |
| CHG-unified-app-action-schema     | v4 只用 `management.actions` 承载 config/service，禁止旧字段和未知 kind，动作所有权唯一 | `proposal.md` P-001；`design.md` File-Level Interfaces      | `src/config.ts` 的 `appManagementV4`/`systemdServiceV4`/`systemdUnitConfig`；`tests/unit/app_management_config.test.ts` 正负例                                                                                   | no requirement defect or missing behavior | pass   |
| CHG-unified-app-action-consumers  | service unit 生成候选并复用原子发布、daemon-reload/服务收敛、快照往返和恢复             | `proposal.md` P-002；`design.md` Key Flows                  | `src/systemd_unit.ts`、`src/execution.ts`、`src/history.ts`、`src/cli.ts`；`tests/unit/history.test.ts`、`tests/dv/app_management_execution.test.ts`                                                             | no requirement defect or missing behavior | pass   |
| CHG-unified-app-action-docs-tests | README、指南和 nginx 示例同步 v4，公共导出/编译/格式/lint 闭环                          | `proposal.md` P-003；`design.md` Consumer Migration Closure | `README.md`、`docs/guides/sfo-deploy-cluster-configuration.md`、`examples/eleph-server-multipass/cluster-template/apps/nginx/app.yaml`、`tests/contract/verify_app_management_contract.ts`、testplan C1-C3 与 I4 | no requirement defect or missing behavior | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                                                          | Evidence Inspected                                                                                                                                                                         | Adversarial Check                                                                    | Finding or Not-Applicable Reason | Status |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------- | ------ |
| requirement-and-behavior      | v4 config/service、unit_config、working directory、固定命令/参数、无 hook | proposal P-001/P-002/P-003；loader 与 executor 实现                                                                                                                                        | 检查是否存在旧字段泄漏、hook 恢复、动态变量扩大或动作所有权重复                      | no defect found                  | pass   |
| logic-and-control-flow        | v4 actions 归一、路径解析、unit 候选发布和服务收敛顺序                    | `appManagementV4`、`serviceUnitManagedConfig`、`generateSystemdUnitSkeleton`、`DeploymentExecutor`                                                                                         | 挑战重复 service、config/unit 目标冲突、systemd/静态候选分支和 deploy/configure 顺序 | no defect found                  | pass   |
| boundary-and-input            | schema 字段、相对/绝对路径、空参数、systemd 元字符                        | `src/config.ts` 路径校验；`src/systemd_unit.ts` 渲染器；`tests/unit/app_management_config.test.ts`、`tests/unit/systemd_unit.test.ts`                                                      | 验证 `..`、绝对/相对混用、target 不匹配、`$`/`%`/控制字符/引号/反斜杠 fail closed    | no defect found                  | pass   |
| state-and-data-integrity      | managed config/unit 发布、备份、恢复、快照                                | `src/transport.ts` 事务；`src/history.ts` encode/decode；`tests/unit/history.test.ts`                                                                                                      | 检查 unitConfig 往返、旧快照 decode、changed/unchanged 和发布失败恢复                | no defect found                  | pass   |
| error-handling-and-recovery   | 配置发布、服务收敛、生命周期失败                                          | `src/execution.ts` recovery；`src/service_management.ts`；`tests/dv/app_management_execution.test.ts`                                                                                      | 检查 hook 失败、发布失败、systemd 状态恢复和 partial recovery 记录                   | no defect found                  | pass   |
| resource-lifetime-and-cleanup | 部署包、候选文件、秘密副本、锁和工作区                                    | `src/execution.ts` static candidate cleanup；transport/lock 回归                                                                                                                           | 挑战成功、失败、取消和重复清理路径                                                   | no defect found                  | pass   |
| concurrency-and-ordering      | App/目标锁、release attempt、多目标执行                                   | `tests/dv/execution.test.ts`、`tests/integration/managed_transport_security.test.ts`                                                                                                       | 检查锁顺序、争用、取消和跨目标隔离                                                   | no defect found                  | pass   |
| interface-and-compatibility   | 公共导出、v2/v3/v4 装载、计划快照和 CLI 展示                              | `src/mod.ts`、`tests/contract/app_management_consumer.ts`、`tests/contract/verify_app_management_contract.ts`、`tests/unit/history.test.ts`                                                | 验证 v2/v3 回归、v4 新导出、JSON 展示和示例契约                                      | no defect found                  | pass   |
| security-and-capacity         | unit 文件特权发布、路径越界、命令/参数注入、部署包大小                    | `src/systemd_unit.ts`、`src/config.ts`、`src/deployment_bundle.ts`、`tests/integration/remote_deployment.test.ts`                                                                          | 检查越界路径、systemd 展开字符、root/root/0644、成员大小/数量限制                    | no defect found                  | pass   |
| test-adequacy                 | schema、unit 渲染、执行事务、快照、文档契约和全量回归                     | `testing.md`、`testplan.yaml`、`tests/unit/*`、`tests/dv/*`、`tests/integration/*`、`.harness/test-results/test-runs/20260906T094537Z-sfo-deploy+052-unify-app-management-schema-all.json` | 搜索可逃过测试的正常/边界/失败/兼容路径；全量 239 例和 lint/check 通过               | no adequacy defect found         | pass   |

## Document Consistency

| Document | Source                              | Implementation Consistency                                                                    | Finding     | Status |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------- | ----------- | ------ |
| design   | `design.md`                         | v4 loader、systemd unit 渲染、发布/收敛和快照方案与实现一致；API 影响按向后兼容的新增导出记录 | no mismatch | pass   |
| testing  | `testing.md` and/or `testplan.yaml` | 三个 change_id、case types、contract checks、unit/DV/integration 步骤与实际测试和运行制品一致 | no mismatch | pass   |

## Result Summary

- Overall result: accepted
- Outcome: v4 统一 managed 资源声明、service unit_config、unit
  渲染/发布、快照与文档测试契约均满足批准范围；最终任务级统一入口全绿。
- Blocking issues: none
- Next action: 记录 acceptance receipt 并完成任务索引归档。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason:
  独立审查覆盖所有必需缺陷类别，未发现阻断缺陷；实现、测试、文档和最终任务级运行制品支持批准的需求边界。
