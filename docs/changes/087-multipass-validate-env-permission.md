# 消除 Multipass prepare validate 的 Deno 环境确认

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/087-multipass-validate-env-permission/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/087-multipass-validate-env-permission/proposal.md
- Affected paths:
  - examples/eleph-server-multipass/prepare-multipass.sh
  - examples/eleph-server-multipass/prepare-multipass.ps1
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- 为 prepare 内联 `validate` 的 Deno 进程只添加 `HOME` 和 `USERPROFILE` 环境读取权限。
- 两条脚本保持 validate 参数、退出码处理和其余权限不变；不使用全量 `--allow-env`。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

权限仅扩展到 CLI 初始化定位用户主目录所需的两个变量，仍远小于全量环境访问。

## Verification

- Targeted check: `bash -n examples/eleph-server-multipass/prepare-multipass.sh`；`pwsh` 全文件语法解析 `.ps1`；`rg` 核对两条内联 validate 调用均为 `--allow-env=HOME,USERPROFILE`；以 `DENO_NO_PROMPT=1` 和最小权限前缀执行 CLI probe，预期配置失败为非零退出且无 Deno 权限提示；`git diff --check` 通过。
- Result: passed
- Residual risk or follow-up: 未执行真实 Multipass prepare 全流程；真实 VM 创建和 hosts 写入仍需在目标宿主验证。
