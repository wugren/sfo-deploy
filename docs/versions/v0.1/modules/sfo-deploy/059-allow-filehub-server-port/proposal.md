---
task_manifest: task.yaml
status: approved
---

## Workflow Tier Judgment

- 建议层级：standard
- Final tier: standard
- 判断依据：这是 filehub 发布 source 契约及其验证测试的有边界缺陷修复。它会影响部署兼容性和回退快照行为，因此不属于 trivial；目前没有确认的持久化迁移、跨项目边界或要求完整 high-risk 生命周期阶段的风险触发条件。
- 确认记录：用户已确认本提案和 `standard` 层级；进入实施阶段。机械检查读取的最终层级字段为
  `Final tier: standard`。

## Background and Goal

发布历史快照会把 filehub target 严格规范化为四段。当前正则不允许第一段包含冒号，因此示例支持的
服务地址 `filehub.mynode.site:8443` 会触发以下错误：

`发布历史中的 filehub target 必须是规范四段 SERVER/PROJECT/VERSION/NAME`

目标是允许 server 段携带显式 TCP 端口，同时继续要求 target 保持规范四段。

## Scope

### In scope

- 允许 filehub target 的 `SERVER` 段为 `host` 或 `host:port`。
- 其余 `PROJECT/VERSION/NAME` 段继续沿用现有安全字符规则。
- 增加聚焦的发布 source codec 测试，覆盖无端口、带端口、非法端口和非法段形状。
- 按 standard 工作流维护轻量变更记录和完成报告。

### Out of scope

- 不修改 `filehub` CLI 调用、认证方式、网络协议，或除第一段支持端口之外的目标语义。
- 不加入通用 URL 解析、IPv6 语法、用户名/密码、query、fragment 或任意 authority 语法。
- 不修改本地包缓存行为，也不新增部署动作。

## Requirement Review

该需求合理：仓库自身的 multipass 示例和更新脚本已经有意生成包含 `host:port` 的第一段，但发布
source codec 会拒绝它。采用窄修复：把安全的 server 段与其他段区分开，只允许一个可选数字端口。
这样既支持回退快照校验，也不会把 filehub target 放宽成任意 URL。

## Proposal Items

| proposal_id | change_id | Requirement | Success evidence |
| --- | --- | --- | --- |
| P-001 | CHG-filehub-server-port | filehub 的 `ReleaseSourceCodec` 接受规范四段 target，其中第一段可为 `host` 或 `host:port`。 | 发布 source 导出/导入聚焦测试通过示例形态和无端口形态。 |
| P-002 | CHG-filehub-server-port | 聚焦测试验证带端口 target 可接受，并在端口非法、段数错误或其他段包含不安全字符时关闭失败。 | 聚焦测试构造 65536、0、段数错误和非安全字符 target，全部断言抛出 `DownloadError`。 |

## Success Criteria

- 示例形态 `filehub.mynode.site:8443/eleph-server/0.1.0/jx-server` 能通过发布 source 的导出和导入。
- 不带端口的原有 target 仍然有效。
- 非法 target 形状和非法端口仍会抛出 `DownloadError`。
- 聚焦 Deno 测试通过。

## Risks

- 接受范围过宽会削弱发布快照校验。缓解方式是只允许第一段有一个可选数字端口，并保持其他段规则不变。
- 兼容性：以前被拒绝的 `host:port` target 将被接受；这是本次请求的行为，不改变既有有效 target。
