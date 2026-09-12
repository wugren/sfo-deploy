---
task_manifest: task.yaml
status: approved
---

# 提案：prepare-multipass.sh 重造实例并维护宿主机 hosts 记录

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 改动限定在 `examples/eleph-server-multipass`
  的示例 prep 脚本（bash 与 PowerShell 双实现）及其 README，不触碰框架源码、public
  schema、协议、持久化与迁移、依赖/构建图或安全边界；不改变 sfo-deploy 的部署/回滚
  事务语义。触发面主要是 build/config/deployment 本地示例工具的宿主环境行为（删除并
  重建 Multipass 实例、修改宿主 hosts 文件），均属示例范围且由用户明确指示；不改生产
  部署表面，不涉及多项目集成或架构边界，推荐 standard。
- Proposal and tier confirmation: 用户于 2026-09-12 确认提案并选择 `standard`，同时
  追加要求 `prepare-multipass.ps1`（Windows）同步维护 hosts 记录；确认授权设计、实现、
  验证、独立缺陷审查与收尾。

## Background and Goal

当前 `prepare-multipass.sh`（及对应的 Windows 版 `prepare-multipass.ps1`）遇到同名实例
存在时会复用实例：校验已保存的 SSH 身份、IP 与 host key，仅在不匹配或未知时才失败关闭。
用户希望改为“先删后建”——只要存在同名实例就删除并重新创建空白 VM；并在实例创建后把
`test.eleph-label.com` 解析到新建 VM 的新 IPv4，写入（或更新）宿主机的 hosts 文件
（Linux/macOS 为 `/etc/hosts`，Windows 为 `C:\Windows\System32\drivers\etc\hosts`），使
`test.eleph-label.com:8080` 可被宿主机访问（与 `jx-web` nginx 模板中
`server_name test.eleph-label.com` 对应）。

重复执行 prepare 因此从“复用并复核身份”变为“可预期地重建空白主机并刷新宿主机解析”，
行为更符合本地开发验收流程。

两个脚本（bash 与 PowerShell）需保持职责一致；Windows 版本不引入 sudo，直接以当前
权限读写 hosts 文件，失败时提示以管理员运行。

## Scope

### In scope

- `examples/eleph-server-multipass/prepare-multipass.sh`：
  - 创建 VM 前，若同名实例已存在（`multipass info` 成功），先用
    `multipass delete --purge "<instance_name>"` 删除，再走全新 launch 路径创建；
    删除失败则 fail-closed，不继续创建。
  - 删除原“复用并复核既有实例身份/SSH 信任/host key”的既有实例分支（该分支在新行为下
    成为死路径）；同样被淘汰的是“拒绝接管未知实例”与 `compare_host_keys` 等仅服务于
    复用路径的机件。保留 staging 构建、模板校验、密钥生成、`validate`、原子发布、
    故障清理与备份恢复机制，新实例的完整信任/身份状态从模板重新生成。
  - 实例创建并读取到新 IPv4 后，维护宿主机 `/etc/hosts`：
    - 固定主机名 `test.eleph-label.com`，记录 `<new-ip> test.eleph-label.com`；
    - 若 `/etc/hosts` 中已存在该主机名记录（含作为别名一同存在的形态），用新 IP
      更新该记录，不遗留旧 IP；
    - 保留其他记录、注释与空行；用同目录临时文件 + rename 原子写回，尽量保持
      文件权限；
    - 写权限不足时：若 `sudo` 可用则通过 `sudo` 提升后写回；否则明确失败并给出
      提示，不静默跳过。
  - 新增记录写入失败视为 prepare 失败（fail-closed）。
- `examples/eleph-server-multipass/prepare-multipass.ps1`（Windows，用户确认同步更新）：
  - 与 .sh 相同的“先删后建”：存在同名实例即 `multipass delete --purge "<name>"`
    后再 launch。
  - 创建后维护 `C:\Windows\System32\drivers\etc\hosts` 的
    `<new-ip> test.eleph-label.com` 记录；已存在则更新，保留其他记录；
    以当前进程权限直接读写，失败时提示以管理员身份运行（不引入 sudo）。
- `examples/eleph-server-multipass/README.md`：更新 prepare 职责列表、同名实例行为、
  “幂等性与安全边界”中关于重复执行复用 SSH 身份的描述，以及新增 hosts
  记录说明（Linux/macOS 与 Windows 路径）。

### Out of scope

- 不新增删除前交互确认开关；重复执行 prepare 即为有意的破坏性重建
  （该主机上旧 VM 数据会被删除），README 明确提示。
- 不新增 CLI 选项（不对 `test.eleph-label.com` 做可配置化，作为脚本内常量变量）。
- 不修改 sfo-deploy 框架源码、cluster-template 内容、SSH 信任模型或 `validate` 机制。
- 真实删除/创建、host key 扫描、hosts 文件写回仍只在本机验证脚本逻辑。

### Boundary with neighboring modules

- `examples/eleph-server-multipass/cluster-template/`、`src/`、`tests/` 不属于本任务
  改动面；本任务只改示例 prep 脚本与 README。故障下的备份/恢复与原子发布职责仍由
  prepare 自身拥有。

## Requirement Review

请求合理且边界清晰：本地示例 VM 是每次可重建的开发环境，删除重建正是用户期望的
幂等目标；`/etc/hosts` 记录使宿主机能通过域名访问 VM 中的应用，避免凭 IP 临时访问。

取舍与设计选择：

- 删除命令用 `multipass delete --purge "<name>"`（定向清理单个实例，避免 `multipass
  purge` 波及宿主机上其他已标记删除的实例）。需要 Multipass ≥ 1.11 支持
  `delete --purge`；不支持时命令失败即 fail-closed，不会误删其他实例。
- `/etc/hosts` 写回纳入 prepare，理由：用户明确要求每次创建后维护；这样任意一次成功
  prepare 后域名即可用。失败即 fail-closed，避免用户以为已配置。
- 复用路径被移除：与“先删后建”冲突，保留只会制造死代码与误导文档；删除是用户明确、
  可见的风险，通过 README 警示。
- 权限提升采用“优先直写，其次 sudo，再失败报错”，对自动化与交互环境都给出明确结果，
  不静默跳过，也不强制要求 root 运行。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-multipass-recreate-instance | 存在同名实例时先删除再创建，复用旧实例的分支与机件移除（.sh 与 .ps1 一致）。 | 仅作用到配置的 `instance_name`；删除失败时 fail-closed 不创建。 | 示例 VM 数据每次重建即丢失（用户期望）；换取可预期、可重复的空白主机。 | `multipass info` 返回存在时脚本执行 `delete --purge` 后再 `launch`；不存在的路径仍直接 `launch`。 | 不新增确认开关。 |
| P-002 | CHG-multipass-hosts-entry | 实例创建后把 `test.eleph-label.com` 指向新 IPv4 写入/更新宿主机 hosts 文件（.sh→`/etc/hosts`，.ps1→Windows hosts）。 | 只处理固定主机名 `test.eleph-label.com`；保留其他记录；写回失败即失败。 | .sh 需要 hosts 写权限（直写或 sudo），.ps1 需要管理员权限，否则任务失败并提示。 | 模拟宿主 hosts 文件验证：新建、更新（旧 IP 被替换）、保留无关记录，权限不足时明确失败。 | 不配置化主机名、不跳过失败。 |

## Success Criteria

- Concrete user-visible or system-visible result: 重复执行 `prepare-multipass.sh`（以及
  `prepare-multipass.ps1`）会删除并重建同名 VM；prepare 成功后宿主机 hosts 文件
  （`.sh`→`/etc/hosts`，`.ps1`→Windows hosts）中 `test.eleph-label.com` 指向当前
  新建实例的新 IPv4，且多次执行后只保留一条有效记录、无旧 IP 残留。
- Required evidence: `bash -n prepare-multipass.sh` 通过；用伪造 `multipass`/`ssh-keyscan`
  或轻量桩在临时目录执行脚本，验证：
  1) 实例存在时先 `delete --purge` 再 `launch`；
  2) 实例不存在时直接 `launch`；
  3) 创建后 hosts 记录新建/更新正确、无关记录保留；
  4) 删除或写 hosts 文件失败时 fail-closed；
  5) 既有 `deno task check`（示例 CLI 静态检查）不受影响。
  PowerShell 版本做静态解析（`pwsh -NoProfile` 语法检查或 PSScriptAnalyzer，若环境可用）
  并人工核对分支迁移逻辑。
- Explicit non-goals: 不保证真实 Multipass VM 联网常驻或应用可访问；真实的 hosts
  权限交互按宿主机环境执行，任务内以逻辑验证为主；不修改除上述两脚本与 README 之外的
  文件。

## Risks

- 破坏性：删除现存同名实例会丢失该 VM 内所有数据；README 明确警示，脚本不追加确认。
  这是用户明确选择的语义。
- `/etc/hosts` 权限：非 root 且无 sudo 时写回失败，prepare 以明确错误结束。
  建议运行前确认权限或在特权环境使用；Windows 版本需管理员权限运行。
- `multipass delete --purge` 需要 Multipass ≥ 1.11；旧版会在删除步骤 fail-closed，
  不会误删其他实例。
- `test.eleph-label.com` 为脚本内固定常量；如其他环境已占用该域名，需用户自行调整。