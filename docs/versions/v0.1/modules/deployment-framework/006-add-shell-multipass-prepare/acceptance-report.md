# Multipass Bash 准备脚本第四轮验收报告

## Findings

| ID    | Severity | Owning Stage | Correctness Category | Evidence                                                                                                                                | Problem                                                                                           | Blocking |
| ----- | -------- | ------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| F-000 | none     | none         | overall              | 当前 proposal、pipeline plan、risk profile、Bash/PowerShell 实现、README、测试代码、testplan、最新任务运行制品及第四轮独立 RSA 边界执行 | 完成十类独立证伪后未发现仍需返回上游阶段的缺陷；真实 Multipass E2E 限制已作为明确 manual gap 保留 | no       |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-08-16
- In-scope implementation:
  `prepare-multipass.sh`、README、`test_prepare_multipass_sh.py`、`test_multipass_e2e.py`，以及当前任务设计、风险、测试计划与
  `20260816T145146Z` 运行制品
- Review mode: independent falsification; conclusion selected after findings and category
  review，本轮从当前主证据重新审查并独立执行 RSA 强度与类型边界

## Requirement Coverage

| change_id                   | Requirement or Boundary                                                                                          | Source                                                | Implementation Evidence                                                                                                                                      | Finding                                                                                                | Status |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ |
| CHG-shell-multipass-prepare | 与 PowerShell 等价地准备 VM、专用 SSH 身份和严格固定的信任包；异常状态失败关闭；提供 Linux/macOS Bash 入口及说明 | `proposal.md` P-001、P-002、P-003 和 Success Criteria | `prepare-multipass.sh:43-571`、README 平台入口、宿主原生 E2E 选择、任务测试及成功制品 `20260816T145146Z-sfo-deploy+006-add-shell-multipass-prepare-all.json` | 默认/显式入口、可信重跑、失败关闭、原子发布、SSH 身份、文档与可运行验证均符合提案；实机 E2E 缺口已说明 | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                                                   | Evidence Inspected                                                      | Adversarial Check                                                           | Finding or Not-Applicable Reason                                                                                                            | Status |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| requirement-and-behavior      | P-001 至 P-003 的 Bash 等价入口、失败关闭和平台文档                | 当前 proposal、Bash/PowerShell、README、测试和最新制品                  | 寻找未知接管、错误成功、职责扩张及平台入口缺失                              | 脚本仅调用 info/start/launch，不处理 JAR 或 VM 内安装；必需行为和非目标边界一致，未发现需求缺口                                             | pass   |
| logic-and-control-flow        | 参数解析、实例新建/重跑、30 次扫描、锁、发布和恢复                 | `prepare-multipass.sh:43-115,399-451,453-571` 与对应任务测试            | 复核 help/unknown 顺序、start/info/scan 失败和各发布分支退出                | 非法 argv 在宿主变更前失败，扫描严格终止于 30 次，错误分支不发布未完成 bundle，未发现错误分支或终止缺陷                                     | pass   |
| boundary-and-input            | CLI、空格路径、JSON、模板、目录/symlink、Ed25519/RSA blob          | 实现解析函数、fake 工具、参数化负例和第四轮独立执行                     | 验证 1023/1024/16384/16385 位 RSA、类型错配、零/负/非规范 mpint 及显式 argv | 1023/16385 位和类型错配失败，1024/16384 位成功；零、负、非规范及过小 RSA 负例进入目标分支，argv 保持独立                                    | pass   |
| state-and-data-integrity      | clusterRoot、互斥锁、staging、backup、可信重跑和残留状态           | 状态/清理实现及 non-directory、stale、backup/restore 测试               | 推演目标非目录、并发、备份移动、发布、恢复和提交后清理失败                  | 异常目标与残留状态失败关闭；旧 bundle 或唯一恢复 backup 保留，未暴露部分或混合修订                                                          | pass   |
| error-handling-and-recovery   | start/launch/info/JSON/scan/chmod/mv/rm 失败以及 INT/TERM          | Bash traps、全部新增 DV/integration 用例和独立 SIGINT 观察              | 检查 VM 保留、退出码、旧状态恢复、诊断残留及自有资源清理                    | 最新制品覆盖 TERM，独立 SIGINT 返回 130；失败保持 VM/旧 bundle 或可诊断 backup，未吞错或错误回滚                                            | pass   |
| resource-lifetime-and-cleanup | staging、backup、prepare lock、cloud-init 和扫描临时文件           | `cleanup`、受限删除函数、权限/信号/恢复测试                             | 沿成功、普通失败、INT、TERM 和强杀残留策略追踪资源                          | 当前进程资源在 EXIT/INT/TERM 清理，删除受父目录和前缀限制；强杀锁/backup 明确保留人工核对，未发现泄漏或越界删除                             | pass   |
| concurrency-and-ordering      | 同一示例状态上的并发 prepare 与残留锁                              | pipeline lock 设计、原子 `mkdir` 实现和 existing-lock 测试              | 推演同时获取锁、强杀残留和发布窗口                                          | 第二进程在任何 Multipass/cluster 操作前失败，残留锁不自动猜测或删除，未发现发布交错竞态                                                     | pass   |
| interface-and-compatibility   | Bash 3.2、Linux/macOS 工具、README、E2E 宿主分支和既有 PowerShell  | Bash 静态契约、README、`test_multipass_e2e.py` 和 contract 运行         | 搜索 Bash 4/GNU-only 构造并对照默认值、参数及消费者选择                     | 无 Bash 4/GNU-only 用法，非 Windows E2E 选择 Bash，PowerShell 保持并存；命令与文档一致                                                      | pass   |
| security-and-capacity         | 参数注入、私钥、host-key、路径删除、JSON/模板求值和工作量边界      | 引用的 argv、Python 数据解析、0600/umask、key validator 及 RSA 边界执行 | 用 shell 元字符参数、算法错配、非法 mpint、强度上下界和异常路径尝试绕过     | JSON/模板不经 shell 求值；RSA modulus 限于 1024 至 16384 位且为正奇数，类型/结构严格匹配；未发现注入、错误信任或无界重试                    | pass   |
| test-adequacy                 | unit、DV、integration、RSA/Ed25519、生命周期、恢复、兼容和真实 E2E | 当前 testplan、测试实现、manual_gaps 和最新成功制品的逐命令记录         | 核对测试实际声明的 key 类型、进入的分支、断言强度以及未执行环境范围         | fake 现按 host-key-type 输出并真实进入 RSA 分支；有效 1024 位基线经 `ssh-keygen` 验证，负例覆盖关键 mpint/强度类别；实机 E2E 原因和影响明确 | pass   |

## Document Consistency

| Document | Source             | Implementation Consistency                                                                | Finding                              | Status |
| -------- | ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------ | ------ |
| design   | `pipeline/plan.md` | Bash 实现符合实例、身份、互斥锁、失败流、发布事务、兼容性和消费者闭包设计                 | 未发现设计本身或实现映射不一致       | pass   |
| testing  | `testplan.yaml`    | 注册命令、测试实现、manual_gaps 与最新任务制品一致，覆盖当前 risk-profile required checks | 未发现测试文档、代码或运行证据不一致 | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 第四轮独立证伪确认前轮 RSA 和测试分支问题已关闭，当前交付满足提案及设计边界
- Blocking issues: 无阻断问题；真实 Multipass E2E 未执行的环境原因与验收影响保留在 testplan
  manual_gaps
- Next action: 可由父流水线记录 accepted 状态并执行后续生命周期关闭；具备真实 JAR、secret 和授权 VM
  环境时再补充实机 E2E

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 当前实现对 CLI、实例、SSH 身份、并发、发布和恢复均保持失败关闭，RSA
  类型/结构/强度边界经实现、测试和独立反例共同验证，任务级全部运行制品成功且唯一实机缺口已透明记录
