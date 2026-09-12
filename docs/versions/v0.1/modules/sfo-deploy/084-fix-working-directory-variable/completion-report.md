# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/084-fix-working-directory-variable.md

## Delivery Summary

- Outcome: `unit_config.working_directory` 现在与 config `target` 一致支持三个目录变量
  `${INSTALL_DIRECTORY}`、`${CURRENT_VERSION_DIRECTORY}`、`${LATEST_DIRECTORY}`（裸值或
  变量前缀 + 规范相对后缀），在 `src/config.ts` 装载期解析为绝对目录；multipass 集群既有
  `working_directory: ${LATEST_DIRECTORY}` 现在解析为 `/opt/eleph-server/latest` 并通过
  systemd unit 渲染 preflight。无变量写法（`latest`、相对、绝对）行为不变。
- Handoff: `deploy --cluster multipass --config-root ./examples/eleph-server-multipass/clusters`
  的 preflight 错误“systemd unit working_directory 包含不支持的 systemd 展开或引号字符”
  已消失；远端部署后续阶段由用户继续执行。gitignored 本地集群文件未改动，方案为让解析器
  支持既有写法。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-working-directory-directory-variables | P-001：`working_directory` 支持三个目录变量并解析为绝对目录 | proposal.md P-001 | src/config.ts systemdWorkingDirectory 解析 `${LATEST_DIRECTORY}`、`${CURRENT_VERSION_DIRECTORY}` 与 `${INSTALL_DIRECTORY}` 为绝对目录并支持变量加相对后缀；multipass 集群复跑装载得到 workingDirectory=/opt/eleph-server/latest 且 unit 渲染成功 | 交付与提案一致，旧写法语义不变 | pass |
| CHG-working-directory-directory-variables | P-002：非法写法装载期 `ConfigurationError` 明确失败 | proposal.md P-002 | 负例覆盖多变量、变量不在开头、非法后缀（`../`、`.`、尾部斜杠）、未知变量（`${UNKNOWN}`）、后缀含 `$`、缺 `install_directory`；19 个装载/渲染用例全部通过 | 边界与错误路径收紧且可读 | pass |
| CHG-working-directory-directory-variables-doc | P-003：配置指南与技能参考说明变量契约 | proposal.md P-003 | `docs/guides/sfo-deploy-cluster-configuration.md` 与 `skills/sfo-deploy-cluster/references/app.md` 相关段落补充变量语义及 current/latest 装载一致说明 | 文档与实现一致 | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `systemdWorkingDirectory` 全部分支、`remoteDirectoryPath` 调用链、`managedConfigTarget` 对照、`git diff` 与新增/既有测试 | 逐分支核对变量计数、裸值/前缀匹配、相对后缀校验、`managedTargetPath` 复用；检查与 config target 语义一致性（current/latest 均解析 latest） | 独立复核发现 `$${UNKNOWN}` 与后缀含 `$` 会静默进入计划到渲染才失败，已在实现中补上装载期拒绝并加回归用例；其余分支无遗漏 | pass |
| boundaries-and-failure-paths | `managedTargetPath` 规范绝对路径校验、`install_directory` 缺失分支、相对后缀的 `..`/`.`/空段/转义字符拒绝、渲染器 `assertUnitText` 不变 | 以 `-` 或 `$`/`%`/`"` 开头的操作数、`/` 与 `//`、尾部斜杠、多变量、缺 `install_directory`（packageless）逐一验证 | 装载期拒绝与渲染器拒绝边界一致，未放开任何安全限制 | pass |
| regression-and-side-effects | 全量 `deno task test` 325 个测试、`deno task check`、改动文件窄域 `fmt`/`lint`、集群装载 + 渲染复跑 | 检查 `latest`/相对/绝对旧写法、config target 变量、计划快照编解码、契约文档断言、multipass 实装是否受影响 | 未发现本改动引入的回归；唯一测试调整是 integration/versioned_release 对 liveApp 由 `working_directory: latest` 断言改为 `${LATEST_DIRECTORY}`（与该文件当前值一致） | pass |

## Verification

- Targeted check: `deno task check`；`deno fmt --check src/config.ts tests/unit/app_management_config.test.ts tests/integration/versioned_release.test.ts`；`deno lint`（窄域，仅既有遗留问题）；`deno test --allow-read --allow-write --allow-env --allow-net --allow-run`（全量 325 通过）；复跑集群装载 + unit 渲染脚本确认 preflight 通过
- Result: passed
- Exception reason: 仓库级 `deno task lint` 在未改动的既有脏文件行上失败（`src/config.ts:1228` 未用参数 `directory`、`tests/unit/app_management_config.test.ts:664` 未用 `label`，均为先前任务遗留）；本任务改动代码窄域检查通过

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-001 | low | `src/systemd_unit.ts#assertUnitText` | `working_directory` 之外的 command/args 仍可能携带 `$`/`%`/`"` 并只在渲染期失败；超出本任务范围（提案非目标），装载校验可按需单独跟进 | no |
| F-002 | low | `deno task lint` 输出 | 仓库级 lint 在先前任务遗留的未改动行上失败，非本任务引入 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 原始 preflight 缺陷已修复，multipass 集群既有 `${LATEST_DIRECTORY}` 配置无需改动
  即可通过装载与 unit 渲染；新增装载/渲染/负例回归先红后绿，全量 325 测试通过；交付与已确认
  提案一致，未引入新的边界或契约变化。独立复核发现并修补的未知变量静默通过问题已纳入范围
  并锁回归。