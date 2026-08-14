---
task_manifest: task.yaml
status: approved
---

# 修复 ssh-keygen 空口令参数传递提案

Risk profile: not-created

## Workflow Tier Judgment
- Proposed tier: trivial
- Final tier: trivial
- Tier rationale / triggered boundaries: 改动局限于 Multipass 示例中一次 `ssh-keygen` 原生命令调用及其针对性回归测试，恢复脚本原本就要求的无口令专用密钥生成行为；不改变密钥类型、权限、信任边界、实例生命周期、公开接口、依赖或发布流程。虽涉及 SSH 密钥路径，但不引入新的安全策略或扩大密钥暴露面，因此没有确认实质性高风险边界。
- Proposal and tier confirmation: 用户已在当前会话明确确认本提案及 `trivial` 工作流分级。

## Background and Goal
Windows PowerShell 5.1 调用原生程序时不会保留 `-N ""` 中的空字符串实参。当前 `prepare-multipass.ps1` 因此会让 `ssh-keygen` 把后续 `-f` 误作 `-N` 的参数，并把密钥路径视为多余参数，最终报告 `Too many arguments`。目标是在 Windows PowerShell 与新版 PowerShell 中都准确传递空口令参数，使首次准备流程能够生成专用 Ed25519 密钥并继续执行。

## Scope
### In scope
- 调整 `prepare-multipass.ps1` 的 `ssh-keygen` 启动方式，显式构造并保留空口令实参，同时正确处理可能含空格的输出路径。
- 保持现有退出码失败检查和私钥 ACL 收紧流程。
- 增加针对 Windows PowerShell 原生参数传递的回归验证，并运行脚本语法和相关 bootstrap 测试。

### Out of scope
- 不改变专用密钥的 Ed25519 类型、无口令设计、存放位置或权限策略。
- 不创建、启动、停止或删除真实 Multipass 实例。
- 不修改 cloud-init、SSH 主机密钥校验、生成配置或后续部署行为。

### Boundary with neighboring modules
- 修复仅属于 `examples/eleph-server-multipass` 的 Windows 主机引导逻辑；通用部署框架、Multipass 后端和应用部署脚本保持不变。

## Requirement Review
该请求合理且错误可以由当前代码直接解释。仅把 `""` 改成特殊引号转义会依赖 PowerShell 的原生参数模式，在 Windows PowerShell 5.1 与 PowerShell 7.3+ 之间可能产生不同含义；采用显式进程启动和参数构造更能稳定表达“一个长度为零的参数”。代价是增加少量进程调用代码，但可以避免版本分支，并保持现有退出码语义。

## Proposal Items
| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-ssh-keygen-empty-passphrase | 在 Windows PowerShell 和新版 PowerShell 中向 `ssh-keygen -N` 传递一个真实空字符串，并让专用密钥生成成功 | 仅修改密钥生成调用及对应回归测试 | 使用显式进程参数构造替代简短的直接原生命令调用 | 回归测试证明空口令参数和含空格路径均被正确接收；PowerShell 语法及相关 bootstrap 测试通过 | 不改变密钥安全模型或执行真实 VM 生命周期操作 |

## Success Criteria
- Concrete user-visible or system-visible result: 运行 `.\prepare-multipass.ps1` 时不再在密钥生成步骤报告 `Too many arguments`，并能生成预期的私钥和公钥文件。
- Required evidence: 旧调用形式可复现参数丢失；修复后的针对性测试验证 `ssh-keygen` 成功生成无口令 Ed25519 密钥，覆盖含空格路径；脚本 PowerShell AST 解析和相关 bootstrap 测试通过。
- Explicit non-goals: 本任务不以真实 Multipass VM 创建、网络连通或完整应用部署作为完成条件。

## Risks
- 参数构造必须同时保留空字符串与路径边界，避免修复空口令后又在含空格路径上失败。
- 错误退出码仍必须使脚本失败关闭，不能把 `ssh-keygen` 的真实失败误判为成功。
