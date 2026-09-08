---
task_manifest: task.yaml
status: approved
---

# Proposal：识别缺失 unit 的 inactive/exit 4 状态

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 这是上一次首次部署状态识别修复的边界
  残留，仍影响 systemd 生命周期执行行为；根因明确、改动集中在状态读取分支，
  无 schema、安全边界或持久化格式变更，适合 standard。
- Proposal and tier confirmation: 用户于 2026-09-08 确认提案并选择 standard。

## Background and Goal

Multipass Ubuntu 环境中，`systemctl is-enabled jx-server.service` 对缺失 unit
返回退出码 4 和 `not-found`，已作为首次部署合法基线处理。但同一环境的
`systemctl is-active jx-server.service` 返回退出码 4 和输出 `inactive`。当前
状态读取器只在 active 输出为 `not-found` 时放宽退出码 4，因此首次 activate
在读取 active 状态时仍失败，unit 未进入发布和收敛阶段。

目标是当 enabled 查询已经确认受管 unit 缺失时，接受 active 查询的明确缺失
状态 `inactive` 或 `not-found`（均返回退出码 4），并视为未运行；随后继续执行
既有 unit 发布、daemon-reload、enable 和 on_deploy 收敛。

## Scope

### In scope

- 修正 `src/service_management.ts` 中缺失 unit 的 active 状态判定：以
  `is-enabled` 明确返回 `not-found`/exit 4 为前提，接受 `is-active` 返回
  `inactive` 或 `not-found` 且 exit 4 的组合。
- 将该组合解释为 `active=false`，保留实际 active 输出。
- 更新单元测试和执行级回归测试，覆盖 Ubuntu 返回 `inactive`/exit 4 的真实
  缺失 unit 边界。

### Out of scope / explicit non-goals

- 不改变已有 unit 的 active 状态读取、收敛或失败补偿语义。
- 不忽略其他退出码、未知输出、权限故障或 systemd 不可用故障。
- 不修改 unit 渲染格式、计划 schema、CLI 输出或部署顺序。
- 不执行真实 Multipass 部署；修复后由用户重新部署确认远端结果。

## Requirement Review

- 请求合理：上一个任务只覆盖了 active 输出 `not-found` 的假设，未覆盖
  Ubuntu 对缺失 unit 输出 `inactive` 且 exit 4 的实际行为。
- 主要权衡：不能简单接受 active 的所有 exit 4，否则可能掩盖其他 systemd
  状态异常；因此必须先由 `is-enabled` 的 `not-found` 确认 unit 缺失。
- 选定方向：只在同一状态读取中确认 unit 缺失时，允许 active 输出为明确的
  `inactive` 或 `not-found` 并返回未运行基线。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-missing-unit-active-state | Ubuntu 缺失 unit 的 `is-active` 返回 `inactive`/exit 4 时继续首次部署。 | 前提是同一 unit 的 `is-enabled` 明确返回 `not-found`/exit 4。 | 用 enabled 查询先确认缺失，避免放开所有 active 异常。 | 单元测试和执行级 activate 回归通过。 | 不忽略未知 active 状态。 |
| P-002 | CHG-missing-unit-active-state | 缺失基线继续触发 unit 发布与服务收敛。 | 复用现有 managed config 事务和 systemd 收敛路径。 | 不新增服务状态机。 | activate 测试确认 daemon-reload/enable/restart 执行且服务收敛为 enabled/active。 | 不手工创建远端 unit。 |

## Success Criteria

- Concrete user-visible or system-visible result: 在没有 `jx-server.service` 的
  Ubuntu 目标机上，`jx-server:activate` 不再因 `读取 systemd active 状态失败:
  inactive` 失败，而会发布 unit 并完成服务收敛。
- Required evidence: 更新后的 systemd 单元测试、activate 执行级测试、类型检查
  和相关回归验证通过。
- Explicit non-goals: 本任务不直接修改远端状态，也不承诺在本任务内执行真实
  Multipass deploy。

## Risks

- 如果 enabled 和 active 查询之间目标状态发生变化，可能对短暂缺失状态建立
  基线；这是现有两次查询间已存在的竞态，后续发布/enable 失败仍会 fail closed。
- 过度放宽 active 检查可能掩盖 systemd 故障；通过限定 enabled 先返回
  `not-found`、active 输出只能是 `inactive`/`not-found` 且 exit 4 控制范围。
