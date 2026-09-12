---
task_manifest: task.yaml
status: approved
---

# Proposal：Environment script manager 支持 stop

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本次会扩展 Environment 配置装载契约、计划生成、历史快照持久化和远端执行行为；`stop` 会改变运行中服务的生命周期，失败路径可能导致服务中断或状态误判。
- Proposal and tier confirmation: 用户于 2026-09-09 回复“确认”，批准本提案和 high-risk 层级。

## Background and Goal

当前 Environment 新生命周期中的 `manager.kind: script` 只声明 `start` 和 `restart`。这意味着
MySQL 虽然实际通过 systemd/service 管理，但无法通过 Environment 级 `stop` 动作停止。用户已确认
MySQL 可以保持 script manager，同时指出缺少 stop。

目标是把 script manager 的契约扩展为 `start`、`stop`、`restart` 三个必需动作，使 MySQL、Redis
等跨发行版环境既能继续探测 `mysql`/`mysqld` 与 `redis-server`/`redis`，也能通过系统服务管理器
安全停止。

## Scope

### In scope

- 扩展 `EnvironmentScriptManager` 配置和计划快照，新增必需的 `stop` 调用。
- `sfo-deploy stop --env mysql`（或等价环境选择方式）可计划并执行 script manager 的 `stop` 脚本。
- MySQL 和 Redis 环境补充幂等 `scripts/stop.ts`，优先通过 `systemctl stop`，systemd 不可用时回退
  `service stop`；动作后校验服务不再 active。
- 更新装载/计划/历史/执行测试和中文配置文档。
- 同步实际 `examples/eleph-server-multipass/clusters/multipass/environments/{mysql,redis}` 的配置和脚本。

### Out of scope

- 不改变 system manager 的内置 systemctl/service 行为。
- 不支持 pacman、zypper 等其他包管理器或 init 系统。
- 不自动停止依赖 MySQL/Redis 的 App；停止顺序仍由用户显式控制。
- 不修改 App managed service 的 stop 语义。

## Requirement Review

需求合理：App script service 已经有 start/stop/restart 三段；Environment script manager 缺少
stop 属于功能缺口。为保持跨发行版能力，脚本方式比把服务名硬编码为内置 system manager 更符合当前
Multipass 示例。主要风险是 stop 的失败语义：如果服务已经停止，脚本应视为满足；如果停止失败或状态
校验失败，必须 fail-closed。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-environment-script-manager-stop | Environment script manager 必需声明 `start`、`stop`、`restart`。 | 旧 plan 快照按新增必需字段兼容；无 manager 的环境不生成服务动作。 | 契约更完整，但旧 script manager 配置需要迁移。 | 装载、计划、历史和执行测试覆盖新增 stop 及冲突/兼容路径。 | 不自动迁移无 stop 的旧配置。 |
| P-002 | CHG-environment-script-manager-stop | MySQL/Redis 提供 service-manager-backed stop 脚本。 | 优先 systemctl，必要时 service；stop 后确认 inactive，不直接杀进程。 | 脚本稍复杂，但保留 Ubuntu/CentOS 7 兼容。 | 实际集群 validate/plan 通过；本地测试覆盖 systemd 和 SysV 分支。 | 不停止依赖这些环境的应用。 |

## Success Criteria

- `manager.kind: script` 可以声明并装载 `stop`；缺少 `stop` 时配置装载失败。
- 新计划快照能编码/解码 stop；执行器只对 `stop` 动作调用对应脚本。
- MySQL 和 Redis 的 stop 脚本不直接启动/杀死进程，只通过系统服务管理器停止并确认状态。
- 生成集群中 `mysql`、`redis` 的环境 `validate` 和 `stop plan` 可通过；真实节点停止动作仍需用户显式执行。
- 非目标：不证明真实 VM 上的服务停止成功。

## Risks

- 停止数据库可能导致连接中断；脚本必须只操作服务管理器并失败关闭。
- 历史 plan 快照兼容处理不当会导致旧发布无法回放。
- SysV 服务状态码存在差异，需要避免把“已停止”误判为失败或假成功。
