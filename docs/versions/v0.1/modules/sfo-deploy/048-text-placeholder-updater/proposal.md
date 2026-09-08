---
task_manifest: task.yaml
status: approved
---

# 提案：内置文本占位符配置更新器（management.configs 新增 template updater）

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务在 app.yaml schema v3 `management.configs` 中新增面向
  App 自定义文本格式的内置占位符替换
  updater，命中多条已确认的材料边界：公共契约/协议（配置装载契约、部署包 skeleton/bindings
  成员形态、远端 config_updater bundle
  协议）、安全/隐私（秘密值注入文本，必须保持失败关闭语义且秘密不进
  argv/env/stdout）、产出制品与发布面（远端 runtime bundle 需重新编译交付）。仓库先例中 managed
  配置与秘密交付类任务（037、041、046）均按 high-risk 全生命周期执行。
- Proposal and tier confirmation: 用户于 2026-09-05 确认「确定，自动完成」，批准本提案与 high-risk
  层级，并要求自动执行后续全生命周期。确认同时采纳提案中的三个推荐项：机制挂载点为
  `management.configs` 新增内置 updater `type: template`；占位符语法为仅 `${NAME}` + `$$`
  转义（不支持裸 `$NAME`）；首版仅支持值秘密（kind: value，utf8），文件秘密留待后续版本。

## Background and Goal

现状：App 自定义格式（非 yaml/json/toml/ini）的运行时配置只能走 legacy App
脚本流程——框架把模板上传到步骤工作区并投放秘密受限副本，App 作者必须在自己的 configure/deploy
脚本里重复实现 `${DB_PASSWORD}` 渲染逻辑（`docs/guides/sfo-deploy-cluster-configuration.md` 第 7
节协议示例）。内置 managed updater 只支持 yaml/json/toml/ini 结构化格式（`src/config.ts` 的
`MANAGED_CONFIG_FORMATS`、`src/remote_runtime/config_updater.ts`），无法承载 App 自定义格式。

目标：在 `management.configs` 新增内置 updater 类型 `template`（文本占位符替换）：`source` 是 App
自定义格式的文本模板，秘密以 `${NAME}` 占位符声明；部署/configure
过程中由框架固定远端载荷用真实秘密值替换占位符，经既有校验与原子发布后落到 target，App
作者不再编写渲染脚本，秘密处理收敛到框架可信面。

## Scope

### In scope

- app.yaml schema v3 装载：`management.configs[].updater.type` 新增 `template`；绑定声明不使用结构化
  `path`/`section`，改为秘密 → 占位符名的映射；一致性校验沿用现有机制（秘密须同时在 App 顶层
  `secret_values`/`secret_files` 声明，kind/类型与 `cluster.yaml.secrets` 一致，重复 selector
  拒绝）。
- 控制端骨架生成：模板按纯文本处理，把已声明占位符转换为内部保留
  marker；普通参数占位符机制（`variables[].path`）是否接入 template 由 design
  阶段决定；未声明占位符拒绝。
- 远端执行：config_updater 支持 template 文本替换（原始文本注入，不做 yaml/json/toml/ini
  标量转义），注入后校验残留 marker、UTF-8、大小上限；可选 validator、原子发布、`on_change`
  服务动作语义全部沿用。
- 测试与文档：unit/integration/contract
  用例覆盖成功与失败关闭路径；集群配置指南、README、示例同步更新。

### Out of scope / explicit non-goals

- 不做通用模板引擎：无条件、循环、include、默认值、函数转换等表达能力。
- 不替代既有机制：四种结构化 updater、`type: script` updater、legacy App
  脚本模板流程全部保留且行为不变。
- 不自动注入任何未声明占位符；每个占位符必须绑定一个已声明秘密，未知占位符失败关闭。
- 不改变 `secrets-deploy` 放置协议与 `cluster.yaml.secrets` 契约。
- 不支持二进制（非 UTF-8）配置渲染。

## Requirement Review

- 请求合理：消除每个 App 一份重复且易错的渲染样板；把秘密替换、未知占位符拒绝、残留 marker
  校验收敛到框架固定载荷，缩小出错面；占位符写法与文档既有约定形式一致。
- 主要风险/权衡：
  1. 文本注入不受结构语法约束，秘密值可能破坏 App 自有配置语法——通过可选 validator
     与注入后完整校验缓解，语义正确性仍由 App 负责（与 script updater 一致）。
  2. 占位符语法若同时支持裸 `$NAME` 形式，App 配置中合法的大写 `$WORD`（如 nginx
     变量风格）会被误判为未声明占位符；若只支持 `${NAME}` 则更严格但与文档 render
     示例的全约定不完全一致。
  3. 文件秘密（kind: file）内容为任意字节，直接文本注入可能产生非法 UTF-8。
- 选定方向：复用 `management.configs` 全链路（装载 → 骨架 → 绑定 → 远端替换 → 校验 → 原子发布 →
  on_change），只新增一种格式，不引入并行机制。
- 未决问题（已于 2026-09-05 随提案确认一并裁定，均采纳推荐项）：
  1. 机制挂载点：已裁定为 `management.configs` 新增内置 updater
     `type: template`，复用发布/校验/on_change 链路。
  2. 占位符语法：已裁定为仅 `${NAME}` + `$$` 转义；不支持裸 `$NAME`，避免大写裸变量误伤。
  3. 文件秘密：已裁定首版仅支持值秘密（kind: value，utf8）；文件秘密（kind: file）留待后续版本。

## Proposal Items

| proposal_id | change_id                       | requirement                                                                                                                                                                | boundary                                                                                                                                    | tradeoff                                             | success_evidence                                                                                                          | non_goal                           |
| ----------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| P-001       | CHG-template-updater-control    | 控制端支持 `updater.type: template`：装载校验（绑定无结构化 path、秘密声明一致性、占位符→marker 转换生成无秘密骨架）、部署包成员（skeleton + bindings JSON）按新格式生成。 | 只扩展装载与骨架生成面；既有四种结构化 updater 与 script updater 的装载结果逐字段不变。                                                     | 新增一种格式分支，换取 App 自定义格式的内置支持。    | template 装载成功/失败路径单测覆盖（未知占位符、重复 selector、秘密声明缺失/类型冲突均报错）；既有 updater 用例回归全绿。 | 不做通用模板表达式。               |
| P-002       | CHG-template-updater-remote     | 远端 config_updater 支持 template 文本替换：按 bindings 用真实秘密值替换 marker，注入后执行残留 marker/UTF-8/大小校验，可选 validator 与原子发布、on_change 语义沿用。     | 秘密不进 argv/env/stdout；失败关闭（残留 marker、非法 UTF-8、超限即失败，不发布）；更新远端 bundle 并保持 `--no-remote --no-npm` 离线执行。 | 原始文本注入比结构化标量转义更宽松，换取格式自由度。 | integration 覆盖成功替换、失败关闭、原子发布回退；contract 校验远端 bundle 与控制端一致；既有四种格式用例回归全绿。       | 不写最终 target 以外的持久路径。   |
| P-003       | CHG-template-updater-docs-tests | 文档与示例更新：集群配置指南新增 template updater 声明与占位符语法说明，README 与示例 README 同步；补齐端到端测试夹具。                                                    | 只覆盖本任务涉及的文档与测试文件。                                                                                                          | 文档面较大但契约类变更需要同步说明。                 | 文档示例与实现行为一致（装载校验文案、失败关闭语义）；`deno task check` 全绿。                                            | 不为通用模板引擎能力预留文档承诺。 |

## Success Criteria

- 可见结果：App 在 `management.configs` 声明 `type: template` 的自定义文本配置，`${DB_PASSWORD}`
  占位符在部署/configure 中由真实秘密替换后原子发布到 target；App 作者无需自写渲染脚本。
- 必要证据：`deno task check`（类型检查与全量测试）通过；新增 unit/integration/contract
  用例覆盖未知占位符、缺失/类型不匹配秘密、重复 selector、残留 marker、`$$`
  转义、发布失败回退等失败关闭路径；文档与实现一致。
- 显式非目标：同上 Out of scope 列表；不支持未声明占位符与二进制渲染。

## Risks

- 安全：文本注入位置不受语法约束，错误注入可能把秘密送入错误字段；缓解：绑定显式声明、注入后完整校验、可选
  validator、失败关闭。
- 协议：部署包与远端 bundle 变更需回归既有四种结构化 updater 与 script
  updater；缓解：既有用例全量回归 + contract 校验。
- 兼容：加法演进，不改既有行为；plan/history 快照对新格式的兼容性在 design 阶段确认并留验收证据。
- 语法约定风险：占位符语法若与既有文档 render 约定不一致，需在文档中明确区分内置 updater 与 App
  脚本两条路径的约定。
