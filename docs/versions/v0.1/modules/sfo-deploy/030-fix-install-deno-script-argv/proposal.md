---
task_manifest: task.yaml
status: approved
---

# 修复 install-deno 远端命令参数不合法提案

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 这是 sfo-deploy 模块内有界的生产 bugfix， 位于
  `src/ssh_install.ts` 向传输层构造远端命令的边界。未触及公开 CLI 契约/退出码/ JSON
  结构、持久数据、安全信任模型、依赖/供应链、发布或回滚行为，因此没有 high-risk
  触发点；但问题本身属于远端命令执行（runtime）路径，且实现存在一个小的方案取舍， 使用 standard
  默认流程并留变更记录比 trivial 更稳妥。用户确认时可替换为 trivial 并 记录残余风险。
- Proposal and tier confirmation: 用户已回复“确认，按照你的步骤来”，确认本提案及其 standard
  层级，并保持“只修脚本 argv 传输问题、不扩展自动安装远端基础工具”的范围。

## Background and Goal

用户报告
`sfo-deploy install-deno --cluster multipass --config-root
./examples/eleph-server-multipass/clusters`
在确认后立即失败，返回 `error_category: transport`、`message: 远端命令参数不合法` 以及完整安装脚本。

根因已通过最小复现确认：`installerScript()` 用换行（`\n`）拼装多行 POSIX shell 脚本后， 作为一个
argv 元素传给 `/bin/sh -c`；而 `OpenSshRemoteSession.run` 的 `validateArgv`
有意拒绝任何含控制字符（换行属于控制字符）的参数，因此每次实际安装都会在本地构造命令时 失败，与
`--config-root`、集群或机器配置无关。目标是把安装脚本改造成既通过传输层 校验、又保持原有 shell
语义，让 install-deno 真正能执行远端安装。

## Scope

### In scope

- 修改 `src/ssh_install.ts` 的安装脚本构造方式：输出不含控制字符的单行 POSIX shell 命令（语句以 `;`
  分隔），保留 `set -eu`、curl/wget 与 unzip/7z 前置检查、安装命令与 固定版本参数。
- 保留 `DENO_INSTALL` 环境变量、提权判定（默认 `$HOME/.deno` 不提权，其它路径按需
  root/`sudo -n`）与安装后 `deno --version` 验证逻辑不变。
- 补充回归测试：断言安装脚本可被传输层 `validateArgv` 接受、仍包含固定版本号，且现有 unit/dv
  测试继续通过。
- 运行 relevant 测试以及 `deno task check`、lint、fmt。

### Out of scope

- 不改变 CLI 动作、参数、帮助、JSON 结果或退出码契约（成功 0、失败 4 等）。
- 不放松或修改 `validateArgv`/`quotePosix` 的安全校验（控制字符拒绝是不变式）。
- 不为 `RemoteSession` 新增 stdin 或工作区脚本投递 API；不改变 Deno 安装版本、来源、 `--install-to`
  语义或 machines.yaml 约定。
- 不改文档：README 与指南描述的行为保持不变，本次只是让已文档化的行为真正可执行。

### Boundary with neighboring modules

- 传输模块：仅消费现有 `run`/`validateArgv` 契约，不改传输接口与信任模型。
- CLI/结果模块：动作、筛选、确认门、退出码与 JSON 序列化不涉及。
- 示例模块：`eleph-server-multipass` 集群配置仅是复现场景，不修改示例文件。

## Requirement Review

需求合理，且是阻碍 install-deno 全部安装路径的缺陷，值得修复。主要取舍是把原本可读的
多行脚本压缩成单行：POSIX shell 中换行与 `;` 语句分隔等价，条件分支、管道与 `set -eu`
在一行内均保持语义；输出仍作为单 argv 传给 `/bin/sh -c`，不需要放宽传输层校验。

替代方案比较：

1. 单行拼装安装脚本（推荐）：改动最小、不碰安全不变式，行为与错误信息不变。
2. 新增工作区上传脚本再执行：需要为 install-deno 引入工作区生命周期和远程文件清理，
   改动面更大，且本任务不需要。
3. 放宽 `validateArgv` 允许换行：会削弱对所有命令的统一安全校验，明确否决。

## Proposal Items

| proposal_id | change_id                        | requirement                                                                      | boundary                                                                           | tradeoff                                          | non_goal                                             | success_evidence                                                                            |
| ----------- | -------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| PI-1        | CHG-fix-deno-install-script-argv | 修复 install-deno 安装脚本无法通过传输层参数校验的问题，使缺省全量安装可正常执行 | 只改 `src/ssh_install.ts` 的脚本构造与对应测试；不改传输层校验、CLI 契约与安装语义 | 用单行 `;` 分隔脚本换取通过既有安全校验且改动最小 | 不为传输层新增投递 API；不修改安装版本/来源/路径语义 | 单行脚本可被 `validateArgv` 接受；unit/dv 测试、check、lint、fmt 通过；确认流程与退出码不变 |

## Success Criteria

- Concrete user-visible result: 用户运行
  `sfo-deploy install-deno --cluster multipass
  --config-root ./examples/eleph-server-multipass/clusters`
  并输入 `yes` 后，不再出现 “远端命令参数不合法”，远端有最小依赖时正常安装或跳过，JSON
  结果与退出码语义不变。
- Required evidence: 回归测试覆盖脚本可被 `validateArgv` 接受且版本参数正确；
  `deno task check`、lint、fmt 与相关 unit/dv 测试通过；完成报告含独立缺陷搜索。
- Explicit non-goals: 不在本任务真实连通 multipass 机器以证明端到端；不改变任何文档或 公开契约。

## Risks

- 单行化后若漏掉语句分隔符会改变 shell 语义：用语句数组显式 `join("; ")` 构造，并保留
  原条件分支与管道结构，回归测试覆盖完整脚本内容。
- 若目标机确实缺少 curl/wget 或 unzip/7z，安装仍按原设计 fail-closed 并以明确中文
  报错失败，这一行为不变。
- 残余风险：无法在本环境保证真实远端安装成功；真实 multipass 环境可做后续 E2E 验证。
