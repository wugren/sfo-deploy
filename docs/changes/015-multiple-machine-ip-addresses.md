# 集群机器支持多个 private/public IP

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/015-multiple-machine-ip-addresses/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/sfo-deploy/015-multiple-machine-ip-addresses/proposal.md
- Affected paths: src/sfo_deploy/cli.py, src/sfo_deploy/config.py, src/sfo_deploy/history.py,
  src/sfo_deploy/models.py, src/sfo_deploy/planning.py, src/sfo_deploy/transport.py,
  tests/integration/test_project_cli.py, tests/test_release_history.py,
  tests/unit/test_config_planning.py, tests/unit/test_transport.py, README.md,
  docs/guides/sfo-deploy-cluster-configuration.md
- Explicit tier override: 用户确认按 `standard` 完成，低于提案建议的 `high-risk`
- Expanded high-risk packet: none

## Approach

兼容读取单个 IP 字符串和有序 IP 列表，并在领域模型中规范化为不可变候选集合。规划继续依据 region/显式
`address_kind` 选择 private 或 public 类别，保留首项作为计划主地址，同时把同类候选地址交给 SSH
传输层顺序尝试。发布历史读取兼容旧单值，新增记录保存完整候选列表和已解析主地址；文档同步配置语法与回退边界。

## Risk Screen

- Public contract, protocol, or CLI change: yes（`machines.yaml` 的两个 IP
  字段新增列表格式，计划输出可能增加候选地址）
- Persistent data, schema, or migration change: yes（发布历史机器快照需兼容旧单值与新列表）
- Security, privacy, or trust-boundary change: yes（每个候选 IP 都必须保持严格 known-host
  校验，不能因重试放宽）
- Concurrency, lifecycle, or runtime integration change: yes（SSH
  建连新增确定顺序的串行重试和聚合失败）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact:
  yes（旧配置与旧历史必须继续可读，新历史必须可回放）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

以上风险均已在确认前识别；用户明确选择
`standard`，因此保留该等级并通过定向契约、单元、传输及历史兼容测试降低风险。

## Verification

- Targeted check:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python -m pytest tests/unit/test_config_planning.py::test_machine_ip_fields_accept_ordered_lists_and_resolve_all_candidates tests/unit/test_config_planning.py::test_machine_ip_lists_reject_invalid_shapes tests/unit/test_transport.py tests/integration/test_project_cli.py::test_cli_plan_serializes_all_address_candidates tests/test_release_history.py::TestReleaseUnit::test_plan_snapshot_preserves_multiple_ip_candidates tests/test_release_history.py::TestReleaseUnit::test_plan_snapshot_reads_legacy_v2_scalar_ip_fields -q`；`UV_CACHE_DIR=.harness/uv-cache uv run --active python -m compileall -q src/sfo_deploy`；`git diff --check`
- Result: passed
- Residual risk or follow-up: 串行候选重试会按每个地址分别消耗连接超时；不跨 private/public
  类别回退。一次更宽的探索性测试运行受工作区既有 Deno
  配置迁移失配影响：当前加载器要求带权限的脚本映射，而旧测试夹具仍提供脚本路径字符串；该问题早于本任务产品修改且由独立的
  Deno 任务处理，不归入本交付。
