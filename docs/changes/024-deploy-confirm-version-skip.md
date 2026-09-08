# deploy 二次确认与版本一致跳过变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/024-deploy-confirm-version-skip/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/sfo-deploy/024-deploy-confirm-version-skip/proposal.md
- Affected paths:
  - `src/cli.ts`
  - `src/integration.ts`
  - `tests/unit/deploy_confirm.test.ts`
  - `tests/integration/deploy_version_skip.test.ts`
  - `examples/eleph-server-multipass/cluster-template/apps/jx-server/scripts/deploy.ts`
  - `examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml`
  - `examples/eleph-server-multipass/clusters/multipass/apps/jx-server/scripts/deploy.ts`
  - `examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml`
  - `README.md`
  - `examples/eleph-server-multipass/README.md`
  - `docs/guides/sfo-deploy-cluster-configuration.md`
  - `docs/changes/024-deploy-confirm-version-skip.md`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- `src/integration.ts` 的 `runDeploy` 在装载集群并生成 `deploy` 计划后、创建发布 attempt 前调用
  `confirmPlan`；未确认抛出 `CancelledError`，因此拒绝路径不连 SSH、不留 release attempt、退出码
  130。
- `src/cli.ts` 把原有 install 确认函数泛化为 `confirmExecutionPlan`，按 `plan.requestedAction` 分别
  显示 install 缺省全量与 deploy 的目标/步骤提示；deploy 动作帮助新增 `--yes` 与确认说明，`--yes`
  帮助文本改为同时覆盖 install 缺省全量与 deploy。
- `deploy.ts` 使用 `${WORK_DIRECTORY}/.jx-server.version` 作为远端版本标记：通过 `/usr/bin/cat`
  读取，与 `metadata.parameters.version`（来自
  `app.yaml.version`）比对；一致时跳过复制/重启/健康检查，
  不一致时保持原原子发布流程并在健康检查成功后写入新标记；失败回滚只恢复 JAR，标记未动，因此回滚后
  版本一致性保持。模板与 live cluster 脚本逐字节同步。
- `app.yaml` 的 deploy `run` 权限新增 `/usr/bin/cat`（读取版本标记的最小命令）。
- 新增两组测试：CLI 确认门禁（提示、`--yes`、拒绝路径零 SSH 与零发布记录）与部署脚本行为（版本一致
  跳过、新版发布+重启+标记、模板/live/权限契约）。
- 文档同步：README、示例 README 与集群配置指南说明确认门禁、`--yes` 与版本一致跳过语义。

## Risk Screen

- Public contract, protocol, or CLI change: yes（`deploy` 增加执行前确认，自动化调用必须显式传
  `--yes`；帮助文本与 README 同步更新；属已确认提案内的明确改动）
- Persistent data, schema, or migration change: no（远端新增 `.jx-server.version` 部署产物标记，
  不改变任何配置文件/发布历史 schema）
- Security, privacy, or trust-boundary change: no（deploy `run` 白名单仅增加
  `/usr/bin/cat`，权限模型 与白名单思想不变）
- Concurrency, lifecycle, or runtime integration change:
  yes（真实部署面的预期变化：版本一致跳过重启； 范围限于 jx-server App 与 live
  镜像，行为测试与模板-实例一致契约覆盖）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: yes（部署语义变化即本次需求主体；
  历史快照/回退机制与数据未变）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

以上 yes 项均属于用户已确认的提案范围，未改变需求/验收边界，因此保留 `standard` 层级并在完成报告
记录残余风险。

## Verification

- Targeted check:
  - `deno task check`
  - `deno lint src/cli.ts src/integration.ts tests/unit/deploy_confirm.test.ts tests/integration/deploy_version_skip.test.ts`
  - `deno fmt --check`（本任务涉及 5 个源/测试/脚本文件）
  - `deno test tests/unit/deploy_confirm.test.ts tests/integration/deploy_version_skip.test.ts tests/unit/transport_cli.test.ts`
  - 全量 `deno test tests`（69 通过；2 项为任务前已存在的陈旧路径失败）
  - `tests/contract/verify_independent_remote_scripts.ts closure|docs`
- Result: pass
- Residual risk or follow-up:
  - `app.yaml.version` 当前仍是 `external-url` 哨兵值，实战前必须替换为真实版本号，否则版本一致判定
    无意义（README 与指南已标注）。
  - 未传 `--yes` 的既有 deploy 自动化调用现在会取消（退出码 130），需要显式加 `--yes`。
  - 远端无 `.jx-server.version` 标记（首次部署或标记被删）时按“版本不一致”完整发布一次。
  - 标记写入若在健康检查成功后失败，命令报错且下次同标记部署会再次发布（自愈收敛，不会误跳过）。
  - 全量 `deno task fmt` 仍有 3 个任务前未格式化文件；全量测试仍有 2 个任务前陈旧路径失败
    （`independent_remote_scripts.test.ts` 引用不存在的 `environments/eleph-server/`
    路径），均与本次 交付无关。
