---
task_manifest: task.yaml
status: approved
---

# 提案：prepare-multipass.sh 不再用 cluster-template 整体替换 clusters/multipass

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 仅修改本地示例 `prepare-multipass.sh` 的重建语义，
  不触碰框架 CLI、集群 schema、SSH 信任边界之外的公共契约。
- Proposal and tier confirmation: 用户于 2026-09-13 确认提案并选择 `standard`；确认授权实施、
  验证、独立缺陷审查与收尾。两个未决问题也已确认：首次引导完全移除模板逻辑（脚本要求
  `clusters/multipass` 已存在）；`prepare-multipass.ps1` 同步修改。

## Background and Goal

当前 `prepare-multipass.sh` 每次运行都从 `cluster-template` 复制出一个全新集群，重新生成
SSH 身份，构造信任包，并整体原子替换 `clusters/multipass`。这会把用户在本地集群中手工维护的
业务配置（例如 `apps/jx-server/app.yaml`、`apps/jx-web/app.yaml`）恢复为模板占位内容，
与示例“业务文件仅在本地集群管理、不入模板”的约定冲突。

目标：去掉 `cluster-template` 整体替换 `clusters/multipass` 的逻辑。脚本只做两件事——
删除已有测试环境（同名 Multipass 实例）并创建新的空白实例；对已存在的 `clusters/multipass`
不再整目录重建，而是保留用户自定义内容，仅在必要时刷新指向新实例的动态状态
（known_hosts、machines.yaml 的 IP、bootstrap.json）。

## Scope

### In scope

- `prepare-multipass.sh` 与 `prepare-multipass.ps1` 不再读取或复制 `cluster-template`，不再
  重新生成 SSH 身份，也**不再承担首次引导**；脚本要求 `clusters/multipass` 已存在。
- 复用 `clusters/multipass/secrets/id_ed25519(.pub)`：删除已有同名 VM → 用同一公钥经
  cloud-init 创建空白 VM → 读取新 IPv4 → 用新地址刷新 `known_hosts`、`machines.yaml`
  与 `bootstrap.json`（原地原子替换单文件）→ 更新宿主机 hosts 记录。
- 保留删除同名旧 VM 的破坏性语义与删除失败 fail-closed。
- 保留基于现有集群目录的严格校验（deno CLI `validate`）。
- 同步更新 `README.md` 中与脚本职责描述相关的内容，以及
  `tests/contract/verify_environment_placement_config.ts` 中对应两个脚本的片段断言。
- 清理因本次语义变化而失效的死代码：`validate_template_tree`、`publish_cluster_atomically`、
  `migrate_legacy_cluster`、`reject_stale_backups`、模板 staging 构造等。

### Out of scope

- 不修改集群 schema、sfo-deploy CLI、部署行为或 SSH 信任校验逻辑本身。
- 不删除 `cluster-template` 目录（仍作为外部参考存在；全新检出的用户需自行准备首次集群状态。
  脚本不再引用它）。
- 不执行真实 Multipass 删除/创建端到端操作；只在目标宿主上运行脚本时验证。

## Requirement Review

请求合理。`clusters/` 被 `.gitignore` 忽略，是本地持久状态；整体从模板重建会覆盖本地维护的
业务配置，与 README “两个业务文件保持原样、仅在本地集群中管理”的约定冲突。用户确认两个未决
问题：完全移除模板逻辑（脚本要求 `clusters/multipass` 已存在）、`prepare-multipass.ps1`
同步修改。因此两个脚本都收敛为“删除已有实例 + 创建新实例 + 刷新指向新实例的动态状态”。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-prepare-no-template-replace | 重复运行两个 prepare 脚本不再恢复模板占位内容；`clusters/multipass` 中用户业务配置保持不变。 | 只允许把 `known_hosts`、`machines.yaml`、`bootstrap.json` 的机器身份字段改为新实例对应值。 | 保留自定义换取整目录原子发布保证。 | 脚本中不再引用 `cluster-template` 复制路径；copy/publish staging 构造被删除；README 同步说明。 | 不改写任何 app/environment 业务配置。 |
| P-002 | CHG-prepare-no-template-replace | 删除已有同名 VM 并创建新的空白 VM；同一专用公钥继续被 cloud-init 注入。 | VM 生命周期与 hosts 写回行为保持与现状一致。 | 复用既有身份，新 VM 首次启动即接受现有私钥。 | 删除阶段仍在 launch 之前；cloud-init 使用 `clusters/multipass/secrets/id_ed25519.pub`。 | 不重新生成 SSH 密钥。 |
| P-003 | CHG-prepare-no-template-replace | 新 IPv4、host key 与 hosts 记录成功写出后才报告成功；失败 fail-closed。 | 状态文件以同文件系统临时文件 + `mv` 原子替换；缺失既有集群信任文件时直接失败；脚本要求 `clusters/multipass` 已存在。 | 跨单文件的轻微不一致窗口换取脚本大幅简化，并彻底移除模板逻辑。 | `bash -n` 与脚本 stub 验证通过；非零路径返回非零。 | 不做整目录事务发布，不承担首次引导。 |

## Success Criteria

- `prepare-multipass.sh` 与 `prepare-multipass.ps1` 不再出现 `cluster-template` 的递归复制与
  整目录原子发布路径；对应契约测试片段更新为新的可验证顺序。
- 两个脚本都要求 `clusters/multipass` 已存在；运行后其中用户业务配置（apps 等）保持原样，
  仅 `known_hosts`/`machines.yaml`/`bootstrap.json` 的机器身份被刷新。
- `bash -n prepare-multipass.sh` 通过；`pwsh` 对 `prepare-multipass.ps1` 语法解析通过。
- `tests/contract/verify_environment_placement_config.ts` 的 `docs` 模式通过。
- README 与两个脚本的新语义一致。

## Risks

- 删除已有 VM 是既有破坏性语义，保持不变。
- 复用既有 SSH 私钥意味着旧集群私钥仍然可用；这与“测试环境身份复用”的意图一致，属于
  已确认行为而不是密钥泄漏路径（私钥文件权限仍为 600）。
- 完全移除首次引导后，全新检出的用户需要自行准备 `clusters/multipass` 首次状态；README 需
  给出入口说明。