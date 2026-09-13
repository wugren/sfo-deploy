---
task_manifest: task.yaml
status: accepted
---

Task manifest: task.yaml

# sfo-deploy 089 验收报告

## Findings

| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- | --- | --- |
| F-001 | none | none | state-and-data-integrity | 重新通过 design/implementation/testing 后，`lifecycle-check.py --require-prior acceptance` 通过；最新任务级 run artifact 为 `.harness/test-results/test-runs/20260913T043542Z-sfo-deploy+089-lifecycle-file-permissions-all.json` | 初审发现的 design 收据过期已通过返回 design 并重建下游收据关闭。 | no |
| F-002 | none | none | logic-and-control-flow | `src/history.ts#encodePlanInvocation` 保留旧快照脚本的空 `relativePath`；`tests/unit/history_regressions.test.ts#legacy v2 snapshot rearchives without a relative path` 覆盖 v2 解码、v4 重新归档和空路径保留 | 初审发现的旧 v2 快照重新归档失败已修复并有回归证据。 | no |
| F-003 | none | none | test-adequacy | `tests/unit/history_regressions.test.ts#legacy v2 snapshot rearchives without a relative path` 已纳入 taskplan U1/U3，并在 `.harness/test-results/test-runs/20260913T043542Z-sfo-deploy+089-lifecycle-file-permissions-all.json` 通过 | 初审缺少的旧 v2/v3 重新归档回归已补充并通过。 | no |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-13
- In-scope implementation: 生命周期脚本 `permissions.read/write` 贯通；Python 运行时与 schema v1 快照兼容路径移除；计划快照、CLI、文档与示例同步。
- Review mode: independent falsification review；直接复查提案、交付 diff、历史调用链、实际 Deno 子进程测试、task-scoped run artifact 和修复后的回归证据，再形成结论。

## Requirement Coverage

| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-lifecycle-file-permissions | 脚本可分别声明 `read/write` 远端路径，贯通装载、计划、快照与执行；workspace 始终保留 | `proposal.md` P-001；`design.md` File-Level Interfaces | `src/config.ts#scriptInvocation`、`src/history.ts#encodeInvocation`、`src/history.ts#decodePermissions`、`src/history.ts#encodePlanInvocation`、`src/transport.ts#executeDeno`、`tests/integration/script_file_permissions.test.ts`、`tests/unit/history_regressions.test.ts` | 权限主链路、Deno allow/deny、旧配置兼容和旧 v2/v3 重新归档均满足 | pass |
| CHG-remove-python-runtime | 删除 Python 运行时支持，Deno-only，Python v1 快照明确拒绝 | `proposal.md` P-002；`design.md` Overall Approach | `src/types.ts#ScriptRuntimeKind`、`src/transport.ts`、`src/secret_loader/python.py` 删除、`src/history.ts#decodePlan`、`tests/contract/verify_deno_contract.ts`、`tests/unit/history_regressions.test.ts` | Python loader/session/runtime 值已移除，v1 快照明确拒绝且 repository closure 通过 | pass |

## Independent Defect Discovery

| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- | --- |
| requirement-and-behavior | 读写授权、旧配置/旧快照兼容、Deno-only 边界 | 提案 Scope/Success Criteria、交付 diff、`src/config.ts`、`src/history.ts`、`src/transport.ts`、实际 Deno 子进程测试、旧 v2/v3 fixture | 尝试只读删除、越界写入、旧配置缺省、旧 v2/v3 快照回退和 Python v1 拒绝 | 未发现需求缺失、越界或旧快照兼容缺陷 | pass |
| logic-and-control-flow | 计划脚本编码、回退继承和权限合并 | `encodeStep()`、`encodePlanInvocation()`、`encodeInvocation()`、`inheritRollbackSnapshot()`、`filePermissionPaths()` | 检查空 `relativePath`、重复路径、workspace 去重、内置脚本权限和动作分支 | 旧 v2/v3 空路径分支有回归覆盖；未发现错误 fallthrough 或错误分支 | pass |
| boundary-and-input | `read/write` 路径、快照缺省字段、旧快照脚本字段 | 配置负例、历史 fixture、`validatePathPermissions()`、`permissionValues()`、`pathPermission()` | 尝试相对路径、根路径、`.`/`..`、逗号、重复值和缺失字段 | 新权限边界失败关闭；旧快照空相对路径按合法遗留输入保留 | pass |
| state-and-data-integrity | 发布快照、回退计划和阶段收据 | `ReleaseStore`、`deriveRollbackPlan()`、`lifecycle.json`、stage receipts、latest run artifact | 检查哈希绑定、旧快照升级、重复记录和下游收据有效性 | 收据链完整；旧 v2/v3 回退重新归档保留空 `relativePath` 且有回归 | pass |
| error-handling-and-recovery | Deno 权限拒绝、快照拒绝、执行失败清理 | 实际子 Deno 测试、v1 fixture 测试、executor 失败/清理路径 | 检查是否吞错、错误分类是否正确、清理是否改变 | 未发现新增吞错、错误分类或恢复路径缺陷 | pass |
| resource-lifetime-and-cleanup | 子进程、临时目录、workspace 和会话 | 实际子 Deno 测试、executor 清理路径、transport cleanup | 检查成功、失败和取消时的资源生命周期 | 未发现新增泄漏或重复清理 | pass |
| concurrency-and-ordering | 计划串行执行、runtime key 复用、快照编码 | executor `runtimeChecked`、history codec、DV 计划顺序 | 检查同一 runtime 重复预检、依赖顺序变化和取消 | 未新增并发路径或顺序回归 | pass |
| interface-and-compatibility | 公开类型、计划 wire format、CLI JSON 和文档契约 | `src/mod.ts`、`src/cli.ts`、v2/v3/v4 fixtures、external consumer、README/guide | 检查旧消费者、旧快照和新字段兼容 | 新字段向后兼容；Python 破坏性移除有明确拒绝和文档迁移说明 | pass |
| security-and-capacity | Deno 文件权限、路径注入、子进程边界、输入上限 | `pathPermission()`、`validatePathPermissions()`、`permissionValues()`、实际 Deno allow/deny、`runPermission()` | 尝试路径逃逸、逗号注入、越界写、只读删除和重复授权 | 未发现注入或 Deno 沙箱绕过；run 子进程边界已按非目标记录 | pass |
| test-adequacy | 配置、快照、实际运行、移除和文档契约 | task all run artifact `.harness/test-results/test-runs/20260913T043542Z-sfo-deploy+089-lifecycle-file-permissions-all.json`、unit/DV/integration tests、contract closure | 判断旧快照重新归档、只读删除、越界写入和运行时移除能否被发现 | 覆盖充分；真实远端部署前提保留为 manual gap | pass |

## Document Consistency

| Document | Source | Implementation Consistency | Finding | Status |
| --- | --- | --- | --- | --- |
| design | `design.md` | 生产实现遵循设计的权限链路、Deno-only 边界和旧快照空 `relativePath` 约束 | no mismatch | pass |
| testing | `testing.md`、`testplan.yaml` | task all 通过；测试文档、testplan step 和最新 run artifact 一致 | no mismatch | pass |

## Result Summary

- Overall result: accepted
- Outcome: 生命周期脚本可精确授权 Deno 读写路径；未授权写入/删除被 Deno 拒绝；旧配置与旧 Deno v2/v3 快照保持兼容；Python 运行时与 v1 快照支持已移除并明确拒绝。
- Blocking issues: 无。
- Next action: 无阻塞后续动作；已获 run 权限的子进程不受 Deno 文件沙箱限制仍为文档记录的边界，不属于本任务验收声明。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 初审发现的收据过期、旧 v2/v3 快照重新归档回归和测试缺口均已修复；独立缺陷发现、需求覆盖、文档一致性和任务级测试无阻塞问题。
