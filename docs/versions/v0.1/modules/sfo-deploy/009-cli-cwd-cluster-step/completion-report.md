# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/009-cli-cwd-cluster-step.md

## Delivery Summary

- Outcome: 通用 `sfo-deploy` 命令的 `--config-root` 变为可选；省略时按
  `./production`、`./clusters/production`
  的固定顺序发现集群目录，两处均不存在时报配置错误并列出已搜索位置。显式 `--config-root` 与项目绑定
  CLI 的固定配置根语义不变。
- Handoff: 安装后可在包含集群目录的当前目录直接执行
  `sfo-deploy configure --cluster production`、`sfo-deploy deploy --cluster production`
  等命令；配置环境/更新安全配置继续使用 `configure`，更新程序使用 `deploy`，README 已给出映射说明。

## Proposal Consistency

| change_id                | Requirement or Boundary                                                     | Proposal Source   | Delivery Evidence                                                                                                                                       | Finding        | Status |
| ------------------------ | --------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| CHG-cli-cwd-cluster-step | 通用 `--config-root` 可选；省略时按两个确定性候选位置发现集群，显式传参不变 | proposal.md P-001 | `src/sfo_deploy/cli.py` 的 `_resolve_generic_config_root` 与可选参数解析；直接子目录、`clusters/` 子目录、优先序、非目录候选、缺失、非法名称测试        | 实现与要求一致 | pass   |
| CHG-cli-cwd-cluster-step | README 提供免 `--config-root` 用法与中文步骤映射                            | proposal.md P-002 | README 命令行章节新增当前目录发现规则、两组示例与 `configure`/`deploy` 映射；契约测试固定示例存在                                                       | 实现与要求一致 | pass   |
| CHG-cli-cwd-cluster-step | 补充 CLI 契约/回归测试且不触碰规划执行内核                                  | proposal.md P-003 | `tests/integration/test_project_cli.py` 新增 6 个发现/边界用例；`tests/contract/test_public_contract.py` 固定可选参数与 README 示例；定向与全量测试通过 | 实现与要求一致 | pass   |

## Independent Defect Discovery

| Category                     | Evidence Inspected                                                                                  | Adversarial Check                                                                                                                                                                                       | Finding or Not-Applicable Reason                 | Status |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------ |
| behavior-and-logic           | `cli.py` 参数流、发现顺序、`RunOptions` 校验复用、bound 入口分支                                    | 反向核查 bound CLI（`generic=False`）是否会读取不存在的 `namespace.config_root`、显式根目录是否绕过发现、集群名校验是否先于路径拼接；复查发现并修正 `main()` docstring 中“必须 --config-root”的过期描述 | 行为符合确认的调用形式与固定顺序；过期描述已修复 | pass   |
| boundaries-and-failure-paths | 新增边界测试与真实错误输出                                                                          | 构造两候选并存、直接候选为文件、两候选均缺失、`../outside` 形式名称；确认按序选择或返回 exit 2 配置错误并展示已搜索路径，不做递归/模糊匹配                                                              | 未发现路径逃逸、候选歧义或意外递归行为           | pass   |
| regression-and-side-effects  | 仓库根全量测试、契约测试、wheel/入口点测试、README 断言、项目绑定 CLI 拒绝 `--config-root` 既有测试 | 运行完整 `tests` 套件与真实子进程冒烟；确认 `python -m sfo_deploy --help` 显示可选 `--config-root`，`/tmp` 工作目录可从 `./clusters/production` validate 成功，项目根误运行返回 2                       | 71 项测试全部通过，未发现框架、示例或打包回归    | pass   |

## Verification

- Targeted check:
  `pytest tests/integration/test_project_cli.py tests/contract/test_public_contract.py -q`（24
  项通过）；`pytest tests -q`（71 项通过）；真实子进程
  `python -m sfo_deploy validate --cluster production` 冒烟（成功返回 0 并解析
  `./clusters/production`，错误路径返回 2）
- Result: passed
- Exception reason: 无

## Findings

| ID  | Severity | Evidence                                          | Problem                                                       | Blocking |
| --- | -------- | ------------------------------------------------- | ------------------------------------------------------------- | -------- |
| F-1 | none     | 三类独立证伪、定向/全量测试与真实子进程冒烟均通过 | 未发现任务范围内缺陷（排查中发现的过期 docstring 已当场修复） | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付满足批准提案三个 requirement：当前目录两个确定性候选发现、README
  用法与步骤映射、契约/回归测试齐全；显式参数与项目绑定 CLI 兼容性已验证。
