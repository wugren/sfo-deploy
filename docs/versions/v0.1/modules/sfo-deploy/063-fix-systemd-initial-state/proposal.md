---
task_manifest: task.yaml
status: approved
---

# Proposal：允许首次部署时 systemd unit 尚不存在

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 修复影响 App 部署的 systemd 生命周期
  运行时行为；虽然根因明确且改动集中，但它改变服务首次发布的失败判定语义，
  不适合 trivial。无 schema、安全边界或持久化格式变更，回滚简单，建议 standard。
- Proposal and tier confirmation: 用户于 2026-09-08 确认提案并选择 standard。

## Background and Goal

真实 Multipass 首次部署中，`jx-server:activate` 已上传 stage 部署包，但在读取
`jx-server.service` 状态时失败：`systemctl is-enabled` 返回 `not-found`。远端
检查确认 `/etc/systemd/system/jx-server.service` 不存在。执行器当前在任何
managed unit 发布前调用 `inspectSystemd`；对尚不存在的受管 unit，这个前置检查
把合法的首次部署状态误判为致命错误，导致 unit 不会被发布。

目标是让首次部署能把“managed unit 不存在”识别为未启用/未运行状态，继续完成
unit 发布、`daemon-reload`、enable/start/restart 收敛；同时保持已有 unit 的状态
检查、收敛与失败补偿语义不变。

## Scope

### In scope

- 在 App `activate`/managed config 路径中，当受管 systemd unit 尚不存在时，
  以 `enabled=false`、`active=false` 作为 systemd 基线继续执行发布。
- 对 unit 不存在的部署，让后续收敛先发布 unit、再执行 `daemon-reload`，
  然后按既有规则 enable 并执行 `on_deploy` 动作。
- 保持已存在 unit 的前置状态读取、变更补偿和收敛检查不变。
- 增加执行级回归测试覆盖“unit 缺失时 activate 成功发布并收敛”。

### Out of scope / explicit non-goals

- 不修改 systemd unit 渲染格式、App schema、CLI 输出契约或 stage/activate/restart
  计划顺序。
- 不改变已有服务失败后的有界补偿状态机。
- 不手工修改远端系统状态；真实 Multipass 验证只作为修复后的部署确认，不纳入
  本地自动化 acceptance。
- 不把普通 shell/systemd 命令输出或非 `not-found` 的 privilege/systemd 故障
  当作可忽略状态。

## Requirement Review

- 请求合理：首次部署没有旧 unit 是合法状态，不应当让 activation 失败。
- 主要权衡：识别 `not-found` 需要依赖 systemd 的明确输出/退出码，而不是简单
  忽略所有检查失败。执行器应只在受管配置尚未发布且 unit 不存在时建立合成基线。
- 选定方向：保留 `inspectSystemd` 的严格故障语义；当确认唯一缺失状态是 unit
  `not-found` 时返回未启用/未运行的合成状态。unit 发布和后续状态收敛继续使用
  现有路径，避免引入第二套服务状态机。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-systemd-initial-state | 首次部署时允许受管 systemd unit `not-found`。 | 仅当 unit 明确不存在；其他命令/权限/systemd 故障仍失败。 | 为缺失 unit 合成 `enabled=false`/`active=false` 基线。 | 执行级测试证明缺失 unit 不阻断 activate。 | 不忽略未知错误。 |
| P-002 | CHG-systemd-initial-state | 缺失 unit 的 activate 完成发布并收敛。 | 复用现有 managed config 发布、daemon-reload、enable、restart 语义。 | 不新增独立发布通道。 | 测试确认 unit 候选发布且服务按 on_deploy 收敛。 | 不手工创建远端 unit。 |

## Success Criteria

- Concrete user-visible or system-visible result: 在没有 `jx-server.service` 的
  目标机上，`sfo-deploy deploy` 的 `jx-server:activate` 能成功发布 unit 并启动/
  enable 服务；`jx-web:activate` 不再因目标机 fail-fast 被跳过。
- Required evidence: 新增/更新回归测试覆盖 unit 缺失分支；相关 targeted tests
  和 `deno check` 通过。
- Explicit non-goals: 本任务不承诺真实 Multipass 端到端部署；修复后可重新执行
  用户部署确认实际结果。

## Risks

- 若把非 `not-found` 的错误误识别为缺失 unit，可能掩盖权限或 systemd 故障；
  通过只接受明确的 `not-found` 输出/退出码降低该风险。
- 服务启动可能因应用自身配置失败；这属于既有 managed service 语义，不通过本次
  状态检查修复。
