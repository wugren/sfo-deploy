---
task_manifest: task.yaml
status: approved
---

# Proposal：允许 deploy 计划包含受管 restart 步骤

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 这是部署计划持久化前的语义校验缺陷修复，
  影响 deploy/release 快照校验行为，因此不只是 internal documentation；但范围有界、
  无 schema 或历史格式变更，回滚简单，适合 standard。
- Proposal and tier confirmation: 用户于 2026-09-07 确认提案并选择 standard；
  同日确认修订后的 rollback 白名单范围。

## Background and Goal

内置 versioned App 的 deploy 计划会先生成 `stage`，再统一 `activate`；如果 App
声明受管 systemd service，还会在 activate 全部完成后生成受管 `restart` 步骤。
但 `PLAN_STEP_ACTIONS.deploy.app` 白名单没有把 `restart` 加入合法步骤，导致
`archivePlans` 在确认部署后抛出“计划步骤与 requested_action 不匹配”。

目标是让 deploy 计划接受其生成器已有且文档描述的受管 `restart` 阶段，使
jx-server 这类 versioned App 可完整执行部署。

## Scope

### In scope

- 将 `restart` 加入 deploy 请求的 App 步骤白名单。
- 增加针对 phased deploy 计划快照编码/校验路径的回归验证。
- 将 `stage` 和 `activate` 加入 rollback 请求的 App 步骤白名单，使
  `deriveRollbackPlan` 从 phased deploy 计划推导出的合法回退计划可通过校验。

### Out of scope / explicit non-goals

- 不修改 deploy 执行顺序、stage/activate 依赖、失败恢复或 rollback 计划推导算法。
- 不修改计划 schema、发布历史 schema 或 CLI 行为。
- 不修改示例 App 配置、目标机连接信息或执行真实 Multipass 部署。

## Requirement Review

- 请求合理：计划生成器与持久化校验明显不一致，阻止当前示例的核心部署流程。
- 主要权衡：只放宽 deploy 白名单，不把 `restart` 加入 rollback 白名单；rollback
  计划仍然不携带 restart 步骤，避免改变回退语义。
- 选定方向：最小修正校验白名单，并让回归测试同时覆盖计划生成和快照校验。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-fix-deploy-plan-restart | deploy 计划中的 App `restart` 步骤可被持久化校验接受。 | 只调整 deploy 语义白名单；不改变执行语义。 | 白名单继续严格限制其他非法步骤。 | 针对 builtin versioned App + managed restart 的计划编码/解码校验通过；现有 deploy 计划测试通过。 | 不执行远程部署。 |
| P-002 | CHG-fix-deploy-plan-restart | rollback 计划中的 App `stage`/`activate` 步骤可被持久化校验接受。 | 只调整 rollback 语义白名单以匹配现有 deriveRollbackPlan 输出；不改变推导算法或回退行为。 | 允许 phased rollback 快照持久化，换取 phased deploy 可完成记录。 | phased deploy + managed restart 可完成 archivePlans；rollback 计划仍按 deriveRollbackPlan 现有结果回放。 | 不新增回退目标或改变回退恢复算法。 |

## Success Criteria

- 可见结果：包含 `stage -> activate -> restart` 的 versioned App deploy 计划可以通过
  `archivePlans` 进入快照校验，不再出现 requested_action 不匹配错误。
- 必要证据：定向 Deno 回归测试通过，至少覆盖 deploy 白名单接受 restart 且拒绝非法步骤。
- 显式非目标：不做真实 VM 部署、不变更 rollback 计划、不修改部署失败恢复。

## Risks

- 校验放宽风险：如果只移除限制而不加入精确动作，可能掩盖非法计划；本次只在
  deploy 的 App 集合中新增 `restart`，其他动作仍会被拒绝。
- 兼容性风险：旧 deploy 快照本来不含 `restart`，新增允许项不影响读取兼容性。
