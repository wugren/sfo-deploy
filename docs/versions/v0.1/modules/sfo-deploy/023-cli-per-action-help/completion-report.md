# 轻量完成报告：CLI 动作专属帮助

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: trivial
- Change record: not-applicable
- 对象：让 `sfo-deploy <action> --help`
  按动作显示各自的用法行、适用参数与限制说明，同时保留全局概览帮助；仅修改 `src/cli.ts`
  帮助渲染与对应单元测试。

## Delivery Summary

- Outcome: `src/cli.ts` 新增 ACTION_HELP 动作帮助表与 actionUsage 函数，按 CLI_ACTIONS
  为每个动作渲染独立的用法行、参数区和限制区；全局帮助保留动作列表并新增“运行 sfo-deploy action
  --help
  查看该动作参数”提示。validate、check、install、configure、deploy、start、stop、restart、history、rollback
  均可把 --help 放在动作前后查看专属帮助。
- Handoff: 用户直接运行 `sfo-deploy history --help` 可看到可选 `--release-id`，`rollback --help`
  可看到必填 `--release-id`，`check --help` 会明确“不支持
  --app”。后续调整动作参数适用范围时，只需维护 `src/cli.ts` 的 ACTION_HELP 与既有 RunOptions
  校验保持一致。

## Proposal Consistency

| change_id               | requirement_or_boundary                        | proposal_source                          | delivery_evidence                                                                                                                                                                       | finding                  | status |
| ----------------------- | ---------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------ |
| CHG-cli-per-action-help | 按动作显示各自的用法行、适用参数列表与限制说明 | proposal.md 的 P-001 与 Scope 参数映射表 | `ACTION_HELP` 覆盖全部 11 个动作并由 `actionUsage` 渲染；实测 history/rollback/check/deploy 帮助显示对应参数与限制；新增单元测试覆盖 help 前后置顺序、必填发布 ID 与不支持 --app 的边界 | 与批准范围和成功标准一致 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                                          | adversarial_check                                                                                                                             | finding_or_not_applicable_reason                                                                                                                                                                                       | status |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | `ACTION_DESCRIPTIONS`、`ACTION_HELP`、`actionUsage`、全局 `usage` 的选项常量，以及 `RunOptions` 校验与 `buildPlan` 筛选逻辑 | 逐动作核对 ActionHelp 映射与 RunOptions 的实际约束，尝试寻找参数漏列、误列或 help 顺序与渲染不一致的用例                                      | 11 个动作均有帮助定义且参数与代码约束一致：check/install 不列 --app 并给出限制；history 列可选 --release-id；rollback 列必填 --release-id；plan/deploy/configure/start/stop/restart 列全套选择器与 --with-dependencies | pass   |
| boundaries-and-failure-paths | 帮助标志在动作前/后的解析、不带动作的全局帮助、generic 与 project-bound 两种入口、未知动作/未知选项路径                     | 分别测试 `rollback --help`、`--help rollback`、`history --help`、`--help` 与 fixed configRoot 变体，并检查 generic 变体是否输出 --config-root | 帮助前后置均正常，全局帮助保留概览，project-bound 不误显 --config-root，参数错误路径仍回退全局帮助；未知动作仍按既有错误逻辑拒绝                                                                                       | pass   |
| regression-and-side-effects  | 既有 CLI 帮助/参数/JSON 测试、`deno task check`、`deno fmt --check`、实际帮助输出与任务基线                                 | 运行 transport_cli 全部测试并逐行核对全局帮助与动作帮助输出；确认选项描述改为常量后文本一致，`serializeResult`、解析和执行逻辑未触碰          | 9 项 CLI/传输测试全部通过，JSON 输出与退出码路径未变，本任务变更清单仅含 src/cli.ts 与对应测试                                                                                                                         | pass   |

## Verification

- Targeted check:
  `deno task check`；`deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/transport_cli.test.ts`；`deno fmt --check src/cli.ts tests/unit/transport_cli.test.ts`；实际运行
  validate/check/deploy/history/rollback 五个动作帮助并人工核对输出
- Result: pass
- Exception reason: not-applicable

## Findings

| id  | severity | evidence               | problem                  | blocking |
| --- | -------- | ---------------------- | ------------------------ | -------- |
| F-0 | none     | 独立缺陷发现三类别复查 | 未发现需修正或阻塞的缺陷 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason:
  动作专属帮助已按批准范围实现：所有动作都能查看自己的用法行、参数与限制，全局帮助保留并增加子帮助提示；类型检查、格式检查、单元测试与五个动作的实际输出均通过，未发现参数映射偏差或运行路径回归。
