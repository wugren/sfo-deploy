# 任务完成报告：030-fix-install-deno-script-argv

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/030-fix-install-deno-script-argv.md

## Delivery Summary

- Outcome: install-deno 不再因“远端命令参数不合法”在本地构造命令时失败；安装脚本
  单行化后可通过传输层严格 argv 校验并正常执行远端安装，CLI/退出码/JSON 与远端 最小依赖契约不变。
- Handoff: 交付物为 `src/ssh_install.ts` 的脚本构造修复、`tests/unit/ssh_install.test.ts`
  新增回归测试、标准变更记录与本报告；用户可直接重跑
  `sfo-deploy install-deno --cluster multipass --config-root ./examples/eleph-server-multipass/clusters`
  验证。

## Proposal Consistency

| change_id                        | requirement_or_boundary                         | proposal_source  | delivery_evidence                                                                                                                                                         | finding                    | status |
| -------------------------------- | ----------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------ |
| CHG-fix-deno-install-script-argv | 安装脚本须通过传输层参数校验且保持原 shell 语义 | proposal.md PI-1 | 单行脚本通过 `validateArgv`/`quotePosix`，真实 `OpenSshRemoteSession` 渲染出无换行的 `exec env DENO_INSTALL=... /bin/sh -c '...'`，stub 分支实测 curl/wget 均命中 v2.2.11 | 未发现与提案要求不一致之处 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                                                                                      | adversarial_check                                                                                                                    | finding_or_not_applicable_reason                                            | status |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | 逐语句比对新旧 `installerScript`：set -eu、curl/wget 前置检查、unzip/7z 检查、安装器管道与 v2.2.11 版本参数均保留；用 /tmp 隔离 PATH 的 stub curl/wget 实测两条下载分支 | 构造缺 curl/wget、缺 unzip/7z 场景确认 fail-closed 中文报错且退出非零；用 `sh -n` 校验单行脚本语法；验证 `quotePosix` 对该脚本不抛错 | 未发现缺陷：单行 `;` 分隔与换行在 POSIX sh 中语义等价，分支行为与原设计一致 | pass   |
| boundaries-and-failure-paths | 走真实 `OpenSshRemoteSession.run` 全链路：validateArgv 接受单行脚本、渲染命令无控制字符、安装后版本验证返回 installed                                                   | 检索 `src/` 全部 `/bin/sh -c` 调用点，确认仅 install-deno 曾传多行脚本且已修复；检查空参数/版本注入/路径校验既有用例仍通过           | 未发现残留多行 argv 或校验绕过边界；缺工具时仍按原契约报错而不是静默安装    | pass   |
| regression-and-side-effects  | 全量 `deno task test` 135 项通过，`deno task check`/`lint`/`fmt` 通过；transport 控制字符拒绝等既有用例不受影响                                                         | 检查 git diff 仅含 `src/ssh_install.ts`、`tests/unit/ssh_install.test.ts` 与任务文档；确认公开导出与 CLI JSON/退出码无改动           | 未发现回归或非预期副作用；`deno.lock`、配置与示例集群均未触碰               | pass   |

## Verification

- Targeted check: `deno task test`（135
  通过）、`deno task check`、`deno task lint`、`deno task fmt`，以及真实 `OpenSshRemoteSession`
  端到端安装模拟
- Result: pass
- Exception reason: n/a（无未执行项；真实 multipass E2E 留作后续环境验证）

## Findings

| id  | severity | evidence                               | problem                | blocking |
| --- | -------- | -------------------------------------- | ---------------------- | -------- |
| F-1 | none     | 全量测试、静态检查与端到端模拟全部通过 | 未发现阻断或非阻断缺陷 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 根因（多行脚本作为单个 argv 被传输层控制字符校验拒绝）已修复并有回归测试；
  行为/契约/退出码未变，独立缺陷搜索三类全部通过，变更记录与提案一致。
