---
task_manifest: task.yaml
status: approved
---

# cluster.yaml 增加 sfo-deploy 版本门禁（精确匹配）

Risk profile: not-created（待定 tier；若用户改选 high-risk 再补充）

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries：本次变更给 `cluster.yaml` 增加一个可选字段
  `deployer_version`（精确字符串，非 semver 区间），并让 sfo-deploy
  在执行时用它自己的运行时版本做精确匹配，不一致即 fail-closed
  停止，不产生任何远端副作用。涉及范围：`src/config.ts`（schema 字段 + `TOOL_VERSION` 常量与 JSON
  import）、`src/integration.ts`（门禁判定点）、`README.md`
  与模块/导航文档、以及对应测试。不引入数据迁移、安全边界变化、依赖图或构建链变化、跨项目集成；不改变稳定
  `--json` 结构、退出码语义或已存在集群的远端行为（字段缺省 =
  不启用门禁，向后兼容）。属于单模块、有界、可回退的功能性变更，建议
  standard。触发边界：该字段会改变带此字段的集群的部署准入行为（版本不匹配时阻止执行），需要在交付内同步测试与文档契约。
- Proposal and tier confirmation：用户回复“确认”，批准本提案与 standard
  层级并授权整个任务执行。提案中列出的两个未决问题按默认语义处理：门禁覆盖所有装载集群并继续执行的受控动作（plan/deploy/check/install/prepare/configure/start/stop/restart/validate）；`validate`/`plan`
  同样拦截报错（fail-closed），不单独放行。

## Background and Goal

用户希望控制“谁”的 sfo-deploy 可以对指定集群执行部署。目前 `cluster.yaml`（schema v2）只允许
`schema_version/name/executor_region/environments/apps/secrets` 字段，且 sfo-deploy
自身没有可用的运行时 版本号，也没有 `--version` 选项。因此带新功能的运维团队无法要求“只有指定版本的
sfo-deploy 才能部署”。

目标：在 `cluster.yaml` 声明本集群要求使用的 sfo-deploy 精确版本（例如
`deployer_version: "0.1.0"`）； sfo-deploy
在执行集群相关动作时装载该字段，并用自己的运行时版本号做精确匹配；只有完全一致才继续后续
步骤，不一致则报错停止。

已实测验证版本读取方案可行：在 Deno 2 中用 `import pkg from "../deno.json" with { type: "json" }`
可以读取 `deno.json.version`，且 `deno install --global` 从 URL
安装后（官方安装方式）依然离线可用，因为 Deno 会把 `deno.json`
作为模块图一部分缓存。`--allow-read`（README 安装命令已含）即可满足权限。

## Scope

### In scope

- `src/config.ts`：
  - 增加 `TOOL_VERSION` 常量，通过 JSON import 读取仓库根 `deno.json` 的 `version`
    字段；类型推断并导出。
  - `cluster.yaml` 解析允许新增可选字段
    `deployer_version`（非空字符串，不做 trim、不做字符集限制），缺省表示不启用门禁； 声明时将其放入
    `ClusterConfig`。
  - 校验：`deployer_version` 必须是与 `TOOL_VERSION` 精确匹配（直接字符串相等），不做 semver
    范围或前缀匹配。
- `src/integration.ts`：在集群装载后、构建执行计划/执行任何远端动作之前，若 `cluster.yaml` 声明了
  `deployer_version`，比对当前运行时版本，不一致时抛出明确错误并停止（fail-closed，不连接 SSH、不建
  release attempt）。
- 版本来源一致性：`TOOL_VERSION` 与 `deno.json.version` 同源，避免双份维护。
- 文档：`README.md`（最小配置示例、命令行/行为说明）、`docs/modules/sfo-deploy.md`（长生命周期边界）、
  `docs/guides/**`（如适用）补充字段说明与门禁行为。
- 测试：为字段解析（合法/非法/缺省）、门禁通过（一致继续）、门禁拦截（不一致停止、无远端副作用）增加单元与
  （如可行）集成覆盖，并同步受影响的既有测试。

### Out of scope

- 不做 semver 范围/最小版本/前缀匹配；版本匹配只支持精确全等。
- 不新增 `--version` CLI 选项（除非用户要求，可作为独立后续任务）。
- 不改变 `history`/`rollback`
  语义；回退仍读不可变快照，不受此门禁约束（若用户希望回退也受控，需另行确认）。
- 不引入 i18n、版本控制中心或远程版本协商。
- 不改 `deno.json`、`ClusterConfig` 之外的公开类型契约；不改变已有集群（未声明字段）的任何现有行为。

### Boundary with neighboring modules

- 本项目为单模块工作，归属 `sfo-deploy` 模块；不改动 `examples/**`、`skills/**`、Harness 规则/脚本。
- 归档时若需全量功能验证则不搞离线构建；验证以 `deno task check`/`lint`/`fmt`/`test` 为准。

## Requirement Review

- 需求合理性：合理。集群声明“只接受哪个版本的部署工具”是环境治理的常见诉求，实现成本低、向后兼容。
- 风险/取舍：
  - 精确匹配要求生产环境升级 sfo-deploy 时必须同步 bump 每个集群的
    `deployer_version`，否则该集群进入 fail-closed
    停摆。这是用户明确要求的语义（“只有一致才执行”），文档中应写清升级步骤。
  - 门禁判定的动作范围：默认方案是“凡装载集群并继续执行/规划的动作”（plan、deploy、check、install、
    prepare、configure、start/stop/restart 以及 validate）都受控；`history`/`fetch`/`install-deno`/
    `secrets-deploy` 不做受控执行，均不受影响。若希望缩小到“仅 deploy”，可在确认时说清。
  - `validate` 也做门禁并 fail-closed，保证“不一致就停止”在所有入口一致；若用户希望 `validate`
    只报告不阻断，也需确认。
- 选定方向：解释上述默认语义并请用户确认。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-cluster-deployer-version-pin | `cluster.yaml` 增加可选字段 `deployer_version` 的解析与格式校验（非空字符串，不做 trim、不做字符集限制），缺省不启用门禁，解析值放入 `ClusterConfig`。 | 只改字段解析与 `ClusterConfig` 契约，不改变已有字段语义；本地校验形式与既有 `ConfigurationError` 错误路径一致。 | 精确全等使升级 sfo-deploy 时需同步 bump 各集群字段，否则 fail-closed。 | `loadCluster` 单测覆盖合法值、非字符串/空/纯空白拒绝、带空白版本原样保留；受控 return 值正确。 | 不做 semver/前缀/最小版本匹配，不做字符集白名单。 |
| P-002 | CHG-cluster-deployer-version-pin | `TOOL_VERSION` 常量与仓库根 `deno.json.version` 同源读取（JSON import），作为唯一运行时版本源导出。 | 不在别处硬编码版本；`deno.json` 缺失 version 时回落 `<unknown>` 仍可构建。 | 发布流程需以 `deno.json` 为唯一版本源，README 安装 tag 与之一致。 | JSON import 实测本地与 `deno install --global`（URL 安装）后离线可用；`TOOL_VERSION === "0.1.0"`。 | 不新增 `--version` CLI 选项（独立后续任务）。 |
| P-003 | CHG-cluster-deployer-version-pin | 集群装载后、执行任何远端动作前，`deployer_version` 与 `TOOL_VERSION` 精确全等匹配；不一致抛 `ConfigurationError` fail-closed，不连接 SSH、不建 release。门禁覆盖所有装载集群并继续执行的受控动作。 | 覆盖 validate/plan/deploy/check/install/prepare/configure/start/stop/restart；`history`/`rollback` 不装载集群，`fetch`/`install-deno`/`secrets-deploy` 不做受控执行，均不受门禁。 | 门禁判定点需覆盖 `run()` 主路径与 `deploy` 独立分派的 `runDeploy`，否则存在绕过路径。 | 全部 `loadCluster` 站点逐一核实；deploy 不匹配测试断言 transport 零连接、release 目录不创建；`deno task test` 348 项通过。 | 不放宽 `validate`/plan 为仅报告不阻断；不改历史/回退语义。 |
| P-004 | CHG-cluster-deployer-version-pin | 文档与测试随门禁同步：README、模块文档、配置指南补充字段说明与门禁行为；为解析、放行、拦截、缺省兼容与 pass-through 增加测试。 | 只更新既有文档的字段/行为说明与新增独立测试，不改文档结构契约；不放宽既有断言。 | 文档需精确区分“不经过完整集群装载”与“装载但不受控执行”的 pass-through 描述。 | 文档表述与实现一致（独立缺陷审查核对）；门禁单测通过。 | 不实现 i18n、版本控制中心或远程版本协商。 |

## Success Criteria

- 声明 `deployer_version` 且与运行版本一致的集群：既有动作照常执行，行为不变。
- 声明 `deployer_version` 且不一致的集群：任何受控动作在 SSH 前报错停止，不创建 release
  attempt，无远端副作用，给出含期望/实际版本的明确错误信息。
- 未声明该字段的集群：行为与现状完全一致（向后兼容）。
- `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  全绿；受影响的既有测试已同步。
- 非目标：不引入 semver 范围、不新增 CLI `--version`、不改历史回退语义。

## Risks

- 升级锁死风险：生产集群 bump 工具版本前所有声明了 `deployer_version` 的集群会
  fail-closed。缓解：文档写明“升级时必须同步更新该字段”；字段缺省不启用门禁。
- 单点桶流（TOCTOU）风险：版本号来源单一（`deno.json` + JSON import），若发布流程人为改版本却忘改
  `deno.json`，门禁拿到旧版本。缓解：发布流程以 `deno.json` 为唯一版本源已足够，README 安装 tag
  与实际 `deno.json.version` 一致的约定继续成立。
- 行为差异风险：`validate`/`plan` 是否阻断属确认项，需用户明确，否则按默认（阻断）实现。
