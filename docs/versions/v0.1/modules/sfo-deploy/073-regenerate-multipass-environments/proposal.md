---
task_manifest: task.yaml
status: approved
---

# Proposal：按新规则重新生成 multipass 环境配置

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 这是示例集群模板内的配置重生成，不修改 sfo-deploy 运行时、配置契约、默认行为或生产配置。模板面向 Ubuntu 22.04 Multipass，系统包和 systemd 行为已有框架固定原语支持，可通过本地 `validate`/`plan` 和定向检查验证。
- Proposal and tier confirmation: 用户于 2026-09-09 回复“确认”，批准本提案和 standard 层级。

## Background and Goal

`examples/eleph-server-multipass/cluster-template/environments/` 目前使用旧顶层
`scripts` 生命周期。JRE、MySQL、Nginx 和 Redis 各自提供 apt 安装脚本；MySQL 和 Redis 另有
systemd start/stop/restart 脚本。新契约已支持顶层 `install` 与可选 `manager`，其中 package
安装由框架查询包状态并执行固定包管理器命令，system manager 由框架探测并收敛 systemd/service
状态。

本次目标是在不改变环境名称、版本标签、依赖放置和集群映射的前提下，把四个环境重新生成为新
生命周期配置，并让同一份 multipass 模板支持 Ubuntu/Debian 和 CentOS 7。所有安装仍优先交给
系统包管理器，服务仍优先交给 systemd/service；对包名或服务名跨发行版不一致的组件，使用新契约
中的 `install.kind: script` 或 `manager.kind: script` 在环境目录内探测 apt/yum、systemctl/
service 和对应服务名，不直接启动脱离服务管理器的进程。

## Scope

### In scope

- 将 `jre`、`mysql`、`nginx`、`redis` 的 `environment.yaml` 从旧 `scripts` 生命周期迁移为
  `install` + 可选 `manager`。
- 使用 `install.manager: auto` 优先探测 apt-get，其次 yum，覆盖 Ubuntu/Debian 与 CentOS 7。
- `nginx` 的包名和服务名在两个目标上一致，使用 package install 和 `manager.kind: system`。
- `mysql` 包名一致但服务名可能是 Ubuntu 的 `mysql` 或 CentOS 的 `mysqld`；包安装使用
  package install，服务启停使用 script manager 并探测服务名。
- `jre` 和 `redis` 的发行版包名不同；使用 script install 探测 apt/yum 并选择对应包名。
  Redis 的服务名也不同，使用 script manager 探测 `redis-server`/`redis`。
- `jre` 是运行时依赖而非服务，不声明 manager。
- 为新生命周期中需要跨发行版探测的环境保留必要的 `scripts/install.ts`、`scripts/start.ts`
  和 `scripts/restart.ts`；不再保留旧契约的 check/stop 等脚本。
- 同步 `examples/eleph-server-multipass/README.md` 中与 multipass 环境安装/启动相关的说明。

### Out of scope

- 不修改 `cluster.yaml` 的环境放置、App 依赖、App schema、版本映射或机器定义。
- 不改变框架源码、测试基础设施或 skill 配置参考。
- 不连接 Multipass 虚拟机，不运行 `prepare`、安装软件包、启动服务或部署应用。
- 不固定发行版软件包的精确版本；`version` 仍只是环境配方版本标记。
- 不处理 MySQL 数据初始化、Redis 密码配置、Nginx 站点配置或应用配置迁移。

## Requirement Review

请求合理：新契约的 package/system 原语能直接覆盖包名和服务名一致的场景，script install/manager
则覆盖 Ubuntu 与 CentOS 7 之间的差异，且仍把实际动作收敛到系统包管理器和系统服务管理器。主要
权衡是跨发行版兼容需要少量自包含探测脚本，而且新契约的环境 script manager 不提供 stop 动作。
框架只支持 apt-get/yum 和 systemctl/service，不支持 dnf 或其他 init 系统；这些边界应保留在
README 中。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-regenerate-multipass-environments | multipass 环境优先使用系统包安装和系统服务管理，并支持 Ubuntu/Debian 与 CentOS 7。 | 包管理器使用 auto 的 apt-get→yum 探测；服务管理优先 systemctl，必要时回退 service。包名或服务名跨发行版不一致时使用新契约的 script install/manager。 | 跨发行版兼容需要少量自包含探测脚本，且环境 script manager 不提供 stop。 | 本地 `validate`/`plan` 通过，定向检查确认 YAML、脚本权限和跨发行版探测逻辑符合新契约。 | 不连接真实 Ubuntu/CentOS 虚拟机执行安装或启动。 |
| P-002 | CHG-regenerate-multipass-environments | 移除旧生命周期脚本和不再需要的环境脚本，并同步 README 的环境 prepare 语义。 | 只处理 `examples/eleph-server-multipass/cluster-template/environments/**` 中迁移需要的文件。 | 减少旧 check/stop 等入口，但保留跨发行版探测所需的新脚本。 | 旧顶层 `scripts` 不再被环境 YAML 引用；README 不再声称旧 check/install/start 序列。 | 不更新其他示例、skill 源或全局指南。 |

## Success Criteria

- `cluster.yaml.environments` 和依赖闭包保持不变；模板 `validate` 成功。
- `plan` 输出仍包含三个 App 和对应环境依赖；环境配置从旧 `scripts` 切换为新 `install`/`manager`。
- `nginx` 使用 package install 和 system manager；`mysql` 使用 package install 和 script manager；
  `jre`、`redis` 使用 script install；`redis` 使用 script manager；`jre` 无 manager。
- 跨发行版脚本只探测并调用 apt-get/yum、systemctl/service 和预定义包/服务名；失败时 fail-closed。
- README 准确说明 Ubuntu/CentOS 支持边界、prepare 只负责环境准备，以及本地验证不证明真实 VM
  已安装成功。
- README 准确说明 prepare 只负责环境准备，不执行 App 部署，也不会证明真实 VM 已安装成功。
- 非目标：实际 VM 上的包可下载性、软件源状态、服务启动结果和 MySQL 初始化不在本次验证范围内。

## Risks

- 声明式安装依赖目标机的软件源和网络；prepare 时失败会阻塞环境准备，这是显式失败而非本次配置
  可掩盖的缺陷。
- `mysql` 在 Ubuntu 的包安装通常自动初始化服务；本配置只声明服务收敛，不额外处理首次数据目录
  初始化或密码。
- 示例 README 中如有与旧生命周期耦合的措辞，必须同步；否则用户会误解 prepare 行为。
