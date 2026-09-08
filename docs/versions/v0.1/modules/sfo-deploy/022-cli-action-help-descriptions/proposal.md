---
task_manifest: task.yaml
status: approved
---

# CLI 动作帮助描述提案

Risk profile: not-created（仅在高风险确认后替换为 ./risk-profile.yaml）

## Workflow Tier Judgment

- Proposed tier: trivial
- Final tier: trivial
- Tier rationale / triggered boundaries: 请求明确；只修改 `src/cli.ts` 的 `usage()`
  帮助文本展示，为每个动作补充一行中文描述，不改变动作参数、解析、执行语义、退出码或任何外部契约；可用的针对性验证是无须参数即可运行的
  `--help` 单元测试。触发规则中的 CLI
  路径仅是筛查证据，实际影响限定为帮助文本展示，不构成高风险的契约/协议变更。
- Proposal and tier confirmation: 用户已确认按 trivial 提案执行；提案与层级均获批准。

## Background and Goal

`sfo-deploy <action> --cluster NAME --help`
的帮助文本目前只在一行里列出动作名称（`动作: validate, plan, ...`），用户无法从帮助中了解每个动作的用途。目标是在帮助文本中为每个动作提供一行简短中文描述，例如说明
`validate` 校验配置、`plan` 预览部署计划、`rollback` 回退到指定发布等。

## Scope

### In scope

- 修改 `src/cli.ts` 中的 `usage()`，将动作列表改为按动作逐项带描述列出。
- 如需更强回归保障，可在 `tests/unit/transport_cli.test.ts` 增加一条帮助文本包含动作描述的断言。

### Out of scope

- 不改变 CLI 动作集合、选项、参数解析、执行逻辑、输出 JSON 格式或退出码。
- 不新增或删除动作，也不修改 README、配置指南等其它文档。

### Boundary with neighboring modules

仅影响 `sfo-deploy` 命令的 `--help` 文本；`src/mod.ts` 的公共 API、`CLI_ACTIONS`
常量及其它模块不受影响。

## Requirement Review

该要求合理且价值明确：帮助文本是用户理解命令动作的主要入口，目前仅列出名称的用法可读性不足。选定方向是在
`usage()` 中为每个动作维护“动作名 + 简短描述”，描述与现有
README/配置指南中的语义保持一致；不引入新数据结构或自动生成机制，避免过度设计。

## Proposal Items

| proposal_id | change_id                        | requirement                                         | boundary                                       | tradeoff                           | success_evidence                                           | non_goal                         |
| ----------- | -------------------------------- | --------------------------------------------------- | ---------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| P-001       | CHG-cli-action-help-descriptions | `sfo-deploy --help` 为每个 CLI 动作提供一行中文描述 | 仅作用于帮助文本；动作集合、解析与执行语义不变 | 帮助文本需要与动作语义手工保持同步 | `--help` 输出逐项显示动作与描述，现有 CLI 单元测试继续通过 | 不改变动作行为或其它帮助内容结构 |

## Success Criteria

- Concrete user-visible or system-visible result: `sfo-deploy --help`
  的帮助文本中，每个动作都能看到简短中文描述。
- Required evidence: `deno task check` 类型检查通过；`tests/unit/transport_cli.test.ts`
  中帮助相关测试通过（并可加上对动作描述出现的断言）。
- Explicit non-goals: 不改动作语义、选项说明格式、README 或配置指南。

## Risks

- 无已知安全、迁移、兼容性或发布风险。唯一残余风险是帮助描述与未来动作语义可能脱节，属于文档维护范畴，不影响行为。
