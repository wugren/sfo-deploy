# 任务完成报告：033-remove-template-deno-field

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/033-remove-template-deno-field.md

## Delivery Summary

- Outcome: 示例集群模板不再写入 `deno` 字段，重新生成后的 `machines.yaml` 使用框架 默认裸命令
  `deno`；示例 README 已同步删除旧绝对路径说明并保留 install-deno 自动 同步说明。
- Handoff: 用户重新运行 `prepare-multipass.sh` 生成的集群不再包含 `deno` 行； 当前已存在的本地
  `clusters/multipass/machines.yaml` 也已在此前手动移除该字段。

## Proposal Consistency

| change_id                      | requirement_or_boundary                                                            | proposal_source  | delivery_evidence                                                                                                                                                                                                                  | finding                    | status |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------ |
| CHG-remove-template-deno-field | 示例模板不再写出 `deno` 字段，生成集群使用框架默认的裸命令 `deno`；README 同步说明 | proposal.md PI-1 | `machines.yaml.tpl` 中已无 `deno` 行；`tests/integration/environment_placement.test.ts` 的 multipass 模板用例（复制模板→替换 IP→loadCluster→buildPlan）通过；README 已删除旧路径说明并保留 `deno` 默认与 install-deno 自动同步说明 | 未发现与提案要求不一致之处 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                                                                    | adversarial_check                                                                                                                                                 | finding_or_not_applicable_reason                                                 | status |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | 模板删除前后对比：`machine.scriptRuntime.executable` 在无 `deno` 字段时由 `loadMachines` 落入 `item.deno ?? "deno"`；生成集群用例加载后构建 plan 通过 | 构造“模板重新生成后不写 deno、写成重复/非法内容、保留旧绝对路径”三种反例，仅本次删除模板字段的配置成功；非法内容仍被严格装载拒绝                                  | 未发现缺陷：模板行为与框架默认值一致，删除不会改变其它机器字段                   | pass   |
| boundaries-and-failure-paths | README 中 `--install-to /usr/local` 命令、`deno --version` 验证与 install-deno 自动同步说明；模板复制替换 IP 的边界用例                               | 逐项核对 README 不再沿用 `/usr/local/bin/deno` 作为模板配置说明；检查若远端 PATH 不含 deno 时 README 明确提示默认命令依赖 PATH；install-deno 自动同步仍为独立说明 | 未发现边界或失败路径缺口；PATH 前提已被文档表达，install-deno 同步行为按范围保留 | pass   |
| regression-and-side-effects  | 相关模板集成测试、install-deno 文档契约、check/lint/fmt；变更前后 git 差异范围                                                                        | 全量 `deno task test` 通过；文档契约仍能匹配三份文档的 install-deno 示例与自动同步标记；模板测试证明删除字段后 loadCluster/buildPlan 正常                         | 未发现回归或非预期副作用；仅模板、README、变更记录与任务文档被修改               | pass   |

## Verification

- Targeted check: `deno test tests/integration/environment_placement.test.ts`、
  `deno run tests/contract/verify_install_deno_contract.ts`、`deno task check`、
  `deno task lint`、`deno task fmt --check`
- Result: pass
- Exception reason: 未执行真实 Multipass 重新生成，因为该项不改变框架行为且模板集成
  测试已覆盖“复制模板 → 替换 IP → 严格装载 → 构建 plan”的完整本地链路

## Findings

| id  | severity | evidence                                           | problem              | blocking |
| --- | -------- | -------------------------------------------------- | -------------------- | -------- |
| F-1 | none     | 模板集成测试、文档契约、全量测试与静态检查全部通过 | 未发现任务范围内缺陷 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 模板已不再写 `deno` 字段，README 与变更记录一致，三类独立缺陷搜索均 pass，
  相关集成/契约测试与全量测试通过；install-deno 自动同步写回绝对路径的行为属于本任务
  明确排除的范围，已在变更记录中列为后续可选项。
