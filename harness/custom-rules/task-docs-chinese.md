# 中文文档规则

## 目标
- 保证所有 Harness 任务流程生成或维护的任务相关文档统一使用中文撰写，便于团队阅读、评审和归档。
- 本条规则是项目自定义规则，按 `AGENTS.md` 的规则优先级高于生成的 Harness 规则和机械检查器。

## 适用范围
- 适用于所有工作流层级：`trivial`、`standard`、`high-risk`。
- 适用于所有阶段：`proposal`、`design`、`implementation`、`testing`、`acceptance`、`general`。
- 适用于所有模式：`manual`、`auto-pipeline`。

## 规则内容
- 任务流程生成或维护的任务相关文档正文必须使用中文，至少包括：
  - 提案文档 `proposal.md`；
  - 设计文档 `design.md` 以及 `pipeline/plan.md` 中由人工撰写或评审的说明性内容；
  - 测试设计文档 `testing.md` 与测试计划 `testplan.yaml` 中的说明性字段；
  - 验收报告 `acceptance-report.md`；
  - 完成报告 `completion-report.md`；
  - `docs/changes/` 下的变更记录；
  - `task.yaml` 及任务本地文档中的说明性文字、注释和评审结论；
  - 任务索引、生命周期记录、变更清单等由 Harness 流程生成并供人阅读的说明性内容。
- 机器可读字段、标识符、路径、命令、代码、`change_id`、`task_name` slug 等技术性内容保持其原有格式，不强制或禁止使用中文。
- 文档结构、目录位置和文件名保持 Harness 现有约定。本条规则不改变目录、命名或 schema 要求。

## 验收
- 任何任务交付前，检查其生成的任务相关文档正文是否使用中文。
- 存在非技术性英文正文时，除非属于固定术语、代码、命令或不可避免的标识符，否则应改为中文后再交付。