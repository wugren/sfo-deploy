---
task_manifest: task.yaml
status: approved
---

# Proposal：同步 multipass App 配置到最新规则

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: multipass 集群中的三个 App 均已是 App schema 1。
  配置同步本身是局部修改，但执行校验发现 schema 1 装载器没有把已解析的
  `install_directory` 传入顶层 `configs`，导致 070 引入的 `${INSTALL_DIRECTORY}` 部署
  目标契约在当前路径失效。恢复该绑定涉及框架装载、版本内配置发布路径和部署失败边界，
  属于部署/回滚与共享契约风险，因此推荐 high-risk。
- Proposal and tier confirmation: 用户于 2026-09-10 先确认 standard 提案。执行时发现 schema 1
  装载器丢失了 070 已实现的 `${INSTALL_DIRECTORY}` 绑定，完成目标需要新增框架装载修复；
  这是部署路径契约回归修正。随后用户确认修订提案并选择 high-risk。

## Background and Goal

`examples/eleph-server-multipass/clusters/multipass/apps/` 中的三个 App 都需要按当前
App schema 1 规则重新核对。`jx-web` 与 `nginx` 已使用 schema 1 的顶层 `configs` /
`management.service` 结构；`jx-server` 也已使用顶层 `configs`，但两个版本内配置目标仍写成
`<install_directory>/latest/resources/...`。当前文档推荐版本内配置使用
`${INSTALL_DIRECTORY}/resources/...`，由内置 deploy 在准备阶段解析到本次待发布版本目录，
避免依赖旧 `latest` 指向。

同时，`jx-server/application.yml` 中保留了明文 Redis 密码；同一 App 的本地配置已使用
`${ELEPH_REDIS_PASSWORD}`，集群 `cluster.yaml.secrets` 也已声明该秘密。同步规则后应消除
配置源中的明文秘密，使两个配置文件使用同一路径。

## Scope

### In scope

- 逐个审计 `jx-server`、`jx-web` 和 `nginx` 的 `app.yaml`，确认其使用当前 schema 1 的
  顶层 `configs` / `management.service` 结构、动作所有权和字段闭包。
- 将 `apps/jx-server/app.yaml` 中 `application.yml` 与 `application-local.yml` 的
  `target` 从绝对 `latest` 路径改为 `${INSTALL_DIRECTORY}/resources/...`。
- 将 `apps/jx-server/application.yml` 中的 Redis `password` 改为
  `${ELEPH_REDIS_PASSWORD}`。
- 如 `jx-web` 或 `nginx` 存在与 schema 1 冲突的字段，将按当前契约修正；当前只读核查
  显示它们不需要行为性迁移。为与集群模板和 schema 1 示例保持一致，可仅调整 `nginx`
  中 `configs` 与 `management` 的书写顺序；字段顺序不属于语义契约。
- 本地运行 `validate` 与 `plan`，确认 schema 1 装载、配置解析和部署计划继续通过。
- 修复 `src/config.ts` 中 schema 1 顶层 `configs` 装载调用：把已解析的 App
  `install_directory` 传入配置装载器，恢复 `${INSTALL_DIRECTORY}/` 目标解析。
- 增加定向回归测试，覆盖 schema 1 App 声明 `install_directory` 且配置 target 使用
  `${INSTALL_DIRECTORY}/` 时解析为 `<install_directory>/latest/<relative>`；覆盖缺少
  `install_directory` 时本地失败。

### Out of scope

- 不改变 `jx-web` 和 `nginx` 的服务行为、配置内容、目标路径或放置。
- 不修改框架源码、文档、集群模板或环境配置。
- 不运行 `secrets-deploy`、`prepare`、`deploy`，也不连接 Multipass 节点。
- 不修改数据库地址、服务端口、Java 参数或 Spring profile。
- 不处理 Redis 服务端实际密码是否已与 `ELEPH_REDIS_PASSWORD` 一致；该前提必须在真实
  部署前由目标机配置确认。
- 不修改部署执行器、远端传输、版本清理、环境生命周期或其他配置格式。

## Requirement Review

请求合理。当前实际集群配置已经完成 schema 迁移，剩下的差距是最新版本内配置目标写法和
配置源中的遗留明文秘密。改用安装目录变量是当前框架支持的推荐写法；秘密占位符能继续通过
受管配置解析和授权检查。需要明确的运行时权衡是：如果目标 Redis 当前使用的是
`application.yml` 中旧明文密码，而集群秘密是另一个值，占位符同步后应用将使用集群秘密。
这符合“秘密只由集群声明”的规则，但部署前必须确保 Redis 服务端接受该值。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-sync-multipass-app-config | jx-server 的版本内配置目标使用当前推荐的 `${INSTALL_DIRECTORY}` 写法。 | 仅改两个 `configs[].target`；不改变目标路径最终语义和 Java 启动参数。 | 旧 `latest` 写法仍兼容，新写法由 deploy 解析到待发布版本目录，依赖最新内置发布契约。 | 修改后的 `app.yaml` 可通过 `validate`，`plan` 仍生成 jx-server/jx-web/nginx 计划。 | 不迁移 jx-web/nginx，不改模板。 |
| P-002 | CHG-sync-multipass-app-config | jx-server 基础配置中的 Redis 密码使用集群秘密占位符。 | 仅替换 `application.yml` 的 `spring.redis.password`；要求 `ELEPH_REDIS_PASSWORD` 已在集群秘密中声明。 | 消除配置源明文秘密，但目标 Redis 必须接受集群秘密值，否则真实部署前需先调整 Redis。 | 定向检查确认源文件不含旧明文密码且引用已声明秘密；`validate` 通过。 | 不执行 secrets-deploy，不改 Redis 服务端。 |
| P-003 | CHG-sync-multipass-app-config | jx-web 和 nginx 的 App 声明按当前 schema 1 审计并对齐。 | 不改变 jx-web/nginx 的部署、服务、配置内容或机器放置；nginx 最多只做 `configs`/`management` 顺序整理。 | 字段顺序无语义影响；保持集群模板、指南示例和实际集群一致可降低后续维护误读。 | 定向检查确认三者均无旧 schema 字段、旧顶层 `management.configs`、冲突脚本或未声明秘密引用；`validate`/`plan` 通过。 | 不为通过检查而虚构或新增配置。 |
| P-004 | CHG-sync-multipass-app-config | 恢复 App schema 1 顶层配置的 `${INSTALL_DIRECTORY}` 绑定。 | 仅把已解析的 `install_directory` 传入 schema 1 的 `appConfigs`；行为应回到 070 已验收契约，不扩大变量语法或改变旧绝对路径兼容。 | 避免继续让旧 `latest` 写法成为唯一可用方式，但涉及框架路径解析回归修正和真实部署路径边界。 | 新增 schema 1 变量解析回归测试；缺少 `install_directory` 时本地失败；修复后实际集群配置使用 `${INSTALL_DIRECTORY}` 通过 `validate`/`plan`。 | 不引入新变量、不改部署执行器。 |

## Success Criteria

- 三个 App 均通过当前 schema 1 装载；没有旧 schema 字段、旧 `management.configs`、
  `management.actions` 或与内置配置/服务冲突的生命周期脚本。
- `apps/jx-server/app.yaml` 的两个版本内配置 target 均以
  `${INSTALL_DIRECTORY}/resources/` 开头。
- `jx-web` 和 `nginx` 的部署/服务语义、配置内容和放置保持不变；若因顺序整理产生 diff，
  该 diff 仅限于字段顺序。
- `apps/jx-server/application.yml` 的 Redis password 为 `${ELEPH_REDIS_PASSWORD}`，
  不再包含旧明文密码。
- `validate --cluster multipass` 成功；`plan --cluster multipass` 成功且仍包含三个 App
  对应步骤。
- 定向检查确认没有引用未声明秘密、没有重复目标路径，也没有引入顶层旧字段。
- schema 1 `${INSTALL_DIRECTORY}` 回归测试和实际集群 `validate`/`plan` 通过。
- 非目标：真实 Multipass 节点上的服务可用性、Redis 密码匹配、包下载和实际部署结果不在
  本次验证范围。

## Risks

- 运行时秘密差异：若 Redis 当前实际密码不是 `ELEPH_REDIS_PASSWORD`，替换占位符后应用连接
  Redis 会失败；这应在下一次部署前通过 Redis 配置确认。
- 版本内路径契约：新 target 要求目标父目录随包提供；当前 `resources/` 需要存在于制品版本
  目录中，否则 deploy 会在切换 `latest` 前失败关闭。
- 框架回归修复若不完整，可能影响 schema 1 App 配置的版本内发布或独立 configure 路径；
  必须用 schema 1 目标解析测试和实际集群计划验证。
- 本地验证边界：`validate`/`plan` 不能证明真实节点配置、密钥或服务可用。
