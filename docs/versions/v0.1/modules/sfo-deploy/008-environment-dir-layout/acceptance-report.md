---
task_manifest: task.yaml
status: approved
---

# 环境目录按机器组织验收报告

Risk profile: ./risk-profile.yaml

## Findings

| ID    | Severity | Owning Stage | Correctness Category | Evidence                                                                                                                                                | Problem                                                               | Blocking |
| ----- | -------- | ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| F-001 | none     | none         | overall              | `.harness/tasks/v0.1/tasks.json` 因任务包迁移到 `sfo-deploy` 模块产生陈旧条目；已备份到 `/tmp/tasks-v0.1.json.bak` 后经 `task-index.py init + add` 重建 | 流程状态文件重置，不影响交付物或行为                                  | no       |
| F-002 | none     | none         | test-adequacy        | `examples/eleph-server-multipass/tests/test_bootstrap.py` 两个 pwsh 用例                                                                                | 本环境无 pwsh，属既有环境缺口；bash prepare 等价路径已集成覆盖        | no       |
| F-003 | none     | none         | overall              | `design.md` File-Level Implementation Sequence 将测试文件列为实现条目                                                                                   | 测试实现实际由 testing 阶段负责，属文档颗粒度不精确，不影响行为与交付 | no       |
| F-000 | none     | none         | overall              | 最终任务运行证据 `.harness/test-results/test-runs/20260818T045622Z-sfo-deploy+008-environment-dir-layout-all.json`（12 步全部 exit 0）                  | 未发现缺陷                                                            | no       |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-08-18
- In-scope implementation: `src/sfo_deploy/config.py` 装载器、`machines.yaml`
  schema、`environments/<机器名>/<环境名>/` 目录约定、multipass
  示例模板与生成信任包、README、相关测试与契约。
- Review mode: independent
  falsification（独立伪造尝试）：以反向检查旧布局残留、缺环境目录、跨机依赖、目录枚举与计划输出一致性为主，结论经证据核对后选定。

## Requirement Coverage

| change_id                  | Requirement or Boundary                                                | Source                    | Implementation Evidence                                                                                                              | Finding                                                    | Status |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------ |
| CHG-environment-dir-layout | machines.yaml 只保留机器身份与连接字段                                 | `proposal.md` P-001       | `config.py:_load_machines` 字段白名单移除 environments；旧文件报 `未知字段: environments`                                            | 未发现要求缺陷：字段白名单与负例测试均符合提案 P-001       | pass   |
| CHG-environment-dir-layout | `environments/<机器名>/<环境名>/environment.yaml` 自包含声明并驱动装载 | `proposal.md` P-002/P-003 | `config.py:_load_machine_environments` 枚举机器目录；示例模板四环境均为自包含 YAML                                                   | 未发现要求缺陷：目录枚举结果与计划输出符合提案 P-002/P-003 | pass   |
| CHG-environment-dir-layout | 保留 apps/ 与 cluster.yaml.apps 独立语义                               | `proposal.md` 确认答复    | `config.py:_load_apps` 与 `planning.build_plan` 未改动                                                                               | 未发现要求缺陷：App 生命周期与放置语义保持不变             | pass   |
| CHG-environment-dir-layout | 不兼容旧布局并按机器目录初始化                                         | `proposal.md` P-004/P-005 | 负例契约测试 `tests/contract/test_old_layout_rejected.py`、单元测试 `test_environment_declarations_live_only_in_machine_directories` | 未发现要求缺陷：旧字段/旧目录均失败关闭，符合 clean break  | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                                     | Evidence Inspected                                                                 | Adversarial Check                                                        | Finding or Not-Applicable Reason                           | Status |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ------ |
| requirement-and-behavior      | 目录即声明的集群装载行为与 machines.yaml schema 边界 | proposal/design、`config.py`、示例模板                                             | 逐一比对新布局装载结果与旧行为的计划输出（14 步 id 完全一致）            | 未发现要求歧义或遗漏行为（计划输出与旧布局一致）           | pass   |
| logic-and-control-flow        | 环境依赖解析、跨机依赖与计划拓扑顺序                 | `planning.py`、`_validate_dependencies`                                            | 自依赖、未知依赖、跨机限定依赖、定向 App 仅 check 分支                   | 自依赖规划期报 PlanningError；跨机依赖按拓扑先执行         | pass   |
| boundary-and-input            | machines.yaml 与 environments 目录的输入校验边界     | `config.py` 校验路径与单元/契约负例                                                | 旧字段、非机器目录、空环境目录、多机同名环境参数                         | 全部失败关闭或独立实例化                                   | pass   |
| state-and-data-integrity      | 集群目录树作为唯一环境声明持久状态                   | 装载器、`prepare-multipass.sh` 与发布机制测试                                      | 机器无环境目录视为无环境；目录即唯一声明源；未引入新持久状态             | 未发现状态完整性缺陷（目录即唯一声明源）                   | pass   |
| error-handling-and-recovery   | SSH 前严格校验与失败关闭路径                         | `tests/unit/test_config_planning.py`、`tests/contract/test_old_layout_rejected.py` | 占位哈希/缺文件/坏 schema 均 ConfigurationError                          | 未发现错误传播或回滚缺陷                                   | pass   |
| resource-lifetime-and-cleanup | 资源生命周期与清理（本任务无新增资源）               | 变更面审查：config.py 与 planning.py 无资源获取/释放                               | 本次未引入文件句柄、线程、网络连接或异步任务                             | not-applicable：无新增资源生命周期，装载与规划为纯函数操作 | pass   |
| concurrency-and-ordering      | 执行计划串行顺序与依赖门                             | `planning.py` 拓扑与测试断言                                                       | 依赖门与步骤 id 顺序                                                     | east 环境先于 west 跨机依赖；环境先于 App                  | pass   |
| interface-and-compatibility   | `ClusterConfig.environments` 键语义                  | 设计 Consumer Migration Closure、`consumer-closure-check`                          | breaking 键语义的仓库内消费者全部迁移；扫描通过                          | 未发现残留旧 key 引用（迁移闭包与扫描均通过）              | pass   |
| security-and-capacity         | 路径包含、模板规范与文件私钥投递信任边界             | `config.py` `_contained/_scripts` 校验                                             | 路径逃逸、模板规范、文件私钥目标                                         | 校验逻辑未变，未发现新绕过                                 | pass   |
| test-adequacy                 | 测试覆盖、测试计划与统一入口运行证据                 | testplan、testing.md、最终 run artifact                                            | 反查每个 change_id 有 direct/case-type/design-element 行且 12 条命令全绿 | 无充足性缺陷；pwsh 用例为既有环境缺口（F-002）             | pass   |

## Document Consistency

| Document | Source                         | Implementation Consistency                             | Finding                           | Status |
| -------- | ------------------------------ | ------------------------------------------------------ | --------------------------------- | ------ |
| design   | `design.md`                    | 装载器、模板布局、文档与测试均按设计形状实现           | 除 F-003 文档颗粒度注记外无不一致 | pass   |
| testing  | `testing.md` + `testplan.yaml` | 测试步骤与文档验证 id 一致；最终 run artifact 覆盖每步 | 无不一致                          | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 新环境目录布局交付并验证；旧布局按约定拒绝；apps/ 语义保留；文档与生成信任包同步。
- Blocking issues: 无。
- Next action: 在具备 pwsh 与环境变量的真实 Multipass 环境补跑 PowerShell
  引导与端到端验收（既有缺口）。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason:
  独立缺陷发现覆盖要求/边界/错误路径/兼容性/测试充分性；全部负例与契约检查通过，机器可读运行证据完整（exit
  0），未发现阻断性缺陷。
