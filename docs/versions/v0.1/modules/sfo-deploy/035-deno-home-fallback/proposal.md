---
task_manifest: task.yaml
status: approved
---

# install-deno 缺省安装到 PATH 目录提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本需求改变 install-deno 的生产默认行为：缺省 安装位置从
  `$HOME/.deno` 改为 `/usr/local`（`/usr/local/bin` 在默认 PATH），默认
  安装不再免提权，而要求远端身份 root 或可 `sudo -n`。这触及 production-default/
  rollout、security（默认提权）、runtime-integration 与公开帮助/文档契约，因此默认按 high-risk
  提案，进入 proposal → design → implementation → testing → acceptance
  完整流程。用户确认时可选择替换为 standard 并记录残余风险。
- Proposal and tier confirmation: 用户已回复“确认，自动完成”，确认本提案与 high-risk
  层级，并授权从提案批准后自动完成全部后续 lifecycle 阶段；方向为 install-deno 缺省 安装到
  /usr/local。

## Background and Goal

用户要求 install-deno 安装完成后，其它 sfo-deploy 命令无需改配置或 PATH 即可使用。
现状：install-deno 缺省安装到 `$HOME/.deno/bin/deno`，而 SSH 非交互会话的 PATH 往往 不含该目录，导致
`prepare`/`deploy` 仍找不到 Deno。

目标：把 install-deno 的缺省安装根目录改为 `/usr/local`，使可执行文件位于
`/usr/local/bin/deno`（Linux 默认 PATH 目录）；未写 `deno` 字段时框架按裸命令 `deno`
调用即可直接命中该路径。

## Scope

### In scope

- `src/ssh_install.ts`：未传 `--install-to` 时，缺省安装根目录从 `${home}/.deno` 改为
  `/usr/local`；返回的 `denoPath` 为 `/usr/local/bin/deno`。
- 提权语义：`/usr/local` 非当前用户可写目录，缺省安装也走 `privileged` 路径；远端 身份必须为 root
  或可 `sudo -n`，否则按 preflight 失败（退出码 3）。
- CLI 帮助、README、集群配置指南与示例 README：把“缺省安装到远端
  `$HOME/.deno/bin/deno`”改为“缺省安装到 `/usr/local/bin/deno`”，并说明提权前提。
- 更新 unit/dv/integration 回归：缺省安装、缺省提权、跳过 present、显式 `--install-to $HOME`
  仍免提权等路径。

### Out of scope

- 不恢复 `install-deno` 对 `machines.yaml` 的自动写回。
- 不在运行阶段做 PATH 兜底搜索、不改变脚本执行解析逻辑。
- 不新增 CLI 参数；不改 `--install-to`、`--deno-version`、确认门禁、JSON 与退出码。
- 不修改 Python 解释器解析。

### Boundary with neighboring modules

- 配置模块：`machines.yaml.deno` 仍可选；不写 `deno` 时默认裸命令 `deno` 经 PATH 找到
  `/usr/local/bin/deno`。
- 传输模块：复用现有 `privileged`/`preflightPrivilege` 原语，不改变接口。

## Requirement Review

需求合理：/usr/local/bin 是 Linux 多数发行版 ssh 非交互会话的默认 PATH 目录，把 install-deno
的缺省安装目标放到这里可直接解决“安装后找不到 deno”。代价是缺省安装
需要提权；这与用户明确选择的方向一致，且文档已说明 multipass 默认 ubuntu 用户可 `sudo -n`。

替代方案：

1. 缺省安装到 `/usr/local`（推荐，本次范围）：直接命中 PATH，改动集中在安装编排。
2. 保持 home 安装并在 `/usr/local/bin` 创建软链：需要新增远程提权副作用且更隐蔽。
3. 运行时 PATH 兜底：改变每次命令的解析语义，用户已不选择该方向。
4. 恢复自动写 machines.yaml：用户已明确不想要。

## Proposal Items

| proposal_id | change_id                     | requirement                                                       | boundary                                            | tradeoff               | success_evidence                                                                 | non_goal                               |
| ----------- | ----------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| PI-1        | CHG-install-deno-path-default | install-deno 缺省把 Deno 安装到 /usr/local，使 deno 位于默认 PATH | 只改安装根目录默认值与提权语义；不新增参数/不写配置 | 用默认提权换取装完即用 | unit/dv 覆盖缺省 /usr/local、提权失败 preflight、显式 $HOME 免提权；全量测试通过 | 不写 machines.yaml；不做 PATH 兜底搜索 |
| PI-2        | CHG-install-deno-path-docs    | CLI 帮助与三份文档说明缺省 /usr/local 与提权前提                  | 只改说明文档与帮助文本                              | 文档与默认行为一致     | 帮助/README/指南/示例一致；契约测试通过                                          | 不承诺所有发行版 PATH                  |

## Success Criteria

- Concrete user-visible result: multipass 上运行 `install-deno`（不带
  `--install-to`）后，`/usr/local/bin/deno --version` 可执行，`prepare` 按默认 `deno`
  命令直接通过预检。
- Required evidence: unit/dv 证明缺省 denoPath=/usr/local/bin/deno、缺省
  privileged=true、提权失败退出 3、显式 home 目录免提权；帮助与三份文档同步；全量
  测试、check/lint/fmt 通过；high-risk 生命周期完成。
- Explicit non-goals: 不保证无 sudo 主机的缺省安装成功；不修改其它动作。

## Risks

- 提权：缺省安装从免提权变为需 root/`sudo -n`，无 sudo 主机需显式 `--install-to $HOME/.deno`
  或手工安装。README 将明确该前提。
- 行为变化：帮助文本、缺省路径与已装版本探测路径同步变化；present 探测也改为 `/usr/local/bin/deno`。
- 兼容：旧 `$HOME/.deno` 安装不会被自动迁移；用户可继续用 `--install-to $HOME/.deno`
  并在需要时显式配置。
