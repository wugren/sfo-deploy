---
task_manifest: task.yaml
status: approved
---

## Workflow Tier Judgment

- Proposed tier: `standard`
- Final tier: standard
- Tier rationale: 这是框架 SSH 远端命令的运行时 bugfix，影响
  `secrets-deploy --check`、移除和步骤密钥复制路径；属于局部实现修复且有单元级回归信号，不涉及持久数据、公共协议变更或跨项目边界。
- Confirmation statement: 用户已于 2026-09-04 明确确认所显示的提案和 `standard` 层级。

## Background and Goal

在 Multipass 示例执行 `secrets-deploy --check` 时，远端返回
`/usr/bin/test: ‘--’: binary operator expected`。原因是 OpenSSH 远端会话在四处使用 GNU/COREUTILS
风格的 `test -f -- path` 或 `test -d -- path`，而 Ubuntu 24.04 的 `/usr/bin/test` 不支持 `--`
作为选项结束分隔符。目标是移除这些无效参数，使 `secrets-deploy` 在远端安全目录检查中正确工作。

## Scope

### In scope

- 将 `src/transport.ts` 中所有传给 `/usr/bin/test` 的 argv 移除 `--`，改为 `/usr/bin/test -f path`
  或 `/usr/bin/test -d path`。
- 增加或调整单元测试，覆盖 `checkSecrets`/密钥检查路径不再向 `/usr/bin/test` 传递 `--`。
- 使用仓库原生 Deno 测试运行目标回归。

### Out of scope

- 不修改 `secrets-deploy` CLI 接口、集群 YAML 格式或项目绑定语义。
- 不更改其他远端命令的 `--` 用法；`rm`、`install`、`chmod`、`stat`、`cat`、`ls` 等工具按其 CLI
  约定继续使用。
- 不执行 Multipass 部署或其他 SSH 状态变更。

## Requirement Review

请求合理：`/usr/bin/test`
的行为是被远端工具链确认的失败路径。保留路径安全性的其他措施不受影响，因为所有路径仍经过
`SAFE_REMOTE_PATH_RE` 与 `..` 段校验；移除 `--` 只影响 shell `test` 工具调用，不扩大可执行命令边界。

## Proposal Items

| proposal_id | change_id                    | Requirement / 要求                                                                                                    | Success Evidence / 成功证据                                                                                                    |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| P1-1        | CHG-remote-test-endofoptions | 远端 `/usr/bin/test` 调用必须使用可移植 argv，不传递 `--`，保证密钥目录、清单和文件存在性检查在 Ubuntu 24.04 上可用。 | 单元测试断言相关远端命令不含 `--`，目标 Deno 回归通过；随后只读 `secrets-deploy --check` 不再返回 `binary operator expected`。 |

## Success Criteria

- `secrets-deploy --check` 不因 `/usr/bin/test --` 而失败。
- 相关单元测试通过，并且代码中不再有 `/usr/bin/test ... -- path` 调用。
- CLI 接口、部署结果结构和远端权限要求保持不变。

## Risks

- `test` 参数顺序错误可能错误判断文件存在；通过覆盖存在/缺失返回码和明确 argv 断言降低。
- 该修复属于部署框架运行时路径；如测试发现更大范围远端兼容性问题，需要返回提案重新划界。
