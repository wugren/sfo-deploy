# 删除 App 顶层秘密声明并收敛为 cluster.yaml.secrets 唯一声明点变更记录

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/049-drop-app-secret-declaration/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/sfo-deploy/049-drop-app-secret-declaration/proposal.md
- Design: docs/versions/v0.1/modules/sfo-deploy/049-drop-app-secret-declaration/design.md
- Risk profile:
  docs/versions/v0.1/modules/sfo-deploy/049-drop-app-secret-declaration/risk-profile.yaml
- Affected paths:
  - `src/types.ts`
  - `src/config.ts`
  - `src/planning.ts`
  - `tests/_support/fixtures.ts`（核查：无需变更）
  - `tests/unit/app_management_config.test.ts`
  - `tests/unit/secrets_deploy_config.test.ts`
  - `tests/unit/history.test.ts`
  - `tests/fixtures/history/legacy-v3-secret-field-names.json`
  - `tests/contract/verify_app_management_contract.ts`（核查：收敛后断言仍成立，无需变更）
  - `README.md`
  - `docs/guides/sfo-deploy-cluster-configuration.md`
  - `docs/changes/049-drop-app-secret-declaration.md`
- Explicit tier override: none（用户确认 high-risk 并授权自动完成全生命周期，Q1=A
  方案、Q2=环境定义一并移除、Q3=v3 内收窄）
- Expanded high-risk packet: existing task packet 049-drop-app-secret-declaration

## Approach

- 装载面：app.yaml 与环境定义顶层的 `secret_values`/`secret_files` 字段移除，装载即定向拒收
  （`fields()` 白名单之前），文案为
  `${label} 的 <字段> 已移除：秘密由 cluster.yaml.secrets
  唯一声明，managed 绑定与脚本直接引用本机已声明秘密`；schema
  停留在 v3（v3 内收窄，无 v4）。
- 校验面：`declaredManagedSecret` App 级 allowlist 删除；managed 绑定（yaml/json/toml/ini/ template
  与 script updater secrets）由 `loadCluster.validateSecret` 直连 `cluster.yaml.secrets`
  按放置机器逐一校验（未知秘密、kind 冲突、未放置本机均装载期失败关闭）。
- 交付面（方案 A，用户知情裁定）：开启秘密交付的步骤（环境 `configure`、App `configure`/ `deploy`
  及含 updater/hook 的动作）秘密集合 = 本机 cluster 声明放置的全部秘密
  （`machineScopedSecrets`：值/文件分集、排序；`machines: "*"` 装载期已归一），门禁沿用
  `exposesScriptSecrets || managedConfiguring`；`lifecycleSecret*` 与步骤集合同源，history
  不变量自然成立；planning 的 `managedSecrets` 绑定归一函数删除。同机多 App 共享脚本秘密
  可见性，隔离旋钮为 cluster.yaml 的 machines 放置声明（指南已明确该安全模型）。
- 文档面：README 与集群配置指南删除两张字段表的顶层声明行与示例行，绑定一致性、失败关闭与
  交付语义改写为唯一声明点模型；指南 :1033 的 `secrets.yaml` CLI 流程为独立特性，按设计保留。

## Verification

- 统一测试入口任务作用域
  `python3 harness/scripts/test-run.py
  sfo-deploy/049-drop-app-secret-declaration all`：9 步全部
  exit 0（五类 contract steps： external-positive/external-negative/removed-symbol-scan via
  consumer-closure-check/ repository-compile-closure/documentation-examples + unit U1-U4 +
  integration I1 `deno task
  test`、I2 文档契约、I3 旧符号扫描），run artifact
  `.harness/test-results/test-runs/20260905T144614Z-sfo-deploy+049-drop-app-secret-declaration-all.json`。
- 全仓 `deno task test` 232 通过 / 0 失败；`deno task check`、`deno task lint`、 `deno task fmt`
  通过。
- 验收独立探针（真实 loadCluster → buildPlan）：双机集群三态边界（单机秘密/通配文件秘密/
  无秘密机器）、两类顶层声明定向拒收文案、managed 绑定未声明/未放置本机失败关闭、managed App
  部署步骤整机集合与 lifecycleSecretValues 同源、计划序列化只含秘密名——全部通过。
- 验收报告：docs/versions/v0.1/modules/sfo-deploy/049-drop-app-secret-declaration/acceptance-report.md
  （accepted；F-01 方案 A 交付面为用户知情裁定的低危观察，F-02/F-03 为扫描器语义边界处置记录）。

## Follow-ups

- 无阻断后续。F-01 维持文档化的放置隔离模型；如未来需要按 App 收窄脚本秘密可见性，可在
  cluster.yaml.secrets 或绑定侧引入显式收窄声明（新任务）。
