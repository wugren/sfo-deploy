---
task_manifest: task.yaml
status: approved

Risk profile: ./risk-profile.yaml
---

# Proposal：修复 multipass eleph-server deploy 直到成功

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 已知阻塞是 `serviceCommand` 对 systemctl 的
  `daemon-reload` 误加 `-- <unit>`；当前用户要求继续修复同一 multipass deploy 直到全部
  5 步成功。目标直接改变真实部署与失败补偿路径，复验可能暴露框架执行、发布提交、
  systemd 收敛或集群配置中的后续独立缺陷。这属于部署/回滚语义与 runtime integration 的
  实质影响，因此按 high-risk 执行。
- Proposal and tier confirmation: 用户于 2026-09-10 明确确认本提案和 high-risk 层级；授权
  包括完整实施、测试、复跑真实部署、独立验收和收尾。

## Background and Goal

078 修复 GNU `test --` 缺陷后，真实 multipass 部署推进到 systemd 准备阶段并出现新的失败：

```text
[eleph-server] jx-server stage（1/5）... 失败：systemd daemon-reload 失败
```

远端只读复核确认根因：框架通过 `serviceCommand` 构造的命令为
`systemctl daemon-reload -- jx-server.service`，而 Ubuntu 24.04 的 systemctl 对该调用返回
`Too many arguments.` 且退出码 1（`daemon-reload` 是全局子命令，不接受 unit 参数）。
本地单元测试只断言 argv 前两项（`["systemctl", "daemon-reload"]`），因此未暴露追加参数的问题。

目标是让 `daemon-reload` 调用不带 unit 参数，同时保持 `enable`/`disable`/`start`/`stop`/
`restart`/`reload` 等需要 unit 的子命令继续携带 `-- <unit>`；然后继续复验、定位并修复
同一部署命令链路上的后续阻塞性缺陷，直到完整执行成功。

## Scope

### In scope

- `src/service_management.ts`：systemctl 命令构造逻辑按子命令区分是否追加 `-- <unit>`；
  `daemon-reload` 不追加，其余既有子命令行为不变（`prepareSystemd` 与 `restoreSystemd`
  共用同一构造函数，一处修正覆盖两条路径）。
- 复验中发现并阻断本次 5 步成功的其他框架代码、配置或测试缺陷；修复保持目标命令的
  预期语义，不引入无关重构。
- `tests/unit/service_management.test.ts`：把 daemon-reload 断言改为完整 argv，并显式断言
  enable/restart 等仍携带 unit；覆盖 prepare 与 restore 两条路径。新增缺陷按所需单元、DV、
  集成或契约测试补充覆盖。
- 本地验证：`deno task check`、改动文件 `fmt`/`lint`、单元与集成测试、`deno task test`。
- 在 multipass `eleph-server` 上重新执行同一部署命令；必要时只读复核远端状态，并在失败
  补偿后清理属于同一失败事务的临时部署资源，再安全重试。

### Out of scope

- 不扩展到 multipass `eleph-server` 之外的环境、集群、机器或本命令未使用的部署目标。
- 不改变 App 业务包内容、业务运行语义、服务命名、版本号、来源或哈希。
- 不改变 systemd 收敛状态机、enable/active 判定、补偿顺序、unit 渲染或服务超时语义。
- 不修改集群配置、示例 App、环境脚本、文档契约或 Harness 规则。
- 若发现需要改变上述非目标才能成功的缺陷，停止并返回提案确认，不默认扩权。

### Boundary with neighboring modules

`src/execution.ts` 继续编排 stage/activate 与补偿；`src/systemd_unit.ts` 继续渲染 unit 内容；
发布提交由 `src/versioned_release_management.ts` 负责。本任务修正的 argv 形状属于
`src/service_management.ts`；后续阻塞性缺陷只在其阻断目标命令成功时修复。

## Requirement Review

请求合理：`systemctl daemon-reload` 带 unit 参数在 Ubuntu 24.04 上必然失败，且该调用位于
versioned stage 的关键路径，属于阻塞性缺陷。远端已复现：`systemctl daemon-reload -- jx-server.service`
→ `Too many arguments.`，`exit=1`。最小正确修复是仅在需要 unit 的子命令上追加 `-- <unit>`。
远端只读复核显示服务 unit 仍未安装，且存在两次失败事务留下的临时 latest/marker 文件；
这支持把后续阻塞修复纳入同一目标。真实部署授权来自用户当前请求。

备选方案与取舍：

- 方案 A（选定）：在 `serviceCommand` 内按子命令判断是否追加 unit，保持其他调用方不变。
- 方案 B：在 `prepareSystemd`/`restoreSystemd` 调用处绕过 `serviceCommand` 直接发命令，会重复
  特权与超时处理，且容易遗漏补偿路径。
- 方案 C：改为 `systemctl daemon-reload` + 单独的 `systemctl enable/reset-failed` 组合命令，
  不解决根因且扩大行为变化。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-multipass-deploy-success | `systemctl daemon-reload` 不再携带 `-- <unit>`，其余 unit 子命令保持携带。 | 仅 systemctl 命令构造；不改 service 工具分支、状态判定、超时或特权处理。 | 按子命令区分构造，略增分支复杂度；换取真实 Ubuntu 行为正确。 | 单元测试断言完整 argv：daemon-reload 无 unit，enable/restart 等带 unit；旧实现下断言失败。 | 不重写服务收敛流程。 |
| P-002 | CHG-multipass-deploy-success | prepare 与 restore 两条 daemon-reload 路径都通过同一修正。 | `serviceCommand` 是两条路径的唯一构造入口，不额外新增旁路。 | 无 | 单元/集成测试覆盖部署收敛与失败补偿两条路径。 | 不新增补偿动作。 |
| P-003 | CHG-multipass-deploy-success | 继续定位并修复阻断同一 multipass deploy 成功的后续链路缺陷。 | 只处理目标命令及其失败补偿必须经过的代码或配置；发现目标外问题单独报告。 | 迭代修复范围比只改一个 argv 更大，但符合用户明确的完成边界。 | 每个新阻塞有远端证据、最小修复和回归验证；部署推进到下一步。 | 不做无关重构。 |
| P-004 | CHG-multipass-deploy-success | 原部署命令在 multipass `eleph-server` 上完整成功。 | 真实部署会按既有事务继续改动目标机应用状态；失败时按既有补偿逻辑回滚。 | 真实环境验证成本高，但这是用户请求的最终验收。 | CLI 返回成功；5 步状态全部成功，无 skipped/blocked/failed。 | 不引入手动伪造的发布状态。 |

## Success Criteria

- Concrete user-visible or system-visible result: `sfo-deploy deploy --cluster multipass
  --config-root ./examples/eleph-server-multipass/clusters` 完整成功，jx-server/jx-web 的
  stage 与 activate 以及 nginx configure 均 succeeded。
- Required evidence: 单元测试完整 argv 断言旧红新绿；`deno task check` 与 `deno task test` 通过；
  最终真实部署日志显示状态成功且 5/5 步成功；修复后的服务 active/enable 状态符合配置。
- Explicit non-goals: 不修改其他集群；不改变业务包语义；不保证后续无关部署目标一定成功。

## Risks

- 若仅修改 prepare 路径而遗漏 restore 路径，失败补偿仍会报错；实现将修正放在共同构造函数并由
  测试覆盖两条路径。
- 复验可能暴露链路中的后续缺陷；本提案将同类阻塞缺陷纳入同一目标，但每个修复仍需
  设计映射和测试证据，避免无审查的迭代修改。
- 真实部署会继续更新 `eleph-server` 上的应用状态；属于用户原始部署意图的继续。
- 高风险流程在确认后需要完整的 risk profile、design、testing 和独立 acceptance 证据。
