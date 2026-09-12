# Acceptance Report：App 配置目录变量

## Object and Scope

- Task manifest: `task.yaml`
- Review mode: independent defect discovery over proposal, implementation, callers, tests, run artifact, and lifecycle evidence

## Findings

| id | severity | owning_stage | correctness_category | evidence | problem | blocking |
| --- | --- | --- | --- | --- | --- | --- |
| F-000 | none | none | overall | `src/config.ts.managedConfigTarget()` 的变量计数/前缀匹配、`src/execution.ts.deploymentConfigTarget()` 的 targetRoot 分支、`tests/dv/versioned_deploy_order.test.ts` 的三类目标执行路径均已独立复核 | 独立缺陷搜索未发现未解决缺陷 | no |

## Requirement Coverage

| change_id | requirement_or_boundary | source | implementation_evidence | finding | status |
| --- | --- | --- | --- | --- | --- |
| CHG-app-directory-variable-contract | `${INSTALL_DIRECTORY}` 表示安装根，新增 current 版本目录与 latest 目录变量，保持路径安全并迁移示例 | proposal.md Scope / Success Criteria；design.md Overall Approach | `managedConfigTarget()` 归一 `install/current/latest` 四种 `targetRoot`；`history.ts` 保存 `target_root` 并兼容旧快照；`deploymentConfigTarget()` 只重定位 current 与旧绝对 latest；`tests/unit/app_management_config.test.ts` 和 `tests/dv/versioned_deploy_order.test.ts` 覆盖三类目标；README、指南、模块边界、技能与 Multipass live 示例已迁移 | 未发现缺失或越界行为 | pass |

## Independent Defect Discovery

| category | applicable_scope | evidence_inspected | adversarial_check | finding_or_not_applicable_reason | status |
| --- | --- | --- | --- | --- | --- |
| requirement-and-behavior | managed config target 变量契约与 breaking 迁移 | proposal.md Scope/Non-goals、design.md Overall Approach、README、guide、`examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml` | 逐项核对三个变量语义、deploy/configure 差异、无别名迁移和非目标，检查是否窄化或引入 shell 展开 | 未发现需求缺失、矛盾或非目标越界；`${INSTALL_DIRECTORY}` 不再追加 latest 且文档说明 breaking | pass |
| logic-and-control-flow | 变量识别、展开和重定位分支 | `managedConfigTarget()` 的 variableCount/prefix/relative 分支；`deploymentConfigTarget()` 的 `targetRoot === current` 与 absolute latest 分支 | 构造多变量、无斜杠、`.`/`..`、current/latest/install/absolute 分支，检查 fallthrough 和错误走向 | 分支顺序先拒绝多变量，再匹配前缀并复用 `managedTargetPath()`；current 与 legacy latest 重定位，latest/install 不重定位 | pass |
| boundary-and-input | 空相对路径、路径分隔符、`.`/`..`、缺 install_directory、重复目标 | `managedTargetPath()`、相对片段校验、重复 target 集合；`tests/unit/app_management_config.test.ts` 正负例 | 试探空尾、双斜杠、反斜杠、`.`/`..`、多变量和同一展开路径重复声明 | 非法相对片段和绝对路径在装载前失败；重复 target 使用展开后的真实路径 | pass |
| state-and-data-integrity | 计划快照、旧快照兼容和执行目标根状态 | `src/history.ts.encodeManagement()`/`decodeManagement()`；`targetRoot` 状态；`tests/unit/history.test.ts` | 删除 `target_root` 模拟旧快照、篡改枚举、检查 current/latest 展开同值时的语义保留 | 旧快照缺省 `absolute`；current/latest 通过显式状态区分，不因展开值相同丢失语义 | pass |
| error-handling-and-recovery | 配置装载失败和部署发布失败 | loader error messages、`tests/dv/versioned_deploy_order.test.ts` publish/switch/service/marker/restore fault fixtures | 验证装载失败阻止计划、发布失败不切换 latest 并走既有恢复路径 | 本任务不新增恢复机制；既有失败补偿保持，未发现吞错或错误回退 | pass |
| resource-lifetime-and-cleanup | 部署事务、临时工作区和临时候选资源生命周期 | `publishManagedConfigs` fixture、`recoverDeployment()` 既有路径、测试断言 cleanup | 检查发布失败、取消、恢复失败后的 workspace/backup 行为是否被 target 变量改变 | 变量只改变目标选择；资源所有权、备份和清理沿用既有实现 | pass |
| concurrency-and-ordering | 多目标 stage/activate 和配置发布顺序 | `tests/dv/versioned_deploy_order.test.ts` preparation barrier、events、targetRoot variants | 检查是否 current/latest 重定位改变“先准备后切换”的顺序或引入共享可变状态 | 未新增锁、异步或共享状态；发布仍在切换前完成，latest target 有意写当前链接 | pass |
| interface-and-compatibility | 导出类型、计划快照、示例与文档契约 | `ManagedConfigFile.targetRoot`、`testplan.yaml` external-positive/removed-symbol-scan/compile closure、contract tests | 检查旧快照读取、必需新字段对构造者影响、README/指南/技能/示例漂移和迁移说明 | 新字段为 migration-required；C2/C3/C4 通过；旧语义不保留别名且迁移路径明确 | pass |
| security-and-capacity | 路径遍历、链接逃逸、无界变量和秘密暴露 | `managedTargetPath()`、transport releaseRoot 边界、`tests/integration/versioned_transport_boundary.test.ts`、变量数量限制 | 构造 `..`、符号链接、越界 target 和多变量；确认变量只作用于 target 前缀，秘密仍不进入环境变量 | 路径校验在发布前保留；无 shell 展开、环境注入或新的秘密消费面 | pass |
| test-adequacy | 需求的 normal/boundary/negative/error/compatibility/lifecycle/cross-module 验证 | `testplan.yaml` U1-U3/D1/I1-I2/C1-C4；run artifact `.harness/test-results/test-runs/20260911T103153Z-sfo-deploy+082-app-directory-variables-all.json` | 检查测试是否直接区分 current/latest/install、旧快照兼容、示例契约和编译闭包，而非只测字符串 | 41 个相关测试步骤加契约覆盖目标行为；真实远端 SSH 部署明确记录 manual gap | pass |

## Document Consistency

| document | source | implementation_consistency | finding | status |
| --- | --- | --- | --- | --- |
| design | design.md | 文件序列、迁移闭包和 targetRoot 分支与实际 `src/`、示例、测试路径一致；设计修正已重放收据 | 无 | pass |
| testing | testing.md, testplan.yaml | 测试步骤、风险 required checks、manual gap 与实际任务 run artifact 一致 | 无 | pass |

## Result Summary

- Overall result: accepted
- Outcome: 三类目录变量契约已实现并通过独立验收；示例已迁移，旧 `${INSTALL_DIRECTORY}` 版本内语义按提案为 breaking change。
- Blocking issues: none
- Next action: 通过 `task-transition.py complete` 记录验收收据，再移除未完成任务索引项。
- Residual risk: 本任务未执行真实 SSH 主机部署；仓库工作区中另有 4 个未使用变量的 Deno lint 错误，与本任务改动无关，未纳入本任务修复。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 需求逐项落地，独立缺陷搜索未发现阻断缺陷；目标路径选择、快照兼容、失败路径、示例迁移和文档契约均有具体证据，真实远端部署作为明确 manual gap 记录。
