# sfo-deploy 验收报告

## Findings

| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
|----|----------|--------------|----------------------|----------|---------|----------|
| F-001 | none | none | overall | `src/transport.ts#ensureReleaseParent`、`install -d -m 0750 -o runAs`、集成边界用例和最终 `realpath` 复核 | 未发现阻塞缺陷；远端文件系统固有的短暂检查/创建窗口在创建后由真实路径复核和 App 租约缓解 | no |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-10
- In-scope implementation: `src/transport.ts` 中 versioned 受管配置父目录的受限准备；`tests/integration/versioned_transport_boundary.test.ts` 安全回归；README、模块边界、指南、示例说明和集群配置技能参考同步。
- Review mode: independent falsification; conclusion selected after findings and category review

## Requirement Coverage

| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
|-----------|-------------------------|--------|-------------------------|---------|--------|
| CHG-versioned-config-parent | 带已验证 `releaseRoot` 的受管配置可在版本内创建缺失父目录；无 `releaseRoot` 行为不变；拒绝越界与符号链接逃逸 | `proposal.md` P-001/P-002 | `src/transport.ts#ensureReleaseParent`、`publishManagedConfigs`；`tests/integration/versioned_transport_boundary.test.ts` 覆盖创建、兼容、越界、发布根符号链接和中间符号链接 | 未发现需求缺失或越权行为 | pass |

## Independent Defect Discovery

| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
|----------|------------------|--------------------|-------------------|----------------------------------|--------|
| requirement-and-behavior | versioned stage/activate 配置发布 | 提案 P-001/P-002、`src/execution.ts#deploymentConfigTarget`、`src/transport.ts#publishManagedConfigs`、`src/versioned_release_management.ts` | 检查是否把修复扩大为无条件建目录或改变 latest/marker 语义 | 未发现缺失、越界或未授权行为；无发布根路径继续要求父目录存在 | pass |
| logic-and-control-flow | `src/transport.ts` 发布器父目录分支 | `src/transport.ts#publishManagedConfigs` 中 releaseRoot 校验、parentState 分支和 `src/transport.ts#ensureReleaseParent` 循环 | 验证缺失/存在/异常返回码、相对片段校验和最终 `realpath` 顺序 | 未发现错误分支或终止缺陷 | pass |
| boundary-and-input | `src/transport.ts` 远端目标与发布根路径 | `safeRemotePath`、`posix.dirname`、相对路径拆分、`realpath -e`、`test -L/-d` | 检查空片段、`.`/`..`、兄弟目录、中间符号链接和发布根符号链接 | 边界测试覆盖并通过；未发现可逃逸输入 | pass |
| state-and-data-integrity | `src/versioned_release_management.ts` 候选版本目录和 `src/transport.ts` 受管配置事务 | `prepareVersionedRelease`、`publishManagedConfigs`、`restoreManagedConfigs`、DV 发布/服务/标记失败用例 | 检查部分发布、重复发布、同版本部署和失败恢复 | 未发现非法状态转换；目录准备属候选版本，不污染旧 latest | pass |
| error-handling-and-recovery | `src/transport.ts` 目录创建失败与配置发布失败 | `requireSuccess` 调用、`ManagedConfigPublicationError`、DV 发布/恢复失败用例 | 检查错误传播、恢复资料保留和取消路径 | 未发现吞错或不可恢复路径 | pass |
| resource-lifetime-and-cleanup | `src/execution.ts` workspace、备份、操作锁 | executor finally 清理、`cleanupWorkspace`、`preserveWorkspace`、操作租约 | 检查成功/失败/恢复失败时的远端资源和锁生命周期 | 未发现新增泄漏；恢复失败仍按既有机制保留资料 | pass |
| concurrency-and-ordering | `src/execution.ts` 单 App 远端部署顺序 | `src/execution.ts` 串行步骤、App 操作锁、DV stage/activate 顺序用例 | 检查跨步骤乱序和配置/服务切换窗口 | 未发现新增部署步骤乱序、锁排序或取消窗口；`src/transport.ts#ensureReleaseParent` 的 TOCTOU 残留已单独记录为 F-001 | pass |
| interface-and-compatibility | `src/transport.ts` RemoteSession、计划契约和文档 | `ManagedConfigPublishRequest`、executor 调用、`tests/contract/verify_app_management_contract.ts`、文档同步 | 检查旧绝对 target、无 releaseRoot、示例配置和公共类型是否被破坏 | 未发现旧绝对 target、无 releaseRoot 或示例配置契约被破坏，公共类型保持不变 | pass |
| security-and-capacity | `src/transport.ts` 路径逃逸、目录权限和本地写入 | `#ensureReleaseParent`、`install -d -m 0750 -o runAs`、集成边界用例 | 尝试越界、跟随符号链接、无 runAs、不可穿越目录 | 未发现可复现的越界或符号链接逃逸；远端文件系统固有的短暂检查/创建窗口由创建后 `realpath` 复核和 App 租约缓解 | pass |
| test-adequacy | `tests/integration/versioned_transport_boundary.test.ts` 与 `tests/dv/versioned_deploy_order.test.ts` | `testplan.yaml`、`.harness/test-results/test-runs/20260910T043342Z-sfo-deploy+077-fix-versioned-config-parent-all.json`、integration/DV/contract 测试 | 确认红色回归、命令参数断言、安全拒绝断言和 DV 恢复断言能暴露原缺陷 | 未发现会导致缺陷逃逸的充分性缺口；真实 SSH/Multipass 不在本次验证范围 | pass |

## Document Consistency

| Document | Source | Implementation Consistency | Finding | Status |
|----------|--------|----------------------------|---------|--------|
| design | `design.md` | 实现遵循“先校验发布根、再逐段准备、最后复核真实边界”的设计，未引入发布根外目录 | no mismatch | pass |
| testing | `testing.md`、`testplan.yaml` | 测试文档与统一入口、红色回归和安全边界用例一致 | no mismatch | pass |

## Result Summary

- Overall result: accepted
- Outcome: 修复满足已确认提案。versioned stage 在候选版本内安全创建缺失配置父目录，原有边界保持拒绝，activate 依赖顺序和恢复事务未改变。
- Blocking issues: 无。
- Next action: 无需进一步修改；真实 Multipass/systemd 部署由用户在准备好制品和节点后执行。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 独立缺陷审查覆盖了所有必要类别；红色/绿色回归、安全边界、部署顺序和事务恢复证据支持接受。F-001 为低风险残留，不阻塞本次交付。
