---
task_manifest: task.yaml
status: approved
---

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale: 这是边界化重构/修正：运行时 loader
  交付机制不变，但集群模板、示例脚本封装、集成测试和文档契约必须同步调整。它影响示例构建/测试合同和公共文档示例，因此不适合
  trivial；不改变 CLI 行为、秘密安全边界、依赖图或发布流程，暂无 high-risk 触发。
- Proposal and tier confirmation: 用户已于 2026-09-04 明确确认该 standard 方案。

## Background and Goal

`sfo-secret-loader.ts` 应由 sfo-deploy 在每个需要秘密的脚本步骤上传到远端
workspace，不应作为集群模板或脚本目录中的自定义文件存在。当前 `src/execution.ts` 已按此机制从
`src/secret_loader/deno.ts` 上传真实 loader，但 `examples/eleph-server-multipass/cluster-template/`
下存在根级副本，多个脚本目录又存在薄封装副本，造成所有权不清楚。

## Scope

### In scope

- 删除 Multipass 集群模板根级 `sfo-secret-loader.ts` 与脚本目录内全部 `sfo-secret-loader.ts`
  薄封装。
- 集成测试改为从 `src/secret_loader/deno.ts` 获取 sfo-deploy 提供的 loader。
- 独立脚本契约检查新增断言：集群模板不得包含 `sfo-secret-loader.ts`。
- 更新 README、集群配置指南和 Multipass 示例文档，明确 loader 文件名只出现在远端 workspace，由
  sfo-deploy 上传；集群脚本导入 `./sfo-secret-loader.ts` 是运行时约定。
- 执行现有可定向验证，保证没有集群内 loader 副本后测试与文档契约仍通过。

### Out of scope

- 不修改 `src/secret_loader/deno.ts`、`src/secret_loader/python.py` 或 `src/execution.ts`
  的运行时上传行为。
- 不调整秘密来源 YAML、known_hosts、远端目录权限或 Deno 沙箱契约。
- 不迁移 Python 示例脚本。
- 不改变公开 CLI 或 `ProjectBindings` API。

## Requirement Review

该请求是对既有 loader 设计的边界澄清。sfo-deploy 保留 `src/secret_loader/*`
资产并在执行期上传；集群只应包含生命周期脚本、模板和配置声明。测试中的临时 workspace
需要模拟“框架上传后的远端状态”，因此从框架资产复制，而不是从集群模板复制。文档必须区分“脚本导入同目录文件名”与“集群定义该文件”，避免消费者误把
loader 提交进集群。

## Proposal Items

| proposal_id | change_id                            | requirement                                                                                        | boundary                                                             | tradeoff                                           | success_evidence                                                                                | non_goal                              |
| ----------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| P-001       | CHG-framework-provided-secret-loader | 集群模板不得定义或复制 `sfo-secret-loader.ts`；loader 由 sfo-deploy 的执行器在需要秘密的步骤上传。 | 仅调整示例集群资产、测试装配和说明性文档；框架运行时与安全契约不变。 | 测试和静态契约需要额外模拟框架上传后的 workspace。 | 契约检查发现集群内 loader 文件即失败；示例脚本集成测试改用 `src/secret_loader/deno.ts` 后通过。 | 不修改上传路径、文件名或 loader API。 |

## Success Criteria

- `examples/eleph-server-multipass/cluster-template/` 内没有任何 `sfo-secret-loader.ts` 文件。
- 示例脚本仍使用同目录相对导入 `./sfo-secret-loader.ts`，以匹配远端 workspace 布局。
- 集成测试不再从集群模板复制 loader，而是复制 `src/secret_loader/deno.ts`。
- 文档不再说“脚本文件夹内提供薄封装”，而明确说明集群不定义该文件。
- 相关单元/集成/合同验证通过。

## Risks

- 如果直接删除集群内副本而不更新测试与契约，静态编译闭包和示例脚本集成会失败；提案要求同步更新测试和文档。
- 文档读者可能误解“同目录导入”为需要自行维护 loader；必须通过契约检查和明确文案消除歧义。

## Harness Lifecycle

待用户确认 standard 方案后，按 standard
流程创建一条轻量变更记录，执行修改、定向验证、独立缺陷发现，并完成任务级 completion report。
