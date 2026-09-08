# 任务完成报告：034-drop-install-deno-config-sync

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/034-drop-install-deno-config-sync.md

## Delivery Summary

- Outcome: `install-deno` 不再回写 `machines.yaml.deno`；配置写回代码、相关测试与文档
  说明已全部移除，安装动作恢复为“只安装、不改配置”。
- Handoff: 用户运行 install-deno 后配置文件内容保持不变；未写 `deno` 字段的集群按 既有默认裸命令
  `deno` 调用远端运行时。

## Proposal Consistency

| change_id                       | requirement_or_boundary                                                     | proposal_source  | delivery_evidence                                                                                                                                                       | finding                    | status |
| ------------------------------- | --------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------ |
| CHG-drop-install-deno-sync      | install-deno 不再写入或修改 machines.yaml.deno                              | proposal.md PI-1 | `src/integration.ts` 已删除 syncMachineDenoConfig 调用与辅助函数；`src/config.ts` 已删除 syncMachineDenos/MachineDenoUpdate；DV 测试断言安装前后 machines.yaml 内容不变 | 未发现与提案要求不一致之处 | pass   |
| CHG-drop-install-deno-sync-docs | 三份文档与文档契约改为说明 install-deno 不修改 machines.yaml，缺省使用 deno | proposal.md PI-2 | README/指南/示例 README 已改为“不修改 machines.yaml + 默认裸命令 deno”；tests/contract/verify_install_deno_contract.ts 增加无同步标记断言并移除了“原子同步”旧标记       | 未发现与提案要求不一致之处 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                                                                              | adversarial_check                                                                                                                       | finding_or_not_applicable_reason                                        | status |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| behavior-and-logic           | `src/integration.ts runInstallDeno` 删除同步调用后的完整返回路径；`src/config.ts` 保留 `item.deno ?? "deno"` 装载逻辑；DV 主流程、privileged、present、失败路径 | 构造“安装后 machines.yaml 内容不变”“present 跳过时也不写配置”“失败机器不写配置”反例，DV 已覆盖安装后内容不变；检查是否有残留导入/死代码 | 未发现缺陷：install-deno 现在零配置写回，删除的代码无其它消费者         | pass   |
| boundaries-and-failure-paths | 文档契约对三份文档的不修改断言与旧短语移除断言；contract 确保不会误留“原子同步”字样；全量测试中 install-deno 失败/preflight/确认路径                            | 检查 README/指南/示例中是否存在换行拆开的“不修改 machines.yaml”标记或旧同步说明；构造契约缺失文档时会 fail                              | 未发现边界或失败路径缺口；PATH 前提由文档披露，手工绝对路径仍是可选方式 | pass   |
| regression-and-side-effects  | 全量 `deno task test` 153 项通过；check/lint/fmt 通过；变更前后 git 差异范围                                                                                    | 逐项核对 task 032 的同步测试全部移除而非残留；公开 CLI/JSON/退出码相关集成测试未受影响；模板集成测试仍通过                              | 未发现回归或非预期副作用；仅删除了专用于写回的代码与断言                | pass   |

## Verification

- Targeted check: `deno test tests/unit/config_planning.test.ts tests/dv/install_deno.test.ts`、
  `deno run tests/contract/verify_install_deno_contract.ts`、`deno task check`、
  `deno task lint`、`deno task fmt --check`；随后全量 `deno task test`
- Result: pass
- Exception reason: n/a（无未执行项；真实 SSH/multipass E2E 留作后续环境验证）

## Findings

| id  | severity | evidence                                                                       | problem              | blocking |
| --- | -------- | ------------------------------------------------------------------------------ | -------------------- | -------- |
| F-1 | none     | 全量测试、文档契约、静态检查全部通过；git diff 只含删除写回代码与对应文档/测试 | 未发现任务范围内缺陷 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: install-deno 已完全移除 machines.yaml 写回，DV 证明安装前后配置不变，文档
  契约与三份说明一致，153 项全量测试与 check/lint/fmt 通过；三类独立缺陷搜索均 pass。
