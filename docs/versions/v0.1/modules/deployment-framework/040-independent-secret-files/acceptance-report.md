---
task_manifest: task.yaml
status: approved
---

# 040-independent-secret-files 独立验收报告

## Object and Scope

- Task manifest: task.yaml
- Review mode: independent；验收轮重新读取提案、设计、实现、测试与运行工件，先构造失败假设再下结论
- Runtime evidence:
  `.harness/test-results/test-runs/20260904T042359Z-deployment-framework+040-independent-secret-files-all.json`

## Findings

| ID    | Severity | Owning Stage | Correctness Category     | Evidence                                                                                                                                                                                                                                                                   | Problem                                      | Blocking |
| ----- | -------- | ------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------- |
| F-001 | none     | none         | requirement-and-behavior | `src/secrets.ts` `loadClusterSecretSource`、`src/integration.ts` `runSecretsDeploy`/`discoverClusterKnownHosts`、`tests/unit/cluster_secret_source.test.ts`、`.harness/test-results/test-runs/20260904T042359Z-deployment-framework+040-independent-secret-files-all.json` | 独立证伪未发现阻断缺陷；交付与已确认提案一致 | no       |

## Requirement Coverage

| change_id                    | Requirement Or Boundary                                                                              | Source           | Implementation Evidence                                                                                                                                                                                  | Finding    | Status |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| CHG-cluster-secret-source    | P1-1：通用 CLI 自动装载集群本地 `secrets.yaml`，顶层键直接对应密钥名；value/file 按 cluster 声明分派 | proposal.md P1-1 | `src/secrets.ts` `clusterSecretSourcePath/loadClusterSecretSource`；`src/integration.ts` `runSecretsDeploy` 仅在部署时装载；`tests/unit/cluster_secret_source.test.ts`、`tests/unit/secrets_cli.test.ts` | 未发现缺陷 | pass   |
| CHG-cluster-known-hosts      | P1-2：通用 CLI 自动发现并使用集群目录 `known_hosts`，显式 transport/knownHosts 优先                  | proposal.md P1-2 | `src/integration.ts` `discoverClusterKnownHosts` 与默认 OpenSSH transport 接线；`tests/unit/cluster_secret_source.test.ts`                                                                               | 未发现缺陷 | pass   |
| CHG-multipass-no-binding-cli | P1-3：Multipass 不再用 `src/cli.ts` 构造 ProjectBindings，使用通用 CLI 与 `secrets.yaml`             | proposal.md P1-3 | `examples/eleph-server-multipass/deno.json` task、示例 README、删除绑定入口；真实只读 `secrets-deploy --check` 到 `eleph-server` 返回预期 missing                                                        | 未发现缺陷 | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                                              | Evidence Inspected                                                                                            | Adversarial Check                                                                                                      | Finding Or Not Applicable Reason                   | Status |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------ |
| requirement-and-behavior      | 单一 YAML、顶层键、值/文件来源、无绑定脚本入口                | proposal.md、design.md、`src/secrets.ts`、`src/integration.ts`、示例 `deno.json`/README                       | 对照三个 proposal item 与真实 Multipass `--check` 输出逐条证伪；确认 `--check` 不要求 `secrets.yaml` 且不触发 JAR 预检 | 对照需求逐条核验后未发现缺失、缩小或越界行为       | pass   |
| logic-and-control-flow        | YAML 键映射、kind 分派、部署操作分支                          | `loadClusterSecretSource`、`runSecretsDeploy`、`prepareSecretDeployments` 调用链                              | 构造未知键、缺少声明键、value/file 混用、部署/校验/移除分支反例；单元测试覆盖分派与操作差异                            | 分支映射与操作流程未发现逻辑缺陷                   | pass   |
| boundary-and-input            | YAML 权限、空值、非法键名、路径、重复键                       | `requireSecretSourceFile`、YAML 解析、`ProjectBindings` 校验、`tests/unit/cluster_secret_source.test.ts`      | 尝试 0644、空值、非法键、绝对路径、反斜杠、`..`、目录逃逸和不可读文件；均失败关闭                                      | 边界输入均在 SSH 前拒绝，未发现缺陷                | pass   |
| state-and-data-integrity      | 本地秘密来源、远端清单、临时暂存                              | `src/transport.ts` 原子部署与清单、`src/integration.ts` 临时目录、`tests/unit/secrets_transport.test.ts`      | 检查幂等重跑、部分失败重试、临时目录清理和远端清单漂移                                                                 | 状态写入和清理路径未发现完整性缺陷                 | pass   |
| error-handling-and-recovery   | 配置错误、preflight、SSH 失败、取消                           | `src/integration.ts` 错误分类与 outcome 聚合、`tests/dv/execution.test.ts`、`tests/unit/secrets_cli.test.ts`  | 构造缺失来源、连接失败、取消和步骤失败；确认失败关闭且不输出秘密值                                                     | 错误分类与恢复路径未发现缺陷                       | pass   |
| resource-lifetime-and-cleanup | secrets.yaml 读取、本地暂存、远端会话                         | `runSecretsDeploy` finally 清理、`PreparedExecution.close`、DV 证据                                           | 检查成功、失败、取消路径的临时目录与会话关闭；unit/DV/integration 工件通过                                             | 资源生命周期未发现泄漏或悬挂句柄                   | pass   |
| concurrency-and-ordering      | 多机器顺序执行、步骤依赖、会话复用                            | `src/execution.ts` 顺序执行模型、`tests/dv/execution.test.ts`                                                 | 检查依赖失败、目标失败、取消传播和重复步骤；现有 DV 断言覆盖顺序                                                       | 串行执行模型下未发现并发或顺序缺陷                 | pass   |
| interface-and-compatibility   | 通用 CLI、ProjectBindings 公共 API、示例 Deno task            | `src/cli.ts` 帮助、`src/mod.ts` 导出、`examples/eleph-server-multipass/deno.json`、contract C1/C2             | 验证 ProjectBindings 仍导出可用、CLI 结果结构保持稳定、示例入口改用通用 CLI 后编译与文档契约通过                       | 接口兼容与迁移路径未发现缺陷                       | pass   |
| security-and-capacity         | 明文 YAML、文件路径、known_hosts、远端权限                    | `requireSecretSourceFile`、路径限制、`src/transport.ts` 0700/0600、`tests/unit/cluster_secret_source.test.ts` | 检查弱权限、路径逃逸、符号链接、未声明键、错误输出和日志暴露；均被拒绝或脱敏                                           | 安全边界检查未发现泄漏或不安全默认                 | pass   |
| test-adequacy                 | 三个 change_id 的正常/边界/负向/错误/兼容/生命周期/跨模块覆盖 | testing.md、testplan.yaml、C1/C2、unit/dv/integration run artifact                                            | 审查断言强度和覆盖映射；确认没有只依赖通过结果，且真实 `--check` 与伪造传输测试互补                                    | 测试设计与运行证据足以暴露相关缺陷，未发现验证缺口 | pass   |

## Document Consistency

| Document | Source                    | Implementation Consistency                                 | Finding              | Status |
| -------- | ------------------------- | ---------------------------------------------------------- | -------------------- | ------ |
| design   | design.md                 | 装载器、known_hosts 发现、文件路径边界和变更映射与实现一致 | 逐节核对未发现不一致 | pass   |
| testing  | testing.md, testplan.yaml | 统一入口、覆盖表、合同检查与运行工件一致                   | 逐项核对未发现不一致 | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 通用 `secrets-deploy` 已支持集群本地 YAML 值/文件来源；known_hosts
  自动发现生效；Multipass 示例移除绑定脚本并可通过通用 CLI 执行只读检查；任务级统一测试全部通过
- Blocking issues: none recorded
- Next action: 无返工；如需部署实际密钥，可直接运行 `secrets-deploy`

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 独立证伪未发现需求、逻辑、边界、安全或验证缺陷；所有 change_id
  均有实现与测试证据，文档一致性通过
