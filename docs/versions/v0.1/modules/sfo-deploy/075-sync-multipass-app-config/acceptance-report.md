# multipass App 配置与安装目录绑定验收报告

## Findings

| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- | --- | --- |
| F-000 | none | none | overall | 独立复审 `src/config.ts` 的 `loadApps -> appConfigs -> managedConfigFiles -> managedConfigTarget` 调用链、`tests/unit/app_management_config.test.ts`、`tests/dv/versioned_deploy_order.test.ts`、`tests/integration/versioned_transport_boundary.test.ts`、`tests/integration/managed_transport_security.test.ts`、实际 multipass App 配置及 `.harness/test-results/test-runs/20260909T165241Z-sfo-deploy+075-sync-multipass-app-config-all.json` | 本轮批准范围内未发现未解决缺陷 | no |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-10
- In-scope implementation: `src/config.ts`、`tests/unit/app_management_config.test.ts`、实际 multipass 集群的 `jx-server/app.yaml`、`jx-server/application.yml`、`jx-web/app.yaml` 和 `nginx/app.yaml`。
- Review mode: independent falsification；按提案、设计、生产调用链、测试源码、运行工件和实际集群配置重新复核，不采用实现或测试自评作为正确性证据。未连接 SSH/Multipass，也未执行 deploy。

## Requirement Coverage

| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-sync-multipass-app-config | jx-server 版本内配置 target 使用 `${INSTALL_DIRECTORY}/resources/...` | proposal.md P-001 | `app.yaml` 两个 target 均使用变量；`managedConfigTarget` 展开为 `/home/ubuntu/eleph-server/latest/resources/...`，deploy 阶段由既有候选版本映射使用 | 目标与设计一致，validate/plan 通过 | pass |
| CHG-sync-multipass-app-config | jx-server 基础配置 Redis 密码使用集群秘密占位符 | proposal.md P-002 | `application.yml` 使用 `${ELEPH_REDIS_PASSWORD}`；`cluster.yaml.secrets` 声明同名秘密；multipass validate 解析通过 | 未发现未声明引用；真实 Redis 值匹配保留为部署前风险 | pass |
| CHG-sync-multipass-app-config | jx-web 和 nginx 按 schema 1 审计并对齐 | proposal.md P-003 | 两个 `app.yaml` 均无旧 `management.configs`/`management.actions`/顶层 `templates`；nginx 仅调整字段顺序，jx-web 无行为性变更 | 结构、字段闭包和动作所有权符合当前契约 | pass |
| CHG-sync-multipass-app-config | 恢复 schema 1 顶层配置的 `${INSTALL_DIRECTORY}` 绑定 | proposal.md P-004 | `loadApps` 将已解析 `install_directory` 传入 `appConfigs`，后者转发给 `managedConfigFiles`；新增正例和缺失声明反例测试 | 回归修复未扩展变量语法或改变旧绝对路径兼容 | pass |

## Independent Defect Discovery

| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- | --- |
| requirement-and-behavior | 四项提案边界和用户要求的三个 App 同步 | proposal.md Scope/Success Criteria、design.md、实际 app.yaml/application.yml、validate/plan 输出和统一测试工件 | 逐项核对是否遗漏 jx-web/nginx、是否仍使用旧 target、是否引入未批准行为 | 批准范围内行为与提案一致；范围外遗留明文 token secret 已记录为后续风险，不作为本次完成证据 | pass |
| logic-and-control-flow | schema 1 配置装载参数流 | `loadApps`、`appConfigs`、`managedConfigFiles`、`managedConfigTarget` 和新增 unit 测试 | 检查参数缺失、变量命中、无变量路径和异常分支是否落入正确处理路径 | 参数现在从已解析安装目录连续传递；无变量路径仍走 `managedTargetPath` | pass |
| boundary-and-input | target 变量、路径片段、重复目标和秘密引用 | `managedConfigTarget` 的片段校验、重复目标检查、cluster secrets 声明和相关测试 | 构造缺失 install_directory、路径逃逸、重复目标和未声明秘密场景 | 缺声明与非法路径本地失败；重复目标和未声明秘密继续被拒收 | pass |
| state-and-data-integrity | latest 选择器、候选版本配置和恢复状态 | `src/versioned_release_management.ts`、`src/execution.ts`、DV 发布/切换/标记/恢复用例 | 验证配置写入候选版本、切换后服务动作、失败恢复不激活新版本 | 既有版本事务状态不被变量装载改变 | pass |
| error-handling-and-recovery | 配置错误、发布失败、transport 恢复 | schema 1 反例、DV 故障注入、integration 边界/事务测试和运行工件 | 检查错误是否在 SSH 前暴露、恢复是否保留旧 latest 和备份 | 未发现吞错、错误分类漂移或恢复语义退化 | pass |
| resource-lifetime-and-cleanup | 配置发布临时资源、版本目录与恢复备份 | transport workspace/boundary、versioned release cleanup 和 managed transport 测试 | 检查新增参数是否提前释放恢复资源或影响清理判定 | 本修复不新增资源生命周期；既有保留/清理策略保持不变 | pass |
| concurrency-and-ordering | stage/activate 顺序与配置/服务动作 | planning 依赖图、DV 事件顺序断言、integration 事务顺序 | 检查本地变量解析是否新增远端插入点或改变 switch/action 顺序 | 变量解析仅发生在本地装载期，部署顺序不变 | pass |
| interface-and-compatibility | App schema 1 配置契约、计划格式与旧路径 | `src/config.ts`、计划相关测试、DV 兼容用例、实际 app.yaml | 验证旧绝对 target、计划 JSON 和公共导出兼容性 | 内部签名不导出；公共 YAML 契约向后兼容，旧路径继续可用 | pass |
| security-and-capacity | 秘密引用、路径穿越、符号链接和 shell 注入 | cluster secret 声明、application.yml、transport realpath 包含关系和 integration 安全测试 | 检查路径逃逸、软链逃逸、未声明秘密和 argv 注入 | 批准范围内秘密只经集群声明注入；路径边界保持闭环。范围外 `token.secret` 明文作为后续风险 | pass |
| test-adequacy | 参数转发、变量展开、失败关闭、部署映射和实际集群计划 | testing.md/testplan.yaml、unit/DV/integration 测试源码和统一入口运行工件 | 核对是否只测装载而漏掉部署映射、路径边界或集群计划 | 35 个测试及 2 个集群 CLI 步骤通过；足以暴露本次回归和主要边界 | pass |

## Document Consistency

| Document | Source | Implementation Consistency | Finding | Status |
| --- | --- | --- | --- | --- |
| design | design.md | 参数转发、latest 选择器、路径边界、文件顺序和回退方式与实现一致 | 无不一致 | pass |
| testing | testing.md, testplan.yaml | 表列用例、testplan 命令、change_id 覆盖和统一入口工件一致 | 无不一致 | pass |

## Result Summary

- Overall result: accepted
- Outcome: multipass 三个 App 均按当前 schema 1 复核；jx-server 使用 `${INSTALL_DIRECTORY}` 推荐目标，Redis 密码引用集群秘密；schema 1 安装目录变量绑定回归已修复并通过本地测试。
- Blocking issues: none
- Next action: 完成生命周期并从未完成索引移除。后续部署前需确认 Redis 服务端接受 `ELEPH_REDIS_PASSWORD`；另建议单独任务把 `token.secret` 明文迁移到 `ELEPH_TOKEN_SECRET`。本地验证不证明真实节点部署、包内容或服务可用。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 独立反例检查覆盖行为、路径边界、状态恢复、兼容性、秘密/安全和测试充分性；未发现阻断缺陷，任务范围内的四项需求均有实现和运行证据。
