---
task_manifest: task.yaml
status: approved
---

# Proposal：让 activate 发布受管 systemd unit

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 修复影响内置 versioned App 的部署运行时
  行为和 systemd 服务生命周期，因此不是 trivial；但根因明确、改动集中在一个执行
  分支，无 schema、安全边界或持久化格式变更，回滚简单，适合 standard。
- Proposal and tier confirmation: 用户于 2026-09-07 确认提案并选择 standard。

## Background and Goal

内置 versioned App 的 deploy 已拆分为 `stage` 和 `activate`，计划中的
`activate` 保留了 `management.service` 和 `unit_config`。但执行器只在
`deploy/configure/start/stop/restart` 动作中解析 `management.service`，
没有包含 `activate`。这导致生成的 service unit 不会被发布到
`/etc/systemd/system/<unit>`，后续 `daemon-reload`/`enable`/`restart` 也
不执行；后续独立 restart 读取 enable 状态时返回 `not-found`。

目标是在 `activate` 阶段按已有 managed config 事务发布 systemd unit，并完成
service 收敛，使 jx-server 等首次部署不再失败于 `not-found`。

## Scope

### In scope

- 在执行器的 App 动作解析中加入 `activate`，使其读取 `management.service`
  并生成对应的 `serviceUnitManagedConfig`。
- 让受管 unit 与其他 managed config 一样进入候选发布、service 收敛和失败补偿
  路径。
- 增加执行级回归验证，证明 `activate` 会发布 unit 候选并执行 systemd 收敛。

### Out of scope / explicit non-goals

- 不修改 `stage` 的职责、deploy/activate/restart 顺序或版本目录发布算法。
- 不修改 systemd unit 渲染格式、配置 schema 或 CLI 输出契约。
- 不执行真实 Multipass 部署，也不直接修改远端系统状态。
- 不改变已有 service 失败后的有界补偿语义。

### Boundary with neighboring modules

- `systemd_unit.ts` 继续负责渲染 unit；本次只让执行器在 `activate` 阶段消费它。
- `service_management.ts` 继续负责 systemd 状态读取、收敛和补偿；本次不改其逻辑。
- `planning.ts` 生成的计划已经包含 `activate` 的 `management.service`，不需要变更。

## Requirement Review

- 请求合理：计划与执行器行为不一致，`activate` 是内置 versioned 部署的关键阶段。
- 主要权衡：让 `activate` 承担 unit 发布和 service 收敛，避免重复引入一个额外
  阶段；这符合计划中已经保留的 `management.service` 数据。
- 选定方向：最小修正动作集合，并利用现有配置发布事务和 systemd 收敛路径。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-activate-service-unit | `activate` 阶段发布 `unit_config` 生成的 systemd unit。 | 仅影响 App `activate` 执行路径；不改 stage 或独立 restart。 | 复用现有 managed config 事务，不新增独立发布通道。 | 执行级测试确认 unit 候选进入发布批次且 service 收敛被执行。 | 不手工修改远端 unit。 |
| P-002 | CHG-activate-service-unit | `activate` 的 systemd 收敛遵循 `daemon_reload`、`enabled` 和 `on_deploy`。 | 收敛仍由 `service_management.ts` 现有逻辑拥有。 | 无额外状态机。 | 测试确认 daemon-reload/enable/restart 序列和 service 结果可见。 | 不重写失败恢复。 |

## Success Criteria

- Concrete user-visible or system-visible result:
  `jx-server` 首次 versioned deploy 时，`activate` 会发布
  `/etc/systemd/system/jx-server.service`，后续独立 restart 能读到
  `enabled=true` 并成功重启。
- Required evidence: 新增执行级回归测试通过；现有相关 unit/dv 测试与类型检查通过。
- Explicit non-goals: 本任务不执行真实远端部署；真实 Multipass 验证可在部署时进行。

## Risks

- 如果 `activate` 早于其他 App 的配置发布完成，unit 会先被发布和启动；现有依赖
  顺序仍然约束 stage 与 activate 的关系，但后续独立 restart 只覆盖 jx-server。
- 对已有机器重复部署会尝试启用并重启受管服务；这是 `on_deploy: restart` 的既有语义。
- 发布失败仍会走现有配置恢复和 systemd 补偿路径，不引入新的部分状态处理。
