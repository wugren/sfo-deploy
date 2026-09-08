# 分阶段 App deploy 验收报告

## Findings

| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- | --- | --- |
| F-000 | none | none | overall | `proposal.md`、`design.md`、`src/planning.ts`、`src/execution.ts`、`src/remote_runtime/versioned_release.ts`、`src/history.ts`、`src/cli.ts`、`README.md`、`docs/guides/sfo-deploy-cluster-configuration.md`、`tests/unit/app_management_config.test.ts`、`tests/integration/versioned_release.test.ts`、`.harness/test-results/test-runs/20260907T071327Z-sfo-deploy+056-phased-app-deploy-all.json` | 独立缺陷搜索未发现阻断或非阻断缺陷 | no |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-07
- In-scope implementation: 内置 versioned App 的 deploy 改为全局 `stage` 屏障、统一 `activate` 和统一 managed `restart`；stage/activate/legacy deploy 远端脚本、plan/history/rollback 兼容、CLI 和文档同步。
- Review mode: independent falsification; conclusion selected after findings and category review

## Requirement Coverage

| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-phased-deploy-planning | 内置 versioned deploy 生成 `stage`、`activate` 和 managed `restart` 阶段；所有 activate 依赖全部 stage，restart 依赖全部 activate | `proposal.md` P-001；`design.md` File-Level Interfaces、Key Flows | `src/types.ts`、`src/planning.ts`、`tests/unit/app_management_config.test.ts` | no requirement defect or missing behavior | pass |
| CHG-phased-deploy-execution | stage 只建版本目录；activate 集中发布 latest/marker/config；restart 集中收敛；单目标恢复与旧 deploy 快照兼容 | `proposal.md` P-002；`design.md` State and Ownership、Key Flows | `src/execution.ts`、`src/remote_runtime/versioned_release.ts`、`src/history.ts`、`tests/integration/versioned_release.test.ts` | no requirement defect or missing behavior | pass |
| CHG-phased-deploy-docs-tests | README/指南、CLI 计划文本、契约/单元/集成测试和统一入口同步 | `proposal.md` P-003；`design.md` Implementation Order | `src/cli.ts`、`README.md`、`docs/guides/sfo-deploy-cluster-configuration.md`、`testing.md`、`testplan.yaml`、最终 all run artifact | no requirement defect or missing behavior | pass |

## Independent Defect Discovery

| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- | --- |
| requirement-and-behavior | 阶段顺序、无最新生效、统一激活/重启、custom deploy/packageless 例外 | proposal rows；planning/execution/release script；plan tests | 搜索 custom deploy 被拆分、packageless 被误改、stage 提前切 latest、restart 在 activate 前执行 | no defect found | pass |
| logic-and-control-flow | plan barrier、stage/activate/legacy deploy 分支、managed config/service 顺序 | `planning.ts`、`execution.ts`、`versioned_release.ts`、`service_management.ts` | 挑战多目标 stage 失败、无 service、有 service、同版本、legacy deploy 和 custom deploy 分支 | no defect found | pass |
| boundary-and-input | 版本名、包目录、install root、keep_versions、managed config/unit | `config.ts`、`versioned_release.ts`、`tests/integration/versioned_release.test.ts` | 验证非法包类型、非目录/符号链接、路径逃逸、版本不匹配、非法 keep 值失败关闭 | no defect found | pass |
| state-and-data-integrity | 版本目录、VERSION、latest、当前标记、发布快照 | release script 状态机；`history.ts` codec；history tests | 检查 stage 不写当前状态、activate 一致切换、marker/latest 失败恢复、旧快照解码 | no defect found | pass |
| error-handling-and-recovery | stage/activate/restart 失败、取消、managed 恢复 | release script rollback；execution recovery；DV tests | 挑战恢复不完整、partial/recovery 输出、清理错误和取消传播 | no defect found | pass |
| resource-lifetime-and-cleanup | workspace、stage dir、latest temp、marker temp、旧版本 | release script finally；remote deployment cleanup；DV isolation tests | 检查成功/失败/取消不泄漏临时目录，cleanup 错误升级结果 | no defect found | pass |
| concurrency-and-ordering | 全局阶段屏障、App/目标锁、release attempt、串行执行 | `planning.ts`、`tests/dv/execution.test.ts`、`tests/integration/managed_transport_security.test.ts` | 检查 activate/restart 依赖屏障、锁释放、目标隔离和取消竞态 | no defect found | pass |
| interface-and-compatibility | PlanAction、历史 codec、旧 deploy 快照、custom deploy、CLI plan 输出 | `types.ts`、`history.ts`、`cli.ts`、history/contract tests | 验证旧 v1/v2/v3/v4 快照、custom deploy、packageless 和文档/CLI 契约不破坏 | no defect found | pass |
| security-and-capacity | 远端脚本权限、bundle 大小/成员、秘密集合、install root 提权 | `remote_runtime/artifact.ts`、`remote_deployment.ts`、`versioned_release.ts`、security tests | 检查无 net、固定 run 白名单、无秘密进入脚本、拒绝危险路径和超大成员 | no defect found | pass |
| test-adequacy | 计划屏障、脚本状态、兼容、失败恢复、文档 | `testing.md`、`testplan.yaml`、最终任务级 all run artifact | 搜索可逃过测试的正常/边界/失败/兼容路径；contract/unit/DV/integration/lint 全绿 | no adequacy defect found | pass |

## Document Consistency

| Document | Source | Implementation Consistency | Finding | Status |
| --- | --- | --- | --- | --- |
| design | `design.md` | stage/activate/restart 分层、依赖屏障、状态所有权、失败恢复和实现顺序与代码一致 | no mismatch | pass |
| testing | `testing.md`、`testplan.yaml` | 三个 change_id、case types、contract/unit/DV/integration 步骤与最终 run artifact 一致 | no mismatch | pass |

## Result Summary

- Overall result: accepted
- Outcome: 内置 versioned App 现在先完成全部 stage，再统一 activate，最后统一 managed restart；准备失败阻止后续阶段，单目标失败保留明确恢复结果。自定义 deploy、packageless、旧快照和发布历史语义保持兼容；最终任务级统一入口全绿。
- Blocking issues: none
- Residual risk: 本地自动化未执行真实多机 SSH 部署；统一阶段边界不是跨机器分布式原子事务，激活后目标不承诺隐式跨目标回滚。
- Next action: 记录 acceptance receipt 并完成任务索引归档。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 独立审查覆盖所有必需缺陷类别，未发现阻断缺陷；实现、测试、文档和最终任务级运行制品支持批准的需求边界。
