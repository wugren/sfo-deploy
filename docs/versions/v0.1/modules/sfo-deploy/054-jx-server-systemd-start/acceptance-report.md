# 内置 versioned 发布与 Multipass 示例迁移验收报告

## Findings

| ID    | Severity | Owning Stage | Correctness Category | Evidence                                                                                                                                                                                                                                                                                                                                       | Problem                            | Blocking |
| ----- | -------- | ------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------- |
| F-000 | none     | none         | overall              | `proposal.md`、`design.md`、`src/config.ts`、`src/planning.ts`、`src/remote_runtime/versioned_release.ts`、`src/execution.ts`、`src/history.ts`、`tests/unit/app_management_config.test.ts`、`tests/integration/versioned_release.test.ts`、`.harness/test-results/test-runs/20260906T174548Z-sfo-deploy+054-jx-server-systemd-start-all.json` | 独立缺陷搜索未发现阻断或非阻断缺陷 | no       |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-07
- In-scope implementation: App v4 `deployment.kind: versioned`、无 `scripts.deploy`
  的默认内置发布、框架远端版本目录发布/latest/标记/清理/回滚、jx-server 与 jx-web
  示例迁移、公共类型导出、文档与测试契约。
- Review mode: independent falsification; conclusion selected after findings and category review

## Requirement Coverage

| change_id                            | Requirement or Boundary                                                                                 | Source                                                      | Implementation Evidence                                                                                                         | Finding                                   | Status |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------ |
| CHG-versioned-deployment-schema      | v4 支持 `deployment.kind: versioned`；无 custom deploy 默认启用；冲突、packageless、run_as 缺失失败关闭 | `proposal.md` P-001；`design.md` File-Level Interfaces      | `src/types.ts`、`src/config.ts`、`src/planning.ts`、`tests/unit/app_management_config.test.ts`                                  | no requirement defect or missing behavior | pass   |
| CHG-versioned-deployment-execution   | 框架内置版本目录、VERSION、latest、当前标记、清理和回滚；发布成功后 managed 收敛                        | `proposal.md` P-002；`design.md` Key Flows                  | `src/remote_runtime/versioned_release.ts`、`src/remote_runtime/artifact.ts`、`src/execution.ts`、`src/history.ts`、`src/cli.ts` | no requirement defect or missing behavior | pass   |
| CHG-packaged-app-versioned-migration | jx-server/jx-web 删除自定义 deploy，统一 latest 布局；jx-server service 从 current 启动                 | `proposal.md` P-003；`design.md` Consumer Migration Closure | `examples/eleph-server-multipass/cluster-template/apps/**`、live 集群副本、`examples/eleph-server-multipass/README.md`          | no requirement defect or missing behavior | pass   |
| CHG-versioned-deployment-docs-tests  | README/指南、契约测试和统一测试入口同步                                                                 | `proposal.md` P-004；`design.md` Implementation Order       | `README.md`、`docs/guides/sfo-deploy-cluster-configuration.md`、`testing.md`、`testplan.yaml`、最终 all run artifact            | no requirement defect or missing behavior | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                                                  | Evidence Inspected                                                                                                                          | Adversarial Check                                                                 | Finding or Not-Applicable Reason | Status |
| ----------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------- | ------ |
| requirement-and-behavior      | deployment schema、默认路由、包根布局、latest/标记语义            | proposal P-001/P-002/P-003；loader、planner、release script                                                                                 | 搜索 custom deploy 被覆盖、packageless 被误启用、路径语义漂移或 secret 集合扩大   | no defect found                  | pass   |
| logic-and-control-flow        | builtin invocation 注入、执行顺序、发布/配置/服务收敛、同版本跳过 | `planning.ts`、`execution.ts`、`versioned_release.ts`、`service_management.ts`                                                              | 挑战 deploy/configure 顺序、service 收敛时机、冲突脚本和 managed actions 为空分支 | no defect found                  | pass   |
| boundary-and-input            | 版本名、App 名、install_directory、包目录、keep_versions          | `config.ts`、`versioned_release.ts`、`tests/unit/app_management_config.test.ts`、`tests/integration/versioned_release.test.ts`              | 验证 `..`、`/`、尾斜杠、符号链接、raw package、越界版本与非法 keep 值失败关闭     | no defect found                  | pass   |
| state-and-data-integrity      | release root、VERSION、latest、当前标记、快照                     | release script 状态机；`history.ts` codec；history tests                                                                                    | 检查 marker 丢失时拒绝替换 latest、标记失败恢复、旧版本保留、旧快照 decode        | no defect found                  | pass   |
| error-handling-and-recovery   | 发布失败、latest 切换失败、managed config/service 失败            | release script rollback；execution recovery；DV tests                                                                                       | 挑战部分发布、恢复不完整、清理误删和取消/锁路径                                   | no defect found                  | pass   |
| resource-lifetime-and-cleanup | workspace、stage、latest temp、marker temp、旧版本                | release script finally；remote deployment cleanup；DV isolation tests                                                                       | 检查成功/失败/取消和重复执行不泄漏临时资源                                        | no defect found                  | pass   |
| concurrency-and-ordering      | App/目标锁、release attempt、服务收敛前脚本完成                   | `tests/dv/execution.test.ts`、`tests/integration/managed_transport_security.test.ts`                                                        | 检查并发计划、锁释放和目标隔离                                                    | no defect found                  | pass   |
| interface-and-compatibility   | 公共类型、旧 v2/v3/v4 快照、CLI plan JSON、自定义 deploy          | `src/mod.ts`、`tests/contract/app_management_consumer.ts`、`tests/unit/history.test.ts`、`tests/contract/verify_app_management_contract.ts` | 验证新增导出、旧计划兼容、CLI 展示和 custom deploy 仍可用                         | no defect found                  | pass   |
| security-and-capacity         | 远端脚本权限、包大小/成员、秘密集合、install root 提权            | `artifact.ts`、`remote_deployment.ts`、`versioned_release.ts`、transport tests                                                              | 检查无 net、固定 run 白名单、无秘密注入、拒绝危险包/目录、包上限保持              | no defect found                  | pass   |
| test-adequacy                 | schema、执行、状态、兼容、文档和示例                              | `testing.md`、`testplan.yaml`、最终任务级 all run artifact                                                                                  | 搜索可逃过覆盖的正常/边界/失败/兼容路径；unit/dv/integration/contract/lint 全绿   | no adequacy defect found         | pass   |

## Document Consistency

| Document | Source                              | Implementation Consistency                                                            | Finding     | Status |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------- | ----------- | ------ |
| design   | `design.md`                         | builtin 类型/计划/执行/发布算法与实现一致；API 新导出与 testplan 记录一致             | no mismatch | pass   |
| testing  | `testing.md` and/or `testplan.yaml` | 四个 change_id、case types、contract/unit/DV/integration 步骤与最终 run artifact 一致 | no mismatch | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 普通带包 App 已可由框架内置发布到版本目录并原子切换 latest；jx-server/jx-web
  示例迁移完成；managed service 和既有自定义 deploy 兼容性保持；最终任务级统一入口全绿。
- Blocking issues: none
- Residual risk: 本地自动化未执行真实 Multipass SSH 部署；已有旧 jx-web
  符号链接布局需按文档人工迁移后使用新内置流程。
- Next action: 记录 acceptance receipt 并完成任务索引归档。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason:
  独立审查覆盖所有必需缺陷类别，未发现阻断缺陷；实现、测试、文档和最终任务级运行制品支持批准的需求边界。
