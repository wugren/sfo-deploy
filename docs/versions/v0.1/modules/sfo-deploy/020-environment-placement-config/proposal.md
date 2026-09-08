---
task_manifest: task.yaml
status: approved
---

# Environment 集中放置配置提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries:
  - `cluster.yaml` 是用户直接维护的公开部署配置；新增版本并改变 Environment 放置与目录语义，触发配置
    schema、公开文件格式与迁移边界。
  - 配置装载结果会改变 `ClusterConfig` 中 Environment
    定义、实例和放置关系，并影响规划、过滤、依赖校验与发布快照的兼容性判断。
  - 需要同时验证旧 v1 集群、新 v2 集群、示例生成物和历史回退，命中
    contract-protocol、data-schema、build-config-deployment 与 runtime-integration 风险。
- Proposal and tier confirmation: 已确认；用户启动语句为“确认，自动完成”，确认本提案与 high-risk
  层级，并授权从 design 开始自动完成实现、测试和验收，不需要逐阶段再次确认。

## Background and Goal

当前 Environment 使用
`environments/<机器名>/<环境名>/environment.yaml`，目录层级同时承担定义和机器放置，导致同一种环境部署到多台机器时需要重复定义、脚本和模板。App
已采用更清晰的两层模型：资源目录定义“如何部署”，`cluster.yaml.apps` 定义“部署到哪里”。

目标是让 Environment 采用相同模型：`environments/<环境名>/environment.yaml`
集中定义安装、配置和生命周期行为，`cluster.yaml.environments` 明确列出每个环境所在的机器。

## Scope

### In scope

- 为 `cluster.yaml` 增加 schema v2；v2 同时要求完整的 `environments` 与 `apps` 放置映射。
- v2 Environment 定义目录调整为 `environments/<环境名>/environment.yaml`，同目录继续承载
  `scripts/`、`templates/` 等资源。
- `cluster.yaml.environments` 使用与 `apps` 一致的 `环境名: [机器名, ...]`
  结构；每个定义必须恰好出现一次、至少放置到一台已声明机器，列表中禁止重复机器。
- 从 Environment 放置映射生成每台机器的环境实例，保持环境/App
  依赖、生命周期动作、机器/App/Environment CLI 过滤和确定性计划顺序。
- 保留 v1 旧布局的装载兼容；文档、测试夹具和 multipass 示例迁移到 v2，框架不自动改写用户文件。
- 验证发布计划快照和 rollback 不依赖当前 Environment 目录布局，既有受支持快照继续可读、可校验。

### Out of scope

- 不在 v2 放置映射中增加逐机器参数覆盖；`environment.yaml` 中的 version、parameters、defaults
  与权限对其全部目标机器一致。
- 不改变 App 放置格式、生命周期动作集合、包下载、SSH、秘密和模板投递机制。
- 不自动迁移或删除现有 v1 集群，也不提供批量配置改写命令。
- 不改变 `machines.yaml`、`app.yaml`、`environment.yaml` 各自现有的 schema_version 1；只有
  `cluster.yaml` 用 v2 选择新布局。

### Boundary with neighboring modules

- `machines.yaml` 继续只负责机器身份与连接信息。
- `environment.yaml` 继续负责 Environment 的安装、配置、依赖、脚本、模板和秘密声明。
- `app.yaml depends_on` 的短名称继续表示 App 所在机器上的同名 Environment；显式 `机器名/环境名`
  继续表示跨机器依赖。
- 历史发布执行使用归档计划，不从当前 `cluster.yaml` 或 Environment 目录重新构造步骤。

## Requirement Review

要求合理。App 与 Environment 使用一致的“共享定义 + 集中放置”模型后，可以从 `cluster.yaml`
一处查看整套集群资源分布，并避免多台机器重复维护同一环境脚本。

选定方向是版本化兼容迁移：新布局由 `cluster.yaml schema_version: 2` 显式启用，现有 v1
配置继续按原语义装载。这样不会把两套目录规则模糊地混在同一个 schema
版本中，也避免升级工具后立即破坏现有集群。代价是装载器需要保留清晰隔离的 v1/v2 分支；v2
暂不支持逐机器参数覆盖，存在机器差异时应拆成不同 Environment 定义。

v2 示例：

```yaml
schema_version: 2
name: production
executor_region: cn-east
environments:
  deno: [node-01, node-02]
  postgresql: [node-01]
apps:
  backend: [node-01]
  frontend: [node-02]
```

对应定义目录为
`environments/deno/environment.yaml`、`environments/postgresql/environment.yaml`；由此可直接得出
node-01 安装 deno、postgresql，node-02 安装 deno。

## Proposal Items

| proposal_id | change_id                        | requirement                                                                                    | boundary                                                                                  | tradeoff                             | success_evidence                                      | non_goal                            |
| ----------- | -------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------- | ----------------------------------- |
| P-001       | CHG-environment-placement-config | 新增 `cluster.yaml` schema v2，以完整 `environments` 映射声明 Environment 到机器列表的放置关系 | 每个 Environment 定义必须映射且至少一台目标机器；拒绝未知定义、未知机器、空列表和重复目标 | 新增一个集群文件版本                 | 配置正反例测试证明 v2 映射严格、确定                  | 不提供逐机器参数覆盖                |
| P-002       | CHG-environment-placement-config | v2 从 `environments/<环境名>/environment.yaml` 读取一次共享定义，再按放置映射生成每机实例      | 目录名与声明 name 必须一致；脚本和模板仍相对此目录解析                                    | 同一环境在所有目标机器使用同一份配置 | 多机规划产生正确的环境步骤、依赖和资源路径            | 不改变 Environment 生命周期脚本协议 |
| P-003       | CHG-environment-placement-config | 保留 v1 `environments/<机器>/<环境>/` 读取兼容，并让错误信息明确区分版本和布局                 | v1 不接受 v2 字段，v2 不回退扫描 v1 目录                                                  | 暂时维护两个隔离装载分支             | v1 回归测试、新旧混用负例和 v2 测试通过               | 不自动改写 v1 文件                  |
| P-004       | CHG-environment-placement-config | 保持 App/Environment 依赖、过滤、计划顺序以及历史快照/rollback 兼容边界                        | 短依赖必须在 App/Environment 所在机器有对应放置；跨机器依赖按显式名称解析                 | 放置校验更严格                       | 单元、DV 与历史回归覆盖同机、跨机、缺失依赖及旧快照   | 不改变发布快照 schema               |
| P-005       | CHG-environment-placement-config | README、配置指南、测试夹具与 multipass 示例切换到 v2 集中放置模型                              | 示例和文档必须与严格装载器一致                                                            | 示例目录发生迁移                     | 类型检查、任务测试、示例 validate/plan 与文档契约通过 | 不新增迁移 CLI                      |

## Success Criteria

- Concrete user-visible or system-visible result: 用户只需在 `environments/<环境名>/`
  定义一次环境，并在 `cluster.yaml.environments` 中配置目标机器；`plan`
  对每个映射目标生成对应环境步骤，App 依赖仍正确闭合。
- Required evidence: v2 单机/多机配置装载与计划测试；未知/缺失/重复/空放置和混用布局负例；v1
  配置回归；App 同机与显式跨机依赖；历史计划快照/rollback 回归；Deno 类型检查；multipass 示例
  validate/plan；独立缺陷发现验收。
- Explicit non-goals: 不增加逐机器 overrides，不自动迁移用户配置，不改变部署脚本协议、SSH
  或秘密管理。

## Risks

- 配置契约：`cluster.yaml` v2 是新的公开文件格式，必须严格拒绝缺失或多余放置，且不能按目录猜测版本。
- 迁移：现有 v1 配置保持可用，但复制 Environment 到多机的用户需要手工合并定义并填写 v2
  映射；降级到不认识 v2 的旧版本时无法读取新集群。
- 依赖：共享定义被放置到多机后，短名称依赖必须逐目标机器验证，避免生成计划外依赖或错误跨机绑定。
- 参数差异：共享定义不提供逐机器覆盖；具有不同参数或版本的机器需使用不同 Environment
  名称，这是本次有意边界。
- 历史/回退：不能让当前目录布局变化污染已归档执行计划；需用现有多版本快照测试确认兼容。
- 工作树：仓库当前存在上一轮 Python→Deno
  迁移留下的大量已修改、删除和未跟踪文件；实施必须基于并保留这些现有内容，不得覆盖或清理用户改动。
