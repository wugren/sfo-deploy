# 允许 filehub target 的 server 段携带端口

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/059-allow-filehub-server-port/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/059-allow-filehub-server-port/proposal.md
- Affected paths: src/downloads.ts, tests/unit/downloads_secrets.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

把 filehub target 的第一段视为 server 标识，允许 `host` 或 `host:port`；端口必须是 1-65535 的
十进制数字。其余三段继续沿用现有 `FILEHUB_PART_RE` 规则，且 target 仍必须正好四段。这样兼容示例
生成器已经产出的 `filehub.mynode.site:8443/...`，同时不把发布快照中的 target 放宽为任意 URL。

## Risk Screen

- Public contract, protocol, or CLI change: yes
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: yes
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: yes
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

`host:port` target 以前被发布快照拒绝，现在会被接受，这是用户确认的行为修复。快照仍会在 SSH 前
关闭失败，不接受 query、fragment、凭据或其他 authority 语法；因此兼容性影响限定在明确要求的第一段
端口。回退快照继续记录同版本 source，不需要迁移或旧记录转换。

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/downloads_secrets.test.ts`
- Result: pass
- Residual risk or follow-up: 不支持 IPv6 地址段；如果后续需要，应作为独立的显式契约扩展提案。
