# Environment 集中放置配置第二轮独立验收报告

## Findings

| id         | severity | owning_stage | correctness_category     | evidence                                                                                                                                                                                                                                             | problem                                                        | blocking |
| ---------- | -------- | ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| A020-F-001 | none     | none         | requirement-and-behavior | `risk-profile.yaml` 当前将 `source_bindings.design_source` 绑定为 `pipeline/plan.md`；`python3 harness/scripts/risk-profile-check.py --task .../task.yaml` 实际返回 passed                                                                           | 第二轮从当前文件重新检查后，未复现设计源绑定缺失               | no       |
| A020-F-002 | none     | none         | state-and-data-integrity | `find examples/eleph-server-multipass/cluster-template -print` 仅见 v2 `environments/{jre,jx-runtime,mysql,redis}`；原样复制到临时目录后 `loadCluster` 成功并生成 14 步计划                                                                          | 第二轮未在规范模板树中发现旧机器层目录或 Python 缓存残留       | no       |
| A020-F-003 | none     | none         | test-adequacy            | `tests/integration/environment_placement.test.ts` 原样复制模板且不预删除路径，首次严格装载后再注入 `environments/eleph-server/mysql` 并断言拒绝；contract 的 `assertCleanTemplateTree` 递归检查旧层级、`__pycache__`、`.pytest_cache` 与 `*.py[cod]` | 当前测试不再用预清理掩盖旧布局，并会直接检测规范模板树中的缓存 | no       |

## Requirement Coverage

| change_id                        | requirement_or_boundary                                                                                                                                                   | source                                                                                                                                              | implementation_evidence                                                                                                                                                                                                                                                                                                               | finding                                                                               | status |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| CHG-environment-placement-config | P-001 至 P-005：严格 v2 Environment 放置与共享定义、隔离的 v1 兼容、依赖/过滤/历史行为保持，以及文档和 Multipass 模板迁移；不增加逐机器 overrides、不自动改写用户 v1 配置 | `proposal.md` Requirement Review 与 Proposal Items；`pipeline/plan.md` Exported Interfaces、Consumer Migration Closure、Failure Flows 和 Invariants | `src/config.ts` 的 `clusterSchemaVersion`、`loadV1MachineEnvironments`、`loadV2PlacedEnvironments` 与 `validateDependencies`；`src/planning.ts::buildPlan`；`src/integration.ts::buildRequestedPlan`；`src/history.ts::loadRollbackPlan`；当前 v2 模板、两套 prepare、三份文档；任务 all 与独立原样复制 direct load/14-step plan 证据 | 唯一 change_id 的正常、负例、兼容、消费者迁移与人工边界均有当前证据，未发现遗漏或收窄 | pass   |

## Independent Defect Discovery

| category                      | applicable_scope                                                            | evidence_inspected                                                                                                                                          | adversarial_check                                                                                                             | finding_or_not_applicable_reason                                                                                                     | status         |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| requirement-and-behavior      | v2 放置、共享定义、v1 兼容、计划/历史与示例迁移的完整用户结果               | `proposal.md` P-001 至 P-005、`src/config.ts`、`src/planning.ts`、三份更新文档和当前模板                                                                    | 将每项提案与唯一 change_id、实现符号、测试断言逐项反向映射，并检查 non-goal 未被实现扩张                                      | v2 严格行为、v1 只读兼容、无逐机覆盖、无自动迁移及真实 Multipass 人工边界一致，未发现任务范围内行为缺口                              | pass           |
| logic-and-control-flow        | schema 分支、定义实例化、依赖闭合、过滤与确定性拓扑                         | `loadCluster`、`loadV1MachineEnvironments`、`loadV2PlacedEnvironments`、`validateDependencies`、`buildPlan`                                                 | 检查未知版本、v1/v2 混用、同机短依赖、显式跨机依赖、过滤排除依赖和多机排序路径                                                | v1/v2 不猜测回退，依赖在派生实例集合上闭合，计划按已排序节点拓扑生成；定向正负例均通过                                               | pass           |
| boundary-and-input            | 空映射、空目标、重复目标、未知定义/机器、非法名称、资源路径与 YAML 版本边界 | `tests/unit/environment_placement.test.ts` 七组测试及 `src/config.ts` 的 `fields`、`stringList`、`contained`                                                | 复核空环境合法条件、缺失与多余映射组合、重复机器、非列表、未知机器、目录名不一致及路径逃逸                                    | 所有新增边界在首次 SSH 前失败关闭，错误包含版本、字段、Environment 或机器上下文                                                      | pass           |
| state-and-data-integrity      | 规范模板、生成 staging、已发布集群、历史快照和旧生成状态迁移                | 两套 prepare 的模板预检、fresh staging 与发布函数；`ReleaseStore.archivePlans/loadRollbackPlan`；当前模板树                                                 | 原样复制模板而不清理后直接装载；注入旧机器层目录验证拒绝；删除当前 Environment/App 后读取归档 rollback                        | 模板源无旧层级/缓存，staging 不与旧输出合并，严格校验先于发布；rollback 从归档计划读取而不回读当前布局                               | pass           |
| error-handling-and-recovery   | 模板残留、复制后严格校验失败、发布替换失败与历史临时快照失败                | Shell `validate_template_tree`、`cleanup`、`publish_cluster_atomically`；PowerShell `Assert-CleanClusterTemplate`、`Publish-ClusterAtomically` 与 `finally` | 核对实际语句顺序：源预检在复制和 Multipass 调用前，stage 校验在 publish 前；实际调用 Shell guard 注入旧层级和 `__pycache__`   | 两端均在严格校验失败时保留既有发布目录并清理 staging；Shell guard 两种脏树均非零退出。未执行真实 Multipass，按 testplan 保留人工缺口 | pass           |
| resource-lifetime-and-cleanup | staging、备份、锁、历史 snapshot 临时目录与人工 VM 生命周期                 | Shell `cleanup`/trap/锁、PowerShell `try/finally`、`PendingRelease.archivePlans` catch 清理、Multipass README 清理边界                                      | 沿成功、校验失败、发布移动失败和历史编码失败路径检查临时目录、备份及锁的释放或恢复                                            | 文件系统临时资源都有清理/恢复路径；VM 明确不自动删除且属于显式人工生命周期，不被本轮伪报为自动通过                                   | pass           |
| concurrency-and-ordering      | 配置派生与计划顺序；prepare 为单操作者一次性引导命令                        | `childDirectories` 排序、v2 目标机器排序、`buildPlan` 稳定拓扑；Shell prepare 锁和两端独立 staging                                                          | 查找共享可变缓存、异步部分发布、未排序 Map 输入与计划重入状态；对 prepare 核对校验先于发布                                    | 配置/规划没有新增共享可变并发状态且结果稳定；批准范围未声明并发 prepare，故没有额外并发语义需要验收                                  | not-applicable |
| interface-and-compatibility   | cluster schema、公开 TypeScript 形状、CLI 消费者、v1 配置与 v1/v2/v3 历史   | `src/types.ts`、`src/mod.ts`、planning/integration/history 调用者、三份迁移/降级文档、历史 fixture                                                          | 比较 v1/v2 对同一放置的计划步骤；检查 `ClusterConfig.placements` 仍只表示 App；用归档 snapshot 在删除当前目录后 rollback      | 公开类型和计划 schema 未扩张，v1 仍可读，v2 明确前向不兼容并提供完整降级边界，历史读取不依赖当前目录                                 | pass           |
| security-and-capacity         | 资源路径、符号链接/普通文件、秘密、SSH trust bundle 和模板扫描              | `src/config.ts::contained`、两套 prepare 的模板与信任状态检查、模板 YAML 权限声明、三份文档                                                                 | 检查共享目录是否绕过 containment、脏模板是否可随复制进入发布、私钥/known_hosts 是否可能混合版本、放置列表是否可重复放大       | 共享定义复用既有 containment，放置拒绝重复值，prepare 只整体发布严格校验后的 trust bundle；未引入新网络或秘密接口                    | pass           |
| test-adequacy                 | contract、unit、DV、integration、历史兼容、模板消费者与人工运行边界         | `testplan.yaml`、支持 fixture、unit/integration/contract 源码、`20260901T175335Z` artifact 及第二轮任务 all 输出                                            | 检查测试是否预删除旧层级、是否只断言部分计划、是否漏掉缓存、v1、依赖负例或 rollback 当前目录独立性；另做独立 direct load/plan | 测试原样复制模板、断言完整 14 步、动态注入旧层级、递归检查缓存并覆盖 v1/v2/历史；真实 Multipass 服务部署是准确且未伪造的 manual gap  | pass           |

## Document Consistency

| document | source             | implementation_consistency                                                                                                                                    | finding                                                                          | status |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| design   | `pipeline/plan.md` | 风险绑定、消费者迁移、旧层级/缓存物理删除、两端 prepare 源预检、fresh staging、strict validate 后发布均可在当前源文件定位；公开类型和 history schema 保持不变 | 设计与当前实现一致，且本轮未发现共同持有的错误假设                               | pass   |
| testing  | `testplan.yaml`    | 注册的 2 个 contract、3 个 unit、1 个 DV、1 个 integration 步骤与测试源码及 artifact 一致；原样模板、完整计划、旧布局负例、缓存扫描和 rollback 均有对应断言   | 测试设计与实现一致；真实 Multipass、systemd/MySQL/Redis/JAR 仍按文档列为人工缺口 | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 唯一 `CHG-environment-placement-config`
  的需求、实现、消费者迁移与测试证据通过第二轮独立证伪；A020-F-001、A020-F-002、A020-F-003 均从当前
  primary sources 重新验证为已闭合。
- Blocking issues: none；本轮没有发现任务范围内阻断缺陷。
- Next action: 由父编排器在不把 checker 当作正确性证明的前提下完成 acceptance 状态收口；真实
  Multipass 服务部署继续按 `testplan.yaml` 的 manual gap 在隔离 VM 中验收。

## Object and Scope

- Task manifest: `task.yaml`
- Review mode: independent 第二轮验收；reviewer
  未参与实现、测试或本轮修复，不采纳上一轮结论与实施/测试摘要。
- Primary sources:
  `proposal.md`、`pipeline/plan.md`、`risk-profile.yaml`、`testplan.yaml`、`src/config.ts` 及
  planning/integration/history 调用者、任务测试、两套 prepare、当前模板树、三份更新文档和
  `20260901T175335Z` 成功 artifact。
- Runtime evidence: `risk-profile-check` passed；任务级 all 的 7
  个注册步骤重跑成功；临时原样复制模板 direct load/14-step plan
  成功，注入旧机器层目录失败关闭；Shell 源预检实际拒绝旧层级与 `__pycache__`。
- Manual gap: 未运行真实 Multipass、远端 Deno、systemd、MySQL、Redis 或 JAR
  部署；本报告不声称这些环境行为已自动验证。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 当前 primary sources、定向反例、最新既有 artifact
  和独立重跑共同表明三项既有缺陷均已闭合，恰好十类缺陷发现、唯一 change_id 覆盖及 design/testing
  consistency 均无任务范围内阻断；真实 Multipass 保持为明确人工缺口。
