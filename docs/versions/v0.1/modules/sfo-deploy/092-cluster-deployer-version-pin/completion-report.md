# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/092-cluster-deployer-version-pin.md
- 对象：在 `cluster.yaml`（schema v2）增加可选字段 `deployer_version`，作为 sfo-deploy
  运行时版本的精确准入门禁：声明后，仅当当前运行时版本与它完全一致（全等字符串、不做 trim）才继续执行
  受控动作（validate/plan/deploy/check/install/prepare/configure/start/stop/restart），不一致在任何
  SSH/远端动作前 fail-closed 失败；字段缺省时行为不变。覆盖 `src/**`、`tests/**`、`README.md`、
  `docs/guides/**`、`docs/modules/sfo-deploy.md`。

## Delivery Summary

- Outcome: `TOOL_VERSION` 从仓库根 `deno.json.version`（`"0.1.0"`）经 JSON import 派生并导出（缺失时回落
  `<unknown>`）；`cluster.yaml` 解析经 `exactDeployerVersion` 读取 `deployer_version` 存入
  `ClusterConfig.deployerVersion`（拒绝非字符串与纯空白，不做 trim、不做字符集限制）；`assertDeployerVersion`
  在主 `run()` 装载路径（477 行）与 `runDeploy` 装载点（771 行）都调用，deploy 不再绕过门禁。`history`/
  `rollback` 不装载集群，`fetch`/`install-deno`/`secrets-deploy` 虽装载集群但不做受控执行，均不受门禁约束。
- Handoff: 复现命令为 `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  （`ok | 348 passed | 0 failed`）。独立缺陷审查对阻塞性 deploy 绕过缺陷做动态验证（deployer_version 不匹配
  时 transport 零连接、release 目录不创建），修复后复审全部通过。升级工具版本时需同步受影响集群的
  `deployer_version`，否则 fail-closed。

## Proposal Consistency

| change_id | requirement_or_boundary | proposal_source | delivery_evidence | finding | status |
| --- | --- | --- | --- | --- | --- |
| CHG-cluster-deployer-version-pin | P-001：`deployer_version` 可选，解析并放入 `ClusterConfig` | proposal.md:A-001/A-002 | `loadCluster` 读取并经 `exactDeployerVersion` 校验，`ClusterConfig.deployerVersion?: string`；8 个门禁单测通过 | 未发现偏差 | pass |
| CHG-cluster-deployer-version-pin | P-002：与 `TOOL_VERSION` 精确匹配（直接字符串相等，不做 semver/前缀），不一致 fail-closed 不连接 SSH 不建 release | proposal.md:A-003 | `assertDeployerVersion` 全等比较，覆盖主路径与 `runDeploy`；deploy 测试断言 transport 零连接、release 目录不创建；带空白版本被解析但不放行（不 trim） | 未发现偏差 | pass |
| CHG-cluster-deployer-version-pin | P-003：门禁覆盖所有装载集群的受控动作；history/fetch/install-deno/secrets-deploy 不受影响 | proposal.md:A-003 | 5 个 `loadCluster` 站点逐一核实：476（受控公共路径）与 770（deploy）门禁，586/824/885（secrets-deploy/fetch/install-deno）不门禁，418-437（history/rollback）不装载 | 未发现偏差 | pass |
| CHG-cluster-deployer-version-pin | P-004：缺省不启用门禁，既有集群行为不变 | proposal.md:A-004 | 单测“字段缺失行为不变”：`deployerVersion === undefined` 且 validate 正常通过 | 未发现偏差 | pass |

## Independent Defect Discovery

| category | evidence_inspected | adversarial_check | finding_or_not_applicable_reason | status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `src/config.ts`、`src/integration.ts`、门禁单测、`deno task check`、348 项测试 | 动态验证：`deployer_version` 不匹配时 deploy 是否在 SSH 前失败；全部 5 个 `loadCluster` 站点逐个核对门禁/跳过归类；带空白版本匹配语义实测 | 首次审查发现阻塞性缺陷：deploy 走 `runDeploy` 独立分派绕过 `run()` 门禁，不匹配版本仍发起 SSH。修复后在 `runDeploy` loadCluster 后补 `assertDeployerVersion`，并新增 deploy 门禁单测（transport 零连接、release 目录不创建）；复审确认修复且无新缺陷 | pass |
| boundaries-and-failure-paths | 字段类型/空白/非法值处理、TOOL_VERSION 派生、错误消息、文档列举的 pass-through 集合 | 穷举 `cluster.yaml.deployer_version`：非字符串 42、空串、纯空白 `"  "` 均拒绝；`" 0.1.0 "` 可解析但在门禁超时失败（不 trim）；fetch 不匹配版本仍走下载路径（不受门禁影响） | 首次审查发现 major：测试三断言有恒真断言且未覆盖 deploy；修复为真实断言并新增 deploy 用例。另修正 4 处 minor（README/pass-through 表述、精确消息断言、字符集限制文案、TOOL_VERSION 空串回落） | pass |
| regression-and-side-effects | 变更路径清单、测试期望、README 与配置指南、依赖该字段的既有测试 | 全量测试 348 项通过；门禁仅新增二进制开关语义，未声明字段的集群回归测试（validate/plan/fetch）通过；无预装字段被复用语义偏移 | 未发现回归：除新增字段解析与门禁外无其它行为变化；修订后 `deno task check`/`lint`/`fmt` 全部通过 | pass |

## Verification

- Targeted check: `deno task check`、`deno task lint`、`deno task fmt`、`deno task test`
  （`ok | 348 passed | 0 failed`）
- Result: pass
- Exception reason: not-applicable

## Findings

| id | severity | evidence | problem | blocking |
| --- | --- | --- | --- | --- |
| F-001 | blocking | src/integration.ts deploy 分派（443-455 行）走 `runDeploy` 独立路径；修改前 `runDeploy` loadCluster（770 行）后未调用门禁 | `deployer_version` 不匹配时 deploy 仍可执行并连接 SSH，绕过 `run()` 主路径门禁；已在 771 行补 `assertDeployerVersion` 修复 | no |
| F-002 | major | tests/unit/deployer_version_gate.test.ts 原三断言含恒真断言 `assertEquals(directory.length > 0, true)` 且未覆盖 deploy | 测试未验证 deploy 的 fail-closed 行为，真实缺陷被全绿掩盖；已新增 deploy 门禁单测（transport 零连接、release 目录不创建）并移除恒真断言 | no |
| F-003 | minor | README/pass-through 文案 | `fetch`/`install-deno`/`secrets-deploy` 描述为“不经过完整集群装载”，实际它们是装载但不做受控执行 | no |
| F-004 | minor | cluster.yaml.deployer_version 校验 | 旧 `stringValue` 做 trim，带空白版本会与期望值意外相等，削弱精确匹配语义 | no |
| F-005 | minor | TOOL_VERSION 派生 | deno.json 缺失 version 时错误消息中构建版本为空串，不易诊断 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 阻塞性缺陷 F-001 已在 `runDeploy` 内补 `assertDeployerVersion`（771 行）修复，F-002 由新增 deploy 门禁单测（断言 transport 零连接、release 目录不创建）修复，F-003/F-004/F-005 均已在文档与实现中修正。独立缺陷复审全部通过，全量测试 348 项通过，`deno task check`/`lint`/`fmt` 全绿。