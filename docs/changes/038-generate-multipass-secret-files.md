# 生成 Multipass 示例本地秘密

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  docs/versions/v0.1/modules/deployment-framework/038-generate-multipass-secret-files/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/deployment-framework/038-generate-multipass-secret-files/proposal.md
- Affected paths: examples/eleph-server-multipass/.env
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

按 `clusters/multipass/cluster.yaml` 的三个 `kind: value` 声明，生成强随机十六进制值并写入本地
`.env`。文件使用 `0600` 权限并被示例 `.gitignore` 排除；启动示例 CLI
前仍需用户手动加载。该方案保留示例绑定从环境变量读取值密钥的既有行为。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: yes
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

安全影响限于本地 Multipass
示例凭据：文件不属于版本控制，权限限制为所有者读写；生成、校验和检查过程不打印秘密明文，也不上传或部署。若用户已有同名
`.env`，提案明确要求拒绝覆盖。

## Verification

- Targeted check: 使用示例项目的 `SecretSettings.fromEnvironment()` 校验三项值的格式和长度；检查
  `0600` 权限、`.env` 被 `.gitignore` 忽略、仅包含三个预期变量，并比较 SSH
  私钥摘要与公钥指纹未变化。
- Result: pass
- Residual risk or follow-up: none
