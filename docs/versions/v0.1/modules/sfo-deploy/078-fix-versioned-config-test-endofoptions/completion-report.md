# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/078-fix-versioned-config-test-endofoptions.md

## Delivery Summary

- Outcome: `src/transport.ts` 中 `publishManagedConfigs` 与 `#ensureReleaseParent` 传给
  `/usr/bin/test` 的 4 处 `--` 已移除（`-d` 父目录探测与 `-e`/`-L`/`-d` 逐级准备探测）。
  Ubuntu 24.04 的 GNU `test` 现在按预期返回 0/1，077 已实现的“候选版本内创建缺失配置父目录”
  分支恢复可达；集成回归按真实 GNU 行为建模并锁定了该 argv 约束。
- Handoff: 原始 `binary operator expected` 缺陷已修复并在真实 multipass 集群复验：发布 ID
  `r20260910T070645704430Z-0b7f3565e5b9ac21` 的 `jx-server:stage` 越过配置发布并推进到
  systemd 准备，随后失败于独立缺陷 `systemctl daemon-reload -- <unit>`（见 F-001），该缺陷
  需要另行确认任务后修复。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-versioned-config-test-endofoptions | P-001：`/usr/bin/test` 探测不再传递 GNU test 不支持的 `--` | proposal.md P-001 | `src/transport.ts` 4 处参数列表移除 `--`；`tests/integration/versioned_transport_boundary.test.ts` 新增 GNU 行为回归并断言不含 `--` | 交付与提案一致，旧实现红色、新实现绿色 | pass |
| CHG-versioned-config-test-endofoptions | P-002：缺失父目录按 077 契约逐级创建后继续发布，边界拒绝不变 | proposal.md P-002 | 集成用例覆盖缺失父目录创建顺序、无 run_as、身份、中间符号链接拒绝；11/11 通过 | 目录创建与边界语义未被放宽 | pass |
| CHG-versioned-config-test-endofoptions | P-003：在 multipass `eleph-server` 上重新执行原部署命令确认缺陷消失 | proposal.md P-003 | 真实 deploy 日志：原 `binary operator expected` 消失，stage 推进到 systemd 准备；远端只读复核 `sudo -n systemctl daemon-reload -- jx-server.service` 返回 `Too many arguments.`/exit=1 属独立缺陷 | 本缺陷已确证消失；后续失败为独立发现 F-001 | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `src/transport.ts` `publishManagedConfigs`/`#ensureReleaseParent` 全部分支、`git diff`、077 设计与验收报告 | 逐一核对 4 处 `test` 调用与 GNU 退出码语义，确认没有遗漏其他 `--`；临时恢复 `--` 复现旧行为后再还原 | 未发现遗漏或语义变更；`realpath`/`stat`/`install`/`mv` 的 `--` 为 GNU 合法用法，保持原样 | pass |
| boundaries-and-failure-paths | `safeRemotePath`、`releaseRoot` 校验、符号链接拒绝、越界与事务恢复用例 | 检查以 `-` 开头的操作数不可能出现（只接受绝对规范路径）、缺失/存在/异常退出码分支、失败不写目标 | 未发现边界放宽；失败路径仍先校验后写入，异常退出码仍以 `TransportError` 拒绝 | pass |
| regression-and-side-effects | 全量 `deno task test` 303 个测试、`deno task check`、改动文件 `fmt`/`lint`、真实 deploy 日志、远端只读状态 | 检查系统密钥、预置环境、versioned 发布、配置契约与真实集群行为是否受影响 | 未发现本改动引入的回归；真实复验暴露的 `daemon-reload` 参数缺陷成因位于 `src/service_management.ts` 的既有 `serviceCommand`，非本改动引入（F-001） | pass |

## Verification

- Targeted check: `deno task check`；`deno fmt --check src/transport.ts tests/integration/versioned_transport_boundary.test.ts`；`deno lint src/transport.ts tests/integration/versioned_transport_boundary.test.ts`；`deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/integration/versioned_transport_boundary.test.ts`；`deno task test`；multipass 真实部署复验
- Result: passed
- Exception reason: 仓库级 `deno task fmt`/`deno task lint` 在未改动的既有脏文件上失败（1 处格式、6 处 lint，属先前任务遗留）；本任务改动文件通过对应的窄域检查

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-001 | medium | 真实 deploy 发布 ID `r20260910T070645704430Z-0b7f3565e5b9ac21`；远端复现 `sudo -n systemctl daemon-reload -- jx-server.service` → `Too many arguments.` exit=1；`src/service_management.ts#serviceCommand` 对 systemctl 无条件追加 `--` 与 unit 参数 | 独立既有缺陷：`daemon-reload` 不接受 unit 参数，导致 `jx-server:stage` 在 systemd 准备阶段失败；超出本任务提案范围，需另行确认任务修复 | no |
| F-002 | low | `deno task fmt`/`deno task lint` 输出；改动文件窄域检查通过 | 仓库级格式与 lint 在先前任务遗留的未改动文件上失败，非本任务引入 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 原缺陷已修复并有旧红新绿回归与真实 Multipass 复验证据；交付与已确认提案一致，
  未引入新的边界或契约变化。F-001 为本次复验发现的独立缺陷，已记录并移交后续任务处理。
