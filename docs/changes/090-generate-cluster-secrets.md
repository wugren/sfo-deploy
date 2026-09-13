# Multipass 集群密钥随机值生成脚本

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/090-generate-cluster-secrets/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/090-generate-cluster-secrets/proposal.md
- Affected paths: examples/eleph-server-multipass/scripts/generate-cluster-secrets.ts（新增）、
  examples/eleph-server-multipass/deno.json（新增 `generate-cluster-secrets` 任务与
  `no-import-prefix` lint 豁免）、examples/eleph-server-multipass/README.md（第 1 节）、
  tests/unit/generate_cluster_secrets.test.ts（新增）；运行时还生成未跟踪的
  examples/eleph-server-multipass/clusters/multipass/secrets.yaml
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

新增自包含 Deno 2 脚本，读取 `clusters/multipass/cluster.yaml` 顶层 `secrets` 声明，为
`kind: value` 密钥生成 32 字节 CSPRNG 随机值的 64 位小写十六进制文本（`--length` 可在 8–64 字节
之间调整），默认 dry-run 且从不打印秘密值；`--write` 用同目录临时文件加 rename 原子写入
`clusters/multipass/secrets.yaml`，POSIX 上权限固定 0600。目标已存在时拒绝覆盖，只有 `--force`
才先写 `secrets.yaml.bak.<UTC 时间戳>`（0600）备份再替换；声明存在 `kind: file` 密钥时 `--write`
失败关闭且不写任何文件。脚本使用 `jsr:` 直接导入 `@std/yaml`/`@std/path`，因此示例 `deno.json`
补上与仓库根一致的 `no-import-prefix` lint 豁免，保证仓库级单测可以直接导入该脚本（无 import map
依赖），也沿用 `update-filehub-app-versions.ts` 的纯函数导出与 dry-run/`--write` 约定。

## Risk Screen

- Public contract, protocol, or CLI change: no（未触及 sfo-deploy CLI、schema 与远端执行器）
- Persistent data, schema, or migration change: no（只生成被忽略的本地秘密来源文件）
- Security, privacy, or trust-boundary change: yes（生成真实本地凭据；已按提案用 0600、默认
  dry-run、拒绝覆盖、`--force` 备份、不打印秘密值与最小 Deno 权限缓解，不构成生产信任边界变化）
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no（新增仅本机脚本依赖
  `@std/yaml` 1.2.0 / `@std/path` 1.1.6，均为仓库既有锁定版本）
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

## Verification

- Targeted check: `deno task test`（仓库全量 340 项，含本任务 9 项新单测）、根 `deno task check`/
  `deno task lint`/`deno task fmt` 与示例 `deno task check`；真实运行
  `deno task generate-cluster-secrets`（dry-run 与 `--write`）后检查文件权限、键集合、值格式与重复
  写入拒绝，并用框架 `loadCluster`/`loadClusterSecretSource`/`resolveSecretsForMachine` 本地装载验证；
  另在 /tmp 隔离目录验证文件密钥失败关闭、`--length` 与 `--force` 备份轮换语义
- Result: pass
- Residual risk or follow-up: 未在 Windows 上执行（0600 语义仅 POSIX 生效，README 已说明）；
  `kind: file` 密钥仍需人工准备来源路径；未运行 secrets-deploy/SSH/deploy，远端漂移与本机生成的
  秘密是否已投递需由用户在获授权的部署流程中确认
