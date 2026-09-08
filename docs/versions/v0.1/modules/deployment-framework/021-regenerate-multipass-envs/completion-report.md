# Completion Report: 重新生成 Multipass 环境配置

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/021-regenerate-multipass-envs.md
- 对象：将 `examples/eleph-server-multipass/clusters/multipass` 从 schema v1 逐机器环境布局迁移到
  schema v2 共享定义布局，同时保留 SSH 信任包和应用制品配置。

## Delivery Summary

- Outcome: 完成生成集群的环境布局迁移：`jre`、`jx-runtime`、`mysql`、`redis` 全部改为
  `environments/环境名/` 共享定义，`cluster.yaml` 升级为 `schema_version: 2` 且 `environments`
  映射完整；旧 `environments/eleph-server/` 布局和遗留 Python 缓存已移出目标集群到 `.state`
  隔离目录，SSH 信任文件与应用配置哈希无变化。
- Handoff: 用户可在 `examples/eleph-server-multipass/clusters/multipass` 下继续使用
  `deno task eleph-deploy`；部署前只需按 README 填写可信 JAR 信息，并确认 `.state`
  中隔离缓存可清理。

## Proposal Consistency

| change_id               | requirement_or_boundary                                 | proposal_source  | delivery_evidence                                                                            | finding | status |
| ----------------------- | ------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- | ------- | ------ |
| CHG-multipass-v2-layout | 将生成集群升级为 schema v2 共享定义布局                 | proposal.md:P1-1 | `cluster.yaml` 已改为 `schema_version: 2` 并含四个 environment 放置；staging `validate` 成功 | 无偏差  | pass   |
| CHG-multipass-v2-layout | 保护 SSH 信任包和应用制品配置，移除旧 v1 布局与缓存残留 | proposal.md:PI-2 | 六个保留文件哈希与迁移前一致；目标目录无 `environments/eleph-server`                         | 无偏差  | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                        | adversarial_check                                                                          | finding_or_not_applicable_reason                                                                              | status |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | 检查 `cluster.yaml`、四个 `environment.yaml`、脚本路径和模板资源，并对照 `cluster-template` 做 `diff -qr` | 在 staging 副本中使用模板哨兵运行 `validate` 和 `plan --app jx-server --with-dependencies` | 未发现环境定义、脚本引用、依赖顺序或放置映射逻辑缺陷                                                          | pass   |
| boundaries-and-failure-paths | 检查 schema v2 加载器对 `environments/机器名/` 旧布局的拒绝路径，并检查目标目录残留                       | 试图在真实集群直接运行 `validate`，并确认旧布局目录已被移除、空目录不存在                  | 直接 `validate` 被遗留 JAR 占位拦截，但这是制品配置边界，不属于本次环境迁移；staging 验证证明 v2 布局可被加载 | pass   |
| regression-and-side-effects  | 对比迁移前后 `machines.yaml`、`bootstrap.json`、`known_hosts`、SSH 密钥和应用配置哈希                     | 用 `sha256sum --check` 前后比对，并检查隔离缓存未影响环境资源                              | 保留文件哈希完全一致，未发现信任包、VM 状态或应用配置回归                                                     | pass   |

## Verification

- Targeted check: 在 `.state` staging 副本中替换旧 JAR 占位为模板哨兵后运行
  `deno run --allow-read src/cli.ts validate --config-root 缓存目录 --cluster multipass` 与
  `plan --app jx-server --with-dependencies`
- Result: pass
- Exception reason: 不适用；验证已执行并通过。

## Findings

| id | severity | evidence                                                                          | problem                                                                                      | blocking |
| -- | -------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| F1 | low      | 在真实集群运行 `validate` 返回 app[jx-server].package.hash.value 长度或格式不合法 | 现有 `apps/jx-server/app.yaml` 仍是旧版 JAR 占位，真实集群在补全可信制品信息前无法验证或部署 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 批准范围内已完成 schema v2
  环境布局迁移，依赖计划验证通过，信任包和应用配置保持不变；遗留占位是既有制品配置问题，记录为非阻塞后续项。
