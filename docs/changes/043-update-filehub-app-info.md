# Multipass App 信息由 filehub CLI 更新

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  `docs/versions/v0.1/modules/deployment-framework/043-update-filehub-app-info/task.yaml`
- Approved proposal:
  `docs/versions/v0.1/modules/deployment-framework/043-update-filehub-app-info/proposal.md`
- Affected paths: `examples/eleph-server-multipass/scripts/**`,
  `examples/eleph-server-multipass/deno.json`, `examples/eleph-server-multipass/README.md`,
  `tests/unit/update_filehub_app_versions.test.ts`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

示例新增独立的 Deno 2 / TypeScript 辅助脚本。脚本调用本机 `filehub` CLI 的
`versions --format json`，只消费该命令输出中的版本、发布时间和 App 元数据；认证仍由 filehub
自己的本地凭据处理。脚本不直接请求 API，也不读取或传递 token。

latest 按 `published_at` 选择。脚本校验 `jx-server` 与 `jx-web` 都存在、SHA-256 是 64
位十六进制、size 是正安全整数、filehub target 各段合法。默认 dry-run；显式传 `--write`
时先写同目录受限临时文件，再 `rename` 原子替换目标 `clusters/multipass/app_versions.yaml`。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

本任务更新部署前元数据，但不下载制品、不执行部署、不修改 sfo-deploy 公共契约或 filehub
provider。filehub 返回的哈希仍会在 `fetch/deploy` 中由框架复验。latest 语义和未锁定版本
的残余风险记录在提案与示例 README 中。

## Verification

- Targeted check:
  `deno check examples/eleph-server-multipass/scripts/update-filehub-app-versions.ts tests/unit/update_filehub_app_versions.test.ts`；
  `deno test --allow-read --allow-write tests/unit/update_filehub_app_versions.test.ts`；
  `deno lint examples/eleph-server-multipass/scripts/update-filehub-app-versions.ts tests/unit/update_filehub_app_versions.test.ts`；
  `deno fmt --check examples/eleph-server-multipass/scripts/update-filehub-app-versions.ts tests/unit/update_filehub_app_versions.test.ts examples/eleph-server-multipass/deno.json`；
  `deno task update-filehub-app-versions`
- Result: passed
- Residual risk or follow-up: filehub `latest` 是最近发布/创建版本，不一定是最高语义化版本；
  当前示例集群的 `jx-web` App 定义属于既有 `013` 任务范围。
