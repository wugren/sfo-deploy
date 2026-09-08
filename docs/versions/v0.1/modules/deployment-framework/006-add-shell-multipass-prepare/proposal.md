---
task_manifest: task.yaml
status: approved
---

# 增加 Multipass 准备脚本的 Bash 版本提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 新增脚本会实际创建或启动 Multipass 实例、生成并保护 SSH
  私钥、注入公钥、固定 SSH host key，并原子发布包含凭据与信任状态的集群目录。虽然目标是复刻现有
  PowerShell
  逻辑，但这是新的可执行宿主入口，错误可能造成接管未知实例、信任错误主机、泄露私钥或暴露混合修订状态，因此已确认安全、运行时生命周期和部署边界具有实质影响。
- Proposal and tier confirmation:
  用户已在当前会话回复“确认，自动完成任务”，明确确认本提案、`high-risk`
  层级，并授权从设计阶段开始自动完成全部后续流水线阶段。

## Background and Goal

当前 Multipass 示例只提供 Windows PowerShell 准备脚本。目标是基于 `prepare-multipass.ps1`
的现有约束与失败关闭逻辑，增加适用于 Linux/macOS 宿主机的 Bash 版本，使用户可以用等价流程准备空白
Ubuntu VM、专用 SSH 身份和严格固定的集群信任包。

## Scope

### In scope

- 新增 `examples/eleph-server-multipass/prepare-multipass.sh`，采用 Bash 命令行参数并提供与
  PowerShell 默认值等价的实例名、CPU、内存、磁盘和 Ubuntu 镜像配置。
- 等价实现依赖检查、输入校验、已有实例可信状态校验、非运行实例启动、新实例 cloud-init 启动、IPv4
  提取、SSH host key 扫描与集合比对、私钥权限收紧、模板替换及集群目录原子发布。
- 保持脚本只调用 `multipass info/start/launch`，不通过 `exec`、`transfer` 或 `mount` 配置
  VM，也不处理 JAR 参数或应用安装。
- 增加 Bash 语法、静态安全契约与可隔离执行路径的针对性测试，并在示例 README 中补充 Linux/macOS
  前提和调用方式。

### Out of scope

- 不修改现有 `prepare-multipass.ps1` 的行为或参数。
- 不改变集群模板、部署 CLI、JAR 配置、应用生命周期脚本或 VM 内软件安装流程。
- 不删除、停止或回滚用户已有的 Multipass 实例；新建实例后的后续脚本失败仍遵循现有 PowerShell
  版本“不自动删除 VM”的边界。
- 不要求完成真实 Multipass VM 的端到端创建作为本任务唯一完成条件；可用环境下再运行已有或新增的显式
  E2E 检查。

### Boundary with neighboring modules

- 变更限定在 `examples/eleph-server-multipass` 示例的宿主机引导入口、对应测试与说明文档；通用
  `sfo-deploy` 框架及其他示例不变。

## Requirement Review

该需求合理，增加 Bash 入口能让现有示例覆盖 Linux/macOS Multipass 用户。选择 Bash 而不是严格 POSIX
`sh`，因为安全清理、参数解析、数组式命令调用和失败关闭更容易清晰表达；脚本不会依赖
`jq`，可复用示例已有的 Python 3.11 前提解析 Multipass JSON。实现以行为等价为准，不机械逐行翻译
PowerShell；重点保留未知实例拒绝接管、IP/host key
不匹配时失败、密钥权限为仅当前用户可读写，以及单目录发布避免信任包混合修订。

## Proposal Items

| proposal_id | change_id                   | requirement                                                                        | boundary                                       | tradeoff                                                           | success_evidence                                                    | non_goal                            |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------- |
| P-001       | CHG-shell-multipass-prepare | 提供可执行的 Bash 准备脚本，并与 PowerShell 版本保持 VM、SSH 身份和信任包行为等价  | 仅增加宿主引导入口，不改变部署框架和 VM 内配置 | 使用 Bash 与 Python 3.11 解析 JSON，换取可靠参数边界和免 `jq` 依赖 | Bash 语法检查、静态契约测试和隔离命令替身测试覆盖首次创建及可信重跑 | 不追求逐行或函数名完全相同          |
| P-002       | CHG-shell-multipass-prepare | 对未知实例、可信 IP 变化、host key 变化、命令失败和未完成 staging 保持失败关闭     | 不自动接管、删除或修复外部实例                 | 新实例可能在后续步骤失败后保留，与现有脚本边界一致                 | 负路径测试证明不会发布不完整或混合修订信任包                        | 不增加实例销毁或回滚功能            |
| P-003       | CHG-shell-multipass-prepare | 在 README 中并列说明 Windows PowerShell 与 Linux/macOS Bash 的前提、参数和调用方式 | 不重写后续 JAR 配置与部署步骤                  | 文档增加少量平台分支                                               | README 契约测试和人工检查确认两种入口均清晰且顺序一致               | 不承诺未验证的其他 shell 或宿主平台 |

## Success Criteria

- Concrete user-visible or system-visible result: Linux/macOS 用户可从示例目录运行
  `./prepare-multipass.sh`，使用默认值或显式参数生成与 PowerShell 版本相同结构的
  `.state/clusters/multipass` 信任包。
- Required evidence: Bash 语法检查通过；针对性测试验证命令范围、输入校验、密钥权限、IPv4/host key
  信任检查、模板替换和原子发布；相关示例测试通过；若本机具备可用 Multipass，则补充实际 E2E
  结果，否则明确记录未运行原因。
- Explicit non-goals: 不修改 PowerShell 行为，不处理 JAR，不在 VM 内安装组件，不扩大通用框架接口。

## Risks

- shell 引号、空格路径和参数展开若处理错误，可能破坏命令边界或写错状态目录。
- host key 比对必须按密钥类型与内容的集合语义进行，不能因地址字段或输出顺序差异错误接受或拒绝。
- 目录替换需保证失败恢复；清理临时目录时必须验证目标位于示例 `.state` 下，避免扩大删除范围。
- Linux 与 macOS 的工具差异主要集中在文件权限和文件操作语义，测试需覆盖脚本依赖与平台假设。
