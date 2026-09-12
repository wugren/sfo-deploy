---
task_manifest: task.yaml
status: approved
---

# Proposal：App 配置目录变量拆分为安装根、版本目录和 latest 目录

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 这是 App 配置公开契约变更，改变现有
  `${INSTALL_DIRECTORY}` 的语义，影响受管配置写入路径、版本化部署与独立
  configure 行为。路径解析错误可能导致服务读到错误配置，因此建议 high-risk。
- Proposal and tier confirmation: 用户于 2026-09-11 确认显示的提案并选择
  `high-risk`；授权完整设计、实现、测试、独立验收与收尾。

## Background and Goal

070 引入的 `${INSTALL_DIRECTORY}` 虽然绑定 `app.yaml.install_directory`，但受管配置
target 会继续追加 `latest/`，最终写入当前或待部署版本目录。这个名称与用户直觉
不一致：它听起来是安装根目录，实际是版本内目录。

目标是把目录语义拆清楚：

- `${INSTALL_DIRECTORY}`：精确表示 `app.yaml.install_directory` 声明的 App 安装根。
- `${CURRENT_VERSION_DIRECTORY}`：当前动作定位的版本目录；内置 deploy 阶段是待部署
  候选版本目录，独立 configure 阶段是当前 latest 指向的版本目录。
- `${LATEST_DIRECTORY}`：`<install_directory>/latest` 软链路径。

## Scope

### In scope

- 调整 managed config `target` 的内置目录变量解析契约：
  - `${INSTALL_DIRECTORY}/...` 展开为 `<install_directory>/...`；
  - `${CURRENT_VERSION_DIRECTORY}/...` 展开为版本目录；
  - `${LATEST_DIRECTORY}/...` 展开为 `<install_directory>/latest/...`。
- 三个变量都必须位于 target 开头、只出现一次，后续必须是规范相对路径，且 App 已声明
  `install_directory`。
- 内置 deploy 的待发布版本目录重定位、路径边界检查、重复 target 检查和发布权限语义保持不变。
- 更新类型/装载实现、单元与版本化部署测试、README、配置指南、模块契约、示例配置和
  `sfo-deploy-cluster` 技能文档。
- 迁移仓库内使用旧 `${INSTALL_DIRECTORY}` 版本目录语义的示例配置。

### Out of scope / explicit non-goals

- 不提供旧语义兼容别名；`${INSTALL_DIRECTORY}` 不能同时表示安装根和版本目录。
- 不做任意 shell 展开，不把目录变量注入服务环境变量。
- 不支持变量出现在 target 中间、多次出现，或作为裸值（target 仍必须是文件路径）。
- 不改变 `app.yaml.install_directory` 的校验规则、版本布局或 latest 切换时机。
- 不执行真实远端部署。

## Requirement Review

请求合理：现有命名确实让“安装根”和“版本目录”混用，容易写出错误的持久化位置。
建议采用用户给出的 `${CURRENT_VERSION_DIRECTORY}` 与 `${LATEST_DIRECTORY}`，并纠正
`${INSTALL_DIRECTORY}` 为字面安装根。这里不使用 `${ACTIVE_VERSION_DIRECTORY}` 之类
替代名，因为 `current` 已经能表达“当前动作操作的版本”，且与用户请求一致。

主要取舍：语义修正是 breaking change。旧示例和用户配置中 `${INSTALL_DIRECTORY}` 的
版本内路径必须迁移到 `${CURRENT_VERSION_DIRECTORY}`。不保留别名可以避免同名变量根据
部署阶段产生歧义。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-app-directory-variable-contract | managed config target 支持三个目录变量并纠正 `INSTALL_DIRECTORY` 语义。 | 仅限 target 开头的单次路径前缀；缺声明或非法相对路径本地失败。 | 修正语义但属于 breaking change。 | 装载测试覆盖三个变量、deploy/configure 解析差异、非法写法和缺失声明。 | 不做 shell 环境注入或别名兼容。 |
| P-002 | CHG-app-directory-variable-contract | 文档与示例迁移到新目录变量。 | 只更新与契约直接相关的文档、模块契约、示例和技能说明。 | 现有用户配置需要自行迁移。 | 文档契约断言和示例 validate/plan 通过。 | 不迁移仓库外用户配置。 |

## Success Criteria

- 用户可以声明：
  - `target: '${CURRENT_VERSION_DIRECTORY}/resources/app.yml'` 写入本次部署或当前配置
    对应的版本目录；
  - `target: '${LATEST_DIRECTORY}/resources/app.yml'` 明确基于 latest 路径；
  - `target: '${INSTALL_DIRECTORY}/shared/app.yml'` 写入安装根下的路径。
- `INSTALL_DIRECTORY` 不再自动追加 `latest/`；`CURRENT_VERSION_DIRECTORY` 在 deploy 时
  解析为候选版本目录，在独立 configure 时解析为当前版本目录。
- 所有路径仍受既有绝对路径、规范路径、发布根和重复 target 检查约束。
- 针对性配置装载测试、版本化部署路径测试、示例 validate/plan、文档契约检查和全量测试通过。

## Risks

- 旧 `${INSTALL_DIRECTORY}` 用法若未迁移，会从版本内路径变为安装根路径，可能覆盖或
  读取错误位置；必须在装载错误信息、文档和仓库示例中明确迁移。
- `${LATEST_DIRECTORY}` 在 deploy 阶段如果不做版本重定位，会天然写入 latest 当前指向；
  这是有意语义，但文档必须提醒与 `${CURRENT_VERSION_DIRECTORY}` 的差异。
- 工作区存在大量未完成任务的本地改动，本任务提交/收尾只关注本提案直接相关路径。
- Risk profile: ./risk-profile.yaml
