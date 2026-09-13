---
task_manifest: task.yaml
status: approved
---

# sfo-deploy 代码输出文案英文化

Risk profile: not-created（standard 层级不创建；若用户改选 high-risk 再补充）

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries：本次变更把运行时用户可见文本（CLI 帮助、进度行、确认提示、结果汇总、错误消息、步骤 label）从中文改为英文，并把 examples 脚本的控制台输出一并英文化；同时同步断言这些文本的测试与 README/契约测试中的输出语言标记。变更不触及稳定 `--json` 结构与键名、配置 schema、安全边界、远端执行语义、持久数据或依赖图，属于单模块、可回退的机械性文本重构，因此建议 standard。触发边界是本地化表面：人可读输出语言变化会影响依赖精确文本的测试断言与文档契约标记，需要在同一次交付内同步。
- Proposal and tier confirmation：用户已回复“确认”，批准本提案和 standard 层级并授权整个任务执行；提案中无未解决问题。

## Background and Goal

用户要求把代码中输出的文案全部改成英文。当前框架的人可读输出层几乎全部是中文：`src/**` 中约 1348 处字符串字面量（CLI 帮助文本、分步进度行、`yes` 确认提示、结果汇总、`DeploymentError` 系列错误消息、步骤 label/描述）、`examples/eleph-server-multipass/scripts/*.ts` 两个脚本的 `console` 输出与错误文案，以及 30 余个断言这些精确文本的测试文件。

目标是让所有运行时对外输出的文案（即用户或脚本消费到的文本）统一为英文，同时保持机器契约、行为语义与脱敏边界完全不变，避免出现中文输出与英文输出混杂的过渡状态。

## Scope

### In scope

- `src/**`（含 `src/remote_runtime/*` 与 `src/secret_loader/*`）中所有运行时会输出或抛出的字符串字面量：CLI 帮助、进度事件行、确认提示、汇总、错误消息、步骤 `label`/`message`/`skipReason`。按交付物要求重新编译 `src/remote_runtime/config_updater.bundle.js`。
- `examples/eleph-server-multipass/scripts/generate-cluster-secrets.ts` 与 `update-filehub-app-versions.ts` 的用法说明、`console.log` 输出与错误文案。
- 与上述文案绑定的测试断言更新：`tests/unit/**`、`tests/integration/**`、`tests/contract/**`、`tests/dv/**`、`tests/_support/**` 中期望中文输出的断言与固定文本。
- `tests/contract/verify_cli_output_docs.ts` 的输出契约标记，以及 `README.md` 中描述人可读输出语言/格式的段落（README.md:504、README.md:510 附近）同步为英文输出契约。

### Out of scope

- 源码注释与 JSDoc 语言保持现状（仍为中文）；`Deno.test(...)` 测试名与测试文件注释保持现状。若用户希望连注释、测试名一并英文化，可在确认时说明并调整范围。
- Harness 规则、Harness 脚本、任务文档（`docs/versions/**`、`docs/changes/**`、`completion-report.md` 等）按 `harness/custom-rules/task-docs-chinese.md` 继续使用中文。
- `docs/guides/**`、`docs/architecture/**`、`README.md` 其余中文正文不整体翻译；只更新与输出语言契约直接相关的句段。
- 不改变 `--json` 的结构、键名、枚举取值、退出码、步骤顺序、进度事件语义、秘密脱敏行为与任何远端执行逻辑。
- 不引入 i18n 框架、语言切换开关或双语文案表；本次交付固定为英文输出。

### Boundary with neighboring modules

- `deployment-framework` 示例模块只接收 `examples/**` 脚本输出文案的英文化，不改变示例集群的配置、脚本语义或部署行为。
- `skills/sfo-deploy-cluster/**` 是给 Agent 的配置技能文档，描述的是配置文件而非命令输出，保持中文，不在本次范围。
- `harness/**` 与任务流程文档不是产品输出层，保持现状。

## Requirement Review

请求合理且边界清楚：输出语言属于产品表面文本，改动集中在字符串字面量与断言，不改变任何行为分支。需要一并处理两类耦合面，否则交付不完整：

1. 测试断言：大量单元/集成/契约测试按精确文本断言中文输出，只改 `src/**` 会让测试套件失败，必须同步更新期望值（不得通过放宽断言掩盖文案回归）。
2. 输出契约与文档：`tests/contract/verify_cli_output_docs.ts` 与 README 明确声明“按步骤输出中文人可读的进度行”，CLI 帮助文本也包含中文说明，必须与实现同步改为英文标记。

主要权衡：

- 中文输出是当前人可读层的事实契约，翻译后会改变依赖 `message`/`stderr` 精确文本的下游消费方式；缓解方式是保持 `--json` 结构与键名不变，并在完成报告中明确“值级文本变化、结构级兼容”。
- 远端 `config_updater.bundle.js` 是仓库内提交的构建产物，必须用 `deno task bundle:remote-runtime` 重新生成并验证可离线执行，否则远端配置更新行为会保留中文输出。

选择方向：全量替换运行时输出文案为英文，同步更新测试与文档契约标记，不保留中英混合输出。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-english-runtime-output | `src/**` 全部运行时输出文案改为英文，覆盖 CLI 帮助/进度/提示/汇总/错误/步骤 label。 | 只改字符串字面量文本，不改控制流、退出码、步骤顺序与脱敏逻辑。 | 下游按精确文本匹配人可读输出或错误 `message` 的消费方式会变化。 | `rg '[\p{Han}]' src` 只命中注释；`deno task check`/`lint`/`fmt` 通过；CLI 帮助、进度行、错误与提示均为英文。 | 不引入 i18n 或语言开关，不改变 `--json` 结构与键名。 |
| P-002 | CHG-english-runtime-output | 重新生成 `src/remote_runtime/config_updater.bundle.js`，使远端运行时输出同步为英文。 | 使用仓库既有 `deno task bundle:remote-runtime` 流程，不新增依赖。 | 提交产物体积/`deno.lock` 不变，但必须复核生成确定性与离线执行。 | bundle 重新生成并字节复核一致；`tests/integration/config_updater.test.ts` 通过。 | 不改变 bundle 的协议、参数与写入语义。 |
| P-003 | CHG-english-runtime-output | 同步更新依赖中文输出的测试断言与 README/契约测试中的输出语言标记。 | 只更新期望值与文档契约标记，不放宽断言、不删除断言覆盖。 | 测试文件改动面较大，但可保持逐条文本可追溯。 | `deno task test` 全量通过；`tests/contract/verify_cli_output_docs.ts` 以英文标记校验通过。 | 不修改机器可解析 JSON 契约的结构断言。 |
| P-004 | CHG-english-example-scripts | `examples/eleph-server-multipass/scripts/*.ts` 的用法说明、`console` 输出与错误文案改为英文。 | 只改文本，不改变脚本参数、dry-run/`--write` 语义与密钥安全行为。 | 示例脚本输出语言与 README 中文正文分离，README 相关行按需同步。 | 两个脚本对应的单元测试通过；脚本 `--help` 输出为英文。 | 不翻译示例集群配置与 README 正文。 |

## Success Criteria

- 用户可见结果：CLI 的帮助文本、进度行、确认提示、结果汇总与错误消息，以及两个 examples 脚本的控制台输出与错误文案全部为英文，不再出现中文输出文案。
- 必需证据：
  - `deno task check`、`deno task lint`、`deno task fmt` 通过。
  - `deno task test` 全量测试通过（含 `tests/contract/verify_cli_output_docs.ts` 的英文输出契约标记）。
  - `rg -n '[\p{Han}]' src examples/eleph-server-multipass/scripts` 只剩注释行（无输出字面量）。
  - `deno task bundle:remote-runtime` 重新生成 bundle 后复核一致，远端更新器测试通过。
  - `--json` 输出结构与键名不变：既有 JSON 契约测试在不改结构断言的前提下通过。
- 明确非目标：不翻译源码注释、测试名、Harness/任务文档与示例文档正文；不提供多语言切换。

## Risks

- 文本量大（`src/**` 约 1348 处字符串字面量），存在翻译遗漏或中英混杂风险；缓解方式是按文件清单逐项核验，并用 `rg '[\p{Han}]'` 残留扫描 + 全量测试 + fmt/lint 收敛。
- 测试与实现必须同步：先改实现会让测试大面积失败，先改测试会得到虚假失败；按“实现→测试期望→全量运行”顺序推进，并保留失败输出作为过程证据。
- 精确文本变化会影响外部消费方（例如脚本 grep 错误消息）。`--json` 结构与键名保持稳定，值级文本变化记入完成报告，不作为回滚理由。
- bundle 属于提交产物，若生成环境与仓库锁定依赖不一致可能产生字节漂移；复核生成前后差异与 `deno.lock` 不变，必要时在完成报告中记录哈希。
