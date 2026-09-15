---
task_manifest: task.yaml
status: approved
---

# deploy 支持只上传并部署、跳过 latest 切换与重启（--no-activate）

Risk profile: not-created（待定 tier；若用户改选 high-risk 再补充）

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries：本次变更为 `deploy` 动作新增可选的 `--no-activate`
  命令行选项，把内置 versioned App 的部署阶段（configure/stage：上传并发布新版本目录）与
  激活阶段（activate：切换 `latest`、写 `<app>.version` 标记、启动/重启服务）解耦。
  缺省行为完全不变（不传该选项时仍完整执行 stage+activate+restart 并重启服务）；新增选项只会
  让计划只包含 configure/stage，不切换 `latest`、不写激活标记、不重启服务。属于单模块、有界、
  向后兼容的功能性变更，不引入数据迁移、安全边界变化、依赖图或构建链变化、跨项目集成，建议
  standard。触发边界：本选项会改变传入它的部署动作的目标机状态机（新版本只落地不激活），
  需要在交付内同步 CLI 帮助文本、README/模块文档与对应测试。风险较低：行为是新增可选入口，
  默认与既有契约不变；叠加在现有 stage/activate 计划与恢复语义之上，不新增远端原语。
- Proposal and tier confirmation：用户回复"确认"，批准本提案与 standard 层级并授权整个任务执行。
  提案中列出的两个未决问题按默认语义处理：未激活部署的 release 记为 succeeded 且回退只重放
  stage（不切换）；不新增"只激活已落地版本"的命令（作为独立后续任务）。

## Background and Goal

当前 `sfo-deploy deploy --cluster <cluster> --app <app>` 对内置 versioned App 会一次性完成
"上传+发布新版本目录（stage）→ 切换 `latest` 并启动/重启服务（activate）" 两个阶段
（`src/planning.ts` 中 deploy 的 actionSequence 为 `[configure?, stage, activate, restart?]`）。
运维希望在某些场景（如先落版本、人工或后续零点再切换与重启；或上线前的灰度验证）时，只
"上传并部署新版本"，而不做最后的切换 `latest` 与重启服务的操作。

目标：为 `deploy`（以及 `plan` 预览）新增一个命令行选项控制是否执行激活阶段。不传该选项时
行为与现状完全一致；传入后计划只保留 configure/stage（若 App 声明配置脚本则含 configure）， 不再生成
activate/restart 步骤，目标机只本地落地新版本目录，不改变 `latest`、`.app.version`
标记或服务运行状态。

## Scope

### In scope

- `src/planning.ts`：`buildPlan` 的 `PlanRequest` 新增可选布尔 `activate`（缺省 `true`）； 当
  `action === "deploy"` 且 `activate === false` 时，内置 versioned App 的 deploy actionSequence 变为
  `[configure?, stage]`（同时移除尾部 script-manager 的 `restart`）。 非
  versioned/其他动作不受影响。
- `src/types.ts`：`PlanRequest` 增加 `activate?: boolean` 字段说明。
- `src/integration.ts`：`RunOptionsInit`/`RunOptions` 增加 `activate`（缺省 `true`）， 传参到
  `buildRequestedPlan`；校验布尔类型，非法值抛 `ConfigurationError`。
- `src/cli.ts`：解析新选项 `--no-activate`，透传到 `RunOptions`；更新 `deploy` 动作帮助文本、
  全局选项列表与部署确认提示（明确"本次不切换 latest、不重启"）。
- 文档：`README.md` 的 deploy 命令说明与 `docs/modules/sfo-deploy.md` 版本化发布边界补充
  `--no-activate` 语义。
- 测试：计划级（stage-only 计划、各管理器类型、packageless/非 versioned 不受影响、缺省仍含
  activate）、CLI 解析（`--no-activate` 生效/非法合并/帮助文本/确认提示）、集成验证 （执行
  stage-only 计划后不 switch/不重启、`latest` 与版本标记不变、版本目录已落地）。

### Out of scope

- 不新增独立子命令（如新 action `stage-only`），不改动作集合与 `--json` 稳定键结构。
- 不改变 `prepare`/`rollback`/`history` 语义；`--no-activate` 只作用于 `deploy`（及预览它的
  `plan`）。
- 不改远端运行时脚本（`src/remote_runtime/versioned_release.ts`）或远端传输原语。
- 不实现"分批切换/latest 脏读一致性"等新机制；只做"跳过激活阶段"的最小能力。

### Boundary with neighboring modules

- 单模块工作，归属 `sfo-deploy`；不改动 `harness/**`、`examples/**`、`skills/**`。
- release history 仍按 deploy 记录：stage-only 部署成功后 release 记录 `succeeded`，其回退计划
  仅重放 configure/stage（不切换）；这是"未激活部署"文档化的边界，作为残余风险记录。

## Requirement Review

- 需求合理性：合理。"先落版本、后切换/重启"是版本发布常见的解耦诉求，实现改动小、向后兼容。
- 风险/取舍：
  - 命名与语义：选项取名 `--no-activate`，语义为"跳过激活阶段（切换 latest 与重启服务）"，
    而不是"跳过整个部署"。缺省保持激活，保证既有自动化不变。
  - 未激活部署的 release/回退：stage-only 部署也会写 release attempt 并标 succeeded（它确实
    把新版本落地到了节点），但回退不会切换回旧版本（因为从未切换）。文档需写清该边界。
  - `plan` 预览同样支持该选项，保证"先预览再执行"的一致行为。
- 选定方向：新增 `--no-activate` 布尔选项，部署只在传入时跳过激活阶段。

## Proposal Items

| proposal_id | change_id              | requirement                                                                                                                                                                                    | boundary                                                                                  | tradeoff                                              | success_evidence                                                                                                          | non_goal                          |
| ----------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| P-001       | CHG-deploy-no-activate | `PlanRequest` 新增可选 `activate?: boolean`（缺省 true），`buildPlan` 在 `action="deploy"` 且 `activate=false` 时对内置 versioned App 只生成 configure/stage 步骤，不再生成 activate/restart。 | 仅影响 deploy actionSequence；环境动作、非 versioned App、packageless App、其他动作不变。 | 缺省全长链保持既有行为；传参新入口才有差异化。        | 计划级测试覆盖 script/service/packageless 三型：缺省含 activate，`activate:false` 只含 configure/stage，depends_on 正确。 | 不新增 action、不改 `--json` 键。 |
| P-002       | CHG-deploy-no-activate | `RunOptions`/`RunOptionsInit` 增加 `activate`（缺省 true，布尔校验），并透传 `buildRequestedPlan`。                                                                                            | 只作用于 deploy/plan；其他动作不接受或忽略该字段。                                        | 非法布尔透传抛配置错误。                              | 单元测试覆盖缺省 true、显式 false、非布尔拒绝。                                                                           | 不引入其他选项。                  |
| P-003       | CHG-deploy-no-activate | `createCli` 解析 `--no-activate`（拒绝内联值），透传到 RunOptions；deploy 帮助文本、确认提示与全局选项说明同步更新。                                                                           | 选项只在 `deploy`（及 `plan`）上有效，其他动作收到后不影响（帮助文本只在对应动作显示）。  | 帮助文本与确认提示需如实说明"不切换 latest、不重启"。 | CLI 解析测试：帮助出现该选项、`--no-activate=值` 拒绝、确认提示文案包含跳过语义。                                         | 不改动作集合。                    |
| P-004       | CHG-deploy-no-activate | 文档与集成验证：README/模块文档补充该选项语义；集成测试验证 stage-only 执行后新版本目录落地、`latest` 与 `.app.version` 不变、无 switch/restart 事件。                                         | 只更新既有文档的字段/行为说明与新增独立测试，不放宽既有断言。                             | 记录"未激活部署的 rollback 只重放 stage"边界。        | 集成断言事件序列无 switch/systemctl 动作；`deno task check/lint/fmt/test` 全绿。                                          | 不改远端运行时脚本。              |

## Success Criteria

- 缺省 `deploy`（无 `--no-activate`）：计划与执行行为与当前完全一致（stage→activate→restart）。
- `deploy --no-activate`：计划只含 configure/stage，执行后新版本目录落在
  `<install_directory>/<version>/`，`latest` 符号链接、`.app.version` 标记、服务状态均不变。
- `plan --no-activate` 与 `deploy --no-activate` 的步骤视图一致（预览即执行的真实计划）。
- `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  全绿；受影响的既有测试同步。
- 非目标：不改远端运行时、不改动作集合、不改 `--json` 键结构、不改 prepare/rollback 语义。

## Risks

- 未激活部署的语义边界：stage-only 释放的 release 记录为成功且回退只重放 stage，不会切换回
  旧版本。缓解：文档化该行为；不激活即"未上线"，回退期望应遵循该边界。
- 误勾选风险：用户在非预期场景使用 `--no-activate` 导致版本落地但未上线。缓解：确认提示与 JSON
  结果均如实反映"跳过激活"；选项只对 deploy/plan 可见。
- 未来激活方式：当前没有配套的"只激活已落地版本"的命令；如需可作独立后续任务，本次不做。
