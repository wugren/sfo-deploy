---
task_manifest: task.yaml
status: approved
---

# 提案：消除 Multipass prepare 内联 validate 的 Deno 环境确认

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 修复本地示例 prepare 的内联 Deno `validate`
  调用。Deno 运行时权限提示发生在集群校验初始化读取用户主目录时；修复将授予
  `HOME` 与 Windows `USERPROFILE` 的最小环境读取权限。不授予通用环境访问，不改变
  validate 逻辑、集群 schema、部署行为、SSH 信任或安全边界。
- Proposal and tier confirmation: 用户于 2026-09-12 16:58:22 (CST) 确认提案并选择
  `standard`；确认授权实施、验证、独立缺陷审查与收尾。

## Background and Goal

用户运行 `prepare-multipass.sh` 时，Deno 在内联 CLI `validate` 阶段请求环境访问
`HOME` 并显示 `Allow? [y/n/A]`。原因是两条 prepare 脚本调用 CLI 时只授予
`--allow-read`，而 CLI 初始化装载用户配置会读取 `HOME`（Windows 为
`USERPROFILE`）。目标是在不交互确认的前提下完成 validate。

## Scope

### In scope

- 将 `prepare-multipass.sh` 中内联 validate 的 Deno 参数从 `--quiet --allow-read`
  改为 `--quiet --allow-read --allow-env=HOME,USERPROFILE`。
- 将 `prepare-multipass.ps1` 中同一调用同步为相同最小权限。
- 保持 validate 的配置根、集群名称、退出码与非零失败处理不变。

### Out of scope

- 不授予 `--allow-env` 全量环境访问。
- 不改变示例 `deno.json` 的 `eleph-deploy` 任务权限。
- 不改变真实 hosts 写入、VM 删除重建、SSH trust bundle 或 sfo-deploy CLI 行为。

## Requirement Review

请求合理。提示不是 hosts 写入确认，而是 Deno 权限系统在 CLI 初始化时请求 `HOME`。
使用 `--allow-env=HOME,USERPROFILE` 与示例 `eleph-deploy` 任务的现有权限一致：Linux/
macOS 需要 `HOME`，Windows 需要 `USERPROFILE`，跨平台脚本可同时声明，不会扩大到全部
环境变量。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-multipass-validate-env | prepare 内联 validate 可直接读取 `HOME` 或 `USERPROFILE`，不再弹出 Deno 环境权限确认。 | 仅限两个 prepare 脚本的内联 validate Deno 进程；只允许 `HOME,USERPROFILE`。 | 允许 CLI 读取用户主目录以定位用户配置，换取非交互运行。 | 两条调用均包含 `--allow-env=HOME,USERPROFILE`；Deno 权限解析接受该参数且脚本语法检查通过。 | 不授予全量环境权限。 |

## Success Criteria

- 两条 prepare 脚本的内联 validate 调用均包含
  `--allow-env=HOME,USERPROFILE`。
- Deno 不再因 CLI 初始化读取用户主目录而提示 `Allow? [y/n/A]`。
- `bash -n examples/eleph-server-multipass/prepare-multipass.sh` 通过。
- 若环境提供 `pwsh`，`prepare-multipass.ps1` 语法解析通过。

## Risks

- 环境权限从只读扩展到两个主目录变量；这是 CLI 初始化所需的最小范围。
- 若用户主目录缺失，CLI 仍应按现有配置错误失败，不引入兜底读取其他环境变量。
