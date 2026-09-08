task_manifest: task.yaml
status: approved

## Workflow Tier Judgment

- Proposed tier: standard
- Final user-confirmed tier: standard
- Final tier: standard
- Rationale: 新增 Nginx 环境会改变示例集群的部署准备面和远端软件安装行为，并需要同步模板、生成集群和文档；影响边界清楚且是单项目可回退配置变更，因此不使用 trivial，但也不需要 high-risk 的完整设计、独立测试与验收生命周期。
- Confirmation statement: 用户已回复“确认”，批准显示的 proposal 和 standard 层级；提案中无未解决问题。

## Background and Goal

用户执行 `sfo-deploy deploy --cluster multipass` 时，nginx App 的 `check` 因目标机缺少 `/usr/sbin/nginx` 而失败。当前示例明确把 Nginx 建模为 packageless App：它只检查、配置和控制 systemd 服务，不安装软件。为保持该职责边界，安装能力应放在 environments 中，通过既有的 `prepare` 流程完成。

目标是新增一个 `nginx` 环境应用，使用 Ubuntu APT 安装 Nginx，使目标机可以在部署 nginx App 前通过 `sfo-deploy prepare --cluster multipass --env nginx` 完成预装。

## Scope

- In-scope:
  - 在 `cluster-template/environments/nginx/` 新增 `environment.yaml`、`scripts/check.ts` 和 `scripts/install.ts`。
  - 在 `clusters/multipass/environments/nginx/` 同步相同环境，避免用户必须重跑 Multipass prepare 才能使用本次修复。
  - 将 `nginx: [eleph-server]` 加入模板和生成集群的 `cluster.yaml.environments`。
  - 更新示例 README，说明先准备 nginx 环境，再部署 nginx App。
- Out-of-scope:
  - 不修改现有 nginx App 的 `check`、配置模板或 systemd 管理行为。
  - 不让 `deploy` 自动安装环境依赖；继续遵循当前 `deploy` 只处理 App、环境由 `prepare` 负责的边界。
  - 不初始化站点配置、不配置 TLS、不改监听端口、不做版本锁定或 APT 源替换。
- Neighboring boundary: 新环境名称与现有 nginx App 名称相同是刻意对应的运维名称；两者职责不同，不建立依赖声明。

## Requirement Review

请求合理：独立环境安装符合 jre、mysql、redis 的现有模式，也能避免 packageless App 重新承担包管理职责。主要权衡是不把 nginx 依赖写入 nginx App 的 `depends_on`。当前 `deploy` 被设计为只处理 App，因此加依赖不会让 deploy 自动安装，只会引入名称对应和维护成本。选择保持分离，并让用户先运行 `prepare --env nginx`。

## Proposal Items

| proposal_id | change_id | requirement | success_evidence |
| --- | --- | --- | --- |
| P-1 | CHG-add-nginx-environment | 提供 `nginx` 环境的 `check`，确认 `/usr/sbin/nginx` 已存在。 | CLI 严格配置校验通过，且 `check --env nginx` 能在目标机执行。 |
| P-2 | CHG-add-nginx-environment | 提供 `nginx` 环境的非交互 APT 安装脚本，安装 Ubuntu Nginx 软件包。 | 安装脚本遵循现有环境安装模式，并通过配置校验；真实目标机的实际安装按用户确认后验证。 |
| P-3 | CHG-add-nginx-environment | 将该环境分配给 `eleph-server`，并同步模板与当前生成集群。 | 两个 `cluster.yaml` 都包含 `nginx: [eleph-server]`，`prepare --env nginx` 能生成计划。 |
| P-4 | CHG-add-nginx-environment | 更新示例文档，说明 nginx 环境安装与 nginx App 配置的分工。 | README 中的使用顺序与实际 CLI 行为一致。 |

## Success Criteria

- `deno task eleph-deploy validate --cluster multipass --config-root examples/eleph-server-multipass/clusters` 通过。
- `deno task eleph-deploy check --cluster multipass --config-root examples/eleph-server-multipass/clusters --env nginx` 能装载并执行 nginx 环境检查；CLI 的 `plan` 只支持 App，环境安装通过 `prepare` 验证。
- 目标机未安装 Nginx 时，`prepare --env nginx` 会执行安装；安装后 `/usr/sbin/nginx` 存在。
- README 不再只表达“目标机必须预装 Nginx”，同时给出通过 nginx 环境预装的路径。

## Risks

- 运行时影响：安装脚本会访问 APT 源并修改目标机软件包状态。缓解方案是只在显式 `prepare` 命令中触发，不在 App deploy 中隐式执行。
- 版本漂移：APT 安装的是 Ubuntu 当前可用版本，不锁定补丁版本。该示例环境也用 `version` 表达目标语义，不用于强制 APT 版本锁定。
- 生成集群漂移：只改模板会导致当前 multipass 集群不可用；因此同步当前集群目录。若后续重跑 prepare，模板也能生成一致目录。

## 待确认问题

无未解决问题。
