---
task_manifest: task.yaml
status: approved
confirmed_by: user
confirmation_at: 2026-09-13
---

# 提案：Multipass 集群密钥随机值生成脚本

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries:
  - 变更限制在 Multipass 示例项目的本地辅助脚本、示例任务入口、说明文档和对应单测；不修改
    sfo-deploy 的集群 schema、CLI、远端执行器或部署行为，也没有跨项目协调和持久数据迁移。
  - 命中 `security` 触发条件（秘密/令牌、`**/*secret*` 路径）与 `contract-protocol` 的
    文档敏感面：脚本会生成并落盘真实凭据。风险限于本机集群目录，用 0600 权限、默认 dry-run、
    拒绝覆盖、`--force` 备份、不打印秘密值和最小 Deno 权限缓解；与既有同类任务（038、043）
    的分级一致，推荐 `standard`。
  - 若用户希望按 high-risk 走完整设计/测试/验收生命周期，可在确认时选择 high-risk。
- Proposal and tier confirmation: 用户于 2026-09-13 17:54 (CST/HKT) 确认本提案与 `standard`
  层级，并按确认请求中的建议默认解决两个待定问题（统一 32 字节值长度、实施时直接生成当前集群的
  `secrets.yaml`）；确认授权实施、验证、独立缺陷审查与收尾。

## Background and Goal

`examples/eleph-server-multipass/clusters/multipass/cluster.yaml` 声明了三个 `kind: value`
密钥：`ELEPH_DB_PASSWORD`、`ELEPH_REDIS_PASSWORD`、`ELEPH_TOKEN_SECRET`。真实来源是未提交的
`clusters/multipass/secrets.yaml`（权限必须为 `0600`，顶层键直接对应声明名），目前该文件并不存在，
README 第 1 节只给出手工填写的示例值，用户需要自己生成强随机十六进制字符串。

目标是提供一个可复用的 Deno 2 / TypeScript 脚本，读取集群的 `secrets` 声明，为 `kind: value`
密钥生成密码学安全的随机值并写入受保护的 `secrets.yaml`，替代手工生成和粘贴。

## Scope

### In scope

- 新增 `examples/eleph-server-multipass/scripts/generate-cluster-secrets.ts`：
  - 解析 `clusters/multipass/cluster.yaml` 的顶层 `secrets` 映射（`@std/yaml`，禁止重复键），
    校验密钥名符合 `^[A-Z][A-Z0-9_]*$`、每条声明的 `kind` 只能是 `value` 或 `file`。
  - `kind: value`：使用 `crypto.getRandomValues` 生成随机字节，渲染为小写十六进制值；默认 32 字节
    （64 个十六进制字符），可用 `--length <bytes>`（8–64）覆盖。
  - `kind: file`：本脚本不生成文件内容；只要声明中存在文件密钥，`--write` 就失败关闭并列出需要人工
    提供来源路径的密钥名，不写半成品 `secrets.yaml`（框架要求来源覆盖全部声明键）。
  - 默认 dry-run：只打印目标路径、将生成的密钥名/类型/长度和文件是否存在，不打印任何秘密值。
  - `--write`：以同目录临时文件 + `rename` 原子写入 `clusters/multipass/secrets.yaml`，权限
    `0600`；目标已存在时拒绝覆盖，只有显式 `--force` 才先把旧文件备份为
    `secrets.yaml.bak.<UTC 时间戳>`（同为 `0600`）再替换。
  - 导出纯函数（选项解析、声明解析、值生成、渲染、原子写入）供单测直接调用，随机源可注入。
- 在示例 `deno.json` 增加任务 `generate-cluster-secrets`，权限固定为
  `--allow-read=clusters/multipass --allow-write=clusters/multipass`（无网络、无子进程、无环境读取）；
  如添加 `@std/yaml` 导入映射，同步更新示例 `deno.lock`。
- 在示例 README 第 1 节补充该任务的用法、覆盖保护/备份语义、文件密钥需人工准备和“不打印秘密值”说明，
  并把示例值统一为脚本默认的 64 个十六进制字符（框架只要求值非空，旧 48 字符值仍合法）。
- 新增 `tests/unit/generate_cluster_secrets.test.ts`：覆盖声明解析（合法/非法名/非法 kind/重复键/
  缺失 `secrets`）、值格式与长度、注入随机源的确定性、文件密钥失败关闭、选项解析、dry-run 不写文件、
  拒绝覆盖、`--force` 备份、`0600` 权限与原子写入。
- 实施时对本机 `clusters/multipass` 执行一次 `--write`（当前不存在 `secrets.yaml`，不会覆盖任何数据），
  生成 0600 的真实本地秘密文件；验证时不打印秘密值。

### Out of scope

- 不运行 `secrets-deploy`、不建立 SSH 连接、不运行 `prepare`/`deploy`/`fetch` 或任何远端操作。
- 不修改 `cluster.yaml` 的密钥声明、机器放置，不生成或替换 `secrets/id_ed25519*` SSH 身份材料。
- 不修改 sfo-deploy 的 CLI、schema、校验规则、秘密装载实现或示例 `src/` 代码。
- 不实现秘密轮换、加密存储、vault 集成，不把秘密值写入版本控制、日志、报告或测试夹具。
- 不为 `kind: file` 密钥生成文件内容或路径。

### Boundary with neighboring modules

- 脚本只负责本地秘密来源文件的生成；秘密投递仍由通用 CLI 的 `secrets-deploy` 负责，示例
  `clusters/multipass` 与 sfo-deploy 框架的契约不变。
- 集群声明（`cluster.yaml`）仍由框架维护为唯一声明点，脚本只是消费者，不改变 schema 语义。

## Requirement Review

请求合理且与框架契约一致：框架对 `kind: value` 只要求非空字符串，长度由示例约定决定，因此脚本
统一默认 32 字节（64 个十六进制字符）即可覆盖既有密码与令牌，避免按密钥名做魔法分支；如需保留
README 旧的 48 字符密码约定，可在确认时改成按名配置。

选择“默认 dry-run + 显式 `--write` + 拒绝覆盖 + `--force` 备份”是因为目标文件存放真实凭据：先预览
再落盘能避免误覆盖既有秘密，`--force` 备份保证轮换前的值可回退。脚本从不打印秘密值，避免终端回滚
缓冲、CI 日志或工单记录泄漏；原子替换避免半写文件被当作有效秘密来源。

`kind: file` 密钥的失败关闭是刻意的：随机内容对 TLS/服务账号密钥没有意义，且框架要求
`secrets.yaml` 覆盖全部声明键，静默跳过会生成不可用来源。

## Proposal Items

| proposal_id | change_id                    | requirement                                                                                                   | boundary                                                     | tradeoff                                                     | success_evidence                                                                                                     | non_goal                     |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| P-001       | CHG-multipass-secret-generator | 新增脚本读取 `clusters/multipass/cluster.yaml` 的 `secrets` 声明，为 `kind: value` 生成强随机十六进制值     | 只读声明文件与只写集群目录；不改 schema 与框架代码           | 统一 32 字节默认值，换取无按名特例的简单语义                 | 单测覆盖解析、格式与长度、注入随机源、dry-run 行为；`deno check`/`lint`/`fmt` 通过                                   | 不修改集群声明               |
| P-002       | CHG-multipass-secret-generator | `--write` 以 0600 原子写入 `secrets.yaml`；已存在时拒绝覆盖，`--force` 先备份                                 | 仅写 `clusters/multipass/secrets.yaml` 与其备份文件           | 显式 `--force` 与备份文件增加一次操作，换取凭据可回退         | 单测验证拒绝覆盖、备份文件名与权限、临时文件清理；真实运行生成 0600 文件                                             | 不自动轮换或上传秘密         |
| P-003       | CHG-multipass-secret-generator | 文件密钥失败关闭；`secrets.yaml` 必须覆盖全部声明键                                                            | 只为 `kind: value` 生成值，文件密钥交回人工                  | 需要人工补齐文件密钥时脚本返回非零，牺牲一次自动化            | 单测覆盖 `kind: file` 失败关闭且不产生半写文件                                                                       | 不生成文件密钥内容           |
| P-004       | CHG-multipass-secret-generator | 示例 `deno.json` 任务与 README 说明同步更新，固定最小权限与不打印秘密值的约定                                  | 只改示例入口与文档；权限限定在 `clusters/multipass`           | 文档需维护新任务说明，换取可重复的生成流程                    | 示例任务可执行且权限最小；README 描述与脚本行为一致                                                                  | 不改变其他示例命令           |

## Success Criteria

- Concrete user-visible or system-visible result: 在 `examples/eleph-server-multipass` 运行
  `deno task generate-cluster-secrets` 会列出三个待生成密钥与目标路径且不写文件；运行
  `deno task generate-cluster-secrets --write` 后，`clusters/multipass/secrets.yaml` 存在、权限
  为 `0600`，包含 `ELEPH_DB_PASSWORD`、`ELEPH_REDIS_PASSWORD`、`ELEPH_TOKEN_SECRET` 三个键，
  值为 64 个小写十六进制字符，且终端不出现秘密值。
- Required evidence: `deno test --allow-read --allow-write --allow-env tests/unit/generate_cluster_secrets.test.ts`
  通过；示例 `deno check`（脚本与项目入口）通过；`deno lint`/`deno fmt --check` 通过；真实
  `--write` 后检查文件名/键集合/权限/值格式（不打印值）并通过 `git check-ignore` 确认该文件仍未被
  版本控制跟踪；重复 `--write` 被拒绝。
- Explicit non-goals: 不执行远端部署与秘密投递，不验证远端漂移，不生成 SSH 身份，不实现轮换。

## Risks

- 生成的凭据是真实秘密：通过 0600、Git 忽略、绝不打印值、默认 dry-run 和失败关闭降低泄漏面。
- 覆盖已有 `secrets.yaml` 会导致旧凭据丢失：默认拒绝覆盖，`--force` 先写 0600 备份并打印备份路径。
- 文件密钥被静默跳过会产出不可用来源：`--write` 遇到文件密钥直接非零退出。
- Windows 上 `chmod` 语义有限：0600 主要在 Linux/macOS 生效，README 明确该差异。
- 若用户实际需要保留旧的 48 字符密码约定，需要按名配置长度；本提案按统一默认提交，可在确认时修改。

## Resolved Questions

1. 默认值长度：采纳建议，统一 32 字节（64 个十六进制字符），README 示例同步更新；不实现按名策略。
2. 实施时对当前 `clusters/multipass` 执行一次 `--write`：采纳建议执行（当前不存在 `secrets.yaml`，
   不会覆盖数据），生成 0600 的真实本地秘密文件；验证过程不打印秘密值。
