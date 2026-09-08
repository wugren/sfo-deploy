---
task_manifest: task.yaml
status: approved
---

# 示例模板不再写入 machines.yaml.deno 参数提案

Risk profile: not-created（不需要；仅在确认 high-risk 时创建）

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 本需求只修改示例集群模板与示例 README，把 `machines.yaml`
  的 `deno` 字段从模板中去掉，让生成集群使用框架既有的 `deno` 默认值。 不涉及
  CLI/公开契约、schema、安全边界、供应链或生产默认行为的改动；但涉及示例文档与
  运行时调用方式的一致性，使用 standard 记录变更并做一次文档/配置验证。
- Proposal and tier confirmation: 用户已回复“确认”，确认本提案及其 standard 层级。

## Background and Goal

用户发现框架对 `machines.yaml.deno` 的默认值本来就是裸命令 `deno`，并不需要硬编码
绝对路径；因此希望示例模板中也不要写 `deno` 参数，让生成出来的集群保持默认行为。

目标：删除 `examples/eleph-server-multipass/cluster-template/machines.yaml.tpl` 的
`deno: /usr/local/bin/deno` 行，并同步示例 README 中引用该模板路径的说明，使模板与
框架默认行为一致。

## Scope

### In scope

- 删除模板 `machines.yaml.tpl` 中机器的 `deno` 字段，生成后的 `machines.yaml` 不再 包含该字段。
- 更新示例 README：移除“模板 machines.yaml 的 deno: /usr/local/bin/deno 一致”的说明， 改为说明未写
  `deno` 时框架默认使用 `deno` 命令，并说明 PATH/安装目录前提。
- 重新生成替身集群或直接用模板替换 IP 后跑 `validate`，确认框架按默认 `deno` 装载。

### Out of scope

- 不删除 `machines.yaml.deno` 字段本身的支持（字段仍可选，用于自定义运行时路径）。
- 不修改 `install-deno` 的安装路径或配置同步行为。
- 不修改其它集群模板、指南或框架源码。

### Boundary with neighboring modules

- 配置模块：继续使用 `item.deno ?? "deno"` 的既有默认值，本次只是让示例不再覆盖默认。
- 示例模块：仅改 `eleph-server-multipass` 模板与 README。

## Requirement Review

需求合理：框架对缺省运行时已是裸命令 `deno`，模板硬编码绝对路径属于冗余且可能产生
用户看到的路径不一致问题。删除后生成集群与框架默认保持一致。

替代方案：

1. 删除模板字段（推荐，本次范围）：最简单，直接使用默认值。
2. 保留字段但改成 `deno: deno`：依然显式冗余，且与“不写参数”的诉求不一致。
3. 修改框架默认逻辑：没有必要，框架默认本来就是 `deno`。

## Proposal Items

| proposal_id | change_id                      | requirement                                                       | boundary                                              | tradeoff                                                     | success_evidence                                                                                         | non_goal                                 |
| ----------- | ------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| PI-1        | CHG-remove-template-deno-field | 示例模板不再写出 `deno` 字段，生成集群使用框架默认的裸命令 `deno` | 只改示例模板与示例 README；不改配置 schema 与框架行为 | 配置更简洁并与默认一致；代价是需要 README 明确远端 PATH 前提 | 模板无 deno 行；模板替换 IP 后 validate 通过；README 无“与模板 deno 路径一致”旧说明；check/lint/fmt 通过 | 不删除可选字段；不改变 install-deno 行为 |

## Success Criteria

- Concrete user-visible result: 重新生成 `eleph-server-multipass` 集群后， `machines.yaml`
  中不再出现 `deno` 字段，`sfo-deploy validate` 成功，远端脚本预检 按默认 `deno` 命令执行。
- Required evidence: 模板内容无 deno 行；生成/替身集群 validate 通过；示例 README 说明默认 `deno`
  命令与 PATH 前提；相关测试与 check/lint/fmt 通过；standard completion-report 完成。
- Explicit non-goals: 不修改框架对 `deno` 字段的解析；不要求所有远端 PATH 都预装 deno；不做真实 SSH
  E2E。

## Risks

- 远端 PATH：模板不写 `deno` 后，如果 SSH 非交互会话的 PATH 不包含 Deno 可执行文件，
  预检会失败。缓解：README 明确保留 `--install-to /usr/local` 建议（`/usr/local/bin` 通常在默认
  PATH），并提示手工安装时需要把安装目录加入 PATH。
- 文档一致性：若只删模板不更新 README，会留下旧路径说明；因此 README 与模板同步修改。
