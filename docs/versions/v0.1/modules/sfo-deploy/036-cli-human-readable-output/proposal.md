---
task_manifest: task.yaml
status: approved
---

# CLI 改为按步骤输出人类可读信息提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本需求改变 CLI 的默认输出契约：当前 README 明确“输出为
  JSON”，现有 `fetch`、`install-deno` 集成测试直接解析 stdout JSON。 默认从 JSON
  改为人可读的分步文本是公开 CLI/输出契约变更，并需要在执行路径中注入
  步骤事件以支持“执行过程中逐步输出”，属于 runtime-integration 变更；此外需同时
  维护兼容开关、帮助与文档，因此默认按 high-risk 提案，进入 proposal → design → implementation →
  testing → acceptance 完整流程。用户确认时可选择替换为 standard/trivial，并记录残余风险。
- Proposal and tier confirmation: 用户已回复“确认，自动完成”，确认本提案（三个待确认
  问题均按推荐项：保留 `--json` 兼容开关、每步完成后打印一行、全部动作默认输出人可读 文本）与
  high-risk 层级，并授权从提案批准后自动完成全部后续 lifecycle 阶段；方向为
  默认输出人可读的分步进度并按 `--json` 保留稳定 JSON 契约。

## Background and Goal

用户运行 `sfo-deploy prepare --cluster multipass --config-root ... --env jre` 时，
命令只在结束时输出一整个 JSON 对象，包含 targets/steps 等套嵌结构，人眼难以跟踪
“现在执行到哪一步、结果如何”。

目标：命令默认在执行过程中按步骤输出人类可读的中文进度信息（每行一个步骤的结果、
必要时给出开始提示），结束时给出简洁汇总；机器可解析的 JSON 输出通过 `--json` 保留，作为兼容契约。

## Scope

### In scope

- CLI 默认输出：对
  `validate/plan/check/install/configure/prepare/deploy/fetch/
  start/stop/restart/history/rollback/install-deno`
  全部动作，默认输出人类可读的 分步进度与汇总，不再默认输出 JSON。
- 步骤事件：在执行路径（DeploymentExecutor、install-deno 逐机执行、fetch 逐包下载
  等）加入可选的事件回调；CLI 把事件渲染为带颜色/符号与状态说明的中文行 （如
  `[eleph-server] jre check ... 通过`、`install ... 跳过（已是最新）`）。
- `--json` 兼容开关：新增全局选项，指定后保持现有 `serializeResult` 的稳定 JSON
  结构与排序不变；错误信息同样按是否 `--json` 输出 JSON 或可读文本。
- 文档与帮助：更新 README 的输出说明、CLI 帮助文本与动作帮助；同步更新解析 stdout JSON
  的既有测试（改为加 `--json`）。

### Out of scope

- 不改变任何动作语义、步骤顺序、远程行为、退出码（0/2/3/4/130）或秘密脱敏规则。
- 不改变 `--json` 模式下 `serializeResult` 的字段、字段名或输出排序。
- 不新增机器可读日志格式（NDJSON/事件流）以外的其他格式选项；事件回调不成为公开 的稳定文件格式。
- 不修改计划、历史快照、发布记录等持久化数据结构。

### Boundary with neighboring modules

- 结果模块：`StepResult/TargetResult/DeploymentResult` 等结构保持稳定，事件回调只
  按步骤完成时转发现有结果对象，不复制或改写。
- 执行模块：`DeploymentExecutor` 增加可选监听参数，缺省行为与现有公共 API 兼容。
- 配置/历史模块：`history/rollback` 的输出同样转为人可读汇总；历史 JSON 文件与 CLI `--json`
  输出是两回事，前者不改。

## Requirement Review

需求合理：CLI 是给人用的命令，默认全 JSON 输出对终端用户不友好；同时保留 `--json`
既满足脚本消费方，又避免行为断裂。代价是本次默认值变化本身仍属公开契约变更，因此 按 high-risk
提案并由文档和 `--json` 兼容路径共同对冲。

替代方案：

1. 默认人可读分步输出 + `--json` 保留契约（推荐，本次范围）。
2. 仅检测非 TTY 时输出 JSON：隐式行为，不可预测，不如显式 `--json`。
3. 只在命令结束时可读化，不流式输出：不满足“执行过程中按步骤输出”的诉求。
4. 完全去掉 JSON：会破坏现有脚本与测试契约，不采用。

## Proposal Items

| proposal_id | change_id                 | requirement                                                    | boundary                                                | tradeoff                            | success_evidence                                                  | non_goal                                          |
| ----------- | ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| PI-1        | CHG-cli-step-human-output | 所有动作默认输出中文人可读的分步进度与汇总，执行过程中逐步打印 | 只改 CLI 渲染与事件转发；步骤语义、顺序、退出码不变     | 默认输出面向人，脚本需显式 `--json` | unit/dv/integration 覆盖 prepare 分步输出与跳过原因；全量测试通过 | 不做开始/完成双行粒度之外的进度美化；不改执行语义 |
| PI-2        | CHG-cli-json-flag         | 新增 `--json`，输出与现状一致的稳定 JSON；错误也按模式区分     | 仅影响 CLI 输出层；`serializeResult` 与原 JSON 结构不变 | 兼容成本是一个显式参数              | 既有 fetch/install-deno JSON 解析测试在 `--json` 下原样通过       | 不新增其它输出格式                                |
| PI-3        | CHG-cli-output-docs       | README、帮助文本与动作帮助说明默认人可读输出与 `--json` 用法   | 只更新文档与帮助文案                                    | 文档与行为同步                      | 帮助文本与 README 一致覆盖两种模式                                | 不改历史记录/发布快照的持久化 JSON                |

## Success Criteria

- Concrete user-visible result: 在 `examples/eleph-server-multipass` 上重复用户命令 （不带
  `--json`）时，终端按步骤打印 `eleph-server/jre check ... 通过`、
  `install ... 跳过（已是最新）`、`configure ... 跳过（已是最新）` 等可读行，结尾
  汇总集群/动作/状态；退出码仍为 0。
- Required evidence: unit/dv/integration 覆盖默认人可读输出、`--json` 稳定 JSON 与
  错误模式、跳过原因与退出码保持不变；帮助/README 同步；全量测试、check/lint/fmt 通过；high-risk
  生命周期完成。
- Explicit non-goals: 不默认保留 JSON、不改动作语义、不改退出码、不改持久化格式。

## Risks

- 公开 CLI 契约：默认输出从 JSON 变为文本，既有未经 `--json` 的脚本解析者会受影响； 以显式 `--json`
  与迁移说明对冲，README 明确记录。
- 执行路径侵入：新增步骤事件监听必须保持异步、可取消与失败路径不丢事件；设计阶段
  固化事件点在步骤结果产生处，避免改造步骤状态机。
- 测试回归：所有依赖 stdout JSON 的测试切到 `--json`，同时新增人可读断言的覆盖，
  防止两类模式互相污染 stdout/stderr。
