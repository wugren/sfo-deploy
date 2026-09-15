---
task_manifest: task.yaml
status: approved
---

# sfo-deploy plan 人可读输出补充更详细的步骤信息

Risk profile: not-created（待定 tier；若用户改选 high-risk 再补充）

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries：本次变更只改 `sfo-deploy plan`
  动作的人可读（非 `--json`）结果渲染（`src/cli.ts` 的 `writeHumanResult`），为每个步骤补充
  已解析的目标机地址与地址类型、依赖步骤、包提供方、发布方式、脚本相对路径与运行时、声明密钥的
  逻辑名称、以及受管 service/配置信息。`--json` 稳定契约、远端执行行为、部署/回滚、发布记录、
  密钥值、安全边界均不变；不连接远端、不下载包、不解析密钥值与现行为一致。属于单模块、有界、
  仅影响展示层的向后兼容变更，建议 standard。触发边界：人可读文本是 CLI 使用体验与既有 README
  "按步骤输出英文人可读的进度行" 契约的一部分，需要同步 README 文档描述并补充对应渲染测试；
  但该输出不是机器契约（机器契约由 `--json` 承担，键结构不变）。
- Proposal and tier confirmation：用户回复"确认"，批准本提案与 standard 层级并授权整个任务执行。
  提案中列出的未决问题按默认语义处理：plan 人可读渲染的详细字段集合固定为本提案 Proposal Items
  所列字段；`deploy` 执行确认提示（confirmExecutionPlan 的一行摘要）不在本次范围。

## Background and Goal

当前 `sfo-deploy plan --cluster <cluster> --app <app>` 的人可读输出只有一行摘要和每步一行简写：

```
Plan: cluster multipass | action deploy | 2 steps
- [eleph-server] app:jx-server stage
- [eleph-server] app:jx-server activate
```

用户希望 `plan` 预览给出更详细的信息，便于在真正连接远端执行前核对目标机器、地址、依赖、包、
脚本、密钥与受管配置等关键计划内容。`--json` 序列化已包含这些数据
（`src/cli.ts` `serializeResult` 的 plan 分支），但人可读渲染只展示了最小字段。

目标：`plan` 的人可读输出为每个步骤补充下列信息（Present 时展示，缺省对应项不强制输出空行）：

- 步骤序号与总数（`1/2` 等）。
- 目标机名称、解析后的 `address` 与 `address_kind`。
- `depends_on`（非空的步骤依赖集合）。
- `package_provider`（App 有安装包时）与 `deployment` 发布方式（内置 versioned 时）。
- 脚本相对路径（`relativePath`，不打印本地绝对路径 `source`，避免泄露执行器文件系统路径）与
  `script_runtime`（kind/executable）。
- 声明需要的密钥：`secret_values` 与 `secret_files` 的逻辑名称（只打印名称，永不打印值或文件内容）。
- 受管信息（`management`）：service 管理器的 unit 名与 `on_deploy` 动作；受管 config 的 target 与
  format（不放宽为打印完整 unit 或密钥引用明细，保持可读）。

## Scope

### In scope

- `src/cli.ts`：`writeHumanResult` 的 `ExecutionPlan` 分支由一行简写改为多行详细渲染
  （见 Background 的目标字段集合），保留现有一行摘要行头。
- 测试：新增/扩展 CLI 人可读输出测试，覆盖含完整可选字段的 plan、全部可选字段缺省的 plan、
  以及 `--json` 输出保持既有键结构不变。
- 文档：README 的 CLI 输出说明（"按步骤输出英文人可读的进度行"段落）补充 plan 详细预览语义；
  如 `docs/modules/sfo-deploy.md` 有对应预览说明则同步。

### Out of scope

- 不改 `--json` 键结构与任何序列化字段；序列化保持现状。
- 不改 `confirmExecutionPlan`（deploy 执行前的确认摘要）与执行期每步进度行（部署执行时的
  onProgress 渲染）。
- 不改 planning/config/environment/execution/transport 等生产行为，不连接远端、不下载包、不解析密钥。
- 不打印密钥值、文件密钥内容、私钥内容或脚本的本地绝对路径（`source`）。
- 不引入 ANSI 颜色/表格依赖，不新增加依赖。

### Boundary with neighboring modules

- 单模块工作，归属 `sfo-deploy`；不改动 `harness/**`、`examples/**`、`skills/**`。
- 人可读输出只在 `plan` 动作结果（`RunResult` 的 `ExecutionPlan` 分支）生效；deploy 执行后的
  human 汇总（`DeploymentResult` 分支）保持不变。

## Requirement Review

- 需求合理性：合理。`plan` 是发布前置预览，更详细信息（目标地址、依赖、包、脚本、密钥名、受管
  服务/配置）能显著提升人工核对效率；数据已在内存计划对象与 `--json` 输出中存在，改动只涉及
  展示层渲染，风险低。
- 风险/取舍：
  - 密钥只打印逻辑名称：延续 README "计划只包含敏感输入的逻辑名称，不包含配置密钥值或文件私钥
    内容" 的既有契约；渲染必须复用 `step.secretValues`/`step.secretFiles` 名称集合，不触碰值。
  - 脚本只打印 `relativePath`：`ScriptInvocation.source` 是执行器本地绝对路径，打印会泄露本地
    文件系统布局；相对路径才是部署 YAML 声明与用户可核对的内容。
  - 保持单行布局：每个步骤用缩进的子行而非长串联单行，避免超长输出和换行错乱；可选字段缺失时
    不输出占用行。
- 选定方向：在 `src/cli.ts` 的 plan 人可读分支内就地扩展渲染，不新增渲染模块或配置。

## Proposal Items

| proposal_id | change_id              | requirement                                                                                                                                                                                                                                   | boundary                                                                                                                            | tradeoff                                                     | success_evidence                                                                                                    | non_goal                          |
| ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| P-001       | CHG-plan-detailed-output | `writeHumanResult` 的 plan 分支对每个步骤输出序号/总数、机器名、address 与 address_kind；非空时输出 depends_on、package_provider、deployment kind、脚本 relativePath 与 runtime、secret_values/secret_files 逻辑名称、management 的 service unit + on_deploy 与受管 config target + format。 | 仅作用于 plan 人可读渲染；`--json`、confirmExecutionPlan、执行期进度行不变。                                                          | 详细字段只含计划对象已有信息，不新增解析/装载。                | 手工复现 `plan --app jx-server`：输出含地址/地址类型、包提供方、versioned、密钥名、service unit/on_deploy 与 config target；缺省字段的简单 App 不输出空行。 | 不打印密钥值、私钥内容或脚本绝对路径。 |
| P-002       | CHG-plan-detailed-output | 缺省/Absent 可选字段的步骤渲染干净：无包、无密钥、无受管信息的 App 只显示基础行 + 存在的字段；总输出仍是稳定的人可读文本，不依赖密钥解析或远端连接。                                                                                                             | 渲染函数只消费 PlanStep 已装载字段；缺省字段路径必须覆盖，不抛错。                                                                    | 渲染逻辑需对可选字段逐一判空。                                 | 单元测试覆盖"全可选字段缺省"计划：输出无异常且只含基础行与序号/机器/地址。                                                      | 不改变计划构建逻辑。               |
| P-003       | CHG-plan-detailed-output | README（及存在的模块文档）把 plan 人可读输出描述更新为"详细步骤预览"，继续满足 `--json` 稳定契约与"只输出逻辑密钥名"的既有文档承诺。                                                                                                              | 只更新既有文档的对应文本，不放宽 `--json` 契约声明。                                                                                | 文档需忠实描述实际输出格式。                                   | `deno task check/lint/fmt/test` 全绿；README 契约测试（CLI 输出文档契约）通过。                                                   | 不改 `--json` 键结构。              |

## Success Criteria

- `sfo-deploy plan --cluster <cluster> --app <app>`（无 `--json`）在完整版 App 上输出每个步骤的
  序号/机器/地址/地址类型，以及 Present 的依赖、包、发布方式、脚本路径、密钥逻辑名与受管服务/配置
  信息；缺失字段不产生空行。
- `--json` 输出与既有键结构逐字节一致（本项目内的输出契约测试保持通过）。
- plan 仍不建立 SSH 连接、不下载包、不解析密钥值（行为不变）。
- 密钥只以逻辑名称出现，脚本只出现 relativePath（不出现绝对路径）。
- `deno task check`、`deno task lint`、`deno task fmt`、`deno task test` 全绿；
  受影响既有测试同步。
- 非目标：不改规划/执行/序列化，不改 deploy 确认提示，不改执行期进度行，不改远端运行时。

## Risks

- 人可读文本属于使用体验契约：升级 CLI 或迁移工具脚本若解析人可读 plan 文本可能受格式影响。
  缓解：机器解析明确建议使用稳定 `--json`；本任务同步更新 README 描述。
- 渲染泄露风险：新字段含地址、脚本相对路径与密钥名，若后续误接入密钥值或绝对路径会泄露敏感信息。
  缓解：渲染只消费 `secretValues`/`secretFiles` 名称集合与 `ScriptInvocation.relativePath`，测试断言
  输出不包含 `source` 绝对路径占位。
- 字段集合扩张导致输出过长：缓解：可选字段缺省不输出空行，控制每步行数。