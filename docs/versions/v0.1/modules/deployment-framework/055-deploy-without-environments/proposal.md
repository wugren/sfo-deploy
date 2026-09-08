---
task_manifest: task.yaml
status: approved
---

# deployment-framework Proposal：deploy 只处理 App

Risk profile: not-created

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 这是部署 CLI 的公共行为变更，会影响 `deploy`/`plan`
  的执行计划和用户脚本兼容性，但范围集中在一个规划与入口模块，可通过现有单元、集成和契约测试验证；没有引入持久化数据迁移、安全边界或依赖图变更，因此不建议升级为
  high-risk。
- Proposal and tier confirmation: 用户已确认按本提案执行，并确认 tier 为 standard。

## Background and Goal

当前不带过滤器的 `sfo-deploy deploy` 会把 `cluster.yaml.environments`
放置映射中的环境也纳入部署计划，并将环境展开为 `check -> install -> configure?`。这会让 App
发布命令意外执行系统环境安装。

目标是让 `deploy` 的职责只覆盖 App 部署；环境生命周期由 `prepare` 显式负责。

## Scope

### In scope

- `deploy` 执行计划只包含 App 步骤，不再生成 environment 的 `check`、`install` 或 `configure` 步骤。
- `plan` 预览 deploy 时遵循同样语义。
- `deploy` 拒绝 `--environment`，避免用户误以为仍可部署环境。
- `deploy` 拒绝 `--with-dependencies`，因为该开关在“只处理 App”语义下没有可展开的环境依赖动作。
- 同步 README 和集群配置指南中的命令语义。

### Out of scope

- 不改变 `prepare` 的环境部署语义；`prepare` 仍执行环境生命周期。
- 不改变 `check`、`install`、`configure`、`start`、`stop`、`restart` 的既有环境/App 动作支持。
- 不自动安装或检查 App 依赖环境。
- 不修改 App 依赖声明 schema；`depends_on` 仍用于配置校验和历史/架构语义，但 deploy
  不再把它展开为环境步骤。

### Boundary with neighboring modules

- 环境准备入口继续属于 `prepare`。
- 发布历史和 rollback 不在本次范围内；新 deploy 快照自然只包含 App 步骤，旧快照仍按其归档内容回放。

## Requirement Review

该请求合理：App 发布与环境准备分开可以让 `deploy`
成为更可预期的应用发布操作。主要权衡是首次部署或依赖漂移时，用户必须先运行 `prepare`；否则 App
部署可能在远端因缺少运行时或服务而失败。这个失败面通过文档明确“deploy 前先 prepare”来缓解。

方向：让 deploy 只生成 App 计划，并在 CLI 校验期拒绝环境相关开关；不采用“保留环境
check”的折中方案，因为用户明确要求 deploy 不包含 environment 部署。

## Proposal Items

| proposal_id | change_id            | requirement                                                             | boundary                                      | tradeoff                       | success_evidence                                 | non_goal                         |
| ----------- | -------------------- | ----------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ | ------------------------------------------------ | -------------------------------- |
| P-001       | CHG-deploy-apps-only | `deploy` 只规划并执行 App 步骤                                          | 不包含 environment 步骤；不安装或检查依赖环境 | 首次部署前必须显式执行 prepare | 规划和执行测试显示 deploy plan 只含 `app:*` 步骤 | 不修改 prepare                   |
| P-002       | CHG-deploy-apps-only | `deploy --environment` 和 `deploy --with-dependencies` 在配置校验期失败 | 提供明确的中文错误信息；不建立 SSH 连接       | 少量调用脚本的兼容性变化       | CLI 校验测试覆盖拒绝路径和退出码                 | 不改变其他动作对这两个开关的支持 |
| P-003       | CHG-deploy-apps-only | 文档说明 deploy 只负责 App，环境准备使用 prepare                        | 同步 README 和集群配置指南                    | 文档需覆盖新失败边界           | 文档检查/契约测试通过                            | 不新增教程                       |

## Success Criteria

- 用户可见结果：`sfo-deploy deploy --cluster multipass ...` 的确认计划只列出 App 步骤，不再列出
  `environment:eleph-server/jre/mysql/redis`。
- 必需证据：针对 `buildPlan` 的单元/集成测试确认 deploy 无 environment 节点；CLI 校验测试确认
  `--environment` 和 `--with-dependencies` 被拒绝；相关契约或帮助输出检查通过。
- 明确非目标：不把环境动作移动到 deploy，也不自动隐式执行 prepare。

## Risks

- 兼容性风险：已有自动化脚本若依赖
  `deploy --environment`、`deploy --with-dependencies`，升级后会收到配置错误。
- 运行顺序风险：用户忘记先执行 `prepare` 时，App 部署可能因缺少依赖环境而失败；错误可能出现在远端
  App 部署阶段而不是 deploy 预检。
- 文档一致性风险：旧文档可能仍暗示 deploy 会处理依赖环境，需要同步更新。
