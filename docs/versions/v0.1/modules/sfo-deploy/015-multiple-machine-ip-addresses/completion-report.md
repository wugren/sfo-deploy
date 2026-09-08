# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/015-multiple-machine-ip-addresses.md

## Delivery Summary

- Outcome: `machines.yaml` 的 `private_ip`、`public_ip` 已兼容单个 IP
  和有序非空列表；规划保留主地址并携带选定类别的全部候选，SSH 按声明顺序串行回退，CLI
  显示候选地址，execution-plan v3 保存多地址且继续读取 v1/v2 单值历史。
- Handoff: 可直接使用 `private_ip: [10.0.0.10, 10.0.0.11]` 或对应 `public_ip` 列表；只在
  region/`--address-kind` 已选中的类别内重试，不跨 private/public
  切换。工作区原有及并行变化均已保留，未将无关的 Deno 任务文件归为本任务交付。

## Proposal Consistency

| change_id                         | Requirement or Boundary                                              | Proposal Source                                 | Delivery Evidence                                                                                                                            | Finding                                  | Status |
| --------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| CHG-multiple-machine-ip-addresses | 两类 IP 支持有序多值、同类串行连接回退、单值及历史兼容，不跨类别回退 | proposal.md 的 P-001、Scope 与 Success Criteria | `config.py` 规范化并校验输入；`planning.py` 绑定候选；`transport.py` 顺序重试；`history.py` v1/v2/v3 分流；CLI、README、指南和 13 项定向测试 | 当前交付覆盖批准的行为、兼容与非目标边界 | pass   |

## Independent Defect Discovery

| Category                     | Evidence Inspected                                                                                            | Adversarial Check                                                                                                                          | Finding or Not-Applicable Reason                                                                                                                                                                                                                         | Status |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | `config._ip_addresses`、`planning.resolve_machine`、`ParamikoTransport.connect`、CLI 计划序列化及对应定向测试 | 逐项追踪单值/列表从 YAML 到模型、计划和连接循环；尝试反例包括顺序被集合打乱、首项未作为主地址、跨类别偷回退、第二地址成功后仍继续连接      | 地址顺序全程使用 tuple 保持；规划只选择一个类别并以首项为主地址；传输只遍历该候选 tuple 且成功即返回。发现 history 错误文字残留 v2，已修正为 v3 或 v2/v3                                                                                                 | pass   |
| boundaries-and-failure-paths | 配置空/重复/非法输入分支、单地址与全候选连接失败分支、known-host 策略设置和 client 关闭路径                   | 检查空列表、重复 IP、非法元素、非列表类型、单地址旧错误格式、每个候选严格 RejectPolicy、失败 client 关闭和聚合错误是否遗漏地址             | 空/重复/非法输入均失败关闭；13 项测试覆盖单值兼容、两地址回退、全部失败聚合和单地址错误格式；每次尝试重新加载 host keys 并设置 RejectPolicy，失败 client 均关闭                                                                                          | pass   |
| regression-and-side-effects  | `Machine`/`ResolvedMachine` 旧构造形式、execution-plan 编解码、README/指南、工作区基线与 changed-path 清单    | 用旧字符串/`None` 直接构造模型，降级生成 v2 标量历史后重新读取，并检查 CLI 保留原 `address` 同时新增 `addresses`；核对基线中任务外并行文件 | 旧构造会规范化为单元素/空 tuple，v2 历史成功读取，v3 保存完整候选，原单地址错误格式保留。更宽测试受既有 Deno 夹具失配阻断；本任务自包含路径全部通过。基线列出的 `tests/integration/test_deno_script_runtime.py` 为并行 Deno 任务变化，本任务未编辑或认领 | pass   |

## Verification

- Targeted check:
  `UV_CACHE_DIR=.harness/uv-cache uv run --active python -m pytest tests/unit/test_config_planning.py::test_machine_ip_fields_accept_ordered_lists_and_resolve_all_candidates tests/unit/test_config_planning.py::test_machine_ip_lists_reject_invalid_shapes tests/unit/test_transport.py tests/integration/test_project_cli.py::test_cli_plan_serializes_all_address_candidates tests/test_release_history.py::TestReleaseUnit::test_plan_snapshot_preserves_multiple_ip_candidates tests/test_release_history.py::TestReleaseUnit::test_plan_snapshot_reads_legacy_v2_scalar_ip_fields -q`；`UV_CACHE_DIR=.harness/uv-cache uv run --active python -m compileall -q src/sfo_deploy`；`git diff --check`
- Result: passed
- Exception reason: not-applicable

## Findings

| ID  | Severity | Evidence                                 | Problem                                                                                                                                                | Blocking |
| --- | -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| F-1 | low      | `history.py` 新 v3 编码与错误分支        | 初次审查发现错误信息仍称 execution-plan v2；已更正并重新验证                                                                                           | no       |
| F-2 | medium   | 更宽探索性 pytest 运行与任务前工作区内容 | 既有 Deno 迁移中，加载器已要求脚本权限映射但旧夹具仍写字符串脚本，导致许多测试在进入 IP 路径前失败；本任务以自包含最小集群和独立历史计划验证多 IP 行为 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 已批准的多 IP 配置、同类顺序回退、旧单值/历史兼容、严格 host-key
  边界及文档均有直接实现与通过的定向证据；独立反例检查发现的版本提示缺陷已修复，剩余测试失配属于任务前并行
  Deno 工作且不隐藏本任务自包含行为。
