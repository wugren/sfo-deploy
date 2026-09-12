# App management.kind 配置契约验收报告

## Findings

| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- | --- | --- |
| F-000 | none | none | overall | 独立复审 `src/config.ts` 的 `rejectTopLevelAppScripts`/`appManagement`、`src/planning.ts` 的 packageless 与 package 归属、`src/execution.ts` 的 script/service manager 分支、`src/history.ts` 的 manager 快照编解码、实际 multipass App 配置、`tests/contract/verify_app_schema1_removed_types.ts` 及 `.harness/test-results/test-runs/20260909T184333Z-sfo-deploy+076-remove-app-scripts-node-all.json` | 批准范围内未发现未解决缺陷 | no |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-10
- In-scope implementation: `src/config.ts`、`src/types.ts`、`src/planning.ts`、`src/execution.ts`、`src/history.ts`、`src/cli.ts`、multipass 实际集群与模板 App 配置、README/指南/模块边界/技能参考同步及 task testplan 覆盖的 unit/DV/integration/contract 测试。
- Review mode: independent falsification。按 proposal、design、生产调用链、旧契约残留、测试源码、运行工件和实际集群配置重新复核，不以实现或测试自评为前提；未执行真实 SSH、fetch、deploy 或服务重启。

## Requirement Coverage

| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-remove-app-scripts-node | App YAML 完全禁止顶层 `scripts`；配置脚本只由 `configs[].kind: script` 承载 | proposal.md P-001、design.md Design Scope | `rejectTopLevelAppScripts` 在 `loadApps` 装载前定向拒收；`APP_FIELDS` 移除 `scripts`；`tests/unit/app_management_config.test.ts` 覆盖拒收和配置脚本计划 | 顶层字段闭包和错误路径符合批准范围 | pass |
| CHG-remove-app-scripts-node | `management.kind` 分派 script/service，不再使用 `management.service` 包装 | proposal.md P-002、design.md File-Level Interfaces | `appScriptManagement` 和 `appServiceManagement` 归一为 `AppManagerDefinition`；`src/cli.ts`/`src/history.ts` 消费 `management.manager`；负向类型检查拒收旧 `service` 字段 | script/service 互斥结构和旧包装拒收一致 | pass |
| CHG-remove-app-scripts-node | `management.kind: script` 必须提供 start/stop/restart；service 直接携带系统服务配置 | proposal.md P-002、design.md Key Flows | loader 要求三脚本 invocation；service 分支校验 `name`/`tool`/enabled/daemon_reload/unit_config；unit 和 lifecycle 测试覆盖两种 kind | 配置形状与执行动作归属一致 | pass |
| CHG-remove-app-scripts-node | packageless App 不新增 check，deploy 只生成受管 configure | proposal.md P-003、design.md Key Flows | planning 中 packageless deploy 动作序列为 `["configure"]`；nginx 示例移除 scripts/check.ts；`tests/unit/config_planning.test.ts` 和 fetch 测试覆盖 | packageless 契约与实际 plan 一致；缺少前置检查是已确认取舍 | pass |
| CHG-remove-app-scripts-node | 同步文档、模板、实际 multipass 配置和 breaking API 测试 | proposal.md P-004、design.md Implementation Order | README、guide、module boundary、skill reference/assets、multipass App YAML 已更新；`verify_app_management_contract.ts` 与 removed-type negative test 通过 | 用户可见契约与实现一致 | pass |

## Independent Defect Discovery

| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- | --- |
| requirement-and-behavior | 顶层 scripts 禁用、management.kind 分派、packageless 去 check、同步和测试 | proposal.md 四个 Proposal Items、design.md、实际 app.yaml、`src/config.ts`、`src/planning.ts` 和统一测试工件 | 将 jx-server/jx-web/nginx 逐个代入装载与 deploy 计划；检查是否残留 check、旧包装或顶层 scripts | 批准范围内行为完整；示例仅剩 jx-server/jx-web stage/activate 和 nginx configure | pass |
| logic-and-control-flow | management.kind 分派、manager 归一、plan 动作序列和 App package 归属 | `appScriptManagement`、`appServiceManagement`、`buildPlan` 的 `scriptRestart`/`appScriptManagerAction`/package 分支及相关测试 | 构造 script、service、packageless、start/stop/restart 和 versioned deploy 输入，检查分支是否错误落入旧逻辑 | script manager restart 不会因 release committed 跳过；service manager 的旧三阶段快照只执行一次重启 | pass |
| boundary-and-input | 空字段、非法 kind、缺 run_as、重复目标、路径与 manager 字段闭包 | `fields()` 闭包、`appRunAs`、`managedConfigTarget`、重复目标测试和 `validatePlanShape` | 用缺失/多余字段、非法 kind、旧 wrapper、路径逃逸和重复 target 输入尝试通过装载 | 非法输入在 SSH 前失败关闭；错误信息指向 schema 1 契约 | pass |
| state-and-data-integrity | App 历史快照、release committed 状态、manager 状态和 operation lease | `src/history.ts` 的 `encodeManagement`/`decodeManagement`、`src/execution.ts` 的 deployment/lease 状态、history 和 lifecycle 测试 | 篡改旧 manager 形状、重复步骤、失败后恢复和并发锁路径 | 快照键闭包收紧为 `manager`；操作锁和发布状态语义未引入非法转换 | pass |
| error-handling-and-recovery | 配置装载失败、发布失败、配置发布恢复、服务/脚本动作失败 | schema rejection tests、DV publish/switch/service/marker/restore 故障注入、integration lifecycle attempt | 检查失败是否吞错、错误分类是否漂移、恢复是否遗漏 script manager restart | 未发现吞错；service manager 旧快照的冗余 restart 被显式跳过，script manager restart 独立执行 | pass |
| resource-lifetime-and-cleanup | bundle、workspace、operation lock、版本临时资源 | executor finally 清理链、DV deployment tests、`cleanupVersionedRelease`、integration lifecycle tests | 注入工作区清理/锁释放失败，检查是否泄漏资源或误清恢复资料 | 本任务未新增资源类型；既有 workspace、lock 和 release cleanup 生命周期保持不变 | pass |
| concurrency-and-ordering | stage/activate 全局屏障、script manager restart、App/目标锁 | `src/planning.ts` dependency/order、`tests/dv/versioned_deploy_order.test.ts`、operation lock 和 lifecycle tests | 检查是否存在多目标 activate 早于 stage、重复 restart 或 lock 释放遗漏 | stage 全局完成后 activate，script manager restart 不跳过；service manager 旧快照避免重复重启 | pass |
| interface-and-compatibility | App YAML schema、TypeScript public types、plan snapshot、CLI output、文档/技能示例 | removed-type negative test、consumer closure、history round-trip、CLI serialize、文档 contract test | 检查旧 consumer、旧计划快照和示例是否被错误接受或缺少迁移证据 | breaking API 变更按确认范围执行；旧 schema 无兼容层，负例和闭包扫描通过 | pass |
| security-and-capacity | run_as、script permission whitelist、secret subset、operation lock、bundle capacity | loader scriptInvocation 权限校验、machine-scoped secrets、transport boundary/security tests、executor identity validation | 构造未声明权限、越权秘密、bundle 爆炸或绕过 managed lock 输入 | 未发现新增信任边界；配置脚本和 manager 脚本仍走权限白名单与降权/锁路径 | pass |
| test-adequacy | schema、plan、history、execution、integration、breaking API 和文档示例 | testing.md/testplan.yaml、task test-run artifact、unit/DV/integration/contract 测试源码、multipass validate/plan 输出 | 核对测试是否可暴露旧 schema 残留、package 丢失、script restart 缺失、锁/身份缺失和文档漂移 | 299 个仓库测试和 13 个任务级命令通过；用例覆盖 normal/negative/compatibility/lifecycle/cross-module 边界 | pass |

## Document Consistency

| Document | Source | Implementation Consistency | Finding | Status |
| --- | --- | --- | --- | --- |
| design | design.md | `management.kind` 分派、packageless configure-only、`manager` 快照、breaking API closure 与实现一致 | 无不一致 | pass |
| testing | testing.md, testplan.yaml | 表列用例、change_id、contract steps 和任务统一入口运行工件一致 | 无不一致 | pass |

## Result Summary

- Overall result: accepted
- Outcome: App schema 1 已收敛为顶层 `configs` 与 `management.kind: script|service`；顶层 `scripts`、旧 `management.service` 包装和 packageless check 均按确认范围移除，实际 multipass 配置、文档、技能和测试同步通过。
- Blocking issues: none
- Next action: 完成 lifecycle 并从未完成索引移除。后续真实部署前仍需确认目标 Multipass、systemd、制品和 Redis 密钥；本次本地验收不证明真实节点服务可用。已另行发现 `application.yml` 中明文 `token.secret` 的范围外风险，建议单独任务迁移到 `ELEPH_TOKEN_SECRET`。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 独立反例检查覆盖行为、分支、边界、状态、恢复、资源生命周期、并发、兼容、安全和测试充分性；未发现阻断缺陷，任务范围内四项需求均有实现和运行证据。
