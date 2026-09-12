---
task_manifest: task.yaml
status: approved
---

# App 安装目录变量与 jx-server 配置目标

## Workflow Tier Judgment
- Proposed tier: high-risk
- Final tier: high-risk
- 理由：新增公开 app.yaml 路径引用语义，直接决定配置写入位置，需验证路径边界、旧配置兼容及版本部署/独立 configure 的不同解析结果。
- 提案及层级确认：用户确认“确认，自动完成”，同意按 high-risk 自动完成本任务。

## Background and Goal
jx-server 已有 application.yml 和 application-local.yml，需部署到 JAR 所在版本目录的 resources 子目录。目前 config.target 只接受绝对路径，重复写入安装目录，修改 install_directory 时容易遗漏。提供来自 App 声明的安装目录变量，使路径只配置一次。

## Scope
- App managed config 的 target 支持以 ${INSTALL_DIRECTORY}/ 开头的路径；变量展开为包含当前或待部署 App 版本目录的绝对路径，例如 `<install_directory>/<version>/resources/application.yml`。
- 部署继续沿用 069 的 latest 到候选版本映射和切换顺序；独立 configure 写入当前 latest。
- 更新本地 Multipass jx-server 两个配置 action，保留现有业务配置、权限与 Java 加载参数；同步示例说明与相关配置技能文档。模板缺少业务 YAML 时不复制本地敏感内容，不编造可运行业务配置。
- 不提供任意 Shell 环境插值，不改变配置内容中的秘密变量语义，不新增版本变量，不改变服务 args 的字面值语义。
- 不执行 SSH、fetch 或部署，不修改机器、版本、制品或业务 YAML 内容。

## Requirement Review
- 内置变量满足用户希望安装位置易于表达的意图；框架统一取值，避免控制机环境变量覆盖远端安装路径。
- 现有绝对 target 保持兼容；使用新变量而缺少 install_directory 时在本地报错。展开后仍执行路径安全与重复目标检查。
- 目标 resources 目录沿用现有必须存在的约束，缺目录在 latest 切换前失败；本任务不引入自动创建任意父目录。
- 待澄清问题：无；变量名称和限定作用域随本提案确认。

## Proposal Items
| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-install-directory-variable | config.target 支持安装目录内置变量并保持绝对路径兼容 | App 配置装载与路径验证 | 限定为路径前缀，不做全局字符串或 Shell 展开 | 展开、缺声明、非法路径、展开后重复目标测试 | 不注入服务环境变量 |
| P-002 | CHG-install-directory-variable | jx-server 两个 YAML 指向 `${INSTALL_DIRECTORY}/resources` | 现有本地配置及示例说明 | deploy 定位候选版本，configure 定位当前版本 | 本地 validate/plan 与任务级部署路径回归 | 不执行真实部署，不复制业务秘密 |

### 拟交付的目标写法
```yaml
install_directory: /home/ubuntu/eleph-server
# management.actions 中两个配置项分别使用：
# target: '${INSTALL_DIRECTORY}/resources/application.yml'
# target: '${INSTALL_DIRECTORY}/resources/application-local.yml'
```

## Success Criteria
- 只修改 install_directory 即可改变版本发布根目录和两个 YAML 的安装路径，无须重复硬编码绝对目录。
- deploy 将 `INSTALL_DIRECTORY` 展开为待部署版本目录，并把配置写入该版本的 resources；独立 configure 将其展开为当前版本目录。
- 路径边界、旧绝对路径兼容、本地 jx-server validate/plan 和针对性测试通过；不以本地验证冒充实际业务启动验证。
- 示例说明明确业务文件来源和父目录前提，保留工作区其他任务改动。

## Risks
- 错误展开会改变远端配置写入位置，必须在配置装载时验证并在发布时沿用真实路径边界检查。
- 同版本更新仍直接修改当前版本配置，沿用 069 恢复行为。
- 真实制品是否包含 resources 及远端 Java 服务能否启动需实际部署验证，本任务不执行。
- Risk profile: ./risk-profile.yaml
