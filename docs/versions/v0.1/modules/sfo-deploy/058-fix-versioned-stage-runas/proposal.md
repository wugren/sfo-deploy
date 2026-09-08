---
task_manifest: task.yaml
status: approved
---

# 提案：修复内置 versioned stage 的 run_as 快照校验

## Workflow Tier Judgment

Proposed tier: standard

- Final tier: standard

该请求修复部署计划在保存发布快照时的运行时校验缺陷。它影响 versioned App
部署流程，但不修改执行顺序、发布历史 schema 结构、远端脚本行为或回退算法。
风险局部于计划快照编码/解码校验，使用 standard 而非 trivial；未发现跨项目、
持久数据迁移或安全边界升级条件，暂不需要 high-risk。

Proposal and tier confirmation statement: 用户已确认本提案并选择 standard tier。

## Background and Goal

内置 versioned App 的 deploy 会先生成 `stage`，再统一 `activate`。计划生成
有意让 stage 步骤只携带 package/deployment/install_directory/run_as，不携带
`management`；执行层也按 versioned deployment 步骤要求 `run_as`。但
`src/history.ts` 在 plan-v4 快照编码和旧快照解码校验中，把“没有 management
但有 run_as”一律判为非法，导致实际 Multipass deploy 在确认后失败：

`非 managed plan-v4 步骤不能声明 run_as`

目标是让 versioned stage 步骤的 run_as 通过 plan-v4 快照校验，同时继续拒绝
与 managed 无关的普通步骤声明 run_as。

## Scope

In scope:

- 调整 `src/history.ts` 中 plan-v4 快照 encode/decode 对 managed 与
  versioned deployment 步骤的 `run_as` 判定。
- 允许 `kind: app`、`action: stage`、`deployment.kind: versioned` 的步骤在
  `management` 缺失时声明规范非 root `run_as`。
- 增加针对该部署失败路径的回归测试。

Out of scope:

- 不改变 deploy 的 stage -> activate -> restart 顺序。
- 不改变 plan-v4 JSON 字段结构或旧快照文件格式。
- 不改变 rollback 推导算法、远端执行器或 App YAML 配置契约。
- 不修改本示例集群的 `app.yaml`。

Neighboring boundaries:

- activate 步骤仍必须携带 managed 声明和 `run_as`。
- 非 versioned、非 managed 步骤仍不能声明 `run_as`。
- `run_as` 仍必须是非 root Linux 用户。

## Requirement Review

用户报告的是可复现部署阻断，且现有设计和执行器都支持 stage 携带 run_as；
快照校验落后于分阶段部署契约，修复是合理且必要的。主要取舍是保持最小
校验修正，只开放有 versioned deployment 证明的 stage 步骤，避免放宽所有
非 managed 步骤的身份声明。

## Proposal Items

| proposal_id | change_id | Requirement | success_evidence |
| --- | --- | --- | --- |
| P-001 | CHG-fix-versioned-stage-runas | 内置 versioned App 的 stage 步骤可在无 `management` 时通过 plan-v4 快照编码/解码校验，且其 `run_as` 身份继续强制为规范非 root 用户。 | 历史 codec 回归测试完成 `archivePlans`/`verifySnapshot` 往返，并断言缺失/root 身份失败。 |
| P-002 | CHG-fix-versioned-stage-runas | 回归测试覆盖实际 deploy 计划快照保存/读取路径，并确认普通非 managed 步骤声明 `run_as` 仍被拒绝。 | 历史 codec 回归测试保存/读取 stage 快照，并用 configure + run_as 反例确认原错误仍抛出。 |

## Success Criteria

Visible result:

- 用户给出的 multipass 部署计划可通过 `ReleaseStore` 快照编码/读取校验。
- `jx-server:stage` 与 `jx-web:stage` 不再触发
  `非 managed plan-v4 步骤不能声明 run_as`。

Required evidence:

- 定向 unit 回归测试通过。
- 现有 history 和 app management 配置测试通过。

Explicit non-goals:

- 不验证真实 Multipass VM 内的完整部署结果；该行为仍需用户实际部署确认。

## Risks

- 若校验条件过宽，可能允许非托管步骤携带 run_as；修复只允许 App stage 且
  `deployment.kind: versioned` 的组合。
- 旧快照中若存在同类非法 run_as，仍应继续失败关闭；解码方向不静默放宽。
