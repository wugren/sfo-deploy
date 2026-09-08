---
task_manifest: task.yaml
status: approved
---

# 集群脚本迁移到 Deno TypeScript 提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries:
  该变更替换远端脚本运行时和机器依赖，修改集群配置、发布快照与回退兼容契约，并把 Deno
  权限模型引入部署安全边界；同时现有脚本依赖系统命令、特权文件和网络健康检查，已确认触发
  security、runtime、dependency/deployment 与 compatibility 边界。
- Proposal and tier confirmation: 用户以“按推荐方案确认
  high-risk，自动完成”确认本提案、推荐目录语义、旧 Python 快照兼容策略，并明确启动从 design
  开始的自动流水线。

## Background and Goal

当前环境与 App 生命周期脚本必须是 `.py` 文件，由远端 Python 3 执行，并通过上传的 Python
运行时读取部署上下文。目标是把当前集群脚本契约和示例脚本迁移为 TypeScript，由远端 Deno 执行；Deno
脚本默认不能访问网络，文件读写限制在对应资源的明确目录边界内。

## Scope

### In scope

- 集群配置只接受 `.ts` 生命周期脚本，机器运行时配置和预检从 Python 迁移为 Deno。
- 将远端 `DeploymentContext` 辅助运行时迁移为 TypeScript，继续提供
  metadata、配置密钥和模板渲染能力，并维持上下文文件的最小暴露与清理语义。
- 为每个环境或 App 步骤建立确定的远端资源工作目录；Deno 直接文件 API
  仅获准读写该目录，执行时固定使用 `--no-prompt`，默认不授予
  `--allow-net`、`--allow-ffi`；确需启动的子进程使用显式可执行文件白名单。
- 更新传输、执行、发布历史/回退、错误信息、配置指南、测试夹具与 eleph-server-multipass
  示例中的脚本及运行时前置条件。
- 测试允许目录内读写、目录外读写拒绝、默认网络拒绝、运行时缺失预检失败、上下文/秘密处理、远端清理及现有部署动作语义。

### Out of scope

- 不把 Deno 权限模型描述为操作系统级恶意代码隔离；若允许外部子进程，子进程不受 Deno
  文件/网络权限完整约束。
- 不在本任务中引入容器、namespace、seccomp、微虚拟机或通用远端权限代理。
- 不增加并发执行、重试策略或新的部署动作。
- 不允许脚本通过 FFI 绕过 Deno 权限。

### Boundary with neighboring modules

配置与领域模型定义脚本类型、Deno 命令和资源目录；执行与 SSH
传输负责安全拼装权限参数、上传上下文并清理远端目录；远端 TypeScript
运行时只解析当前步骤上下文。示例部署脚本是该契约的实际消费者，发布历史负责保存足以重放的运行时绑定。

## Requirement Review

迁移到 Deno 并采用默认拒绝网络、目录白名单是合理方向，但现有部署脚本大量调用
`apt-get`、`systemctl`、`mysql`、`redis-cli` 等外部命令，还会读写
`/etc`、`/var/lib`、`/home/ubuntu/eleph-server` 并访问本机 HTTP 健康端点。授予 `--allow-run`
后，外部命令不会继承 Deno 的文件和网络限制；完全不授予 `--allow-run`
又无法保持当前部署能力。因此不能把“Deno 参数限制”直接等同于完整安全边界。

采用“资源目录默认隔离 + 权限显式声明”的迁移方向：Deno
自身始终只能读写步骤资源目录、默认无网络；确需本机网络或外部命令的动作必须在资源配置中显式列出。用户已确认子进程权限不属于本任务的控制边界，因此允许白名单子进程按目标机运行身份访问
Deno 权限范围之外的文件和网络；这项保证用于约束 Deno API
的直接访问和减少误操作，不作为对恶意集群脚本的完整安全隔离。

## Proposal Items

| proposal_id | change_id                  | requirement                                                                                      | boundary                                                   | tradeoff                                                               | success_evidence                                                            | non_goal                    |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------- |
| P-001       | CHG-deno-script-contract   | 用 Deno 执行 `.ts` 集群脚本，直接文件读写仅限每步骤资源目录，默认拒绝网络，并显式控制高风险能力  | 覆盖环境与 App 生命周期脚本、上下文、传输、历史与回退      | 外部命令无法由 Deno 权限形成完整隔离；历史 Python 快照需要明确兼容政策 | 配置/计划/传输/执行/DV/集成测试证明权限参数、拒绝路径、预检、清理和兼容行为 | OS 级恶意代码沙箱           |
| P-002       | CHG-deno-example-migration | 将 eleph-server-multipass 的 Python 生命周期脚本和文档迁移为 TypeScript/Deno，并保持示例部署结果 | 只迁移集群生命周期脚本，不迁移项目自身 Python CLI 和主框架 | 系统安装与服务管理需要外部命令；本机健康检查需要显式网络权限           | TypeScript 静态检查、脚本行为测试、Multipass 集成路径与文档契约通过         | 把整个仓库改写为 TypeScript |

## Success Criteria

- Concrete user-visible or system-visible result: 新集群只使用 `.ts` 生命周期脚本，目标机预检
  Deno；每一步以资源专属目录作为唯一直接读写白名单，未声明网络权限时 Deno
  自身的网络请求确定失败，子进程只能从显式可执行文件白名单启动。
- Required evidence: `.py` 集群脚本被配置层拒绝；`.ts` 脚本通过 Deno
  执行；目录内读写成功且目录外直接读写失败；默认 Deno 网络访问失败；`--allow-ffi`
  永不授予；未声明子进程被拒绝、已声明子进程可执行；上下文秘密、模板、制品、清理、错误分类和发布历史行为有自动化覆盖；示例脚本通过
  Deno 检查及相应集成测试。
- Explicit non-goals: 不迁移 sfo-deploy 主程序到
  TypeScript，不声称运行时权限能约束已启动的任意原生进程，不引入通用容器平台。

## Risks

- `--allow-run` 是 Deno
  沙箱逃逸边界：现有系统部署操作依赖它。用户已接受子进程不受控制，但实现仍需显式声明可执行文件并在文档中避免把直接
  API 权限误述为端到端隔离。
- “App 所在目录”在当前远端协议中不是一等配置；控制端 `apps/<name>/`
  目录不会原样存在于目标机。必须确认它是“每步骤远端暂存资源目录”还是“目标机持久应用目录”。环境脚本也没有
  App 目录，需要对应的环境资源目录定义。
- 现有示例的 `apt-get` 需要外网，App 健康检查需要访问
  `127.0.0.1:8080`；默认禁网后需要明确的逐资源/逐动作授权政策。
- 已有发布快照保存 Python 脚本与机器 `python` 字段。彻底删除 Python
  执行路径会使旧版本回退不可用；保留兼容路径则会在旧快照回退时保留旧权限模型。
- 远端必须预装兼容
  Deno，属于新的部署依赖和供应链/版本管理责任；应固定最低支持版本并对不可用或版本不兼容
  fail-closed。

## Confirmed Decisions

- “App 所在目录”按推荐方案解释为每个
  App/环境步骤在目标机上自动创建并在结束时清理的独立资源工作目录；脚本、上下文、模板和制品均暂存在该目录，持久目录及系统目录由白名单子进程操作。
- 旧 Python 发布快照保留只读兼容回退路径，并明确旧回退继续使用原 Python 权限模型；新集群配置只接受
  TypeScript/Deno。
- Deno 直接 API 的文件与网络权限受控，白名单子进程不在本任务权限保证内。
