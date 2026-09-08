---
task_manifest: task.yaml
status: draft
---

# Proposal：修复首次 versioned 服务激活的路径与残留失败状态

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: pending
- Tier rationale / triggered boundaries: 修复影响内置 versioned App 的 systemd
  启动路径和失败恢复行为。根因明确、改动集中在示例配置和一个状态读取分支；
  无 schema、安全边界或持久化格式变更，适合 standard。
- Proposal and tier confirmation: pending user confirmation.

## Background and Goal

最新部署已能把 `jx-server.service` 发布给 systemd，但启动失败：

```text
jx-server.service: Changing to the requested working directory failed:
No such file or directory
Main process exited, code=exited, status=200/CHDIR
```

远端实际布局是内置 versioned 发布根 `/home/ubuntu/eleph-server`，载荷位于
`latest/server/`；`latest -> 0.1.0` 存在，但 `current` 不存在。当前 App 配置
却声明 `working_directory: current`，与统一 latest 布局不一致。

服务启动失败后，恢复流程会删除新发布的 unit。此时 unit 文件已不存在，但
systemd 仍保留 `failed` 状态，`systemctl is-active` 返回 `failed`/exit 4。
当前缺失 unit 状态读取只接受 `inactive` 或 `not-found`，导致补偿恢复报
“恢复不完整”。

目标是让首次部署使用实际的 latest 载荷路径启动服务，并在缺失 unit 的补偿
读取中接受 systemd 残留的失败状态，使失败恢复完整。

## Scope

### In scope

- 将 Multipass 示例 `jx-server` 的 managed service 工作目录从 `current` 改为
  `latest/server`，同步 template 与 live 配置。
- 保持 `ExecStart=/usr/bin/java -jar jx-server.jar` 相对新工作目录解析，使实际
  启动 `/home/ubuntu/eleph-server/latest/server/jx-server.jar`。
- 更新示例契约、版本化发布集成测试和 README 中相应的路径语义。
- 在 `systemctl is-enabled` 明确返回 `not-found`/exit 4 的前提下，接受
  `systemctl is-active` 的已知非运行状态（包括 `inactive`、`failed`、
  `unknown`、`not-found`）且退出码为 4，作为缺失 unit 基线。
- 增加单元和契约回归覆盖：正确 latest 启动路径、缺失 unit 残留 `failed`
  状态可恢复、其他异常仍失败关闭。

### Out of scope / explicit non-goals

- 不改回或重建 `current` 符号链接；统一 latest 布局是既有设计。
- 不在激活前做服务健康检查，不新增应用级 readiness gate。
- 不修改 systemd unit 渲染器、App schema、计划顺序、回滚算法或 CLI 输出契约。
- 不手工修复远端状态；真实 Multipass 验证由修复后的下一次部署完成。
- 不扩大已有 unit 的 active 状态读取语义。

## Requirement Review

- 请求合理：服务配置仍引用旧布局路径，同时失败恢复遗漏了 systemd 在 unit 文件
  删除后可能保留 `failed` 状态的实际行为。
- 主要权衡：把示例路径切换到 `latest/server` 依赖 versioned release 已有的
  latest 原子切换语义；这比新增 current 别名更符合当前设计，也避免两份当前版本
  指针。
- 选定方向：先让 unit 引用实际载荷路径；再只在 enabled 查询确认 unit 缺失时，
  放宽 active 查询的明确非运行状态，保证失败补偿能读取基线。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-versioned-service-path | `jx-server` 从 `latest/server` 作为工作目录启动。 | 仅调整 Multipass 示例的 template/live 配置和对应契约/文档。 | 使用已有 latest 原子切换，不新增 current 指针。 | 契约测试确认 working directory 和 JAR 相对路径。 | 不改变制品布局。 |
| P-002 | CHG-missing-unit-failed-state | 缺失 unit 的残留 `failed` 状态不阻断失败恢复。 | 前提是同一 unit 的 enabled 状态明确为 `not-found`/exit 4；只接受已知非运行输出且 exit 4。 | 缺失 unit 的 active 输出按非运行状态处理，但不放开已有 unit 的异常。 | 单元测试覆盖 `failed` 基线并保留未知异常拒绝。 | 不吞掉 systemd/权限故障。 |

## Success Criteria

- Concrete user-visible or system-visible result: 下一次 Multipass deploy 的
  `jx-server:activate` 能发布 unit 并以
  `/home/ubuntu/eleph-server/latest/server` 为工作目录启动服务；如果启动仍失败，
  恢复流程也能完整回滚并明确报告启动失败，而不是“恢复不完整”。
- Required evidence: 新增/更新 systemd 单元测试、示例契约测试、versioned
  release 集成测试通过；类型检查、lint、格式检查和全量测试通过。
- Explicit non-goals: 本任务不保证应用本身一定能启动成功；若 Java、数据库或
  应用配置仍失败，会作为清晰的服务启动失败暴露。

## Risks

- `latest/server` 依赖制品内保留 `server/` 目录；示例契约会固化这一布局，制品
  布局变化需同步调整配置。
- 缺失 unit 状态读取放宽过多可能掩盖故障；通过 enabled `not-found` 前提、exit 4
  和已知非运行状态列表控制范围。
- systemd 在 unit 文件删除后保留 failed 状态属于目标机状态；补偿读取不会清除
  该状态，仅保证恢复流程能完成。
