# check/install 缺省环境过滤器时选择全部环境，并为全量 install 增加预执行确认

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/010-default-all-environments/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/010-default-all-environments/proposal.md
- Affected paths: src/sfo_deploy/cli.py, src/sfo_deploy/integration.py, src/sfo_deploy/planning.py,
  src/sfo_deploy/errors.py, tests/integration/test_project_cli.py,
  tests/unit/test_config_planning.py, tests/contract/test_public_contract.py, README.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

`RunOptions` 解除对 `check`/`install` 的“必须有
--environment”强制校验，规划器已有的“过滤器缺省全选”语义直接生效：省略环境过滤器时按当前机器范围选择全部环境，`--app`
冲突校验保留。`check` 不设确认；`install` 在缺省全量时由 CLI 传入确认回调，于计划生成后、SSH
连接前打印目标环境并要求交互确认，输入 `yes` 才继续；非交互终端未传新增的 `--yes` 时返回取消（退出码
130），新增 `CancelledError` 作为该路径的稳定错误类别。README 同步说明缺省语义、确认门禁与 `--yes`。

## Risk Screen

- Public contract, protocol, or CLI change: yes（`--environment` 从必选改为缺省全选，新增 `--yes`
  与取消退出路径）
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
  `.venv/bin/python -m pytest tests -q`；`.venv/bin/python -m pytest examples/eleph-server-multipass/tests -q -k 'not bootstrap'`
- Result: passed
- Residual risk or follow-up: 全量 `install` 的误操作面由确认门禁缓解但未被消除；自动化路径以
  `--yes` 显式承担风险；README 已写明。示例完整套件与 harness-self-check
  的既有环境/模板失败见完成报告。
