---
task_manifest: task.yaml
status: approved
---

# Proposal：修复 versioned 配置父目录检查的 GNU test 参数兼容性

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 根因明确、影响有限：`publishManagedConfigs` 以
  `/usr/bin/test -d -- <path>` 探测配置父目录，而 Ubuntu 24.04 的 GNU `test` 不支持 `--`
  选项结束符，会把它当作二元比较并以退出码 2 失败，使 077 已实现的“候选版本内创建缺失父目录”
  分支不可达。改动集中在 `src/transport.ts` 的 4 处参数列表与对应集成测试，不改变
  `releaseRoot` 边界、符号链接拒绝、发布事务、配置 schema、CLI 契约或回滚语义；回滚只需恢复参数。
  命中 runtime-integration 与 build-config-deployment 触发面，但均未达到部署/回滚语义实质变化、
  安全边界变化或共享契约变化的升级条件；同类远端 `test` 兼容性缺陷 039 亦按 standard 交付。
  因此推荐 standard。
- Proposal and tier confirmation: 用户于 2026-09-10 确认提案并选择 `standard`；确认授权
  设计、实现、验证、真实 Multipass 复验、独立缺陷审查与收尾。

## Background and Goal

用户在 multipass 集群执行
`sfo-deploy deploy --cluster multipass --config-root ./examples/eleph-server-multipass/clusters`
时，第 1 步 `app:eleph-server/jx-server:stage` 失败：

```text
配置目标父目录不存在 /home/ubuntu/eleph-server/0.1.0/resources: /usr/bin/test: ‘--’: binary operator expected
```

这是 077-fix-versioned-config-parent 之后的残余缺陷。077 让受管配置可以在已验证的候选版本
目录内创建缺失父目录，但发布器仍用 `/usr/bin/test -d -- <path>` 探测父目录是否存在。
GNU `test` 不支持 `--` 选项结束符：`/usr/bin/test -d -- /tmp` 返回退出码 2 并输出
`‘--’: binary operator expected`。`publishManagedConfigs` 只在退出码为 1（命令行为成功但判定为假）
时进入“父目录缺失则创建”分支，退出码 2 会直接走 `requireSuccess` 失败路径，因此报错文本里
“配置目标父目录不存在”后面还带上了 test 的用法错误。

目标是让 versioned stage/activate 的存在性探测在 GNU `test` 上按预期返回 0/1，使 077 的受限
父目录创建逻辑真正生效，同时不放宽任何路径与安全边界。

## Scope

### In scope

- `src/transport.ts`：移除 `publishManagedConfigs` 与 `#ensureReleaseParent` 传给
  `/usr/bin/test` 的全部 4 处 `--`（`-d` 父目录探测、`-e`/`-L`/`-d` 逐级准备探测）。
- `tests/integration/versioned_transport_boundary.test.ts`：更新受影响命令建模，并加强回归，
  按真实 GNU 行为对含 `--` 的 `/usr/bin/test` 调用返回退出码 2，断言修复后不再向
  `/usr/bin/test` 传递 `--`，且缺失父目录仍按 077 契约逐级创建后继续发布。
- 本地验证：`deno task check`、`deno task fmt`、`deno task lint`、`deno task test`。
- 修复后在实际运行的 multipass `eleph-server`（Ubuntu 24.04）上重新执行同一部署命令，确认
  `jx-server` stage 不再因该缺陷失败。

### Out of scope

- 不改变 077 的目录创建策略、`releaseRoot` 校验、真实路径边界、符号链接拒绝和配置发布事务。
- 不修改 `realpath`/`stat`/`install`/`mv`/`rm` 等其他远端工具的 `--` 用法（GNU 支持且已被
  039 验证，`test` 是例外）。
- 不修复本次真实部署可能暴露的其他独立缺陷；若 activate/nginx 阶段出现新问题，单独报告并按
  流程另行处理。
- 不修改集群配置、示例 App、环境脚本或长期文档契约。

### Boundary with neighboring modules

`src/execution.ts` 继续决定 `releaseRoot` 与目标映射，`src/versioned_release_management.ts`
继续负责候选版本目录；本任务只修正 `src/transport.ts` 远端探测命令的 argv 兼容性。

## Requirement Review

请求合理：077 承诺的行为在当前代码上不可达。本地只读复现与用户日志一致：
`/usr/bin/test -d -- /tmp` → 退出码 2，stderr `‘--’: binary operator expected`；
`/usr/bin/test -d /tmp` → 退出码 0。最小正确修复是让 `/usr/bin/test` 调用不带 `--`。
路径在此之前已经过 `safeRemotePath` 校验为绝对规范路径，操作数不会以 `-` 开头，因此
不需要也不可能通过 `--` 兜底。

备选方案与取舍：

- 方案 A（选定）：移除 `/usr/bin/test` 的 `--`，与 039 既有修复保持一致，改动最小且可回归。
- 方案 B：改用 `[ -d ... ]` 或其他探测形式，无额外收益且扩大改动面。
- 方案 C：改用 `stat`/`ls` 探测存在性，会改变错误语义与失败分类，超出本缺陷范围。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-versioned-config-test-endofoptions | `src/transport.ts` 中 `/usr/bin/test` 的存在性/类型探测不再传递 GNU `test` 不支持的 `--`。 | 仅这 4 处参数列表；路径仍先经 `safeRemotePath` 与 `releaseRoot` 校验。 | 失去 `--` 保护仅对其他工具的选项注入有意义，absolute 路径场景不适用；换取 GNU test 上 0/1 语义可达。 | 集成回归按 GNU 行为返回退出码 2，旧实现红色，新实现绿色。 | 不改目录创建策略、边界校验或发布事务。 |
| P-002 | CHG-versioned-config-test-endofoptions | versioned stage 在候选版本内缺失配置父目录时按 077 契约逐级创建并继续发布。 | 仅限已验证 `releaseRoot` 内；越界、符号链接、非普通目录仍拒绝。 | 无新增能力，只是让既有契约可达。 | `tests/integration/versioned_transport_boundary.test.ts` 的创建与边界用例通过。 | 不新增自动创建范围。 |
| P-003 | CHG-versioned-config-test-endofoptions | 在 multipass `eleph-server` 上重新执行原部署命令，确认该缺陷不再出现。 | 真实部署会改动目标机应用状态（用户原命令的继续）；其他阶段失败按独立问题处理。 | 真实环境验证成本高、耗时长，但能确证 Ubuntu 24.04 GNU test 行为。 | 部署日志中 `jx-server` stage 不再出现 `binary operator expected`，进入后续发布/服务阶段。 | 不保证本次部署全部 5 步成功。 |

## Success Criteria

- Concrete user-visible or system-visible result: `jx-server:stage` 在 multipass 上越过父目录
  探测并继续配置发布；`/usr/bin/test` 不再产生 `binary operator expected`。
- Required evidence: 集成回归测试旧红新绿并断言 `/usr/bin/test` 调用不含 `--`；
  `deno task check`/`fmt`/`lint`/`test` 通过；真实部署日志证明错误消失。
- Explicit non-goals: 不保证 activate/nginx 阶段全部成功；不修改任何配置或安全边界。

## Risks

- 选项解析风险低：`safeRemotePath` 只接受绝对规范路径，`test -d /abs/path` 不存在被误读为选项的
  可能；测试会显式断言不再传递 `--`。
- 回归测试保真度：既有桩曾把 `test -d -- <path>` 建模为退出码 1，掩盖了 GNU 行为；本次回归
  按真实退出码 2 建模，避免再次逃逸。
- 真实部署风险：重新部署会更新 `eleph-server` 上已部署的版本与配置，可能触发后续阶段失败；
  这些失败将被记录为独立发现，不影响本缺陷的修复判定。
