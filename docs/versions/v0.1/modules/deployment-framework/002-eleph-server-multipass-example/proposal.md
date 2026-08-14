---
task_manifest: task.yaml
status: approved
---

# eleph-server Multipass 部署示例提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment
- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 示例会通过 deploy 环境/App 脚本建立 JRE、MySQL、Redis、数据库初始化、HTTP 制品校验下载、敏感配置注入、systemd 生命周期、健康检查和回滚约定，直接触及部署面、数据初始化、运行时集成与安全边界。
- Proposal and tier confirmation: 原提案曾由用户以“确认，自动完成”批准；用户要求把 JAR 配置从 Multipass 引导中移除，并以“确认，自动完成”批准本修订、high-risk tier 及后续自动回流实现、测试与验收。

## Background and Goal
在 `examples/eleph-server-multipass/` 下建立一个独立、可运行、可复制的消费者项目，演示如何引用仓库根部的 `deployment-framework`，把可通过 HTTP/HTTPS 下载的 `jx-server.jar` 部署到单台 Multipass Ubuntu 虚拟机。除创建空白 Multipass 实例及取得 SSH/IP 这一框架外部引导步骤外，JRE、MySQL、Redis、数据库、应用配置和应用生命周期全部通过 deploy 支持的环境/App 配置及 Python 生命周期脚本实现。最终结果必须是 `jx-server` 正常运行并可从宿主机访问。

## Scope
### In scope
- 面向 Windows PowerShell 主机提供最小 Multipass 引导入口，仅创建空白 Ubuntu 实例、配置示例专属 SSH 密钥、生成严格的 `known_hosts` 并把实例 IP 写入 deploy 机器配置；不在引导脚本中安装应用运行环境。
- 示例目录拥有独立的 `pyproject.toml`、Python 包/命令入口、集群配置、远端生命周期脚本、README、测试和本地忽略目录；通过项目依赖引用仓库根部 deploy 模块，不复制其源码。
- 在 `app.yaml` 中保留 deploy 模块内置的 HTTP/HTTPS 制品声明；用户在 Multipass 引导完成后直接手工编辑生成的 `.state/clusters/multipass/apps/jx-server/app.yaml`，填写 URL、对应 provider 和 SHA-256。`prepare-multipass.ps1` 不接收、校验或改写任何 JAR 参数。
- 通过 SSH 下载校验后的 JAR 到 Multipass 虚拟机，并演示 deploy/configure/start/stop/restart 生命周期。
- 分别使用 deploy 环境定义及其 `check/install/configure/start/stop/restart` Python 脚本，在虚拟机内安装并配置 JRE、MySQL 和 Redis；环境依赖顺序由 deploy 计划表达。
- 通过 deploy 的配置模板和 `config_secrets` 创建本地数据库/账号、初始化 `jx-server` 所需 schema，并生成应用数据库、Redis、令牌等覆盖配置，不读取或传播源仓库现有配置中的明文连接参数。
- 使用 deploy App 的 `deploy/configure/start/stop/restart` 脚本安装 JAR、生成 systemd 单元并管理服务；生命周期脚本负责失败退出和幂等行为。
- 提供 deploy 驱动的服务检查或部署后的 HTTP 健康探测，验收必须证明宿主机能通过 Multipass IP 访问 `jx-server:8080`。
- 为纯本地配置/脚本逻辑增加自动化验证；在文档中给出完整的准备、规划、部署和清理命令。

### Out of scope
- 修改 `C:\work\eleph-server-new` 的业务代码、现有配置文件或数据库 schema。
- 修改 deploy 模块的生产代码、根项目依赖或根测试；示例只消费 deploy 模块公开接口。
- 构建、重新打包、上传或托管 `jx-server.jar`，以及实现新的制品下载提供方。
- 部署 `web-ui`、Nginx、TLS、域名或暴露到宿主机之外的网络。
- 生产级高可用、备份、监控、容量规划、密钥保险库和零停机发布。
- 自动安装 Multipass 或在未经确认的情况下创建/删除虚拟机。

### Boundary with neighboring modules
- `deployment-framework` 继续负责配置解析、依赖计划、SSH 传输、HTTP/HTTPS 制品校验、模板/敏感配置投递和生命周期执行；独立示例项目只通过公开 Python 接口引用它，并提供自己的项目绑定、Multipass 最小引导、环境/App 生命周期脚本、测试及说明。
- Multipass 引导与 deploy 执行的明确边界是“可通过受信 SSH 连接的空白 Ubuntu 实例”：该边界之前不安装 JRE/MySQL/Redis/应用，边界之后不使用 `multipass exec/transfer/mount` 绕过 deploy。
- `eleph-server-new` 仅作为识别应用入口和配置形态的只读参考，不是实现或构建输入；示例生成的密钥、机器 IP、known_hosts 和临时配置放入示例本地状态目录并忽略版本控制。

## Requirement Review
该需求适合作为现有部署框架的首个真实消费者项目。独立目录能清楚展示“项目如何依赖并调用 deploy 模块”，同时避免为单个应用修改通用框架。示例固定使用 Ubuntu 22.04 LTS；`jx-server.jar` URL、provider 与 SHA-256 由调用方手工写入生成的 App YAML，JRE、MySQL、Redis 和数据库初始化则由 deploy 环境脚本完成。示例默认只在 Multipass 私有网络内提供 `8080`，允许宿主机访问但不桥接到局域网。

本机当前未安装 `multipass`，因此实现阶段可以完成静态、单元和模拟执行验证，但真实 VM 端到端验证需要用户先安装 Multipass，或在具备 Multipass 的环境中执行。源项目现有资源包含明文远程连接参数；示例不会复制这些值，而要求调用方通过本地环境变量提供示例配置。

## Proposal Items
| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-multipass-bootstrap | 提供幂等的 Multipass 最小引导，生成专属 SSH 身份、主机指纹和 deploy 机器配置，完全不处理 JAR | 只建立可 SSH 的空白命名实例；不得接收 JAR URL/SHA，不得安装运行环境或应用 | Windows 优先，其他主机只提供可移植说明 | 脚本静态测试、生成配置校验；可用环境中的 `multipass info`/SSH 预检 | 自动安装 Multipass、桥接公网、使用 Multipass 命令部署应用、处理 JAR 参数 |
| P-002 | CHG-eleph-http-deploy | 在独立项目中引用 deploy 模块公开接口；调用方手工编辑生成的 App YAML 设置 HTTP/HTTPS provider、JAR URL 和 SHA-256；环境脚本安装/配置 JRE、MySQL、Redis 和数据库，App 脚本完成配置、systemd 生命周期与健康检查 | 不修改/复制 deploy 模块，不构建或上传 JAR；首次 SSH 后不得绕过 deploy | 手工填写的 provider、URL 与 SHA-256 必须匹配；apt、制品 URL 依赖网络；示例包含单机数据库初始化 | 独立项目依赖/导入测试、App YAML 未填写时失败关闭、环境/App 计划测试、脚本幂等/失败模拟；真实环境中的 systemd 与 HTTP 可访问证据 | deploy 模块内部改造、本地制品提供方、HA、滚动升级、生产迁移 |
| P-003 | CHG-example-guidance | 独立目录自带中文 README 和从准备到部署、检查、重启、停止、清理的命令入口 | 不依赖根 README 或根测试才能理解/验证 | 目录内会有少量重复的项目级启动说明 | 目录结构、文档命令和本地测试一致性检查 | web-ui、Nginx、TLS |

## Success Criteria
- Concrete user-visible or system-visible result: 用户运行不带任何 JAR 参数的 `prepare-multipass.ps1` 准备一台名为 `eleph-server` 的空白 Multipass 实例，随后手工编辑生成的 App YAML 填写 provider、JAR URL 与 SHA-256，再执行示例 deploy 命令；deploy 自动安装/配置 JRE、MySQL、Redis 和数据库，下载并校验 `jx-server.jar`，将其作为 systemd 服务启动，宿主机最终可通过实例 IP 的 `8080` 端口访问服务。
- Required evidence: 独立示例项目能从自己的目录安装/引用根部 deploy 模块；目录内 YAML、模板、脚本和测试通过静态与自动化验证；框架 `validate/plan` 展示完整环境依赖和内置 `https` 制品提供方；模拟执行覆盖环境安装、配置、App 生命周期与失败；最终验收必须在具备 Multipass、网络和有效 JAR URL 的环境记录 VM 内 JRE/MySQL/Redis/systemd 状态及宿主机 HTTP 访问结果。当前机器缺少 Multipass 时，该真实验收保持未完成而不能宣称已正确部署。
- Explicit non-goals: 不把该单机示例宣称为生产方案，不复用源仓库中的明文凭据，不自动暴露公网，不更改源业务仓库。

## Risks
- Multipass 实例 IP 来自私有 DHCP，重建或网络变化后必须重新生成机器配置和 host key 证据。
- 用户提供的 JAR 必须确实是可独立运行的部署制品；当前源码目录中的历史构建形态可能依赖外置 `lib/resources`，示例不会负责修复或重新打包该制品。
- 数据库 schema 快照需要随独立示例版本化并注明来源；它只用于一次性示例初始化，不替代正式迁移机制。
- Ubuntu 22.04、JRE 与旧版 Spring 依赖的兼容性，以及数据库初始化后的实际业务访问，需要真实部署验证；无 Multipass 环境时不能满足最终“可访问”验收。
- 本地生成的令牌、数据库/Redis 参数和 SSH 凭据必须位于忽略目录或进程环境中，日志与计划输出不得泄露具体值。
