# 轻量完成报告：本地 App 部署包 fetch 与用户配置

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/025-local-package-download.md
- 对象：新增 `sfo-deploy fetch` 把 App 安装包下载到用户级本地缓存；`deploy` 只从本地缓存取包，
  缺包时预检失败并提示先 `fetch`；`~/.sfo-deploy/config.yaml` 支持自定义 `packages_dir`；
  `rollback`/`install`/`configure` 缓存优先、缺失时远端下载并回填。

## Delivery Summary

- Outcome:
  - `src/cli.ts` 新增 `fetch` 动作与帮助文本（仅 `--app` 筛选），CLI 每次调用装载用户配置并将
    `packages_dir` 通过 `RunDependencies.packagesDir` 传入执行层；`fetch` 输出 `downloaded`/`cached`
    状态与 App、版本、provider、缓存路径、哈希。
  - `src/package_cache.ts` 提供内容寻址缓存：`packages_dir/<provider>/<算法>-<哈希>`，元数据 sidecar
    记录来源与 App/版本，每次使用前校验普通文件与完整哈希；并发下载原子发布，`AlreadyExists`
    时按已有文件重新校验；执行侧只读拷贝到临时目录，缓存本体永不删除。
  - `src/integration.ts` 新增 `fetch` 动作分派、`FetchResult`、`RunOptions` 的 fetch 参数约束；
    `runDeploy` 在创建发布 attempt 前用 `cache.ensure` 做本地包预检（缺失即退出码 3、零 SSH、 零
    release），`executePlan` 的 `prepareExecution` 按动作使用 `local-only` （deploy）或
    `remote-fallback`（rollback/install/configure）。
  - `src/user_config.ts` 严格装载 `~/.sfo-deploy/config.yaml`：`schema_version: 1` + 可选的
    `packages_dir`，支持 `~` 展开与绝对路径，拒绝相对路径和未知字段；缺失文件返回默认
    `~/.sfo-deploy/packages`。
  - README、集群配置指南、示例 README 同步 fetch 用法、缓存配置与 deploy 本地门禁。
- Handoff: 用户先运行 `sfo-deploy fetch --cluster 集群名 --app App名`，再执行
  `sfo-deploy deploy ...`；重复 fetch 输出 `cached` 且不重复下载；未 fetch 直接 deploy 时退出码 3
  并给出补救命令；不在 CLI 路径运行的公共 API 未传 `packagesDir` 时维持原远端下载行为。

## Proposal Consistency

| change_id            | requirement_or_boundary                                              | proposal_source   | delivery_evidence                                                                                                                                    | finding        | status |
| -------------------- | -------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| CHG-fetch-cli-action | 新增 `fetch` 动作，仅 `--app` 筛选下载 App 包并输出 JSON             | proposal.md P-001 | `CLI_ACTIONS`/`RunOptions`/`FetchResult`/帮助与序列化均覆盖；集成测试验证下载、缓存命中、筛选报错与未知 App                                          | 与批准范围一致 | pass   |
| CHG-package-cache    | 内容寻址缓存 + 命中跳过 + 每次校验 + deploy 本地门禁 + fallback 回填 | proposal.md P-002 | `PackageCache.fetch/prepare/ensure` 与执行接入；单元测试覆盖命中、损坏失败、local-only 缺包与清理不删缓存；集成测试验证 deploy 缺包零 SSH/零 release | 与批准范围一致 | pass   |
| CHG-user-config      | `~/.sfo-deploy/config.yaml` 装载 `packages_dir`，严格校验            | proposal.md P-003 | `loadUserConfig` 单元测试覆盖缺省、`~` 展开、绝对路径、未知字段/schema/相对路径拒绝；CLI 装配通过                                                    | 与批准范围一致 | pass   |
| CHG-docs             | README、指南、示例 README 记录 fetch 用法与本地门禁                  | proposal.md P-004 | 三处文档均已更新并描述实现行为                                                                                                                       | 与批准范围一致 | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                   | adversarial_check                                                                                                                                                  | finding_or_not_applicable_reason                                                                                                    | status |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | `runFetch`/`runDeploy` 时序、`PackageCache` 命中/校验/发布分支、`RunOptions` 参数约束、用户配置装载  | 尝试把 fetch 循环置于 release 之后、把 ensure 放到 beginAttempt 之后、把 local-only/remote-fallback 混淆、把 `--environment`/`--machine` 放进 fetch                | 未发现逻辑缺陷：fetch 不触 SSH/不写 release；deploy 预检在 beginAttempt 前；rollback/install 走 fallback；fetch 拒绝全部非 App 筛选 | pass   |
| boundaries-and-failure-paths | 缓存损坏/缺失/并发发布、相对路径/未知字段/schema 错误、无 package 的 App、重复 fetch、非交互 `--yes` | 构造损坏缓存（哈希不符）必失败且提示移除；缺包 deploy 断言 connects=0 与 `.sfo-deploy` 不存在；二次 fetch 断言 provider 调用仍为 1；清理 artifact 后缓存文件仍存在 | 未发现新缺陷：失败关闭、幂等跳过、缓存不被清理；sidecar 损坏自动重建不影响包                                                        | pass   |
| regression-and-side-effects  | 既有 CLI/传输/历史/下载/环境放置/集成测试；全量测试与格式检查                                        | 全量 `deno test tests` 78 通过；2 项失败复现为任务前陈旧路径（`environments/eleph-server/`）；`deno lint src tests` 通过；新修改文件 `fmt --check` 通过            | 未发现本任务引入的回归；残余为任务前工作区基线问题                                                                                  | pass   |

## Verification

- Targeted check: `deno task check`；`deno lint src tests`； `deno fmt --check`（本任务 9
  个新增/修改源与测试文件）；
  `deno test tests/unit/user_config.test.ts tests/unit/package_cache.test.ts tests/integration/fetch_package.test.ts`；
  全量 `deno test tests`（78 通过 + 2 项任务前失败）
- Result: pass
- Exception reason: 全量格式检查仍有 3
  个任务前未格式化文件（`tests/contract/verify_environment_placement_config.ts`、 两个
  `environment_placement` 测试文件），全量测试仍有 2 个任务前陈旧路径失败；均已在变更记录标注，
  不阻塞本交付结论。

## Findings

| id  | severity | evidence         | problem                    | blocking |
| --- | -------- | ---------------- | -------------------------- | -------- |
| F-0 | none     | 三类独立缺陷发现 | 未发现需要修正或阻塞的缺陷 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与用户确认的提案一致：fetch 只下载 App 安装包且重复执行幂等跳过；deploy 缺包时在
  创建发布记录前预检失败并提示 fetch；`~/.sfo-deploy/config.yaml` 的 `packages_dir` 严格装载；
  rollback/install/configure 缓存优先、缺失远端回填；定向单元/集成测试、类型检查、lint 与全量测试
  通过，残余失败均为任务前工作区基线问题。
