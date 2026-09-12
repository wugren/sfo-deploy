---
task_manifest: task.yaml
status: approved
---

# 提案：prepare-multipass.sh 默认 Ubuntu 26.04 并确认 hosts 静默更新

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 改动限定在本地示例 Multipass prep 脚本与说明。
  Ubuntu 镜像默认值影响新建 VM 的基础镜像，但不改变 sfo-deploy schema、部署/回滚协议、
  安全边界、持久化数据或生产发布面。hosts 行为目标是保持脚本内直接更新且无交互确认；
  现有路径未见 `read`/`Read-Host` 等二次确认。该要求用于核对并维持现有行为，而非引入
 新的跨项目集成或高风险变更。
- Proposal and tier confirmation: 用户于 2026-09-12 16:42:38 (CST) 确认提案并选择
  `standard`，同时追加要求 `prepare-multipass.ps1` 的 Ubuntu 默认镜像同步修改；确认授权
  实施、验证、独立缺陷审查与收尾。

## Background and Goal

`prepare-multipass.sh` 当前变量默认为 `ubuntu_image="24.04"`，但 usage 文案仍写着默认
`22.04`，README 也描述两个脚本默认 `22.04`。用户要求 bash prep 的 Ubuntu 镜像使用 26.04。
同时希望脚本改写 hosts 时不再次提醒确认；需要核对该路径并保持无交互确认。

## Scope

### In scope

- 将 `prepare-multipass.sh` 的 `ubuntu_image` 默认值改为 `26.04`。
- 将 usage 中默认 Ubuntu 镜像文案改为 `26.04`。
- 将 `prepare-multipass.ps1` 的 `$UbuntuImage` 默认值改为 `26.04`。
- 更新 README 中两个 prep 脚本的默认镜像描述。
- 核对 hosts 更新路径无脚本级二次确认；若实现确认无确认提示，则不添加或移除相关代码，
  仅在变更记录中保留证据。

### Out of scope

- 不修改除默认镜像外的 PowerShell 参数接口或行为。
- 不改变 hosts 的目标主机名、写入路径、权限提升策略或原子写回逻辑。
- 不绕过 `sudo` 的密码/权限认证；该提示属于系统权限认证，不是脚本二次确认。
- 不改变 VM 删除重建策略、SSH trust bundle、配置生成或部署流程。

## Requirement Review

请求合理且边界清楚：示例脚本的默认镜像更新属于有影响的配置默认值，但仅作用于用户显式
运行的本地示例环境重建。当前实现中 hosts 更新发生在集群信任包发布后，直接构造更新文件并
通过直接写或 `sudo install` 写回；没有发现脚本级 `read` 确认。将其保持为静默执行符合用户
目标，同时保留系统级权限认证以避免要求或伪造免密 sudo。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-multipass-ubuntu-26-04 | `prepare-multipass.sh` 与 `prepare-multipass.ps1` 默认使用 Ubuntu `26.04`。 | 只改默认值和对应说明；显式镜像参数仍可覆盖。 | 新默认 VM 使用更新基础镜像，本地 Multipass 版本需能访问该镜像。 | 两个脚本变量/参数与 usage、README 均为 `26.04`。 | 不改变参数接口。 |
| P-002 | CHG-multipass-hosts-no-confirm | hosts 更新在脚本内保持无二次交互确认。 | 仅限现有 `test.eleph-label.com` 更新路径；sudo 密码/权限提示保持不变。 | 自动化体验更直接，但不会额外要求用户确认 hosts 变更。 | 检查 `update_hosts_entry` 及调用路径，证明无 `read`/交互确认；静态检查通过。 | 不删除或绕过 sudo 认证。 |

## Success Criteria

- `prepare-multipass.sh` 与 `prepare-multipass.ps1` 在未提供镜像参数时均使用 `26.04`。
- `--help` 显示默认 Ubuntu 镜像为 `26.04`。
- README 中两个脚本默认镜像描述准确且保持一致。
- hosts 更新路径无脚本级二次确认；`update_hosts_entry` 失败仍 fail-closed。
- `bash -n examples/eleph-server-multipass/prepare-multipass.sh` 通过；若环境提供 `pwsh`，
  PowerShell 语法解析通过。

## Risks

- 26.04 镜像在 Multipass 上的可用性取决于本地 Multipass 版本和镜像源；若不可用，可用
  `--ubuntu-image` 或 `-UbuntuImage` 显式回退。
- hosts 直接更新是用户要求的行为；sudo 密码提示仍可能出现，脚本不会也不应绕过系统认证。
