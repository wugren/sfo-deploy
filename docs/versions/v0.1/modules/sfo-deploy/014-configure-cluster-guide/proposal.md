---
task_manifest: task.yaml
status: approved
---

# 使用 sfo-deploy 配置集群的文档提案

Risk profile: not-created（仅在确认使用 high-risk 层级后替换为 `./risk-profile.yaml`）

## Workflow Tier Judgment

- Proposed tier: trivial
- Final tier: trivial
- Tier rationale / triggered boundaries:
  - 本次只新增一篇面向使用者的集群配置指南，并在现有 `README.md` 中增加入口；不修改配置 schema、CLI
    行为、部署执行逻辑或安全边界。
  - 影响集中于 `sfo-deploy`
    单模块的文档，可通过对照当前配置加载器、命令行实现和测试契约进行定向核验。
  - 未发现公共契约、持久化数据、安全、运行时、构建、发布/部署默认行为、兼容回退、跨项目或架构边界的实质变化，因此建议使用
    `trivial`。
- Proposal and tier confirmation: 用户已确认按本提案执行，最终层级为 `trivial`。

## Background and Goal

当前 `README.md` 已提供集群目录、少量 YAML
与命令示例，但缺少一条从创建目录到校验、规划、安装环境、配置与部署 App
的完整操作路径，也没有集中解释主要字段、筛选规则、密钥边界和常见错误。

目标是生成一篇中文操作指南，使使用者能够依据当前实现独立创建一个可校验的 sfo-deploy
集群配置，并按安全、可复核的顺序执行首次部署。

## Scope

### In scope

- 新增 `docs/guides/sfo-deploy-cluster-configuration.md`，提供从零配置集群的完整流程。
- 说明目录布局以及 `cluster.yaml`、`machines.yaml`、环境 `environment.yaml`、App `app.yaml`
  的字段和相互关系。
- 提供生命周期 Python 脚本、模板、`config_secrets`、`file_secrets`、HTTPS/filehub
  包来源的可复制示例。
- 说明 `validate`、`plan`、`check`、`install`、`configure`、`deploy`
  的推荐执行顺序、选择器与关键安全注意事项。
- 加入故障排查和上线前检查清单，并在 `README.md` 增加指南链接。

### Out of scope

- 不修改任何 Python 实现、YAML schema、CLI 参数或执行行为。
- 不为特定云厂商、操作系统、业务应用或秘密管理系统给出专属部署方案。
- 不承诺当前实现未提供的并行执行、自动回滚数据库、凭据存储/轮换或高可用编排能力。
- 不复制整套示例项目或新增可执行集群配置。

### Boundary with neighboring modules

- 文档仅描述当前 `sfo-deploy` 公共能力；`examples/eleph-server-multipass/`
  仅作为核对现有模式的参考，不纳入修改范围。
- 现有未提交实现和未完成任务均视为用户工作，不在本任务中整理或改写。

## Requirement Review

需求合理。相比继续扩充根
`README.md`，单独的指南更适合承载端到端步骤、完整配置片段和排错内容，也能保持首页简洁。指南将以当前代码和测试为事实来源，并在
README 提供清晰入口，避免形成与实现脱节的第二套规范。

主要取舍是示例完整度与维护成本：文档会给出一套最小但连贯的示例，同时把字段约束和易错点写清楚；不会枚举每种基础设施组合，也不会将示例包装成未经验证的生产模板。

## Proposal Items

| proposal_id | change_id                   | requirement                                                                   | boundary                           | tradeoff                                       | success_evidence                                                     | non_goal                             |
| ----------- | --------------------------- | ----------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| P-001       | CHG-configure-cluster-guide | 新增中文端到端指南，覆盖目录创建、四类 YAML/脚本/模板配置、校验规划和首次部署 | 内容必须与当前实现和测试契约一致   | 采用一套连贯最小示例，避免罗列所有基础设施变体 | 逐项对照配置加载器、CLI 与契约测试，文档中的路径、字段和命令均可追溯 | 不新增或改变运行时能力               |
| P-002       | CHG-configure-cluster-guide | 解释密钥、包下载、目标筛选、依赖和发布回退的操作边界与常见故障                | 只说明 sfo-deploy 已实现的边界     | 增加必要安全说明，但不扩展为通用运维手册       | 指南明确禁止在 YAML 写入凭据，并与 README/实现一致                   | 不替代秘密管理、备份恢复或云平台文档 |
| P-003       | CHG-configure-cluster-guide | 在 README 增加新指南入口                                                      | 仅增加导航，不重写 README 现有说明 | 保持首页简洁                                   | 链接目标存在且 Markdown 链接有效                                     | 不重组现有 README                    |

## Success Criteria

- Concrete user-visible or system-visible result: 使用者从 README
  能进入一篇完整中文指南，并按指南创建自包含集群目录、通过 `validate`/`plan` 检查配置，再执行环境与
  App 生命周期动作。
- Required evidence:
  文档结构和链接检查通过；所有示例字段、动作、选择器、退出码与安全边界均与当前代码、测试及 README
  契约一致；完成一次独立的文档缺陷发现检查。
- Explicit non-goals: 不修改产品行为，不提供厂商专属方案，不声称示例已达到生产高可用或灾备标准。

## Risks

- 文档漂移：当前工作区已有未提交实现，指南必须以实际代码和测试为准，不能只复述旧 README。
- 示例误用：示例会明确使用占位地址、哈希和路径，并提示部署前替换和先运行 `validate`/`plan`。
- 安全误解：指南必须明确 YAML 不保存秘密值、`file_secrets`/`config_secrets`
  的职责边界，以及回退不会撤销数据库或外部副作用。
