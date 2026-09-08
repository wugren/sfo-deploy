---
task_manifest: task.yaml
status: approved
---

# 通用 CLI：安装后从当前目录按名称发现集群提案

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries:
  - 修改 `sfo-deploy` 通用命令的公共 CLI 契约：`--config-root`
    从必选改为可选，缺失时按当前工作目录发现集群，属于公共 CLI 行为变化。
  - 公开契约已有回归测试（`tests/contract/test_public_contract.py`、`tests/integration/test_project_cli.py`），需要同步维护，属于
    bounded 的单项目功能变更。
  - 不涉及集群配置
    schema、SSH/信任包/密钥机制、持久化数据、依赖/构建图、跨项目边界或高风险部署面；命中触发器：contract-protocol。
- Proposal and tier confirmation: 用户已确认按提案执行，最终层级为 `standard`；同时确认保持现有
  `sfo-deploy <动作> --cluster <名称>` 调用形式，并采用 `./<集群名>` 与 `./clusters/<集群名>`
  两个确定性候选位置。

## Background and Goal

`sfo-deploy` 安装后虽然已经提供 `sfo-deploy` 控制台入口，但通用命令强制要求显式
`--config-root`，集群必须严格是该配置根的直接子目录。用户在已经包含集群目录的工作目录里仍然要重复输入配置根，不符合“直接输入集群名称和部署步骤即可”的预期。

目标：安装后用户可以在包含集群目录的当前目录中执行 `sfo-deploy <动作> --cluster <名称>`，无需再传
`--config-root`；集群目录按名称从当前目录搜索。配置环境、更新安全配置、更新程序等部署步骤继续由现有动作表达（`configure`、`deploy`
等），并在 README 中给出清晰的命令映射。

## Scope

### In scope

- `sfo-deploy` 通用命令的 `--config-root`
  变为可选：省略时在调用时当前目录中按名称搜索集群；显式传入时保持现有精确语义。
- 当前目录搜索的确定性候选位置为 `./<集群名>` 与
  `./clusters/<集群名>`，按此顺序取第一个存在的集群目录；两者都不存在时报配置错误。
- 固定动作集合、选择器和错误码保持不变；项目绑定 CLI（`create_cli` 生成的 bound
  入口）保持固定配置根、拒绝 `--config-root` 的既有行为。
- README 命令行章节更新为免 `--config-root` 用法，并给出“配置环境 / 更新安全配置 /
  更新程序”与现有动作的映射表。
- 补充或调整通用 CLI 的契约与集成回归测试，覆盖省略参数、显式参数、`clusters/` 候选、缺失集群与
  bound 入口不受影响。

### Out of scope

- 不新增中文或“别名”步骤子命令；步骤语义只复用现有动作集合。
- 不做任意深度递归目录扫描；不自动猜测或模糊匹配集群名称。
- 不改变 `RunOptions`、集群装载 schema、SSH 信任、密钥投递、规划或执行逻辑。
- 不改变项目绑定 CLI 的绝对配置根行为。

### Boundary with neighboring modules

- 改动集中在 `src/sfo_deploy` 通用包、README 与仓库测试；`examples/` 和部署框架核心行为不做修改。

## Requirement Review

该需求合理：通用入口安装后应当开箱即用，在包含集群目录的当前目录中只需输入集群名和部署步骤。把
`--config-root` 改为默认当前目录是最小且向后兼容的改法，显式传参仍然可用，项目绑定入口语义不变。

主要取舍是“从当前目录搜索”的范围：本提案使用两个确定性候选位置（`./<集群名>` 与
`./clusters/<集群名>`），覆盖“目录内直接放集群”和仓库标准 `clusters/`
布局两种常见情形，同时避免递归扫描的歧义与性能问题。

## Proposal Items

| proposal_id | change_id                | requirement                                                                                                                                          | boundary                                                                      | tradeoff                       | success_evidence                                                                                                                        | non_goal                        |
| ----------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| P-001       | CHG-cli-cwd-cluster-step | 通用 `sfo-deploy` 的 `--config-root` 改为可选；省略时从调用时当前目录的 `./production` 与 `./clusters/production` 按序发现集群目录                   | 显式 `--config-root` 语义不变；候选位置确定性优先序；两者都不存在时报配置错误 | 提升开箱体验，同时保留显式覆盖 | 在含 production 集群目录的临时目录运行 `sfo-deploy validate --cluster production` 成功且无需 `--config-root`；README 两种布局示例均可用 | 不递归扫描、不模糊匹配          |
| P-002       | CHG-cli-cwd-cluster-step | README 命令行章节给出免 `--config-root` 用法和“配置环境 / 更新安全配置 / 更新程序”到现有动作的映射                                                   | 动作本体与帮助文本不新增别名；映射只作为用户指引                              | 文档与行为一致，避免用户猜测   | README 示例命令与实现行为一致；公开契约测试同步通过                                                                                     | 不新增中文步骤参数              |
| P-003       | CHG-cli-cwd-cluster-step | 补充/调整通用 CLI 回归测试：省略 `--config-root`、显式 `--config-root`、`clusters/` 候选搜索、缺失集群错误，以及 bound CLI 拒绝 `--config-root` 不变 | 测试只覆盖 CLI 解析与集群发现，不触碰规划/执行内核                            | 行为变化被契约测试固定         | 新增与既有 CLI 相关测试全部通过                                                                                                         | 不为本变更引入真实 SSH/部署执行 |

## Success Criteria

- Concrete user-visible or system-visible result: 安装包后，在含 `production/` 或
  `clusters/production/` 的当前目录运行 `sfo-deploy validate --cluster production`（以及
  `plan`、`configure`、`deploy`、`check`、`install` 等动作）不再要求
  `--config-root`；显式传参时行为不变。
- Required evidence: 新增/更新测试全部通过，包括省略参数、显式参数、`clusters/`
  候选、缺失集群错误码与 bound 入口不变；`python -m sfo_deploy --help` 显示 `--config-root`
  可选；README 命令行示例与实际行为一致。
- Explicit non-goals: 不新增新步骤/别名命令；不改集群发现之外的框架行为；不做真实远端部署验证。

## Risks

- 公共 CLI 契约变化：必选参数变为可选，帮助文本、README
  与既有契约测试需要同步；显式路径保留以维持向后兼容。
- 搜索范围误判：若用户实际需要任意深度递归或其它布局，本提案的确定性候选范围不覆盖；通过明确报错信息与
  README 说明降低误用风险。
- 双候选位置歧义：`./<集群名>` 与 `./clusters/<集群名>`
  同时存在时按固定顺序取前者，需在文档中写明；确认时若用户有不同预期可调整。

## Resolved Question

1. 调用形式：保持现有 `sfo-deploy <动作> --cluster <名称>`，不新增位置参数形式。
2. 搜索范围：采用 `./<集群名>` 与 `./clusters/<集群名>` 两个确定性候选位置，不支持任意深度递归。
