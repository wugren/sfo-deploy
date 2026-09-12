---
task_manifest: task.yaml
status: approved
---

# Proposal：Environment 支持统一安装与服务管理

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本次会改变配置装载契约、远端执行行为、部署准备流程和多发行版兼容面；安装与服务启动使用提权命令，错误选择包管理器或 init 系统会影响真实机器。因此不能按 low-risk 变更处理。
- Proposal and tier confirmation: 尚未确认；等待用户确认本提案和层级。

## Background and Goal

当前 `environment.yaml` 的 `check/install/configure/start` 都要求用户提供具体脚本。Nginx 等 Ubuntu 模板需要直接写 `/usr/bin/apt-get`，换到 CentOS 后必须改写脚本。App 的 managed service 也只支持 systemd。

本次目标是把新 Environment 生命周期收敛为顶层 `install` 和可选 `manager` 两个配置节点：安装可以是内置系统包安装或脚本，服务管理可以是内置系统服务控制或脚本；不再引入新的 `check` 步骤。用户声明要安装的软件包，`manager` 缺省时表示该 environment 只准备依赖，不管理运行中的应用。sfo-deploy 在目标机运行时探测合适的工具，例如 Ubuntu/Debian 使用 apt-get，CentOS 7 使用 yum；服务启动按目标平台选择 systemctl 或 service。

## Scope

### In scope

- 在 `environment.yaml schema_version: 1` 上引入顶层 `install` 和 `manager` 生命周期节点，并把脚本、声明式安装和服务控制收敛到这两个节点下。
- 现有顶层 `scripts` 继续按旧契约装载；顶层 `install`/`manager` 是新增的可选统一入口，不强制迁移。
- 运行时 fail-closed 地探测并使用受支持的包管理器；首版至少覆盖 Ubuntu/Debian 的 apt-get 和 CentOS 7 的 yum。
- 声明式安装必须支持幂等检查：已安装的包不再重复安装。
- `install` 只有两个实现方式：`package` 使用系统包管理器，`script` 使用用户脚本；声明式包安装内部完成幂等判断，不再要求独立 check 脚本。
- `manager` 只有两个实现方式：`system` 使用 systemctl/service，`script` 使用用户脚本声明启动/重启入口；不再要求独立 check 脚本。
- `manager.tool` 在运行时按目标平台自动选择控制工具：Ubuntu/Debian 使用 systemctl，CentOS 7 使用 service；同时允许显式指定工具，未知或缺失工具时失败而不猜测。
- 在扩展后的 schema v1 中，顶层旧 `scripts` 与新 `install`/`manager` 不允许同时出现。新配置必须声明 `install`；`manager` 可缺省，缺省表示不管理应用运行。`install.kind` 只允许 `package|script`，`manager.kind` 只允许 `system|script`。
- 更新配置指南、cluster 配置技能参考和自动测试，示例只修改能证明行为的必要部分。

### Out of scope

- 不支持 pacman、zypper、Homebrew 等其他包管理器；不支持不可探测的平台。
- 不自动生成或发布任意 systemd unit；CentOS 7 的 service 分支只控制已由系统包或用户预先安装的服务定义。
- 不自动升级已安装软件包到 Environment 声明的版本标签；`version` 继续作为环境配方版本标记，除非后续设计明确增加精确包版本能力。
- 不把 App 的 `management.actions` 迁移到新机制，也不改变现有 App 脚本/managed service 行为。
- 不连接真实部署机器执行安装或启动。

### Boundary with neighboring modules

- `install-deno` 已有自己的工具补齐探测逻辑，可作为包管理器命令探测的实现参考，但本次不重写该功能。
- App managed service 继续由 `service_management.ts` 现有 systemd 语义拥有。
- cluster 配置技能会同步说明新 Environment 配置，但不自动修改用户现有集群配置。

## Proposed Configuration Direction

具体字段名将在 design 阶段定稿，但提案采用顶层 `install` 和可选 `manager` 承载生命周期声明。顶层 `manager` 表示服务管理声明；其内部使用 `tool` 选择 systemctl/service，避免形成 `manager.manager`。

### 系统包安装与系统服务

这份配置在 Ubuntu/Debian 和 CentOS 7 上保持一致：

```yaml
schema_version: 1
name: nginx
version: "1.24"
depends_on: []
requires_privilege: true

install:
  # 允许值：package | script
  kind: package
  # 允许值：auto | apt-get | yum
  manager: auto
  packages: [nginx]
  update_cache: false

manager:
  # 允许值：system | script
  kind: system
  name: nginx
  # 允许值：auto | systemctl | service
  tool: auto
  enabled: true
  start_after_install: true
  timeout_ms: 300000
```

### 脚本安装与脚本服务管理

```yaml
schema_version: 1
name: nginx
version: "1.24"
depends_on: []
requires_privilege: true

install:
  kind: script
  path: scripts/install.ts
  permissions:
    run: [/usr/bin/apt-get]
    net: []

manager:
  kind: script
  start:
    path: scripts/start.ts
    permissions:
      run: [/usr/bin/systemctl]
      net: []
  restart:
    path: scripts/restart.ts
    permissions:
      run: [/usr/bin/systemctl]
      net: []
```

新配置只有顶层 `install` 和可选 `manager` 两个步骤，不声明 `check`。`install.kind` 只允许 `package` 或 `script`；`manager.kind` 只允许 `system` 或 `script`。当 `install.kind: package` 时，`install.manager` 只允许 `auto`、`apt-get` 或 `yum`；当 `manager.kind: system` 时，`manager.tool` 只允许 `auto`、`systemctl` 或 `service`。`auto` 会根据目标机实际可用工具选择命令；设计阶段会明确探测顺序和失败语义。当前边界是只使用预定义的 apt-get、yum、systemctl、service 模板，不执行配置中传入的命令。顶层 `version` 仍是环境配方版本标记，不代表精确锁定发行版软件包版本。现有顶层 `scripts` 继续兼容，但新配置推荐使用顶层 `install`/`manager`。

## Requirement Review

这个需求合理：真实集群经常包含 Ubuntu 和 CentOS 机器，逐环境复制安装脚本会放大维护成本。更稳妥的方向不是让用户在配置中写任意命令，而是让框架维护一组固定、可测试、fail-closed 的包管理器和服务管理器命令模板。

主要权衡是声明式配置更容易使用，但覆盖的平台能力有限。使用固定模板和显式白名单可以避免把 YAML 变成 shell 注入通道。对 CentOS 7，`service` 是 SysV 兼容入口；对 Ubuntu/Debian，systemd 语义可以复用现有服务管理经验，但 Environment 侧需要独立的、更轻量的执行模型。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-declarative-environment-install | Environment 的 `install` 步骤支持 `package` 或 `script`；`package` 由框架按目标机选择 apt-get/yum 安装。 | 首版支持 apt-get 与 yum，包名经过严格校验，不执行任意 shell；脚本安装必须可重复执行。 | 固定模板比任意脚本安全，但灵活性降低。 | 装载/校验测试、计划行为测试和远端执行驱动测试覆盖 package/script 与 Ubuntu/CentOS 分支。 | 不新增 check 步骤。 |
| P-002 | CHG-declarative-environment-service | Environment 的顶层 `manager` 步骤支持 `system` 或 `script`；`system` 由框架按目标机选择 systemctl/service。 | 首版只控制已有服务定义，不生成 unit；脚本服务必须声明 start/restart 入口。 | 支持多 init 入口会引入平台差异和额外状态判断。 | 装载/校验、计划和执行测试覆盖 system/script 与 Ubuntu/CentOS 分支。 | 不新增 check 步骤。 |
| P-003 | CHG-declarative-environment-conflicts | 在 schema v1 上新增顶层 `install` 和可选 `manager` 节点；顶层脚本继续兼容。 | 顶层 `scripts` 与 `install`/`manager` 互斥；新配置必须声明 install，manager 缺省表示不管理应用运行。未变更的 v1 环境行为必须完全不变。 | 顶层配置更扁平；由于保持 schema v1，装载器必须同时兼容旧顶层字段和新统一字段。 | 正负例测试确认旧字段与新字段混用、缺失 install 和未知 kind 失败关闭，缺省 manager 不产生服务动作，旧 v1 集群配置不产生行为漂移。 | 不提供自动迁移工具。 |
| P-004 | CHG-declarative-environment-docs | 指南与 cluster 配置技能说明声明式配置、支持平台和失败语义。 | 文档只覆盖本次契约，不重写完整部署教程。 | 文档需要与实现同步。 | 文档示例与校验/计划行为一致，并纳入契约检查。 | 不虚构真实机器验证结果。 |

## Success Criteria

- Concrete user-visible or system-visible result: 用户可以在 `environment.yaml` 的顶层 `install` 中选择系统方式或脚本方式；需要应用运行管理时再声明顶层 `manager`。新配置不需要独立 check；`validate` 能发现非法或冲突声明，`prepare` 能按目标平台执行。
- Required evidence: Deno check、lint/format、定向单元与集成/契约测试通过；测试覆盖 package/script 安装、system/script 服务、包管理器探测、命令模板、幂等安装、服务管理器选择、失败关闭、旧脚本兼容和历史计划兼容。
- Explicit non-goals: 不证明某个真实 CentOS 或 Ubuntu 节点已经部署成功；不新增不受信任的命令模板；不支持所有 Linux 发行版；不提供同一 environment 内脚本与声明式配置混用模式。

## Risks

- 包管理器探测若只看二进制存在性，可能误判容器或自定义路径；设计需要确定探测顺序、绝对路径和失败提示。
- service/systemctl 的状态查询和启用语义不同，CentOS 7 与 Ubuntu 的退出码差异需要统一建模，否则会产生假成功。
- 声明式安装使用 root/提权包管理器，存在软件源信任与网络访问边界；必须保持固定参数、包名白名单和明确文档提示。
- 环境计划和历史快照若携带新配置，需要兼容旧 plan v3/v4；否则旧任务历史无法回放。
- 整体二选一会让包含部分脚本、部分内置动作的旧环境迁移到声明式配置时需要重写完整生命周期；文档必须说明迁移边界。
