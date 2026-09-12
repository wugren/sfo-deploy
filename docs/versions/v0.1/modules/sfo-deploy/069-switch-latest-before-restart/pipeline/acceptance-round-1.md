# sfo-deploy 配置先发布与 latest 最后切换验收报告

## Findings
| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
|----|----------|--------------|----------------------|----------|---------|----------|
| F-069-001 | high | implementation | interface-and-compatibility | `src/versioned_release_management.ts:prepareVersionedRelease` 的 privileged install -m 0640；`src/remote_runtime/versioned_release.ts:readTextFile/stageRelease`；独立本地实际 helper 调用后 stat 为 root:root 640，runuser nobody cat 返回 exit 1 Permission denied | 新标记归 root 且非应用用户可读。后续 stage 以 run_as 非 root 执行，将权限失败当标记不存在；同版本再次部署命中 latest 已指向候选版本的拒绝分支，无法执行同版本配置更新。应保证标记可由应用身份读取，并用真实身份边界回归验证。 | yes |
| F-069-002 | medium | testing | test-adequacy | `tests/unit/versioned_release_management.test.ts:LocalSession.run`、`tests/dv/versioned_deploy_order.test.ts:fixture` 均在测试进程身份执行固定 argv；同版本用例事先构造标记 | 已有测试没有以真实非 root run_as 读取新 helper 生成的标记，未贯穿一次发布成功后的再次 stage，掩盖 F-069-001。需要新标记与降权 stage 相连的测试。 | yes |

## Object and Scope
- Task manifest: task.yaml
- Review date: 2026-09-09
- In-scope implementation: `src/execution.ts`、`src/planning.ts`、`src/versioned_release_management.ts`、`src/service_management.ts`、`src/transport.ts`、`src/remote_deployment.ts`、`src/history.ts` 及框架文档和测试。
- Review mode: independent falsification; conclusion selected after findings and category review。审查者未实现该变更；先读 proposal、正式 plan、生产与消费者代码及测试断言，再参考测试证据。未执行远端部署，也未修改 jx-server。

## Requirement Coverage
| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
|-----------|-------------------------|--------|-------------------------|---------|--------|
| CHG-configure-before-switch | 先发布候选版本配置，全部 stage 成功后逐目标最后切换并紧接服务动作；保留首次、同版本及失败恢复行为 | `proposal.md` P-001/P-002/P-003、Success Criteria | `deploymentConfigTarget`、`activateDeployment`、`prepareSystemd/executePreparedSystemd`、`recoverDeployment`、`normalizeVersionedSteps` | 主要操作顺序符合要求，但 F-069-001 阻断成功发布后的同版本部署，F-069-002 未覆盖该消费者边界 | fail |

## Independent Defect Discovery
| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
|----------|------------------|-------------------|-------------------|---------------------------------|--------|
| requirement-and-behavior | 配置、激活、服务和同版本重试 | proposal P-001/P-003；`activateDeployment`；remote `stageRelease` | 用成功发布后的真实标记重新代入同版本消费者，而不是使用预造标记 | F-069-001：同版本配置更新不成立，已批准意图本身无歧义 | fail |
| logic-and-control-flow | stage/activate 调度与失败传播 | `DeploymentExecutor.executePrepared`、`normalizeVersionedSteps`、planning `topological` | 核对任一 stage 失败、取消、依赖失败时的 activation 阻断；旧 restart 在 committed 后跳过 | 正常顺序未发现其他确定缺陷；正式 deploy 当前不从配置生成 App 运行依赖，不能把手工混合循环直接当作正式配置反例 | pass |
| boundary-and-input | 版本字符串、目录和配置路径 | `prepareVersionedRelease` 参数判断；transport `releaseRoot` 分支；boundary 测试 | 检查 ../、相邻前缀 v20、根/父目录软链、缺父目录、标记/latest 不一致 | 参数与父目录检查发生在切换前；匹配 VERSION 与普通目录检查存在，未发现新输入绕过 | pass |
| state-and-data-integrity | latest、版本标记和配置事务 | `switchVersionedRelease`、`restoreVersionedRelease`、`ManagedConfigPublicationError` | 检查远端 rename 成功但响应丢失、同版本备份以及标记部分提交 | switched 在发送前记录，配置发布在 rename 前保留事务，恢复备份保留；但新标记所有权使持久状态无法被原消费者读取（F-069-001） | fail |
| error-handling-and-recovery | 切换、重启、取消和恢复失败 | `recoverDeployment`；DV 的 publish/switch/service/marker/restore/partial-publish 故障注入 | 检查补偿忽略已取消 signal、各项恢复继续尝试、原 active 服务强制 restart | 恢复结果和错误会进入 StepResult；首发失败恢复为无 latest；没有用恢复成功掩盖原失败 | pass |
| resource-lifetime-and-cleanup | workspace、lease、版本备份和保留清理 | executor finally；transport `preserveWorkspace/close`；helper cleanup | 检查未提交目标在结束时补偿，恢复失败后避免 close 自动删除备份，提交成功后才执行 retention | lease/workspace 在准备屏障期间保留，所有恢复完成后释放；失败恢复保留资料且记录错误，未发现新泄漏反例 | pass |
| concurrency-and-ordering | 多目标准备屏障与每目标提交边界 | planning activate 依赖全部 stage；`activateDeployment`；`systemctl` | 检查切换之后的首个远端调用是否为 start/restart，是否偷偷执行 privilege/systemd 状态预读 | prepare 已完成 privilege、daemon-reload、enable；switch 与 action 无远端插入；取消时走补偿，未发现正常路径违约 | pass |
| interface-and-compatibility | privileged helper 与降权 runtime、旧计划及显式 configure | `executeInvocation` 的 runAs；remote `readTextFile`；history encode/decode；DV legacy/configure 用例 | 实际 helper 创建标记后以 nobody 读取；核对旧三阶段迁移和独立 configure 不激活 | F-069-001 为确定身份语义回归；旧单步部署拒绝已在设计说明且 SSH 前发生 | fail |
| security-and-capacity | 配置发布路径与权限、临时文件、保留策略 | transport realpath 包含关系；helper VERSION/keepVersions 限制与固定 argv | 检查路径前缀相邻目录、版本根软链、保留策略误删无 VERSION 目录、shell 注入 | 固定 argv 与路径校验防止字符串注入；清理只处理匹配 VERSION 的版本目录，keepVersions 有界；F-069-001 是最小权限读权限破坏，列于兼容性 | pass |
| test-adequacy | 正常/故障/身份边界验证 | 新 unit/DV/integration 三文件全部测试源码；testplan U1/D1/I1 与 C1-C3 | 检查假会话是否准确模拟 privileged 和 run_as；核对 same 用例的前置状态来源 | F-069-002：单次 root fixture 不能揭示新标记被非 root 后续 stage 读取的问题；95 tests + 3 contracts 通过不足以替代该边界 | fail |

## Document Consistency
| Document | Source | Implementation Consistency | Finding | Status |
|----------|--------|----------------------------|---------|--------|
| design | `pipeline/plan.md` | 准备/提交接口、事务所有权、恢复和清理结构相符，但同版本兼容承诺被标记权限违背 | F-069-001；需返回实现修复，未发现须改写用户意图的问题 | fail |
| testing | `testplan.yaml` | 列出的测试与实际文件匹配，但未覆盖新 helper 与降权 stage 的身份交互 | F-069-002 | fail |

## Result Summary
- Overall result: needs changes
- Outcome: 操作排序主体满足要求，发现可重现的同版本重部署阻断，当前不可验收。
- Blocking issues: F-069-001、F-069-002。
- Next action: 返回 implementation 修复版本标记所有权/读取契约，再由 testing 增加真实非 root 消费者的发布后重部署回归；修复完成后独立复验。不修改 jx-server。

## Conclusion
- Accepted / rejected / needs changes: needs changes
- Reason: 真实身份边界复现证明已有通过测试未覆盖消费者权限回归。须修复并补证，不能以生命周期或测试计数宣布功能完成。
