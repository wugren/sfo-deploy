# App 版本/下载/哈希独立配置、版本目录、latest 与重打包变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/026-versioned-app-layout/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/026-versioned-app-layout/proposal.md
- Design: docs/versions/v0.1/modules/sfo-deploy/026-versioned-app-layout/design.md
- Risk profile: docs/versions/v0.1/modules/sfo-deploy/026-versioned-app-layout/risk-profile.yaml
- Affected paths:
  - `src/types.ts`
  - `src/config.ts`
  - `src/planning.ts`
  - `src/history.ts`
  - `src/downloads.ts`
  - `src/execution.ts`
  - `src/integration.ts`
  - `src/transport.ts`
  - `examples/eleph-server-multipass/cluster-template/app_versions.yaml`
  - `examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml`
  - `examples/eleph-server-multipass/cluster-template/apps/jx-server/scripts/configure.ts`
  - `examples/eleph-server-multipass/cluster-template/apps/jx-server/scripts/deploy.ts`
  - `examples/eleph-server-multipass/cluster-template/environments/jx-runtime/templates/jx-server.service`
  - `examples/eleph-server-multipass/cluster-template/environments/jx-runtime/scripts/configure.ts`
  - `examples/eleph-server-multipass/clusters/multipass/`（同一批文件的 live 副本）
  - `README.md`
  - `docs/guides/sfo-deploy-cluster-configuration.md`
  - `examples/eleph-server-multipass/README.md`
  - `tests/_support/fixtures.ts`
  - `tests/unit/config_planning.test.ts`
  - `tests/unit/downloads_secrets.test.ts`
  - `tests/dv/execution.test.ts`
  - `tests/integration/deploy_version_skip.test.ts`
  - `tests/integration/fetch_package.test.ts`
  - `tests/integration/independent_remote_scripts.test.ts`
  - `docs/changes/026-versioned-app-layout.md`
- Explicit tier override: none（用户确认 high-risk）
- Expanded high-risk packet: existing task packet 026-versioned-app-layout

## Approach

- 配置：新增集群根 `app_versions.yaml`（schema_version 1 + `apps` 映射）作为 version/package
  （provider/source/hash）的唯一来源；app.yaml schema v2 移除 version/package 并必填
  `install_directory`（远端绝对 POSIX 路径）；`src/config.ts` 装载合并为既有 `AppDefinition`， 按
  App 全量映射严格校验；纯 v1 内联集群（无 app_versions.yaml）只读兼容，禁止 v1/v2 混用。
- 计划与历史：`PlanStep` 为 App 步骤补充 `installDirectory` 与 `bundleScripts`（App 在 app.yaml
  声明的全部脚本按相对路径去重）；`src/history.ts` 的 v3 plan codec 记录
  `install_directory`/`bundle_scripts` 与脚本 `relative_path`，并让旧快照在可选字段缺失时仍可解码。
- 执行：`src/execution.ts` 对 App 安装包在 SSH 前做 gzip 魔数断言，metadata 注入
  `package_hash`、`install_directory`、App deploy 模板与集群脚本映射；`src/integration.ts` 的
  `fetch` 同样校验 gzip；`src/transport.ts` 的远端 Deno 放行 `HOME` 环境变量供脚本定位
  `~/.sfo-deploy/apps/`。
- 示例：jx-server 模板与 live 副本同步为 app.yaml v2 + app_versions.yaml；configure 准备安装目录并
  渲染共享 application.yml；deploy 先 `sha256sum` 复验，再解压 tar.gz、并入渲染配置/集群脚本/版本
  元数据重打包为真实安装包，存入 `~/.sfo-deploy/apps/<version>/`，发布到
  `<install_directory>/<version>/`，原子切换 `latest`，systemd 从 latest 启动，健康失败回滚重建
  latest；同版本跳过发布与重启。

## Risk Screen

- Public contract, protocol, or CLI change: yes（集群 app.yaml schema v2 与 app_versions.yaml 新
  契约；部署 context metadata 新增字段；CLI 动作不变，v1 只读兼容）
- Persistent data, schema, or migration change: yes（app_versions.yaml 新持久配置；版本目录与 latest
  取代平铺 JAR；发布历史 v1/v2/v3 快照仍可读，不回写）
- Security, privacy, or trust-boundary change: yes（gzip 魔数与目标机 sha256sum 复验形成双重格式/
  完整性门禁；路径校验拒绝非法 install_directory）
- Concurrency, lifecycle, or runtime integration change: yes（版本目录/latest 幂等发布与失败回滚；
  远端临时目录清理）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: yes（重打包产物与部署布局变化即
  本次需求主体；旧快照重放仍按旧脚本执行）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

全部 yes 项均属于已确认 high-risk 提案范围，风险档案与设计文档覆盖相应 required_checks。

## Verification

- 实现与测试：`src/` 类型检查通过；tests 全套 85 项通过（含新增配置 fail-closed、发布/跳过/hash
  拒绝/回滚、gzip 门禁、codec 兼容用例）；契约脚本 closure/docs 通过；模板与 live 副本逐字节一致
  （deploy_version_skip 契约测试）。
- 静态门禁：`deno task check`、`deno lint src tests examples/eleph-server-multipass/src`、
  `deno fmt --check` 通过。
- Result: pass
- Residual risk or follow-up: 旧平铺布局机器不自动迁移（文档明确重新 prepare 或手工迁移）；历史
  版本目录与安装包不做自动清理，由运维保留策略负责。
