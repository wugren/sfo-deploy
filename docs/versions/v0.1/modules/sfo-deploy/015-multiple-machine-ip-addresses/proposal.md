---
task_manifest: task.yaml
status: approved
---

# 集群机器多 IP 地址支持提案

Risk profile: not-created

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: standard
- Tier rationale / triggered boundaries: `private_ip`、`public_ip`
  是对外配置契约；将单地址扩展为多地址还会改变 SSH 连接重试、计划输出与发布历史快照/回放行为，触发
  contract、runtime 与 compatibility 边界。
- Proposal and tier confirmation: 用户已确认本提案，并明确选择按 `standard`
  层级完成；该选择低于建议的 `high-risk`，已向用户提示公开契约、运行时重试和历史兼容风险。

## Background and Goal

当前每台机器的 `private_ip` 与 `public_ip` 最多只能配置一个 IP，规划阶段各自只能解析出一个 SSH
目标。目标是让两类地址都能配置多个候选
IP，并在不破坏现有单值配置和既有区域选路规则的前提下实际用于连接。

## Scope

### In scope

- `machines.yaml` 的 `private_ip`、`public_ip` 同时接受原有单个 IP 字符串和新增的非空 IP 列表。
- 加载后将地址规范化为保持声明顺序的不可变候选集合；逐项校验 IP，拒绝空列表、非法值和重复值。
- 继续按 `executor_region` 或 `--address-kind` 选择 private/public
  类别，只在选中的类别内按配置顺序尝试 SSH 地址，首次成功后停止。
- 保持现有单地址配置、计划主地址/`address_kind`
  输出和旧发布历史记录可读取；新历史数据完整保留候选地址及实际选中地址。
- 更新配置说明、示例和覆盖配置校验、地址选择、连接回退、错误聚合、历史兼容的测试。

### Out of scope

- 不在 private/public 两类之间自动降级或切换。
- 不做 DNS、负载均衡、并发竞速连接、连接健康打分或持久化优先级学习。
- 不改变机器名称、region、SSH 用户/端口/密钥等其它配置语义。

### Boundary with neighboring modules

配置加载与领域模型拥有候选地址；规划负责选择地址类别与有序候选集；SSH
传输负责同类候选地址的串行连接；CLI 和发布历史只扩展必要的兼容表示，不改变部署动作与环境/App 编排。

## Requirement Review

该需求合理：多网卡、多出口或地址切换场景需要同一类别的多个候选地址。仅让 YAML
接受列表但仍永久使用首项不能形成完整可用能力，因此选择在传输建立阶段提供有序回退。为避免不可控路由和安全边界扩大，回退严格限制在规划选定的
private 或 public 类别内，并对每个候选地址继续执行严格 known-host
校验。旧的单字符串写法继续有效，减少现有集群配置和历史数据迁移成本。

## Proposal Items

| proposal_id | change_id                         | requirement                                                         | boundary         | tradeoff                           | success_evidence                                                        | non_goal                    |
| ----------- | --------------------------------- | ------------------------------------------------------------------- | ---------------- | ---------------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| P-001       | CHG-multiple-machine-ip-addresses | `private_ip`、`public_ip` 支持有序多 IP，并在选定类别内串行连接回退 | 不跨地址类别回退 | 连接全失败时总等待时间随候选数增加 | 单值/列表加载测试、规划测试、传输回退与错误测试、历史兼容测试、文档示例 | DNS、并发拨号、动态健康检查 |

## Success Criteria

- Concrete user-visible or system-visible result: 用户可在一台机器的 `private_ip` 和/或 `public_ip`
  中配置多个 IP；首个地址无法连接时自动尝试同类下一地址，计划与错误输出能够反映候选/实际地址。
- Required evidence:
  新旧配置格式均通过；非法/空/重复列表被拒绝；区域与显式地址类型选择不变；连接按声明顺序回退且每次严格校验主机密钥；全部失败时包含各候选失败信息；旧历史可读取，新历史可重放；相关定向测试通过。
- Explicit non-goals: 不跨 private/public 回退，不引入地址探测服务，不改变部署步骤筛选和依赖关系。

## Risks

- 配置与 Python 公共模型从可选字符串扩展为候选集合，需要明确兼容输入和序列化格式。
- 自动重试会延长全部地址不可用时的失败时间；保持串行、确定顺序，错误中汇总每次失败以便诊断。
- known-host 条目按实际候选 IP 校验；任何未知或错误主机密钥都不能因回退而被宽松接受。
- 发布历史需同时兼容既有单地址快照与新多地址快照，避免破坏 rollback/replay。
