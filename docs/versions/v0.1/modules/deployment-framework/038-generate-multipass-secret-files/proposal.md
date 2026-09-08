---
task_manifest: task.yaml
status: approved
---

## Workflow Tier Judgment

- Proposed tier: `standard`
- Final tier: standard
- Tier rationale: 任务影响集中在 Multipass
  示例的本地秘密准备，但涉及真实凭据/令牌的生成、存储权限与泄漏边界，因此不满足 `trivial`
  的“无安全/隐私影响”条件；它不修改公共
  CLI、部署行为或示例代码，也未确认存在生产或跨系统回滚影响，推荐 `standard`。
- Confirmation statement: 用户已于 2026-09-04 明确确认所显示的提案和 `standard` 层级。

## Background and Goal

`examples/eleph-server-multipass/clusters/multipass/cluster.yaml` 声明了三个 `kind: value`
的密钥：`ELEPH_DB_PASSWORD`、`ELEPH_REDIS_PASSWORD` 和
`ELEPH_TOKEN_SECRET`。当前示例约定这三个值通过 `SecretSettings.fromEnvironment()`
从进程环境读取，CLI 不会自动加载
`.env`。目标是为该集群生成一套对应的本地秘密配置，避免继续使用空占位值。

## Scope

### In scope

- 创建未纳入版本控制的 `examples/eleph-server-multipass/.env`。
- 按示例约束生成三项强随机十六进制秘密：数据库和 Redis 密码各 48 个十六进制字符，token 密钥 64
  个十六进制字符。
- 将 `.env` 权限设置为 `0600`，避免组和其他用户读取。
- 使用示例绑定入口的校验规则验证三项秘密格式，不打印秘密明文。

### Out of scope

- 不覆盖或重新生成 `clusters/multipass/secrets/id_ed25519` 和 `id_ed25519.pub`；它们已经是集群生成的
  SSH 信任材料。
- 不修改 `cluster.yaml`、`SecretSettings`、CLI 或部署流程。
- 不把示例 CLI 改成自动读取 `.env`。
- 不运行 `secrets-deploy`，也不通过 SSH 连接或改动 Multipass VM。
- 不把秘密值写入版本控制、日志、提案或完成报告。

### Neighboring boundary

若用户后续希望以本地文件绑定文件密钥，需要先修改集群声明或通过项目绑定的 `fileSecrets`
传入；当前声明不支持把这三个值密钥当作文件密钥处理。

## Requirement Review

请求合理：三个应用密钥确实是部署前必需的本地秘密来源。但“密钥文件”不应理解为在本地生成 `ELEPH_*`
文件密钥；当前集群声明它们为 `value` 密钥，示例绑定从环境变量读取。因此建议生成受保护的 `.env`
作为本地持久化形式，用户启动 CLI 前在 shell 中显式加载。这样满足请求，同时不扩大示例行为或混淆
`value` 与 `file` 密钥语义。

## Proposal Items

| proposal_id | change_id                | Requirement / 要求                                                                                                                | Success Evidence / 成功证据                                                                                                            |
| ----------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1        | CHG-multipass-secret-env | 为 Multipass 示例创建受保护的本地 `.env`，内含三个符合绑定校验格式的随机秘密；不覆盖既有 SSH 密钥，不修改部署代码，不提交秘密值。 | `SecretSettings.fromEnvironment()` 格式校验、0600 权限、`.gitignore` 匹配与 SSH 密钥完整性检查通过；秘密明文不出现在输出或版本控制中。 |

## Success Criteria

- `examples/eleph-server-multipass/.env` 存在且权限为 `0600`。
- 文件包含 `ELEPH_DB_PASSWORD`、`ELEPH_REDIS_PASSWORD` 和 `ELEPH_TOKEN_SECRET` 三个赋值行。
- 三个值分别匹配示例绑定要求的正则格式：密码 48 个十六进制字符，token 64 个十六进制字符。
- 不打印、不复制、不记录秘密明文；仅报告文件名、变量名和格式验证结果。
- `clusters/multipass/secrets/id_ed25519` 的内容、公钥指纹和集群 SSH 信任状态不变。

## Risks

- 秘密持久化在本地文件中存在读取或意外复制风险；通过 `.gitignore`、0600 权限、不输出明文来降低。
- 如果用户已有 `.env`，覆盖会丢失凭据；执行前必须先检查，若存在则不自动覆盖，向用户确认备份或跳过。
- 用户可能期望生成的是 SSH 私钥；实际 SSH 密钥已存在，重新生成会破坏当前 Multipass 集群的 SSH 信任。
