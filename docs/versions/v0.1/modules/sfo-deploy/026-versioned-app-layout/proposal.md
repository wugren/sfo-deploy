---
task_manifest: task.yaml
status: approved
---

# App 版本/下载/哈希独立配置、版本安装目录、latest 软链与安装包重打包/hash 校验提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 需求改变远端持久目录语义：`~/.sfo-deploy/apps/<version>/`
  作为真实安装包存放目录，App 实际安装目录由 `app.yaml` 的必填 `install_directory` 字段声明，并在
  安装目录下按版本建目录、`latest` 软链与失败回滚语义；同时涉及安装包信任校验边界（SSH 前
  size+SHA-256 与 gzip 格式校验、目标机 sha256sum 复验）、`app_versions.yaml` 配置 schema
  （data-schema）与部署 context 脚本输入契约扩展。综上确认存在物质性 release/deployment、
  compatibility/rollback、security/supply-chain 与 contract-protocol 影响，故最终层级为
  `high-risk`。
- Proposal and tier confirmation: 已确认。用户确认层级 high-risk 并按推荐/指定回答全部未决问题：
  `install_directory` 必填；hash 采用目标机 `/usr/bin/sha256sum` 直接复验；版本目录与 `latest`
  按推荐模式（`<install_dir>/<version>/` 与 `<install_dir>/latest`，systemd 从 latest 启动，失败
  回滚重建 latest）；独立配置文件采用集群根 `app_versions.yaml`；app.yaml 移除 version/package。
  用户补充要求：fetch 取得的是 App 可执行文件包且均为 tar.gz，部署时需解压并与集群相关脚本重新
  打包生成真正的安装包。用户指示“自动完成”，后续高风控阶段按流程证据自动推进，不再重复征求确认。

## Background and Goal

当前 jx-server 示例部署到机器上时的持久布局是固定目录 `/home/ubuntu/eleph-server/`：JAR 直接写为
`jx-server.jar`，配置写为 `application.yml`，另用 `.jx-server.version` 文本标记当前版本，回滚靠
`jx-server.jar.previous` 备份；持久目录路径硬编码在脚本里。部署包先由框架在 SSH 前完成 size+SHA-256
校验（不通过不会上传），再上传到每步临时工作区 `/tmp/sfo-deploy-*/package-*.bin`，
由脚本复制到持久目录。App 的 `version`、下载 provider/source 与版本 hash 内联在 app.yaml 中，
每次发版都要在 app.yaml 里改；fetch 只下载，不区分可执行包格式。

用户希望改为：

1. 每个 App 版本放独立目录，目录名即版本号，目录内是该版本的完整可执行内容；`latest` 软链接表示
   最新版本。
2. 真实安装包上传到集群机器 `~/.sfo-deploy/apps/<version>/`；App 实际安装目录由 `app.yaml` 必填的
   `install_directory` 设置，版本目录与 `latest` 位于安装目录之下。
3. 安装包必须通过 hash 校验后才可安装；校验不通过不安装。
4. 每次发版都会修改的安装版本、下载配置（provider/source）与版本 hash 统一放入集群根
   `app_versions.yaml`，发版时只编辑该文件；app.yaml 不再内联这些字段。
5. fetch 下载的是 App 可执行文件包且均为 tar.gz；部署时先解压可执行文件包，再与集群配置中该 App
   的启动/停止等相关脚本重新打包，生成真正的安装包后安装。

## Scope

### In scope

- jx-server 示例（cluster-template 与生成的 clusters/multipass 在线集群）持久布局改造：
  - 真实安装包存放目录：`~/.sfo-deploy/apps/<version>/`，存放重打包生成的 tar.gz 安装包；
  - 安装目录：app.yaml v2 必填 `install_directory`（远端绝对 POSIX 路径），脚本不再硬编码持久路径；
    jx-server 示例设置为既有 `/home/ubuntu/eleph-server`；
  - 版本目录：`<install_dir>/<version>/` 存放该版本完整可执行内容（解压后的可执行文件、该版本渲染
    后的 application.yml、集群启动/停止等脚本与版本元数据）；`<install_dir>/latest` 为指向最新版本
    的软链；systemd 单元从 `latest` 路径启动。
- 版本与跳过语义延续 024：以 `app_versions.yaml` 声明、装载后合并进 `AppDefinition.version`（经
  `metadata.parameters.version` 传递）为唯一版本来源；同版本部署跳过发布与重启；新版本发布失败时
  回滚到上一版本目录并重建 `latest`。
- 安装包 hash 校验（已确认方案）：
  - 保留现有框架级校验：下载后在 SSH 前校验大小与 SHA-256，失败即不执行部署；
  - 部署 context metadata 显式加入 `package_hash`（algorithm/value），jx-server 远端 deploy 脚本
    在目标机用 `/usr/bin/sha256sum` 复验，通过后才继续解压、重打包与发布。
- 独立版本/下载/hash 配置文件：新增集群根 `app_versions.yaml`（schema_version + `apps` 映射），按
  App 声明 `version` 与 `package`（provider/source/hash）；app.yaml v2 移除 `version`/`package`，
  装载时与独立文件合并为既有 `AppDefinition`；纯 v1 内联集群（无 app_versions.yaml）只读兼容。
- App 安装包重打包：框架在 SSH 前校验 App 可执行包 gzip 魔数（必须是 tar.gz）；jx-server deploy
  脚本在目标机 `sha256sum` 复验后解压可执行包，写入渲染后配置、集群配置中的启动/停止等相关脚本与
  版本元数据，重新打包为真实安装包存入 `~/.sfo-deploy/apps/<version>/` 并发布到
  `<install_dir>/<version>/`；框架 metadata 为脚本提供 `package_hash`、`install_directory`、模板与
  集群脚本映射。
- app.yaml 配置：schema v2 必填 `install_directory`，经配置装载、计划与 context metadata 传给远端
  脚本；文档字段表同步。
- 文件秘密、环境安装、MySQL/Redis/nginx 等其它目录布局不做改动。
- 文档：README、集群配置指南、示例 README 与任务 change record 同步 `app_versions.yaml`、
  `install_directory`、真实安装包目录、重打包流程、latest 软链、回滚与 hash 校验语义。
- 测试：更新 config/planning、deploy_version_skip、fetch_package、independent_remote_scripts 等
  既有测试并新增配置/重打包/hash 拒绝用例，保持模板与在线集群脚本逐字节一致契约。

### Out of scope

- 不把“安装包目录 + 版本安装目录 + 重打包算法”强制为所有 App 的框架行为：安装目录与打包组合方式由
  App 的 deploy 脚本决定，本任务只在 jx-server 示例实现重打包并补齐框架 metadata。
- 不自动迁移已存在的旧布局机器（如 `/home/ubuntu/eleph-server/jx-server.jar` 平铺布局）与 v1 内联
  配置；在线示例集群需重新运行 prepare 或手工迁移后才采用新布局。
- 不改集群 schema 主版本、ExecutionPlan 格式或发布历史 intent/outcome/snapshot 结构；不改下载
  provider 协议本身；不发新 context schema 主版本（只在 metadata 扩展字段）。
- 不做旧版本目录自动清理/保留策略；历史版本与 `~/.sfo-deploy/apps/` 中安装包保留由运维决定。
- 不改变环境 install 包格式；jre/mysql/redis/nginx 等环境包仍不做 gzip/tar 约束。

### Boundary with neighboring modules

- 配置模块：`src/config.ts` 新增 `app_versions.yaml` 装载（schema_version、按 App 映射、严格校验），
  与 app.yaml v2 合并产出既有 `AppDefinition`；校验 `install_directory`（必填、远端绝对 POSIX 路径、
  拒绝 `..` 与非法字符）；类型 `src/types.ts` 与计划 `src/planning.ts` 携带该字段；纯 v1 集群只读
  兼容；未知/非法值在 SSH 前失败。
- 执行模块：`src/execution.ts` 在“有 package 的 install/deploy 步骤”向 context metadata 注入
  `package_hash`，App 步骤注入 `install_directory`，App deploy 步骤注入集群脚本映射与模板；App
  安装包在 SSH 前校验 gzip 魔数；上传仍走临时工作区，解压、重打包、落位与安装目录写入由脚本完成。
- 下载/缓存模块：`src/downloads.ts` 增加 gzip 魔数断言辅助；本地缓存与下载 provider 语义不变。
- 示例/在线集群：模板与 live cluster 的 jx-server 脚本、app.yaml、`app_versions.yaml`、jx-runtime
  systemd 模板必须一致；app.yaml 的 deploy/configure `run` 白名单增加 `/usr/bin/sha256sum`、
  `/usr/bin/tar` 等最小命令。
- 历史/回退：旧快照重放仍执行快照内的旧脚本，忽略新增 metadata 字段；不回写或迁移旧快照。

## Requirement Review

需求合理，与现有架构大部分兼容：

- 框架下载阶段已做 size+SHA-256 校验；用户确认“目标机 sha256sum 复验”后，metadata 增加
  `package_hash` 由脚本复验，防御上传-写入窗口被替换/损坏。
- `~/.sfo-deploy/apps/<version>/` 是真实安装包存储目录（与控制器本地 `~/.sfo-deploy/config.yaml`、
  `packages/` 同名前缀但分处不同机器，文档需明确区分）；安装目录来自 app.yaml，版本目录与 latest
  位于安装目录之下，“装到哪里”提升为声明式配置。
- 独立配置文件：`version` 与 `package`（provider/source/hash）是每次发版修改的数据，独立成
  `app_versions.yaml` 后编辑面更小且可整体校验；代价是文件间一致性约束（每个 App 必须有且仅有一条
  版本记录），由装载时严格校验与全量映射检查兜底。
- 重打包：框架负责把可执行文件包安全送到目标机并校验，脚本负责解压、与集群脚本组合、再打包与发布，
  符合“装什么/怎么装由脚本负责”的既有架构；安装包格式约束为 tar.gz（gzip）由框架 SSH 前校验兜底。
- 版本目录 + latest 软链替代固定目录与 `.previous` 备份模型，回滚语义变为“版本目录切换 + 软链重建”；
  软链原子切换、配置写入时机与 data/uploadPath 共享目录在设计中明确。

## Proposal Items

| proposal_id | change_id                | requirement                                                                                                                                                                                                                     | boundary                                                                                 | tradeoff                                              | success_evidence                                                                                                        | non_goal                                            |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| P-001       | CHG-versioned-app-layout | app.yaml v2 必填 `install_directory`；真实安装包存 `~/.sfo-deploy/apps/<version>/`；`<install_dir>/<version>/` 放完整可执行版本，`<install_dir>/latest` 软链指向最新版本；systemd 单元、版本跳过与失败回滚基于版本目录/软链实现 | 仅 jx-server 示例与 live 集群副本；v2 必填该字段                                         | 多版本目录占用磁盘；软链切换需原子且失败可回退        | 远端安装包目录、版本目录、latest 结构测试，回滚重建 latest，模板与 live 脚本一致契约，`deno task check` 通过            | 不自动清理旧版本、框架不内置每个 App 的安装布局算法 |
| P-002       | CHG-remote-package-hash  | 安装包 hash 校验：保留框架 SSH 前 size+SHA-256 校验并文档化；context metadata 增加 `package_hash`，远端脚本用 `/usr/bin/sha256sum` 复验后才解压/重打包/发布                                                                     | 仅 install/deploy 且声明 package 的步骤；metadata 扩展字段，不改 schema 主版本           | 远端多一次校验开销；app.yaml run 白名单增加 sha256sum | 破坏文件注入后脚本拒绝安装；校验失败步骤失败且不发布；契约/文档测试通过                                                 | 不改下载 provider 协议或历史快照格式                |
| P-004       | CHG-release-config       | 集群根 `app_versions.yaml`：按 App 声明 `version` 与 `package`（provider/source/hash）；app.yaml v2 移除内联 version/package，装载合并为 AppDefinition；纯 v1 内联集群只读兼容                                                  | sfo-deploy 配置装载、示例与文档；不改变执行计划/历史快照格式                             | 多 App 单文件编辑更集中，但出现文件间一致性要求       | 修改版本只编辑 app_versions.yaml；缺失/多余 App、未知字段、非法 hash 装载即失败；单元/契约测试与 `deno task check` 通过 | 不自动迁移 v1 文件，不改变下载 provider 协议        |
| P-005       | CHG-repackage            | fetch 的 App 可执行文件包为 tar.gz（SSH 前校验 gzip 魔数）；deploy 时目标机 sha256sum 复验后解压，写入渲染配置、集群启动/停止等脚本与版本元数据，重新打包为真实安装包存入 `~/.sfo-deploy/apps/<version>/` 并发布到版本目录      | 仅 App deploy 步骤与 jx-server 示例；metadata 扩展、不改变下载 provider 协议与环境包格式 | 每个版本目录自包含可执行内容与脚本，磁盘占用增大      | 解压/重打包/发布/回滚测试、hash 拒绝与 gzip 拒绝测试、模板与 live 脚本一致契约通过                                      | 框架不内置各 App 的打包算法本身                     |
| P-003       | CHG-docs                 | README、集群配置指南、示例 README 与 change record 记录 `app_versions.yaml`、`install_directory`、真实安装包目录、重打包流程、latest 软链、回滚与 hash 校验语义                                                                 | 文档与实现/测试一致                                                                      | 无                                                    | 文档描述与行为、测试一致                                                                                                | 不重写安装/配置教程主体                             |

## Success Criteria

- Concrete user-visible or system-visible result: 部署某版本 V 后在目标机 `~/.sfo-deploy/apps/V/`
  存在通过校验的真实安装包（tar.gz）；`<install_dir>/V/` 存在完整可执行版本（解压后的可执行文件、
  该版本渲染配置、集群脚本与版本元数据）；`<install_dir>/latest` 是软链且指向 V；安装目录来自
  app.yaml 的 `install_directory`；systemd 单元从 `latest` 路径运行；部署同版本时跳过发布/重启；
  新版本健康检查失败时恢复上一版本并重建 `latest`；任何一层 hash 校验失败都不会安装新版本。
- 配置组织：修改某个 App 的安装版本、下载 URL 或哈希时只编辑 `app_versions.yaml`；app.yaml v2 不再
  包含 version/package；纯 v1 内联集群仍可装载且行为等价。
- Required evidence: 配置字段校验、脚本行为测试（发布、跳过、回滚、hash 拒绝、gzip/tar 拒绝）、
  模板/live 一致契约、执行器 metadata 单元测试、任务级统一测试入口与 `deno task check` 通过；
  README/指南与示例文档同步。
- Explicit non-goals: 不自动迁移旧布局与 v1 内联配置、不做旧版本清理策略、框架不内置各 App 打包
  算法（示例实现重打包并验证契约）。

## Risks

- 兼容/迁移：旧 `/home/ubuntu/eleph-server` 平铺布局机器不会自动迁移，旧 v1 内联集群不会被改写。
  缓解：文档明确重新 prepare 或手工迁移，示例测试只覆盖新布局。
- 配置 schema：`install_directory` 为 app.yaml v2 必填字段；非绝对路径或含 `..` 时装载在 SSH 前
  拒绝；`app_versions.yaml` 缺失/多余/冲突条目同样拒绝。
- 软链与回滚：非原子切换可能短暂指向不存在版本。缓解：先建临时软链再原子替换；回滚时重建 latest
  到上一版本目录并恢复健康检查。
- hash 信任边界：远端复验依赖 metadata 中的期望 hash 正确传递与 `/usr/bin/sha256sum` 可用；框架
  下载/校验仍是最外层信任边界。缓解：metadata 由已校验的 PackageSpec 注入，脚本最小权限白名单。
- 重打包信任与格式：可执行包若被替换为非常规格式会导致部署失败。缓解：SSH 前校验 gzip 魔数与既有
  size+SHA-256，目标机 sha256sum 复验；`tar` 只处理本次工作区内受控路径。
- 契约变化：app.yaml 字段与 metadata 字段变化属于脚本输入契约扩展。缓解：context schema 主版本
  不变，旧脚本按既有严格校验兼容新增 metadata；文档与契约测试同步。

## Confirmed Decisions

1. `install_directory`：字段名即为 `install_directory`，app.yaml v2 必填，远端绝对 POSIX 路径；
   jx-server 使用既有 `/home/ubuntu/eleph-server`。
2. hash 校验：保留框架 SSH 前 size+SHA-256 校验；部署 metadata 增加 `package_hash`，目标机用
   `/usr/bin/sha256sum` 直接复验，失败即不打包不发布。
3. 版本目录与 `latest`：`<install_dir>/<version>/` 存放该版本完整可执行内容（含渲染配置、集群脚本
   与版本元数据），`<install_dir>/latest` 软链指向最新版本；systemd 从 latest 启动；失败回滚重建
   latest 并保留旧版本目录。
4. 独立配置文件：集群根 `app_versions.yaml`，按 App 映射 `version` 与 `package`；app.yaml 移除
   version/package；纯 v1 内联集群只读兼容，新集群与示例使用 v2 + app_versions.yaml。
5. 重打包：fetch 的可执行文件包为 tar.gz（框架 SSH 前校验 gzip 魔数）；deploy 脚本解压后与集群
   启动/停止等脚本、渲染配置、版本元数据重新打包为真实安装包后发布。
