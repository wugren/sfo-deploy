---
task_manifest: task.yaml
status: approved
---

# check/install 缺省环境过滤器时选择集群全部环境提案

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries:
  - 修改 `sfo-deploy` 两个公共 CLI 动作的缺省行为：省略 `--environment` 时从“报错退出码
    2”改为“选择全部环境”，属于公共 CLI 契约变化，命中 contract-protocol 触发器。
  - 改动集中在 `sfo-deploy`
    单模块：入口校验移除强制项，规划器已有“过滤器缺省全选”语义可直接复用，不涉及配置
    schema、SSH/密钥信任、持久化数据、依赖/构建图或跨项目边界。
  - `install`
    属于远端修改类部署动作，缺省全选有误操作面；这不改变脚本执行能力或执行顺序，属于用户明确要求的缺省目标调整，不是新的高风险能力面。按实际后果评估为
    bounded 的标准层级变更。
- Proposal and tier confirmation: 用户已确认按提案执行，最终层级为
  `standard`；同时确认预执行确认门禁只对 `install` 生效，`check` 的缺省全量不要求确认。

## Background and Goal

当前 `check` 与 `install` 被 CLI 入口强制要求至少一个 `--environment`，省略时直接报“环境动作
check/install 必须至少指定一个 --environment”，退出码
2。规划器本身对“未传过滤器”的语义是选择全部对象，因此 `plan`/`deploy` 省略 `--app` 都会作用于全部
App/环境，唯独 check/install 在入口被挡下。

目标：让 `check` 与 `install` 省略 `--environment`
时采用与其他动作一致的缺省语义，即检查或安装当前选择范围内（默认全部机器）的集群全部环境；显式传入环境过滤器时保持现有选择与依赖校验行为。由于全量
`install` 会修改远端，在真正执行前加入一道预执行确认门禁；`check` 为只读检查，不设确认。

## Scope

### In scope

- `RunOptions` 校验解除对 `check`/`install` 的“必须指定
  --environment”要求；省略时传给规划器的环境过滤器为空，从而选择全部机器上的全部环境。
- 保留 `check`/`install` 不能与 `--app`
  同时使用的校验；保留未知环境/机器筛选、空选择与依赖缺失的规划错误语义。
- 当 `install` 省略 `--environment` 并进入执行路径时，CLI 在计划生成后、任何 SSH
  连接前打印将处理的机器/环境范围，并要求交互确认；拒绝、EOF
  或非交互环境未显式同意时视为取消，不执行任何远端步骤。
- `check` 省略 `--environment` 时直接检查全部环境，不进入确认门禁。
- 新增 `--yes` 标志：仅用于跳过上述缺省全量确认门禁，供脚本/CI 等非交互场景显式表示同意；显式传入
  `--environment` 的既有路径不需要确认，不受影响。
- 补充或调整框架 CLI 契约测试，覆盖无环境参数时选择全部环境、显式环境子集不受影响、`--app`
  冲突仍拒绝，以及 `--machine` 收窄范围。
- 更新 README 命令行说明：`check`/`install` 不再强制要求
  `--environment`，省略时默认检查/安装全部环境，并给出 `--machine`/`--environment`
  收窄范围、预执行确认与 `--yes` 的说明。

### Out of scope

- 不新增 `--all-environments` 或其它别名/旗标；缺省即全选。
- 不改变 `plan`/`deploy`/`configure` 的现有过滤语义。
- 不改变环境依赖传递、执行顺序、串行执行、下载、密钥或模板机制。
- 不引入 dry-run 门禁；确认只是执行前的交互闸门，不影响计划目标。
- 确认门禁不扩展到显式指定环境、`check`、`deploy` 或其它动作的现有执行路径。

### Boundary with neighboring modules

- 边界在 `src/sfo_deploy` 入口校验与规划调用、仓库 `tests/` 契约测试、`README.md`；`examples/`
  与示例 CLI 不加改动。

## Requirement Review

需求合理：让所有动作保持“过滤器缺省全选”的一致语义，用户不需要先枚举集群里的每个环境名才能做全量检查或安装。

主要取舍是安全边界：`install`
缺省全集群执行可能放大误操作后果。原设计用强制点名防止“忘了传环境”。本次按用户明确要求改为缺省全选，并对
`install` 加入交互确认：交互终端现场确认，非交互环境必须显式传
`--yes`，从而把“忘了传”从静默全量变成可察觉的确认步骤；`check`
保持无确认的只读全量语义；最终由用户确认接受该取舍。

## Proposal Items

| proposal_id | change_id                    | requirement                                                                                                                          | boundary                                                                            | tradeoff                                                             | success_evidence                                            | non_goal                               |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| P-001       | CHG-default-all-environments | `check`/`install` 省略 `--environment` 时选择集群全部环境并正常规划/执行                                                             | 显式环境过滤器保留；`--app` 冲突仍拒绝；空选择与依赖缺失仍报规划错误                | 一致缺省语义换取更高的误操作风险                                     | CLI 测试覆盖无环境参数与显式参数两种路径，均通过            | 不新增 `--all-environments` 等别名旗标 |
| P-002       | CHG-default-all-environments | 缺省全量的 `install` 在执行前进入确认门禁：打印目标范围并要求同意，拒绝/EOF/非交互未同意则取消；`--yes` 显式跳过确认；`check` 不确认 | 仅作用于省略环境过滤器的 install 执行路径；显式环境参数与其它动作（含 check）不确认 | 用一次确认抵消 install 静默全量的误操作风险，脚本用 `--yes` 显式买单 | 测试覆盖同意、拒绝、EOF、`--yes` 四种路径，均符合预期退出码 | 不做 dry-run                           |
| P-003       | CHG-default-all-environments | 将 check/install 缺省全部环境的语义、install 确认门禁与 `--yes` 写入 README，并说明收窄范围的过滤器                                  | 文档与行为一致                                                                      | 清晰表达缺省全量与确认要求                                           | README 示例与测试契约一致                                   | 不改变显式环境路径                     |

## Success Criteria

- Concrete user-visible or system-visible result: 在任意已加载集群上执行
  `sfo-deploy check --cluster <名称>` 与 `sfo-deploy install --cluster <名称>`
  不再因缺省参数报错；`install` 在交互终端会先看到目标范围并确认后才真正执行，显式传 `--yes`
  则直接执行，`check` 无需确认；显式 `--environment` 时只作用于所选环境且不确认。
- Required evidence: 新增/更新缺陷驱动与项目 CLI 测试全部通过，覆盖 install
  确认门禁的同意、拒绝、EOF、`--yes` 路径与退出码，以及 check 缺省全量不确认；README
  说明与实现一致；`--app` 冲突与显式环境子集的既有行为回归通过。
- Explicit non-goals: 不新增 dry-run 机制，不改变安装脚本与执行器本身，不把确认扩展到显式环境路径或
  `check`。

## Risks

- 全量 install 误操作面：省略环境参数时可能一次修改整个集群的远端环境；方案保留
  `--machine`/`--environment` 收窄能力并在文档显著说明。
- 确认疲劳与强制同意：交互确认可被用户随意同意，`--yes`
  也会放宽保护；方案定位为“防忘传”的默认闸门而非权限系统，README 明确两者都不能替代精确的过滤器。
- 非交互 install 调用：没有 TTY 且未传 `--yes` 时命令会取消并退出 130；自动化调用需显式使用
  `--yes`，README 提供示例。
- 行为回退兼容：原来依赖“缺省报错”的调用方可能行为变化；这是本次明确需求，不提供开关或降级。
- 范围一致性：若过滤结果为空（例如选中的机器没有任何环境），规划器报“过滤条件没有选择任何部署对象”，错误码保持
  2。

## Resolved Questions

1. 确认门禁只对会修改远端的 `install` 生效；`check`
   是只读检查，缺省全量时不弹确认（用户确认时明确说明）。
