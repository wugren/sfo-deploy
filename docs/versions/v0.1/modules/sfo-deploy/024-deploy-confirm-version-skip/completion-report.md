# 轻量完成报告：deploy 二次确认与版本一致跳过

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/024-deploy-confirm-version-skip.md
- 对象：让 `sfo-deploy deploy` 在真实部署前请求二次确认（`--yes` 跳过），并在 App 部署脚本中引入远端
  版本标记比对：版本一致时不做任何修改，不一致时原子发布并重启应用切换到新版本，成功后更新标记。

## Delivery Summary

- Outcome:
  - `src/integration.ts` 的 `runDeploy` 在计划生成后、发布 attempt 创建前调用
    `confirmPlan`；未确认抛 `CancelledError`，CLI 退出 130，不连 SSH、不产生 release attempt。
  - `src/cli.ts` 的确认提示泛化为按动作显示（deploy 展示步骤清单并等待 `yes`）；deploy 帮助新增
    `--yes`，`--yes` 说明同时覆盖 install 缺省全量与 deploy。
  - jx-server `deploy.ts` 新增 `.jx-server.version` 标记读写：版本一致时跳过复制/重启/健康检查；
    不一致时保留原子发布+systemd restart+有界健康检查，健康成功后写入新标记；失败回滚恢复上一 JAR，
    标记保持旧版本。模板与 live cluster 脚本逐字节一致，`app.yaml` deploy 权限新增 `/usr/bin/cat`。
  - README、示例 README、集群配置指南同步确认门禁与版本语义。
- Handoff: 用户交互运行 `sfo-deploy deploy ...` 会先看到步骤清单并要求输入 `yes`，自动化调用加
  `--yes`; jx-server 重复部署同版本会幂等跳过，部署新版本后服务自动切换并记录新版本。

## Proposal Consistency

| change_id                       | requirement_or_boundary                                                 | proposal_source   | delivery_evidence                                                                                                                                      | finding        | status |
| ------------------------------- | ----------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------ |
| CHG-deploy-confirm              | deploy 执行前二次确认；`--yes` 跳过；拒绝路径零远端步骤、零发布 attempt | proposal.md P-001 | `runDeploy` 在 `beginAttempt` 前调用 `confirmPlan`；`confirmExecutionPlan` 按动作提示；新增测试覆盖提示、`--yes`、拒绝后 connects=0 且无 `.sfo-deploy` | 与批准范围一致 | pass   |
| CHG-deploy-version-skip-restart | 版本一致不做修改；不一致发布并重启；标记成功更新、回滚保持一致性        | proposal.md P-002 | `deploy.ts` 版本比对/跳过/发布/健康后写标记；模板与 live 逐字节一致；行为测试与结构契约通过                                                            | 与批准范围一致 | pass   |
| CHG-deploy-docs                 | README、指南、示例 README 记录确认门禁与版本语义                        | proposal.md P-003 | 三处文档均已更新，`deno task check` 与契约 docs 检查通过                                                                                               | 与批准范围一致 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                         | adversarial_check                                                                                                                                                                                                                                            | finding_or_not_applicable_reason                                                                                                             | status |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | `runDeploy` 时序、`confirmExecutionPlan` 分支、`deploy.ts` 版本读取/跳过/发布/写标记分支，以及三处文档表述 | 尝试颠倒确认与 attempt 顺序、确认回调返回 false/undefined 行为、版本相等/不等/无标记/空版本、标记读写权限组合                                                                                                                                                | 未发现逻辑缺陷：确认先于 attempt；`--yes` 时 confirmPlan 为 undefined 不误拦；版本缺失报错、无标记按不一致发布、相等跳过；模板/live 脚本一致 | pass   |
| boundaries-and-failure-paths | CLI 非交互/help/参数路径；脚本缺失版本、marker 缺失、健康失败回滚、标记写入失败；live cluster 与模板契约   | 构造拒绝/EOF/`--yes` 三条确认路径；版本一致时仅授权 cat/test 仍成功退出且 JAR 未生成；新版发布后重启与标记断言；健康失败路径由原回滚逻辑保持（标记未动）                                                                                                     | 未发现新缺陷：取消不留 attempt；跳过路径零修改；失败回滚不误更新标记；契约脚本 closure/docs 通过                                             | pass   |
| regression-and-side-effects  | 既有 CLI/传输、历史、下载、环境放置、DV、集成测试；全量 `deno test tests`                                  | 全量测试与 69 项通过；2 项失败为任务前已存在的陈旧路径问题（`independent_remote_scripts.test.ts` 引用不存在的 `environments/eleph-server/` 路径，任务开始前已复现）；`verify_independent_remote_scripts` closure/docs 通过；未触碰发布历史/下载/环境布局逻辑 | 未发现本任务引入的回归；残余为工作区迁移期既有基线问题                                                                                       | pass   |

## Verification

- Targeted check: `deno task check`；`deno lint`（4 个改动源/测试文件）；`deno fmt --check`（5
  个本任务
  文件）；`deno test tests/unit/deploy_confirm.test.ts tests/integration/deploy_version_skip.test.ts
  tests/unit/transport_cli.test.ts`；全量
  `deno test tests`（69 通过 + 2 项任务前失败）；契约
  `verify_independent_remote_scripts.ts closure|docs`
- Result: pass
- Exception reason: 全量格式检查与全量测试存在 3 个未格式化文件/2
  项陈旧路径失败，均为任务前基线，已在 变更记录与手交付说明中标注，不阻塞本交付结论。

## Findings

| id  | severity | evidence           | problem                    | blocking |
| --- | -------- | ------------------ | -------------------------- | -------- |
| F-0 | none     | 三类别独立缺陷发现 | 未发现需要修正或阻塞的缺陷 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与用户确认的提案一致：deploy 已具备执行前二次确认且取消路径零远端副作用；jx-server
  版本一致跳过、版本不同发布+重启+成功记录标记、失败回滚保持版本一致性均已由行为测试与契约验证；
  文档同步；既有 69 项测试通过，残留失败均为任务前工作区迁移基线问题。
