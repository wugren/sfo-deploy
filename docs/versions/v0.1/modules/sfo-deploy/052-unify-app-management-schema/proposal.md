---
task_manifest: task.yaml
status: approved
---

# Proposal：统一 app.yaml 的 managed 资源声明

Risk profile: ./risk-profile.yaml

Risk profile: not-created (仅在 high-risk 确认后替换为 ./risk-profile.yaml)

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务会新增 `app.yaml` 公开 schema（建议
  v4），改变配置声明契约与用户可见的迁移/兼容边界；示例、文档和验证面同步变化。虽然可以在装载后归一到现有内部模型以缩小实现范围，但公开契约、兼容性和文档迁移仍命中
  high-risk 边界。
- Proposal and tier confirmation: 用户于 2026-09-06 确认提案与 high-risk
  层级，并要求自动完成全生命周期。

## Background and Goal

当前 App v3 有两套声明面：

1. 顶层 `scripts` 声明 `check/install/configure/deploy/start/stop/restart` 脚本；
2. `management` 内部再分成 `configs`、`service` 和 `hooks`。

这导致“配置、服务、脚本”分散在多个 YAML 层级中。用户希望把它们收敛为同一个集合，通过不同
`kind`/类型表达；尤其当启用 managed 配置和 systemd 服务时，不应再重复声明配置脚本或
start/stop/restart 脚本。

目标是为 App 引入一个统一的 managed 资源声明集合：内置配置生成和 systemd
启停控制是同一集合中的两种类型条目；service 条目通过一个明确的 `working_directory`
描述安装相关目录，启动命令和参数保持固定声明，框架装载后仍按现有动作语义、权限模型和失败关闭行为执行。

## Scope

### In scope

- 新增 `app.yaml schema_version: 4` 统一 managed 资源声明形状（推荐 `management.actions` 列表）。
- 支持的条目只有两种：
  - `kind: config`：生成、校验并原子发布 App 配置；
  - `kind: service`：声明 `working_directory`、固定的启动命令和参数、systemd unit
    的生成与发布，以及启停、重启、reload 和状态收敛。
- `unit_config` 的核心表达是启动定义（例如 `ExecStart`
  的可执行路径和参数），不是任意业务配置；常见字段还包括 working directory、environment 和 unit
  目标路径。
- 生成 unit 时必须声明 `working_directory`。它可以是相对 App `install_directory`
  的路径，也可以是远端绝对路径；相对路径必须留在该 App 安装目录内，`..` 越界和解析失败都会 fail
  closed。
- 启动命令和参数是固定字面值，不做变量替换或 deployment facts 注入。可执行路径可声明为绝对路径、PATH
  中的裸命令名，或相对 `working_directory` 的路径；相对可执行路径由框架渲染成 systemd 要求的绝对
  `ExecStart`。启动参数原样写入，参数中的相对路径由服务进程按 working directory 解析。
- 生成的 systemd unit 文件目标路径仍必须是远端绝对路径；框架不把 App 相对路径解释为控制端工作目录或
  systemd 服务进程的隐式 CWD。
- unit 内容变化后再执行 daemon-reload 和声明的服务动作。不需要生成 unit 时，`unit_config`
  可以缺省，此时 service 只控制目标节点上已有的 unit。
- 保持动作所有权唯一：`config` 存在时不能再有 `action: configure` 的脚本；`service` 存在时不能再有
  `action: start/stop/restart` 的脚本。
- 禁止 `kind: config` 和 service 的 `unit_config` 声明同一个目标路径，避免两个 managed 资源争夺 unit
  文件。
- 不提供 `kind: script` 或 `kind: hook`；App 自身必要的脚本仍放在现有 `scripts` 声明中。
- 统一校验唯一性、必填字段、放置顺序、`run_as`、包/packageless 要求和 on-change 服务依赖。
- 继续保留 v2/v3 装载行为；新增 v4 不自动改写既有集群。
- 同步 README、集群配置指南、示例集群和相关测试。

### Out of scope / explicit non-goals

- 不改变 Environment 的 `environment.yaml.scripts` 布局。
- 不改变秘密声明、systemd 提权模型、执行锁或失败回滚语义；unit 启动参数的类型、排序与 shell
  转义边界由设计阶段基于安全边界确定。
- 不新增 managed hook、任意脚本入口或自定义 service manager。
- 不实现旧 v2/v3 到 v4 的自动迁移工具。
- 不保留 v4 中 `scripts` 与 `management.configs/service/hooks` 的旧形状；避免同一个 schema
  里出现两套声明面。
- 不在本提案内支持 systemd 以外的 service manager。

### Boundary with neighboring modules

- `src/config.ts` 负责装载 v4 并归一到内部模型。
- planning/execution/history/CLI 优先继续消费现有归一模型；只有当计划或展示暴露 v4
  原始形状时才需要小范围同步。
- 文档和示例是用户契约的一部分，必须与 loader 错误提示一致。

## Requirement Review

- 请求合理：现有所有权校验已经防止配置/生命周期动作重复，但声明面分散仍然让“动作由谁拥有”不够直观。统一为
  `config` 和 `service` 两种 managed 资源能减少心智负担。
- 主要权衡：新增 v4 会带来第二个 App 声明格式；如果不新增 schema，直接改 v3 会破坏既有集群。推荐用
  v4 做显式、可校验的迁移边界，同时保留 v2/v3。
- 选定方向：v4 的 `management.actions` 只承载生成配置与 systemd 控制；service 条目内置
  `unit_config`，用 `working_directory`
  承载唯一的安装相关目录语义，启动命令和参数保持固定声明。装载后归一到现有模型，不引入部署后
  facts/变量系统，从而把行为风险限制在配置装载/校验与文档迁移层。App 特有部署/检查逻辑继续留在
  `scripts`，不再通过 hook 扩展点进入 managed 资源。

## Proposal Items

| proposal_id | change_id                         | requirement                                                                                                                                                                                                                                                         | boundary                                                       | tradeoff                                                                    | success_evidence                                                                                                                                                                       | non_goal                                  |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| P-001       | CHG-unified-app-action-schema     | 新增 App v4 统一 `management.actions` 声明，只支持 `config` 和 `service` 两种 kind；service 条目声明 `unit_config`，用 `working_directory` 表达安装相关目录，用固定字面值表达启动命令和参数，并建立必填、未知字段、重复、路径冲突/越界、所有权和 packageless 校验。 | v4 是新契约；v2/v3 装载行为保持不变。                          | 引入新 schema，但避免破坏旧集群。                                           | v4 正负例覆盖两类条目、working directory、固定启动命令/参数、相对基准解析与越界拒绝、unit 生成、目标路径冲突、重复、缺失 run_as、on_change 无 service 等错误。                         | 不支持 v4 旧字段别名。                    |
| P-002       | CHG-unified-app-action-consumers  | 将 v4 装载结果归一到现有 App 脚本/管理模型；解析 working directory、渲染/发布 service unit，并纳入配置发布/服务收敛流程。                                                                                                                                           | 不改 systemd 执行、锁和回滚语义；unit 渲染协议在设计阶段确定。 | 借助归一模型降低 runtime/历史快照风险，但需要同步配置发布顺序和目标端渲染。 | v4 计划、deploy/configure/start/stop/restart 展示与执行与等价 v3 归一结果一致；working directory 或固定启动声明变化会让 unit 内容变化并触发 daemon-reload/服务动作，且被失败恢复覆盖。 | 不新增 hook、service manager 或远程协议。 |
| P-003       | CHG-unified-app-action-docs-tests | 文档、示例集群和测试迁移/补充 v4 用例，并明确 v2/v3 保留策略与迁移方式。                                                                                                                                                                                            | 只改任务相关文档、示例和测试。                                 | 示例更新面较广，但契约一致性必须闭环。                                      | `deno task check` 与统一测试入口通过；README/指南/示例无旧 v4 冲突声明。                                                                                                               | 不提供自动迁移工具。                      |

## Success Criteria

- 可见结果：用户可以在 `app.yaml schema_version: 4` 中用同一个 `management.actions`
  列表声明配置生成和 systemd 启停控制；service 条目通过 `working_directory`
  表达安装相关目录，启动命令和参数固定声明。
- 必要证据：v4 装载正负例测试覆盖统一 schema、两类资源的动作所有权、working directory
  解析、固定启动命令/参数、service unit 生成/发布、路径冲突、packageless/带包要求、错误文案；示例可
  validate/plan；相关测试与 `deno task check` 通过。
- 显式非目标：不改 Environment；不自动迁移旧配置；不引入 hook 或新的 service manager。

## Risks

- 公开契约风险：v4 若设计不当，会加剧 schema 复杂度；必须严格禁止 `scripts` 与
  `configs/service/hooks` 的旧别名。
- 迁移风险：v2/v3 保留会让框架短期支持两种心智模型，需要文档明确“新 App 用 v4”。
- 行为一致性风险：统一 YAML 必须归一到现有模型，避免配置/服务执行顺序或失败恢复出现差异。
- Unit 渲染风险：systemd unit 不是现有 YAML/JSON/TOML/INI
  结构化格式，直接复用现有渲染器可能改变语义；设计阶段必须确定专用渲染/校验边界。
- 参数注入风险：启动参数进入 systemd unit 时必须避免 shell
  意义、换行、空参数和权限边界被误用；需要类型化/严格转义或固定 argv 语义。
- Working directory 风险：相对基准必须绑定到明确的 `install_directory`，否则不同 systemd
  工作目录、package 布局或目标节点会造成行为漂移。
- 示例/测试风险：现有示例混合了 managed 与 legacy
  App，需要逐个确认迁移范围，避免误改不该迁移的用例。
