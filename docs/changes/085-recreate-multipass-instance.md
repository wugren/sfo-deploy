# multipass prepare 先删后建并维护宿主机 hosts 记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/085-recreate-multipass-instance/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/085-recreate-multipass-instance/proposal.md
- Affected paths: examples/eleph-server-multipass/prepare-multipass.sh,
  examples/eleph-server-multipass/prepare-multipass.ps1, examples/eleph-server-multipass/README.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

两个 prep 脚本（bash 与 PowerShell）建立统一新语义：存在同名 Multipass 实例时先用
`multipass delete --purge "<instance>"` 删除再走全新 launch 路径；创建并读取到新 IPv4 后，
把 `test.eleph-label.com` 指向新 IP 写入/更新宿主机 hosts 文件（`.sh`→`/etc/hosts`，
`.ps1`→`C:\Windows\System32\drivers\etc\hosts`）。原“复用并复核既有实例身份/SSH 信任/host
key”分支为死路径被移除；staging 构建、密钥生成、`validate`、原子发布与故障清理保留。
`.sh` 在 hosts 直写权限不足且 `sudo` 可用时用 `sudo` 提升，否则明确失败；`.ps1` 以当前权限
直接写，失败提示以管理员运行。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
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

- Targeted check: `bash -n prepare-multipass.sh`；伪造 multipass/ssh-keyscan/deno/hosts 桩在
  临时目录端到端执行脚本，验证先删后建（存在时 delete --purge 先于 launch、不存在时直接
  launch、删除失败 fail-closed、hosts 写回失败 fail-closed）与 hosts 新建/更新/保留无关记录；
  `deno task check`（示例 CLI 静态检查）；`pwsh` 对 prepare-multipass.ps1 做语法解析。
- Result: passed
- Residual risk or follow-up: 真实 Multipass 删除/创建与真实 hosts 权限交互不在此任务内验证；
  `.ps1` 的 hosts 写回以静态解析与人工核对为准（未在真实 Windows 宿主执行）。