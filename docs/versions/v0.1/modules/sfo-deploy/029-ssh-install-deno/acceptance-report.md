---
task_manifest: task.yaml
---

## Object and Scope

- Task manifest: task.yaml
- Review mode: independent falsification（环境中无独立 reviewer 子代理可用，验收负责人按
  acceptance-review-rules 的替代路径执行：不采信实现自评，逐一重读 proposal/design/
  implementation/testing 证据后选择结论）
- Scope: sfo-deploy 模块 029-ssh-install-deno 的两个 change_id（CHG-ssh-deno-install、
  CHG-ssh-deno-docs）

## Findings

| id   | severity | owning_stage | correctness_category | evidence                                                                                                           | problem                                                   | blocking |
| ---- | -------- | ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------- |
| F-01 | none     | none         | overall              | 验收循环中修复 preflight 退出码映射（src/results.ts 与新增两处测试）；最终缺陷发现表 error-handling 行 status pass | 修复后未发现残余问题                                      | no       |
| F-02 | none     | none         | overall              | testplan.yaml manual_gaps.real-ssh-install 与内存传输替身测试证据                                                  | 真实 SSH 目标机 E2E 留作 manual gap，不影响本任务完成结论 | no       |

## Requirement Coverage

| change_id            | requirement_or_boundary                                                                                             | source                                                                              | implementation_evidence                                                                                                                                                                                                                                                           | finding                                                                  | status |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------ |
| CHG-ssh-deno-install | 新增纯 SSH 安装 Deno 的 CLI 动作 `install-deno`；按机器筛选；固定版本校验；已满足跳过；安装后复验；退出码/JSON 稳定 | proposal.md PI-1、design.md File-Level Interfaces/Key Flows/Risks and Rollback      | src/ssh_install.ts normalizeDenoVersion/validateInstallTo/installDenoOnMachine；src/integration.ts CLI_ACTIONS/RunOptions/runInstallDeno/confirmMachines；src/results.ts InstallDenoResult；src/cli.ts 解析/帮助/序列化；tests/unit、tests/dv、tests/integration 共 21 项任务用例 | 需求全部落地；preflight 退出码经验收循环修复（F-01）后符合固定退出码契约 | pass   |
| CHG-ssh-deno-docs    | README/指南/示例 README 同步 install-deno 用法、前提与安装目录约定                                                  | proposal.md PI-2、design.md API and Build Surface Impact/Consumer Migration Closure | README.md install-deno 段落与命令清单；docs/guides/sfo-deploy-cluster-configuration.md 第 4 节引导段落；examples/eleph-server-multipass/README.md 第 2 节；tests/contract/verify_install_deno_contract.ts 固定校验三处示例                                                        | 文档与实现一致，示例契约通过；真实目标机验证缺项记录在 F-02              | pass   |

## Independent Defect Discovery

| category                      | applicable_scope                                                                           | evidence_inspected                                                                                                                                                 | adversarial_check                                                                                                                                  | finding_or_not_applicable_reason                                                     | status |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| requirement-and-behavior      | 用户原始请求“sfo-deploy 中再添加一个使用纯 ssh 安装 deno 的命令”与 proposal 两个 change_id | proposal.md Scope/Out of scope/Success Criteria；README 新段落；src/cli.ts 动作清单；src/ssh_install.ts                                                            | 核对“纯 SSH（复用 OpenSshTransport，不要求远端预装 Deno）、按机器筛选、固定版本、已满足跳过、安装后复验、不自动改 machines.yaml”逐条对应最终实现   | 未发现需求缺失、越界行为或与 proposal 矛盾；install-deno 与既有 install 语义区分明确 | pass   |
| logic-and-control-flow        | 探测/跳过/安装/复验分支与确认门禁                                                          | src/ssh_install.ts probe/installer/verify 分支；src/integration.ts runInstallDeno 循环与取消重抛；src/results.ts exitCode 分支                                     | 构造“已满足跳过、缺失安装、安装失败、版本不匹配、HOME 非法、取消、preflight”反例路径，全部命中预期分支或关闭失败                                   | 反例均被正确处理；仅 F-01 退出码偏差已在验收循环修复                                 | pass   |
| boundary-and-input            | 版本、安装目录、远端 HOME、机器筛选                                                        | normalizeDenoVersion/validateInstallTo；RunOptions 校验；cli parseArguments                                                                                        | 空/非法/x.y.z 边界、主版本 <2、相对路径、`..`、空白控制字符、apps/env/withDependencies 混用均 fail-closed；缺省全量确认默认值正确                  | 边界输入全部拒绝或展开到合法远端路径，无注入面                                       | pass   |
| state-and-data-integrity      | 无持久状态；结果对象不可变；present/installed/failed 转换                                  | src/results.ts InstallDenoResult 冻结字段；src/ssh_install.ts outcome 构造与 cleanupErrors；runInstallDeno finally 关闭                                            | 每机器独立结果不被部分失败污染；会话清理失败会把结果标记 failed；不写任何发布历史或集群文件                                                        | 状态所有权与不可变结果一致，无半成功持久副作用                                       | pass   |
| error-handling-and-recovery   | 安装失败、验证失败、取消、preflight、清理错误                                              | errors.ts 类别；src/ssh_install.ts TransportError；src/integration.ts 捕获/重抛 CancelledError；src/results.ts 退出码                                              | 错误分类映射退出码 2/3/4/130；单台失败不阻断其余机器；取消中断且零连接；清理错误附加到结果                                                         | 错误处理 fail-closed，F-01 修复后 preflight=3 与文档一致                             | pass   |
| resource-lifetime-and-cleanup | OpenSSH 会话与 FakeSession 生命周期                                                        | src/integration.ts finally session.close；transport.ts OpenSshRemoteSession.close；tests/dv/install_deno.test.ts 三处 `assert(session.closed)`                     | 成功、安装失败、preflight 失败路径都关闭会话；取消在 connect 前抛出无需清理                                                                        | 会话生命周期完整，未发现泄漏或重复关闭                                               | pass   |
| concurrency-and-ordering      | 跨机器串行、确认门禁顺序、取消                                                             | runInstallDeno for..of 串行；throwIfAborted 在每台机器前；不可变结果数组                                                                                           | 无共享可变状态；多台机器按声明顺序处理；取消后不再连接剩余机器                                                                                     | 顺序与取消语义正确，无竞态共享状态                                                   | pass   |
| interface-and-compatibility   | CLI_ACTIONS、RunOptions、RunDependencies.confirmMachines、InstallDenoResult 导出           | src/integration.ts、src/cli.ts、src/mod.ts；tests/integration/install_deno_cli.test.ts；全量 deno task test 132 项                                                 | 新动作与可选参数均为 backward-compatible 新增；旧动作回归通过；帮助/JSON 字段稳定                                                                  | 接口兼容，无符号删除或迁移要求                                                       | pass   |
| security-and-capacity         | SSH 命令边界、版本/路径注入、提权、供应链                                                  | src/ssh_install.ts 版本正则、路径校验、固定 URL、DENO_INSTALL 经环境变量传递；transport.ts validateArgv/known_hosts/私钥；README 供应链备注                        | 用户输入只进环境变量或规范化数字字符串，不进 shell 字面量；非用户可写目录仅在 root/sudo -n 时安装；安装后固定小版本复验                            | 命令注入与路径逃逸被拒绝；供应链残余已由固定版本+复验与 F-02 记录                    | pass   |
| test-adequacy                 | 单元/DV/集成/契约四层与统一入口                                                            | testplan.yaml U1/U2/D1/I1/docs-contract；运行工件 .harness/test-results/test-runs/20260902T135449Z-*；全量 deno task test 132 项；deno task check/lint/fmt --check | 分支覆盖版本/路径/跳过/失败/验证/退出码；DV 覆盖主流程、提权配置、失败、确认、preflight；集成覆盖公开契约与 JSON；真实 SSH 差异由 manual_gaps 记录 | 覆盖与层级契约匹配；唯一缺口为真实目标机 E2E（F-02，已记录）                         | pass   |

## Document Consistency

| document    | source                    | implementation_consistency                                                                                                      | finding     | status |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| design      | design.md                 | File-Level Interfaces、Key Flows、State and Ownership、Risks and Rollback 与最终实现一致（含 preflight 退出码修复后的结果语义） | 无 mismatch | pass   |
| testing     | testing.md, testplan.yaml | 覆盖表与 testplan 步骤一致；DV 表已登记 preflight 退出码工作流；统一入口运行通过                                                | 无 mismatch | pass   |
| proposal.md | proposal.md               | Scope/非目标/成功标准逐条落地                                                                                                   | 无 mismatch | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 独立缺陷审查覆盖需求、逻辑、边界、状态、错误、资源、顺序、接口、安全与测试充分性；
  验收循环中修复 F-01（preflight 退出码），任务用例 21 项、全量 132 项测试与 check/lint/fmt
  全部通过。
- Blocking issues: none
- Next action: 完成验收收据，从未完成任务索引移除 029，并向用户交付变更摘要。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 两个 change_id 的需求覆盖均有 pass 证据；十类缺陷发现无 fail 项；设计/测试文档一致； F-01
  已在验收循环中修复并回归，F-02 作为非阻断 manual gap 保留，支持验收通过。
