---
task_manifest: task.yaml
status: approved
---

## Workflow Tier Judgment

- Proposed tier: high-risk
- Risk profile: ./risk-profile.yaml
- Final tier: high-risk
- Tier rationale: 当前规划器强制要求环境和 App 的 `configure` 动作；若 Multipass 资源不声明
  `configure`，部署会失败。本任务要改变框架生命周期规划，使 `configure`
  成为可选动作，并按用户修订直接删除示例中的初始化/认证/unit/版本选择逻辑。该变化影响
  部署生命周期、集群配置契约和 Multipass 部署结果，因此建议 high-risk。
- Confirmation statement: 用户已于 2026-09-04 明确确认本 high-risk 方案，并授权修正 041 任务清单的
  YAML 格式以解除任务注册阻塞。

## Background and Goal

用户修订了范围：Multipass 集群中的环境和 App 都不使用 `configure.ts`；MySQL 初始化、 Redis
认证、systemd unit 安装和 Java 版本选择也不再由 sfo-deploy 示例负责；`jx-runtime` 环境整体删除。

当前框架要求 `configure` 存在，因此直接删除会使部署失败。目标不是把这些职责迁移到
install/deploy，而是让框架接受省略 `configure` 的资源，并按修订后的 Multipass 意图移除
相关脚本、模板、资源依赖和检查假设。

## Scope

### In scope

- 将环境/App 的 `configure` 动作从强制项改为可选项：没有定义时规划器不生成该步骤，而不是失败。
- 调整 Multipass 模板和生成集群：
  - 删除全部环境/App `scripts/configure.ts`，并从 YAML 移除 `scripts.configure`。
  - 删除 `jx-runtime` 环境目录及其集群放置。
  - 将 `jx-server` 的依赖改为直接依赖 `jre`、`mysql`、`redis`。
  - 删除不再被引用的 `jx-server.service` 和 `application.yml.tpl`。
  - 移除资源中仅服务于被删除 configure 的 `secret_values` 声明。
  - 调整 `mysql` check，使其不再要求 schema、数据库账号或初始化标记；只检查安装和 MySQL 服务可用。
  - 调整 App deploy，使其不再要求或打包 `application.yml`。
- 同步更新框架规划/执行测试、Multipass 脚本测试和文档。

### Out of scope

- 不删除其他集群已声明的 `configure` 动作；既有显式配置仍应继续工作。
- 不为 Multipass 重建数据库初始化、Redis 认证、systemd unit、Java alternatives 或应用配置。
- 不改变秘密部署机制本身；但 Multipass 示例不再通过 configure 消费这些秘密。
- 不修改 Multipass VM 创建流程。

## Requirement Review

请求是明确的功能裁剪：`configure` 对通用框架仍有价值，但不应强制存在；Multipass 示例
不再负责应用级初始化和主机配置。该方向会改变示例的部署结果，但边界清楚。

## Proposal Items

| proposal_id | change_id                        | Requirement / 要求                                                                                          | Boundary / 边界                                                   | Tradeoff / 取舍                                                                | Success Evidence / 成功证据                                              | Non-goal / 非目标                   |
| ----------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------- |
| P-001       | CHG-optional-multipass-configure | 资源可以省略 `configure`；Multipass 示例不再包含任何 `configure.ts`，且删除 `jx-runtime` 及相关初始化职责。 | 允许省略但不移除既有 configure 支持；被删除职责不迁移到其他脚本。 | 示例部署更简单，但不再交付数据库 schema、Redis 认证、应用配置和 systemd unit。 | 配置校验通过；Multipass 计划不含 configure 和 jx-runtime；定向测试通过。 | 不破坏其他集群的 configure 兼容性。 |

## Success Criteria

- `sfo-deploy validate` 接受没有 `scripts.configure` 的 Multipass 集群。
- `prepare --env redis` 的计划只包含安装/启动相关步骤，不再包含 `configure`，也不再写入 Redis 认证。
- MySQL 准备不再创建数据库、账号或 schema；检查不再要求初始化标记。
- Java 准备只安装包，不再切换 alternatives；App 部署不再生成、检查或打包 `application.yml`。
- `jx-runtime` 从集群定义、资源目录和依赖图中删除；`jx-server` 直接依赖 `jre`、`mysql`、`redis`。
- 模板和 `clusters/multipass` 中都不存在 `configure.ts`。
- 相关单元/集成/合同测试通过。

## Risks

- 生命周期规划是框架公共行为；可选 configure 需要保留向后兼容并覆盖依赖步骤编号。
- 删除初始化后，Multipass 示例部署出的数据库、Redis 和 App 可能需要调用者自行配置才能完整运行。
- 删除 `jx-runtime` 会改变依赖顺序和现有文档/测试契约。
- 既有 041 任务清单存在无效 YAML，会阻塞新任务注册；需要单独修正格式后才能完成 Harness 注册。

## Harness Lifecycle

待用户确认后创建 `risk-profile.yaml`，按 design → implementation → testing → acceptance
完成完整生命周期证据。
