# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/061-add-nginx-environment.md
- 对象：为 Multipass 示例新增 `nginx` 环境安装；验证范围覆盖环境配置、安装/幂等脚本、模板与生成集群同步、相关测试和真实目标机 prepare 行为。

## Delivery Summary

- Outcome: 新增 `nginx` 环境，使用 `/usr/bin/test -x /usr/sbin/nginx` 检查可用性，未满足时通过
  APT 以 `--no-install-recommends` 安装 `nginx`。模板集群和当前生成集群均已声明
  `nginx: [eleph-server]`；README 说明先运行 `prepare --env nginx`，再部署 nginx App。现有
  nginx App 仍只负责配置发布和 systemd 管理，软件安装由环境显式完成。
- Handoff: 真实目标机已通过 `prepare --env nginx --yes` 安装成功，复查显示 `/usr/sbin/nginx` 存在、
  APT 版本为 `nginx 1.24.0-2ubuntu7.17`、`nginx.service` active。后续可运行
  `deno task eleph-deploy deploy --cluster multipass --app nginx --yes`；本次任务未重跑 App deploy。

## Proposal Consistency

| change_id | requirement_or_boundary | proposal_source | delivery_evidence | finding | status |
| --- | --- | --- | --- | --- | --- |
| CHG-add-nginx-environment | `nginx` 环境 `check` 确认 `/usr/sbin/nginx` 已存在 | proposal.md:P-1 | 新增 `check.ts`；远端 `check --env nginx` 未安装时退出 1，安装后退出 0 | 未发现偏差 | pass |
| CHG-add-nginx-environment | 提供非交互 APT 安装脚本 | proposal.md:P-2 | 新增 `install.ts`，遵循现有 jre/mysql/redis 的 APT 模式；真实目标机安装成功 | 未发现偏差 | pass |
| CHG-add-nginx-environment | 环境分配给 `eleph-server`，模板与生成集群同步 | proposal.md:P-3 | 两个 `cluster.yaml` 均包含 nginx；三份新环境文件逐一 `cmp` 一致 | 未发现偏差 | pass |
| CHG-add-nginx-environment | 文档说明环境安装与 App 配置分工 | proposal.md:P-4 | README 增加 nginx prepare/deploy 命令并说明 App 不安装软件 | 未发现偏差 | pass |

## Independent Defect Discovery

| category | evidence_inspected | adversarial_check | finding_or_not_applicable_reason | status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | 复查 check/install 脚本、environment schema、CLI check/prepare 输出和远端 APT 安装结果 | 分别验证已安装、未安装、重复 prepare 三种路径：未安装触发 install；已安装后续 install skipped；失败命令抛出错误 | 行为与提案一致；重复执行不会重复安装 | pass |
| boundaries-and-failure-paths | 检查 requires_privilege、run 权限白名单、apt-get 退出码传播、环境名与 App 名同名语义 | 确认环境安装只由显式 prepare 触发，deploy 不会自动安装；apt-get 非零会让脚本抛错；`--env nginx` 只选择环境 | 失败关闭路径成立；未发现越界安装或权限缺口 | pass |
| regression-and-side-effects | 对照 pre-edit 基线、变更清单、cluster validate、相关测试、fmt/lint/check，以及模板和生成集群 diff | 重跑 environment placement/prepare 相关测试，发现并修正 multipass 环境数量断言；复查未改变 nginx App 或 deploy 语义 | 相关 23 项测试通过；唯一缺陷是既有测试期望需同步，已修正且无残留 | pass |

## Verification

- Targeted check: `src/cli.ts validate`、远端 `check --env nginx`、远端
  `prepare --env nginx --yes` 及幂等复查、
  `deno test ... tests/integration/environment_placement.test.ts tests/integration/env_prepare_cli.test.ts
  tests/unit/environment_placement.test.ts tests/unit/env_prepare_cli.test.ts`、
  新脚本 `deno check`、`deno task check`、`deno fmt --check`、`deno task lint`
- Result: passed
- Exception reason: not-applicable；所有验证均已执行。

## Findings

| id | severity | evidence | problem | blocking |
| --- | --- | --- | --- | --- |
| F-1 | low | `environment_placement` 模板断言仍假设 3 个环境，新增 nginx 后失败 | 测试期望未同步为 4 个环境；已在本次任务更新并通过 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: nginx 环境安装、幂等行为、模板/生成集群一致性和文档分工均已实现并通过真实目标机与仓库原生验证；发现的测试期望偏差已修正。
