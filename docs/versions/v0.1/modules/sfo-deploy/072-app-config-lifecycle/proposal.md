---
task_manifest: task.yaml
status: approved
---

# sfo-deploy App schema 1 配置与服务生命周期提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本需求会重写 `app.yaml` 配置契约、App 配置发布与
  服务管理执行路径，并涉及部署/回滚、跨发行版系统服务兼容和破坏性旧版本移除，属于共享契约、
  运行时行为和部署面变更。
- Proposal and tier confirmation: 用户已于当前会话明确确认提案和 high-risk 层级。

## Background and Goal

用户要求重新定义 `app.yaml` 配置契约：`schema_version` 使用 1；配置声明分为 `configs` 与
`management`；每个配置段不声明 `name`，直接用 `kind: script|file` 表达类型；管理可选择系统服务
或脚本；系统服务需要覆盖 Ubuntu 与 CentOS。用户已明确不需要管理历史 App 版本兼容。

## Scope

### In scope

- 为 App 增加新的声明式配置契约：
  - App 顶层 `schema_version` 只接受 `1`；
  - 顶层 `configs` 支持多个配置段；
  - 每个配置段没有 `name` 字段，直接使用 `kind: script` 或 `kind: file` 表达类型；
  - 同一配置段只能选择其中一种类型；
  - `file` 保持受管模板、远端目标、格式、属主/权限、校验和变更动作；
  - `script` 按固定生命周期动作执行配置脚本；
  - `file` 配置以目标路径作为唯一标识，`script` 配置以脚本路径作为唯一标识，重复声明会被拒收。
- 为 App 增加新的 `management` 契约：
  - 支持 `kind: system` 的系统服务管理，工具可选 `auto`、`systemctl`、`service`，以覆盖
    Ubuntu/CentOS 常见 systemd 系统及旧式 `service` 兼容场景；
  - 支持 `kind: script` 的 start/stop/restart 脚本管理；
  - 系统服务和脚本管理互斥。
- 保持受管配置、服务生命周期与 App 脚本的所有权唯一。
- 移除 App v2/v3/v4 装载兼容路径，旧版本配置装载时直接明确拒收。
- 更新类型、装载校验、计划/执行器、安全边界和受影响的历史记录/执行逻辑。
- 更新技能模板与参考文档、配置指南和示例 `app.yaml`。
- 增加覆盖装载、计划、执行、跨发行版服务工具选择、旧 schema 拒收和失败路径的测试。

### Out of scope

- 不迁移用户已有 App v2/v3/v4 配置；这些旧版本装载会直接失败。
- 不执行真实 SSH、部署、环境安装或服务操作。
- 不虚构示例机器、路径、包来源或服务命令。
- 不在本次引入 Windows 或非 Linux 服务管理器。

### Boundary with neighboring modules

- Environment 的 `install`/`manager` 语义继续由 environment 配置和 runtime 负责；App 新契约只在
  App 装载、打包、计划和执行范围内生效。
- App 版本与制品信息继续放在 `app_versions.yaml`；本任务不调整制品协议。
- 密钥放置仍由 `cluster.yaml.secrets` 声明，配置模板不得内联秘密。

## Requirement Review

需求合理：当前 App 配置契约把文件配置和服务管理耦合在 `management.actions` 中，跨发行版系统服务
能力也没有显式暴露给 App。改成 Environment 风格的 `configs` 与 `management` 可以降低复杂场景下的
声明歧义，并支持脚本配置、脚本服务和 Ubuntu/CentOS。

提案采用全新 **App schema 1**：

- App 顶层 `schema_version` 只接受 `1`；
- schema 1 使用顶层 `configs` 和 `management`；
- 旧 App v2/v3/v4 配置不再兼容，装载时直接明确拒收；
- schema 1 `configs` 条目不含 `name`，统一由 `kind` 区分 script/file；
- 受管配置仍由控制端生成确定性骨架，脚本配置由受权限白名单约束的 App 脚本执行；
- 系统服务通过 `tool: auto|systemctl|service` 支撑 Ubuntu/CentOS；`auto` 在目标节点探测
  systemd，失败时可回退 `service`，而显式 `systemctl`/`service` 不再自动换工具。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-001 | 新 App schema 1 配置契约支持多个 `configs` 段，每段直接以 `kind` 选择 script 或 file | 条目不含 `name`；script 与 file 互斥；受管配置与 `scripts.configure` 互斥；标识唯一；旧 schema 拒收 | 这是破坏性契约重写，旧配置将不可装载 | 装载/计划测试证明多段、脚本、文件、唯一性、旧版本拒收及冲突规则按预期 | 不迁移旧配置 |
| P-002 | CHG-002 | App 管理支持 system/script 服务，system 服务覆盖 Ubuntu/CentOS | 同一 App 只能选择 system 或 script；服务与 start/stop/restart 脚本互斥 | 需要服务工具探测、执行与失败报告 | 单元/执行测试覆盖 systemctl、service 和脚本管理 | 不支持非 Linux 服务管理 |
| P-003 | CHG-003 | 更新文档、模板、示例与交付说明 | 不替换集群名、真实机器或现有非相关配置；示例中的环境保持 Ubuntu/CentOS 明确区分 | 文档与模板需同步维护 | 指南/技能说明与配置装载规则一致，示例通过静态/配置测试 | 不提供通用安装器 |

## Success Criteria

- Concrete user-visible or system-visible result: 用户使用 `app.yaml schema_version: 1` 的
  `configs` 和 `management` 声明多配置段；每个配置段不写 `name`，直接用 `kind: script|file` 选择
  脚本或文件配置；管理可选择系统服务或脚本管理；系统服务声明可在 Ubuntu 和 CentOS 场景下使用
  适当工具。
- Required evidence: 配置装载、计划生成、执行器行为、旧 schema 拒收、安全边界和跨发行版工具选择
  通过；`deno check` 与项目测试通过；文档/模板与实现一致。
- Explicit non-goals: 不执行实际部署；不迁移旧 schema；不放宽制品哈希、密钥、权限或沙盒边界。

## Risks

- 共享契约风险：schema 1 是破坏性变更，旧 App v2/v3/v4 配置、已有模板、指南和历史记录的解码
  路径会不兼容，必须在错误信息和测试中明确失败。
- 部署/回滚风险：配置脚本和服务脚本的可恢复性、幂等性与失败路径不如受管文件/service 原语可控。
- 跨发行版风险：`auto` 探测可能遇到 systemd/旧 init 差异、CentOS 版本差异或 sudo 权限差异。
- 安全风险：脚本配置和脚本服务必须继续执行权限白名单、降权、秘密注入和失败关闭策略。
- 文档/模板风险：技能与指南示例若落后于 schema，会引导用户写出无法装载的配置。
