---
task_manifest: task.yaml
status: approved
---

# 下载版本文件支持 filehub 提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries:
  - 新增内置 `filehub` 下载 provider 与 `package.source`
    形态，属于面向项目部署配置的公开扩展契约，命中 contract-protocol 边界。
  - 下载路径将启动外部 `filehub`
    客户端并依赖其本地凭据、网络行为、退出码和原子落盘语义，属于部署执行期间的运行时集成，命中
    runtime-integration 边界。
  - 实现必须明确处理客户端缺失、子进程失败、部分文件、目标覆盖、大小限制和框架二次哈希校验；这些失败边界会直接影响部署是否安全继续，因此建议使用完整设计、测试和独立验收流程。
- Proposal and tier confirmation: 用户回复“确认，自动完成”，确认本提案、`high-risk`
  层级，并显式授权从 design 开始自动完成 implementation、testing 与 acceptance，跳过逐阶段用户确认。

## Background and Goal

当前 `sfo-deploy` 内置 `http`/`https` 下载 provider，也允许项目注入自定义 provider，但不能直接从
filehub 项目版本拉取应用归档。filehub 已提供
`filehub pull <server/project/version/name> <输出文件路径>`
命令，并在客户端内部完成认证、下载、SHA-256 校验和原子落盘。

目标：让部署配置可以选择内置 `filehub` provider 下载版本文件；框架调用本机已登录/已配置的 filehub
客户端完成拉取，并继续执行框架既有的独立哈希与大小校验。如果本机没有安装 `filehub`
命令，向用户提供清晰的安装提示和官方安装文档入口，而不是报告模糊的未知 provider 或进程启动错误。

参考实现与命令契约来自 [wugren/sfo-filehub](https://github.com/wugren/sfo-filehub) 当前 `main`
分支（检查时提交 `1931c789f4733d17f6455c22b0aa9af2eb873120`）的
`README.md`、`cli/README.md`、`install-cli.sh`、`install-cli.ps1` 和 `filehub pull` 实现。

## Scope

### In scope

- 在默认 `DownloadProviderRegistry` 中注册 `filehub` provider，使应用 deploy 与环境 install
  的既有包下载链路都可通过 `provider: filehub` 使用。
- 定义最小配置契约：`package.source` 仅接受非空 `target`，值采用 filehub 的
  `<server/project/version/name>` 目标串；认证和服务器配置继续由 filehub 客户端自身的默认配置或
  `FILEHUB_*` 环境变量负责。
- 使用参数数组直接执行 `filehub pull <target> <destination>`，不经过
  shell；保留既有“目标不得已存在”约束。
- 将客户端未安装单独识别为可操作的 `DownloadError`，提示安装 `filehub`
  并链接官方仓库安装说明，同时覆盖 Linux/macOS 与 Windows 的入口说明。
- 将 filehub
  非零退出、无法创建工件、异常工件、超限或哈希不匹配映射为下载失败；失败时尽力清理目标文件，成功后仍由
  `sfo-deploy` 独立校验普通文件、最大字节数和配置声明的哈希。
- 增加单元测试和必要的集成/契约测试，覆盖命令构造、缺失客户端、退出码/错误信息、成功下载、失败清理、大小与哈希二次校验。
- 在 README 增加 filehub 配置示例、登录前置条件、客户端缺失提示与官方安装入口。

### Out of scope

- 不自动下载、安装或升级 filehub 客户端，也不在运行时执行远程安装脚本。
- 不在 `sfo-deploy` 内实现 filehub HTTP API、登录、token 管理或凭据存储。
- 不修改 `sfo-filehub` 仓库、服务端协议、CLI 命令面或发布流程。
- 不允许在部署 YAML 中保存 filehub 密码、token 或会话；本次也不新增 `source.config`
  路径字段，调用方可使用 filehub 默认配置或 `FILEHUB_CONFIG` 环境变量。
- 不改变现有 `http`/`https` provider、项目自定义 provider 注入或远端脚本的包处理方式。

### Boundary with neighboring modules

- 主要边界位于 `src/sfo_deploy/downloads.py` 的内置 provider/注册表、相关测试与
  README；配置加载器继续把经过顶层结构校验的 `source` 映射交给 provider 做专属字段校验。
- filehub 客户端拥有认证、服务端选择、网络下载和内部 SHA-256/归档校验；`sfo-deploy` 拥有 provider
  选择、目标生命周期、最大大小与配置声明哈希的独立最终校验。

## Requirement Review

需求合理，并能复用现有 provider 扩展边界。直接调用官方 CLI 比在框架内复制 filehub API
与认证逻辑更小，也能沿用用户已经完成的 `filehub login` 与凭据存储。

关键取舍是新增外部命令依赖。方案不自动安装客户端，不把凭据放进命令行或
YAML；缺少命令时提供明确安装指引。调用使用 argv 而非 shell，目标串不会被解释为 shell 语法。filehub
成功后仍执行框架自己的文件类型、大小和声明哈希校验，避免把部署完整性边界完全委托给外部进程。

## Proposal Items

| proposal_id | change_id            | requirement                                                                                                                   | boundary                                                       | tradeoff                                       | success_evidence                                                     | non_goal                            |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| P-001       | CHG-filehub-download | 内置支持 `provider: filehub`，以 `source.target` 表示 `<server/project/version/name>`，调用 `filehub pull` 下载到框架目标路径 | filehub 负责认证/拉取，sfo-deploy 负责 provider 契约与最终校验 | 引入本机 CLI 依赖，换取复用官方认证与下载语义  | provider/注册表测试证明默认可解析，argv 与目标路径准确且不经过 shell | 不嵌入 filehub API 客户端           |
| P-002       | CHG-filehub-download | `filehub` 命令缺失时给出明确安装提示与官方安装入口                                                                            | 只提示，不自动安装                                             | 用户需先完成安装与登录                         | 缺失命令测试验证错误类型、中文提示、命令名和安装链接                 | 不管理 filehub 版本或凭据           |
| P-003       | CHG-filehub-download | 外部命令失败或工件不满足要求时安全失败并清理，成功后执行框架既有大小/哈希二次校验                                             | 不改变 HTTP/自定义 provider 语义                               | 双重校验增加一次本地读取，但保持统一完整性边界 | 测试覆盖非零退出、无输出、异常/超限/哈希错误和清理结果               | 不信任 CLI 成功退出即代表部署包可用 |
| P-004       | CHG-filehub-download | README 说明配置、安装与登录前置条件                                                                                           | 文档不复制 filehub 全部命令手册                                | 保持最小可操作说明，并链接上游真相源           | 文档示例与自动化契约一致                                             | 不维护 filehub 服务端部署教程       |

## Success Criteria

- Concrete user-visible or system-visible result: 部署包声明 `provider: filehub` 与合法
  `source.target` 后，`sfo-deploy` 能通过已安装、已配置凭据的 `filehub pull`
  获得版本归档，再沿用现有上传与脚本执行链路；缺少客户端时，命令在下载阶段以下载错误退出并明确告诉用户如何安装。
- Required evidence: 自动化测试覆盖默认注册、严格 source 校验、安全
  argv、成功拉取、客户端缺失、外部失败、目标/临时文件清理、大小限制与哈希不匹配；现有 HTTP 和自定义
  provider 测试继续通过；README 示例与实现一致。
- Explicit non-goals: 不自动安装、不新增凭据字段、不实现 filehub API、不改变现有 provider
  与远端执行语义。

## Risks

- 外部进程生命周期：网络阻塞、信号/取消、超时和非零退出需要在设计阶段明确；不能让残留子进程或部分文件被误认为有效工件。
- 凭据边界：filehub 读取本地配置和环境变量；错误信息需要可诊断，但不得回显 token、密码或会话内容。
- 上游兼容：当前依赖 `filehub pull`
  的目标串和精确输出路径契约；设计需记录所检查的上游提交与兼容假设。
- 完整性：filehub 内部 SHA-256 来自服务端元数据，而 sfo-deploy
  的期望哈希来自部署配置；两层校验必须都成功，且失败后不得留下可复用的目标文件。
- 平台差异：命令发现与错误提示需兼容 POSIX 和 Windows；测试不依赖真实 filehub 服务或用户凭据。

## Unresolved Questions

- 无。默认采用最小 `source.target` 契约；如需为单个包显式指定 `--config`，可作为后续独立需求评估。
