---
task_manifest: task.yaml
status: approved
---

# install-deno 自动补齐远端 curl/unzip 提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本需求改变 install-deno 的生产默认行为：远端缺少 curl/wget
  或 unzip/7z 时不再 fail-closed 报错，而是通过目标机包管理器用提权身份安装 系统包。这确认触及
  security（root/`sudo -n` 提权执行系统包管理）、supply-chain
  （信任发行版软件源并联网安装包）、runtime-integration（多发行版/包管理器探测与失败 路径）与
  production-default/rollout（默认行为变化）边界，并存在发行版支持范围的 acceptance 歧义，因此按
  high-risk 提案，进入 proposal → design → implementation → testing → acceptance
  完整流程。用户确认时可选择替换为 lower tier 并记录残余风险。
- Proposal and tier confirmation: 用户已回复“确认，自动完成”，确认本提案及 high-risk
  层级，并授权从提案批准后自动完成全部后续 lifecycle 阶段；三个待确认问题按提案建议
  采纳（apt/apk/dnf/yum 探测并 fail-closed、默认自动补齐不新增 CLI 开关、安装 curl 与 unzip 并保留
  wget/7z 兜底）。

## Background and Goal

任务 030 已修复 install-deno 的多行脚本 argv 问题，命令现在能真正到达远端执行；但远端 缺少 curl/wget
或无 unzip/7z 时，安装仍按原设计 fail-closed，只给出“目标机缺少 curl 或 wget”类报错。用户在确认 030
后明确要求 install-deno “包括 curl 和 unzip 的
安装”，即希望运行时引导也补齐远端最小基础工具，让命令开箱即用，而不是要求运维手工预装。

目标：在安装 Deno 前，若远端缺少下载器和解压工具，自动尝试用目标机包管理器安装缺失的 curl 与
unzip（并保留 wget/7z 兜底），安装成功后按原流程继续安装固定版本 Deno；无法
自动补齐（不支持的发型版/包管理器、提权不可用或安装失败）时给出明确、可行动的失败。

## Scope

### In scope

- 在 `src/ssh_install.ts` 增加“补齐工具”步骤：安装 Deno 前置检查发现 curl/wget 或 unzip/7z
  缺失时，按固定模板检测可用包管理器（优先 `apt-get`，其次 `apk`、`dnf`、 `yum`），用 `privileged`
  提权路径安装 `curl` 与 `unzip` 这两个缺失工具。
- 包管理器命令使用仓库内固定模板，包名固定映射；不解析远端任意输入，不引入 shell 注入面。
- 提权沿用现有 `preflightPrivilege`（root 或 `sudo -n`）；无法提权时按 preflight 失败 （退出码
  3）处理。
- 包管理器不存在/不支持、工具安装失败时，机器结果按 transport 失败（退出码 4），并在 message
  中给出具体命令与可行动提示（例如“请手工安装 curl unzip 后重试”）。
- 补齐成功后再执行原有安装脚本（其前置检查作为兜底）与 `deno --version` 复验；
  已满足版本的目标仍跳过；无缺失工具时行为与 030 修复后一致。
- 更新 README、集群配置指南与示例 README：说明自动补齐行为、提权前提、包管理器支持范围
  与供应链信任边界。
- 补充 unit/dv 测试：缺失工具触发对应包管理器命令、已满足跳过、支持/不支持发行版失败
  映射、提权失败、Deno 安装失败路径等。

### Out of scope

- 不新增 CLI 参数（默认自动补齐，不加 `--ensure-tools` 等开关；如用户要求开关再修订提案）。
- 不改 machines.yaml/config schema，不探测远端 CPU 架构。
- 不投递控制端二进制/归档（用户选择了远端包管理器安装路线）。
- 不覆盖 pacman、zypper、Homebrew 等其它包管理器；不支持时 fail-closed 给出手工预装提示。
- 不卸载、不升级已有 curl/wget/unzip/7z，不改变 Deno 版本、来源与安装路径语义。

### Boundary with neighboring modules

- 传输模块：复用 `run` 的 `privileged`/环境变量与提权原语，不修改传输接口与校验。
- CLI/结果模块：`install-deno` 参数、筛选、确认门、JSON 结构不变；退出码语义保持
  （无工具且提权失败=3，工具安装执行失败=4，成功=0）。
- 示例模块：示例 README 说明 Ubuntu/apt-get 行为；不修改 `prepare-multipass` 脚本职责。

## Requirement Review

需求合理：运行时引导的目标就是减少手工登录预装步骤，curl/wget、unzip/7z 是官方 deno.land
安装器的硬性最小依赖，由框架自动补齐符合用户预期。主要取舍是信任与代价：
远端包管理器安装意味着以特权身份信任发行版软件源并联网，供应链边界从“只信任 deno.land
固定版本”扩大到“发行版仓库 + deno.land”；这是用户明确选择的方向，因此文档必须诚实披露。

替代方案比较：

1. 远端包管理器安装 curl/unzip（推荐，本次范围）：实现直接，示例 Ubuntu 机器已有 apt-get
   依赖模式；需要提权并记录供应链风险。
2. 控制端投递 Deno 归档/二进制：远端不再需要 curl/wget，但需要本地方便架构探测与解压，
   且用户表述明确要“安装 curl 和 unzip”，故不采用。
3. 保持 fail-closed 只给提示：与用户本次要求冲突，否决。

待确认问题：

1. 包管理器范围：建议支持 apt-get / apk / dnf / yum 四种，其余 fail-closed；是否足够？
2. 默认行为：建议默认自动补齐、不新增 CLI 开关；是否需要显式开关或按机器禁用？
3. 安装对象：建议安装 curl 与 unzip（用户原话），wget/7z 仅作兜底保留；是否需要两者都装？

## Proposal Items

| proposal_id | change_id                  | requirement                                                                                                | boundary                                                               | tradeoff                                                                      | non_goal                                                        | success_evidence                                                                                                   |
| ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| PI-1        | CHG-deno-ensure-tools      | install-deno 在远端缺少下载/解压工具时，用目标机包管理器提权安装缺失的 curl/unzip，再继续安装固定版本 Deno | 只改 ssh_install 的执行编排与失败映射；不改 CLI/结果 schema 与传输校验 | 用提权+发行版软件源换取开箱即用；固定模板防注入，不支持的包管理器 fail-closed | 不新增 CLI 参数；不覆盖全部发行版；不投递二进制；不卸载已有工具 | unit/dv 测试覆盖四种包管理器、缺失/已满足/提权失败/安装失败路径；文档说明供应链边界；check/lint/fmt 与全量测试通过 |
| PI-2        | CHG-deno-ensure-tools-docs | README、集群配置指南与示例 README 同步自动补齐行为、提权前提与支持范围                                     | 只改三份说明文档，不改既有引导/部署流程                                | 诚实披露发行版软件源供应链边界，换取可审计默认行为                            | 不承诺所有发行版；不替代供应链审批流程                          | 三份文档一致可复现；文档示例与真实命令行为一致                                                                     |

## Success Criteria

- Concrete user-visible result: 在缺少 curl/unzip 的目标机（示例 Ubuntu/multipass）上运行
  `install-deno` 并确认后，工具可在提权允许时自动安装 curl/unzip 并继续安装固定版本
  Deno；不支持或缺包管理器时给出明确失败提示，不再静默。
- Required evidence: 方案级单元/驱动测试覆盖缺失工具→apt-get/apk/dnf/yum 固定命令、
  已满足跳过、提权失败（退出 3）、安装失败（退出 4）与 Deno 安装/验证成功路径；
  设计文档记录支持矩阵与供应链边界；README/指南/示例一致；全量测试与 check/lint/fmt
  通过；验收报告含独立缺陷搜索。
- Explicit non-goals: 本任务不承诺真实公网 E2E 为唯一完成条件（可在替身环境下验证）； 不修改
  machines.yaml；不新增 CLI 参数（缺省行为直接变更并在验收中确认文档与行为一致）。

## Risks

- 供应链：自动安装来自发行版软件源，需在文档与验收中明确该信任边界；工具版本不由框架
  固定，只保证命令存在。
- 安全/提权：包管理器命令以 root/`sudo -n` 执行；只用仓库内固定模板，安装对象固定为
  curl/unzip，拒绝用户输入进入命令模板。
- 兼容：不支持的发型版（例如无四种包管理器）必须 fail-closed 并可行动，不能半途无提示；
  `apt-get update` 会刷新远端索引，需在文档说明。
- 行为变更：缺省从“报错提示”变为“自动安装”，与旧版本/文档不一致；通过版本说明、 README
  更新和验收一致性检查收口。
