---
task_manifest: task.yaml
---

## Object and Scope

- Task manifest: task.yaml
- Review mode: independent falsification（环境中无独立 reviewer 子代理可用，验收负责人按
  acceptance-review-rules 的替代路径执行：不采信实现自评，逐一重读 proposal/design/
  implementation/testing 证据并新增反例后选择结论）
- Scope: sfo-deploy 模块 031-install-deno-ensure-tools 的两个 change_id
  （CHG-deno-ensure-tools、CHG-deno-ensure-tools-docs）

## Findings

| id   | severity | owning_stage | correctness_category | evidence                                                                                                                                                                                                       | problem                                                                                             | blocking |
| ---- | -------- | ------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------- |
| F-01 | none     | none         | overall              | 新增 argv 校验回归测试立刻抓到工具探测脚本内 `printf "%s\n"` 的 JS 转义换行（真实 0x0A）会触发“远端命令参数不合法”，问题所属实现阶段；已改为空格分隔输出并新增 validateArgv 断言                               | 修复前探测脚本在实际传输层同样会被拒绝；修复后四条探测/安装命令全部通过严格 argv 校验               | no       |
| F-02 | none     | none         | overall              | 验收循环审查发现“工具补齐阶段提权不可用→preflight/退出码 3”只有语义映射测试、没有直接覆盖，问题所属测试阶段；已新增 unit 与 dv 各一条提权失败用例（PreflightError 透传、installCalls=0、exitCode=3、会话关闭） | 修复后该失败路径有直接反例测试支撑                                                                  | no       |
| F-03 | none     | none         | overall              | 真实 multipass/发行版目标机不在本环境可用；测试以内存替身和真实 OpenSshRemoteSession 命令工厂模拟验证                                                                                                          | 具体发行版上 apt/apk/dnf/yum 安装脚本兼容性留作 manual gap（testplan manual_gaps.real-ssh-install） | no       |

## Requirement Coverage

| change_id                  | requirement_or_boundary                                                                                                                      | source                                                                                             | implementation_evidence                                                                                                                                                                                                                                                                                                                                  | finding                                                                                  | status |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| CHG-deno-ensure-tools      | 远端缺少 curl/wget 或 unzip/7z 时，用目标机包管理器提权安装缺失的 curl/unzip 后继续固定版本 Deno 安装；失败 fail-closed；CLI/JSON/退出码不变 | proposal.md PI-1、design.md File-Level Interfaces/Key Flows/State and Ownership/Risks and Rollback | src/ssh_install.ts 新增 TOOL_PROBE_SCRIPT/PACKAGE_MANAGER_PROBE_SCRIPT/probeTools/detectPackageManager/packageInstallArgv/installRemotePackages/ensureRemoteTools 并接入 installDenoOnMachine；包管理命令固定 argv、privileged=true、无用户输入进命令；tests/unit 24 项、tests/dv 9 项任务用例                                                           | 需求全部落地；探测脚本转义换行缺陷（F-01）与提权覆盖缺口（F-02）已在验收循环修复并经回归 | pass   |
| CHG-deno-ensure-tools-docs | README/指南/示例 README 同步自动补齐行为、提权前提、包管理器支持范围与发行版软件源供应链边界                                                 | proposal.md PI-2、design.md API and Build Surface Impact/Design Notes/Risks and Rollback           | README.md install-deno 段落、“发行版仓库 + deno.land 固定版本”信任边界说明；docs/guides/sfo-deploy-cluster-configuration.md 第 4 节支持顺序 apt-get→apk→dnf→yum 与退出码 3/4 语义；examples/eleph-server-multipass/README.md 第 2 节 apt-get 自动安装说明；tests/contract/verify_install_deno_contract.ts 固定校验三份文档的可执行示例与三处自动补齐标记 | 三份文档一致且契约通过；真实目标机验证缺项记录在 F-03                                    | pass   |

## Independent Defect Discovery

| category                      | applicable_scope                                                           | evidence_inspected                                                                                                                                                                                         | adversarial_check                                                                                                                                                                                                                             | finding_or_not_applicable_reason                                           | status |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| requirement-and-behavior      | 用户请求“install-deno 包括 curl 和 unzip 的安装”与 proposal 两个 change_id | proposal.md Scope/Out of scope/Success Criteria；README 新段落；src/ssh_install.ts ensureRemoteTools 流程                                                                                                  | 核对“默认自动补齐、无新 CLI 开关、只装 curl/unzip、wget/7z 仅兜底、包管理器不支持时 fail-closed、已满足版本跳过”逐条对应实现与文档                                                                                                            | 需求全部落地且无越界行为；未新增参数，未改变 machines.yaml/发布历史        | pass   |
| logic-and-control-flow        | 工具探测→包管理器选择→安装→复测→Deno 安装→复验分支                         | src/ssh_install.ts ensureRemoteTools/probeTools/detectPackageManager/installRemotePackages 与 installDenoOnMachine 顺序                                                                                    | 构造“齐全跳过、缺一补一、都缺、无包管理器、update 失败、install 失败、复测仍缺、已满足版本跳过、提权失败”反例路径，全部命中预期分支                                                                                                           | 反例均被正确处理；F-01 的转义换行缺陷修复后探测逻辑真正可传输              | pass   |
| boundary-and-input            | 工具集合边界与包管理器值域                                                 | probeTools 空格分隔解析；detectPackageManager 固定路径与白名单 basename；packageInstallArgv 固定包名                                                                                                       | 空工具集、单工具、四类包管理器、未知二进制、缺一补一均按预期；命令行以 argv 数组传递，包名只能是 curl/unzip 常量                                                                                                                              | 边界输入 fail-closed 或映射到固定模板；无注入面                            | pass   |
| state-and-data-integrity      | 单会话顺序状态、结果对象不可变                                             | ensureRemoteTools 内 present 状态与安装后复测；MachineDenoOutcome/InstallDenoResult 冻结字段；runInstallDeno finally 关闭                                                                                  | 每机器独立结果不被部分失败污染；工具补齐失败不会留下半安装 Deno 状态（安装脚本尚未执行）；不写任何发布历史或集群文件                                                                                                                          | 无持久 schema 或共享状态，未发现半成功持久副作用                           | pass   |
| error-handling-and-recovery   | 错误分类、退出码映射与可行动提示                                           | errors.ts 类别；ensureRemoteTools 抛出 TransportError/PreflightError；integration runInstallDeno 捕获与最终清理                                                                                            | 工具补齐执行失败→transport/退出码 4；提权失败→preflight/退出码 3；无包管理器/复测仍缺→transport/退出码 4 且提示可行动；取消仍为 130                                                                                                           | 错误处理 fail-closed，F-02 新增用例直接验证提权失败映射                    | pass   |
| resource-lifetime-and-cleanup | OpenSSH 会话与 FakeSession 生命周期                                        | runInstallDeno finally session.close；tests/dv 多处以 Assert(session.closed) 覆盖成功、安装失败、preflight、无包管理器路径                                                                                 | 成功与四类失败路径都关闭会话；取消在 connect 前抛出无需清理；工具补齐失败路径同样进入 finally                                                                                                                                                 | 会话生命周期完整，未发现泄漏或重复关闭                                     | pass   |
| concurrency-and-ordering      | 跨机器串行、确认门禁顺序、取消                                             | runInstallDeno for..of 串行；每台机器 ensureRemoteTools 独立执行；结果数组不可变                                                                                                                           | 无共享可变状态；多台机器按声明顺序处理；取消后不再连接剩余机器；工具补齐不跨机器复用状态                                                                                                                                                      | 顺序与取消语义正确，无竞态共享状态                                         | pass   |
| interface-and-compatibility   | CLI_ACTIONS、InstallDenoResult 导出、RunOptions、JSON/退出码               | src/integration.ts、src/cli.ts、src/mod.ts、src/results.ts；tests/integration/install_deno_cli.test.ts；README 命令清单                                                                                    | 无符号删除或重命名；未加 CLI 参数；install-deno 帮助与 JSON 结构不变；既有 install/deploy/prepare 动作全量回归通过                                                                                                                            | 接口 backward-compatible，无迁移要求                                       | pass   |
| security-and-capacity         | 提权、命令注入、供应链信任边界                                             | src/ssh_install.ts 固定包名/固定检测脚本；transport.ts validateArgv/preflightPrivilege；README 供应链备注                                                                                                  | 用户输入（版本、安装路径、机器名）只进校验后的字符串或环境变量，不进包管理 argv；包管理器仅白名单固定绝对路径；apt 先 update 后 install；不安装 curl/unzip 以外的包                                                                           | 命令注入与路径逃逸被拒绝；软件源信任边界已在三份文档披露并记录 F-03 残余项 | pass   |
| test-adequacy                 | 单元/DV/集成/契约四层与统一入口                                            | testplan.yaml U1/U2/D1/I1/docs-contract；运行工件 .harness/test-results/test-runs/20260902T164359Z-sfo-deploy+031-install-deno-ensure-tools-all.json；全量 deno task test 153 项；deno task check/lint/fmt | 分支覆盖齐全/缺一补一/四类包管理器/update/install/复测/提权/已满足跳过；DV 覆盖主流程、失败、确认、preflight；真实 OpenSshRemoteSession 命令工厂 E2E 渲染出 12 条单行命令全部通过严格校验并得到 installed；唯一缺口为真实发行版目标机（F-03） | 覆盖与层级契约匹配；验收循环新增 F-02 用例后无缺口                         | pass   |

## Document Consistency

| document | source                    | implementation_consistency                                                                                                                                                | finding     | status |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| design   | design.md                 | File-Level Interfaces、Key Flows、State and Ownership、Risks and Rollback、Design Notes 与最终实现一致（含空格分隔探测输出、apt update 后 install、复测仍缺 fail-closed） | 无 mismatch | pass   |
| testing  | testing.md, testplan.yaml | 覆盖表与 testplan 步骤一致；新增提权失败单元/DV 行与统一入口运行工件对应；153 项全量测试通过                                                                              | 无 mismatch | pass   |
| proposal | proposal.md               | Scope/非目标/成功标准逐条落地：默认自动补齐、不新增开关、支持矩阵、供应链披露均实现                                                                                       | 无 mismatch | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 独立缺陷审查覆盖需求、逻辑、边界、状态、错误、资源、顺序、接口、安全与测试
  充分性十类；验收循环修复 F-01（探测脚本转义换行）与 F-02（提权失败直接覆盖缺口）并 回归；任务用例
  42 项、全量 153 项测试与 check/lint/fmt 全部通过；真实传输层 E2E 渲染验证通过。
- Blocking issues: none
- Next action: 完成验收收据、通过 lifecycle 完整检查，从未完成任务索引移除 031，并向
  用户交付变更摘要与真实 multipass E2E 建议。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 两个 change_id 的需求覆盖均有 pass 证据；十类独立缺陷发现无 fail 项；设计/
  测试/提案文档一致；F-01、F-02 在验收循环中修复并回归，F-03 作为非阻断 manual gap
  保留（真实发行版目标机 E2E），支持验收通过。
