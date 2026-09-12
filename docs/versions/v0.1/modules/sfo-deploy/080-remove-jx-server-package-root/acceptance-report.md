# sfo-deploy 验收报告

## Findings

| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
|----|----------|--------------|----------------------|----------|---------|----------|
| F-001 | none | none | requirement-and-behavior | `multipass exec` 读取的 `journalctl -u jx-server.service`、`systemctl is-active jx-server.service=failed`，以及 `src/remote_runtime/versioned_release.ts` 布局逻辑 | jx-server 进程启动后因业务类 `com.sandu.schema.SchemaMaintenanceInitializer` 缺少默认构造器退出；这是业务制品运行时缺陷，不影响本次发布布局和文件路径 | no |
| F-002 | none | none | state-and-data-integrity | `examples/eleph-server-multipass/clusters/multipass/app_versions.yaml`、远端 `.jx-server.version=0.1.2` 与 `.jx-web.version=0.1.2` | 为避免同版本跳过 stage，部署标签从 0.1.1 提升为 0.1.2；filehub source 和 SHA-256 仍指向 0.1.1 制品 | no |
| F-003 | none | none | overall | `tests/integration/versioned_release.test.ts`、发布 ID `r20260911T034012903832Z-08da2d33d7d7708e` 和 `r20260911T034120984487Z-8028c3062672b215` | 未发现阻塞布局缺陷 | no |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-11
- In-scope implementation: `src/remote_runtime/versioned_release.ts` 的缺省单顶层目录剥离；jx-server/jx-web Multipass 配置、README 和集成契约同步。
- Review mode: independent falsification review，先读取提案、实现、测试和远端证据，再形成结论。

## Requirement Coverage

| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
|-----------|-------------------------|--------|-------------------------|---------|--------|
| CHG-remove-jx-server-package-root | 缺省剥离安全解包后唯一顶层普通目录；多顶层/平铺保留 | `proposal.md` P-001 | `src/remote_runtime/versioned_release.ts#resolveSingleRootPayload`、`tests/integration/versioned_release.test.ts` 的 unique-root 与 multiple-top-level 用例 | 未发现需求缺失；保守分支不会误改包布局 | pass |
| CHG-remove-jx-server-package-root | jx-server 新版本直接使用 `latest/jx-server.jar` 和 `latest/resources/` | `proposal.md` P-002 | live `apps/jx-server/app.yaml`、`tests/integration/versioned_release.test.ts#Multipass apps use builtin layout and service`、远端 `latest/jx-server.jar` 与 `latest/resources` 检查 | 配置、测试和远端路径一致 | pass |
| CHG-remove-jx-server-package-root | jx-web 新版本载荷直接位于 `latest/index.html` | `proposal.md` P-003 | live/template `apps/jx-web/app.yaml`、README、远端 `latest/index.html` 和 `web-layer=absent` 检查 | 配置、文档和远端路径一致 | pass |
| CHG-remove-jx-server-package-root | 真实 Multipass 部署后的服务/载荷路径无顶层制品目录 | `proposal.md` P-004 | deploy 返回 succeeded；远端 `readlink`、`find`、`test ! -e server/web` 证据 | 布局变更生效；应用自身运行失败为独立外部缺陷 | pass |

## Independent Defect Discovery

| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
|----------|------------------|--------------------|-------------------|----------------------------------|--------|
| requirement-and-behavior | versioned 发布布局与 Multipass 路径 | 提案 P-001–P-004、`src/remote_runtime/versioned_release.ts`、jx-server/jx-web 配置、远端 latest 目录 | 检查是否误将需求缩小为改配置或引入新的 App 字段；核对同版本跳过与新版本发布路径 | 未发现缺失；jx-server 应用启动失败源于业务类构造器，而不是布局变更 | pass |
| logic-and-control-flow | `resolveSingleRootPayload` 分支 | `Deno.readDir` 枚举、`length === 1`、`isDirectory`/`isSymlink`、安全名称正则、复制源替换 | 尝试推导多顶层、平铺、目录加文件、隐藏文件和符号链接的分支 | 多于一项或非普通目录都返回原包；未发现错误分支 | pass |
| boundary-and-input | packageInput 顶层成员 | `canonicalInnerMember` 既有安全校验、`PAYLOAD_ROOT_RE`、集成包夹具 | 检查空目录、异常目录名、顶层符号链接和超出限制的包成员 | 非法成员仍由 transport 失败关闭；顶层异常名由 runtime 拒绝 | pass |
| state-and-data-integrity | 版本目录、latest、marker | `stageRelease`/`activateRelease`、DV stage/activate/restore、远端 version marker | 检查同版本重入、部分发布、失败回滚和旧版本保留 | 布局选择只在 stage 复制前发生；activate 不重放布局解释 | pass |
| error-handling-and-recovery | stage/activate 失败路径 | `tests/dv/versioned_deploy_order.test.ts` 失败恢复用例、真实部署命令成功返回 | 检查复制失败、切换失败、marker 失败和服务失败是否保留可恢复状态 | 未发现新增吞错路径；业务进程失败由 systemd 呈现为 failed | pass |
| resource-lifetime-and-cleanup | 输入包、临时版本目录、workspace | `stageRelease` finally 清理、`tests/integration/remote_deployment.test.ts`、真实部署成功 | 检查是否移动/删除输入包或留下临时 stage | 复制源只读，临时目录和 workspace 清理路径未改变 | pass |
| concurrency-and-ordering | 同一 App 远端发布步骤 | 单 App 操作锁、DV 顺序测试、`src/execution.ts` 串行编排 | 检查 stage/activate/configure 是否可能看到不同布局解释 | 未新增并发路径或跨步骤重解释 | pass |
| interface-and-compatibility | 内置 versioned 行为、App 配置和文档 | `tests/contract/verify_app_management_contract.ts`、`tests/integration/versioned_release.test.ts`、README | 检查平铺模板、多顶层包、CLI 接口和 `DeploymentDefinition` 是否被破坏 | 未新增字段；CLI 和公共类型保持不变 | pass |
| security-and-capacity | tar 边界、路径边界和权限 | `src/remote_deployment.ts#extractValidatedAppPackage`、`src/remote_runtime/versioned_release.ts`、安全集成测试 | 检查路径逃逸、符号链接、超大包、重复成员和权限放宽 | 既有安全边界未放宽，顶层提升仅使用已验证目录内的子路径 | pass |
| test-adequacy | 自动化布局回归与远端端到端证据 | task all run artifact、integration/DV/contract 用例、远端只读复核 | 判断红色回归、多顶层保留、平铺保留和安全拒绝是否足以暴露缺陷 | 覆盖充分；真实部署补充端到端布局证据 | pass |

## Document Consistency

| Document | Source | Implementation Consistency | Finding | Status |
|----------|--------|----------------------------|---------|--------|
| design | `design.md` | 实现遵循 stage 内选择复制源、不改 transport、不改发布事务的设计 | no mismatch | pass |
| testing | `testing.md`、`testplan.yaml` | 测试文档、统一入口和实际运行工件一致；记录了真实部署 manual gap | no mismatch | pass |

## Result Summary

- Overall result: accepted
- Outcome: 缺省单顶层目录剥离已实现并通过本地和真实 Multipass 验证；jx-server/jx-web 新版本不再有 `server`/`web` 层。
- Blocking issues: 无。
- Next action: jx-server 业务运行失败建议由业务制品维护者单独修复 `SchemaMaintenanceInitializer`；布局任务无需进一步修改。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 独立审查覆盖了提案要求的布局、配置、兼容、安全和恢复边界；自动化测试与真实远端路径证据一致。剩余 jx-server 应用启动失败属于业务制品独立缺陷，不阻塞布局交付。
