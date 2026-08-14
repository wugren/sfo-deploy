---
task_manifest: task.yaml
status: approved
---

# 修复 Multipass 实例信息探测提案

Risk profile: not-created

## Workflow Tier Judgment
- Proposed tier: trivial
- Final tier: trivial
- Tier rationale / triggered boundaries: 改动仅限一个 PowerShell 辅助函数对原生命令错误流的处理，不改变命令行参数、生成配置、信任边界或实例生命周期设计；可在当前无实例环境中用针对性命令稳定复现并验证。文件位于部署示例中会触发部署类路径筛查，但已确认的实际后果只是恢复既定的首次运行分支，不构成实质性发布、兼容或运行时集成变更。
- Proposal and tier confirmation: 用户已在当前会话明确确认本提案及 `trivial` 工作流分级。

## Background and Goal
`prepare-multipass.ps1` 在首次运行、目标实例尚不存在时调用 `multipass info`。Multipass 以退出码 `2` 和 stderr 报告实例不存在；脚本全局启用的 `$ErrorActionPreference = "Stop"` 会先把该 stderr 转成终止错误，使函数无法按原设计检查 `$LASTEXITCODE` 并返回 `$null`，后续创建实例流程因此无法开始。目标是在保留全局严格错误处理的同时，把该预期的非零探测结果正确交给函数现有分支处理。

## Scope
### In scope
- 在 `Invoke-MultipassInfo` 内仅围绕 `multipass info` 调用临时使用非终止错误策略。
- 在调用结束后恢复原错误策略，并保存退出码供现有逻辑判断。
- 验证实例不存在时函数返回 `$null`、脚本错误策略得到恢复，并检查正常 JSON 解析路径未被破坏。

### Out of scope
- 不手工创建、启动、停止或删除 Multipass 实例。
- 不改变实例名称、Ubuntu 镜像、CPU、内存、磁盘、SSH 密钥或 `known_hosts` 行为。
- 不修改部署框架、其他示例脚本或 Multipass 安装与服务配置。

### Boundary with neighboring modules
- 修复仅属于 `examples/eleph-server-multipass/prepare-multipass.ps1` 的 Windows PowerShell 兼容行为；Multipass 后端和通用部署框架保持不变。

## Requirement Review
该修复合理且必要。直接忽略全局错误或手工预建同名实例都会削弱错误检测或触发脚本的未知实例保护，因此选择在信息探测函数内部临时调整错误策略、立即保存退出码并在 `finally` 中恢复，是边界最小且能保持现有安全语义的方案。

## Proposal Items
| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-multipass-info-probe | 目标实例不存在时，信息探测不得因原生 stderr 提前终止，并应让首次创建流程继续 | 仅调整 `Invoke-MultipassInfo` 内部错误策略和退出码捕获 | 增加少量保存与恢复状态的代码，以换取 Windows PowerShell 下的确定行为 | 无实例探测返回 `$null`、退出码为 `2`、调用后错误策略恢复；脚本语法检查通过 | 不改变真实创建参数或接管未知实例的保护逻辑 |

## Success Criteria
- Concrete user-visible or system-visible result: 在 Multipass 可用但 `eleph-server` 不存在时，脚本不再停在第 32 行，而能进入既有的首次创建分支。
- Required evidence: PowerShell 语法检查通过；针对不存在实例的函数级探测证明非零退出码不会成为终止错误，返回值为 `$null`，且调用者的错误策略保持 `Stop`。
- Explicit non-goals: 本任务不执行真实虚拟机创建，也不证明后续网络、SSH 或应用部署成功。

## Risks
- 仍需保留非零退出码判断，避免把命令失败输出当成 JSON。
- 错误策略必须通过 `finally` 恢复，避免影响函数之后的严格错误处理。
