# 轻量完成报告：CLI 动作帮助描述

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: trivial
- Change record: not-applicable
- 对象：让 `sfo-deploy <action> --cluster NAME --help` 的帮助文本为每个 CLI
  动作提供一行中文描述，仅修改 `src/cli.ts` 的 `usage()` 展示逻辑，不改变动作语义。

## Delivery Summary

- Outcome: 帮助文本现从 ACTION_DESCRIPTIONS 常量按 CLI_ACTIONS 顺序逐动作输出描述，常量使用 Record
  类型约束保证全部 11 个动作覆盖。deno run src/main.ts --help 的实际输出中，validate 至 rollback
  每个动作都有一行对齐的中文说明。
- Handoff: 用户运行 `sfo-deploy --help` 即可逐项查看动作用途；帮助文本未来与动作语义同步维护时，修改
  `src/cli.ts` 中的 `ACTION_DESCRIPTIONS` 即可，不需要改动选项解析或执行逻辑。

## Proposal Consistency

| change_id                        | requirement_or_boundary                                                                             | proposal_source               | delivery_evidence                                                                                                                                                                       | finding                  | status |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------ |
| CHG-cli-action-help-descriptions | `sfo-deploy --help` 为每个 CLI 动作提供一行中文描述，仅作用于帮助文本，动作集合、解析与执行语义不变 | proposal.md 的 P-001 与 Scope | `src/cli.ts` 新增 `ACTION_DESCRIPTIONS` 并在 `usage()` 中按 `CLI_ACTIONS` 映射输出；`deno run src/main.ts --help` 显示 11 个动作均有描述；`deno task check`、CLI 单元测试与语法检查通过 | 与批准范围和成功标准一致 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                                                            | adversarial_check                                                                                                                                 | finding_or_not_applicable_reason                                                                                               | status |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| behavior-and-logic           | `src/cli.ts` 的 `ACTION_DESCRIPTIONS` 与 `usage()`、`src/integration.ts` 的 `CLI_ACTIONS`、实际帮助输出，以及 README/配置指南中的动作语义说明 | 逐个核对 11 个动作的 Record 键与帮助行，尝试寻找遗漏动作、键名拼写错误或描述与 check/install/configure/deploy/history/rollback 实际行为不符的用例 | 所有动作均出现在帮助输出且描述与现有文档语义一致；Record 类型约束使任何漏项在编译期失败                                        | pass   |
| boundaries-and-failure-paths | 帮助的 generic 与 project-bound 两种入口、`parseArguments` 的 `--help`/缺参路径、错误回退与固定宽度对齐                                       | 分别检查 `-h`/`--help` 不带动作和集群名、参数错误时 usage 回退、`createCli` 固定 configRoot 分支及 `padEnd` 对齐对长动作名的处理                  | 帮助分支不要求 action/cluster，两类入口输出一致；错误路径仍打印新版帮助；最长动作名 configure 下描述仍对齐，不会产生空行或截断 | pass   |
| regression-and-side-effects  | 既有 CLI 单元测试、`deno task check`、`deno fmt --check`、工作区基线及 changed-path 清单                                                      | 运行 transport_cli 全部测试确认帮助、参数错误和稳定 JSON 行为不变；核查 `serializeResult`、选项解析和执行逻辑未改动，任务外文件由基线隔离         | 8 项 CLI/传输测试全部通过，JSON 输出与退出码未受影响；本任务交付仅 src/cli.ts 变化，其余工作区内容保持原状                     | pass   |

## Verification

- Targeted check:
  `deno task check`；`deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/transport_cli.test.ts`；`deno run src/main.ts --help`
  人工核对每个动作均有描述；`deno fmt --check src/cli.ts`
- Result: pass
- Exception reason: not-applicable

## Findings

| id  | severity | evidence               | problem                  | blocking |
| --- | -------- | ---------------------- | ------------------------ | -------- |
| F-0 | none     | 独立缺陷发现三类别复查 | 未发现需修正或阻塞的缺陷 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 批准的逐动作帮助描述已实现并通过类型检查、CLI
  单元测试、格式检查与实际帮助输出核对；独立反例搜索未发现漏项、语义偏差或回归，交付范围与 trivial
  提案一致。
