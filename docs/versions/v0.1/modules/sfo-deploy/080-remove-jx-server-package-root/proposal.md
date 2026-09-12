---
task_manifest: task.yaml
status: approved

Risk profile: ./risk-profile.yaml
---

# Proposal：内置 versioned 发布缺省剥离单顶层包目录

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 当前 jx-server 制品的 tar.gz 只有一个顶层目录
  `server/`，jx-web 制品只有一个顶层目录 `web/`；内置 versioned 发布会原样复制到版本
  目录。用户明确要求将“剥离唯一顶层目录”作为缺省行为，而不是新增 App 配置字段。该默认
  规则会改变所有内置 versioned 包的布局契约，并同步 Multipass 配置、契约和文档。这直接影响
  部署布局、服务/载荷路径、配置目标和真实部署/回滚验证，属于 deployment 与 rollback 语义的
  高风险变更，因此选择 high-risk。
- Proposal and tier confirmation: 用户于 2026-09-11 确认修订后的缺省 strip-single-root
  提案并选择 `high-risk`；授权完整设计、实现、测试、独立验收、真实 Multipass 复验与收尾。

## Background and Goal

用户要求去掉 Multipass 集群中 jx-server 发布目录里的 `server` 一级目录，并同步去掉
jx-web 发布目录里的 `web` 一级目录。当前已下载并校验过的 jx-server 制品成员全部位于
`server/` 下，例如 `server/jx-server.jar`、`server/lib/`；jx-web 制品成员全部位于
`web/` 下。框架内置发布把制品复制到版本目录后，路径因此多出一层。只修改 `app.yaml`
把 jx-server 工作目录改为 `latest` 会让服务找不到 JAR；jx-web 也必须先安全提升目录。

目标是让 jx-server 新版本在远端以如下布局发布并启动：

```text
/home/ubuntu/eleph-server/
  <version>/
    jx-server.jar
    lib/
    resources/
  latest -> <version>
```

jx-web 同样使用：

```text
/home/projects/ui/
  <version>/
    index.html
    favicon.ico
    static/
  latest -> <version>
```

## Scope

### In scope

- 将“剥离唯一顶层目录”作为内置 versioned 发布的缺省行为：安全解包后，若整包只存在一个
  顶层普通目录且顶层没有普通文件、符号链接或其他目录，把该唯一目录内容提升为版本根。
- 多顶层成员或平铺包保持既有逐成员原样布局，不猜测、不重排；异常成员仍走既有失败关闭路径。
- 调整 Multipass live `apps/jx-server/app.yaml`：工作目录改为 `latest`，JAR 参数改为
  `jx-server.jar`，受管配置目标改为 `${INSTALL_DIRECTORY}/resources/...`。
- jx-web 静态载荷随默认规则直接位于 `/home/projects/ui/latest/`；同步服务声明与 README
  中的载荷路径契约。
- 更新集成契约中 jx-server 的 `jx-server.jar`/`resources` 断言和 jx-web 的顶层载荷断言。
- 增加单元/集成测试覆盖：显式启用提升、未启用保持原布局、多顶层/平铺/异常包失败关闭、
  提升后配置父目录创建/发布仍安全。
- 在 multipass `eleph-server` 上重新部署 jx-server 和 jx-web，验证新版本路径、服务启动和
  配置发布。

### Out of scope

- 不新增 `deployment.package_layout` 或任何 App 配置字段。
- 不重新构建或修改 jx-server/jx-web 业务代码；不改变制品哈希、来源、版本号或业务运行参数。
- 不自动清理远端历史版本目录中的旧 `server/` 布局；旧版本按现有 `keep_versions` 保留策略处理。
- 不放宽 App 包成员数量、展开总量、绝对路径、`..`、符号链接、设备文件、重复成员等安全边界。
- 不修改 jx-server 服务命名、systemd 收敛策略、回滚算法或下载/哈希验证语义。
- 若真实部署暴露不依赖本目标的独立缺陷，停止并单独处理，不默认扩权。

## Requirement Review

请求合理：`server` 和 `web` 不是框架生成的版本层，而是各自制品唯一的顶层目录。当前本地
缓存中的包列表证实了这一布局。将其作为缺省行为符合“发布载荷应为版本根”的直觉，且不需要
为每个 App 重复声明同一种布局约定。

备选方案与取舍：

- 方案 A（选定）：把“唯一顶层普通目录”剥离作为缺省行为，并在多顶层成员或平铺包时保持原布局。
  jx-server/jx-web 既有制品不需要重新发布或改变哈希，调用方也不需要新增声明；代价是
  versioned 发布契约出现隐式默认，必须用测试严格固化。
- 方案 B：在 `deployment.package_layout` 下提供显式 opt-in。兼容面更小，但用户明确指出这是
  缺省配置，不应要求每个 App 重复声明。
- 方案 C：要求发布方重新打包为平铺制品，然后只改配置。框架改动最小，但当前制品无法立即
  生效，且需要制品仓库/打包流程变更。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-remove-jx-server-package-root | 内置 versioned 发布缺省剥离唯一顶层普通目录。 | 仅在安全解包后的包满足严格单顶层目录条件时生效；多顶层、平铺或异常包保持既有原样布局/失败关闭。 | 默认布局契约成为隐式行为；换取既有 `server/` 和 `web/` 制品无需重打包，也无新增 App 字段。 | 单元/集成测试覆盖默认提升、多顶层保留、平铺保留和异常边界；旧实现下新测试失败。 | 不放宽 tar 安全校验。 |
| P-002 | CHG-remove-jx-server-package-root | Multipass jx-server 使用 `latest/jx-server.jar` 和 `latest/resources/`。 | 仅 jx-server live 配置与对应契约/文档。 | 与平铺布局对齐；旧历史版本不迁移。 | validate/plan 通过；契约断言与远端实际路径一致。 | 不清理旧版本目录。 |
| P-003 | CHG-remove-jx-server-package-root | Multipass jx-web 载荷直接位于 `/home/projects/ui/latest/`。 | 由默认布局规则覆盖，并同步 live/template 配置与对应契约/文档。 | 消除 web 层后静态路径更直接；需要同步所有路径消费者和契约。 | validate/plan 通过；集成断言确认 `latest/index.html` 而非 `latest/web/index.html`。 | 不迁移旧版本目录。 |
| P-004 | CHG-remove-jx-server-package-root | 真实 Multipass 部署后的服务/载荷从无顶层制品目录的路径启动。 | 真实部署按用户授权改动目标机当前应用状态；失败走既有补偿。 | 真实验证耗时且有目标机状态变化，但能确认端到端布局。 | 远端 `latest` 下直接存在 `jx-server.jar`/`resources/` 和 `index.html`，无 `server`/`web` 层；部署成功。 | 不保证业务应用自身健康之外的服务承诺。 |

## Success Criteria

- Concrete user-visible or system-visible result: 新部署的 jx-server 不再有
  `/home/ubuntu/eleph-server/latest/server` 这一层，服务实际工作目录为
  `/home/ubuntu/eleph-server/latest`，并直接运行 `latest/jx-server.jar`；新部署的 jx-web
  不再有 `/home/projects/ui/latest/web` 这一层，入口文件位于
  `/home/projects/ui/latest/index.html`。
- Required evidence: 相关单元/集成/契约测试通过；本地 validate/plan 通过；真实 Multipass
  部署日志成功，并复核远端 `latest/jx-server.jar`、`latest/resources/`、
  `/home/projects/ui/latest/index.html` 存在，且新版本无 `server`/`web` 层。
- Explicit non-goals: 不迁移、不删除历史版本；不改变制品哈希或业务包内容；不自动处理无关
  目标和独立缺陷。

## Risks

- 布局提升语义若扩大到多顶层包或异常包，可能误改制品布局；将用严格“唯一顶层普通目录且无
  其他同层成员”的判定和测试约束。
- 提升后的相对路径变化可能影响运行时或配置发布；将同步 App YAML、契约测试并在真实环境复验。
- 部署失败可能影响目标机当前版本；依赖既有 stage/activate 补偿与回滚机制，并在提案确认后
  做 high-risk 完整测试与独立验收。
- 当前工作树已有未完成任务和大量改动；本任务必须只触碰本提案声明的路径，避免与 079 验收混叠。
