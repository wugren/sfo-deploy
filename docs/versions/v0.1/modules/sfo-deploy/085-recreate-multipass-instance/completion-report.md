# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/085-recreate-multipass-instance.md

## Delivery Summary

- Outcome: `examples/eleph-server-multipass/prepare-multipass.sh` 与
  `prepare-multipass.ps1` 统一新语义：只要 `multipass info` 表明同名实例存在，就用
  `multipass delete --purge "<instance_name>"` 删除后再走全新 staging+launch 路径重建
  空白 VM；原“复用并复核既有实例身份/SSH 信任/host key”的既有分支及 `compare_host_keys`、
  已知主机/身份比对与“拒绝接管未知实例”等死路径机件已移除。实例创建并读到新 IPv4 后，
  把宿主 hosts 文件中 `test.eleph-label.com` 记录指向新 IP（`.sh`→`/etc/hosts`，
  `.ps1`→`C:\Windows\System32\drivers\etc\hosts`）：已存在则更新、不存在则新增，无关记录、
  注释保留；写回失败或删除失败均 fail-closed。README 已更新职责列表、同名实例重建语义、
  hosts 说明（Linux/macOS 与 Windows 路径）及“幂等性与安全边界”段落。
- Handoff: 伪造 `multipass`/`ssh-keyscan`/`deno`/hosts 桩端到端验证成本任务的交付域
  （.sh 四条主路径全部通过；.ps1 的 hosts 写回函数在 pwsh 下针对临时 hosts 文件验证
  新增/更新/保留/缺文件失败四类断言并在运行宿主经 `pwsh` 做整文件语法解析通过）；`deno
  task check` 通过；`bash -n` 通过。真实 Multipass VM 删除/创建与真实 `/etc/hosts` 权限
  交互仍按宿主机环境由用户执行，本任务未联网或改动真实 VM。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-multipass-recreate-instance | P-001：存在同名实例时先删后建，复用路径机件移除（.sh 与 .ps1 一致），删除失败 fail-closed | proposal.md P-001 | .sh 现有实例分支改为 `if invoke_multipass_info >/dev/null; then` 时执行 `multipass delete --purge "$instance_name"` 并在失败时 die；`trusted_bootstrap_ipv4`/`compare_host_keys`/已知主机分支删除；.ps1 同步删除 `$existing`/`trustedBootstrap`/`Test-EqualSet` 路径改为 delete --purge；桩测试确认 delete 先于 launch、失败无 launch | 交付与提案一致，两条脚本分支迁移对称 | pass |
| CHG-multipass-hosts-entry | P-002：创建后 hosts 文件记录 `test.eleph-label.com`→新 IPv4，追加/更新、保留无关记录、写回失败失败（.sh→/etc/hosts，.ps1→Windows hosts） | proposal.md P-002 | .sh 新增 `update_hosts_entry()`（python 重写 + install -m 0644 直写/sudo 提升，失败 die）；.ps1 新增 `Set-HostsEntry()`（临时文件 + `[IO.File]::Replace`，当前权限直写）；桩测试验证 hosts 新建/更新/保留无关记录/写失败 fail-closed；pwsh 单测同项断言通过 | 交付与提案一致，主机名固定常量、不新增选项 | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | .sh `update_hosts_entry`/`instance_ipv4`/删除分支全流程 diff 与桩测试输出；.ps1 `Set-HostsEntry`/删除分支 diff 与 pwsh 单测 | 存在/不存在/删除失败/hosts 写失败四种宿主情形逐一复现；同时核查 hosts 重写对尾部空行、注释、无关记录的保留与新条目唯一性 | 独立复核发现原 `mv` 直写会把新 hosts 文件落到 umask 077（0600）权限，破坏其可读性；已将 .sh 两条写回分支统一改用 `install -m 0644`（保留 0644 与 root 归属），修正后测试通过；其余无逻辑缺陷 | pass |
| boundaries-and-failure-paths | hosts 文件缺失、不可写且无 sudo、`delete --purge` 失败、`multipass info` 返回失败；`multipass delete --purge` 需要 Multipass ≥ 1.11 | 验证删除失败不进入 launch、hosts 写失败脚本非零退出且不残留新条目；`.ps1` 缺 hosts 文件抛“missing”错误；`.sh` 用 `install` 而非 `mv` 后权限保持 | 边界行为符合提案 fail-closed 设计，README 已写明 hosts 权限与管理员要求 | pass |
| regression-and-side-effects | `bash -n`、`deno task check`、README 职责清单与“幂等性与安全边界”段落、ps1 全文件 `pwsh` 语法解析 | 确认未改动框架源码/cluster-template/SSH 信任模型/validate 机制；hosts 命名常量与 nginx `server_name test.eleph-label.com` 一致；未引入新 CLI 选项或交付物 | 未发现本任务引入的回归；改动面限定在两条 prep 脚本与 README | pass |

## Verification

- Targeted check: `bash -n prepare-multipass.sh`；伪造 `multipass`/`ssh-keyscan`/`deno`/hosts
  桩在临时 workspace 端到端执行 .sh，覆盖既有实例先删后建、无实例直接 launch、删除失败
  fail-closed、hosts 写失败 fail-closed、hosts 新建/更新/保留无关记录与注释六个场景；
  `pwsh` 对 `prepare-multipass.ps1` 整文件语法解析 + 提取 `Set-HostsEntry`/`Write-Utf8NoBom`
  对临时 Windows hosts 做新增/更新/缺文件断言；`deno task check`（示例 CLI 静态检查）。
- Result: passed
- Exception reason: 真实 Multipass VM 删除/创建、真实 `/etc/hosts` 与 Windows hosts 权限交互
  属于宿主环境，未在真实 VM 或真实 Windows 上执行；.ps1 的删除分支以静态解析 + 与 .sh 对称
  复核为准。

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-001 | medium | `prepare-multipass.sh#update_hosts_entry` 原 `mv` 直写实现 | 以当前 umask（077）挂载的新 hosts 文件将变为 0600，宿主其他用户无法读取解析；已改为 `install -m 0644`（直写与 sudo 分支统一）并复测通过 | no |
| F-002 | low | `prepare-multipass.ps1#Set-HostsEntry` | Windows hosts 写回依赖 `[IO.File]::Replace`，非管理员会抛出访问拒绝错误；符合提案“以当前权限直写，失败提示以管理员运行”的 fail-closed 语义，属预期边界而非缺陷 | no |
| F-003 | low | 验证环境 | 交付验证未在真实 Multipass VM、真实 macOS/Linux 非 root 或真实 Windows 权限场景执行；由 README 前提与风险段说明，需用户在目标宿主复跑 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 先删后建与 hosts 维护均按已确认提案 P-001/P-002 实现并在 .sh 与 .ps1 两侧对称落地；
  桩测试与 pwsh 单测确认新建、更新、无关记录保留、删除失败与写回失败全部 fail-closed；
  `bash -n`、`deno task check`、ps1 语法解析通过；独立复核发现并修复的 hosts 权限缺陷
  (F-001) 已纳入实现并复测；README 与职责/幂等性描述同步更新，无阻塞性缺陷。