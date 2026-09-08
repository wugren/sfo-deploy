---
task_manifest: task.yaml
status: approved
---

# 纯 SSH 安装 Deno 命令提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本需求新增公开 CLI 动作契约，并通过 SSH/SCP
  在目标机器上执行远端安装、从网络获取并落盘 Deno 运行时。这直接涉及 contract-protocol（CLI
  动作、帮助、退出码）、runtime-integration（远端执行安装
  命令）、security（目标身份、提权、命令注入）与 build-config-deployment / supply-chain（Deno
  版本、来源与校验）边界，且后果不是纯文档或纯配置，因此默认按 high-risk
  提案；用户确认时可选择替换为 standard/trivial 并记录残余风险。
- Proposal and tier confirmation: 用户已在本会话回复“确认，自动完成”，明确确认本提案、`high-risk`
  层级，并授权从提案批准后自动完成全部后续 lifecycle 阶段。

## Background and Goal

当前 sfo-deploy 的所有远端生命周期脚本都依赖目标机预装 Deno 2。集群配置指南和
`eleph-server-multipass` 示例都要求用户“按组织批准的供应链流程在 VM 中安装 Deno 2”，
但没有配套命令；`prepare-multipass.sh` 刻意不从网络下载部署运行时。用户希望再添加一个 命令，使用纯
SSH 方式安装 Deno：即只通过本地 OpenSSH 的 `ssh`/`scp` 直连目标并执行 远端安装，不要求目标机预装
Deno/Python，也不使用 `multipass exec`/`transfer`/`mount`
或其它部署代理，从而把“预装运行时”这一步收进 sfo-deploy 自身。

## Scope

### In scope

- 新增一条可执行的“安装 Deno”命令。默认方案是通用 CLI 动作 `install-deno`
  ：`sfo-deploy install-deno --cluster <名称> [--machine ...]`。
- 复用现有 `OpenSshTransport` 的严格 SSH 连接（known_hosts、私钥、地址选择、
  连接/命令超时），不新增第二套传输或远端 agent。
- 支持按 `--machine` 筛选目标；缺省处理所选集群全部机器。
- 安装前确定目标系统/架构与已有 Deno 状态；版本已满足时跳过，未安装或版本过低时执行 纯 SSH
  安装，随后用 `deno --version` 验证结果。
- 默认安装到用户可写目录 `~/.deno/bin/deno`，并提供可选 `--install-to <目录>`；
  使用非当前用户可写目录时，仅在远端身份可非交互提权（root 或 `sudo -n`）时继续。
- 加入命令帮助、README、集群配置指南与示例 README；补充针对性测试。

### Out of scope

- 不改变现有 `install`/`prepare`/`deploy` 等动作的语义、远端权限模型、秘密/模板投递
  协议或发布历史格式。
- 不自动改写 `machines.yaml`（安装完成后由用户把 `deno` 字段指向实际安装路径，或保持默认）。
- 不负责 Deno 的卸载/升级编排、跨机器并行、断点续传或 UI/调度。
- 不引入新的集群配置 schema 大版本，也不要求远端预装任何框架运行时。

### Boundary with neighboring modules

- CLI/集成模块：新增动作、参数解析、帮助文本与 `RunResult` 序列化；`--machine`、
  `--address-kind`、`--executor-region` 沿用现有筛选语义；`install-deno` 与既有
  `install`（环境安装）必须无歧义。
- 传输模块：仅在需要时扩展 `RemoteSession` 的纯 SSH 原语（例如标准输入投递安装脚本），
  不改连接/校验信任模型。
- 示例模块：`eleph-server-multipass` 的 README 说明如何用该命令替代“手工登录 VM 安装
  Deno”步骤；不修改 `prepare-multipass.*` 现有职责。

## Requirement Review

需求合理：目标机预装 Deno 是目前唯一需要脱离 sfo-deploy 手工完成的引导步骤，把运行时 安装收进 CLI
可以减少手工登录和供应链流程漂移。主要取舍是安装方式：纯 SSH 直连必然要求 目标机具备最小 POSIX shell
与下载/解压工具（如 `curl`/`wget`、`unzip`），或由控制端 通过 `ssh`/`scp` 投递固定版本的 Deno
归档并校验；设计阶段将确定具体路径，倾向固定版本、
可信来源与内容校验，避免“管道安装任意脚本”式的不可审计行为。

关键选择（本提案已采用，用户可在确认时调整）：

1. 命令形态为通用 CLI 动作（对所有集群可用），而不是仅示例项目脚本； 若用户希望改成
   `examples/eleph-server-multipass/install-deno.sh`，提案需修订后重确认。
2. 动作名为 `install-deno`，与既有 `install` 区分。
3. 默认安装到 `~/.deno/bin/deno`；示例 README 将说明把 `machines.yaml.deno` 指向
   实际安装路径，或改用 `--install-to /usr/local/bin`（需要提权路径）。

## Proposal Items

| proposal_id | change_id            | requirement                                                                                   | boundary                                                                    | tradeoff                                           | non_goal                                             | success_evidence                                                                                     |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| PI-1        | CHG-ssh-deno-install | 新增纯 SSH 安装 Deno 的命令，按机器筛选，通过现有 OpenSshTransport 直连并按固定版本安装与验证 | 只操作所选机器上的 Deno 运行时，不改集群配置 schema、发布历史与现有动作语义 | 用 ssh/scp 直连换取零远端代理与零预装运行时要求    | 不自动卸载、不自动改写 machines.yaml、不做跨机器并行 | 命令帮助/文档一致；计划与执行测试覆盖筛选、跳过已满足、纯 SSH 安装与版本验证；退出码与 JSON 结果稳定 |
| PI-2        | CHG-ssh-deno-docs    | README、集群配置指南与示例 README 说明新命令的用法、前提与安装路径约定                        | 只同步说明文档与示例入口，不重写既有引导/部署流程                           | 文档明确远端最小依赖并固定版本来源，换取可审计安装 | 不承诺所有发行版/架构；不替代现有供应链审批流程      | 三份文档一致可复现；示例 README 的新命令可替代手工安装步骤说明，并同步 `machines.yaml.deno` 路径约定 |

## Success Criteria

- Concrete user-visible or system-visible result: 用户可运行
  `sfo-deploy install-deno --cluster <名称> [--machine ...]`，仅通过 ssh/scp 把固定 版本的 Deno
  安装到各目标机（或确认已满足并跳过），并输出每台机器的结果与验证版本。
- Required evidence: 新命令帮助、README/指南/示例同步；单元与集成测试覆盖参数筛选、
  已安装跳过、安装失败与版本验证；`deno task check`、lint、fmt 与相关测试通过。
- Explicit non-goals: 不自动修改 `machines.yaml`；不提供卸载/升级；不改变既有动作语义；
  不要求真实公网目标作为唯一完成条件（可隔离替身验证，可用环境下再做真实 E2E）。

## Risks

- 公开 CLI 契约：新动作名与既有 `install` 的区分、帮助文本与退出码需无歧义。
- 安全与供应链：Deno 版本、下载来源与校验必须可审计，锁定架构/系统探测，避免命令
  注入与提权路径滥用。
- 纯 SSH 前提：目标机最小依赖（POSIX shell、下载/解压工具）需在设计文档中明确并 fail-closed 预检。
- 兼容边界：示例模板声明 `/usr/local/bin/deno`；若默认安装到 `~/.deno/bin`，文档必须 说明
  `machines.yaml.deno` 的对应调整。
