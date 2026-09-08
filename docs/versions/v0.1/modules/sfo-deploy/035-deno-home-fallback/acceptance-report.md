---
task_manifest: task.yaml
---

## Object and Scope

- Task manifest: task.yaml
- Review mode: independent falsification（环境中无独立 reviewer 子代理可用，验收负责人 按
  acceptance-review-rules 的替代路径执行：不采信实现自评，逐一重读 proposal/
  design/implementation/testing 证据并新增反例后选择结论）
- Scope: sfo-deploy 模块 035-deno-home-fallback 的两个 change_id
  （CHG-install-deno-path-default、CHG-install-deno-path-docs）

## Findings

| id | severity | owning_stage | correctness_category | evidence | problem | blocking |
|---|---|---|---|---|---| | F-01 | none | none | requirement-and-behavior | 缺省安装改为 /usr/local
后，FakeSession/DV 均验证
denoPath=/usr/local/bin/deno、DENO_INSTALL=/usr/local、privileged=true；README/指南/示例与 CLI
帮助同步 | 未发现阻断或非阻断缺陷 | no | | F-02 | none | none | security-and-capacity |
缺省安装现在要求 root/sudo -n；提权失败走既有 preflight 退出码 3，显式 $HOME 目录仍免提权（unit
覆盖） | 安全语义与文档一致；无提权边界缺口 | no | | F-03 | none | none | runtime-integration |
present 探测路径同步为 /usr/local/bin/deno；旧 $HOME/.deno 安装不会自动被识别为
present，文档已提示可显式 --install-to | 该兼容边界作为既定行为记录，不阻断 | no |

## Requirement Coverage

| change_id                     | requirement_or_boundary                                           | source                                                                                             | implementation_evidence                                                                                                                                                 | finding                                        | status |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------ |
| CHG-install-deno-path-default | install-deno 缺省把 Deno 安装到 /usr/local，使 deno 位于默认 PATH | proposal.md PI-1、design.md File-Level Interfaces/Key Flows/State and Ownership/Risks and Rollback | src/ssh_install.ts DEFAULT_DENO_INSTALL_ROOT=/usr/local 且缺省 root、privileged 判定；src/integration.ts failedDenoOutcome 缺省 /usr/local/bin/deno；unit 25 项/DV 9 项 | 需求落地，测试证明缺省路径、提权与失败路径正确 | pass   |
| CHG-install-deno-path-docs    | CLI 帮助与 README/指南/示例说明缺省 /usr/local 与提权前提         | proposal.md PI-2、design.md API and Build Surface Impact/Consumer Migration Closure                | src/cli.ts 帮助；三份文档缺省命令改为不带 --install-to；tests/contract/verify_install_deno_contract.ts 同步缺省示例                                                     | 文档与实现一致，契约通过                       | pass   |

## Independent Defect Discovery

| category                      | applicable_scope                                        | evidence_inspected                                                            | adversarial_check                                                         | finding_or_not_applicable_reason                                                   | status |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| requirement-and-behavior      | 安装后其他命令可直接使用                                | proposal/design；src/ssh_install.ts 缺省根；README/指南/示例                  | 核对缺省 denoPath、privileged、帮助文本、示例命令逐条对应                 | 需求全部落地，无越界行为                                                           | pass   |
| logic-and-control-flow        | 缺省/probe/privilege/install/复验分支                   | installDenoOnMachine 顺序与 FakeSession path；DV 主流程/present/失败          | 构造缺省安装、present、提权失败、显式 home 免提权反例                     | 反例均命中预期分支：default= /usr/local+privileged、present 跳过、显式 home 不提权 | pass   |
| boundary-and-input            | installTo 输入域与失败路径                              | validateInstallTo 既有测试；DEFAULT_DENO_INSTALL_ROOT 常量；failedDenoOutcome | 空/相对/`..`/显式 home/显式 /usr/local 均按预期；失败结果路径不再“未确定” | 边界输入 fail-closed                                                               | pass   |
| state-and-data-integrity      | 安装不写配置、不写发布历史                              | integration runInstallDeno 返回值；DV 断言 machines.yaml 内容不变             | 安装前后配置一致性、失败不写、结果不可变                                  | 无持久副作用；配置一致性保持                                                       | pass   |
| error-handling-and-recovery   | preflight/execution/退出码                              | transport privilege；InstallDenoResult exitCode；DV preflight/failure         | 提权失败→3，执行失败→4，成功→0；会话关闭                                  | 错误分类正确且幂等可重跑，未发现错误被吞掉                                         | pass   |
| resource-lifetime-and-cleanup | 安装成功、失败与 preflight 路径的会话和临时资源生命周期 | DV 各路径 session.closed；installDenoOnMachine 无本地远端文件残留             | 成功/失败/preflight 都关闭会话                                            | 未发现会话或临时文件泄漏，清理路径完整                                             | pass   |
| concurrency-and-ordering      | 跨机器串行、确认门禁与取消顺序                          | runInstallDeno for..of；DV confirm gate                                       | 取消不连接剩余机器；无并发声明                                            | 顺序与取消语义正确：按声明串行、取消后不再连接                                     | pass   |
| interface-and-compatibility   | CLI/JSON/公开帮助                                       | cli/help/InstallDenoResult；integration 测试                                  | 未删符号、未改 JSON/退出码；帮助文本变化已同步文档                        | 接口 backward-compatible                                                           | pass   |
| security-and-capacity         | 缺省安装提权边界与安装路径校验                          | privileged 判定；preflightPrivilege；validateInstallTo                        | 默认提权但仅安装到固定 /usr/local；显式 $HOME 免提权；非法路径拒绝        | 未发现注入面，提权范围仅限 /usr/local 安装路径                                     | pass   |
| test-adequacy                 | 单元、DV、集成与文档契约分层测试                        | testplan U1/U2/D1/I1/docs-contract；运行工件；154 项全量测试                  | 覆盖缺省/显式/提权失败/present/调试帮助/文档                              | 分层覆盖充分且可运行，真实 SSH 目标机仅留 manual gap                               | pass   |

## Document Consistency

| document | source                    | implementation_consistency                        | finding     | status |
| -------- | ------------------------- | ------------------------------------------------- | ----------- | ------ |
| design   | design.md                 | 缺省根、提权、帮助、Consumer Migration 与实现一致 | 无 mismatch | pass   |
| testing  | testing.md, testplan.yaml | 覆盖表与 testplan 步骤一致；统一入口运行通过      | 无 mismatch | pass   |
| proposal | proposal.md               | 缺省 /usr/local、提权前提、不写配置逐条落地       | 无 mismatch | pass   |

## Result Summary

- Overall result: accepted
- Outcome: install-deno 缺省安装到 /usr/local/bin/deno，装完即可被后续命令在默认 PATH
  中找到；帮助与三份文档同步；提权失败 fail-closed；154 项全量测试和统一任务入口 通过。
- Blocking issues: none
- Next action: 完成验收收据并移除任务；真实 multipass E2E 留作环境验证。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 两个 change_id 均有 pass 证据；十类独立缺陷发现无 fail；设计/测试/提案文档 一致；F-02/F-03
  作为既定的安全/兼容边界记录但不阻断。
