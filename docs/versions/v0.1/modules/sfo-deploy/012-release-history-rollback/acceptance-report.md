# 发布历史与指定版本回退第四轮独立验收报告

## Findings

| ID    | Severity | Owning Stage | Correctness Category | Evidence                                                                                                                             | Problem                                                | Blocking |
| ----- | -------- | ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | -------- |
| F-000 | none     | none         | overall              | 独立检查当前提案、计划、生产实现、调用方、测试与正式运行制品，并重放执行摘要、合法 check→install、原子发布、selection 和回退来源反例 | 未发现仍需返回的阻断缺陷；既有 F-001 至 F-009 均已关闭 | no       |

## Object and Scope

- Task manifest: task.yaml
- Risk profile: risk-profile.yaml
- Review date: 2026-08-31
- In-scope implementation:
  `src/sfo_deploy/history.py`、`downloads.py`、`execution.py`、`secrets.py`、`integration.py`、`results.py`、`cli.py`、`__init__.py`，`README.md`，`tests/test_release_history.py`，以及正式制品
  `.harness/test-results/test-runs/20260831T115834Z-sfo-deploy+012-release-history-rollback-all.json`
- Review mode: independent falsification; conclusion selected after findings and category review;
  this round read current primary sources and did not adopt prior acceptance conclusions

## Focused Reverification

| Prior Finding  | Current Production Evidence                                                                                                                                      | Independent Adversarial Check                                                                                                                        | Current Registered Test Evidence                                                                                                           | Result |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| F-001 至 F-004 | operation lock、严格 plan codec、成功快照要求和 `PreparedExecution` 固定本地输入均在当前实现中保持                                                               | 重放 lock symlink/hardlink、非法 action/status、成功缺 snapshot、prepare 后替换 script/template/key，均安全失败或继续消费固定副本                    | `TestReleaseDv` 的 lock/codec/snapshot 用例与 `TestReleaseUnit` 的稳定输入、清理用例                                                       | closed |
| F-005a         | `_execution_summary_from_data` 精确限制 skip reason；`_validate_execution_against_plan` 绑定完整步骤身份并约束 check-satisfied、target-fail-fast 和成功 App 步骤 | 把 App/environment 步骤改成非法 check-satisfied、让 unsatisfied check 后错误跳过 install、在无前置失败时伪造 fail-fast，list/get/rollback 均失败关闭 | `test_succeeded_outcome_with_inconsistent_execution_summary_fails_closed` 与 `test_outcome_must_match_every_actual_plan_step_and_metadata` | closed |
| F-005b         | 只有存在同资源后续 install 的 environment check 可使用 succeeded + 非零退出码；`finish_result` 在发布 outcome 前执行 decoder、plan binding 和 consistency 校验   | 真实编排探针在多个目标运行 check exit 1→install→configure/deploy，最终 succeeded/exit 0 并生成 release ID；非法 App skip 在创建 outcome 前被拒绝     | `test_successful_deploy_allows_unsatisfied_check_followed_by_install`、`test_invalid_execution_result_is_rejected_before_outcome_publish`  | closed |
| F-006          | `begin_attempt` 在隐藏目录完成 intent 后整体 rename；读端仅对 hard-link 发布的短暂双链接状态等待收敛，永久硬链接继续拒绝                                         | 在目录 rename 和 outcome link/unlink 的精确窗口暂停 writer，并发 history 不观察空 attempt 或报正常中间态损坏                                         | 两个 `test_history_*publish*` 并发定点测试，双链接窗口用例另连续运行十次通过                                                               | closed |
| F-007/F-008    | `ReleaseRecord.selection` 与 CLI JSON 保留完整调用选择；计划明确所有源文件均要求 nlink=1                                                                         | 配置加载前失败仍返回原始 App/机器/环境/区域/地址/依赖选择；源硬链接与实现一致地失败关闭                                                              | selection 单元/集成测试及链接负向测试                                                                                                      | closed |
| F-009          | 单元、DV、集成用例覆盖上述合法与非法状态机、并发窗口、规划前失败和公共 JSON                                                                                      | 独立精确复跑关键 selector 为 19 passed，并核对断言能在旧行为恢复时失败                                                                               | 正式制品记录 Unit 35、DV 35、Integration 4，全部 exit 0                                                                                    | closed |

## Requirement Coverage

| change_id               | Requirement or Boundary                                                                                                         | Source                                                                                | Implementation Evidence                                                                                                                                    | Finding                                                                       | Status |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| CHG-release-history     | 每次 deploy 在配置加载前留 intent，浏览成功/失败/取消/incomplete 记录，持久化不可变实际计划、完整性和完整调用选择，且不泄露秘密 | `proposal.md` P-001、Success Signal、Risks；`risk-profile.yaml` data/security/runtime | `ReleaseStore.begin_attempt/list/get`、`PendingRelease.archive_plans/finish_*`、严格 JSON/plan/outcome 校验、`ReleaseRecord.selection` 与对应 unit/DV 反例 | intent 原子可见、终态与 snapshot 精确绑定；未发现记录遗漏、错误成功或秘密泄露 | pass   |
| CHG-release-history-cli | 提供 history 列表/详情、稳定 JSON、公共结果类型及参数互斥                                                                       | `proposal.md` P-002、CLI/API Acceptance                                               | `RunOptions`/`run` history 分支、`_serialize_release_record`、`ReleaseSelection`/`ReleaseRecord` 公共导出、CLI/README 集成测试                             | 列表、详情、selection、错误类别和既有调用兼容边界均满足                       | pass   |
| CHG-release-rollback    | 指定成功发布 ID 回退，复用快照、下载、预检和执行链，只执行安全 App 恢复步骤并记录 lineage                                       | `proposal.md` P-003、Rollback Acceptance、Non-goals                                   | `load_rollback_plan`、`derive_rollback_plan`、`_run_rollback`、`PreparedExecution`、结果 `release_id/source_release_id` 与 rollback DV                     | 损坏/失败来源和非法 ID 在 SSH 前拒绝；成功回退保留 lineage 且可再次回退       | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                                                              | Evidence Inspected                                                                                                      | Adversarial Check                                                                                              | Finding or Not-Applicable Reason                                                                  | Status |
| ----------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| requirement-and-behavior      | deploy 留痕、history 浏览、指定版本 rollback、失败记录和非目标边界            | `proposal.md` 全部 P/Acceptance/Non-goals，`integration.run`、`ReleaseStore`、README 与主链 DV                          | 运行 deploy→history→损坏当前配置→指定版本 rollback，并检查失败/取消/incomplete、selection、lineage 和再次回退  | 请求行为均有当前生产路径和可失败测试；未发现遗漏或超出非目标的自动数据回滚                        | pass   |
| logic-and-control-flow        | plan 派生、执行摘要解码、步骤依赖与回退控制流                                 | `derive_rollback_plan`、`_validate_plan_semantics`、`_validate_outcome_consistency`、`_validate_execution_against_plan` | 构造空/缺失/额外/重复/身份漂移步骤、非法 skip/fail-fast、App 未执行和合法非零 check                            | 非法组合失败关闭；合法 check→install 分支保留；回退只含 environment check 与 App configure/deploy | pass   |
| boundary-and-input            | CLI/API 参数、release ID、JSON/source codec、路径、文件和容量输入             | `RunOptions`、CLI parser、history strict readers、download source codecs 及负向测试                                     | 输入非法 ID/action/status/exit/skip、重复键、NaN、深 JSON、路径逃逸、symlink/hardlink、超限快照和未知 provider | 所有信任边界在历史读取、回退或 SSH 前拒绝；未发现旁路                                             | pass   |
| state-and-data-integrity      | intent/snapshot/outcome 写一次生命周期、可回退资格、记录/计划/结果一致性      | `begin_attempt`、`_atomic_json`、`_verify_snapshot`、`finish_result`、状态与损坏测试                                    | 暂停发布窗口、删除/篡改 snapshot、伪造 outcome/元数据、提交非法 DeploymentResult                               | 只在完整且真实一致的 succeeded snapshot 上授予 rollback eligibility；非法结果不发布 outcome       | pass   |
| error-handling-and-recovery   | 配置/规划/provider/secret/key/download/SSH/取消和终结失败                     | `integration.run/_finish_attempt_*`、`prepare_execution`、`PendingRelease._finish` 与失败测试                           | 在各阶段注入失败，检查 connect 计数、failed/cancelled/incomplete 投影、原错误传播和可继续浏览性                | 本地可发现错误均在 connect 前；终结失败不误报成功，未完成记录安全地保持不可回退                   | pass   |
| resource-lifetime-and-cleanup | operation lock、本地工件、秘密副本、SSH workspace/session 和临时目录          | `_OperationLock`、`PreparedExecution.close`、executor finally、artifact cleanup 与生命周期测试                          | 成功、异常、取消、替换输入及 cleanup error 下核对释放和结果升级                                                | 锁、文件、目录、工件和会话均有确定释放路径；未发现遗留可复用秘密或死锁                            | pass   |
| concurrency-and-ordering      | 同集群串行操作、无锁 history 与原子组件发布                                   | `_OperationLock`、隐藏 attempt staging、hard-link no-clobber、并发定点测试                                              | 在 rename 前和 link/unlink 之间暂停 writer，同时读取 history；另保留永久硬链接攻击                             | reader 不观察正常非法中间态，永久异常链接仍拒绝，操作锁终态后释放                                 | pass   |
| interface-and-compatibility   | RunOptions、DeploymentResult、公共导出、CLI JSON、provider 扩展和执行时序迁移 | `__init__.py`、`results.py`、`cli.py`、`downloads.py`、consumer closure 与 README                                       | 检查旧位置参数、可选元数据、参数互斥、完整 selection、custom provider 无 codec 和既有直接 execute_plan         | 新接口向后兼容；明确的审计写入、预检时序和 provider codec 迁移边界有文档及测试                    | pass   |
| security-and-capacity         | secret/凭据/私钥、反序列化、路径与磁盘/内存/步骤上限                          | history/archive/download/secrets 实现、风险 required checks、持久化字节检查与容量测试                                   | 搜索历史中的 key/stdout/stderr/token，攻击 URL/source/path/link/JSON 深度、文件数和总字节                      | 敏感内容未持久化；严格 codec、普通文件和有界读取阻断泄露、逃逸与无界解析                          | pass   |
| test-adequacy                 | 正常、边界、负向、错误、生命周期、并发、兼容和跨模块验证                      | `testplan.yaml`、`tests/test_release_history.py` 与 `20260831T115834Z...json`                                           | 逐项核对 F-001 至 F-009 的旧机制是否会使当前断言失败，并独立复跑关键 19 个 selector                            | 测试覆盖可揭示本任务适用的主要失败模式；正式 contract/unit/DV/integration 命令均成功              | pass   |

## Document Consistency

| Document | Source                                  | Implementation Consistency                                                                                                              | Finding                                                                | Status |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| design   | `pipeline/plan.md`、`risk-profile.yaml` | 实现遵循完整 selection、隐藏 attempt 原子发布、短暂双链接收敛、所有源硬链接拒绝、actual-plan/result 精确绑定和合法 check→install 状态机 | 未发现设计自身错误或当前实现偏离                                       | pass   |
| testing  | `testplan.yaml`                         | contract/unit/DV/integration 注册与当前测试文件、change_id、evidence roots 和正式制品一致                                               | `20260831T115834Z...json` 全部步骤 exit 0；新增反例已进入注册 selector | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 三个 change_id
  的发布历史浏览、完整调用选择、不可变快照、指定版本安全回退、lineage、预检和兼容边界均通过独立证伪；先前三轮发现已由生产修复、针对性反例和当前正式制品共同关闭。
- Blocking issues: 无。
- Next action: 完成自动流水线的
  acceptance、生命周期和任务索引收尾；测试与检查通过仅作为当前交付证据，不表述为不存在任何未知缺陷。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 当前主源对 F-001 至 F-009 的旧失败机制均有可观察防线，全部 change_id
  和十类缺陷发现均通过，设计/测试文档与交付一致，未发现剩余阻断问题。
