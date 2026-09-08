# 重新生成 Multipass 环境配置

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  docs/versions/v0.1/modules/deployment-framework/021-regenerate-multipass-envs/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/deployment-framework/021-regenerate-multipass-envs/proposal.md
- Affected paths: examples/eleph-server-multipass/clusters/multipass/**
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

将已生成 Multipass 集群从 schema v1 的 `environments/eleph-server/<名称>/` 手工迁移为 schema v2
的共享定义 `environments/<名称>/`，并在 `cluster.yaml.environments` 中完整声明放置关系。
由于当前集群只有一台机器，四个共享定义可整目录迁移，无需合并差异。

迁移保留 `machines.yaml`、`bootstrap.json`、`known_hosts`、SSH 密钥和已手工填写的
`apps/jx-server/app.yaml`。目标集群内的遗留 Python 字节码缓存先移动到 `.state`
隔离目录，避免直接删除造成不可恢复操作。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

这是本地生成示例集群的配置布局迁移；不改变框架公共接口，不替换 SSH 信任包，不重建 VM，
也不改变部署制品来源。降级时需要恢复完整 v1 `cluster.yaml` 和逐机器目录，不能只改版本号。

## Verification

- Targeted check: 迁移后运行 sfo-deploy `validate`，并生成 `jx-server`
  及依赖的部署计划核对依赖顺序。
- Result: pass
- Residual risk or follow-up: 实际集群保留旧 JAR 占位配置，直接 `validate` 会因制品 hash
  不合法失败； 本次以 staging 副本配合模板哨兵完成了环境布局和依赖计划验证；真实部署前仍需填写可信
  JAR 信息。
