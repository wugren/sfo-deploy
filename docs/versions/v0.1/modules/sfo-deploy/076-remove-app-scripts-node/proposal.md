---
task_manifest: task.yaml
status: approved
---

# Proposal：移除 App 顶层 scripts 并改为 management.kind 分派

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 这是 App 配置契约和运行时计划行为变更。移除顶层
  `scripts` 会影响 schema 校验、packageless `check`、自定义 deploy/configure 兼容、
  plan 步骤生成和执行器动作归属；需要破坏性 schema 边界、回归测试和文档同步。
- Proposal and tier confirmation: 用户于 2026-09-10 确认本提案和 high-risk 层级；同日明确
  不新增 `management.check`，完全禁止顶层 `scripts`，并把管理结构改为 `management.kind`
  分派。

## Background and Goal

当前 App schema 1 仍要求顶层 `scripts`。即使使用内置 versioned 发布和受管配置，
`jx-server`、`jx-web` 也必须写 `scripts: {}`；packageless 的 `nginx` 还通过
`scripts.check` 定义检查动作。当前服务管理则藏在 `management.service` 包装层中。

目标是让 App 生命周期动作的声明面收敛到 `management`，顶层不再出现 `scripts` 节点。
`management` 直接使用 `kind` 分派管理器类型：

```yaml
management:
  run_as: ubuntu
  kind: script
  start:
    path: scripts/start.ts
    permissions: {run: [], net: []}
  stop:
    path: scripts/stop.ts
    permissions: {run: [], net: []}
  restart:
    path: scripts/restart.ts
    permissions: {run: [], net: []}
```

```yaml
management:
  run_as: ubuntu
  kind: service
  name: jx-server.service
  tool: auto
  enabled: true
  daemon_reload: true
  on_deploy: restart
  timeout_ms: 30000
```

脚本配置继续由 `configs[].kind: script` 表达；受管文件继续由
`configs[].kind: file` 表达。

## Scope

### In scope

- 从 App schema 1 中移除并禁止顶层 `scripts` 字段。
- 将管理器声明从旧的 `management.service.kind` 改为顶层 `management.kind`：
  - `kind: script` 直接携带 `start`、`stop`、`restart` 三个脚本；
  - `kind: service` 直接携带系统服务配置（`name`、`tool`、`enabled`、
    `daemon_reload`、`on_deploy`、`timeout_ms`、`unit_config`）。
- 同步实际 multipass 集群与集群模板中的 App 声明。
- 更新类型、装载校验、planning、执行器、测试、README、指南和 sfo-deploy 配置技能参考。

### Out of scope

- 不修改 environment 的 `scripts`/`install`/`manager` 契约。
- 不引入 `management.check`、Windows 服务管理或非 systemd/system V 之外的服务管理器。
- 不执行真实 SSH、fetch、prepare、secrets-deploy、deploy 或服务启停。
- 不修改 App 版本、制品协议、秘密放置或机器放置。

## Requirement Review

请求方向合理：对使用内置发布、受管配置和受管服务的 App 来说，顶层空 `scripts: {}`
只是历史兼容噪音。用户已确认采用破坏性 schema 清理，不保留顶层脚本兼容。

确认契约如下：

- 顶层 `scripts` 禁止出现。
- `configs[].kind: script` 继续承担脚本配置动作，并与受管文件配置互斥。
- `management.kind: script` 直接承担 start/stop/restart，三个动作都必须声明且互斥于
  其他管理器类型。
- `management.kind: service` 直接承担 systemd/SysV 服务动作，字段闭包沿用当前系统服务
  语义，但不再有 `management.service` 包装层。
- 不新增 `management.check`。packageless App 不再生成 check 步骤；nginx 等配置型 App
  只生成 configure/service 相关步骤，前置可用性问题由后续配置发布或服务操作失败暴露。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-remove-app-scripts-node | App schema 1 不再有顶层 `scripts` 节点。 | 装载时遇到 `scripts` 定向拒绝；内置 versioned、configs 和 management 是唯一动作来源。 | 破坏性 schema 变更；自定义 deploy/configure/check 不再由 App schema 1 表达。 | 单元/执行测试证明 `scripts` 被拒收，空对象不再需要。 | 不兼容旧 schema。 |
| P-002 | CHG-remove-app-scripts-node | `management.kind` 分派 script 与 service 管理器。 | `kind: script` 必须提供 start/stop/restart；`kind: service` 沿用当前系统服务字段闭包和跨发行版工具语义。两种 kind 互斥。 | script 管理没有 systemd enable/daemon-reload 语义，只能执行显式脚本。 | 装载、计划、执行测试覆盖 `kind: script` 和 `kind: service`。 | 不支持其他服务管理器。 |
| P-003 | CHG-remove-app-scripts-node | packageless App 不新增 check 归属。 | 不新增 `management.check`；planning 不再要求 packageless check，deploy 计划只生成受管 configure/service 步骤。 | 失去 fail-fast 前置检查，可用性问题会推迟到配置发布或服务操作时暴露。 | nginx 可在不使用顶层 scripts 和 management.check 的情况下装载、validate、plan。 | 不执行真实检查。 |
| P-004 | CHG-remove-app-scripts-node | 同步文档、模板和 multipass 配置。 | 只更新与 App schema 1 动作声明相关的文档、技能参考和示例。 | 文档需要明确破坏性和迁移路径。 | 文档示例均无顶层 scripts；validate/plan 通过。 | 不更新 environment 文档语义。 |

## Success Criteria

- App YAML 中出现顶层 `scripts` 时，装载在 SSH 前定向失败。
- `jx-server` 和 `jx-web` 的 `app.yaml` 不包含 `scripts` 节点。
- `management.kind: script` 与 `management.kind: service` 均可通过装载并生成正确计划；
  旧 `management.service` 包装结构被定向拒收。
- nginx 或等价 packageless App 不使用顶层 `scripts` 和 `management.check` 时，deploy 计划
  仍能表达受管 configure/service 步骤。
- `deno task check`、任务测试、实际 multipass `validate` 和 `plan` 通过。
- 非目标：真实节点服务可用性、包可下载性、制品哈希正确性和 Redis 密码匹配。

## Risks

- 这是破坏性 App schema 变更；已存在带 `scripts` 的 App 会直接拒收。
- 自定义 deploy/configure/check 的迁移路径必须清晰，否则用户会丢失原有生命周期动作。
- 若 packageless 不保留 check，故障会推迟到配置发布或服务启动时才暴露。
- `management.kind: script` 依赖目标脚本存在、权限准确且幂等；计划通过不代表远端可运行。
- 旧 `management.service` 将不可装载；所有集群、模板和文档必须同步，否则 validate 会在
  SSH 前失败。

## Resolved Requirement Decisions

- 不新增 `management.check`。
- 完全禁止顶层 `scripts`。
- 管理器字段是 `management.kind`，不是 `management.service.kind`。
- `management.kind: script` 配置 `start`、`stop`、`restart` 三个脚本。
- `management.kind: service` 配置系统服务；不再使用 `management.service` 包装层。
