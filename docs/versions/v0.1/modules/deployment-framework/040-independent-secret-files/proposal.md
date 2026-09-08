---
task_manifest: task.yaml
status: approved
---

## Workflow Tier Judgment

- Risk profile: ./risk-profile.yaml
- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale: 通用 `secrets-deploy` 的秘密来源契约、本地文件密钥路径解析、集群本地 known_hosts
  发现和 Multipass 示例入口都会变化；这影响公共 CLI、安全边界和既有调用方式。
- Confirmation statement: 用户已于 2026-09-04 明确确认该 high-risk 方案。

## Background and Goal

当前 `secrets-deploy` 需要项目绑定入口构造 `ProjectBindings`，Multipass 示例因此维护
`src/cli.ts`。目标是不要求普通集群维护这类绑定脚本：通用 CLI 自动读取集群本地单一
`secrets.yaml`，同时支持值密钥和文件密钥来源。

## Scope

### In scope

- 通用 `sfo-deploy secrets-deploy` 在部署操作时自动装载 `<cluster-directory>/secrets.yaml`。
- YAML 顶层键直接使用集群声明中的密钥名，不添加 `secrets:` 包装层：

  ```yaml
  ELEPH_DB_PASSWORD: "<local-only>"
  HTTPS_PRIVATE_KEY: "files/server.key"
  ```

- `cluster.yaml` 中的 `kind: value` 表示 YAML 值是秘密值；`kind: file` 表示 YAML
  值是本地源文件路径。
- 文件路径相对于 `secrets.yaml` 所在目录解析，禁止 `..` 逃逸，部署前必须解析为普通可读文件。
- `secrets.yaml` 权限为 `0600`，拒绝未知字段、重复键和非法密钥名。
- 通用 CLI 自动发现并使用 `<cluster-directory>/known_hosts`，使普通集群无需项目绑定脚本装配传输层。
- Multipass 示例使用 `clusters/multipass/secrets.yaml`，移除对 `src/cli.ts` 构造 `ProjectBindings`
  的依赖，并删除旧 `.env`。
- 更新公共文档、示例文档和测试。

### Out of scope

- 不移除 `ProjectBindings` 公共 API；显式 TypeScript 调用者仍可使用。
- 不把 Multipass 三个既有值密钥改成文件密钥。
- 不修改集群放置目标。
- 不在文档、日志、错误或报告输出秘密明文。

## Requirement Review

`cluster.yaml` 继续承担可提交声明：密钥名、类型、放置机器。真实来源集中在未提交的
`secrets.yaml`。通用 CLI 根据 `kind` 解释顶层值；文件密钥只保存路径，实际文件仍由 `secrets-deploy`
上传到远端安全目录。这满足单文件、YAML 格式、无绑定脚本和文件密钥部署的要求。

## Proposal Items

| proposal_id | change_id                    | Requirement / 要求                                                                                                                   | Boundary / 边界                                                   | Tradeoff / 取舍                                    | Success Evidence / 成功证据                                                                              | Non-goal / 非目标                         |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| P1-1        | CHG-cluster-secret-source    | 通用 `secrets-deploy` 自动装载集群本地 `secrets.yaml`；顶层键直接对应密钥名，`kind: value` 解释为值，`kind: file` 解释为相对源路径。 | 只影响 `secrets-deploy` 部署来源；`cluster.yaml` 保持可提交声明。 | 用受保护本地 YAML 换取普通集群不需要项目绑定脚本。 | 单元/集成测试覆盖缺失、未知字段、重复键、路径逃逸、值/文件分类和部署行为；秘密明文不出现在输出或提交中。 | 不把真实秘密写入 `cluster.yaml`。         |
| P1-2        | CHG-cluster-known-hosts      | 通用 CLI 自动发现并使用集群目录内的 `known_hosts`，使普通集群无需项目绑定脚本来装配传输层。                                          | 仅在集群目录存在 known_hosts 时覆盖默认路径。                     | 减少项目绑定入口，同时保留严格主机信任。           | 测试覆盖存在、缺失、非法路径和回退行为；Multipass 示例使用生成目录中的 known_hosts。                     | 不移除显式 `RunDependencies.knownHosts`。 |
| P1-3        | CHG-multipass-no-binding-cli | Multipass 示例不再通过 `src/cli.ts` 构造 `ProjectBindings`；配置来源为 `secrets.yaml`，命令入口为通用 CLI。                          | 只改变示例入口与文档，不改集群资源脚本。                          | 移除示例专用 API 入口，减少无关预检和重复逻辑。    | 示例任务和文档更新；`secrets-deploy --check` 可通过通用 CLI 执行，无 JAR 无关预检阻断。                  | 不移除 `ProjectBindings` 公共 API。       |

## Success Criteria

- 通用 `sfo-deploy secrets-deploy --cluster multipass` 能自动装载
  `clusters/multipass/secrets.yaml`。
- YAML 只包含预期顶层密钥名，权限为 `0600`，没有未知字段、重复键或额外包装层，且被 Git 忽略。
- `kind: file` 路径按 YAML 所在目录解析，拒绝 `..` 逃逸，并在 SSH 前校验为普通可读文件。
- 通用 CLI 自动使用 `clusters/multipass/known_hosts`。
- Multipass 示例命令不再调用 `src/cli.ts` 构造 `ProjectBindings`。
- 仓库原生测试覆盖行为并全部通过；旧 `.env` 不再存在。

## Risks

- `secrets.yaml` 包含明文值和文件路径；通过 `0600`、Git
  忽略、严格字段校验、路径逃逸拒绝和不输出明文降低风险。
- 通用 CLI 自动读取本地秘密是信任边界变化；必须在 SSH 前解析，失败关闭，且不将值写入日志或错误。
- 自动发现 `known_hosts` 影响默认 SSH 信任行为；仅在集群目录存在该文件时启用，并在文档中明确优先级。
- 移除示例绑定脚本影响现有使用方式；需要同步更新 README、示例命令和集成测试。

## Harness Lifecycle

用户已确认 high-risk 方案。确认后创建
`risk-profile.yaml`，完成设计、实现、测试、生命周期检查和独立验收报告。
