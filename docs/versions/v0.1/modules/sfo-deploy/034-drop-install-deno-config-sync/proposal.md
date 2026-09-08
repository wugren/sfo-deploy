---
task_manifest: task.yaml
status: approved
---

# install-deno 不再回写 machines.yaml.deno 提案

Risk profile: not-created（不需要；仅在确认 high-risk 时创建）

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 本需求移除 task 032 加入的 `install-deno`→`machines.yaml`
  自动同步行为，回到“安装动作不修改集群配置”的原始语义。 不新增
  CLI/JSON/退出码契约、不写持久数据、不触碰安全边界；属于有界的单模块行为回退， 使用 standard
  记录变更并做针对性回归。
- Proposal and tier confirmation: 用户已回复“确认”，确认本提案及其 standard 层级。

## Background and Goal

用户希望 `install-deno` 只负责安装 Deno，不再把实际安装路径回写到 `machines.yaml.deno`。Deno
官方安装器安装到 `$HOME/.deno/bin` 后会在用户 shell 配置中 加入 PATH；示例模板已不再写 `deno`
字段，因此安装后直接用默认裸命令 `deno` 即可， 不需要框架代写配置。

目标：移除 `install-deno` 对 `machines.yaml` 的写回调用及相关代码、测试与文档说明，
使该动作不再产生本地持久副作用。

## Scope

### In scope

- 从 `src/integration.ts` 删除 `syncMachineDenoConfig` 调用与辅助函数，`install-deno`
  完成探测/安装/复验后只返回结果，不写 `machines.yaml`。
- 从 `src/config.ts` 删除仅为该写回服务的 `syncMachineDenos`、`MachineDenoUpdate` 及
  行级改写辅助代码；保留 `machines.yaml.deno` 字段的可选解析能力。
- 删除/还原针对配置写回的单元用例、DV 用例和文档契约断言。
- 更新 README、集群配置指南与示例 README：说明 install-deno 不修改 `machines.yaml`； `deno`
  字段不写时默认使用裸命令 `deno`，并提示远端 PATH 需包含已安装的 Deno。

### Out of scope

- 不改变 Deno 默认安装目录、固定版本、安装脚本或安装后的 PATH 处理。
- 不改变 `machines.yaml.deno` 字段本身：用户仍可手工写绝对路径或裸命令名。
- 不修改示例模板（task 033 已完成删除字段）。
- 不改变 install-deno 的 CLI 参数、确认门禁、JSON 结果与退出码。

### Boundary with neighboring modules

- 配置模块：继续严格加载可选 `deno` 字段；删除只被 install-deno 使用的写回 API。
- 脚本执行模块：预检与执行仍按 `machines.yaml.deno`（缺省 `deno`）调用远端运行时。

## Requirement Review

需求合理：install-deno 的职责是运行时引导，是否把路径写回配置属于可分离的持久副作用。
用户明确选择“安装后靠 PATH 使用 `deno`”，且模板已不写该字段；移除同步使行为回到 029
的原始边界并减少配置文件意外改动。

替代方案：

1. 移除全部自动写回（推荐，本次范围）：最符合“安装在哪就是哪”的表述。
2. 保留写回但只在显式 `--install-to` 时发生：增加两种语义分支，且仍会在用户不知情时 改配置，不采用。
3. 保留写回但总是写裸命令 `deno`：会掩盖真实安装路径且依赖 PATH，仍违背“不写配置”。

## Proposal Items

| proposal_id | change_id                       | requirement                                                                   | boundary                                               | tradeoff                                                               | success_evidence                                                               | non_goal                           |
| ----------- | ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| PI-1        | CHG-drop-install-deno-sync      | install-deno 不再写入或修改 machines.yaml.deno                                | 只改 install-deno 编排与相关测试；不动 CLI/JSON/退出码 | 取消自动同步换取动作零持久副作用；用户需自行确保 PATH 或 deno 字段正确 | 源码无 syncMachineDenos 调用；DV 测试不再断言配置被修改；unit 中写回用例已移除 | 不改变安装位置/版本/PATH 处理      |
| PI-2        | CHG-drop-install-deno-sync-docs | 三份文档与文档契约改为说明 install-deno 不修改 machines.yaml，缺省使用 `deno` | 只改说明文档与契约测试                                 | 文档诚实反映行为回退；用户需要理解 PATH 前提                           | 三份文档无自动同步旧断言；契约测试通过；check/lint/fmt 与全量测试通过          | 不承诺所有远端 shell 都会加载 PATH |

## Success Criteria

- Concrete user-visible result: 运行 install-deno 后 `machines.yaml` 内容不变；后续 prepare 按
  `deno` 字段（缺省 `deno` 命令）调用远端运行时。
- Required evidence: 删除同步代码与相关测试；DV 安装用例确认配置文件 mtime/内容不变；
  文档契约移除“自动同步”断言；全量测试、check/lint/fmt 通过；standard 完成报告完成。
- Explicit non-goals: 不保证远端非交互 PATH 一定包含 Deno；不自动更新已存在集群的 deno 字段。

## Risks

- PATH 依赖：若远端 SSH 非交互会话未加载安装器写入的 PATH，prepare 预检会报 `deno`
  不可用。缓解：README 明确推荐 `--install-to /usr/local`（通常已在 PATH）或
  手工安装后把安装目录加入 PATH；用户也可按需手工在 machines.yaml 写绝对路径。
- 文档回退：此前 032 文档/契约均声明自动同步，本次需同步撤销，避免契约测试与真实行为 不一致。
