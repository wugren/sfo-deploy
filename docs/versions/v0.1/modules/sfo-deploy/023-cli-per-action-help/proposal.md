---
task_manifest: task.yaml
status: approved
---

# CLI 动作专属帮助提案

Risk profile: not-created（仅在高风险确认后替换为 ./risk-profile.yaml）

## Workflow Tier Judgment

- Proposed tier: trivial
- Final tier: trivial
- Tier rationale / triggered boundaries: 请求明确且局限于 `src/cli.ts`
  的帮助渲染与对应单元测试；不改变动作集合、参数解析、执行语义、JSON
  输出、退出码或任何运行路径，`--help` 仅在用户显式请求时按动作显示更具体的内容。命中
  contract-protocol 与 ui-workflow 触发器仅是筛查证据；实际影响是帮助文本可读性，不构成高风险边界。
- Proposal and tier confirmation: 用户已确认按 trivial 提案执行；提案与层级均获批准。

## Background and Goal

当前 `sfo-deploy <action> --help` 与 `sfo-deploy --help`
输出完全一致，只显示全局动作列表与全部选项，不能看出某个动作实际支持哪些参数。例如 `history`
是否接受 `--release-id`、`rollback` 是否必须提供 `--release-id`、`check` 是否允许
`--app`，都需要翻文档。目标是在帮助中为每个动作显示“该动作自己的用法行与参数”，让 `--help`
按传入的动作给出可直接照抄的命令提示。

## Scope

### In scope

- `sfo-deploy <action> --help` 显示该动作的用法行与参数列表；`--help` 放在动作前后均可识别。
- 每个动作按实际语义列出可用参数，至少覆盖：
  - `validate`：无选择器参数（只显示通用 `--cluster`/`--config-root`）；
  - `plan`：`--machine`、`--app`、`--environment`、`--executor-region`、`--address-kind`、`--with-dependencies`（预览
    `deploy`）；
  - `check` / `install`：`--machine`、`--environment`、`--executor-region`、`--address-kind`，其中
    `install` 额外显示 `--yes`，并明确“不支持 `--app`”；
  - `configure`、`deploy`、`start`、`stop`、`restart`：`--machine`、`--app`、`--environment`、`--executor-region`、`--address-kind`、`--with-dependencies`；
  - `history`：`--release-id` 可选，并注明不能与选择器/过滤器混用；
  - `rollback`：`--release-id` 必填，并注明不能与选择器/过滤器混用。
- `sfo-deploy --help` 保留全局概览，并增加“`sfo-deploy <action> --help` 查看该动作参数”的提示。
- 在 `tests/unit/transport_cli.test.ts` 增加帮助相关断言，覆盖动作参数展示。

### Out of scope

- 不新增、删除或重命名任何 CLI 动作或选项。
- 不改变非 `--help` 调用的参数校验、规划、执行、JSON 输出或退出码；`--release-id`
  的必填/禁止规则仍由 `RunOptions` 现有逻辑决定。
- 不修改 README 或配置指南正文（若实现时帮助文本与此前文档用词一致，则无需同步）。

### Boundary with neighboring modules

改动集中在 `src/cli.ts` 的 `usage()`/新动作帮助函数，以及 `/src/mod.ts` 之外无公共 API
变化；`CLI_ACTIONS`、`RunOptions`、规划与执行模块均保持不变。

## Requirement Review

该要求合理：帮助的首要职责是让用户在命令行直接理解“这个动作能做什么、能带什么参数”。选定方向是“动作名 +
参数白名单 + 特别限制”，数据来源为现有 `RunOptions` 校验与规划筛选逻辑，不引入动态 schema
生成；参数映射表集中维护，避免各帮助页与行为脱节。

## Proposal Items

| proposal_id | change_id               | requirement                                              | boundary                           | tradeoff                                                       | success_evidence                                                                                                                             | non_goal                 |
| ----------- | ----------------------- | -------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| P-001       | CHG-cli-per-action-help | 帮助中为每个动作显示各自的用法行、适用参数列表与限制说明 | 仅影响帮助渲染；解析与执行语义不变 | 每个动作需手工维护参数映射，但与 `RunOptions` 实际约束保持一致 | `history --help` 显示可选 `--release-id`；`rollback --help` 显示必填 `--release-id`；`check --help` 不显示 `--app`；全局 `--help` 提示子帮助 | 不改变动作行为或新增参数 |

## Success Criteria

- Concrete user-visible or system-visible result: `sfo-deploy <action> --help`
  能按动作显示各自支持的参数与限制说明；`sfo-deploy --help` 仍为全局概览并提示查看动作帮助。
- Required evidence:
  `deno task check`、`deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/transport_cli.test.ts`、`deno fmt --check`
  通过；实际运行至少 `validate`、`check`、`deploy`、`history`、`rollback` 五个动作的帮助核对输出。
- Explicit non-goals: 不改变非帮助路径的任何行为，不增加新参数，不重写选项解析。

## Risks

- 映射表若与实际 `RunOptions` 约束不一致会产生误导。缓解：映射直接对照 `RunOptions`
  校验、`buildPlan` 筛选与现有 README 说明编写，并加入 `history`/`rollback`/`check` 的定向断言。
