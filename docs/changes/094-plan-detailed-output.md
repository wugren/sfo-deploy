# sfo-deploy plan 人可读输出补充更详细的步骤信息

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/094-plan-detailed-output/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/094-plan-detailed-output/proposal.md
- Affected paths: src/cli.ts, tests/unit/cli_plan_output.test.ts, README.md, docs/modules/sfo-deploy.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

在 `src/cli.ts` 的 `writeHumanResult` 的 `ExecutionPlan` 分支（当前只有摘要行 + 每步一行简写）
就地扩展为多行详细渲染：保留摘要行头，对每个步骤输出序号/总数、机器名与解析后的
address/address_kind，并在字段 Present 时输出 depends_on、package_provider、deployment kind、
脚本 relativePath 与 script_runtime、secret_values/secret_files 逻辑名称，以及 management 的
service unit + on_deploy 与受管 config 的 target + format。

关键约束：
- 密钥只输出逻辑名称（`step.secretValues`/`step.secretFiles`），绝不触碰值或文件内容。
- 脚本只输出 `ScriptInvocation.relativePath`，不输出 `source`（执行器本地绝对路径）。
- 可选字段缺失时不输出占用行；渲染函数只消费计划对象已装载字段，不新增解析/装载。
- `--json` 序列化、deploy 确认提示、执行期进度行均保持不变。

新增独立测试 `tests/unit/cli_plan_output.test.ts`，覆盖完整字段渲染、缺省字段省略与 `--json`
契约不变；同步 README 与模块文档的 CLI 输出说明。

## Risk Screen

- Public contract, protocol, or CLI change: no（人可读文本非机器契约；`--json` 键结构不变）
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no（只输出密钥逻辑名，不打印值的处理沿用既有契约）
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: yes（plan 人可读展示输出变更，见 Verification）
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

## Verification

- Targeted check: `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
- Result: pass
- Residual risk or follow-up: 人可读 plan 文本是非机器契约；机器解析建议继续使用稳定 `--json`。脚本
  `source` 绝对路径与密钥值均不进入输出。