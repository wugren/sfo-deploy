# cluster.yaml 增加 sfo-deploy 版本门禁（精确匹配）

- Status: complete
- Owner module: sfo-deploy
- Task manifest: `docs/versions/v0.1/modules/sfo-deploy/092-cluster-deployer-version-pin/task.yaml`
- Approved proposal: `docs/versions/v0.1/modules/sfo-deploy/092-cluster-deployer-version-pin/proposal.md`
- Affected paths: `src/config.ts`、`src/integration.ts`、`src/types.ts`、`src/mod.ts`、`README.md`、`docs/modules/sfo-deploy.md`、`docs/guides/sfo-deploy-cluster-configuration.md`、`tests/unit/deployer_version_gate.test.ts`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- 在 `src/config.ts` 顶部通过 `import pkg from "../deno.json" with { type: "json" };` 读取仓库根
  `deno.json.version` 为 `TOOL_VERSION` 常量并导出（版本缺失时回落 `<unknown>`），作为唯一运行时版本源。
- `cluster.yaml` schema v2 增加可选字段 `deployer_version`：非空字符串，不做 trim、不做字符集限制，
  缺省表示不启用门禁。通过专用 `exactDeployerVersion` 解析后放入 `ClusterConfig.deployerVersion`。
- 在 `src/integration.ts` 新增 `assertDeployerVersion(cluster)`：声明了 `deployer_version` 且与
  `TOOL_VERSION` 全等不一致时抛 `ConfigurationError` fail-closed。门禁在主 `run()` 集群装载后
  （validate/plan/check/install/prepare/configure/start/stop/restart 共用路径）以及 `runDeploy` 的
  `loadCluster` 之后（deploy 有独立分派分支）都调用，确保 deploy 不被绕过。
- `history`/`rollback` 不装载集群；`fetch`/`install-deno`/`secrets-deploy` 虽装载集群但不做受控执行，
  均不受门禁约束。
- 兼容性：未声明字段的既有集群行为完全不变。

## Risk Screen

- Public contract, protocol, or CLI change: yes — `cluster.yaml` 新增可选字段 `deployer_version`；
  对已声明该字段的集群新增 fail-closed 部署准入门禁，行为向后兼容（缺省不生效）。
- Persistent data, schema, or migration change: no（无持久数据；集群配置可选新字段，无迁移）。
- Security, privacy, or trust-boundary change: no（门禁是管理性准入控制，不涉及秘密或信任边界）。
- Concurrency, lifecycle, or runtime integration change: no（纯控制端前置校验，不引入远端并发或生命周期变化）。
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no（不改变依赖图、构建产物或回滚语义）。
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

## Verification

- Targeted check: `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`（348 passed，
  含新增 `tests/unit/deployer_version_gate.test.ts`）。
- 新增测试覆盖：字段解析与非法值拒绝、精确匹配放行、validate/plan/deploy 不匹配时 fail-closed
  （deploy 用例断言 transport 零连接、release history 目录未创建）、带空白版本不 trim 放行、字段缺失兼容、
  fetch 等 pass-through 动作不受门禁影响。
- Result: passed
- Residual risk or follow-up: 升级操作风险——生产集群 bump sfo-deploy 时必须同步更新各集群
  `deployer_version`，否则 fail-closed；README 与配置指南已写明。