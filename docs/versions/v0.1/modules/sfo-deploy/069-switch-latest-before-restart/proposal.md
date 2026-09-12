---
task_manifest: task.yaml
status: approved
---

# sfo-deploy 框架：配置发布完成后，在重启前最后切换 latest

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- 层级理由：改变内置版本部署的激活时点、配置目标解析、服务执行和失败恢复，影响实际运行版本、跨应用调度及兼容性，属于已确认的重大运行时、部署和回滚边界。
- 提案及层级确认：用户已明确回复“确认，自动完成”，批准修订提案及 high-risk 层级，并授权后续自动流水线；先完成框架任务，不在本任务修改 jx-server。

## Background and Goal

用户要求先发布配置，再切换 latest；latest 切换必须是重启前的最后一次操作。当前 planning.ts 安排 stage/activate/restart，execution.ts 在执行 activate 脚本后才发布配置，versioned_release.ts 在 activate 内提前切换 latest，随后还写标记和清理旧版本；service_management.ts 在服务动作前执行 daemon-reload 和 enable。现有次序不满足用户要求。

## Scope

- 调整内置 versioned 部署的配置、切换和服务执行顺序，以及必要的计划/执行上下文、发布脚本、类型和配置解析。
- 让版本内的 managed config 指向本次待发布版本的真实目录，不通过旧 latest 写入；使用独立测试应用覆盖 JAR 同级 resources 等版本内配置目录。
- 更新框架使用指南并维护有意义的单元、集成和契约测试，验证不依赖真实 jx-server 制品或业务配置。
- 当前任务先完成框架实现、验证与独立验收；之后再处理 jx-server 配置及部署适配，该后续工作不纳入当前任务交付。
- 保留同版本部署、首次部署、多应用依赖、无服务应用和显式 configure/start/restart 的明确行为。
- 非目标：修改 jx-server 示例或本地集群配置、执行真实远端部署、修改业务 YAML 内容、重写自定义 deploy 协议、保证跨机器分布式原子提交。

## Requirement Review

- 需求合理：配置发布失败时不应先暴露一个配置尚未就绪的新版本。
- 默认将“最后一次操作”落实到每个应用目标的激活与启动边界：完成配置验证/发布、unit 发布、daemon-reload、enable 及必要前置检查后，原子切换 latest，紧接着执行该服务的 start/restart。二者间不得插入版本标记写入、清理、配置动作、其他应用部署或再次执行 systemd 准备操作；不以分别安排两个调度步骤替代这个约束。
- 首次部署用 start 达到同样边界；新旧版本标记、清理、结果记录和恢复逻辑必须按成功/失败语义重新安排，不在切换和服务命令之间执行。
- 配置目标的版本绑定由框架在部署上下文解析，避免在 app.yaml 手工硬编码当前版本。具体语法及对既有 latest 前缀目标的兼容策略在设计中确定，并以真实路径约束防止写入旧版本或逃逸安装目录。
- resources 父目录的创建或严格预检必须在切换前完成；缺目录失败不能改变旧 latest。
- 有多个部署目标时，先完成所有目标的版本及配置准备，再对每个目标执行紧邻的切换和服务动作，保留应用依赖顺序；任一准备失败不开始切换。
- 无服务应用在配置准备成功后提交 latest，不虚构重启动作；显式 configure 不暗中激活新版本。
- 同版本配置更新可能影响当前版本内容，应保留配置事务恢复并验证其边界，不将本次需求描述为同版本文件零可见性变更。
- 待澄清问题：无；以上作为建议验收边界供确认。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-configure-before-switch | 先向真实待发布版本发布配置，最后切换 latest 并紧接启动/重启 | 内置 versioned 与 managed service | 调整计划、执行及版本路径绑定 | 事件顺序和真实目录测试证明旧版本不被新版本配置修改，切换紧邻服务命令 | 不执行真实部署 |
| P-002 | CHG-configure-before-switch | 配置/准备失败保留旧 latest，切换失败不重启，重启失败执行可核验恢复并报告恢复失败 | 单目标有界恢复、多目标准备屏障 | 不声称跨机器原子性，保留恢复所需旧版本 | 注入配置、目录、切换、服务与恢复故障，核对软链、配置、标记和服务调用 | 不恢复业务进程内部数据 |
| P-003 | CHG-configure-before-switch | 维护框架版本路径能力、文档及兼容行为 | 同版本、首次、多应用、无服务、显式操作 | 配置版本由部署上下文决定，以独立测试应用验证 | 测试配置 validate/plan、回归测试及独立验收 | 当前不适配 jx-server |

## Success Criteria

- 新版本配置发布完成前，latest 保持旧目标；首次部署未准备成功时不存在新 latest。
- 独立测试应用的配置落在本次版本 resources 等声明位置，不会因为 latest 尚未切换而误写旧版本；不读取真实业务秘密作为测试输入。
- 成功路径远端操作轨迹中，该目标 latest 原子切换之后立即是实际 start/restart 命令；无额外配置、标记、清理或 systemd 准备命令插入。
- 每次部署只执行一次所需启动/重启动作，配置 on_change 与 on_deploy 合并，不因 activate/restart 重复执行。
- 覆盖首次、同版本、新版本、多目标准备失败、无服务、独立 configure 和各阶段故障；重启失败恢复到旧指向并进行必要服务补偿，恢复失败明确报告。
- 受影响本地测试、配置校验及独立缺陷审查通过；保留任务开始前已有改动，尤其不继续修改此前 jx-server 配置。

## Risks

- 当前全体 activate 后全体 restart 的调度与本次紧邻要求冲突，必须协调修改，避免丢失依赖或提前启动某个尚未准备完成的应用。
- 配置路径引用 latest 的既有应用可能误写旧版本；需要兼容解析或清晰迁移，不可仅重新排列调用。
- 版本标记、清理和软链提交顺序改变会影响失败重试；恢复所需旧版本不能提前删除。
- systemd unit 发布和 daemon-reload 不等同于业务启动，服务状态采集、权限检查、锁和元数据准备也必须置于最终切换前。
- 独立 configure 及同版本配置事务不具有版本隔离的全部优势，须准确保留与测试其边界。
- Risk profile: ./risk-profile.yaml
