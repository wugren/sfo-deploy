# 修复 versioned 配置父目录检查的 GNU test 参数兼容性

- Status: complete
- Owner module: sfo-deploy
- Task manifest:
  docs/versions/v0.1/modules/sfo-deploy/078-fix-versioned-config-test-endofoptions/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/sfo-deploy/078-fix-versioned-config-test-endofoptions/proposal.md
- Affected paths: src/transport.ts, tests/integration/versioned_transport_boundary.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

移除 `publishManagedConfigs` 与 `#ensureReleaseParent` 传给远端 `/usr/bin/test` 的全部 4 处
`--` 选项结束符。Ubuntu 24.04 的 GNU `test` 不支持 `--`：`/usr/bin/test -d -- <path>` 会把它
当作二元操作数并以退出码 2 报 `binary operator expected`，使部署器只在退出码 1 才进入的
“缺失父目录则创建”分支永远不可达。路径在调用前已经 `safeRemotePath` 校验为绝对规范路径，
操作数不会以 `-` 开头，因此不需要该分隔符。

集成回归按真实 GNU 行为建模：任何含 `--` 的 `/usr/bin/test` 调用返回退出码 2，并断言修复后
不再向 `/usr/bin/test` 传递 `--`，同时缺失父目录仍按 077 契约逐级创建后继续发布。

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

运行时影响限于远端存在性/类型探测的 argv 兼容性：不改变 `releaseRoot` 校验、真实路径边界、
符号链接拒绝、目录创建策略、配置发布事务或回滚语义。`realpath`、`stat`、`install`、`mv`
等 GNU 工具支持 `--`，保持原样。

## Verification

- Targeted check: `deno task check`；`deno fmt --check src/transport.ts
  tests/integration/versioned_transport_boundary.test.ts`；`deno lint src/transport.ts
  tests/integration/versioned_transport_boundary.test.ts`；`deno test --allow-read --allow-write
  --allow-env --allow-net --allow-run tests/integration/versioned_transport_boundary.test.ts`；
  `deno task test`。回归按真实 GNU 行为建模（含 `--` 的 `/usr/bin/test` 返回退出码 2）：临时恢复
  `--` 时新增用例失败于 `TransportError: 配置目标父目录不存在 ...: exit=2`，修复后 11 个集成用例
  与全量 303 个测试通过。真实验证：在 multipass `eleph-server` 上重新执行
  `deploy --cluster multipass --config-root ./examples/eleph-server-multipass/clusters --yes`，
  原 `binary operator expected` 错误不再出现，`jx-server:stage` 推进到后续 systemd 准备
  （发布 ID `r20260910T070645704430Z-0b7f3565e5b9ac21`）。
- Result: pass
- Residual risk or follow-up: 真实复验暴露独立缺陷：`serviceCommand` 给
  `systemctl daemon-reload` 追加 `--` 与 unit 参数，Ubuntu 24.04 返回 `Too many arguments.` 且退出码 1，
  使 `jx-server:stage` 在 systemd 准备阶段失败。该问题超出本任务提案范围（proposal.md 非目标），
  已记录在 completion-report.md F-001，需另行确认任务修复。仓库级 `deno task fmt`/`deno task lint`
  在未改动的既有脏文件上失败（1 处格式、6 处 lint，均为先前任务遗留），本任务改动文件通过窄域检查。
