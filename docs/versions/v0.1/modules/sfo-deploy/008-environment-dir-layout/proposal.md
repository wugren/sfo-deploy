---
task_manifest: task.yaml
status: approved
---

# 环境目录按机器组织提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries:
  - 变更集群配置 schema 与目录结构：`machines.yaml` 移除每机 `environments`
    列表，环境中每个子目录改按 `environments/<机器名>/<app>/` 组织，属于持久化配置 schema/迁移影响。
  - 已生成的 multipass 信任包（`clusters/multipass/`，含旧布局 machines.yaml 与 environments/
    定义）与全部配置/规划测试夹具都会失效，兼容或迁移需要明确决策。
  - 环境解析与初始化行为（按机器名称读取目录、依赖与执行顺序）改变，属于 runtime integration 与
    deployment surface 变化。
  - 命中触发规则：data-schema、build-config-deployment、runtime-integration。
- Proposal and tier confirmation: 用户已确认按提案执行并回答全部未决问题：保留 `apps/`
  目录（自研应用），`environments/<机器名>/<app>/`
  专用于机器环境（安装第三方工具）；不兼容旧布局；每个环境目录内部保留
  `environment.yaml + scripts/ + templates/`
  现有结构；用户要求自动完成任务。最终层级按用户对显示提案的确认定为 high-risk。

## Background and Goal

当前每台机器的环境实例声明在 `machines.yaml` 的 `environments` 列表中，每个实例引用
`environments/<定义名>/environment.yaml`
下的可复用定义，造成“哪台机器装什么”要跨两个文件查看且容易与机器清单混杂。

目标是把环境相关配置完全移出 `machines.yaml`，改为目录即声明：

- `environments/` 下每个子目录代表一台机器，目录名必须等于 `machines.yaml` 中的机器名称；
- 机器目录下每个子目录代表一个需要安装的 app，该子目录及其内容就是这台机器上该环境的完整定义；
- 框架装载集群时只读取 `machines.yaml`
  得到机器清单，再按机器名称读取对应目录下的子目录及其内容来初始化环境，`machines.yaml`
  只保留机器身份与连接信息。

## Scope

### In scope

- 修改集群 schema 与目录约定：`machines.yaml`
  不再接受/使用任何环境相关字段；`environments/<机器名>/<app>/` 成为每台机器环境的唯一声明位置。
- 更新配置装载、校验、环境依赖解析与执行规划逻辑，使其从环境目录结构枚举每台机器的环境实例。
- 更新示例集群模板、两个 prepare 入口（PowerShell/Bash）生成的信任包布局、示例 CLI 与 README。
- 同步更新框架与示例的相关测试夹具和断言。

### Out of scope

- 不改 VM 硬件规格（CPU/内存/磁盘/Ubuntu 镜像仍在 prepare 入口参数中）。
- 不新增凭据管理、加密存储或密钥轮换能力。
- 不改变 SSH 信任与原子发布机制本身（仅随布局变化调整生成内容）。

### Boundary with neighboring modules

- 机器身份/连接字段（region、IP、ssh_user、ssh_port、ssh_private_key、python、domains）仍留在
  `machines.yaml`。
- `cluster.yaml` 的 `executor_region` 保留；`apps` 放置语义是否保留见未决问题 Q1。
- 环境/App 的生命周期脚本机制、模板、配置密钥投递机制保留，只改变声明位置与解析来源。

## Requirement Review

该需求合理：把“每台机器需要什么环境”变成目录结构，声明与文件系统一一对应，避免环境实例散落在机器清单里，也更适合按机器初始化。主要代价是：

- 定义从“可复用定义 + 实例覆盖”变为“按机器展开”，相同 app 在多台机器上会重复目录内容；
- 集群配置 schema 变化会立即使旧布局集群不可装载，需要决定迁移/兼容策略；
- 现有环境中 app 定义（`apps/*`）与 `cluster.yaml` 放置之间的关系需要明确。

选择的实施方向：以 `environments/<机器名>/<app>/` 作为自包含的完整定义目录；保留现有
`environment.yaml` + `scripts/` + `templates/` 的结构，把版本、参数、依赖、权限等信息收进该目录内的
YAML，从而让“读目录即知环境”。

## Proposal Items

| proposal_id | change_id                  | requirement                                                                                                                    | boundary                                                                                                    | tradeoff                                 | success_evidence                                                                  | non_goal                       |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| P-001       | CHG-environment-dir-layout | `machines.yaml` 移除环境实例列表，只保留机器身份与连接字段                                                                     | 机器清单是环境目录的唯一命名来源                                                                            | 机器名称变更需要改目录名                 | machines.yaml 校验拒绝任何环境相关字段；示例生成文件不再包含 `environments:` 列表 | 不自动重命名目录               |
| P-002       | CHG-environment-dir-layout | `environments/<机器名>/<app>/` 目录是每台机器环境的唯一声明位置，装载器按机器名称读取子目录                                    | 未知机器目录、缺少 `environment.yaml` 的 app 子目录按校验错误处理；某台机器完全没有环境目录视为该机器无环境 | 目录即声明，结构直观                     | 配置装载从目录枚举出与旧实例等价的每机环境集合                                    | 不扫描与机器无关的目录         |
| P-003       | CHG-environment-dir-layout | 每个 `<app>/environment.yaml` 自包含 name/version/parameters/depends_on/requires_privilege/scripts/templates/config_secrets 等 | 不再使用跨机器共享定义间接层；`defaults`/`parameters` 合并机制保留                                          | 多机重复内容，换取按机器自包含           | 规划输出环境依赖与执行顺序与当前语义一致                                          | 不新增跨机器共享定义           |
| P-004       | CHG-environment-dir-layout | 更新示例集群模板、两个 prepare 入口与 README，生成的信任包采用新布局                                                           | 生成集群 git-ignored，重新 prepare 即可重建                                                                 | 旧信任包需重新生成；本次明确不兼容旧布局 | 重新 prepare 后 `validate`/`plan` 按新布局成功                                    | 不自动迁移旧布局信任包         |
| P-005       | CHG-environment-dir-layout | 同步更新框架和示例测试夹具、契约断言与文档中的布局示例                                                                         | 测试覆盖装载、规划、校验与示例 CLI                                                                          | 测试夹具变化随 schema 必然发生           | 相关测试全部通过，且旧布局明确报错                                                | 不保留双布局并存的隐藏兼容分支 |

## Success Criteria

- Concrete user-visible or system-visible result: 生成/手写的集群目录中，`machines.yaml`
  不再包含任何环境列表；`environments/<机器名>/<app>/`
  目录及其内容决定该机器初始化的环境；`validate`、`plan`、`check`/`install` 从新布局正常工作。
- Required evidence: 更新后的配置与规划单测、示例 contract/plan/环境脚本测试通过；重新运行 prepare
  入口后再执行 `eleph-deploy validate`/`plan` 成功；README 与模板布局一致。
- Explicit non-goals: 不做旧布局自动迁移、不做多集群发现、不增加 UI。

## Risks

- 配置 schema 与目录结构变化：现有旧布局集群（含当前 `clusters/multipass/`
  信任包）不再可直接装载；已确认不兼容旧布局，装载器对旧格式明确报错，不提供迁移。
- 依赖解析回归：`depends_on` 的名称解析、机器内依赖前缀、执行顺序必须与新目录名保持一致。
- `apps/` 与 `cluster.yaml.apps`
  保留现有独立语义（自研应用定义与放置），环境目录只承载第三方工具安装；部署/启动/停止生命周期不变。
- 每台机器环境目录被限定为 `environments/<机器名>/<app>/` 自包含目录（Q3 已确认保留现有结构），因此
  `cluster.environments` 的键语义从环境定义名调整为 `机器名/环境名`，需要同步模型消费者。
- 目录即声明的校验边界：机器目录缺失、多余 app 目录、重名 app、空目录都必须有确定性行为。
- 风险敏感材料不受影响：密钥、known_hosts 与信任包发布机制不因布局变化而削弱。
