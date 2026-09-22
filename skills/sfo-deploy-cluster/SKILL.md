---
name: sfo-deploy-cluster
description: 创建和维护 sfo-deploy 集群配置项目，支持初始化集群目录、添加 environment 环境定义及机器放置、添加带包或无包 app 及版本/配置/服务管理。用户要求编写 sfo-deploy 集群配置时使用。
---

# sfo-deploy 集群配置

交付符合 sfo-deploy
配置模型的项目文件。使用中文解释配置决策，保留用户给定的集群名、机器、目录和应用约定。

## 选择任务

- **初始化项目**：阅读 [项目和放置](references/project.md)，从 `assets/cluster/` 生成
  `clusters/<集群名>/`。替换示例机器和地址，创建 `environments/`、`apps/`；将
  `assets/project.gitignore`
  的规则合并到项目忽略文件。多个集群分别自包含，不共享相对路径指向目录外的脚本或模板。
- **添加 environment**：阅读 [环境配置](references/environment.md)
  和项目放置规则。添加共享定义、必要生命周期脚本，并合并 `cluster.yaml.environments`。`environment`
  在此表示 nginx/JRE/MySQL 等机器运行依赖；不要把 dev/prod 集群误当作此类运行依赖。
- **添加 app**：阅读 [应用配置](references/app.md)
  和项目放置规则。按带包发布或无包配置选择模板，同时维护 `cluster.yaml.apps` 和
  `app_versions.yaml`。
- **配置秘密**：仅在实际需要时阅读 [秘密与模板](references/secrets.md)。

## 执行约束

先查看目标目录已有配置，再编辑。增量添加只合并相应键，不覆盖其他机器、放置、版本、脚本及注释；同名定义先比对，兼容时补充目标，冲突时呈现具体差异并取得必要输入。读取所有被依赖环境，确认目标机器上实际存在。

以目标项目使用的 sfo-deploy 实现为准。本技能按 v0.1 的 cluster v2、environment/machines/app_versions
v1 和 app v4 整理；旧 app v2/v3 可以继续保留，添加 app 不意味着迁移所有既有应用。源码可用时核对
`src/config.ts`、`src/types.ts`、`src/planning.ts` 和 CLI
帮助；源码与旧教程冲突时遵循源码及实际校验结果。

缺少不影响其他文件生成的信息时，先生成可审阅部分并列明缺项。实际部署必需的机器、账号、OS/安装方式、服务启动命令、包版本/来源/哈希不能虚构。示例
IP
和业务路径必须按请求替换；制品信息未知时将版本记录保留为明确的待补草稿，不写全零摘要伪装有效配置，不声称已通过校验。

模板是可编辑的起点，不是通用安装器。仅复制当前任务需要的模板；不执行模板中的安装或服务命令。生成配置的授权不自动包含
SSH、fetch、prepare、secrets-deploy、deploy 或服务操作；用户另有明确授权时按该授权处理。

## 本地验证与交付

从生成项目根目录运行（`--config-root` 指向包含集群目录的父目录）：

```bash
sfo-deploy validate --config-root ./clusters --cluster production
sfo-deploy plan --config-root ./clusters --cluster production
```

若使用源码入口，将 `sfo-deploy` 替换为
`deno run --allow-read --allow-env /实际仓库/src/main.ts`。如果 Deno
依赖尚未缓存，装载源码依赖可能访问网络；这两项动作不连接部署节点。仅当用户授权后才运行其他部署动作。

空集群或仅含 environment 时，validate 应成功；plan 会以配置错误（退出码
2）报告“过滤条件没有选择任何部署对象”，这是当前没有 app 的预期边界，不应为通过 plan 而添加虚假
app。添加 app 后再要求 plan 成功。

核对 validate 结果、app_versions.yaml 中的版本，以及 plan 中的机器、app 和服务动作（CLI plan
不展示版本字段）。`plan` 预览 deploy，当前 deploy 不执行环境安装/检查，因此 plan
没有环境步骤不代表漏配：还应检查共享环境定义、每机依赖闭合和脚本权限；可用 `deno check`
检查自包含脚本。不要用 validate/plan 通过证明实际服务可运行、包可下载或环境已安装。

有条件时在临时副本中先验证再合并。失败时修正本次生成内容，保留用户原有文件；若缺少真实输入，准确说明未完成的校验。最后给出产物路径、修改的放置/依赖、实际验证结果及待补部署输入，不只返回配置建议。
