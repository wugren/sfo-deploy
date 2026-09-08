# 集群脚本迁移到 Deno TypeScript 第二轮独立验收报告

## Findings

| ID    | Severity | Owning Stage | Correctness Category | Evidence                                                                                                                                                                                                                | Problem                                                                                       | Blocking |
| ----- | -------- | ------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| F-000 | none     | none         | overall              | 独立复查当前提案、风险、pipeline 设计、生产实现、21 个 TS/YAML、修复后的 Deno 行为测试、testplan 和新制品 `20260901T094950Z-sfo-deploy+016-deno-cluster-scripts-all.json`，并重新挑战权限、兼容、清理与 manual 实机边界 | A016-F-001 已由真实 Deno 驱动的当前 TS 行为测试和任务级注册证据关闭；未发现仍需返回的阻断缺陷 | no       |

## Object and Scope

- Task manifest: task.yaml
- Risk profile: risk-profile.yaml
- Review date: 2026-09-01
- In-scope implementation:
  `src/sfo_deploy/{models,config,planning,environment,cli,remote_runtime,history,transport,execution}.py`，`README.md`，`docs/guides/sfo-deploy-cluster-configuration.md`，`examples/eleph-server-multipass/cluster-template/**`、示例测试与
  `deno_script_harness.ts`，以及新制品
  `.harness/test-results/test-runs/20260901T094950Z-sfo-deploy+016-deno-cluster-scripts-all.json`
- Review mode: independent falsification; 第二轮不继承上一轮 needs-changes 或 T-1
  自述结论，直接检查当前 primary sources、断言和机器写入证据后才选择结论

## Focused Reverification

| Prior Finding | Current Primary Evidence                                                                                                                                                                                                                     | Independent Adversarial Check                                                                                                                                                                                                                                                                              | Result |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A016-F-001    | `test_lifecycle_scripts.py` 与 `test_environment_scripts.py` 只引用当前 `.ts`；`run_deno_scenario` 复制目标 TS、当前 `sfo_deploy.ts` 与边界 harness 后由真实 Deno import；testplan 注册 `deno-example-behavior-unit`，新制品对应 step exit 0 | 检查 harness 是否仅做文本断言或吞掉脚本：它只替换 `Deno.Command`、`fetch`、时钟和 timeout，实际模块仍执行；11 个测试检查 start/restart/stop、4xx、120 秒截止、JAR 两次发布与两次 restart、MySQL import→verify→marker、marker 命中跳过、失败不发 marker、Redis 健康失败恢复/restart、秘密脱敏与临时文件删除 | closed |

## Requirement Coverage

| change_id                  | Requirement or Boundary                                                                                                                                     | Source                                                                                    | Implementation Evidence                                                                                                                                                                                                                                  | Finding                                                                                                                     | Status |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| CHG-deno-script-contract   | 新配置仅接受 Deno TypeScript；Deno 直接读写限于逐步骤工作区，默认拒绝网络/FFI/未声明子进程；显式 run/net 逐脚本生效；v1 Python、v2 Deno 与 v3 plan 严格兼容 | `proposal.md` P-001、Success Criteria；`risk-profile.yaml` contract/data/security/runtime | `config._scripts/_net_permission/_run_permission`、`ParamikoRemoteSession.execute_deno`、`DeploymentExecutor.execute_prepared/_execute_step`、`history._encode_plan/_decode_plan`；真实 Deno 权限探针、argv 单元反例和 v1/v2/v3 codec 用例均在新制品成功 | 权限保证只覆盖 Deno 直接 API，允许的子进程不继承沙箱；该例外与用户确认、代码和三处文档一致，未被误述为 OS 级隔离            | pass   |
| CHG-deno-example-migration | 迁移 eleph-server-multipass 的 21 个生命周期脚本、YAML、文档和测试夹具，同时保持部署动作、健康与恢复语义                                                    | `proposal.md` P-002、In scope、Required evidence；`pipeline/plan.md` I-3/T-1              | `cluster-template` 有 21 个 `.ts` 且无 `.py` 源，五个 YAML 使用 `{path, permissions:{run,net}}`；真实 Deno 行为 harness 驱动当前 lifecycle/deploy/MySQL/Redis TS，新制品登记并成功执行该 step                                                            | A016-F-001 的悬空 Python 测试消费者和行为覆盖缺口均已关闭；剩余真实 SSH/systemd/MySQL/Redis 验证明确登记为发布前 manual gap | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                                                 | Evidence Inspected                                                                                                                    | Adversarial Check                                                                                                         | Finding or Not-Applicable Reason                                                                                                                                 | Status |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| requirement-and-behavior      | Deno 执行、默认权限、逐步骤目录、旧快照和示例行为保持            | `proposal.md` P-001/P-002、当前生产路径、21 个 TS/YAML、三处文档和修复后行为测试                                                      | 逐项追踪 `.py` 拒绝、Deno argv、目录内外 I/O、默认网络、显式 run/net、旧回退、健康截止及示例恢复行为                      | 两个 change_id 均有当前生产路径与可失败验证；未发现遗漏、需求歧义或超出非目标的 OS 沙箱承诺                                                                      | pass   |
| logic-and-control-flow        | 权限分派、预检缓存、目标内 fail-fast、脚本循环和旧 runtime 分支  | `DeploymentExecutor.execute_prepared/_execute_step`、`execute_deno`、deploy/lifecycle/MySQL/Redis 当前 TS 与行为断言                  | 检查空/非空白名单、Deno/Python 分支、check 非零、取消、120 秒终止、deploy rollback 和 marker 分支                         | 未发现裸 allow、runtime fallthrough、无限健康循环或错误恢复顺序；边界 harness 的命令和 fetch 消费断言会暴露关键分支漂移                                          | pass   |
| boundary-and-input            | YAML 字段、资源路径、runtime 命令、run/net、上下文与 plan schema | `config._contained/_script_runtime_executable/_run_permission/_net_permission`、transport 二次校验、history strict decoder 与负向测试 | 挑战相对/非规范路径、逗号/控制字符、scheme/userinfo/path/wildcard、端口边界、IPv4/IPv6、未知字段和 snapshot 逃逸          | 所有外部值在 SSH 前严格验证；合法 host/IP/port 被规范保留，非法字段和 argv 注入失败关闭                                                                          | pass   |
| state-and-data-integrity      | 每脚本权限、步骤工作区、上下文秘密和 v1/v2/v3 不可变快照         | `ScriptInvocation/ScriptRuntime`、`PreparedExecution`、executor metadata、`inherit_rollback_snapshot` 和 codec 测试                   | 追踪权限配置→计划→准备→执行→快照，挑战旧来源改写、多 IP 主地址漂移、marker 早发和 Redis 失败后状态                        | 新写 v3，v1 Python 继续 v1 重放，v2 来源只读；行为测试证明 marker 后置及 Redis 原配置恢复顺序                                                                    | pass   |
| error-handling-and-recovery   | Deno 缺失、上传/执行失败、脚本非零、取消、清理、健康失败和旧回退 | `preflight_deno`、executor 双层 finally、deploy/Redis rollback、DV 和真实 Deno 行为测试                                               | 注入预检失败、KeyboardInterrupt、脚本非零、workspace cleanup error、JAR 新版离线、MySQL import 失败和 Redis NOPE          | 错误可见且保持 fail-fast/跨目标隔离；rollback 二次启动、marker 不发布、恢复配置和 redaction 均有顺序断言                                                         | pass   |
| resource-lifetime-and-cleanup | 本地固定输入、每步骤远端目录、context、会话和脚本临时文件        | `PreparedExecution.close`、`create_workspace/_remove_tree/cleanup_workspace`、executor finally、Redis/DeploymentContext 临时文件路径  | 检查成功、失败、预检异常、取消及清理失败；检查只递归删除当前会话登记前缀，并检查 Redis candidate/backup 消失              | 工作区每步独立且所有已检查终态都有清理；清理失败升级结果并脱敏，不会删除未登记路径                                                                               | pass   |
| concurrency-and-ordering      | 保持串行执行、步骤依赖、每机会话和 runtime 预检缓存              | executor 单循环、`by_step/failed_machines/runtime_checked`、history graph validator、pipeline 串行任务图                              | 挑战未完成依赖、同目标失败、跨目标继续、取消后剩余步骤和重复工作区                                                        | 本任务没有引入执行并发；依赖顺序、目标隔离和每步目录所有权保持确定，未发现 race、死锁或乱序更新                                                                  | pass   |
| interface-and-compatibility   | YAML、RemoteSession、CLI、v1/v2/v3 snapshot、示例及测试消费者    | `models.py`、`config.py`、`cli.py`、`transport.py`、`history.py`、consumer closure 与当前示例测试                                     | 搜索新配置 `python:`/裸 `.py`，核对旧 Python 方法只服务 v1，检查 v2 标量地址/v3 多 IP 及示例测试是否仍加载旧脚本          | 新配置消费者完成迁移，历史兼容 shim 范围明确；A016-F-001 的测试接口残留已不存在                                                                                  | pass   |
| security-and-capacity         | Deno API 权限、参数注入、秘密、路径清理和有界历史输入            | 固定 Deno flags、配置/transport 双重校验、TS runtime、Redactor、history 容量上限与行为 harness 脱敏                                   | 搜索 `--allow-all`/裸 allow/remote/npm，攻击目录外 script/context、非法 net/run，并检查 MySQL/Redis 秘密是否进入事件 JSON | 固定 no-prompt/no-config/no-remote/no-npm/deny-ffi；读写仅 workspace，默认 deny-run/deny-net；测试事件不暴露秘密，子进程例外明确                                 | pass   |
| test-adequacy                 | 正常、边界、负向、错误、生命周期、兼容、跨模块和示例实机限制     | `testplan.yaml`、unit/DV/integration、两个示例行为文件、`deno_script_harness.ts` 与 `20260901T094950Z...json`                         | 验证旧 `.py` 恢复、TS 分支/顺序损坏、权限 deny 移除、codec 篡改及 cleanup 退化是否能使当前断言失败；单独审查 manual gaps  | 新制品所有登记层级 exit 0，11 个行为测试驱动当前 TS 而非副本逻辑；真实 SSH/sudo/systemd/MySQL/Redis 未运行，但 testplan 明确其发布前影响且自动化没有声称实机成功 | pass   |

## Document Consistency

| Document | Source                                  | Implementation Consistency                                                                                                            | Finding                                                                                                                                       | Status |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| design   | `pipeline/plan.md`、`risk-profile.yaml` | 当前实现遵循 Deno 直接权限、逐步骤目录、串行执行、子进程例外和 v1/v2/v3 兼容设计                                                      | 未发现设计自身错误或实现偏离；测试返回修复没有改变生产接口                                                                                    | pass   |
| testing  | `testplan.yaml`                         | unit 新增 `deno-example-behavior-unit` 并列出两个测试和 harness；新制品以同一 step/change_id 执行成功，state evidence 指向新 artifact | A016-F-001 已关闭；`deno-real-ssh-target`、Paramiko 私有 I/O 分支和通用 history 容量/平台分支仍作为具体 manual gap 保留，没有被自动化证据掩盖 | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 两个 change_id 的 Deno TypeScript 契约、逐步骤工作区、默认禁网、显式子进程例外、v1/v2/v3
  兼容和 21 个示例消费者均通过独立证伪；A016-F-001 已由当前 TS 的真实 Deno
  行为测试和新任务制品关闭。
- Blocking issues: 无；真实隔离 SSH 目标机上的 Deno 安装路径、sudo、systemd、MySQL、Redis
  和实际制品部署仍是 testplan 明示的发布前人工验证边界，不作为本轮自动化已证明事项。
- Next action: 完成自动流水线 acceptance、生命周期和任务索引收尾；在实际发布前由 testplan
  指定负责人于隔离目标机执行 manual
  gap，若目标发行版路径或服务行为不同则停止发布并回到实现/测试处理。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 当前生产路径未发现阻断，A016-F-001 的旧失败机制已被移除且对应行为进入正式任务入口；全部
  change_id、十类缺陷发现和设计/测试一致性通过，剩余实机限制已准确披露而未被误当成自动验证。
