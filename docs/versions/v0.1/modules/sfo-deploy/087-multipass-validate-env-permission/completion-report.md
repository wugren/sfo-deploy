# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/087-multipass-validate-env-permission.md

## Delivery Summary

- Outcome: `prepare-multipass.sh` 与 `prepare-multipass.ps1` 的内联 Deno `validate`
  调用均添加 `--allow-env=HOME,USERPROFILE`。CLI 初始化可读取当前平台用户主目录变量，
  不再弹出 Deno 环境权限确认；validate 配置根、集群名称、失败处理和其余 Deno 权限不变。
- Handoff: 交付允许 prepare 非交互完成本地集群校验。真实 Multipass 26.04 启动、真实
  hosts 写入和 Windows 管理员场景仍需用户在目标宿主执行；此权限不授予其他环境变量。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-multipass-validate-env | P-001：prepare 内联 validate 可读取 `HOME` 或 `USERPROFILE`，不再弹出 Deno 环境确认，且只授予最小环境权限 | proposal.md P-001 | `.sh:570` 与 `.ps1:405` 均为 `--quiet --allow-read --allow-env=HOME,USERPROFILE ... validate`；`DENO_NO_PROMPT=1` probe 非零退出但输出无权限提示；未添加全量 `--allow-env` | 与提案一致，权限范围保持在两个主目录变量 | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | 两条 prepare 脚本的 validate 调用、CLI 初始化用户配置路径、Deno 权限参数 | 以缺失配置根和 `DENO_NO_PROMPT=1` 运行最小权限 CLI probe，验证非零失败但无权限提示；检查没有引入全量环境权限或改变 validate 参数 | 未发现权限目标或调用逻辑缺陷 | pass |
| boundaries-and-failure-paths | `.sh` 的 `if ! deno ...` 和 `.ps1` 的 `$LASTEXITCODE` 失败路径 | 假设 HOME/USERPROFILE 缺失或配置根无效，确认仍依赖 CLI现有错误处理；真实 prepare 不会因 Deno 权限确认中断 | 未改变 fail-closed 边界；probe 的缺失配置失败符合预期 | pass |
| regression-and-side-effects | 本任务 diff、`git diff --check`、Bash 语法检查、PowerShell 解析、相关文件权限字符串搜索 | 搜索确认改动限定在两条内联 validate 调用；确认没有修改集群模板、hosts 更新、SSH trust bundle、CLI action 或任务权限契约 | 未发现回归；PowerShell 与 Bash 行为保持对称 | pass |

## Verification

- Targeted check: `bash -n examples/eleph-server-multipass/prepare-multipass.sh` 通过；
  `pwsh` 解析 `prepare-multipass.ps1` 通过；`rg` 确认两条内联 validate 均包含
  `--allow-env=HOME,USERPROFILE`；使用空临时配置根执行
  `DENO_NO_PROMPT=1 deno run --quiet --allow-read --allow-env=HOME,USERPROFILE src/cli.ts
  validate --config-root ... --cluster multipass`，返回非零且无 `Deno requests env access`
  或 `Allow? [y/n/A]` 提示；`git diff --check` 通过。
- Result: passed
- Exception reason: 未执行真实 Multipass VM 删除/创建、真实 hosts 权限提升或 Windows
  管理员全流程；这些外部宿主交互仍需在目标环境验证。

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-001 | low | Deno probe 与真实 prepare 环境差异 | 静态/probe 验证不能证明真实 Multipass 镜像启动和 hosts 写回成功；这是既有外部环境边界，需目标宿主复验 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 两条 prepare 脚本均以最小 `HOME`/`USERPROFILE` 环境权限运行内联 validate，
  静态检查和无提示 probe 通过；独立复核未发现阻塞性缺陷，未改变部署或安全语义。
