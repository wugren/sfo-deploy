---
task_manifest: task.yaml
status: approved
---

## Workflow Tier Judgment

- Proposed tier: `standard`
- Final user-confirmed tier: `standard`
- Final tier: standard
- Confirmation statement: 用户已在任务会话中确认本提案；提案状态为 approved，按 standard 流程执行。

建议使用 `standard`，因为请求清楚且只作用于 `examples/eleph-server-multipass/clusters/multipass`，
但它会改变本地示例集群的部署配置布局，并涉及保留 SSH 信任包和手工应用制品配置的兼容边界；
不是纯文档修改，也不足以触发 high-risk。

## Background and Goal

当前生成的 Multipass 集群仍是旧版 cluster schema v1：`cluster.yaml` 没有
`cluster.yaml.environments`，环境定义存放在 `environments/eleph-server/<名称>/`。 新的规则要求
schema v2 使用共享定义 `environments/<名称>/environment.yaml`，并用 `cluster.yaml.environments`
显式声明每台机器的放置关系。

目标是在不重建 Multipass VM、不更换 SSH key、不覆盖 host key 信任和当前 JAR 制品配置的前提下，
把已生成集群同步到当前模板的 v2 环境布局。

## Scope

### In scope

- 将 `cluster.yaml` 升级为 `schema_version: 2`，加入四个共享 Environment 的放置映射。
- 将 `jre`、`jx-runtime`、`mysql`、`redis` 的定义、脚本和模板从旧目录
  `environments/eleph-server/<名称>/` 同步为新的共享定义目录 `environments/<名称>/`。
- 从 `cluster-template` 刷新对应的 TypeScript 环境和应用脚本资源。
- 删除目标集群中的旧 v1 Environment 目录和遗留 `__pycache__` 内容。
- 保留 `machines.yaml`、`bootstrap.json`、`known_hosts` 和 `secrets/id_ed25519*`。
- 保留当前 `apps/jx-server/app.yaml` 中的手工 JAR provider/source/hash 配置。

### Out of scope / Non-goals

- 不运行 `prepare-multipass.ps1` 或 `prepare-multipass.sh`，不创建/删除 Multipass VM。
- 不重新生成或替换 SSH key、`known_hosts`、`bootstrap.json` 或 `machines.yaml`。
- 不覆盖当前手工完成的 `apps/jx-server/app.yaml` 制品配置。
- 不修改框架源码、模板自身、README 或 Harness 规则。
- 不执行真实部署；只做集群配置验证和规划验证。

## Requirement Review

请求合理：仓库文档明确说明 schema v1 仍只读兼容，但不会自动迁移； schema v2
只读取共享定义目录并拒绝旧布局。当前集群确实落后于 `cluster-template`，需要手工或重新 prepare
才能进入新规则支持的形态。

相比完整重新 prepare，直接按模板重建配置能保留本地 VM 信任包和已填写的 JAR 制品信息；
这是更小且有明确回滚路径的方案。

## Proposal Items

| proposal_id | change_id               | requirement                                                 | success_evidence                                                   |
| ----------- | ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| PI-1        | CHG-multipass-v2-layout | 将生成集群升级为 schema v2 共享定义布局，四个环境与模板一致 | staging 上 `validate` 成功；`diff -qr` 显示环境目录与模板为空差异  |
| PI-2        | CHG-multipass-v2-layout | 保护 SSH 信任包和应用制品配置，移除旧 v1 布局与缓存残留     | 保留文件哈希前后一致；目标目录不再存在 `environments/eleph-server` |

## Success Criteria

1. `examples/eleph-server-multipass/clusters/multipass/cluster.yaml` 使用 `schema_version: 2`。
2. 四个共享定义位于 `environments/jre`、`environments/jx-runtime`、`environments/mysql`、
   `environments/redis`，且与当前模板内容一致。
3. `cluster.yaml.environments` 将四个环境完整放置到 `eleph-server`。
4. `cluster.yaml` 不再包含旧版布局目录；加载器能成功读取集群。
5. 对 `jx-server` 及其依赖生成的部署计划仍按依赖顺序包含环境与应用步骤。
6. `machines.yaml`、`bootstrap.json`、`known_hosts`、`secrets/id_ed25519*` 和手工 JAR 配置不变。

## Risks

- 如果应用配置实际包含除 JAR provider/source/hash 以外的手工定制，直接保留当前 `app.yaml`
  是最安全做法，但不会同步模板中的哨兵语法变化。
- `clusters/` 被 git 忽略， Harness 变更清单需要特别处理目标路径，否则可能看不到集群配置变化。
- 降级到 v1 不能只改回版本号，必须恢复完整的旧 `cluster.yaml` 和逐机器目录布局。
