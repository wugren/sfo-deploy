---
task_manifest: task.yaml
status: approved
---

# Proposal：Multipass jx-server 改为 systemd service 启动

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 用户已明确要求把“有安装包的 App
  部署过程”下沉为框架内置能力。这会改变 App 配置
  schema、规划与执行路径、发布版本目录语义、同版本跳过、旧版本清理和失败回滚；它是公开部署契约与运行时行为变更，兼容性和回滚都需要完整验证，因此建议
  `high-risk`。
- Proposal and tier confirmation: 用户于 2026-09-07 回复“确认，自动完成”，批准内置 versioned
  发布方案、jx-server/jx-web 迁移和 `high-risk` 层级。

## Background and Goal

当前带安装包 App 的制品发布逻辑写在各 App 自己的 `scripts.deploy` 中。`jx-server`
重复实现了“安全解包 -> 发布版本目录 -> 原子切换 `latest` -> 写版本标记 -> 清理旧版本 ->
失败回滚”。这些步骤对大多数带安装包 App 是相同的，不应要求每个 App 复制脚本。

目标分两层：

1. 把带安装包 App 的通用版本化发布过程内置到 sfo-deploy，App 不再需要自带 deploy 脚本。
2. `jx-server` 和 `jx-web` 都迁移到该内置发布；`jx-server` 继续由 managed service 启动/重启。

## Scope

### In scope

- 为 App schema v4 增加可选 `deployment.kind`，首版只允许 `versioned`；带包 App 未声明
  `scripts.deploy` 时默认使用内置版本化发布，显式声明可提高配置可读性。
- 内置发布语义：App 内层 tar.gz 解包后的内容就是版本目录内容；框架写入 `VERSION` 和
  `.<app名>.version` 标记，原子切换 `<install_directory>/latest`，按全局 `keep_versions`
  清理旧版本。
- 同版本部署不重打包、不发布版本目录；服务收敛仍按 managed service 的 `on_deploy` 执行。
- 发布过程中版本标记或 `latest` 切换失败时回滚到上一版本；服务启动失败仍由现有 systemd
  恢复机制处理。
- `jx-server` 移除自定义 `scripts.deploy`，改用内置发布；其 service 的 `working_directory` 调整为
  `current`，启动 `latest` 下解包后的 `jx-server.jar`。
- `jx-web` 也移除自定义 `scripts.deploy`，使用同一个 `<install_directory>/<version>` 与
  `<install_directory>/latest` 布局；不再保留 jx-web 专属的 `.sfo-deploy/jx-web`
  发布目录和“单一站点根”探测逻辑。
- `install_directory` 统一表示版本化发布根目录；实际 App 载荷位于 `<install_directory>/latest`。
- 保留显式 `scripts.deploy` 作为自定义 App 的兼容逃生门；已声明自定义 deploy 的 App 不受影响。
- 同步 schema 装载/规划/执行、发布历史、CLI 结果、README、配置指南、示例配置和定向测试。

### Out of scope

- 不修改 `jx-server` 制品内容、JAR 启动参数、Spring 配置、数据库/Redis 逻辑。
- 不新增应用健康检查、日志管理或 systemd hardening 配置。
- 不执行真实 Multipass 部署或远端 VM 变更。

### Boundary with neighboring modules

schema/装载与执行器负责内置发布；`management.service` 继续负责 systemd unit
与服务动作；`app_versions.yaml` 继续负责版本、包来源和哈希；自定义 deploy
脚本继续支持特殊制品流程。`jre` 环境继续提供 `/usr/bin/java`。

## Requirement Review

请求合理：安装包解包后的内容天然适合作为不可变版本目录；通用过程已经被 jx-server 验证过，继续放在
App 脚本中会重复且容易漂移。把过程内置后，App
配置可以只声明“放哪里”和“如何启动”，制品流程由框架统一保证。

主要权衡：

- 内置发布需要固化“内层包根即版本目录”的布局约定。应用不能像当前脚本一样强制分成
  `app/conf/scripts`；如果制品本来就采用子目录，应把 package 内容重新打包，或继续使用自定义 deploy
  脚本。
- 改变部署框架的公开 schema 和执行路径；旧自定义脚本需要继续兼容，历史计划/快照仍能解码。
- 旧版本清理从 App 脚本移到框架后，必须保证与版本标记、latest
  软链和回滚路径一致，否则可能误删当前版本。
- 若目标包需要特殊解包、权限迁移、健康检查或数据迁移，内置过程不足，必须继续使用显式
  `scripts.deploy`。

选定方向：新增可扩展的 `deployment.kind: versioned`，并把“未声明 scripts.deploy 的带包
App”默认路由到该内置实现；自定义 deploy 脚本仍可覆盖默认行为。这样满足“所有普通安装包 App
过程相同”，同时不破坏特殊 App。

## Proposal Items

| proposal_id | change_id                            | requirement                                                                                                                   | boundary                                                                             | tradeoff                                                                                    | success_evidence                                                                                | non_goal                                         |
| ----------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| P-001       | CHG-versioned-deployment-schema      | App v4 支持声明 `deployment.kind: versioned`；带包 App 无 `scripts.deploy` 时默认使用内置发布，有自定义 deploy 时仍走自定义。 | 不改变 packageless App；不改变 app_versions.yaml 哈希/来源模型；自定义 deploy 保留。 | 固化包根即版本目录，减少逐 App 脚本，但特殊包仍需自定义。                                   | schema 正负例、plan 步骤和执行路由测试通过。                                                    | 不支持除 versioned 外的 deployment kind。        |
| P-002       | CHG-versioned-deployment-execution   | 框架内置版本目录发布、版本标记、latest 原子切换、旧版本清理和失败回滚。                                                       | 只消费已下载/已校验的安装包；不新增下载 provider；不执行健康检查。                   | 框架获得制品发布所有权，但必须承担与回滚/清理相关的一致性责任。                             | 同版本跳过、新版本发布、latest/标记回滚、清理边界和取消路径测试通过。                           | 不改发布历史 schema 主版本；不做跨机器原子发布。 |
| P-003       | CHG-packaged-app-versioned-migration | jx-server 与 jx-web 都移除自定义 deploy 脚本，迁移到内置 versioned 发布和统一 latest 布局。                                   | 迁移示例中的两个带包 App；nginx/packageless App 不受影响。                           | 统一发布根目录会让 jx-web 的实际站点路径从旧符号链接布局变为 `<install_directory>/latest`。 | template/live 一致、两个 plan 均展示内置发布、jx-server 同时展示 service action、定向测试通过。 | 不迁移 nginx。                                   |
| P-004       | CHG-versioned-deployment-docs-tests  | 文档与契约测试覆盖内置发布、service 启动、旧脚本兼容和包根布局。                                                              | 只更新受影响文档与测试；不重写全部指南。                                             | 文档需要明确内置与自定义 deploy 的分界。                                                    | README/指南一致；deno check、lint、fmt、unit/integration/contract 通过。                        | 不提供自动迁移工具。                             |

## Success Criteria

- Concrete user-visible or system-visible result: 普通带安装包 App 不再需要自带 deploy
  脚本；框架将其解包到 `<install_directory>/<version>`，原子切换
  `<install_directory>/latest`。`jx-server` 通过 managed service 启动，`jx-web` 直接使用 latest
  目录作为站点载荷。
- Required evidence: schema 正负例、内置发布行为、同版本跳过、回滚/清理、自定义脚本兼容、service
  契约、README/指南一致性测试通过；`deno task check`、`lint`、`fmt` 通过。
- Explicit non-goals: 不证明真实 VM 部署成功，不构建或替换 JAR/前端制品，不新增健康检查，不迁移
  nginx，不支持 versioned 以外的 deployment kind。

## Risks

- 服务启动失败会使 deploy 的 systemd 收敛阶段失败；这是预期 fail-closed
  行为，但不会新增应用级回滚检查。
- 实现验证发现：带环境依赖的 App 执行显式 `start`/`stop`/`restart` 时，计划会包含环境依赖 check 并与
  requested action 不匹配（复现：`start --app jx-server` 报
  `env:eleph-server/jre:check environment/check vs start`）。这属于既有框架筛选语义问题；修复它超出本提案范围，需用户决定是否另开任务或修订本任务。
- 内置发布把失败回滚和旧版本清理从 App 脚本提升为框架责任；如果实现不一致，可能误删当前版本或让
  `latest` 与版本标记失配。
- “包根即版本目录”是新增约定；若既有安装包假定包根外还有一层目录，需要重新打包或继续使用自定义
  deploy。
- jx-web 从旧“install_directory 是指向版本的符号链接”布局迁移到“install_directory 内含
  latest”布局，属于路径语义变更；消费该目录的服务或脚本必须使用 `<install_directory>/latest`。
- 生成的 unit 使用 `/usr/bin/java` 绝对路径；若目标机 Java
  安装路径不同，服务无法启动，当前示例环境已假定 `/usr/bin/java`。
