# 本地 App 部署包 fetch 与用户配置变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/025-local-package-download/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/025-local-package-download/proposal.md
- Affected paths:
  - `src/user_config.ts`
  - `src/package_cache.ts`
  - `src/results.ts`
  - `src/integration.ts`
  - `src/execution.ts`
  - `src/cli.ts`
  - `src/mod.ts`
  - `tests/unit/user_config.test.ts`
  - `tests/unit/package_cache.test.ts`
  - `tests/integration/fetch_package.test.ts`
  - `tests/integration/package_cli.test.ts`
  - `README.md`
  - `docs/guides/sfo-deploy-cluster-configuration.md`
  - `examples/eleph-server-multipass/README.md`
  - `docs/changes/025-local-package-download.md`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- 新增 `src/user_config.ts`：严格装载 `~/.sfo-deploy/config.yaml`（可选 `packages_dir`，默认
  `~/.sfo-deploy/packages`）；支持 `~` 展开、绝对路径，拒绝相对路径与未知字段；配置文件缺失时
  静默使用默认目录。`createCli` 新增可注入的 `homeDir`，测试不碰真实用户目录。
- 新增 `src/package_cache.ts`：按 provider + `算法-哈希` 内容寻址的本地缓存，元数据 sidecar 记录
  来源、App 名称与版本；每次使用前校验普通文件属性与完整哈希；并发重复下载通过原子 hard-link 发布，
  `AlreadyExists` 后按已有文件重新校验；`fetch` 返回 `downloaded`/`cached` 状态。执行侧 `prepare`
  只读拷贝缓存到临时目录供上传，绝不清理缓存本体。
- `src/integration.ts` 新增 `fetch` 动作与 `FetchResult`：仅接受 `--app`（缺省全部 App），不连 SSH、
  不写发布历史；`RunDependencies` 增加 `packagesDir`，公共 API 未传时保持既有远端下载兼容。
- `deploy` 本地门禁：`runDeploy` 在创建发布 attempt 前用 `cache.ensure` 校验所有需要安装包的步骤，
  缺失即抛 `PreflightError`（退出码 3）并提示 `sfo-deploy fetch --cluster <名称> --app <App>`， 零
  SSH、零 release 记录；`executePlan` 阶段 deploy 为 `local-only`，rollback/install/configure 为
  `remote-fallback`（缺失时远端下载并回填缓存）。
- CLI 帮助、README、集群配置指南与示例 README 同步 fetch 用法、缓存目录配置与 deploy 本地门禁。

## Risk Screen

- Public contract, protocol, or CLI change: yes（新增 `fetch` 动作；`deploy` 未预下载时预检失败
  退出码 3；属用户确认的明确范围）
- Persistent data, schema, or migration change: yes（新增用户级缓存目录与元数据 sidecar
  `schema_version: 1`；集群配置、执行计划、发布历史格式均未改变，旧数据零迁移）
- Security, privacy, or trust-boundary change: no（缓存每次使用前校验哈希；目录/文件按 0700/0600
  收紧；不新增网络信任点，不保存凭据）
- Concurrency, lifecycle, or runtime integration change: yes（并发 fetch 原子发布；deploy 预检提前到
  release attempt 之前）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: yes（部署取包路径变化即本次需求
  主体；回退契约保持不变）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

以上 yes 项均属于已确认提案范围，保留 `standard` 层级并在完成报告记录残余风险。

## Verification

- Targeted check:
  - `deno task check`
  - `deno lint src tests`
  - `deno fmt --check`（本任务新增/修改的 9 个源与测试文件）
  - `deno test tests/unit/user_config.test.ts tests/unit/package_cache.test.ts tests/integration/fetch_package.test.ts`
  - 全量 `deno test tests`（78 通过；2 项为任务前已存在的陈旧路径失败）
- Result: pass
- Residual risk or follow-up:
  - 未先 `fetch` 的既有 deploy 自动化调用现在预检失败（退出码 3），需在 CI/CD 流程中先执行 fetch。
  - 缓存被篡改或损坏时失败关闭并提示人工移除文件，不自动删除；sidecar 元数据损坏会自动重建，不影响
    包本身。
  - fetch 按用户确认只下载 App 安装包；环境 install 包仍由 install 等动作在缓存缺失时远端回填。
  - 全量 `deno task fmt` 仍有 3 个任务前未格式化文件；全量测试仍有 2 个任务前陈旧路径失败
    （`independent_remote_scripts.test.ts` 引用不存在的 `environments/eleph-server/` 路径），均与
    本次交付无关。
