# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/088-multipass-prepare-no-template-replace.md

## Delivery Summary

- Outcome: `prepare-multipass.sh` 与 `prepare-multipass.ps1` 完全移除 `cluster-template` 的
  递归复制、SSH 身份重新生成、staging 构造与整目录原子发布路径，也不再承担首次引导。两个脚本
  都要求 `clusters/multipass` 已存在，复用 `secrets/id_ed25519(.pub)`：删除同名旧 VM →
  用同一公钥经 cloud-init 创建空白 VM → 读取新 IPv4 → 原地刷新 `known_hosts`、
  `machines.yaml`（`private_ip`）与 `bootstrap.json` → 对既有集群执行严格 `validate` →
  更新宿主机 hosts 记录。本地业务配置与既有身份文件原样保留。
- Handoff: 交付“只删/建 VM 并刷新机器身份，不重建集群目录”的 prepare 语义。真实 Multipass
  删除/创建、真实 hosts 写入及 Windows 管理员场景仍需用户在目标宿主验证。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-prepare-no-template-replace | P-001：重复运行不再恢复模板占位内容，本地业务配置保持不变；不引用 `cluster-template` 复制路径 | proposal.md P-001 | 两个 prepare 脚本全文不含 `cluster-template`（契约测试负向断言+独立 grep）；stub 端到端中 `apps/jx-server/app.yaml` 刷新前后哈希一致；README 同步说明 | 与提案一致，业务文件未被改写 | pass |
| CHG-prepare-no-template-replace | P-002：删除同名旧 VM 并创建新空白 VM，复用既有专用公钥注入 | proposal.md P-002 | stub 日志顺序 info → `delete --purge` → `launch ... --cloud-init`；cloud-init 读取 `secrets/id_ed25519.pub`；删除失败 fail-closed | 与提案一致，身份复用 | pass |
| CHG-prepare-no-template-replace | P-003：刷新成功后才报告成功，失败 fail-closed；要求既有集群状态 | proposal.md P-003 | 修改后 `known_hosts`(0600)/`machines.yaml`/`bootstrap.json` 指向新 IPv4；缺失 `clusters/multipass` 与 machines.yaml 不含记录地址两条 fail-closed 路径实测退出 1 | 与提案一致 | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | 两个 prepare 脚本的删除/创建/刷新顺序、host key 归一化、IPv4 解析、bootstrap schema 校验 | stub 端到端追踪 delete 先于 launch；扫描 host key 先于写 known_hosts；machines.yaml 恰好一次替换、bootstrap.json schema 严格校验后再改写；旧 IP==新 IP 时替换幂等 | 未发现控制流缺陷；顺序与提案成功信号一致 | pass |
| boundaries-and-failure-paths | 缺失集群状态、缺信任文件、bootstrap 无效、地址不匹配、hosts 写回、真实 CLI validate 失败路径 | 实测缺失集群状态与地址不一致均以非零退出且不继续；真实 CLI `--config-root clusters --cluster multipass` validate 通过；删除/hosts 写回仍为 fail-closed | 未改变破坏性删除语义；失败不留下部分刷新（刷新在 validate 与 hosts 之前，失败即中止） | pass |
| regression-and-side-effects | 本任务 diff、README 职责清单、契约测试片段、`git diff --check`、`bash -n`、`pwsh` 解析、`deno task check` | 搜索确认四个文件的改动均围绕新语义；两个脚本不再引用被删函数；README 保留 schema v2/环境放置/逐机器 overrides/v1 移除等既有契约语句 | 未发现回归；`.ps1` 语法解析与 `.sh` 行为对称（真实 Windows 未执行） | pass |

## Verification

- Targeted check: `bash -n examples/eleph-server-multipass/prepare-multipass.sh` 通过；
  `pwsh` 全文件语法解析 `.ps1` 通过；stub `multipass`/`ssh-keyscan`/`deno` 端到端执行新语义
  成功路径及两条 fail-closed 路径通过；真实 CLI validate 通过；`deno fmt --check`、
  `git diff --check`、示例 `deno task check` 通过。
- Result: passed
- Exception reason: 未执行真实 Multipass VM 删除/创建、真实 hosts 权限提升或 Windows 管理员
  全流程；`tests/contract/verify_environment_placement_config.ts` 的 `docs`/`closure`/
  `v1-rejection` 模式因既有未收尾改动（模板 environment 映射、schema1 移除契约、app v1 拒绝
  文案）在本任务未触及处失败，本任务涉及的片段断言已独立逐项验证通过。

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-001 | low | stub 测试与真实环境差异 | 静态/stub 验证不能证明真实 Multipass 镜像启动、删除与 hosts 写回成功；需目标宿主复验 | no |
| F-002 | low | 契约测试工作树状态 | `verify_environment_placement_config.ts` 三个模式在模板 environment 映射、schema1 移除契约、app v1 拒绝文案处存在既有失败，与本次改动无关 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 两个 prepare 脚本按确认范围移除模板重建路径，只删/建 VM 并以既有身份刷新机器身份
  字段；stub 成功路径与 fail-closed 路径验证通过，独立复核未发现阻塞性缺陷，业务配置得到保留。