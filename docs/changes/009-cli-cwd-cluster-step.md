# 通用 CLI 从当前目录发现集群

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/009-cli-cwd-cluster-step/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/009-cli-cwd-cluster-step/proposal.md
- Affected paths: src/sfo_deploy/cli.py, README.md, tests/integration/test_project_cli.py,
  tests/contract/test_public_contract.py
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

保持 `sfo-deploy <动作> --cluster <名称>` 的现有语法：通用命令的 `--config-root`
改为可选，省略时在调用时当前目录按 `./<集群名>`、`./clusters/<集群名>` 的固定顺序解析集群目录；显式
`--config-root` 与项目绑定 CLI 语义不变。步骤语义复用现有动作集合，不做别名或递归搜索。

## Risk Screen

- Public contract, protocol, or CLI change: yes（`--config-root` 从必选改为可选，属于向后兼容的通用
  CLI 契约扩展）
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

## Verification

- Targeted check:
  `uv run --extra test python -m pytest tests/integration/test_project_cli.py tests/contract/test_public_contract.py -q`（24
  项通过）；`uv run --extra test python -m pytest tests -q`（71 项通过）；真实子进程冒烟：在
  `/tmp/sfo009-cli-smoke` 下执行 `python -m sfo_deploy validate --cluster production`，从
  `./clusters/production` 解析成功且返回 0；在项目根误运行时返回 2 并列出两个已搜索位置。
- Result: passed
- Residual risk or follow-up: `./production` 与 `./clusters/production` 并存时固定选择前者，README
  已写明；无阻塞遗留。
