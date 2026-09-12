---
task_manifest: task.yaml
status: approved
---

# Proposal：working_directory 支持目录变量赋值

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 根因明确、影响有限：multipass 集群的
  `app.yaml` 在 `unit_config.working_directory` 使用 `${LATEST_DIRECTORY}`，但 082 的
  目录变量装载只开放给 config `target`，`working_directory` 走 `remoteDirectoryPath`
  把它当作普通相对路径拼成 `/opt/eleph-server/${LATEST_DIRECTORY}` 字面路径，systemd
  unit 渲染器又刻意拒绝 `$`，因此 deploy preflight 失败。用户明确要求
  `working_directory` 也通过目录变量赋值——即把 082 的目录变量机制（框架部署期环境变量）扩到
  `working_directory`，让既有 `${LATEST_DIRECTORY}` 配置直接可用。改动集中在
  `src/config.ts` 的装载解析、对应单元测试与两处契约文档，属于对既有字段的增量能力；
  不改变 public schema、既有 `latest`/绝对/相对配置的语义、版本布局、部署/回滚事务或
  安全边界；错误路径仍在装载期本地失败。命中 contracts/deployment 触发面，但均为
  收紧 + 增量解析，未达到迁移/回滚语义实质变化的升级条件，推荐 standard。
- Proposal and tier confirmation: 用户于 2026-09-11 确认提案并选择 `standard`；确认授权设计、实现、验证、独立缺陷审查与收尾。

## Background and Goal

用户在 multipass 集群执行
`sfo-deploy deploy --cluster multipass --config-root ./examples/eleph-server-multipass/clusters`
并确认后，部署在第 1 步的 preflight 失败：

```text
错误（preflight）: systemd unit working_directory 包含不支持的 systemd 展开或引号字符
```

082-app-directory-variables 给 managed config `target` 开放了三个目录变量
`${INSTALL_DIRECTORY}`、`${CURRENT_VERSION_DIRECTORY}`、`${LATEST_DIRECTORY}`，其中
`LATEST_DIRECTORY` 表示 `<install_directory>/latest` 软链路径。multipass 集群的
jx-server 把 `working_directory` 写成 `${LATEST_DIRECTORY}`，期望它像 config target
一样被解析为 latest 目录，但装载器不对 working_directory 做变量展开，把它当相对路径段
拼成字面 `/opt/eleph-server/${LATEST_DIRECTORY}`，unit 渲染预检因 `$` 被拒而报错。

目标：让 `working_directory` 与 config `target` 一致地支持三个目录变量在装载期解析为
对应绝对目录；multipass 集群既有配置因此无需改动即可通过 preflight。

## Scope

### In scope

- `src/config.ts`：在 `systemdUnitConfig` 增加 `working_directory` 的目录变量解析：
  - 裸值（整个值就是一个变量）支持 `${INSTALL_DIRECTORY}`、`${CURRENT_VERSION_DIRECTORY}`、
    `${LATEST_DIRECTORY}`，分别解析为安装根、`<install_directory>/latest`、
    `<install_directory>/latest`（与 082 的 current/latest 装载语义一致）；
  - 也支持变量前缀 + 规范相对路径后缀（如 `${INSTALL_DIRECTORY}/lib`），约束与
    `managedConfigTarget` 一致：变量必须在开头、只出现一次、后缀不得含 `..`/`.`/空段、
    不得以 `/` 或 `//` 开头。
  - 使用目录变量时 App 必须已声明 `install_directory`；缺失则装载期 `ConfigurationError`。
  - 无变量的 `latest`（相对）、普通相对和绝对路径行为保持不变（沿用 `remoteDirectoryPath`）。
  - unit 渲染仍由 `src/systemd_unit.ts` 输出装载后解析出的绝对目录，渲染器不做变量展开。
- multipass 集群 `examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml`
  的既有 `working_directory: ${LATEST_DIRECTORY}` 保持原样，无需改动即可通过 preflight。
- `tests/unit/app_management_config.test.ts`：新增装载用例覆盖三个变量的裸值/带后缀解析、
  非法多变量、变量不在开头、非法相对后缀、缺 `install_directory` 的失败；保留既有
  `latest`/相对/绝对路径语义用例。
- `tests/unit/systemd_unit.test.ts`：补齐渲染断言，确认解析后的绝对目录（不含 `$`）正常
  渲染 `WorkingDirectory=`。
- `docs/guides/sfo-deploy-cluster-configuration.md` 与
  `skills/sfo-deploy-cluster/references/app.md`：说明 `working_directory` 支持与 config
  `target` 相同的三个目录变量及其解析语义。
- 本地验证：`deno task check`、窄域 lint/fmt、相关单元测试，并复跑集群装载与 unit 渲染
  确认 preflight 通过。

### Out of scope

- 不给 `working_directory` 引入 config `target` 之外的任意 shell/SHELL 环境变量展开；
  只复用 082 已有的三个受控目录变量，不做通用变量替换器。
- 不改变 config `target` 的变量契约、`targetRoot` 语义或 versioned 重定位行为。
- 不修改 systemd unit 渲染器（`src/systemd_unit.ts` 的 `assertUnitText` 保持对遗留
  `$`/`%`/`"` 的安全拒绝；装载解析后不再出现这些字符）。
- 不修改 history/计划快照编解码：计划快照已保存装载后的绝对路径，无需新字段。
- 不执行真实远端部署；本任务只验证本地装载与 preflight，远端执行由用户在修复后自行继续。
- 不修改其他示例、环境脚本或 cluster-template。

### Boundary with neighboring modules

`src/systemd_unit.ts` 继续拥有 unit 渲染与 `assertUnitText` 安全拒绝；本任务只在
`src/config.ts` 装载期把合法变量解析为绝对路径，非法变量与字符仍在装载期失败，渲染器
限制不放宽。`src/execution.ts` 的发布/版本重定位语义不变。

## Requirement Review

请求合理：`{working_directory}` 与 config `target` 都表达“部署期由框架决定的具体目录”，
`${LATEST_DIRECTORY}` 正是为此设计的目录变量。用户要求 working_directory 也通过该机制
赋值，能消除 `latest` 字面量与 config target 变量写法的不一致，也让 gitignored 的
multipass 集群配置无需修改。

备选方案与取舍：

- 方案 A（选定）：在装载期复用 082 的三个目录变量解析 `working_directory`（支持裸值与
  `变量/后缀`），无变量时保持原有相对/绝对语义。改动集中、契约一致、错误在装载期暴露。
- 方案 B：只把 multipass 配置改为 `latest` 并拒绝变量。能让当前部署通过，但拒绝用户明确
  要求的变量用法，且与 config target 的写法不一致，故不采用。
- 方案 C：把 systemd 的 `WorkingDirectory=${LATEST_DIRECTORY}` 字面写进 unit 让远端或
  systemd 展开。systemd 的 WorkingDirectory 不做 `$VAR` 展开，会变成字面目录，语义错误且
  违反既有拒绝策略，故不采用。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-working-directory-directory-variables | `working_directory` 在装载期解析 `${INSTALL_DIRECTORY}`/`${CURRENT_VERSION_DIRECTORY}`/`${LATEST_DIRECTORY}`（裸值或变量前缀 + 规范相对后缀）为对应绝对目录。 | 仅 `systemdUnitConfig.working_directory`；变量必须在开头且只出现一次；使用变量须已声明 `install_directory`。 | 为既有字段增加解析能力；旧 `latest`/相对/绝对写法语义不变。 | multipass 集群装载后 `workingDirectory=/opt/eleph-server/latest`，unit 渲染通过，preflight 无该错误；新增装载用例绿。 | 不做任意 shell 变量展开、不改渲染器。 |
| P-002 | CHG-working-directory-directory-variables | 非法写法（多变量、变量不在开头、非法相对后缀、缺 `install_directory`）在装载期以 `ConfigurationError` 明确失败。 | 边界与 `managedConfigTarget` 一致。 | 无；收紧既有错误路径。 | 负例装载测试红绿；存量测试与 `deno task check` 通过。 | 不放开渲染器的 `$`/`%`/`"` 拒绝。 |
| P-003 | CHG-working-directory-directory-variables-doc | 配置指南与技能参考说明 `working_directory` 支持三个目录变量及解析语义。 | 仅 `docs/guides/sfo-deploy-cluster-configuration.md` 与 `skills/sfo-deploy-cluster/references/app.md` 的相关段落。 | 低；明确契约边界。 | 两处文档包含该说明且与实现一致。 | 不做文档全面改写。 |

## Success Criteria

- Concrete user-visible or system-visible result: 修复后
  `deploy --cluster multipass --config-root ./examples/eleph-server-multipass/clusters`
  的 preflight 不再出现 “systemd unit working_directory 包含不支持的 systemd 展开或引号
  字符”；`working_directory: ${LATEST_DIRECTORY}` 解析为 `/opt/eleph-server/latest`，
  jx-server stage/activate 的 unit 正常渲染。
- Required evidence: `deno task check` 通过；窄域 lint/fmt 通过；新增装载/渲染用例红绿；
  复跑集群装载与 unit 渲染脚本确认 `workingDirectory=/opt/eleph-server/latest` 且渲染成功。
- Explicit non-goals: 不保证远端部署全程成功（表内之外的问题单独报告）；不新增任意
  shell 变量展开；不改 unit 渲染器；不修改计划快照 schema。

## Risks

- 变更面小但属于契约增量：为 `working_directory` 增加变量解析后，仓库内合法配置（均用
  `latest` 字面量或绝对/相对路径）不受影响；既有测试确认无回归。
- `CURRENT_VERSION_DIRECTORY` 在装载期与 `LATEST_DIRECTORY` 同样解析为 latest 软链路径
  （与 082 current/latest 装载语义一致）；文档会说明这一点，避免用户误以为 unit 会
  跟随候选版本切换。
- multipass 集群配置为 gitignored 本地文件，最终验证以本地装载 + 渲染脚本为主；远端执行
  由用户继续。