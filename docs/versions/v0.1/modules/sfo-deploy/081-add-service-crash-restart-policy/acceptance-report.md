Task manifest: task.yaml

# sfo-deploy 验收报告

## Findings

| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- | --- | --- |
| F-001 | none | none | state-and-data-integrity | `src/history.ts#encodeManagement` 现在按字段存在性序列化 `restart_policy/restart_sec/start_limit_interval_sec/start_limit_burst`；`decodeSystemdUnitConfig()` 使用 `expectKeysOptional()` 并做枚举/整数边界校验 | 初审发现的历史快照字段丢失已修复；由 `tests/unit/history.test.ts#v4 codec round-trips service unit config` 验证新字段完整往返且旧快照缺省字段读取为 undefined | no |
| F-002 | none | none | test-adequacy | `tests/unit/history.test.ts` 新增新字段往返和旧快照兼容断言；task all run artifact `.harness/test-results/test-runs/20260911T073609Z-sfo-deploy+081-add-service-crash-restart-policy-all.json` 通过 27 个相关测试 | 初审缺少的快照往返覆盖已补充，覆盖新字段往返、旧快照兼容和缺省渲染 | no |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-11
- In-scope implementation: `src/types.ts`、`src/config.ts`、`src/systemd_unit.ts` 的可选崩溃拉起字段；README、集群配置技能参考与模板同步；相关单元/契约测试。
- Review mode: independent falsification review；先审查提案、交付代码、调用方、测试与运行证据，再形成结论。

## Requirement Coverage

| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-service-restart-policy-schema | `unit_config` 可声明 systemd 崩溃拉起策略与启动限流，装载失败关闭，缺省不渲染新指令 | `proposal.md` P-001；`design.md` File-Level Interfaces | `src/config.ts#systemdUnitConfig`、`src/systemd_unit.ts#renderUnit`、`src/history.ts#encodeManagement`、`src/history.ts#decodeSystemdUnitConfig`、`tests/unit/app_management_config.test.ts`、`tests/unit/systemd_unit.test.ts`、`tests/unit/history.test.ts` | 装载、渲染、缺省兼容和计划/历史快照往返均满足 | pass |
| CHG-service-restart-policy-template-doc | README 与集群配置技能契约/模板展示推荐写法 | `proposal.md` P-002；`design.md` Directly Mapped Change Items | `README.md`、`skills/sfo-deploy-cluster/references/app.md`、`skills/sfo-deploy-cluster/assets/app-versioned/app.yaml`、`tests/contract/verify_app_management_contract.ts` | 文档与模板契约同步且任务级测试通过 | pass |

## Independent Defect Discovery

| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- | --- |
| requirement-and-behavior | 可选崩溃拉起配置、外部 unit 非目标、旧配置兼容 | 提案 Scope/Success Criteria、`src/config.ts`、`src/systemd_unit.ts`、`src/history.ts`、README 与技能模板 | 尝试构造旧配置、部分字段、非法枚举/越界和外部 unit 声明；检查历史快照往返 | 直接行为和快照状态保持符合；外部 unit 仍按非目标拒绝新字段 | pass |
| logic-and-control-flow | 渲染条件与 section 顺序 | `renderUnit()` 条件展开、`[Unit]`/`[Service]` 顺序、渲染测试 | 检查缺省、`no`、`0`、部分字段和全字段是否落入正确 section | 未发现错误分支或不可达行为 | pass |
| boundary-and-input | 枚举、整数边界、YAML 字段白名单 | `SYSTEMD_RESTART_POLICIES`、`boundedInteger()`、装载负向测试 | 尝试未知策略、负值、上限外值、未知字段和空配置 | 边界在装载期失败关闭；未发现注入或误接受 | pass |
| state-and-data-integrity | 计划快照、release history、恢复回放 | `src/history.ts#encodeManagement`、`decodeSystemdUnitConfig`、`tests/unit/history.test.ts` | 检查新计划生成、旧计划读取和快照往返后 unit 渲染是否一致 | 新字段完整往返；旧快照缺省字段读取为 undefined，非法枚举/越界失败关闭 | pass |
| error-handling-and-recovery | 服务发布失败补偿与配置装载失败 | 既有 managed config/service 补偿路径、装载负向测试 | 检查是否新增吞错、回滚路径改变或半更新状态 | 未改变失败补偿；未发现新增吞错路径 | pass |
| resource-lifetime-and-cleanup | unit 候选生成与发布事务 | `serviceUnitManagedConfig()`、`generateSystemdUnitSkeleton()`、既有配置发布事务 | 检查是否引入句柄、临时状态或额外清理责任 | 无新增资源；旧清理路径不变 | pass |
| concurrency-and-ordering | 计划串行执行与 unit 发布顺序 | `src/execution.ts` 既有 stage/activate 顺序、`src/history.ts` 快照编解码、DV/集成套件边界 | 检查并发回放是否可能得到不同 restart 指令 | 快照往返一致；未新增并发路径或跨步骤重解释 | pass |
| interface-and-compatibility | `SystemdUnitConfig`、历史快照、CLI/类型消费者 | `src/types.ts`、`src/mod.ts`、`src/history.ts`、`tests/contract/app_management_consumer.ts`、history 回归 | 检查旧快照、计划消费者和导出类型是否兼容 | 类型可选扩展；历史 wire format 向后兼容且支持新可选字段 | pass |
| security-and-capacity | systemd 指令注入、整数放大、unit 大小 | 装载白名单、`assertUnitText()`、`MAX_UNIT_BYTES`、渲染测试 | 尝试控制字符、systemd 展开、超大秒/次数和 unit 超限 | 新值只来自白名单/整数，未发现注入或无界输出；`on-watchdog` 在 `Type=simple` 下有效性记录为文档限制 | pass |
| test-adequacy | 装载、渲染、契约、快照和真实 systemd | task all run artifact `.harness/test-results/test-runs/20260911T073609Z-sfo-deploy+081-add-service-crash-restart-policy-all.json`、单元/契约/history 测试 | 判断测试是否能发现缺省兼容、非法值、旧快照和快照丢失 | 覆盖充分；真实 systemd 启动保持为 recorded manual gap | pass |

## Document Consistency

| Document | Source | Implementation Consistency | Finding | Status |
| --- | --- | --- | --- | --- |
| design | `design.md` | 生产装载/渲染、history 编解码与设计的 file-level sequence 一致 | no mismatch | pass |
| testing | `testing.md`、`testplan.yaml` | task all 通过；测试文档、testplan step 和实际运行工件一致 | no mismatch | pass |

## Result Summary

- Overall result: accepted
- Outcome: `unit_config` 崩溃拉起配置可装载并渲染为 systemd 指令；计划/历史快照完整保留新字段，旧配置和旧快照保持兼容。
- Blocking issues: 无。
- Next action: 无阻塞后续动作；真实 Linux 主机 systemd 行为保留为 manual gap，不属于本次本地验收声明。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 初审发现的 history 快照缺陷已修复并新增回归验证；独立缺陷发现、需求覆盖、文档一致性和任务级测试均无阻塞问题。
