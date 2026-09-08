---
task_manifest: task.yaml
status: approved
---

# 提案：删除 App 顶层秘密声明，绑定直接引用 cluster.yaml 秘密

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务删除 app.yaml（及环境定义）顶层
  `secret_values`/`secret_files` 声明契约，改变 v3 配置文件的合法字段集与脚本秘密交付语义（loader
  可见面），属公开配置契约的破坏性变更，并触及秘密交付的最小化边界；与 047/048 同类
  schema/装载契约变更一致，按 high-risk 全生命周期执行。
- Proposal and tier confirmation: 用户于 2026-09-05 确认「确认，自动完成」并裁定：问题 1 采用方案
  A（App 步骤交付本机 cluster 声明的全部秘密、脚本 loader 零声明全量可见）；问题 2
  环境定义同型顶层列表一并移除；问题 3 在 schema v3 内收窄（字段拒收 +
  定向迁移错误文案）。授权自动完成全生命周期。

## Background and Goal

当前 App 要使用任何秘密，必须在 app.yaml 顶层预先声明 `secret_values`/`secret_files`，再由 managed
配置绑定或脚本 loader 引用；cluster.yaml.secrets 已声明每个秘密的 `kind`（value/file）与
`machines`（放置），App 顶层列表构成第三次重复（cluster 声明 + 绑定引用 +
顶层声明）。用户指出：错误防护不依赖顶层声明——绑定引用未声明/类型不符的秘密在装载期即被 cluster
校验拒绝（`validateSecret`），运行期取不到也会报错；即使预先声明，该出错时照样出错。

目标是收敛声明点：**cluster.yaml.secrets 成为秘密的唯一声明处**。App
配置绑定（yaml/json/toml/ini/template/script updater 的 secrets）直接引用 cluster
已声明且放置到本机的秘密；引用失败在装载期报错并指明原因，运行期缺失按既有失败关闭路径报错。

## Scope

### In scope

- 删除 app.yaml 顶层 `secret_values`/`secret_files` 的解析、校验（含两列表互斥检查）与
  `declaredManagedSecret` App 级 allowlist 门禁；managed 绑定直接对 cluster.yaml 声明做「存在 +
  kind + 本机放置」校验。
- 对被移除的两个字段给出定向拒收错误文案（指明「App 直接引用 cluster.yaml.secrets
  声明」的迁移方向）。
- 调整步骤秘密集合与 loader 交付推导（语义取决于下方待确认问题 1），同步 history 快照校验与 CLI
  序列化。
- 环境定义脚本同型的顶层秘密列表按待确认问题 2 决定是否同步移除。
- 同步测试夹具与用例（删除顶层声明断言、新增「绑定直连 cluster」正/负例）、README
  与集群配置指南的声明模型表述。

### Out of scope / explicit non-goals

- 不改 cluster.yaml.secrets 的声明格式（kind/machines 语义不变）。
- 不新增加密、轮换、按 App 精细授权等新能力；机器放置仍是唯一的部署侧隔离旋钮。
- 不改远端 config_updater 协议、bundle 成员形态与失败关闭行为（048 刚验收）。
- 不提供自动迁移工具；既有含顶层声明的 v3 文件装载即失败并给出迁移方向。

## Requirement Review

- 请求合理：错误防护确实不依赖 App 级声明（cluster 装载校验 +
  运行期失败关闭已覆盖），顶层列表对「纯配置型 App」是纯样板；收敛到 cluster
  单一声明点减少三处重复，方向成立。
- 主要权衡（需用户知情确认）：顶层列表是当前唯一低于机器粒度的秘密隔离机制。删除后脚本 loader
  的可见面变为机器范围（问题 1 方案 A）——同机多 App 的脚本都能读取本机全部秘密，最小交付边界让位于
  cluster.yaml 的 machines 放置声明；操作者通过把秘密放置到不同机器来实施隔离。
- 选定方向：删除 App/环境定义顶层声明，绑定直连 cluster 校验，交付语义按问题 1/2 的确认结果落地。

## 已确认问题（Confirmed Decisions）

1. **脚本 loader 秘密语义**：方案 A——App 步骤交付该机器上 cluster 声明的全部秘密，脚本 loader
   全量可见（无任何新声明，最贴近「直接用 cluster 变量」）；方案
   B——步骤秘密集合仅由该步骤实际消费的绑定推导，普通 lifecycle 脚本 loader 将拿不到秘密（041 loader
   场景收窄到 managed script updater 的显式 secrets 列表）。**已确认：方案 A。**
2. **环境定义脚本**：environment
   定义脚本现有同型顶层秘密列表，是否一并移除以保持单一模型？**已确认：一并移除。**
3. **版本策略**：在 schema v3 内直接收窄（两个字段变为未知字段并给出定向错误）还是新增 schema
   v4？**已确认：v3 内收窄**——示例集群与夹具几乎不使用这两个字段，定向错误文案清晰指引迁移，符合 047
   的字段级删除先例精神。

## Proposal Items

| proposal_id | change_id                    | requirement                                                                                                                                                                                                            | boundary                                                                                                                             | tradeoff                                                                               | success_evidence                                                                                                           | non_goal                                    |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| P-001       | CHG-cluster-secret-bindings  | 删除 app.yaml（及问题 2 确认的环境定义）顶层 secret_values/secret_files 解析与 declaredManagedSecret 门禁；managed 绑定（含 template 与 script updater secrets）直接校验 cluster.yaml 声明（存在 + kind + 本机放置）。 | 只改 src/config.ts 装载面与 src/types.ts 公开类型；不动 cluster.yaml 语义、远端协议与 048 template 语义（占位符/失败关闭规则不变）。 | 少一层声明换取装载期错误信息更依赖 cluster 校验文案；同机隔离改由 machines 放置承担。  | 含顶层声明的 v3 文件装载即报定向迁移错误；绑定直连 cluster 的正/负例（未知秘密、kind 冲突、未放置本机）全部按预期报错。    | 不自动改写任何既有配置文件。                |
| P-002       | CHG-secret-delivery-planning | 步骤秘密集合与 loader 交付推导按问题 1 确认的语义重写（A：机器范围推导；B：绑定并集推导），history 快照校验与 CLI 序列化同步。                                                                                         | 只改 src/planning.ts、src/history.ts、src/cli.ts、src/mod.ts；plan schema 字段形状不变，快照版本兼容性按设计阶段裁定。               | 方案 A 放弃步骤级最小交付，换取脚本零声明可用；方案 B 保持最小交付但收窄 loader 场景。 | 计划步骤秘密集合与所选语义逐字段一致；history 校验不变量（managed secret ∈ 步骤集合）保持成立；cli_human_output 回归通过。 | 不改 plan schema version 与远端执行器协议。 |
| P-003       | CHG-secret-docs-tests        | 夹具/用例删除顶层声明并新增直连 cluster 正负例；README 与集群配置指南收敛为「cluster.yaml.secrets 唯一声明点 + 绑定直接引用」模型。                                                                                    | 只覆盖本任务相关测试与文档；示例集群不使用顶层声明，无需迁移。                                                                       | 验证面较大但契约级覆盖是回归底线。                                                     | 全量 `deno task check` 通过；文档与错误文案一致；contract 断言新模型关键表述。                                             | 不为旧声明模型保留兼容示例。                |

## Success Criteria

- 可见结果：app.yaml 不再需要（也不再接受）顶层
  `secret_values`/`secret_files`；配置绑定与脚本按确认语义直接使用 cluster.yaml
  声明的秘密，引用失败即报错且信息指明原因。
- 必要证据：`deno task check` 通过；相关 unit/integration/contract
  用例跑绿；任务作用域统一入口运行制品全绿；变更记录与验收报告完整。
- 显式非目标：不迁移既有文件、不新增授权粒度、不动远端协议。

## Risks

- 契约破坏：既有 v3 集群若使用顶层声明，升级后装载失败（有定向错误文案，无自动迁移）。
- 交付面扩大（方案 A 时）：同机多 App 脚本共享本机秘密可见性，最小交付边界由 machines
  放置声明替代；需在指南中明确写为安全模型。
- 语义歧义风险：问题 1/2/3 未确认前不进入设计，避免交付面与用户意图偏离。
