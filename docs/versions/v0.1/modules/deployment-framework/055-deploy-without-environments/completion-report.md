# Completion Report：deploy 只处理 App

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/055-deploy-without-environments.md

## Delivery Summary

- Outcome: `deploy`/`plan` 现在只生成并执行 App 步骤；不再创建 environment 的 `check`、`install` 或
  `configure` 节点。CLI 在配置校验期拒绝 deploy/plan 的 `--environment` 和
  `--with-dependencies`，README 与集群配置指南已明确环境准备使用 `prepare`。
- Handoff: 已实现并通过完整测试、静态检查、格式检查、契约探针和 multipass plan
  探针；可以合并或按项目流程继续评审。

## Proposal Consistency

| change_id            | requirement_or_boundary                                     | proposal_source                  | delivery_evidence                                                                                                                                                                                                            | finding    | status |
| -------------------- | ----------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| CHG-deploy-apps-only | `deploy` 只规划并执行 App 步骤，不包含环境步骤              | proposal.md Proposal Items P-001 | `src/planning.ts` 在 deploy 时跳过 environment 节点并移除环境依赖；`tests/unit/config_planning.test.ts` 和 `tests/integration/environment_placement.test.ts` 验证 deploy 计划只含 App；multipass plan 探针输出 4 个 App 步骤 | 无阻塞发现 | pass   |
| CHG-deploy-apps-only | deploy/plan 拒绝环境过滤器和依赖展开开关，且不建立 SSH 连接 | proposal.md Proposal Items P-002 | `src/integration.ts` 在 `RunOptions` 校验期抛出配置错误；`tests/unit/deploy_confirm.test.ts` 覆盖 `--environment` 与 `--with-dependencies` 返回码 2                                                                          | 无阻塞发现 | pass   |
| CHG-deploy-apps-only | 文档说明 deploy 只负责 App，环境准备使用 prepare            | proposal.md Proposal Items P-003 | README 和集群配置指南更新 prepare/deploy 分工、CLI 帮助更新 deploy/plan 选项；CLI 输出文档契约与环境放置文档/闭包契约通过                                                                                                    | 无阻塞发现 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                                              | adversarial_check                                                                                                                                                           | finding_or_not_applicable_reason                                                    | status |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | 审查 `src/planning.ts` 的节点收集、依赖过滤、拓扑排序和 App 动作展开；对比 `src/integration.ts` 的 deploy/plan 校验             | 直接构造带 `depends_on: [jre, mysql, redis]` 的 multipass 集群执行 `plan`，确认只剩 jx-server/jx-web/nginx 的 App 步骤；确认没有把依赖过滤误变成未知节点异常                | 未发现 deploy 仍生成环境步骤或依赖环境阻断 App 的行为                               | pass   |
| boundaries-and-failure-paths | 审查 RunOptions 中 deploy/plan 的环境与依赖开关校验、plan 参数解析和 CLI 错误输出路径                                           | 对 `--environment` 和 `--with-dependencies` 分别执行拒绝探针；确认两者都在连接远端前返回退出码 2，`runAction` 未被调用                                                      | 未发现校验绕过、意外 SSH 连接或错误类别不稳定的边界缺陷                             | pass   |
| regression-and-side-effects  | 运行 239 个单元/集成/DV 测试、类型检查、lint、格式检查、CLI 文档契约和环境放置文档/闭包契约；审查历史 rollback 派生与旧快照路径 | 确认 prepare/check/install/configure/start/stop/restart 测试仍通过，旧历史快照读写与 rollback 测试通过；确认新 deploy 快照 rollback 只包含 App 步骤，而旧快照仍按原内容回放 | 未发现其他动作、旧发布历史或 rollback 编解码的回归；非阻塞兼容性影响记录在 Findings | pass   |

## Verification

- Targeted check: `deno task test`（239 通过、0
  失败）、`deno task check`、`deno task lint`、`deno task fmt`、`deno run --allow-read tests/contract/verify_cli_output_docs.ts`、`deno run --allow-read --allow-run=deno tests/contract/verify_environment_placement_config.ts docs`、`deno run --allow-read --allow-run=deno tests/contract/verify_environment_placement_config.ts closure`、multipass
  `plan` 探针和 deploy `--environment` 拒绝探针
- Result: pass
- Exception reason: none

## Findings

| id    | severity | evidence                                                                                          | problem                                                                                                        | blocking |
| ----- | -------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| F-001 | low      | `docs/changes/055-deploy-without-environments.md` Risk Screen 与 README/指南中的 prepare 前置说明 | 依赖 `deploy` 自动安装环境的现有脚本会收到配置错误；忘记先 prepare 时，依赖环境缺失可能推迟到 App 远端执行失败 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与 approved proposal
  的三条边界一致，缺陷排查未发现阻塞缺陷；非阻塞兼容性影响已写入变更记录、完成报告和文档，用户可按“先
  prepare 后 deploy”迁移。
