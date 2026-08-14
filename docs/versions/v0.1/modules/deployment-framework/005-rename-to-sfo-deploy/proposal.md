---
task_manifest: task.yaml
status: approved
---

# 将部署模块重命名为 sfo-deploy 的提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment
- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 该重命名会改变 Python 发行包名、导入命名空间、命令行入口、示例项目依赖和锁文件，属于公开契约迁移与构建产物变更；现有调用方必须同步迁移，旧名称将不再作为兼容入口保留。
- Proposal and tier confirmation: 用户已明确回复“确认，自动完成”，确认本提案、`high-risk` 分级，并授权从 design 开始自动完成后续流水线。

## Background and Goal
当前部署模块在发行包、Python 导入、CLI 和项目文档中使用 `deployment-framework` / `deployment_framework` / `deploy-framework` 等关联名称。目标是将当前产品统一命名为 `sfo-deploy`，并让安装、导入、命令调用、示例引用和验证证据保持一致。

## Scope
### In scope
- 将 Python 发行包名改为 `sfo-deploy`，Python 导入包改为 `sfo_deploy`，通用命令行入口改为 `sfo-deploy`。
- 重命名 `src/deployment_framework/`，并同步生产代码中的运行时标识、临时路径前缀、上传文件名和 User-Agent 等旧名称。
- 更新根 README、测试、示例项目依赖与源码引用、`uv.lock`、统一测试入口中的模块注册名。
- 为本次迁移补充并执行公开契约、安装/构建以及相关回归验证。
- 将当前任务和后续任务的目标模块标识切换为 `sfo-deploy`；已完成任务包保留旧名称和原路径，作为不可改写的历史证据。

### Out of scope
- 不改变部署配置 schema、执行语义、SSH 安全模型、环境/App 生命周期或业务功能。
- 不提供 `deployment-framework`、`deployment_framework` 或 `deploy-framework` 的兼容别名、转发包或旧命令包装器。
- 不改写已完成任务包中的历史正文、生命周期收据或验收证据。
- 不调整版本号、依赖版本或发布渠道。

### Boundary with neighboring modules
- `examples/eleph-server-multipass` 是本模块的仓库内消费者，必须随公开名称同步迁移，但其自身项目名 `eleph-server-deploy` 和部署行为不变。
- Harness 规则本身不变；仅更新统一测试入口的模块键及本次/后续任务使用的目标模块身份。

## Requirement Review
统一重命名是合理的，但只修改 `pyproject.toml` 的发行名会留下旧导入名、旧 CLI、示例依赖和运行时标识，形成不完整迁移。因此选择一次性完成所有活跃产品与消费者引用的原子迁移。代价是这是破坏性公开契约变更，现有外部调用方需要把依赖名改为 `sfo-deploy`、导入改为 `sfo_deploy`、命令改为 `sfo-deploy`；本提案不引入兼容层，以避免长期维护两个品牌入口。

## Proposal Items
| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-rename-sfo-deploy | 将活跃部署模块的发行名、Python 导入名、CLI、运行时标识、示例消费者、测试和 Harness 测试注册统一迁移到 `sfo-deploy` / `sfo_deploy` | 保留已完成任务包的历史名称和证据，不改变部署行为 | 明确接受一次破坏性名称迁移，不保留旧入口 | 构建元数据和锁文件只声明新发行名；新导入与 CLI 可用；仓库活跃代码、示例和测试不再依赖旧名；任务级契约/构建/回归验证通过 | 不改变功能、schema、依赖版本、版本号或提供兼容别名 |

## Success Criteria
- Concrete user-visible or system-visible result: 安装仓库后使用 `sfo-deploy` 命令和 `sfo_deploy` Python 包，项目元数据、README 和示例统一展示 `sfo-deploy`。
- Required evidence: 构建/安装契约验证新发行包和模块路径；CLI 帮助可通过新命令或 `python -m sfo_deploy` 调用；相关单元、DV、集成、契约及示例测试通过；除历史任务证据外不存在活跃旧名称引用。
- Explicit non-goals: 不改变部署功能或配置协议，不为旧名称提供兼容入口，不重写历史任务证据。

## Risks
- 这是破坏性公开命名迁移；任何未同步的仓库内或外部消费者都会出现安装、导入或命令找不到的问题。
- `uv.lock`、构建产物内容、远端运行时上传文件名和测试断言必须同时更新，否则可能出现本地源码可运行但安装包或远端脚本失败。
- 历史任务文档必须与活跃契约区分，避免为了消除文本搜索结果而破坏已有生命周期哈希和审计证据。
