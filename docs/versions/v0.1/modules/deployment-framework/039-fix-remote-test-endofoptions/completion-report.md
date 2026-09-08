# 完成报告：修复远端 test 的选项结束符兼容性

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/039-fix-remote-test-endofoptions.md

## Delivery Summary

- Outcome: 已移除 `src/transport.ts` 中 4 处远端 `/usr/bin/test` 调用的
  `--`，新增回归测试覆盖密钥目录、清单/目标文件和步骤密钥来源检查；完整测试套件通过。
- Handoff: `secrets-deploy --check` 已可读取 Multipass 节点状态；当前只读检查返回 3 个
  `missing`，需要用户单独确认执行实际部署。

## Proposal Consistency

| change_id                    | requirement_or_boundary                                                                 | proposal_source  | delivery_evidence                                                                                                                                                                     | finding    | status |
| ---------------------------- | --------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| CHG-remote-test-endofoptions | 远端 `/usr/bin/test` 调用不传 `--`，并在 Ubuntu 24.04 的 Multipass 节点上可执行密钥检查 | proposal.md P1-1 | `rg` 确认 5 处 `/usr/bin/test` 均无 `--`；单元测试覆盖目录/文件/来源检查路径；`deno task check` 与 `deno task test` 通过；只读远端 `--check` 从 transport 失败变为预期的 3 个 missing | 未发现偏差 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                                                 | adversarial_check                                                                                                                          | finding_or_not_applicable_reason                       | status |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------ |
| behavior-and-logic           | 检查 OpenSSH 会话中 `checkSecrets`、`#readSecretManifest`、`removeSecret` 和 `exposeStepSecrets` 的返回码分支与 `--check` 结果聚合 | 构造目录缺失、文件缺失、清单缺失和未部署密钥的反例，验证 `exit 1` 继续表示缺失而非失败；单元测试断言相关命令不含 `--` 且检查结果仍保持稳定 | 未发现与存在性判断或错误聚合相关的行为缺陷             | pass   |
| boundaries-and-failure-paths | 检查远端路径规范化、`..` 拒绝、清单缺失、未部署密钥、SSH 会话关闭和测试假命令的退出码处理                                          | 尝试确认移除 `--` 不会绕过安全路径校验；构造带尾部斜杠的目录和缺失目标，确认路径规范化后仍按既有规则处理                                   | 未发现会让路径校验放宽或错误码被错误吞掉的失败路径缺陷 | pass   |
| regression-and-side-effects  | 检查全部 `/usr/bin/test` 调用、其他远端工具的 `--` 用法、单元/集成测试和真实 Multipass 只读检查                                    | 确认没有把其他工具的 `--` 一并移除；运行 `deno task check` 与 `deno task test` 全部通过；只读远端检查无副作用                              | 未发现影响其他远端命令或引入部署副作用的回归           | pass   |

## Verification

- Targeted check: 运行 `deno task check`、`deno task test` 和新增 transport 回归；在 Multipass
  上执行只读 `secrets-deploy --cluster multipass --check --json`，确认返回预期的 3 个 `missing`
  而不是 `binary operator expected`。
- Result: pass
- Exception reason: not-applicable

## Findings

| id    | severity | evidence                                    | problem                | blocking |
| ----- | -------- | ------------------------------------------- | ---------------------- | -------- |
| F-001 | none     | 单元回归、完整测试和真实只读 SSH 检查均通过 | 独立缺陷搜索未发现问题 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 修复满足已确认提案，目标命令兼容 Ubuntu
  24.04，完整测试与真实只读检查均通过，未发现回归或副作用。
