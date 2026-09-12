# prepare 脚本不再从 cluster-template 整体重建集群

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/088-multipass-prepare-no-template-replace/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/088-multipass-prepare-no-template-replace/proposal.md
- Affected paths:
  - examples/eleph-server-multipass/prepare-multipass.sh
  - examples/eleph-server-multipass/prepare-multipass.ps1
  - examples/eleph-server-multipass/README.md
  - tests/contract/verify_environment_placement_config.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

- 两个 prepare 脚本（bash 与 PowerShell）去掉 `cluster-template` 的递归复制、重新生成 SSH
  身份与整目录原子发布路径，也不再承担首次引导；脚本要求 `clusters/multipass` 已存在。
- 复用 `clusters/multipass/secrets/id_ed25519(.pub)`：删除同名旧 VM → 用同一公钥经
  cloud-init 创建空白 VM → 读取新 IPv4 → 刷新 `known_hosts`、`machines.yaml`
  （`private_ip`）与 `bootstrap.json`（`ipv4`/`instance_name`），单文件临时文件 + `mv`
  原子替换 → 更新宿主机 hosts 记录。
- 保留严格校验（deno CLI `validate`，对既有集群目录执行）；保留删除失败 fail-closed。
- 删除失效死代码：模板树预检、staging 集群构造、整目录原子发布、旧状态迁移、残留备份拒绝。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

行为变化仅限两个本地示例脚本（宿主级准备工具）及其文档/契约断言；框架、schema、CLI 与
SSH 校验不变化。删除旧 VM 的破坏性语义保持不变。

## Verification

- Targeted check: `bash -n examples/eleph-server-multipass/prepare-multipass.sh` 通过；
  `pwsh` 全文件语法解析 `.ps1` 通过；stub 桩（multipass/ssh-keyscan/deno）临时目录端到端执行
  `.sh`，验证“既有集群要求 → info → delete --purge → launch → host key 扫描 → 刷新
  known_hosts/machines.yaml/bootstrap.json → deno validate → hosts 写回”的成功顺序，以及缺失
  集群状态、machines.yaml 与 bootstrap 记录不一致两条 fail-closed 路径；真实 CLI 以
  `--config-root .../clusters --cluster multipass` 对现有集群 validate 通过；业务文件
  app.yaml 在刷新前后哈希不变；`deno fmt`、`git diff --check`、示例 `deno task check`
  （`deno check --frozen src/**`）通过。
- Result: passed
- Residual risk or follow-up: 真实 Multipass 删除/创建与真实 hosts 权限交互不在本任务内验证；
  `.ps1` 以静态解析与人工核对为准（未在真实 Windows 宿主执行）。`tests/contract/
  verify_environment_placement_config.ts` 的 `docs`/`closure`/`v1-rejection` 模式在本工作树
  因既有未收尾改动（模板 environment 映射、schema1 移除契约、app v1 拒绝文案）在未触及本任务的
  断言处失败；本任务新增/更新的 `.sh`/`.ps1` 片段断言已独立逐项验证通过。