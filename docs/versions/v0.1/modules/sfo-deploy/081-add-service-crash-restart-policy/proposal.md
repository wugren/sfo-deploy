---
task_manifest: task.yaml
status: approved
---

Risk profile: ./risk-profile.yaml

# Proposal：App service unit 支持声明崩溃拉起策略

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 该需求会扩展 `app.yaml` 的 service 配置
  契约、改变框架生成的 systemd unit 内容，并影响服务崩溃后的部署运行时行为。
  这是公共配置 schema 和 deployment/runtime 行为变更，不是普通局部修复，因此建议
  high-risk。
- Proposal and tier confirmation: 用户于 2026-09-11 确认显示的提案并选择
  `high-risk`；授权完整设计、实现、测试、独立验收与收尾。

## Background and Goal

当前 `management.kind: service` 可以声明 systemd 服务；当提供 `unit_config` 时，框架
会生成一个确定性 systemd unit。现有 unit 只包含 `Type=simple`、`User`、
`WorkingDirectory`、`ExecStart` 和 `WantedBy`，没有声明 `Restart` 或启动频率限制。
因此进程崩溃后 systemd 不会自动按用户期望拉起新实例，App 配置也无法表达这一策略。

目标是在 `service.unit_config` 中提供可审阅的崩溃拉起配置，并在生成 systemd unit 时
映射为对应的 systemd 指令。未声明时保持现状，继续由 systemd 缺省行为决定，不引入隐式
变更。

## Scope

### In scope

- 在 `service.unit_config` 下新增可选字段：
  - `restart_policy`: 枚举 `no`、`on-success`、`on-failure`、`on-abnormal`、
    `on-watchdog`、`on-abort`、`always`；
  - `restart_sec`: 非负整数秒；
  - `start_limit_interval_sec`: 非负整数秒，`0` 表示禁用启动频率限制窗口；
  - `start_limit_burst`: 非负整数。
- 新增字段必须与 `tool: systemctl` 或 `tool: auto` 的 managed unit 一起使用；继续禁止
  `tool: service` 与 `unit_config` 搭配。
- 渲染规则：
  - `restart_policy` 映射为 `[Service] Restart=`；
  - `restart_sec` 映射为 `[Service] RestartSec=<N>s`；
  - `start_limit_interval_sec` 和 `start_limit_burst` 映射为 `[Unit]`
    `StartLimitIntervalSec=` 与 `StartLimitBurst=`；
  - 未声明字段不写入 unit，保持既有渲染结果不变。
- 扩展配置装载校验、类型定义、systemd unit 渲染测试和配置解析测试。
- 更新 README 与集群配置技能中的 `unit_config` 契约说明，并让版本化模板展示
  `on-failure` 的推荐崩溃拉起写法。

### Out of scope / explicit non-goals

- 不修改没有 `unit_config` 的既有外部 systemd unit；框架不应为了重启策略改写用户维护
  的 unit。
- 不支持 SysV `tool: service` 的崩溃拉起；SysV 没有同等的声明式重启语义。
- 不新增应用健康检查、readiness probe、应用级看门狗、远端轮询拉起或 Docker 式
  `unless-stopped` 策略。
- 不改变服务启停顺序、部署补偿、回滚算法、systemd enable 状态或 `on_deploy` 语义。
- 不迁移旧 schema；旧 `app.yaml` 缺少新字段时必须继续加载。

## Requirement Review

请求合理：崩溃拉起是服务交付的常见需求，而框架已经在 `unit_config` 中拥有生成
systemd unit 的职责。把策略放在同一位置可以保持“服务如何运行”的声明聚集在一起。

备选方案与取舍：

- 方案 A（选定）：扩展 `unit_config`，显式映射到 systemd 原生 `Restart`、`RestartSec`
  和启动限流指令。语义清晰，不隐式启用自动重启，缺省保持向后兼容。
- 方案 B：在 `management` 层添加通用 `crash` 字段。缺少 `unit_config` 时框架无法安全
  修改外部 unit，容易产生看似可配置但不生效的契约；因此不采用。
- 方案 C：为没有 `unit_config` 的外部 unit 提供远端编辑。会引入改写系统文件、定位
  drop-in 和与运维手工修改冲突的高风险面；超出本次请求，列为非目标。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-service-restart-policy-schema | `unit_config` 可声明 systemd 崩溃拉起策略和启动限流。 | 仅作用于框架生成的 managed systemd unit；枚举与数值在装载期校验。 | 语义绑定 systemd；换取可预测、可测试的原生行为。 | 解析/渲染测试确认字段映射、缺省不渲染和非法值失败关闭。 | 不支持应用级健康判断。 |
| P-002 | CHG-service-restart-policy-template-doc | 配置契约和模板展示推荐的 `on-failure` 崩溃拉起写法。 | 只更新文档、集群配置技能模板与对应契约断言。 | 模板会主动展示能力，但用户仍需显式部署后生效。 | 契约测试确认模板包含示例字段；文档与实现一致。 | 不自动改既有集群配置。 |

## Success Criteria

- Concrete user-visible or system-visible result: 用户在 `app.yaml` 的
  `service.unit_config` 中声明 `restart_policy: on-failure` 等字段后，框架生成的
  systemd unit 包含对应的 `Restart`/`RestartSec`/`StartLimit*` 配置；服务异常退出时由
  systemd 按声明拉起。
- Required evidence: 新增单元测试覆盖所有合法策略、字段缺省不渲染、非法策略/负值/缺失
  `unit_config` 的失败路径；现有类型检查、格式检查和测试通过；文档示例与实现一致。
- Explicit non-goals: 不验证远端进程真的被拉起；该结果由 systemd 保证，框架只负责生成
  并发布受管 unit。

## Risks

- systemd 版本差异可能影响 `StartLimitIntervalSec` 的位置或可用性；以现代 systemd 的
  `systemd.unit(5)` 语义为准，仅支持声明式映射，不做远端版本探测。
- 自动重启可能掩盖业务缺陷或反复重启；通过可选启动限流和文档说明限制，但不替用户选择
  策略。
- 未提供 `unit_config` 的配置不能声明新字段，可能让部分用户觉得受限；这是为避免框架改写
  外部 unit 而保留的明确边界。
