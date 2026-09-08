---
task_manifest: task.yaml
status: approved
---

# sfo-deploy 迁移为 Deno TypeScript 包提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务会替换控制端实现语言、Python
  包与命令安装机制，并影响公共 CLI、项目绑定 API、SSH
  传输、依赖与供应链、发布产物、测试入口及现有使用方迁移，明确触发
  contract、runtime、build、deployment、compatibility 与 architectural boundaries。
- Proposal and tier confirmation: 用户以“确认，自动完成”确认本提案和 high-risk 等级，并明确启动从
  design 开始、覆盖后续全部阶段的自动流水线。

## Background and Goal

当前 `sfo-deploy` 是 Python 包，依赖 PyYAML 与 Paramiko，并通过 Python console script
提供同名命令；Deno 只用于远端生命周期脚本。目标是把控制端整体迁移为 TypeScript/Deno 包，使用户通过
Deno 全局安装后可直接调用 `sfo-deploy`，不再要求 Python、uv
或虚拟环境，同时保留已经形成的集群配置与部署行为。

这里把“Deno 插件”落实为可导入、可测试、可通过 Deno 安装为全局命令的 Deno 原生包。安装以仓库或版本化
URL 暴露的 CLI 入口为本次可验证边界；实际发布到 JSR、npm
或其他注册表需要外部命名空间和凭据，不属于本次仓库内交付。

## Scope

### In scope

- 建立 `deno.json`、锁文件、公开模块入口和 `import.meta.main` CLI 入口，用 TypeScript 提供 Deno
  原生包。
- 支持以 Deno 全局安装命令安装为名为 `sfo-deploy` 的可执行命令，并记录最小必要权限与卸载/升级说明。
- 将现有 Python 控制端的配置解析、严格校验、规划、下载、秘密处理、SSH
  传输、执行、结果序列化、发布历史与回退能力迁移到 TypeScript。
- 保持现有 `sfo-deploy <action> --cluster ...` 命令、固定退出码、JSON 输出、集群 YAML、Deno
  生命周期脚本合同、发布快照读取与安全校验语义；任何不能保持的兼容点必须在设计阶段明确列出迁移方式。
- 把仓库内示例和项目绑定使用方迁移到 TypeScript/Deno API，移除它们对 Python `sfo_deploy`
  包的运行时依赖。
- 把产品测试迁移或重写为 Deno
  测试，并验证类型检查、单元/DV/集成行为、安装后的真实命令调用以及关键旧快照兼容路径。
- 更新 README、配置指南、测试入口和质量门，使仓库描述与验证方式以 Deno/TypeScript 为准。

### Out of scope

- 不在本任务中向 JSR、npm 或其他注册表执行真实发布，也不代替用户申请包命名空间、发布令牌或签名凭据。
- 不改变集群 YAML
  业务模型、部署动作集合、步骤顺序、权限边界、发布历史语义或远端生命周期脚本业务逻辑，除非移植验证证明现有行为无法在
  Deno 中等价实现并经用户重新确认。
- 不自动迁移仓库外部的 Python API 消费方；仓库内会提供清晰的 TypeScript API 与迁移说明。
- 不顺带增加并行部署、新的下载协议、新的秘密后端、自动历史清理或其他与语言迁移无关的功能。
- Harness 自身仍可使用 Python；本任务只迁移产品、产品测试和产品示例，不重写仓库交付流程工具。

### Boundary with neighboring modules

`sfo-deploy` 产品模块拥有 Deno 包、公共 TypeScript API、CLI 与控制端执行能力。示例模块只消费公开
API，不复制框架实现。Harness 继续作为仓库流程工具存在，其 Python 运行环境不构成产品运行时依赖。远端
TypeScript 生命周期脚本合同应复用现有格式，控制端迁移不得悄然扩大脚本权限。

## Requirement Review

迁移方向合理：控制端与远端脚本统一到 Deno/TypeScript 后，可减少产品运行时栈并直接利用 Deno
的安装、权限和类型检查能力。但这不是入口文件的机械改写；当前实现约 8,000 行 Python，包含
SSH、下载、发布快照、安全校验及较完整测试，且仓库内已有 Python 公共 API
消费方，因此应以行为兼容迁移而非一次性删改为原则。

选定方向是先在设计阶段固定 TypeScript
模块边界、SSH/下载依赖与兼容矩阵，再按行为切片移植，最后删除产品侧 Python 包装与依赖。Deno
安装使用显式命令名和最小权限，而不是无边界的 `-A`；若第三方依赖无法满足
known-host、资源清理或失败语义，设计必须记录替代方案与验证证据。

## Proposal Items

| proposal_id | change_id                    | requirement                                                          | boundary                                                                 | tradeoff                                                         | success_evidence                                                                  | non_goal                   |
| ----------- | ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------- |
| P-001       | CHG-deno-package-entry       | 提供 Deno 原生包、公开入口与可安装为 `sfo-deploy` 的 CLI             | 安装来源为本仓库路径或版本化 URL；真实注册表发布除外                     | 安装时必须显式授予控制端所需权限，不能依赖 Python console script | 在隔离安装根中执行 Deno 全局安装后，直接运行 `sfo-deploy --help` 及代表性命令成功 | 申请或发布注册表命名空间   |
| P-002       | CHG-typescript-control-plane | 用 TypeScript 等价实现当前控制端核心能力与公共命令合同               | 保持现有集群配置、退出码、JSON 结果、Deno 生命周期脚本及历史快照兼容边界 | 完整移植工作量较大，SSH 与 YAML 等能力可能引入新的审核依赖       | TypeScript 类型检查通过，现有关键成功/失败/安全/回退场景由 Deno 测试覆盖并通过    | 改变部署业务语义或新增功能 |
| P-003       | CHG-deno-consumer-migration  | 将仓库内示例、项目绑定与文档从 Python API 迁移到 TypeScript/Deno API | 仅承诺迁移仓库内消费者，并为仓库外消费者提供说明                         | Python API 将成为破坏性移除点，需要明确旧到新映射                | 仓库内不再以 Python 包运行产品或示例，示例通过 Deno API 与 CLI 验证               | 自动修改仓库外项目         |
| P-004       | CHG-deno-verification        | 建立 Deno 原生产品测试、安装冒烟和质量门闭环                         | Harness 流程工具保留 Python；测试聚焦产品行为                            | 不能仅用源码文本断言代替可执行行为验证                           | `deno check`、Deno 测试、安装后命令冒烟及兼容性检查均产生通过证据                 | 重写 Harness 为 TypeScript |

## Success Criteria

- Concrete user-visible or system-visible result: 用户在装有 Deno 的环境中，无需
  Python/uv，通过文档给出的 `deno install --global --name sfo-deploy ...` 命令安装后，可以直接调用
  `sfo-deploy` 完成现有 CLI 支持的操作。
- Required evidence: Deno 配置与锁文件有效；TypeScript 公共 API 和 CLI
  通过类型检查；隔离安装根中的安装、PATH 调用与卸载冒烟成功；配置、规划、部署失败映射、SSH
  安全、下载校验、秘密处理、发布历史与回退的代表性成功和失败测试通过；仓库内示例不再依赖 Python
  产品包；文档给出固定版本安装与最小权限说明。
- Explicit non-goals: 不执行注册表发布，不重写
  Harness，不改变集群业务合同，不增加语言迁移之外的新部署功能。

## Risks

- Python 公共 API 被 TypeScript API
  替代属于破坏性兼容变更；必须列出仓库内消费者和旧符号到新接口的迁移状态。
- SSH、YAML 与下载实现的依赖选择会改变供应链和运行时安全面；需要锁定版本、审查权限与 known-host
  行为，并测试失败关闭。
- Deno 安装脚本固化的权限直接决定命令能力；权限过窄会导致运行失败，使用 `-A` 又会失去最小权限边界。
- 发布历史与回退包含跨版本持久数据；序列化差异、路径处理或哈希验证偏差可能使旧记录无法读取或错误执行。
- 当前工作区已有大量未提交的产品、测试、示例和文档改动；实现必须以这些内容为迁移输入，逐项保留，不能通过删除或还原
  Python 文件掩盖尚未移植的行为。
- 一次性替换大规模实现容易产生表面可运行但边界缺失的结果；设计与测试必须按模块和行为矩阵分阶段闭合。
