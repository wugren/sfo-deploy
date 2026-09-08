# Multipass 集群信任包迁移到标准集群根目录

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  `docs/versions/v0.1/modules/deployment-framework/007-multipass-cluster-root/task.yaml`
- Approved proposal:
  `docs/versions/v0.1/modules/deployment-framework/007-multipass-cluster-root/proposal.md`
- Affected paths:
  `examples/eleph-server-multipass/prepare-multipass.sh`、`prepare-multipass.ps1`、`src/eleph_server_deploy/cli.py`、`.gitignore`、`README.md`、`tests/**`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- 两个 prepare 入口的集群根从 `.state/clusters` 改为示例内标准集群根
  `clusters/`，完整信任包（`cluster.yaml`、`machines.yaml`、`environments/`、`apps/`、`known_hosts`、`secrets/`、`bootstrap.json`）仍以单个目录原子发布到
  `clusters/multipass/`；`machines.yaml` 位于集群根，与 `cluster.yaml` 同级。
- 新增一次性受信迁移：仅当新集群根不存在且旧 `.state/clusters/multipass`
  是非符号链接的完整目录时，在取得 prepare 互斥锁后将其整体移动（同一文件系统
  rename）到新根；新、旧位置同时存在、旧位置为符号链接或非目录时一律失败关闭，不自动猜测或修复。
- 示例 CLI 的 `CONFIG_ROOT` / `KNOWN_HOSTS` 改绑到新的 `clusters`
  根，`load_cluster`/`ParamikoTransport` 消费者行为不变。
- 示例 `.gitignore` 增加 `clusters/`，生成的配置、环境依赖 IP、私钥和 `known_hosts`
  保持不被跟踪；`.state/` 仅保留锁、staging 与 E2E 证据。
- Bash 与 PowerShell 保持相同路径语义；README
  与全部相关测试随新路径更新，并新增迁移、歧义、非法旧路径、旧备份和 git 忽略覆盖测试。

## Risk Screen

- Public contract, protocol, or CLI change: yes
  - `sfo-deploy` 通用框架 CLI 不变；仅示例自带的 `eleph-deploy` 绑定配置根从 `.state/clusters` 移到
    `clusters`。public contract 指框架层，答案为 no；此行为变化在 Approach 中记录。
- Persistent data, schema, or migration change: yes
  - 旧版完整信任包在锁内一次性迁移；迁移前不读取/修改，迁移目标存在时保持旧位置，歧义或无效状态失败关闭。schema/版本号不变。
- Security, privacy, or trust-boundary change: yes
  - 信任包发布位置变更，且生成目录需保持忽略。证据：`git check-ignore` 对
    `clusters/multipass/{machines.yaml,known_hosts,bootstrap.json,secrets/id_ed25519}` 均命中
    `clusters/`；测试断言 `.gitignore` 条目。
- Concurrency, lifecycle, or runtime integration change: yes
  - 迁移在原有 `mkdir` 互斥锁内执行，避免与另一个 prepare 进程交错；示例 CLI
    配置根变更后，`validate` 实测从新根读入集群（通过 preflight 到制品占位校验）。
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

## Verification

- Targeted check:
  - `bash -n` 与 Python 3.11 语法检查通过；
  - 示例测试套件通过（96 项，1 项环境条件 skip；2 项 PowerShell 语法/密钥生成测试因本机无 `pwsh`
    保持既有环境失败列为 manual gap，未随本次改动引入）；
  - 仓库根 `sfo-deploy` 测试全量通过（62 项）；
  - `eleph-deploy validate --cluster multipass` 从新 `clusters/` 根进入制品占位校验（预期 preflight
    失败），证明配置根绑定生效；
  - `git check-ignore` 覆盖生成集群中的配置、私钥与 `known_hosts`。
- Result: passed
- Residual risk or follow-up: 本机无 PowerShell 运行时，`prepare-multipass.ps1`
  的解析与空格路径回归需在 Windows/pwsh 环境补充；真机 Multipass E2E 仍受任务环境限制未执行。
