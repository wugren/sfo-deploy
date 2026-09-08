---
task_manifest: task.yaml
status: approved
---

# Multipass 集群配置迁移到标准集群根目录提案

Risk profile: not-created

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries: 改动限于独立示例内部：两个 prepare
  入口的信任包发布目的地、示例 CLI 的配置根、忽略规则、文档与测试。集群 schema、部署框架 API、SSH
  信任语义和原子发布事务保持不变。主要风险是 secrets 因新路径进入版本库、旧信任包迁移错误，以及
  Bash/PowerShell
  行为分叉；这些都可以用针对性测试和紧凑风险筛查覆盖，未确认需要完整高风险分阶段生命周期。用户可替换为
  high-risk 以获得完整设计、测试与验收流程。
- Proposal and tier confirmation: 用户在当前会话回复“确认”，确认本提案、`standard`
  分级，以及默认目标集群根 `examples/eleph-server-multipass/clusters/multipass/`。

## Background and Goal

当前示例把生成的集群发布到 `examples/eleph-server-multipass/.state/clusters/multipass/`，示例 CLI
也绑定该配置根。虽然 `machines.yaml`
已位于这个生成集群目录的根部，但用户要求机器清单等集群配置位于项目标准的真实集群根布局中，即与框架文档一致的
`clusters/<cluster-name>/` 目录。

目标：两个 prepare
脚本把完整信任包（`cluster.yaml`、`machines.yaml`、`environments/`、`apps/`、`known_hosts`、`secrets/`、`bootstrap.json`）原子发布到
`examples/eleph-server-multipass/clusters/multipass/`，示例 CLI
从同一位置读取，且生成内容和敏感材料继续被 git 忽略。

## Scope

### In scope

- 将 `prepare-multipass.sh` 与 `prepare-multipass.ps1` 的集群发布目的地从
  `.state/clusters/multipass` 改为示例内标准集群根 `clusters/multipass`。
- 保留既有原子目录发布、prepare 互斥锁、staging/backup、失败恢复、未知实例拒绝接管、IP 与 host-key
  固定校验。
- 将 `eleph_server_deploy.cli` 的 `CONFIG_ROOT` 和 `KNOWN_HOSTS` 改绑到新的 `clusters` 根。
- 对已存在的完整旧版 `.state/clusters/multipass`
  信任包提供一次性受信迁移：仅当新集群根不存在且旧包结构完整时，先原子迁移再进入既有校验；不完整、歧义或校验失败一律失败关闭。
- 更新示例 `.gitignore`，确保生成的
  `clusters/`（含私钥、`known_hosts`、`bootstrap.json`、`machines.yaml`）不会进入版本库，并用测试验证忽略结果。
- 同步更新示例 README、Bash/PowerShell/CLI/E2E 相关测试中的路径与契约断言。

### Out of scope

- 不修改 `machines.yaml` / `cluster.yaml` / App / 环境 schema，不修改 `sfo-deploy` 通用框架 API。
- 不改变 Multipass 实例参数、cloud-init 注入、SSH 密钥算法、host-key 校验或 JAR 手工配置流程。
- 不把生成的集群配置提交进版本库，也不在 VM 内保存 `machines.yaml`。
- 不支持多集群、跨项目仓库根 `clusters/`，不重写历史任务文档。

### Boundary with neighboring modules

- 改动全部位于 `examples/eleph-server-multipass/`；`src/sfo_deploy`
  通用部署框架与仓库级文档布局保持不变。

## Requirement Review

该要求合理：框架的标准项目绑定模型是
`<project>/clusters/<cluster-name>/`，把机器清单放在该集群根下更符合真实项目结构，也消除示例与框架文档之间的布局差异。代价是生成集群仍必须整体保持
git-ignored（其中包含私钥、known_hosts 和环境相关
IP），并且需要安全迁移旧信任包，避免已有实例在改版后变成“未知实例”。

## Proposal Items

| proposal_id | change_id                  | requirement                                                                                                             | boundary                                         | tradeoff                                   | success_evidence                                                                           | non_goal                     |
| ----------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------- |
| P-001       | CHG-multipass-cluster-root | 两个 prepare 入口把完整生成集群发布到 `examples/eleph-server-multipass/clusters/multipass/`，`machines.yaml` 位于集群根 | 保留现有原子发布、锁、staging/backup 与失败恢复  | 与框架标准布局一致，但生成目录需保持忽略   | fake 成功流断言新路径下 `cluster.yaml`、`machines.yaml`、`known_hosts`、secrets 同修订发布 | 不改变集群 schema 或模板内容 |
| P-002       | CHG-multipass-cluster-root | 示例 CLI 从新的 `clusters` 配置根读取集群与 `known_hosts`                                                               | 仅改绑配置根，不新增 CLI 参数或行为              | 部署入口与发布位置一致                     | CLI contract 测试观察到新 config root，validate/plan 使用新位置                            | 不修改通用 `sfo-deploy` CLI  |
| P-003       | CHG-multipass-cluster-root | 旧版完整信任包一次性迁移到新根后再按既有规则校验                                                                        | 仅在新根不存在且旧包完整时迁移；其余情况失败关闭 | 增加少量迁移代码，换取已有可信环境平滑升级 | 迁移后可信重跑成功；不完整/歧义/身份不匹配负例失败关闭                                     | 不自动猜测或修复损坏状态     |
| P-004       | CHG-multipass-cluster-root | 生成集群与敏感材料在新路径下仍被 git 忽略                                                                               | 示例 `.gitignore` 明确覆盖 `clusters/`           | 配置不可提交，但避免泄露私钥/IP            | `git check-ignore` 覆盖私钥、known_hosts、machines.yaml、bootstrap.json                    | 不提供加密存储或密码库       |

## Success Criteria

- Concrete user-visible or system-visible result: 在示例目录成功运行任一 prepare
  入口后，`clusters/multipass/machines.yaml` 位于标准集群根并与 `cluster.yaml` 同级，包含实际 VM
  IPv4；`uv run eleph-deploy validate --cluster multipass` 从新根读取该集群。
- Required evidence: Bash/PowerShell fake 成功流与失败流测试通过；CLI contract
  测试通过；旧信任包迁移与拒绝接管负例通过；`git check-ignore`
  证明新路径下敏感与生成文件不会被跟踪；相关 README 路径更新。
- Explicit non-goals: 不执行真实 Multipass 创建/部署，不验证应用运行，不改变集群 schema 或通用框架。

## Risks

- 新路径若忽略规则不完整，私钥、`known_hosts` 或环境 IP 可能被提交；必须以测试固定。
- 旧包迁移必须在任何实例接管判断前完成结构检查，并在身份/IP/host-key 校验失败时保持失败关闭。
- staging 仍位于 `.state` 而目标位于 `clusters/`，需确认同一文件系统内目录 rename 的原子性假设。
- Bash 与 PowerShell 必须保持行为等价，避免单侧路径或迁移语义分叉。

## Unresolved Question

- 请确认目标集群根采用示例内
  `examples/eleph-server-multipass/clusters/multipass/`（本提案默认），而不是仓库根
  `clusters/multipass/` 或放入 VM 内部。
