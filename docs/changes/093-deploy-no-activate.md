# deploy 支持 --no-activate：只上传并部署，跳过 latest 切换与重启

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/093-deploy-no-activate/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/093-deploy-no-activate/proposal.md
- Affected paths: src/planning.ts, src/types.ts, src/integration.ts, src/cli.ts, src/execution.ts,
  README.md, docs/modules/sfo-deploy.md, tests/unit/config_planning.test.ts,
  tests/unit/app_management_config.test.ts, tests/unit/deploy_confirm.test.ts,
  tests/dv/versioned_deploy_order.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

`deploy`（及预览它的 `plan`）新增布尔式 CLI 选项 `--no-activate`。实现把"激活阶段 （切换 `latest` +
写 `.app.version` + 重启服务）"从"上传并部署（configure/stage）"中解耦：

- `PlanRequest` 新增可选 `activate?: boolean`（缺省 `true`）。
- `buildPlan` 在 `action === "deploy"` 且 `activate === false` 时，对内置 versioned App
  只生成配置/上传步骤：`[configure?, stage]`，同时移除尾部的 script-manager `restart`； 非
  versioned、packageless、环境动作与其他动作不受影响。
- `RunOptions`/`RunOptionsInit` 增加 `activate`（缺省 `true`，布尔校验并透传到
  `buildRequestedPlan`）。
- `createCli` 解析 `--no-activate`（拒绝内联值），更新 deploy 动作帮助文本、全局选项列表与
  部署确认提示（明确本次不切换 latest、不重启）。
- 执行器把"计划内无后续 activate 步骤的应用"识别为 stage-only（terminal stage）：成功 stage 后
  直接视为已提交——不触发 recovery 回滚（避免恢复刚发布的配置并无谓重启服务）、保留新版本目录与
  已发布配置、跳过 systemd 的 daemon-reload/enable/重启准备；`latest`/标记/服务保持执行前状态。
  含激活步骤的计划行为完全不变（取消/失败仍按既有恢复语义处理）。

兼容性约束：缺省行为与当前完全一致；选项只对 deploy/plan 生效。

## Risk Screen

- Public contract, protocol, or CLI change: yes（证据：新增可选 `--no-activate` 选项，仅影响
  传入它的 deploy/plan 计划；缺省与既有 CLI 行为、`--json` 键结构、退出码语义均不变。）
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: yes（证据：stage-only 部署的
  release 记录成功后，其回退计划只重放
  configure/stage，不切换回旧版本——按提案确认的"未激活部署"边界记录，不改默认 rollout。）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

## Verification

- Targeted check: `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  （`ok | 353 passed | 0 failed`）；新增计划/CLI/执行器测试覆盖见完成报告。
- Result: pass
- Residual risk or follow-up: 未激活部署的 release/回退语义为文档化边界，见 Risk
  Screen；"只激活已落地版本"的命令留作独立后续任务。
