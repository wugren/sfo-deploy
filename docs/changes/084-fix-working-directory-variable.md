# working_directory 支持目录变量赋值

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/084-fix-working-directory-variable/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/084-fix-working-directory-variable/proposal.md
- Affected paths: src/config.ts, tests/unit/app_management_config.test.ts, tests/integration/versioned_release.test.ts, docs/guides/sfo-deploy-cluster-configuration.md, skills/sfo-deploy-cluster/references/app.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

`unit_config.working_directory` 增加与 config `target` 一致的三个目录变量装载解析：
`${INSTALL_DIRECTORY}`、`${CURRENT_VERSION_DIRECTORY}`、`${LATEST_DIRECTORY}`，支持裸值
（整个值就是变量）与“变量前缀 + 规范相对路径后缀”两种写法，在 `src/config.ts` 装载期
解析为对应绝对目录并保持 unit 渲染器不变。`LATEST_DIRECTORY` 与 `CURRENT_VERSION_DIRECTORY`
在装载期都解析为 `<install_directory>/latest`（与 082 的 current/latest 装载语义一致），
`INSTALL_DIRECTORY` 解析为安装根。解析复用到 `managedTargetPath` 的规范绝对路径校验，
约束与 `managedConfigTarget` 对齐：变量必须在开头且只出现一次，后缀不得含 `..`/`.`/空段、
不得以 `/` 或 `//` 开头；使用变量时 App 必须已声明 `install_directory`。无变量的
`latest`/相对/绝对写法仍走原有 `remoteDirectoryPath`，行为不变。

multipass 集群 gitignored 本地文件
`examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml` 已写
`working_directory: ${LATEST_DIRECTORY}`，因此无需改动即可解析为 `/opt/eleph-server/latest`
并通过 preflight。为防止同类问题复发，非变量写法中的 `$`/`%`/`"` 与变量后缀中的
`$`/`%`/`"` 也在装载期明确失败（如未识别变量 `${FOO}` 或 `${LATEST_DIRECTORY}/x${MORE}`），
不会像修复前那样静默进入计划后到 unit 渲染才报 preflight。

## Risk Screen

- Public contract, protocol, or CLI change: yes — `working_directory` 字段增加目录变量契约（增量能力，与 config `target` 对齐；旧写法不受影响）。
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: yes — 变量仅限三个受控目录变量，不做任意 shell 展开；解析结果仍经 `managedTargetPath` 规范绝对路径校验，未放开 `src/systemd_unit.ts` 对 `$`/`%`/`"` 的安全拒绝。
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

契约增量在确认前的提案范围内（P-001/P-002/P-003），不改变已确认的需求、范围或验收边界。

## Verification

- Targeted check: `deno task check`；`deno fmt --check` 窄域文件；`deno lint` 窄域文件（仅既有遗留问题）；`deno test --allow-read --allow-write --allow-env --allow-net --allow-run`（全量 325 通过，覆盖 tests/unit/app_management_config.test.ts、tests/integration/versioned_release.test.ts）；复跑集群装载脚本 `/tmp/opencode/repro.ts`（见完成报告）。
- Result: pass
- Residual risk or follow-up: gitignored 本地集群文件不在变更清单中，已在 completion-report.md 记录验证结果；远端执行由用户继续。