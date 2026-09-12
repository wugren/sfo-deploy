# sfo-deploy 安装目录变量验收报告

## Findings
| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
|----|----------|--------------|----------------------|----------|---------|----------|
| F-000 | none | none | overall | 复审 `src/config.ts` 的 `managedConfigTarget`、`src/execution.ts` 的 `deploymentConfigTarget`、`src/transport.ts` 的 `releaseRoot` 边界、示例 app.yaml、testing.md/testplan.yaml 及 `.harness/test-results/test-runs/20260909T043835Z-sfo-deploy+070-app-install-directory-variable-all.json` | 本轮独立审查未发现未解决缺陷 | no |

## Object and Scope
- Task manifest: task.yaml
- Review date: 2026-09-09
- In-scope implementation: `src/config.ts`、本地 Multipass jx-server app.yaml、README、集群配置指南、模块边界说明、配置技能参考及相关 unit/DV/integration 测试。
- Review mode: independent falsification。审查按 proposal、design、生产代码、调用方、测试源码和运行工件的顺序复核，不以实现或测试结论为前提。未执行 SSH、fetch、deploy 或真实服务重启。

## Requirement Coverage
| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
|-----------|-------------------------|--------|-------------------------|---------|--------|
| CHG-install-directory-variable | managed config target 支持 `${INSTALL_DIRECTORY}/`，部署写入待发布版本 resources，configure 写当前版本；绝对路径保持兼容；缺声明和非法路径本地失败 | proposal.md P-001/P-002、Scope、Success Criteria | `managedConfigTarget` 先展开为 `install_directory/latest/relative`；`deploymentConfigTarget` 在候选 release 存在时映射为真实版本路径；transport 校验 releaseRoot/父目录；`tests/unit/app_management_config.test.ts` 和 `tests/dv/versioned_deploy_order.test.ts` 覆盖两种动作 | 目标写法、版本解析、旧路径兼容和本地失败关闭符合已确认边界 | pass |

## Independent Defect Discovery
| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
|----------|------------------|--------------------|-------------------|----------------------------------|--------|
| requirement-and-behavior | 目标变量、版本部署、configure 与文档 | proposal Scope/Success Criteria；`managedConfigTarget`；`deploymentConfigTarget`；示例与 README | 把用户示例逐字代入装载、deploy 和 configure 流程；检查是否意外重解释绝对路径或改变服务 args | 变量目标产生 latest 选择器，deploy 映射到候选版本，configure 仍写当前版本；绝对路径未被新逻辑改写 | pass |
| logic-and-control-flow | 变量前缀判定、relative 片段校验与路径归一 | `variableCount`、前缀判断、relative 校验、`managedTargetPath` 调用 | 检查非前缀、多次变量、空片段、`.`/`..`、双斜杠和尾斜杠的分支走向 | 所有非法分支在 join 前失败，合法片段唯一进入既有路径校验；未发现错误落点 | pass |
| boundary-and-input | install_directory 缺失、relative 字符域与重复目标 | unit 的缺失安装目录与路径穿越用例；config 装载重复目标检查 | 使用 `../`、`//`、尾斜杠、反斜杠和多变量输入构造逃逸/歧义目标 | 变量缺声明和非法 relative 均本地失败；重复目标在展开后仍被拒绝 | pass |
| state-and-data-integrity | latest 选择器、候选版本目录与配置事务 | versioned release prepare/switch/restore；DV 首次、同版本、新版本和故障恢复用例 | 核对配置写入不早于候选版本可用、失败不修改当前 latest、恢复回旧状态 | 既有事务边界未被新变量破坏；configure 不激活候选版本 | pass |
| error-handling-and-recovery | 配置装载错误、远端发布失败与恢复 | config 错误消息；transport 发布错误；DV publish/switch/service/marker/restore 故障注入 | 检查变量引入后失败是否仍在切换前暴露，恢复是否保留备份 | 未发现吞错或错误分类变化；失败恢复沿用 069 事务 | pass |
| resource-lifetime-and-cleanup | workspace、远端临时文件与版本保留 | transport workspace/preserveWorkspace；versioned release cleanup；相关 integration 测试 | 核对失败路径是否提前清理恢复所需资源 | 本任务未新增资源；既有清理和保留策略未被变量解析改变 | pass |
| concurrency-and-ordering | stage/activate 顺序与 switch 后服务动作 | planning 依赖图；DV 事件顺序断言 | 检查变量展开是否引入新远端调用或改变 switch/action 顺序 | 变量解析是本地装载行为，不新增并发或远端插入点 | pass |
| interface-and-compatibility | app.yaml 目标契约、计划 JSON 与旧绝对路径 | history encode/decode；unit 旧绝对路径；guide/README 示例 | 验证旧 latest 绝对路径和计划快照仍可执行，新变量不进历史快照 | 公共配置契约向后兼容；历史计划无需迁移 | pass |
| security-and-capacity | 路径穿越、符号链接逃逸与秘密边界 | transport `realpath` 包含关系；release root symlink 检查；integration boundary 测试 | 构造 release/resources 软链、相邻目录前缀和 `..` 输入 | 路径先经本地规范校验，再经远端真实路径包含关系校验；不引入 shell 插值或秘密暴露 | pass |
| test-adequacy | 变量分支、部署顺序、失败边界与跨模块契约 | testing.md/testplan.yaml；unit、DV、integration 测试源码；统一入口运行工件 | 逐条核对新增条件是否有断言，检查测试是否只测展开而漏部署映射或恢复 | 14 unit、16 DV、10 integration 加 2 contract 通过；用例覆盖合法/非法路径、部署映射、configure、路径边界与恢复 | pass |

## Document Consistency
| Document | Source | Implementation Consistency | Finding | Status |
|----------|--------|----------------------------|---------|--------|
| design | design.md | 变量只在 managed config 前缀生效、latest 选择器复用既有映射、路径边界与文件顺序均与代码一致 | 无不一致 | pass |
| testing | testing.md, testplan.yaml | 表列测试与实际命令一致，用例覆盖设计要求且统一入口工件成功 | 无不一致 | pass |

## Result Summary
- Overall result: accepted
- Outcome: `${INSTALL_DIRECTORY}` managed config 目标按用户要求表达版本内路径，deploy 与 configure 语义、旧路径兼容、本地失败关闭和远端路径边界均通过独立复核。
- Blocking issues: none。
- Next action: 完成任务生命周期并从未完成索引移除；本地 validate/plan 与测试已通过，真实节点部署和 Java 服务启动不在本任务范围。

## Conclusion
- Accepted / rejected / needs changes: accepted
- Reason: 独立反例检查未发现行为、边界、恢复、兼容或测试充分性缺陷；所有任务变更均有实现与验证证据。
