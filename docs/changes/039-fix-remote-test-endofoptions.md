# 修复远端 test 的选项结束符兼容性

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  docs/versions/v0.1/modules/deployment-framework/039-fix-remote-test-endofoptions/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/deployment-framework/039-fix-remote-test-endofoptions/proposal.md
- Affected paths: src/transport.ts, tests/unit/transport_cli.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

移除传给远端 `/usr/bin/test` 的 `--` 选项结束符。GNU `test` 在 Ubuntu 24.04
上不把它解释为分隔符，会将其误当作二元操作数，导致密钥目录、清单和文件存在性检查失败。其他远端工具继续按各自
CLI 约定使用 `--`；路径仍先经过既有远端安全路径校验。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: yes
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

运行时影响限于 SSH 远端存在性检查的 argv 兼容性。单元测试覆盖 `checkSecrets`、`removeSecret` 和
`exposeStepSecrets` 的 `/usr/bin/test` 调用，防止继续传递 `--`。

## Verification

- Targeted check: 运行 `deno task check` 和 `deno task test`；用伪造 SSH 会话断言 `/usr/bin/test`
  argv 不含 `--`；修复后在 Multipass 上执行只读 `secrets-deploy --check --json`，确认不再出现
  `binary operator expected`，并正确报告 3 个密钥缺失。
- Result: pass
- Residual risk or follow-up: none
