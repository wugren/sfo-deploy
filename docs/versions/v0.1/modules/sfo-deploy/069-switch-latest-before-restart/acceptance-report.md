# sfo-deploy 配置先发布与 latest 最后切换验收报告

## Findings
| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
|----|----------|--------------|----------------------|----------|---------|----------|
| F-000 | none | none | overall | 复审 `VersionedReleaseRequest.runAs`、marker `install -m 0640 -o runAs`、executor `requiredManagedRunAs`，以及真实 nobody 身份 marker 读取和同版本 stage 回归 | 本轮无未解决缺陷；首轮 F-069-001/F-069-002 已修复并由独立复验关闭，首轮报告存于 `pipeline/acceptance-round-1.md` | no |

## Object and Scope
- Task manifest: task.yaml
- Review date: 2026-09-09
- In-scope implementation: `src/execution.ts`、`src/planning.ts`、`src/versioned_release_management.ts`、`src/service_management.ts`、`src/transport.ts`、`src/remote_deployment.ts`、`src/history.ts` 及框架文档和测试。
- Review mode: independent falsification; conclusion selected after findings and category review。审查者未实现该变更；先读 proposal、正式 plan、生产与消费者代码及测试断言，再参考测试证据。未执行远端部署，也未修改 jx-server。

## Requirement Coverage
| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
|-----------|-------------------------|--------|-------------------------|---------|--------|
| CHG-configure-before-switch | 先发布候选版本配置，全部 stage 成功后逐目标最后切换并紧接服务动作；保留首次、同版本及失败恢复行为 | `proposal.md` P-001/P-002/P-003、Success Criteria | `deploymentConfigTarget`、`activateDeployment`、`prepareSystemd/executePreparedSystemd`、`recoverDeployment`、`normalizeVersionedSteps` | 操作顺序与事务边界符合要求；标记显式归应用账户所有，真实降权 stage 回归关闭首轮同版本兼容缺陷 | pass |

## Independent Defect Discovery
| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
|----------|------------------|-------------------|-------------------|---------------------------------|--------|
| requirement-and-behavior | 配置、激活、服务和同版本重试 | proposal P-001/P-003；`activateDeployment`；remote `stageRelease` | 用成功发布后的真实标记重新代入同版本消费者，而不是使用预造标记 | 修复后 marker uid 与 runAs 一致，应用读取及真实同版本 stage 成功；已批准意图无歧义 | pass |
| logic-and-control-flow | stage/activate 调度与失败传播 | `DeploymentExecutor.executePrepared`、`normalizeVersionedSteps`、planning `topological` | 核对任一 stage 失败、取消、依赖失败时的 activation 阻断；旧 restart 在 committed 后跳过 | 正常顺序未发现其他确定缺陷；正式 deploy 当前不从配置生成 App 运行依赖，不能把手工混合循环直接当作正式配置反例 | pass |
| boundary-and-input | 版本字符串、目录和配置路径 | `prepareVersionedRelease` 参数判断；transport `releaseRoot` 分支；boundary 测试 | 检查 ../、相邻前缀 v20、根/父目录软链、缺父目录、标记/latest 不一致 | 参数与父目录检查发生在切换前；匹配 VERSION 与普通目录检查存在，未发现新输入绕过 | pass |
| state-and-data-integrity | latest、版本标记和配置事务 | `switchVersionedRelease`、`restoreVersionedRelease`、`ManagedConfigPublicationError` | 检查远端 rename 成功但响应丢失、同版本备份以及标记部分提交 | switched 在发送前记录，配置发布在 rename 前保留事务，恢复备份保留；新标记通过 -o runAs 与原降权消费者兼容，cp -p 恢复保留旧权限 | pass |
| error-handling-and-recovery | 切换、重启、取消和恢复失败 | `recoverDeployment`；DV 的 publish/switch/service/marker/restore/partial-publish 故障注入 | 检查补偿忽略已取消 signal、各项恢复继续尝试、原 active 服务强制 restart | 恢复结果和错误会进入 StepResult；首发失败恢复为无 latest；没有用恢复成功掩盖原失败 | pass |
| resource-lifetime-and-cleanup | workspace、lease、版本备份和保留清理 | executor finally；transport `preserveWorkspace/close`；helper cleanup | 检查未提交目标在结束时补偿，恢复失败后避免 close 自动删除备份，提交成功后才执行 retention | lease/workspace 在准备屏障期间保留，所有恢复完成后释放；失败恢复保留资料且记录错误，未发现新泄漏反例 | pass |
| concurrency-and-ordering | 多目标准备屏障与每目标提交边界 | planning activate 依赖全部 stage；`activateDeployment`；`systemctl` | 检查切换之后的首个远端调用是否为 start/restart，是否偷偷执行 privilege/systemd 状态预读 | prepare 已完成 privilege、daemon-reload、enable；switch 与 action 无远端插入；取消时走补偿，未发现正常路径违约 | pass |
| interface-and-compatibility | privileged helper 与降权 runtime、旧计划及显式 configure | `executeInvocation` 的 runAs；remote `readTextFile`；history encode/decode；DV legacy/configure 用例 | 实际 helper 创建标记后以 nobody 读取；核对旧三阶段迁移和独立 configure 不激活 | F-069-001 已关闭：固定 argv 在切换前设置 marker 属主，executor 传入已验证身份；旧单步部署拒绝已在设计说明且 SSH 前发生 | pass |
| security-and-capacity | 配置发布路径与权限、临时文件、保留策略 | transport realpath 包含关系；helper VERSION/keepVersions 限制与固定 argv | 检查路径前缀相邻目录、版本根软链、保留策略误删无 VERSION 目录、shell 注入 | 固定 argv 与路径校验防止字符串注入；清理只处理匹配 VERSION 的版本目录，keepVersions 有界；标记保留 0640 权限并仅赋予既有应用账户所有权，未增加 shell 或秘密暴露入口 | pass |
| test-adequacy | 正常/故障/身份边界验证 | 新 unit/DV/integration 三文件全部测试源码；testplan U1/D1/I1 与 C1-C3 | 检查假会话是否准确模拟 privileged 和 run_as；核对 same 用例的前置状态来源 | 新增 committed marker is readable by app and real same-version stage succeeds 在本环境实际以 nobody 读取 marker 并执行真实 stage；断言 uid、0640、跳过暂存、latest 和 marker 内容，关闭 F-069-002。最新统一入口 96 tests + 3 contracts 通过，仅作辅助证据 | pass |

## Document Consistency
| Document | Source | Implementation Consistency | Finding | Status |
|----------|--------|----------------------------|---------|--------|
| design | `pipeline/plan.md` | 准备/提交接口、事务所有权、恢复和清理结构相符；计划末尾新增 runAs 标记所有权约定与实现一致 | 首轮身份缺陷已修复，无现存不一致 | pass |
| testing | `testplan.yaml` | 列出的测试与实际文件匹配；U1 已包含真实降权 stage 回归，覆盖新 helper 与原 runtime 消费者 | 首轮测试缺口已关闭 | pass |

## Result Summary
- Overall result: accepted
- Outcome: 操作顺序、配置候选版本绑定及恢复边界通过独立审查；首轮真实身份缺陷已修复并补充有效回归。
- Blocking issues: none。
- Next action: 由父协调者完成框架任务生命周期收尾；后续 jx-server 适配单独处理。未执行真实远端部署或真实 systemd 重启。

## Conclusion
- Accepted / rejected / needs changes: accepted
- Reason: 复审直接核对固定 argv 所有权、executor 身份来源、原降权消费者及新测试断言，并独立执行真实非 root 回归；首轮反例不再成立。其余九类检查沿用首轮具体证据并复核相关恢复路径，未发现遗留阻断。验收范围为本地受控验证，未声称远端业务启动已验证。
