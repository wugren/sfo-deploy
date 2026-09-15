# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/094-plan-detailed-output.md
- 对象：把 `sfo-deploy plan` 的人可读结果渲染（`src/cli.ts` 的 `writeHumanResult` 的
  `ExecutionPlan` 分支）从"摘要行 + 每步一行简写"扩展为多行详细预览：每个步骤输出序号/总数、
  目标机名与解析后的 address/address_kind，并在字段 Present 时输出 depends_on、package_provider、
  deployment kind、脚本 relativePath 与 script_runtime、secret_values/secret_files 逻辑名称，以及
  management 的 service unit + on_deploy（或 script manager）与受管 config 的 target + format；
  可选字段缺失时不输出占用行。覆盖 `src/**`、`tests/**`、`README.md`、`docs/modules/sfo-deploy.md`。

## Delivery Summary

- Outcome: 新增 `planStepDetail` 渲染辅助函数，plan 分支逐步骤先输出
  `- [i/n] machine (address/address_kind) kind:resource action`，再缩进输出 Present 的细节行。
  公开字段约束：密钥只输出 `secretValues`/`secretFiles` 名称集合，脚本只输出
  `ScriptInvocation.relativePath`（不输出本地绝对路径 `source`），受管 service 只输出
  unit/on_deploy/enabled，config 只输出 target/format。`--json` 序列化、deploy 阶段确认提示
  （confirmExecutionPlan）、执行期进度行均未改动。
- Handoff: 复现命令为 `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  （`ok | 356 passed | 0 failed`）。实机复现 `plan --app jx-server` 与 `plan --app jx-web`
  输出详细字段；`--json` 键结构与原输出逐键一致。

## Proposal Consistency

| change_id              | requirement_or_boundary | proposal_source | delivery_evidence | finding | status |
| --- | --- | --- | --- | --- | --- |
| CHG-plan-detailed-output | P-001：plan 人可读输出为每步补充序号/总数、机器名与 address/address_kind，Present 时输出 depends_on、package_provider、deployment kind、脚本 relativePath 与 runtime、密钥逻辑名、service unit + on_deploy 与 config target + format | proposal.md:P-001 | `src/cli.ts` `planStepDetail` + plan 分支渲染；`tests/unit/cli_plan_output.test.ts` 断言完整字段行（含 `[1/2]`、地址/类型、depends_on、filehub、versioned、deno、scripts/action.ts、三密钥名、demo.service、config target/format）；实机 jx-server/jx-web 复现 | 未发现偏差 | pass |
| CHG-plan-detailed-output | P-002：缺省/Absent 可选字段的步骤渲染干净，不输出空行、不抛错、不依赖密钥解析或远端连接 | proposal.md:P-002 | `tests/unit/cli_plan_output.test.ts` 最小步骤（无包/无密钥/无管理/无依赖）断言不输出 `depends_on:/package:/deployment:/secrets:/service:/configs:` | 独立审查时用 jx-web（on_deploy=none、无 enabled、nginx 配置）核对非完整字段组合，输出仅为 Present 字段 | pass |
| CHG-plan-detailed-output | P-003：README/模块文档同步 plan 详细预览语义，`--json` 稳定契约与"只输出逻辑密钥名/私钥内容"承诺不被放宽 | proposal.md:P-003 | README CLI 输出说明与 `docs/modules/sfo-deploy.md` Long-lived Boundary 新增 plan 预览描述；`tests/unit/cli_plan_output.test.ts` JSON 契约测试断言 plan step 保留原键集合；`tests/unit/cli_human_output.test.ts` README 契约测试保持通过 | 首次发现 P-003 关联缺陷（见 F-001）后已修复并验证 | pass |

## Independent Defect Discovery

| category | evidence_inspected | adversarial_check | finding_or_not_applicable_reason | status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `src/cli.ts` `planStepDetail` 与 plan 分支、渲染依赖的 PlanStep 字段、既有 plan JSON 序列化实现 | 全字段步骤、缺省字段步骤、service on_deploy=reload/none、script manager 分支、enabled 缺省分支逐项走查；把渲染输出与 `--json` 输出交叉核对 | 渲染与 `--json` 完全同源：jx-web 的 secrets 三密钥、`on_deploy: none`、config nginx format 均直接来自计划对象，未发现自造字段或泄露 | pass |
| boundaries-and-failure-paths | 可选字段判空分支（dependsOn/package/deployment/scripts/secrets/management.manager/management.configs）、旧 plan-v2/v3 快照路径 | 构造最小步骤断言缺省字段零输出；验证渲染只消费 live plan（`buildRequestedPlan` 产物）字段，旧快照仅出现于 history/rollback 不经过该渲染；确认 `secretFiles`、`scriptRuntime` 在 PlanStep/Machine 上均为必填 | 未发现边界缺陷：全部可选分支判空；必填字段类型保证无空引用 | pass |
| regression-and-side-effects | 全量测试 356 项、`deno task check/lint/fmt`、`--json` 契约测试、README 契约测试 | 全量回归；README 原文案（"按步骤输出英文人可读的进度行""稳定 JSON 契约""--json"）逐串核对；plan `--json` 输出与原实现产物逐键比对 | 首次发现破坏既有契约测试的缺陷 F-001：README 断行把 "稳定 JSON 契约" 拆到两行导致 `assertStringIncludes` 失败；重新排版恢复单行后全绿。无其他回归 | pass |

## Verification

- Targeted check: `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  （`ok | 356 passed | 0 failed`）
- Result: pass
- Exception reason: not-applicable

## Findings

| id | severity | evidence | problem | blocking |
| --- | --- | --- | --- | --- |
| F-001 | major | README.md CLI 输出说明段落换行；`tests/unit/cli_human_output.test.ts:178` | 初版 README 编辑把 "输出保持稳定/JSON 契约" 断行，"稳定 JSON 契约" 字面串不再可匹配，破坏既有 README 契约测试；重新排版为单行后恢复 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与已确认提案 P-001/P-002/P-003 一致；独立缺陷审查覆盖行为逻辑、边界失败路径与回归副作用三类，仅发现并修复文档断行缺陷 F-001（非阻塞）；`deno task check/lint/fmt/test` 全绿（356 passed | 0 failed），`--json` 稳定契约与 README 契约测试保持通过。