# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/093-deploy-no-activate.md
- 对象：为 `deploy`（及预览它的 `plan`）新增布尔式 CLI 选项 `--no-activate`，把"上传并部署
  （configure/stage：新版本目录落地 + 配置/unit 发布）"与"激活（activate：切换 `latest`、写
  `<app>.version`、启动/重启服务）"解耦。缺省行为完全不变；传入该选项时计划只含 configure/stage，
  执行后新版本目录与已发布配置保留在目标机，但 `latest`、版本标记、服务状态均保持执行前状态。
  覆盖 `src/**`、`tests/**`、`README.md`、`docs/modules/sfo-deploy.md`。

## Delivery Summary

- Outcome: `PlanRequest.activate?: boolean`、`RunOptions.init.activate?: boolean`（缺省 `true`，
  布尔校验并为非 deploy/plan 动作抛 `ConfigurationError`）；`buildPlan` 在 deploy 动作按
  `activate === false` 收紧内置 versioned App 的动作序列为 `[configure?, stage]`（含移除
  script-manager 的尾部 restart）；`createCli` 解析 `--no-activate`（拒绝内联值），更新
  deploy 动作帮助文本、deploy/plan 选项列表与 `confirmExecutionPlan` 的阶段提示；执行器把计划内
  无后续 activate 步骤的 stage 识别为 terminal stage：成功 stage 后直接提交（跳过 recovery 回滚、
  保留新版本目录与已发布配置、不做 systemd 的 daemon-reload/enable/重启准备），含 activate 的
  计划行为（含取消/失败恢复语义）完全不变。
- Handoff: 复现命令为 `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  （`ok | 353 passed | 0 failed`）。独立缺陷审查动态验证了 dv/093：stage-only 执行后无 switch/
  marker/systemctl 事件，`latest` 与 `.demo.version` 不变，`v2` 目录与配置保留。

## Proposal Consistency

| change_id | requirement_or_boundary | proposal_source | delivery_evidence | finding | status |
| --- | --- | --- | --- | --- | --- |
| CHG-deploy-no-activate | P-001：`PlanRequest.activate`，deploy 计划在 `false` 时只保留 configure/stage（service 与 script manager 均不含 activate/restart） | proposal.md:P-001 | `src/planning.ts` actionSequence 收紧；`tests/unit/config_planning.test.ts`（service 仅 `["stage"]`）、`tests/unit/app_management_config.test.ts`（script manager 无 restart；带 configScript 保留 `["configure","stage"]`） | 未发现偏差 | pass |
| CHG-deploy-no-activate | P-002：`RunOptions`/`RunOptionsInit.activate` 缺省 true、布尔校验、透传 `buildRequestedPlan`、非 deploy/plan 拒绝 | proposal.md:P-002 | `src/integration.ts` 增加字段、校验与透传；`tests/unit/deploy_confirm.test.ts` 断言 `activate:false` 非 deploy/plan 抛 ConfigurationError | 未发现偏差 | pass |
| CHG-deploy-no-activate | P-003：CLI `--no-activate` 解析（拒绝内联值）、deploy/plan 帮助、确认提示说明本次不切换不重启 | proposal.md:P-003 | `src/cli.ts` parse/help/options/confirm 全覆盖；`tests/unit/deploy_confirm.test.ts` 断言内联值退出码 2 与提示含 "activation is skipped" | 未发现偏差 | pass |
| CHG-deploy-no-activate | P-004：stage-only 执行不切换 `latest`、不改标记、不重启服务；版本目录保留；缺省行为不变 | proposal.md:P-004 | `src/execution.ts` terminal stage 提交语义；`tests/dv/versioned_deploy_order.test.ts` dv/093 断言 readLink(latest)=="v1"、marker "v1\n"、无 start/restart、v2/VERSION=="v2\n"、配置已发布且保留 | 首次发现要求冲突（见 F-002）后修复并验证 | pass |

## Independent Defect Discovery

| category | evidence_inspected | adversarial_check | finding_or_not_applicable_reason | status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `src/planning.ts`、`src/integration.ts`、`src/cli.ts`、`src/execution.ts`、规划/CLI/执行器测试、353 项测试 | 计划级穷举：service/script manager、带 configScript、非 versioned、无配置；`--no-activate` 与其它动作 / 内联值组合；执行器动态验证 stage-only 无 switch/marker/systemctl 事件、`latest`/标记/配置终态 | 首次审查发现阻塞性缺陷 F-002：naïve 的"仅删 activate 步骤"会让执行器在结束前按未提交部署执行 recovery——恢复刚发布的配置并无谓重启服务，直接违背"只部署不重启不切 latest"；修复（terminal stage 提交语义）后用 dv/093 动态验证 `latest`/标记/服务均不变、配置保留。另发现并修复 manager/action 范围校验缺失（F-001）与 stage 阶段 systemd 准备仍触碰服务（F-003） | pass |
| boundaries-and-failure-paths | 帮助文本、错误消息、确认提示、RunOptions 动作范围、非 versioned/packageless/环境动作、取消与失败恢复路径 | 尝试让 `--no-activate` 影响非 deploy/plan（抛 `ConfigurationError`）；内联值拒绝；含 activate 计划的中止/失败恢复语义（dv/069 取消与故障注入 8 项）回归不变；packageless/non-versioned 计划不受影响 | 未发现边界缺陷：特判仅影响 deploy/plan 的 versioned App；dv/069 取消/故障恢复全部保持通过，证明 terminal 判断不做坏非 stage-only 计划的恢复语义 | pass |
| regression-and-side-effects | 全量测试 353 项、变更路径清单、`deno task check/lint/fmt/test`、既有 dv/069/dv/082/dv/083 断言 | 全量回归；对无 `--no-activate` 的既有计划逐一确认行为零差异（activate 步骤存在 → terminal=false）；README/模块文档与 CLIs 的包文档清单核对 | 未发现回归：唯一共享行为变更是 terminal stage 判断（仅当计划无 activate 时生效）；审查中还修复了测试自身两处 minor（F-004）并隔离了一次误格式化（F-005） | pass |

## Verification

- Targeted check: `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  （`ok | 353 passed | 0 failed`）
- Result: pass
- Exception reason: not-applicable

## Findings

| id | severity | evidence | problem | blocking |
| --- | --- | --- | --- | --- |
| F-001 | major | src/integration.ts RunOptions 构造；初版仅透传 activate，未限制动作 | `--no-activate` 可被传入非 deploy/plan 动作并被静默忽略；补做动作范围校验（`--no-activate applies only to deploy and plan`）与布尔校验，并新增测试 | no |
| F-002 | blocking | src/execution.ts 执行器 finally 的未提交部署 recovery（原 725 行区域） | 直接删掉 activate 步骤的 stage-only 计划在执行结束会触发 recovery：恢复刚发布的配置并对活跃服务执行强制重启，违背"只部署、不改 latest、不重启"目标；以 terminal stage 提交语义修复（成功 stage 即 committed、跳过 systemd 准备与 recovery），dv/093 动态验证终态 | no |
| F-003 | major | src/execution.ts stage 步骤的 systemd 准备段（inspectSystemd/prepareSystemd） | stage 阶段对 terminal 部署仍会做 daemon-reload/enable 等系统级触碰；对 terminal stage 跳过 systemd 全部准备，服务零触碰 | no |
| F-004 | minor | tests/unit/deploy_confirm.test.ts（本次新增） | 断言内联值消息用词与实际实现不符（"does not take a value" vs "does not accept a value"），且 `assertRejects` 误用于同步构造器；修正断言并改用 `assertThrows` | no |
| F-005 | minor | 工具链操作 | 用裸 `deno fmt`（未加 task 限定路径）误格式化仓库内 markdown 文档 269 个非本次变更文件；已全部 git checkout 还原，改用 `deno task fmt` 仅检查 src/tests/示例 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 核心需求（`--no-activate` 只上传并部署，不切 latest、不写标记、不重启）已实现并经
  dv/093 动态验证；阻塞性缺陷 F-002（recovery 误回滚/误重启）以 terminal stage 提交语义修复，
  F-001/F-003 已在实现中补齐，F-004/F-005 为测试与工具链修正。缺省行为与含 activate 计划的
  取消/失败恢复语义（dv/069 全项）保持不变；全量测试 353 项通过，`deno task check`/`lint`/`fmt`
  全绿。文档化残留边界：未激活部署的 rollback 只重放 stage；keep_versions 清理仅发生在成功激活后；
  "只激活已落地版本"的命令留作独立后续任务。