---
task_manifest: task.yaml
status: approved
---

# 实时集群配置脚本完整迁移到 TypeScript 提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries:
  本任务会修改实际可部署集群中的生命周期脚本、脚本运行时配置、Deno 权限声明和目标机部署行为，涉及
  deployment、runtime、security 与 compatibility
  边界；遗漏或错误迁移可能导致现有集群配置无法部署或以错误权限运行。
- Proposal and tier confirmation: 用户以“确认，自动完成”确认本提案和 high-risk 等级，并明确启动从
  design 开始的自动流水线。

## Background and Goal

上一任务已把规范模板和执行器迁移到 Deno TypeScript，但检查发现实际生成的
`examples/eleph-server-multipass/clusters/multipass` 仍保留 21 个 Python 生命周期脚本及旧 YAML
引用。本任务要补齐该遗漏，确保所有实时集群配置中的环境与 App 生命周期脚本统一为
`.ts`，并按已经确认的 Deno 权限契约执行。

## Scope

### In scope

- 扫描并迁移所有 `examples/**/clusters/**` 实时集群配置中的生命周期 `.py` 脚本为等价 `.ts` 实现。
- 更新对应 App、环境和机器 YAML，使脚本对象、Deno 运行时及 `run`/`net` 权限声明与规范模板一致。
- 保持现有集群的变量、秘密引用、节点地址、部署顺序、服务配置、健康检查和回滚语义不变。
- 对迁移后的 TypeScript 脚本执行 Deno 静态检查和行为测试，并增加仓库检查，阻止实时集群目录重新出现
  Python 生命周期脚本或旧式 YAML 引用。
- 核对集群生成路径；只有在发现生成逻辑仍会产生旧配置时，才同步修正该逻辑及其测试。

### Out of scope

- 不改写 `.harness/baselines/**`、历史发布证据、已完成任务包或其他不可变快照。
- 不删除为旧版发布计划解码、回滚兼容或负向校验而保留的 Python 测试夹具。
- 不把 sfo-deploy 控制程序、普通测试代码或非生命周期工具脚本迁移到 TypeScript。
- 不改变已确认的权限边界：Deno
  直接文件访问仅限步骤工作目录、默认禁止直接网络访问；获准启动的子进程不受 Deno 权限完整约束。

### Boundary with neighboring modules

实时集群配置消费上一任务已建立的 TypeScript/Deno
合同。本任务以配置和脚本内容同步为主；执行器、计划格式和历史兼容层只有在验证暴露真实缺陷时才进入修复范围。历史证据不参与实时配置一致性判定。

## Requirement Review

将所有实时集群配置与规范模板同步是必要且合理的补漏。不能简单全仓删除 `.py`，因为控制程序本身仍是
Python，旧版计划兼容测试也需要保留 Python 夹具；正确边界应是可部署的
`examples/**/clusters/**`。迁移应以规范模板为语义来源，对每个实时脚本逐项比对，避免只改扩展名或 YAML
引用而丢失服务操作、配置渲染和健康检查行为。

## Proposal Items

| proposal_id | change_id                      | requirement                                                                    | boundary                                                  | tradeoff                                                     | success_evidence                                                                               | non_goal                     |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| P-001       | CHG-live-cluster-ts-migration  | 把所有实时集群配置中的 Python 生命周期脚本及旧 YAML 引用迁移到 TypeScript/Deno | 仅覆盖可部署的 `examples/**/clusters/**` 及必要的生成逻辑 | 必须保留集群实例的现有参数和秘密，不能用重新生成覆盖本地状态 | 实时集群目录无生命周期 `.py`，YAML 使用 `.ts` 脚本对象和 Deno 配置，全部脚本通过静态及行为验证 | 改写历史基线和旧计划兼容夹具 |
| P-002       | CHG-live-cluster-ts-regression | 增加检查，保证以后生成或提交的实时集群配置不再残留 Python 生命周期脚本         | 检查部署配置合同，不禁止仓库中的一般 Python 文件          | 会增加示例配置变更时的测试约束                               | 回归测试能识别 `.py` 生命周期脚本、旧字符串脚本声明或缺失的 Deno 机器配置                      | 禁止所有 Python 文件         |

## Success Criteria

- Concrete user-visible or system-visible result: 仓库内每个实时 `examples/**/clusters/**`
  集群只使用 TypeScript 生命周期脚本，并可由当前 Deno 执行器按既定权限运行。
- Required evidence: 实时集群目录扫描无生命周期 `.py`；全部相关 YAML 引用 `.ts`
  且权限声明有效；所有迁移脚本通过
  `deno check`；脚本行为、配置解析、部署计划和防回退测试通过；秘密、私钥、known_hosts、节点地址及其他实例状态没有被重置或意外改写。
- Explicit non-goals: 不清理历史快照中的 `.py`，不移除 v1 Python 回滚兼容，不迁移仓库主程序到
  TypeScript。

## Risks

- 实时集群目录可能包含由用户环境生成的密钥、主机指纹、地址或秘密；迁移必须逐文件修改脚本合同，不能用模板目录整体覆盖。
- TypeScript 脚本与 Python 脚本存在行为偏差时，安装、配置、启动、停止、健康检查或卸载动作可能失败。
- 权限清单过窄会阻断合法部署，过宽会削弱默认拒绝目标；应与规范模板逐动作比对并以测试证明。
- 若只修当前目录而没有防回退验证，旧生成路径或复制流程可能再次产生 Python 脚本。
