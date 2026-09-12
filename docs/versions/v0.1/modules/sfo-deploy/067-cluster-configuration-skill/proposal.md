---
task_manifest: task.yaml
status: approved
---

# sfo-deploy 集群配置 Skill 提案

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- 层级理由：新增单模块的可复用技能，包含三类配置编写流程及配套示例，范围超过局部文案修改；不改变部署框架运行时、配置协议或生产默认行为，无已确认的 high-risk 触发条件。
- 提案及层级确认：用户于 2026-09-08 回复“确认”，批准本提案及 standard 层级。

## Background and Goal

创建一个定义 sfo-deploy 集群的中文 skill，使代理能够生成集群配置项目，并在已有项目中添加 environment 配置和 app，输出符合当前框架校验规则的配置。

## Scope

- 在 skills/sfo-deploy-cluster/ 保存可版本管理的技能源，并安装到默认 Codex skills 目录，使后续会话可以发现；若目标已有同名技能，先比较并保留无关用户内容。
- 提供 SKILL.md、必要的配置参考和可复用模板；仅在可靠复用需要时增加生成脚本。
- 初始化项目：集群目录、cluster.yaml、machines.yaml、环境及应用目录、按需的 app_versions.yaml、忽略本地秘密与运行产物的规则。
- 添加 environment：共享 environment.yaml 定义、必要的自包含 Deno 生命周期脚本、放置映射、依赖关系和配置资源。
- 添加 app：当前推荐的 schema v4 定义、版本/包映射、机器放置、可选环境依赖、配置模板和服务管理；按需求区分带包应用与无包配置应用。
- 配置约定以 src/config.ts、src/types.ts 和实际 CLI 为准，参考现有示例；不照搬过时指南。
- 边界：本任务交付配置生成技能，不实际创建用户生产集群、不连接 SSH 节点、不执行安装或部署，也不修改现有产品代码及真实配置。

## Requirement Review

- 需求合理，初始化及增量添加容易遗漏关联映射，适合通过技能维护这些约束。
- 技能应可独立使用，携带必要的配置知识和示例，不依赖当前工作区的绝对路径。
- 模板明确区分占位值与实际部署输入，不编造可用制品哈希或写入真实秘密；生成配置与实际部署的授权分开。
- 默认支持自动发现及显式调用 $sfo-deploy-cluster。
- 待澄清问题：无。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-cluster-configuration-skill | 生成集群配置项目 | 使用当前框架 schema | 提供必要模板与配置参考 | 临时目录产物通过本地 validate 和 plan | 不执行真实部署 |
| P-002 | CHG-cluster-configuration-skill | 添加 environment 配置并同步放置与依赖 | 采用共享环境目录 | 保留已有配置和用户脚本 | 增量添加后的本地配置校验及规划成功 | 不自动安装远端环境 |
| P-003 | CHG-cluster-configuration-skill | 添加 app 并同步版本及放置映射 | 支持当前应用配置模型 | 按应用实际需求选择包和管理动作 | 增量添加后的本地配置校验及规划成功 | 不修改运行时协议 |

## Success Criteria

- 技能可被发现和显式调用，中文说明覆盖初始化、添加 environment、添加 app 三类请求。
- 技能结构通过 skill-creator 的 quick_validate.py；引用资源存在，新增脚本实际运行验证。
- 在隔离临时目录验证三类流程的输出，使用本仓库 CLI 执行本地 validate / plan，确认映射闭合和已有配置保留；验证不访问真实节点。
- 完成 standard 变更记录与独立缺陷检查后的 completion-report.md。
- 非目标：实际发布、远端软件安装、现有指南全面更新、生成新的部署框架或引入其他集群平台。

## Risks

- 指南和当前 App schema 有差异，须以源码和本地验证确定模板字段。
- 环境脚本和服务命令与业务相关，技能必须根据用户需求填写，不以空成功脚本伪装完成实际安装能力。
- 带包应用的版本、制品地址及哈希须来自用户或可信产物，本地验证使用可控测试数据。
