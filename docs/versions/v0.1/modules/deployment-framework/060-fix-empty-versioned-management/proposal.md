task_manifest: task.yaml
status: approved

## Workflow Tier Judgment

- Proposed tier: standard
- Final user-confirmed tier: standard
- Final tier: standard
- Rationale: 该请求修复 versioned 部署的持久化快照兼容行为。虽然代码改动很小，但发布快照/回滚属于运行时持久化契约，无法按 trivial 边界处理；没有证据表明需要 high-risk 的完整设计、测试与验收生命周期。
- Confirmation statement: 用户已回复“确认”，批准显示的 proposal 和 standard 层级；无未解决问题。

## Background and Goal

用户执行 multipass 集群部署时，内置 versioned App 已通过确认并开始处理七个步骤，但随后报错 `management 声明不能为空`。只读排查显示：

- schema v4 app.yaml 允许 `deployment.kind: versioned` 的 App 声明 `management.actions: []`，用来只提供 `run_as`；示例中的 `jx-web` 正属于这一类。
- 计划生成会为 activate 步骤保留 management，但 stage 步骤不保留。
- `src/history.ts` 编码该 activate 步骤时会把空 management 写入发布快照；解码器随后发现 configs、service、hooks 均为空并抛出该错误。

目标是让空但合法的 versioned management 声明能够被发布快照编码、解码并执行，而不是让用户绕过为 `run_as` 设置的空声明。

## Scope

- In-scope: 修复 `src/history.ts` 对 schema v4 持久化 management 的空声明判定，使 versioned App 的 `management: { run_as, actions: [] }` 快照可解码；补充覆盖该缺陷的单元测试。
- Out-of-scope: 不修改 cluster 配置生成器、multipass 示例、计划生成顺序、远端执行语义或 systemd 行为。
- Neighboring boundary: 非 versioned schema v4 app 仍不允许空 actions；legacy v2/v3 management 空声明校验保持不变；旧快照契约中 configs/service/hooks 的字段校验不变。

## Requirement Review

请求合理：这是同一版本内计划装载规则与快照解码规则不一致导致的阻塞缺陷。关键权衡在于是否只把激活步骤的空 management 省略。选择修复解码器并保持 planning 保留 run_as，可继续满足 versioned 部署需要 run_as 的既定契约，也避免引入第三种步骤形态。

## Proposal Items

| proposal_id | change_id                     | requirement                                                                                               | success_evidence                                                                                                        |
| ----------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P-1         | CHG-empty-versioned-management | versioned App 允许持久化并解码空的 v4 management 声明，该声明仍携带 run_as，且必须通过现有相关校验。      | versioned activate 快照回归测试显示空 management 可编码/解码；非 versioned 空声明仍触发 `management 声明不能为空`。      |

## Success Criteria

- 对 `management.actions: []` 的 versioned App 构建计划、归档计划并解码快照时不再出现 `management 声明不能为空`。
- 非 versioned App 或缺少 `run_as` 的无效组合仍被拒绝。
- 新增或调整的仓库原生单元测试通过；必要时运行相关 history/config 测试确认无回归。

## Risks

- 持久化契约风险：放宽条件可能让无效空快照通过。缓解方案是只允许 schema v4 且步骤声明 versioned deployment 的场景，同时保留 run_as 和 managed 步骤校验。
- 回滚风险：现有已写入的空 management 快照会依赖新解码行为。这属于修复兼容性，旧版本无法解码该快照的问题本身即为本缺陷。
