---
task_manifest: task.yaml
status: approved
---

# install-deno 安装后同步 machines.yaml Deno 路径提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本需求改变 `install-deno` 的既有公开行为 （任务 029
  明确“不自动改写 machines.yaml”），并开始写入用户的持久集群配置。这触及
  persistent-data/config（修改 machines.yaml）、public-contract/CLI（行为契约与文档
  变更）、security（哪些路径可被写入、写失败如何处理）与 production-default/rollout
  （缺省安装后行为变化）边界，因此按 high-risk 提案，进入 proposal → design → implementation →
  testing → acceptance 完整流程。用户确认时可选择替换为 standard 或 trivial，并记录残余风险。
- Proposal and tier confirmation: 用户已回复“确认，自动完成”，确认本提案、推荐方案 （install-deno
  安装成功后自动同步 machines.yaml.deno）与 high-risk 层级，并授权从 提案批准后自动完成全部后续
  lifecycle 阶段。

## Background and Goal

用户报告的可复现场景：

```bash
sfo-deploy install-deno --cluster multipass --config-root ./examples/eleph-server-multipass/clusters
# 缺省安装到 /home/ubuntu/.deno/bin/deno，结果 status=installed
sfo-deploy prepare --cluster multipass --config-root ./examples/eleph-server-multipass/clusters --env jre
# preflight 仍查找 /usr/local/bin/deno，失败
```

根因：`install-deno` 缺省安装在远端 `$HOME/.deno/bin/deno`，但 `machines.yaml` 的 `deno`
字段仍指向模板默认值 `/usr/local/bin/deno`。`install-deno` 虽然返回了每台机器的 实际
`deno_path`，却不会回写集群配置；后续任何动作都按 `machines.yaml` 的旧路径预检，
因此出现“刚安装成功，prepare 却找不到 Deno”的断裂。

目标：让 `install-deno` 在完成验证后把选中机器的 `machines.yaml` 中 `deno` 字段同步为
实际安装路径，使报告中的“缺省安装 → prepare”流程开箱即用，同时保持对用户已有配置的
最小、可审计改写。

## Scope

### In scope

- `install-deno` 对每台状态为 `installed` 或 `present` 的机器，把该机器在 `machines.yaml` 中的
  `deno` 字段改为验证后的实际 `denoPath`。
- 仅在路径与当前配置不同时改写；只更新本任务选中的机器，不使用结果覆盖其它机器字段。
- 使用目标化的文本改写（保留注释、字段顺序和文件其它内容）加原子替换；新内容先写临时 文件再
  rename，避免半写状态。
- 写配置失败时给出明确错误并按远端/执行失败语义返回（不静默成功）；已成功安装的机器仍 保留
  installed/present 状态与真实路径，结果中可带配置同步失败说明。
- 同步更新 README、集群配置指南与示例 README：删除“install-deno 不修改 machines.yaml、
  安装后请手工同步”的旧说明，改为说明自动同步行为与失败语义。
- 增加单元、DV、集成与契约测试：缺省安装更新配置、present 跳过安装也更新、失败机器不
  更新、原子写失败、保留格式、多机器部分成功等。

### Out of scope

- 不改变 Deno 缺省安装目录（仍为 `$HOME/.deno/bin/deno`）、版本来源或 `--install-to` 语义。
- 不为 prepare/deploy 增加“找不到配置路径时自动搜索其它 Deno”的兜底；配置同步后不应
  再出现该路径断裂。
- 不修改 `machines.yaml` schema、cluster schema 或其它集群字段。
- 不自动回滚已安装的远端 Deno；不销毁、不覆盖用户手工配置的 non-deno 字段。
- 不新增 CLI 参数、不改变 `install-deno` 的确认门禁、JSON 结果外层结构与退出码语义。

### Boundary with neighboring modules

- 配置模块：复用现有严格装载与路径校验；新增写回函数只接受已通过远端验证的绝对 POSIX
  路径，写回后仍能被 `loadCluster` 原样装载。
- 集成模块：`runInstallDeno` 在完成全部机器处理后统一做配置同步；不做边安装边写。
- 结果模块：尽量保持现有 `MachineDenoOutcome` 字段；若需要承载配置写入失败，采用向后 兼容的
  message/errorCategory 表达，不破坏 JSON 契约。
- 示例模块：示例 README 的命令既可继续使用 `--install-to /usr/local`，也可使用缺省
  安装；两者安装后都会自动同步 `machines.yaml`。

## Requirement Review

需求合理：`install-deno` 作为运行时引导动作，天然职责是留下“可直接部署的集群状态”；
把安装结果与后续动作的回读配置分离是本次断裂的根因。自动同步比继续让用户手工改 `machines.yaml`
更符合开箱即用，也消除了文档中“请同步把 machines.yaml.deno 改成…” 的原则性缺口。

替代方案比较：

1. `install-deno` 自动同步 `machines.yaml`（推荐，本次范围）：直接消除根因，对所有集群
   生效；代价是需要安全、原子地改写用户持久配置，并变更任务 029 明确的不改写约定。
2. 只修改示例模板/README，把默认安装路径改为 `/home/ubuntu/.deno/bin/deno`：成本低，
   但只修复示例，对其它集群仍留下手工同步缺口，且用户已有集群不会自动更新；作为
   备选方案交给用户决定。
3. prepare/deploy 在配置路径缺失时按 `$HOME/.deno` 兜底：不需要写配置，但会隐式选择
   一个配置之外的二进制，掩盖配置错误、引入安全与可审计性问题，不推荐。
4. 保持现状只加强文档提示：不解决用户报告的失败，否决。

## Proposal Items

| proposal_id | change_id                    | requirement                                                                                   | boundary                                                                           | tradeoff                                                     | success_evidence                                                                                                        | non_goal                                 |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| PI-1        | CHG-install-deno-sync-config | `install-deno` 在机器验证成功后，把该机器 `machines.yaml` 的 `deno` 字段同步为实际 `denoPath` | 只改 install-deno 的结果落库与配置写回；不改变安装路径、CLI 参数、确认门禁与退出码 | 用持久配置同步换取后续动作开箱即用；原子写保证不产生半写文件 | unit/dv/integration 测试覆盖安装、present、失败、多机、写失败；改回后 `loadCluster` 能读取且后续 prepare 预检使用新路径 | 不改 schema/其它字段；不自动搜索兜底路径 |
| PI-2        | CHG-install-deno-sync-docs   | README、集群配置指南与示例 README 改为说明自动同步行为，删除手工同步旧约定                    | 只改三份说明文档与文档契约测试                                                     | 文档诚实反映新的默认行为，避免用户被旧说明误导               | 文档契约测试通过；三处示例与实现一致；全量测试通过                                                                      | 不承诺真实公网 E2E 为唯一完成条件        |

## Success Criteria

- Concrete user-visible result: 用户按报告中的两条命令顺序执行，`install-deno` 安装 成功后
  `machines.yaml[eleph-server].deno` 自动变为 `/home/ubuntu/.deno/bin/deno`， `prepare --env jre`
  不再因 `/usr/local/bin/deno` 缺失而 preflight 失败。
- Required evidence: 单元/DV/集成测试覆盖配置同步的正常与失败路径；文档契约测试通过；
  `deno task check`、lint、fmt 与全量测试通过；验收报告包含独立缺陷搜索。
- Explicit non-goals: 不改变 Deno 安装默认位置；不在本环境要求真实公网/Multipass E2E；
  不修改其它动作的预检语义。

## Risks

- 持久配置：写回用户 `machines.yaml` 若实现不当会破坏格式、注释或其它字段。缓解：
  目标化行级改写并原子替换；写回前后用现有 `loadCluster` 严格装载校验；失败不静默。
- 行为变更：任务 029 曾明确不自动改写 machines.yaml。缓解：本提案作为新要求记录并更新
  全部相关文档与契约测试；用户可选择确认或拒绝。
- 部分失败：多台机器部分成功/失败时，必须只同步成功机器，并提供可行动的失败信息。
- 回滚：machines.yaml 的改写是本地可恢复的小字段变更；远程 Deno 已在安装时复验，若用户
  拒绝新行为可把字段改回原值并重跑，不产生发布历史。
