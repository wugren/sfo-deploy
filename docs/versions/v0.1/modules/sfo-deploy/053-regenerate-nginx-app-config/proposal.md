---
task_manifest: task.yaml
status: approved
---

# Proposal：按 App v4 重新生成 Multipass nginx 配置

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 变更只重新生成示例 Multipass 集群中的 nginx App
  声明和配置源，使用已实现的 App v4 装载路径；不修改 sfo-deploy 公共
  schema、装载器、执行器或集群模板。虽然会影响部署配置/运行行为，但范围有界、回滚可用，因此不需要
  high-risk。
- Proposal and tier confirmation: 用户于 2026-09-06 确认提案并选择 standard。

## Background and Goal

`cluster-template/apps/nginx` 已迁移到 `app.yaml schema_version: 4` 的统一 `management.actions`
声明：结构化 YAML 源为 `templates/nginx.yaml`，目标为 `/etc/nginx/nginx.yaml`，不再使用已移除的
`updater`。但已生成的 `clusters/multipass/apps/nginx/app.yaml` 仍停留在 v3，声明
`/etc/nginx/nginx.conf` 和旧 `updater`，且缺少 `templates/nginx.yaml`。

目标是把生成集群中的 nginx App 配置重新生成为模板当前使用的 App v4
形态，使其通过当前框架严格校验并可在后续部署中由内置配置管理发布结构化 YAML。

## Scope

### In scope

- 将 `examples/eleph-server-multipass/clusters/multipass/apps/nginx/app.yaml` 重新生成为当前模板的
  v4 `management.actions` 声明。
- 新增生成集群 nginx App 的 `templates/nginx.yaml`。
- 移除旧 v3 声明专属且不再被引用的 `templates/nginx.conf.tpl` 与 `scripts/update-config.ts`。
- 保留 service action 的“只控制已有 unit”形态：不声明 `unit_config`，不生成 systemd
  unit，配置变化时由 service action 执行 restart。

### Out of scope / explicit non-goals

- 不运行 `prepare-multipass.sh` 或整体重建集群；避免恢复 JAR
  哨兵配置、覆盖现有机器信任和手工制品设置。
- 不生成 nginx 的 systemd unit 配置；`nginx.service` 必须已由目标机预装。
- 不修改 `cluster-template/apps/nginx/**`、sfo-deploy 源码、公共文档或测试。
- 不修改 `app_versions.yaml`、`cluster.yaml`、机器连接信息或环境定义。
- 不连接 Multipass VM、不部署 nginx，也不验证目标机上的 nginx 服务行为。

## Requirement Review

- 请求合理：这是把已确认的 App v4 规则同步到生成集群，而不是新增框架能力。
- 主要权衡：删除旧 updater 和 conf 模板会让该生成集群只能通过内置 YAML 配置管理发布 nginx
  配置；这正是新规则要求的单一声明面。
- 选定方向：只做 nginx App 资源的定向重新生成，不用全量 prepare 重置集群。

## Proposal Items

| proposal_id | change_id                       | requirement                                                                                                                                                                                                                          | boundary                                                      | tradeoff                                                | success_evidence                                                                                      | non_goal                                      |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| P-001       | CHG-regenerate-nginx-app-config | 生成集群 nginx App 使用 `schema_version: 4` 和 `management.actions`，配置源为 `templates/nginx.yaml`，目标为 `/etc/nginx/nginx.yaml`；service action 不带 `unit_config`，只控制已有 `nginx.service` 并按 `on_change: restart` 重启。 | 只修改生成集群的 nginx App 目录；不重建集群、不改框架和模板。 | 放弃旧自定义 updater，换取与当前统一 App 定义规则一致。 | 当前 CLI `validate --config-root examples/eleph-server-multipass/clusters --cluster multipass` 通过。 | 不生成 systemd unit，不远程部署或重启 nginx。 |

## Success Criteria

- 可见结果：`clusters/multipass/apps/nginx` 与模板中 v4 nginx 声明及结构化配置源一致；不再存在 v3
  `management.configs`、`management.service`、`updater` 或未被引用的 conf 模板。
- 可见结果补充：`management.actions` 中 service 条目没有 `unit_config`，只声明 systemd 控制参数。
- 必要证据：示例集群当前 CLI 严格校验通过；nginx 定向计划展开为 `check -> configure`。
- 显式非目标：不执行远程部署、不重建 Multipass VM、不修改其他 App 和环境。

## Risks

- 部署行为差异：后续 nginx 部署将从 `/etc/nginx/nginx.conf` 的旧路径切换到 `/etc/nginx/nginx.yaml`
  的结构化配置路径。这里没有旧配置迁移工具，需要由新规则的内置发布流程生效。
- 未部署验证缺口：本任务只做本地集群校验，不连接 VM；目标机实际发布和重启需后续执行 deploy 时验证。
