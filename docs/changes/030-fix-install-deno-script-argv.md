# 修复 install-deno 远端命令参数不合法

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/030-fix-install-deno-script-argv/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/sfo-deploy/030-fix-install-deno-script-argv/proposal.md
- Affected paths: src/ssh_install.ts, tests/unit/ssh_install.test.ts,
  docs/changes/030-fix-install-deno-script-argv.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

`installerScript()` 原先用 `\n` 拼装多行安装脚本并作为单个 argv 传给 `/bin/sh -c`， 而传输层
`validateArgv` 有意拒绝含控制字符（换行）的参数，导致每次 install-deno 都在
本地构造命令时失败（“远端命令参数不合法”）且远端脚本从未执行。

修复方式：保持原有 `set -eu`、curl/wget 与 unzip/7z 前置检查、deno.land 安装器管道和 固定 vX.Y.Z
版本参数不变，仅把语句数组改为显式 `join("; ")` 渲染为不含控制字符的单行 POSIX shell 脚本；POSIX sh
中换行与 `;` 语句分隔语义等价。CLI/结果/退出码、`DENO_INSTALL`
环境变量、提权判定与安装后版本验证逻辑均未改动，也不放宽传输层校验。

## Risk Screen

- Public contract, protocol, or CLI change: no（JSON/退出码/帮助与参数契约不变）
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no（仅修复命令构造使其符合既有
  传输校验，远端行为语义不变；目标机仍按原契约要求 curl/wget 与 unzip/7z，缺失时 fail-closed）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

If any answer becomes `yes`, record the evidence. When it changes the confirmed requirement, scope,
or acceptance boundary, return the existing packet's `proposal.md` to draft, recommend the
appropriate tier, and obtain proposal/tier reconfirmation before further project mutation. When it
is newly discovered risk inside the unchanged confirmed scope, keep the user-selected tier and
record the residual risk instead of silently upgrading. If the user reconfirms `high-risk`, set
`Status: upgraded`, update the existing `task.yaml`, add the risk profile and downstream lifecycle
artifacts to the same packet, record that expansion above, and continue from the earliest
responsible stage.

Answer `yes` only for confirmed material consequences. A documentation/configuration change or
matching path alone is not sufficient; documentation-only and configuration-only corrections remain
lower-tier when they do not change governed intent or runtime behavior.

If an explicit current-user lower-tier override applies, record the user's instruction in
`Explicit tier override`, keep the selected tier, and describe the known risk under
`Residual risk or follow-up`.

## Verification

- Targeted check: `deno task test tests/unit/ssh_install.test.ts tests/dv/install_deno.test.ts`
  - 新增回归断言（脚本可被 `validateArgv`/`quotePosix` 接受且无控制字符、保留固定版本与
    前置检查），随后 `deno task check`、`deno task lint`、`deno task fmt`。
- Result: passed
- Residual risk or follow-up: 本任务未真实连通 multipass 目标机；真实环境下安装仍依赖目标机 具备
  curl/wget 与 unzip/7z，缺少时会得到明确中文错误而非参数校验错误。
