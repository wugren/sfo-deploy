# 新增 `type: template` 文本占位符配置 updater 变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/048-text-placeholder-updater/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/048-text-placeholder-updater/proposal.md
- Design: docs/versions/v0.1/modules/sfo-deploy/048-text-placeholder-updater/design.md
- Risk profile: docs/versions/v0.1/modules/sfo-deploy/048-text-placeholder-updater/risk-profile.yaml
- Affected paths:
  - `src/types.ts`
  - `src/mod.ts`
  - `src/config.ts`
  - `src/config_generation.ts`
  - `src/history.ts`
  - `src/remote_deployment.ts`
  - `src/cli.ts`
  - `src/planning.ts`
  - `src/remote_runtime/config_updater.ts`
  - `src/remote_runtime/config_updater.bundle.js`
  - `tests/unit/app_management_config.test.ts`
  - `tests/unit/managed_config_generation.test.ts`
  - `tests/unit/history.test.ts`
  - `tests/unit/secrets_deploy_config.test.ts`
  - `tests/integration/config_updater.test.ts`
  - `tests/integration/packageless_app_scripts.test.ts`
  - `tests/contract/verify_app_management_contract.ts`
  - `README.md`
  - `docs/guides/sfo-deploy-cluster-configuration.md`
  - `docs/changes/048-text-placeholder-updater.md`
- Explicit tier override: none（用户确认 high-risk 并授权自动完成全生命周期）
- Expanded high-risk packet: existing task packet 048-text-placeholder-updater

## Approach

- 装载面：app.yaml schema v3 `management.configs[].updater.type: template`，绑定声明
  `{secret, placeholder}`；占位符缺省等于秘密名、`^[A-Z][A-Z0-9_]*$` 取值域、重复拒绝；
  仅支持值秘密（装载时归一为 `kind: value` 并要求顶层 `secret_values` 声明），与 `variables`
  互斥；声明了占位符但模板未使用即失败关闭。
- 生成面：占位符语法裁定为仅 `${NAME}` + `$$` 转义，其余 `$` 保持字面（无裸 `$NAME` 展开）；`__SFO_`
  前缀为保留前缀。控制端按原文扫描生成确定性骨架（同输入同 marker， 不同绑定派生互异
  marker），骨架不含任何秘密值。
- 运行面：远端 config_updater 新增 `--format template`，按绑定清单 marker 全量替换 （split/join
  单遍实现、marker 缺失即失败、无递归展开）；注入后沿用既有残留 marker、 UTF-8 与大小校验，validator
  与 on_change 服务动作语义不变；deny env/net/run/FFI 与 `--no-remote --no-npm`
  离线执行不变；`config_updater.bundle.js` 重新编译提交。
- 持久化：plan/history 快照绑定 encode/decode 新增 `{kind: "template", bindings}` 形态；
  计划步骤最小秘密集合与 CLI 序列化把 template 绑定归一为值秘密。旧二进制无法解码含 template
  的新快照（单向边界），回滚需同版本二进制，指南已声明。
- 文档：README 与集群配置指南新增 template 段落与示例，contract 校验断言关键表述
  （`type: template`、`${DB_PASSWORD}` 示例）。

## Risk Screen

- Public contract, protocol, or CLI change: yes（app.yaml v3 新增 `type: template` updater 取值与
  `--format template` 远端参数；对既有五种 updater 装载/运行语义零变化，属纯扩展）
- Persistent data, schema, or migration change: yes（发布历史快照新增 template 绑定形态；
  新快照旧二进制不可读的回滚边界已在指南声明，无自动迁移）
- Security, privacy, or trust-boundary change: yes（秘密值注入 App 自定义文本；保持失败
  关闭：未知/重复/非法占位符、保留前缀、marker 缺失、残留 marker、非法 UTF-8、超限均
  拒绝发布；秘密不进 argv/env/stdout，远端仅获得绑定清单列出的秘密副本）
- Concurrency, lifecycle, or runtime integration change: no（替换在既有单遍 updateConfig
  流程内顺序执行，原子发布/validator/on_change 沿用既有链路）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: yes（重新编译 提交
  `config_updater.bundle.js` 交付产物；不新增第三方依赖，deno.lock 不变）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

全部 yes 项均属于已确认 high-risk 提案范围，风险档案与设计文档覆盖相应 required_checks。

## Verification

- 实现与测试：`deno task check`、`deno task lint`、`deno task fmt`（作用域）通过；任务
  作用域统一入口 `harness/scripts/test-run.py sfo-deploy/048-text-placeholder-updater all` 7 步全部
  exit 0（制品
  `.harness/test-results/test-runs/20260905T093558Z-sfo-deploy+048-text-placeholder-updater-all.json`）；
  全仓 `deno task test` 232 过/0 败。
- 验收探针（真实链路）：buildDeploymentBundle 对 template 输出 skeleton +
  `{secret, kind: "value", encoding: "utf8", type: "string", selector: null, marker}` 绑定
  清单并被远端接受；51 处占位符全量替换、`$$`/字面 `$`、含正则元字符/换行/`${OTHER}`/ Unicode
  的秘密值逐字节注入且无 marker 残留；含 `__SFO_` 的秘密值注入后被残留守卫拒绝； file 秘密绑定
  template 在装载面被拒；bundle 产物重生成字节一致。
- 静态门禁：harness-check 各阶段（proposal/design/implementation/testing/acceptance）完成
  态通过；lower-tier、risk-profile、stage-scope、schema、testing-coverage、acceptance-report
  检查通过。
- Result: pass
- Residual risk or follow-up: bundle 级 template bindings.json 序列化暂由类型系统与验收
  探针覆盖（集成测试以本地序列化器复刻该形态），可补充专属单元用例；旧二进制不读新快照
  的兼容边界依赖文档声明（无历史二进制制品可自动化验证）；047 变更记录登记的三项先存
  失败测试已在本任务按当前生命周期语义修复/移除（文件秘密现随 configure/deploy 步骤传 播；nginx
  示例已迁移为 schema v3 managed App）。
