---
task_manifest: task.yaml
status: approved
---

# 专门的环境部署命令、环境应用更新与 App 前置就绪门禁提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Requirement revisions: 用户先后追加/澄清了以下需求，提案因此保持 draft：
  1. `prepare` 要能指定只部署某个目标；
  2. 目标不是 `apps/` 下的可部署包，而是“环境中的 app”，例如 jre、nginx 这类以 `environment.yaml`
     为单元的环境应用；
  3. 环境应用要支持更新；安装成功或更新成功后必须启动或重启对应的 app。
- Confirmed decisions（2026-09-02 用户确认“确认，自动完成”）:
  1. 配置模型确认：jre、nginx 这类环境应用就是 `environments/<名称>/environment.yaml` 单元，
     不需要在环境内再嵌套 app 子概念。
  2. 指定只部署某个环境应用的参数使用短名 `--env`（等价兼容既有 `--environment`）。
  3. 环境应用未声明 `start`/`restart` 脚本时跳过对应自动生命周期步骤并提示，不报错。
  4. 保留 App 部署前对依赖环境应用的就绪检查（未就绪阻断并提供指引）； `deploy --with-dependencies`
     的自动完整准备语义保持不变。
- Proposal and tier confirmation: 用户对本提案回复“确认，自动完成”；提案状态 approved，
  最终层级按推荐为 high-risk。
- Tier rationale / triggered boundaries: 本需求变更公开 CLI 动作契约与部署编排语义
  （环境应用更新、成功后的自动 start/restart、App 前置门禁），直接作用于发布/部署表面，
  并涉及环境更新的判定与既有 `start`/`stop`/`restart` 动作边界。命中 contract-protocol、
  runtime-integration、build-config-deployment 触发器且后果不是纯文档/纯配置，因此按 high-risk
  提案；用户确认需求细节后若选择降级为 standard，将按规则记录残余风险。
- Proposal and tier confirmation: 待用户对本提案的修订版本给出确认。

## Background and Goal

当前环境管理能力分散在 `check`/`install`/`configure`/`start`/`stop`/`restart` 多个动作里，
每次部署环境需要手动串联：先检查、按需安装、再配置，最后还要自行调用启动/重启。用户希望把
“部署一个环境应用”收成一个专门命令：例如只部署 jre、nginx 中的某一个；该环境应用要支持更新；
并且安装成功或更新成功后自动启动或重启对应 app。

本提案把每个 `environments/<名称>/environment.yaml` 定义视为一个**环境应用单元**（JRE、
nginx、mysql、redis 这类由环境承载/安装的应用）。目标：新增专门命令完成环境应用的安装、
配置、健康检查和启动/重启；环境应用按 `environment.yaml` 的 `version` 判定更新；App 部署前
对依赖环境做就绪门禁并复用该命令做定向准备。

## Scope

### In scope（待用户确认关键选项后细化）

- 新增 CLI 动作 `prepare` 用于部署/更新所选环境应用。用 `--env <名称>`（短名，可重复， 与既有
  `--environment` 等价兼容）指定某个环境应用，如 jre、nginx；也支持 `--machine` 范围
  筛选，按拓扑顺序执行。
- 单个环境应用的默认执行序列：`check` → 按需 `install`（检查未满足时安装，已满足跳过）→
  `configure`；随后自动启动或重启：
  - 首次安装/配置成功后执行该环境应用的 `start` 脚本；
  - 版本更新（version 变化导致重新安装/配置）成功后执行 `restart` 脚本；
  - 同版本且检查通过时整体跳过，不强制启动/重启。
  - 环境应用未声明 `start`/`restart` 脚本时跳过对应步骤并提示，不报错（已确认）。
- 环境应用更新：以 `environment.yaml.version` 为版本来源，持久化远端版本标记；版本变化时
  重新执行安装/配置并进行健康与生命周期处理，版本一致且健康时跳过。
- App 前置就绪门禁（已确认保留）：App（如 jx-server）的 `configure`/`deploy` 前对其 `depends_on`
  环境应用执行检查；未就绪时阻断并提示先运行环境应用准备命令； `deploy --with-dependencies`
  的自动完整准备语义不变。
- 文档、示例与测试：README、集群配置指南、示例模板/实机副本同步；补充命令、只选单个环境应用、
  更新判定、安装后 start、更新后 restart、失败阻断等的单元、计划、执行与集成测试。

### Out of scope / Non-goals（默认，除非用户明确扩展）

- 不改变环境脚本的权限模型、秘密/模板投递机制或远端脚本协议；软件包本身由环境安装脚本管理。
- 默认不把环境应用安装/配置纳入 `.sfo-deploy/releases/` 发布快照与 `rollback` 回放。
- 不做跨机器并行编排、断点/超时重试、UI 或调度器。
- 不引入新的集群配置 schema 大版本；优先复用 `environment.yaml` 现有字段
  （`version`、`scripts.start`、`scripts.restart`）。

### Boundary with neighboring modules

- CLI/集成模块：`CLI_ACTIONS`、参数解析、帮助文本与 `RunResult` 序列化新增动作； `--env`
  为指定环境应用的可重复短参并等价兼容既有 `--environment`，与 `--app` 语义分离。
- 计划/执行模块：环境应用节点复用环境节点；check 结果缓存、按需 install 与 fail-fast 语义
  沿用现有机制；start/restart 作为 prepare 成功后的自动后续步骤，需与用户显式调用 `start`/`restart`
  的既有动作区分。
- 历史/回退模块：环境应用的版本标记为新持久化产物，但默认不进 release 快照与回滚。
- 配置模块：复用 `environment.yaml` 现有字段，严格装载风格不变。

## Requirement Review

需求合理。把“环境应用”从分散原语收敛为单一部署命令，并把安装/更新与启动/重启串成确定性流程，
符合运维直觉；既有无依赖拓扑、check 缓存、按需安装和生命周期脚本原语可复用，改动集中在
CLI/集成/计划/执行器。主要风险是“环境应用”与现有 `apps/` 可部署包在命名和筛选语义上的 重叠（如 jre
是 environment 而 jx-server 是 app），需要先确认筛选表达，避免 CLI 歧义。

## Proposal Items

| proposal_id | change_id               | requirement                                                                                                                                        | boundary                                            | tradeoff                                                                 | non_goal                     | success_evidence                                                                                                     |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PI-1        | CHG-env-prepare-command | 新增专门的环境应用部署/更新命令 `prepare`，用 `--env <名称>` 只指定一个环境应用（如 jre、nginx），等价兼容 `--environment` 并支持 `--machine` 筛选 | 只作用于环境应用选择，不与 `apps/` 可部署包语义混用 | 用 `--env` 短参替代 `--environment` 长名，保留兼容别名以避免破坏既有调用 | 不选 apps、不做跨机器并行    | 帮助/文档一致；`prepare --env jre` 的计划只含该环境应用；计划与执行测试覆盖只选单个、多机多环境、失败阻断与结果 JSON |
| PI-2        | CHG-env-app-lifecycle   | 安装成功自动 `start`、更新成功自动 `restart`；同版本且健康时跳过；未声明 start/restart 时跳过并提示                                                | 只影响 prepare 成功路径的自动生命周期               | 用自动 start/restart 替代人工串联显式动作                                | 不监控服务常驻状态           | 执行测试覆盖首次安装后 start、版本变化后 restart、同版本跳过、缺脚本跳过提示                                         |
| PI-3        | CHG-env-app-update      | 环境应用按 `version` 与远端版本标记判定更新                                                                                                        | 只以 environment.yaml.version 与远端标记为判定输入  | 复用 check 退出码作为健康唯一判定，不引入额外探针语言                    | 环境不纳入 release 快照/回滚 | 版本变化触发重装/重配+restart；版本一致且检查通过时跳过；标记写入与校验有单测                                        |
| PI-4        | CHG-app-env-ready-gate  | App 部署前对依赖环境应用做就绪门禁，未就绪阻断并提供指引                                                                                           | `--with-dependencies` 自动完整准备语义保持不变      | 定向部署需要先 prepare，换取更明确的前置条件                             | 定向模式不自动安装依赖       | 执行测试覆盖未就绪阻断、就绪放行；指引可复现                                                                         |
| PI-5        | CHG-docs-tests          | 文档与测试同步新命令、生命周期与更新语义                                                                                                           | 覆盖 README/指南/示例模板与实机副本                 | 同步 live 副本换取示例可执行                                             | 不改既有配置 schema 大版本   | README/指南/示例 README 同步；全量 `deno task check`、lint、fmt、test 通过                                           |

## Success Criteria

1. `sfo-deploy prepare --env jre` 可运行且计划只含 jre，其余环境应用不进入计划。
2. 环境应用安装成功后自动执行 `start`；更新成功后自动执行 `restart`；同版本且检查通过时跳过。
3. 环境应用健康检查结果按每台机器/每实例输出，退出码与 JSON 结果稳定。
4. App 部署前对依赖环境应用的就绪门禁生效，未就绪阻断并给出可执行指引。
5. 全部相关测试、文档一致性检查与 Harness 流程检查通过，示例模板与实机副本逐字节同步。

## Risks

- 公开 CLI 契约变化：新增动作与执行类别（环境应用 vs 可部署 App）的筛选表达需要无歧义，否则 会与既有
  `--app`、`--environment` 混淆。
- 自动 start/restart 的副作用：若安装/更新成功但启动失败，需要定义失败语义（整体失败并保留
  版本标记状态），避免半成功状态导致下次部署误跳过。
- 部署表面变化：更新判定与远端版本标记涉及真实远端行为；将以严格测试与 fail-closed 为主。
- 兼容性：现有 `deploy --with-dependencies`、定向 `--app` 与显式 `start`/`restart` 动作的语义
  需要保持可预期；历史快照回放语义不得被破坏。
