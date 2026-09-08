---
task_manifest: task.yaml
status: approved
confirmed_by: user
confirmation_at: 2026-09-04
---

# Multipass App 信息从 filehub 更新提案

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries:
  - 该脚本会写入部署用 `app_versions.yaml`，并让部署流程信任 filehub 返回的版本与 SHA-256；这属于
    本地化但有实际发布/供应链影响的变更，不适合 trivial。
  - 变更限制在 Multipass 示例的辅助脚本、示例配置入口和说明文档；不修改 sfo-deploy 的公共
    schema、CLI 或远端执行引擎，也未发现跨项目协调、持久 schema 迁移或回退冲突，暂不推荐 high-risk。
  - 主要风险是信任了错误的 project/app、静默覆盖有效配置，以及把非锁定/未锁定版本当成可部署版本；
    提案用显式参数、确认开关、原子写入和严格校验缓解。
- Proposal and tier confirmation: 用户已于 2026-09-04 明确确认本提案与 standard 层级。

## Background and Goal

当前 Multipass 示例的 `app_versions.yaml` 需要手工填写 version、filehub target 和 SHA-256。
用户希望在 `filehub.mynode.site:8443/eleph-server` 项目中获取最新的 `jx-server` 和 `jx-web` App
信息，并自动更新 Multipass 集群配置。

目标是新增一个 Deno 2 / TypeScript 辅助脚本：调用本机已安装、已登录的 `filehub` CLI
读取项目版本元数据，找到两个目标 App，生成符合 sfo-deploy v2 配置的 `provider: filehub`
条目，并原子写入指定集群的 `app_versions.yaml`。

## Scope

### In scope

- 在 `examples/eleph-server-multipass/scripts/update-filehub-app-versions.ts` 新增脚本。
- 不读取或传递 `FILEHUB_TOKEN`；认证与协议完全由 `filehub` CLI 的本地凭据管理。
- 默认服务器 `filehub.mynode.site:8443`、项目 `eleph-server`、集群根 `clusters`、集群 `multipass`。
- 运行 `filehub versions filehub.mynode.site:8443/eleph-server --format json`，解析其 JSON 输出；按
  `published_at` 选择最新版本。
- 校验 `jx-server` 与 `jx-web` 都存在于该版本，且 `sha256` 是 64 位十六进制、归档 size 大于
  0、版本名可作为目录名。
- 生成两个 `filehub` target：`<server>/eleph-server/<actual-version>/<app>`。
- 默认只打印将写入的 `version/target/hash/size`；传 `--write` 后用受限临时文件和 `rename`
  原子替换目标 `app_versions.yaml`。
- 在示例 `deno.json` 增加受限 Deno task，并在示例 README 补充使用与安全说明。
- 目标集群必须已有 `apps/jx-server` 与 `apps/jx-web` 定义；本任务不创建缺失的 App 定义。

### Out of scope

- 不下载或安装制品，不修改 `jx-server` / `jx-web` 的部署脚本。
- 不创建 `apps/jx-web`、Nginx 环境或 cluster schema 变更；这些属于现有 `013-add-nginx-jx-web`
  提案的范围。
- 不实现语义化版本排序；完全使用 filehub 定义的 `latest`（最近创建版本）。
- 不改变 sfo-deploy 的 YAML 校验、包缓存或 filehub provider 实现。
- 不处理 filehub 登录；用户需先用 `filehub login` 建立本地凭据。

### Boundary with neighboring modules

- 本任务只负责部署前元数据生成；实际下载和哈希复验仍由 `sfo-deploy fetch/deploy` 完成。
- filehub 服务负责返回版本与 App 元数据；脚本不绕过其认证或锁定语义。
- Multipass 示例负责提供入口和说明；框架仓库的其他模块保持不变。

## Requirement Review

需求合理，且不需要另开 API/token 通路：`filehub versions ... --format json` 已返回
`version`、`published_at`、锁定状态和每个 App 的 `sha256`、`size`。凭据由 filehub CLI
自己管理，脚本只消费其 JSON 输出。

选择“默认 dry-run，显式 `--write`”是因为脚本会覆盖部署输入。这样用户可以先核对版本、hash 和
target，再写入配置。脚本只更新指定的 `clusters/multipass/app_versions.yaml`，不改
`cluster-template/app_versions.yaml`，避免把某个时刻的最新版本固定成模板默认值。实际下载仍由
`sfo-deploy fetch` 触发，其 filehub provider 会调用同一个 CLI 并复验哈希。

## Proposal Items

| proposal_id | change_id                    | requirement                                                                              | boundary                                                  | tradeoff                                   | success_evidence                                       | non_goal         |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ | ---------------- |
| P-001       | CHG-filehub-app-version-sync | 新增 TypeScript 脚本，调用 filehub CLI 读取 latest 元数据并生成 jx-server 和 jx-web 配置 | 只消费 `filehub versions --format json`；不实现登录或上传 | 依赖 filehub 元数据，换取避免手工复制 hash | `deno check`/`deno lint` 通过，并完成接口约定的窄验证  | 不下载制品       |
| P-002       | CHG-filehub-app-version-sync | 提供默认 dry-run 与显式 `--write`，原子更新集群 app_versions.yaml                        | 只写目标集群；不覆盖模板                                  | 增加一步确认，降低覆盖错误配置的风险       | 干跑输出包含版本/target/hash；写入失败时不产生半写文件 | 不自动部署       |
| P-003       | CHG-filehub-app-version-sync | 提供 Deno task 与 README 说明，固定子进程权限边界                                        | filehub 凭据由其 CLI 管理；脚本不接触 token               | 只授予 `filehub` 运行权限，降低误用面      | 示例 task 可执行；文档说明先登录与供应链边界           | 不实现交互式登录 |

## Success Criteria

- Concrete user-visible or system-visible result: 用户可运行新增 Deno task，先看到两个 App 的
  filehub target、版本、SHA-256 和大小；确认后传 `--write`，目标集群的 `app_versions.yaml`
  包含两个可直接被 `sfo-deploy fetch` 消费的条目。
- Required evidence: `deno check` 和 `deno lint` 通过；针对 dry-run、latest 缺失 App、非法
  hash、不写文件与 `--write` 原子落盘的窄验证通过；`sfo-deploy validate` 可接受生成的配置
  结构（在配置允许时）。
- Explicit non-goals: 不验证制品内容、不执行部署、不排序历史版本、不修改框架公共契约。

## Risks

- filehub 的 `latest` 是“最近创建的版本”，不一定是最高语义化版本；文档必须明确该语义。
- 当前 Multipass 示例还没有 `apps/jx-web` 定义。脚本可以先独立验证，但完整
  `sfo-deploy validate/fetch` 需要 `013-add-nginx-jx-web` 或其他已确认变更先补齐该定义。
- 未锁定版本仍可能被服务端更新；脚本可显示锁定状态，但无法保证后续制品不变。
- filehub CLI 的本地凭据负责认证；脚本不得读取、显示、迁移或修改凭据文件。
- 脚本来自本地仓库，filehub 返回的 hash 是部署信任链的一环；运行者仍需选择可信 filehub
  实例，必要时独立核对 hash。
- 当前工作区已有大量未提交迁移改动，实施必须只改本提案声明的新脚本、示例 task/README 与
  本任务文档，避免混入无关变更。

## Unresolved Questions

无。默认采用 filehub 的 `latest`（最近创建版本）、默认 dry-run、显式 `--write`、仅更新
`clusters/multipass/app_versions.yaml`。如需改成最高语义化版本、默认写入或同步模板，请在确认时
说明。
