# Multipass 示例默认使用 Ubuntu 26.04

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/086-multipass-ubuntu-26-04/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/086-multipass-ubuntu-26-04/proposal.md
- Affected paths:
  - examples/eleph-server-multipass/prepare-multipass.sh
  - examples/eleph-server-multipass/prepare-multipass.ps1
  - examples/eleph-server-multipass/README.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- 将 Bash 与 PowerShell 版 prepare 脚本的默认 Ubuntu 镜像同步为 `26.04`。
- 保留 `--ubuntu-image` 与 `-UbuntuImage` 的显式覆盖能力，只更新默认值和 README 描述。
- 核对 hosts 更新路径保持无脚本级二次确认；如仍需要提权，`sudo` 的密码/权限提示属于
  系统认证，不在本任务中绕过或移除。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

26.04 镜像是否可下载取决于本地 Multipass 版本和镜像源；用户仍可通过显式镜像参数回退。

## Verification

- Targeted check: `bash -n examples/eleph-server-multipass/prepare-multipass.sh`；`./prepare-multipass.sh --help` 确认默认显示 `26.04`；`pwsh` 全文件语法解析 `.ps1`；`rg` 核对 `.sh`、`.ps1` 与 README 的默认镜像残留和一致性；检查 hosts 更新路径无 `read -r`、`read -p` 或 `Read-Host` 脚本级确认。
- Result: passed
- Residual risk or follow-up: 未执行真实 Multipass 下载/启动 26.04 镜像或真实 hosts 权限提升；镜像不可用时可通过 `--ubuntu-image` 或 `-UbuntuImage` 显式回退，sudo 密码提示仍由系统认证决定。
