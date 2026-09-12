---
task_manifest: task.yaml
status: approved
---

# sfo-deploy Proposal

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment
- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务修复 versioned App 部署的运行时发布路径、受管配置事务和远端目录边界；属于部署/回滚面与安全边界影响，默认触发高风险。
- Proposal and tier confirmation: 当前用户已在会话中确认按 `high-risk` 执行；批准覆盖设计、实现、验证、独立验收与收尾。

## Background and Goal
用户执行 `sfo-deploy deploy --cluster multipass ...` 时，`app:eleph-server/jx-server:stage` 失败，错误为“配置目标父目录不存在 `/home/ubuntu/eleph-server/0.1.0/resources`”。原因是内置 `stage` 已创建版本目录并复制制品，但制品未包含真实的 `resources/` 目录；后续发布受管配置前先要求父目录存在。这使受管配置无法自动建立其版本内父目录，并将一个常见合法新版本布局误判为失败。

目标是让 versioned `stage`/`activate` 的受管配置能在已验证的版本目录内自动创建缺失父目录，同时保持防目录逃逸、防符号链接逃逸和事务恢复语义。

## Scope
### In scope
- `OpenSshTransport.publishManagedConfigs` 中针对带 `releaseRoot` 的目标目录的校验与准备。
- 仅当 `releaseRoot` 存在且是非符号链接目录、目标路径限定在 `releaseRoot` 内时，创建缺失的目标父目录。
- 保持无 `releaseRoot` 的受管配置现有“父目录必须存在”行为不变。
- 增加覆盖普通缺失父目录、安全创建、边界拒绝和已存在父目录行为的测试。
- 同步 README、模块边界与集群配置技能参考，移除已过时的“制品必须包含空 resources 目录”要求。

### Out of scope
- 不修改用户制品打包流程，也不把制品缺少某个业务目录硬编码为例外；仅同步说明“必须预先包含 resources 目录”的旧契约。
- 不自动创建 `releaseRoot` 外的目录，不放宽符号链接、目录逃逸或用户身份边界。
- 不改变 stage/activate 顺序、latest/marker 事务或配置候选生成逻辑。

### Boundary with neighboring modules
`src/execution.ts` 继续负责生成 `releaseRoot` 和目标映射；本任务只修正远端发布器在既有版本目录内准备配置父目录的行为。

## Requirement Review
请求合理：受管配置目标位于新版本目录内时，父目录应该由部署框架创建，而不是要求每个制品都预先放置一个空目录。若所有受管配置只按 `latest/resources/...` 声明并映射到本次版本，则对已验证版本目录内的路径做受限自动补全是安全且必要的。

主要权衡是安全性与易用性。无条件 `mkdir -p` 可能跟随符号链接或创建越界目录；因此修复必须先沿用/强化 `releaseRoot`、目标规范路径和真实父目录边界校验，再仅创建确定处于版本目录内的缺失父目录。这样不会破坏现有逃逸拒绝测试。

## Proposal Items
| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
|-------------|-----------|-------------|----------|----------|------------------|----------|
| P-001 | CHG-versioned-config-parent | versioned 受管配置发布可创建版本目录内缺失的父目录 | 只在 `releaseRoot` 普通目录校验通过且目标父目录解析不出逃逸时创建 | 自动补全易用性换取严格的事前路径检查 | 针对缺失 `resources/` 的受管配置发布测试成功，且逃逸/符号链接用例仍失败拒绝 | 不创建 `releaseRoot` 外目录 |
| P-002 | CHG-versioned-config-parent | 修复后命令应完整通过配置生成、校验与定向测试 | 不改变 CLI 输入契约 | 无 | `deno task check`、`deno task fmt --check`、`deno task lint` 与相关 Deno 测试通过 | 不在提案阶段执行真实 SSH 部署 |

## Success Criteria
- Concrete user-visible or system-visible result: JAR/JX 制品不含 `resources/` 时，versioned `stage` 可以成功发布版本内受管配置；`activate` 仍按既有依赖和事务流程执行。
- Required evidence: 集成/端到端 Deno 测试证明新版本目录内的父目录被创建；安全边界测试证明越界、符号链接逃逸和 `releaseRoot` 异常仍被拒绝；标准静态检查通过。
- Explicit non-goals: 不要求用户重新打包以加入空 `resources/`；不自动执行 Multipass SSH 部署作为验收；不修改示例业务配置。

## Risks
- 远端安全风险：自动建目录若先于路径校验或跟随符号链接，可能写入应用或账户可篡改位置。缓解：沿用“先校验 releaseRoot 与目标范围，再建目录；目标存在且为符号链接/非普通文件仍拒绝”的顺序，并新增回归测试。
- 事务/回滚风险：多配置发布时前几个目录可能已创建。缓解：保持现有 `ManagedConfigPublicationError`/恢复语义；目录创建属于版本目录准备，不回滚版本目录本身。
- 兼容性风险：普通受管配置可能依赖父目录不存在时报错。缓解：无 `releaseRoot` 行为不变，带 `releaseRoot` 的行为限于版本内路径。
