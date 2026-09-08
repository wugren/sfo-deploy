---
task_manifest: task.yaml
status: approved
---

# 本地 App 部署包 fetch 与用户配置提案

Risk profile: not-created（仅在高风险确认后替换为 ./risk-profile.yaml）

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 需求明确且集中在 `sfo-deploy` 单模块：(1) 新增 `fetch` CLI
  动作，只下载 App 安装包；(2) 引入用户级本地部署包缓存并让 `deploy` 只从本地取包； (3) 支持
  `~/.sfo-deploy/config.yaml` 自定义部署包放置目录。命中 contract-protocol、
  runtime-integration、build-config-deployment 与 data-schema/storage 等筛查触发器：确有公开 CLI
  动作、deploy 执行路径与用户级持久化目录变化，但集群配置 schema、执行计划格式、发布历史
  intent/outcome/snapshot 结构、下载 provider 协议与信任边界均不改变；改动有定向单元/集成测试、
  严格配置校验与文档一致性覆盖，风险受控，因此按 bounded 的 `standard` 层级执行。
- Proposal and tier confirmation: 用户已回复「确认」并给定未决问题答案：命令名使用 `fetch`； fetch
  只下载 App 安装包（不下载环境 install 包）；deploy 缺包时提示先运行 fetch 并终止； rollback
  缓存优先、缓存缺失时远端下载并回填；按确认后的范围自动完成本任务。

## Background and Goal

当前 sfo-deploy 的 App 部署包在每次执行 `deploy` 时由 `prepareExecution` 直接从远端 （HTTP/HTTPS 或
filehub）下载到临时目录，部署前没有独立的“本地取包”环节；即使本机已保存过
同一安装包，下次部署仍会重新下载。用户希望在部署前先把 App 安装包从远端下载到部署机本地， 之后
`deploy` 命令只读取本地安装包，并支持通过用户级配置文件自定义包目录。

目标：新增 `fetch` 动作把所有或选定 App 的部署包下载到用户级本地缓存；`deploy` 只消费本地缓存，
缺少即明确失败并提示先运行 `fetch`；本地已存在指定版本且哈希校验通过的包时不重复下载；
`~/.sfo-deploy/config.yaml` 可配置 `packages_dir`（默认 `~/.sfo-deploy/packages`）。

## Scope

### In scope

- 新增 CLI 动作 `fetch`：可重复使用 `--app` 筛选，缺省下载全部 App 的 deploy 包；不处理环境 install
  包。动作不建立 SSH 连接、不创建发布记录、不请求执行确认；输出 JSON，按包给出 `downloaded`/`cached`
  状态、App 名称、版本、provider、缓存路径和哈希。
- 本地包缓存：默认目录为用户主目录下 `.sfo-deploy/packages`；缓存条目按 provider 与
  算法-哈希内容寻址存储，每次使用前校验文件属性（普通文件、非链接）与完整哈希；命中且校验通过
  则跳过远端下载；并发重复下载时以原子发布为准，任一成功即视为缓存命中。
- `deploy` 本地门禁：CLI 的 `deploy` 只从本地缓存解析 App 部署包；缺失或校验失败时在预检阶段
  失败（退出码 3），给出 `请先运行 sfo-deploy fetch ... --app <名称>` 的指示，不连接 SSH、
  不创建发布 attempt。
- 其它执行动作：`rollback`、`install`、`configure` 等需要包的动作同样本地缓存优先；缓存缺失时
  保留现有远端下载能力并把下载结果回填缓存（回退旧版本源仍可访问的既有契约不变）。
- 用户配置：支持 `~/.sfo-deploy/config.yaml`，字段 `schema_version: 1` 与可选的
  `packages_dir`；允许绝对路径或以 `~` 开头的路径并展开；配置文件不存在时使用默认值；未知字段、
  非法值一律严格报错。
- 文档与测试：README、集群配置指南、示例 README 同步新动作、缓存目录与本地门禁；补充配置装载、
  缓存命中/校验/并发、fetch 动作、deploy 缺包门禁的单元与集成测试；适配既有 CLI 测试 （注入隔离的
  home 目录/缓存路径）。

### Out of scope

- 不改变集群配置 schema（`cluster.yaml`/`app.yaml`/`environment.yaml`）、`ExecutionPlan`
  schemaVersion、发布历史（intent/outcome/snapshot）结构或下载 provider 协议本身。
- fetch 不下载环境 install 包，不支持 `--environment`；环境 install 包仅由 install 等动作在
  缓存缺失时远端回填。
- 不支持从发布快照专门拉取旧版本包；旧版本回退仍走既有 source 下载并回填缓存。
- 不做并行下载、断点续传、缓存自动清理/淘汰/TTL，不在缓存中加入 token、密码或预签名 URL 之外的
  凭据。
- 不改变 `plan`/`validate`/`check`/`start`/`stop`/`restart`/`history` 的既有输出语义（仅
  install/rollback 的取包源变为缓存优先）。

### Boundary with neighboring modules

- CLI/集成模块：`CLI_ACTIONS`、参数解析与帮助文本增加 `fetch`；`RunResult` 与 `serializeResult` 增加
  fetch 结果；`RunOptions` 明确 `fetch` 仅允许 `--app` （不允许
  `--environment`、`--machine`、`--with-dependencies`、`--executor-region`、
  `--address-kind`、`--release-id`）。
- 执行准备模块：`prepareExecution` 增加缓存解析路径；缓存文件只读拷贝到本次临时目录供上传，
  绝不清除缓存本体；deploy 为 local-only，rollback/install/configure 保留 remote-fallback。
- 配置模块：新增独立用户级配置装载器，不改动集群装载器与既有严格校验风格。
- 历史/回退：回退保留远端回填能力，发布快照 source codec 不变。
- 公共 API：`run()`/`prepareExecution` 未显式提供缓存目录时保持既有远端下载行为（向后兼容）； CLI
  路径始终使用用户配置或默认缓存目录。

## Requirement Review

需求合理：把“取包”与“部署”拆开让包准备可审计、可复用，也支持离线/受限部署机先把 App 包备齐；
“本地已有指定版本则不重复下载”能显著减少重复网络传输。缓存以 provider + 内容哈希寻址，因此
“同版本但内容不同”的包会被正确识别为新包重新下载，不会误用旧内容；每次使用前重新校验哈希可对抗
缓存被篡改或损坏。

主要取舍：

- `fetch` 只处理 App deploy 包，环境 install 包不属于本动作范围；需要环境包的场景由 install 动作
  在缓存缺失时远端回填，保持闭环。
- `deploy` 严格本地化会让未先执行 `fetch` 的既有自动化在预检期失败，这是本次明确要求的
  行为变化；错误信息与文档会给出明确补救命令。
- rollback 保留远端回填而不是与 deploy 同样强制本地，避免旧版本 source 无法由当前配置枚举时
  回退被锁死，同时不破坏 README 既有的“回退时制品源仍须可访问”契约。
- 用户级缓存为全局共享目录，跨集群同哈希包可复用；目录权限按既有工件规则收紧（目录 0700、 文件
  0600）。
- 配置遵循仓库严格校验风格：用户配置文件缺失时静默使用默认，存在时未知字段即报错，避免拼写错误
  被忽略。

## Proposal Items

| proposal_id | change_id            | requirement                                                                                                 | boundary                                                             | tradeoff                                   | success_evidence                                                                                | non_goal                                    |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------- |
| P-001       | CHG-fetch-cli-action | 新增 `fetch` 动作，按 `--app` 筛选下载 App 部署包到本地缓存并输出 JSON 结果                                 | 仅新动作且只处理 App 包；无 SSH、无发布记录、无确认；仅 `--app` 参数 | 取包与部署拆分，自动化为离线部署需多跑一步 | CLI 单元/集成测试通过；`--help`、公共 API、JSON 分支覆盖；非授权参数与重复筛选报错              | 不下载环境包、不做 `--environment`/并行下载 |
| P-002       | CHG-package-cache    | 内容寻址本地缓存 + 命中跳过 + 每次校验 + deploy 本地门禁；rollback/install/configure 缓存优先、缺失远端回填 | 缓存与执行准备模块；并发重复下载任一成功；缓存绝不删除               | 同版本新包仍会重下（正确识别内容变化）     | 命中不触发远端、哈希损坏失败关闭、并发发布测试；deploy 缺包预检失败且零 SSH/零 release 测试通过 | 不做自动清理/TTL/断点续传                   |
| P-003       | CHG-user-config      | `~/.sfo-deploy/config.yaml` 装载 `packages_dir`，缺省 `~/.sfo-deploy/packages`，严格校验                    | 仅用户级配置；cluster 装载器不变                                     | 用户配置缺失静默默认；存在则未知字段报错   | 配置装载单元测试覆盖缺省、`~` 展开、未知字段与相对路径拒绝；CLI 装配测试                        | 不支持环境变量覆盖或其它配置项              |
| P-004       | CHG-docs             | README、集群配置指南、示例 README 记录 fetch 用法、缓存目录配置与 deploy 本地门禁                           | 文档与行为一致                                                       | 无                                         | 文档检查与实现/测试描述一致                                                                     | 不重写安装与生命周期文档                    |

## Success Criteria

- Concrete user-visible or system-visible result: 运行
  `sfo-deploy fetch --cluster production
  --app backend` 后，`~/.sfo-deploy/packages`（或配置的
  `packages_dir`）中出现对应 算法-哈希文件与元数据；再次运行同范围命令输出 `cached`
  且不发起远端请求。随后 `sfo-deploy
  deploy --cluster production --app backend`
  全程不联网取包即可完成部署；若先删缓存再 deploy， 命令在预检期失败（退出码 3）并提示先运行
  `fetch`，且无 SSH 连接、无发布 attempt。
- Required evidence: fetch/缓存/配置/CLI 定向单元与集成测试、`deno task check` 通过；
  README/指南/示例文档同步；变更记录与轻量完成报告按 standard 层级完成。
- Explicit non-goals: 不改变发布历史与集群配置格式；不做并行下载与缓存淘汰；fetch 不处理环境 install
  包；不为 rollback 增加专门的快照下载动作。

## Risks

- 缓存文件被篡改或损坏：每次使用前按声明哈希全量校验，失败关闭并给出文件路径与哈希信息；不自动
  删除用户数据，错误信息提示人工移除。
- `deploy` 行为变化影响现有自动化：预检失败退出码 3 并给出一键补救提示；README/指南示例与帮助
  文本同步，change record 明确该兼容性变化。
- 目录权限：缓存目录/文件按 0700/0600 收紧；路径经 `~` 展开与严格校验，相对路径拒绝，避免歧义。
- 并发下载：复用既有原子发布语义，`AlreadyExists` 后按已有文件重新校验，防止半成品被采用。
- 回退兼容：rollback 保留远端回填，发布快照 codec 与回退约定不变。
- 既有测试兼容：现有 CLI/传输测试默认断言远端取包；本地优先后为 `createCli` 提供可注入的 home
  目录/缓存路径，测试在临时目录隔离运行，避免污染真实 `~/.sfo-deploy`。
