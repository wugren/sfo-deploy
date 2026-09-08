---
task_manifest: task.yaml
status: approved
---

# Proposal：配置秘密占位符化并移除 updater 声明

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务改变 `app.yaml`、`cluster.yaml` 公开配置契约与
  managed 配置渲染协议，删除 `management.configs[].updater`
  并改用占位符注入；同时涉及秘密类型、文件秘密路径语义、部署包/远端运行时、计划快照与服务变更判断，命中公共契约、安全/隐私、持久数据/快照兼容、部署/回滚与跨模块边界，必须按
  high-risk 全生命周期执行。
- Proposal and tier confirmation: 用户于 2026-09-06 确认「确认，自动完成」，批准本提案与 high-risk
  层级，并要求自动完成全生命周期。

## Background and Goal

当前 managed 配置要求 `management.configs[].updater` 声明 YAML/JSON/TOML/INI/template/script
更新器，并用结构化 `bindings` 声明秘密写入的 selector 和类型。这个声明面把“值放在哪里”从 App
配置移到绑定清单，表达繁琐，也使常见配置无法直接使用 `${SECRET_NAME}` 占位符。

目标是让受支持的结构化配置直接解析后替换值中的秘密占位符：`cluster.yaml.secrets`
定义秘密类型与放置机器，`management.configs[].format` 定义解析格式，App 源配置通过 `${SECRET_NAME}`
表达引用位置。`management.configs[].updater` 从公开 schema 中删除。

## Scope

### In scope

- 扩展秘密声明：`kind: value` 的 `type` 可选，缺省 `string`；支持
  `string`、`integer`、`number`、`boolean`。类型与实际秘密值不匹配时装载或部署失败。
- 固定 `kind: file` 语义：占位符替换为 `secrets-deploy`
  部署后的目标机稳定秘密文件路径；路径本身是字符串，不注入文件内容或 base64。`kind: file` 不接受
  `type`。
- 结构化配置渲染：按 `format` 解析 `yaml`、`json`、`toml` 或 `ini`，遍历值并替换
  `${SECRET_NAME}`；替换后按声明格式完整复解析。
- `${NAME}` 必须在 `cluster.yaml.secrets`
  中声明且已放置到目标机器；未声明、未放置、类型不匹配或替换后配置无效都在部署前/目标执行前失败关闭。
- 普通变量与秘密占位符的语法和校验边界在设计中明确，避免同名或嵌套歧义。
- 删除 `management.configs[].updater` 公开字段及其相关类型、装载校验、骨架绑定、计划序列化和 CLI
  展示面；用 `format` 表达解析器。
- 同步调整部署包
  manifest/绑定成员、远端固定更新器协议、执行路径、历史快照编解码、错误提示、README、配置指南、示例与测试。
- 文件秘密内容变更但稳定路径不变时，部署变更判断必须能触发该配置声明的
  `on_change`；具体机制在设计阶段确定。

### Out of scope / explicit non-goals

- 不改变 `cluster.yaml.secrets` 的声明和放置模型；秘密值仍不由 `app.yaml` 提供。
- 不提供自动迁移工具；既有含 `updater` 的 v3 配置装载失败并给出定向迁移提示。
- 不保留 `updater.type: script` 或 `updater.type: template`
  作为新契约的一部分；自定义文本格式不在本任务支持范围。
- 不改变 `management.service`、`management.hooks`、systemd 动作或非 managed App 的脚本模式。
- 不实现秘密生成、轮换调度或新的保险库集成。

## Requirement Review

- 请求合理：当前 selector 式绑定把常见配置的表达位置移到 `updater`，与“App
  配置独立”目标相悖；将秘密引用放回源配置可减少重复声明并让配置意图更直接。
- 主要权衡：引用即授权放宽了逐 App 显式秘密绑定，要求依赖 `cluster.yaml.secrets`
  的机器放置和部署前失败关闭；文件路径替换需要新的持久路径/权限和文件变更判断语义；删除 updater
  是破坏性契约变更。
- 选定方向：在受支持结构化格式中解析后替换 `${SECRET_NAME}`；`type` 缺省 `string`；`kind: file`
  固定注入部署后路径。不保留 `updater.type: script/template` 到新契约。

## Proposal Items

| proposal_id | change_id                         | requirement                                                                                                                      | boundary                                                                                 | tradeoff                                                       | success_evidence                                                                                         | non_goal                         |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| P-001       | CHG-secret-placeholder-schema     | `cluster.yaml.secrets` 的 value 秘密增加可选 `type`，缺省 `string`；file 秘密固定路径语义并禁止 `type`；装载期校验类型与实际值。 | 只改配置装载契约与公开类型；不改秘密部署协议和存储位置。                                 | 秘密声明承担类型责任，App 配置不再重复类型绑定。               | 正负例覆盖缺省字符串、显式类型、非法类型/值、file 类型字段拒收。                                         | 不自动迁移既有 cluster.yaml。    |
| P-002       | CHG-placeholder-rendering-runtime | 删除 `management.configs[].updater` 并新增 `format`；结构化源配置解析后按占位符注入秘密，目标端复解析并原子发布。                | 覆盖配置生成、部署包、远端固定渲染器和执行路径；秘密不进入部署包、argv、环境变量或日志。 | 引用即授权取代显式 selector 绑定，简化声明但依赖机器放置授权。 | YAML/JSON/TOML/INI 正负例、缺省字符串、显式类型、未知/未放置秘密、嵌入字符串、无效候选、失败回滚均通过。 | 不支持 script/template updater。 |
| P-003       | CHG-placeholder-plan-history-cli  | 计划、历史快照、CLI 展示与错误输出同步新配置形状；旧快照按设计确定兼容策略。                                                     | 只覆盖序列化/展示/回滚所需面。                                                           | 改变计划/快照形状，需要避免破坏可用回滚。                      | 新计划不含 updater；相关序列化往返、旧快照兼容或明确拒收策略有测试。                                     | 不新增迁移工具。                 |
| P-004       | CHG-placeholder-docs-tests        | 文档、示例与契约/单元/集成/DV 测试同步新语义。                                                                                   | 只修改任务相关文档、示例和测试。                                                         | 测试面较大，但公共契约和安全边界需要闭环覆盖。                 | 全量 `deno task check` 与统一入口相关测试通过；文档不再指导使用 updater。                                | 不为 updater 保留新示例。        |

## Success Criteria

- 可见结果：受支持结构化配置可直接使用 `${SECRET_NAME}`；`management.configs[].updater`
  不再是合法字段；value 秘密类型缺省字符串；file 秘密占位符解析为部署后的稳定路径。
- 必要证据：配置装载、计划生成、部署包、远端渲染、原子发布、服务变更判断、历史/回滚和错误路径有测试；`deno task check`
  与 Harness 统一测试入口通过。
- 显式非目标：不自动迁移既有配置；不保留 script/template updater；不改变秘密存储或 systemd
  管理模型。

## Risks

- 公共契约破坏：既有 `updater`、template/script 用法升级后失败，需要定向错误和迁移说明。
- 安全边界：引用即授权扩大单机 App
  可访问秘密集合；必须坚持秘密不进部署包/argv/env/日志，未声明/未放置失败关闭。
- 文件语义：稳定路径必须持久且可读；文件内容轮换时需触发服务动作，否则证书等配置不会收敛。
- 快照兼容：历史/回滚如果无法解码新形状，会阻断发布恢复；策略需设计并测试。
- 解析歧义：整值占位符与嵌入字符串、格式转义、重复键和 YAML 类型细节需要明确。
