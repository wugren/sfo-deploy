---
task_manifest: task.yaml
status: approved
confirmed_by: user
confirmation_at: 2026-09-04
---

# Multipass 集群增加 Nginx App 与 jx-web App 提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries:
  - `nginx` 作为无安装包 App 会通过 `configure` 直接生成配置、替换主配置并重启服务，改变 sfo-deploy
    公共 App schema、计划/执行行为以及 Multipass 示例的运行时集成和部署表面，命中
    contract-protocol、runtime-integration 与 build-config-deployment 边界。
  - `jx-web` 需要下载、校验、解包并原子发布前端制品到
    `/home/projects/ui`，同时保留可回退版本；错误的归档边界、权限或发布顺序会直接造成站点不可用。
  - Nginx 配置把 `/prod-api/` 转发到 `localhost:8080`，与现有 `jx-server`
    建立可观察的跨组件契约；需要设计、测试和独立验收覆盖代理路径、SPA fallback、失败清理与回退。
- Proposal and tier confirmation: 用户已于 2026-09-04 确认提案与 high-risk 层级，并授权自动完成。

## Background and Goal

当前 Multipass 集群只部署 `jx-server`，没有前端静态站点及统一的 80 端口入口。用户明确要求 `nginx`
也作为 App，但 Nginx 配置不需要下载，而是通过 `configure` 直接生成，并允许 App
没有安装包。提案因此先扩展 sfo-deploy 的 App 模型，支持“packageless/configure-only
App”，再用该模型实现 `nginx` App。

目标是在 `examples/eleph-server-multipass/clusters/multipass` 中得到可验证、可重复部署的 Nginx App +
`jx-web` App 运行结果，并同步维护生成该集群的 `cluster-template`，避免下次 prepare 时丢失配置。

## Scope

### In scope

- 扩展 App schema：允许 App 显式声明 `packageless: true`。这类 App 不需要 `app_versions.yaml`
  条目、不参与 `fetch`/包上传/包解压，必须提供 `configure` 脚本且不得提供 `deploy` 脚本；部署计划把
  `deploy` 动作映射为 `check` + `configure`。
- 新增 `apps/nginx`：以 `packageless: true` 建模。App 使用模板/脚本直接生成 Nginx 配置；脚本以
  Ubuntu 包管理器确保 Nginx 程序可用，验证候选配置，原子替换 `/etc/nginx/nginx.conf`，并重启 Nginx。
- 新增 `apps/jx-web`：使用与 `jx-server` 相同的显式制品占位策略，在 `app.yaml`/`app_versions.yaml`
  中要求调用方提供 HTTP(S) 或 filehub 包 URL 和 SHA-256；部署脚本安全解包静态站点、验证
  `index.html`、原子切换 `/home/projects/ui` 并保留一个可回退版本。
- `cluster.yaml` 把 `nginx` 和 `jx-web` 都放置到 `eleph-server`。现有 `jx-server` 继续监听
  8080，Nginx App 按用户配置代理 `/prod-api/`。
- 同步修改 `cluster-template` 和当前 `clusters/multipass`
  副本；`scripts/update-filehub-app-versions.ts` 继续只处理有安装包的 `jx-server` 和
  `jx-web`，不把无安装包的 `nginx` 纳入 filehub 版本列表。补充示例 README、配置/计划/脚本测试。
- 验证 SPA 路由 fallback、静态文件路径、API 代理头与尾斜杠语义、Nginx
  配置语法、归档路径穿越防护、原子发布、失败清理和回退。

### Out of scope

- 不构建、上传或托管 `jx-web` 制品，也不为 `nginx` 伪造配置包；不自动推导 URL 或 SHA-256。
- 不修改 `jx-server` 的 API、端口、数据库或 Redis 配置。
- 不配置域名、TLS/ACME、外网端口转发、防火墙或负载均衡。
- 不为 Nginx
  增加缓存、压缩、限流、安全响应头或多实例高可用；保留用户给出的配置语义，仅做部署所需的路径/校验处理。
- 不改变 sfo-deploy 的公共 schema
  或执行引擎，除非后续设计证明现有能力无法安全表达本需求；若需要改变，将返回提案重新确认。

### Boundary with neighboring modules

- sfo-deploy 公共模型负责 packageless/configure-only App
  的校验、计划、执行和测试；`deployment-framework` 示例拥有 `nginx` App 脚本、`jx-web` App
  脚本、模板、示例说明和集成测试。
- `sfo-deploy` 继续负责解析、计划、下载、哈希校验、传输和远端脚本执行；本提案默认不修改其生产代码。
- Nginx 拥有 80 端口、静态文件服务和 `/prod-api/` 代理；`jx-server` 仍拥有 8080 后端服务；`jx-web`
  制品只拥有 `/home/projects/ui` 发布内容。

## Requirement Review

需求合理。用户已明确选择把 Nginx 作为 App，并通过 `configure` 直接生成配置。现有框架把 App 制品和
`deploy` 动作视为必需，无法直接表达这类 App；因此提案扩展 schema，引入显式
`packageless: true`。显式标记优于根据“缺少 package”静默推断：配置错误能 fail closed，也能避免普通
App 意外漏掉制品。

用户给出的 Nginx 配置语义继续保留。实现时只会处理部署必须的可移植性细节，例如确保 `mime.types` 在
`/etc/nginx` 上下文可解析，并在替换前执行 `nginx -t`。`proxy_pass http://localhost:8080/;`
将保留其现有语义：传给后端时去掉匹配到的 `/prod-api/` 前缀。

`jx-web` 制品格式暂定为 `.tar.gz`，顶层可直接包含 `index.html`
或仅包含一个站点根目录；部署前会拒绝绝对路径、`..` 路径穿越、符号链接/硬链接和缺少 `index.html`
的归档。该限制换取远端解包安全和确定的发布根目录。

## Proposal Items

| proposal_id | change_id           | requirement                                                                              | boundary                                                                      | tradeoff                                                        | success_evidence                                                    | non_goal                   |
| ----------- | ------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| P-001       | CHG-packageless-app | 为 App schema 增加 `packageless: true`，支持无安装包、`check` + `configure` 的配置型 App | 无安装包 App 不参与 fetch/包上传/包解压；必须声明 `configure`，禁止 `deploy`  | 显式标记换取 fail-closed 校验和清晰的公共契约                   | 单元/集成测试覆盖配置装载、计划、fetch 跳过、脚本执行和非法组合拒绝 | 不引入 App 到 App 依赖     |
| P-002       | CHG-nginx-app       | 新增 `apps/nginx`，通过 configure 生成配置，更新 `/etc/nginx/nginx.conf` 后重启 Nginx    | App 不下载配置包；脚本负责确保 Nginx 程序可用、验证配置并执行受限生命周期命令 | 配置随仓库模板管理，减少制品链路，但需要严格模板渲染与配置验证  | 配置加载/计划测试、`nginx -t`、原子替换、重启和失败恢复测试通过     | 不增加 TLS、域名或额外调优 |
| P-002       | CHG-jx-web-app      | 下载并校验 `jx-web` tar.gz，安全解包后原子发布到 `/home/projects/ui`                     | 制品由用户提供 URL/SHA 或 filehub target；部署只接受受限归档                  | 限制归档结构，换取路径安全与可靠回退                            | 测试覆盖合法发布、恶意归档拒绝、失败清理、回退和 `index.html`       | 不构建或托管前端制品       |
| P-003       | CHG-jx-web-app      | 下载并校验 `jx-web` tar.gz，安全解包后原子发布到 `/home/projects/ui`                     | 制品由用户提供 URL/SHA 或 filehub target；部署只接受受限归档                  | 限制归档结构，换取路径安全与可靠回退                            | 测试覆盖合法发布、恶意归档拒绝、失败清理、回退和 `index.html`       | 不构建或托管前端制品       |
| P-004       | CHG-nginx-app       | 把 `nginx` 和 `jx-web` 都放置到 `eleph-server`，同步模板集群与当前集群                   | 不新增 App 到 App 依赖；现有 `jx-server` 独立部署                             | 依赖“jx-web”与“nginx”按名称执行且互不阻断；两者变更内容相互独立 | validate/plan 证明两个 App 都在目标机；prepare 后结构不漂移         | 不改变 jx-server 生命周期  |
| P-005       | CHG-nginx-app       | 保留 `/prod-api/` 到 `localhost:8080/` 的代理路径与请求头语义                            | 只覆盖同机后端；不处理跨机发现                                                | 与用户配置完全一致，但前缀会被剥离                              | 静态检查和集成测试验证生成配置及路径语义                            | 不改变后端路由             |

## Success Criteria

- Concrete user-visible or system-visible result: 配置好 `jx-web`、`jx-server` 制品信息后，用户可在
  Multipass 示例中部署；`nginx` 作为无安装包 App 自动生成配置并重启服务，之后访问 VM 的 80
  端口可加载 SPA，刷新前端路由回退到 `index.html`，访问 `/prod-api/` 可代理到本机 8080 后端。
- Required evidence: packageless App 的 schema、计划、fetch
  跳过和执行行为有单元/集成测试；模板集群和当前集群均可通过配置校验；计划包含 `nginx` 与 `jx-web`
  App；Nginx
  配置经过模板渲染/`nginx -t`/原子替换/重启；脚本测试覆盖幂等配置、静态归档安全、原子切换、失败恢复和生命周期；相关示例测试通过；独立验收主动检查边界与回归。
- Explicit non-goals: 不构建制品，不配置 TLS/域名/防火墙，不更改 jx-server 的服务语义；除
  packageless/configure-only 所需能力外不扩展框架公共契约。

## Risks

- 替换 `/etc/nginx/nginx.conf`
  和重启服务具有机器级影响；必须先验证候选配置，并在重启失败时恢复旧配置。
- 模板渲染错误或错误配置可能导致 Nginx 启动失败；必须先渲染到临时位置、执行
  `nginx -t`，替换成功后才重启，重启失败时恢复旧配置。
- packageless schema 若过宽，可能让普通 App 意外跳过下载或缺少发布动作；必须使用显式
  `packageless: true`，并禁止 packageless App 声明 `deploy`。
- 当前工作区包含用户未提交改动，且 `clusters/multipass` 是 prepare 生成的信任包；实施需基于 Harness
  基线隔离本任务改动，不能覆盖无关变更。
- 用户给出的 `localhost` 依赖 Nginx 与 jx-server 同机；本提案固定两者都在
  `eleph-server`，不扩展到跨机器代理。
- 当前框架不能表达 App 到 App 依赖，因此不保证 `nginx` 与 `jx-web`
  的先后顺序。两者设计为独立变更：`jx-web` 只发布静态文件，`nginx` 只更新入口配置；任一 App
  先执行都不会要求另一个 App 已存在。

## Unresolved Questions

- 无。已按用户要求将 `nginx` 放入 `apps/nginx`，并用可下载的 Nginx 配置包满足 App
  必须有制品的框架约束。
