# eleph-server Multipass 示例独立验收报告

## Findings
| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
|----|----------|--------------|----------------------|----------|---------|----------|
| F-001 | high | testing | requirement-and-behavior | 修订后 `proposal.md` Success Criteria 与 `risk-profile.yaml` runtime required_checks 仍要求真实 Multipass 中记录 Java/MySQL/Redis/schema/systemd 及宿主机 HTTP；本轮示例测试为 49 passed、1 skipped，`test_multipass_e2e.py:116` 因本机无 multipass、无真实 JAR URL/SHA 和密钥而 skipped，且 `.state/multipass-e2e-evidence.json` 不存在 | 最终目标“正确部署且可访问”仍没有真实运行证据；静态、计划和模拟测试不能证明实际 JAR 与 Ubuntu/MySQL/Java/systemd 组合可工作 | yes |
| F-006-closed | none | none | boundary-and-input | `cli.py:_validate_artifact_configuration` 现于同一 try 内取得 `parsed.hostname` 与 `parsed.port`，ValueError 转为 ArtifactConfigurationError，并要求 hostname 非空、显式端口为 1..65535；artifact tests 新增缺 hostname 和非法端口反例 | 历史 hostname/port SSH 前预检旁路已关闭 | no |
| F-005-closed | none | none | boundary-and-input | `cli.py:75-112` 新增 `_validate_artifact_configuration()` 并在 `main()` 调用 `_bound_cli()` 前执行；artifact tests 覆盖部分配置、provider/scheme mismatch、credentials、fragment 及完整正例 | 历史部分配置和 provider/scheme mismatch 缺陷已关闭；F-006 是新增 host/port 边界遗漏 | no |
| F-002-closed | none | none | security-and-capacity | `schema.sql:4-8` 保持 `Source Server: redacted source snapshot`、`Source Host: removed`；`test_environment_scripts.py::test_versioned_schema_does_not_propagate_source_connection_metadata` 拒绝原 IP 和开发服务器名称 | 历史源连接参数传播缺陷保持关闭 | no |
| F-003-closed | none | none | state-and-data-integrity | `prepare-multipass.ps1` 把 known_hosts、私钥、bootstrap 和配置放入 `$stageCluster` 并只调用一次 `Publish-ClusterAtomically`；CLI `KNOWN_HOSTS` 指向同一集群目录 | 历史 cluster/known_hosts 混合修订缺陷保持关闭 | no |
| F-004-closed | none | none | test-adequacy | `test_multipass_e2e.py:126-166` 不带 JAR 参数运行 prepare，随后安全写入生成 App YAML，接受 `<500` 的 4xx，并通过 deploy CLI check 四个环境、start App 后写 evidence；MySQL check 验证 marker 与 `jxdy.app_user` | 历史 E2E 4xx 误判和 VM 后置状态证据设计缺口保持关闭 | no |

## Object and Scope
- Task manifest: task.yaml
- Review date: 2026-08-13
- In-scope implementation: 新批准的无 JAR 参数 bootstrap 基线，`examples/eleph-server-multipass/` 全部生产配置/脚本/README/测试，proposal、risk profile、pipeline plan、testplan、runtime state 和 `20260813T140033Z` 统一测试 artifact
- Review mode: independent falsification；未参与修订实现，重新检查主来源、全部历史 finding、新手工制品配置边界和运行证据后选择结论

## Requirement Coverage
| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
|-----------|-------------------------|--------|-------------------------|---------|--------|
| CHG-multipass-bootstrap | prepare 完全不处理 JAR，只建立空白 VM、SSH 身份、host key 和基础集群 trust bundle | `proposal.md` P-001、修订 Scope | `prepare-multipass.ps1` 参数仅含实例/资源/镜像；无 JarUrl/JarSha、URI/SHA、App 路径读取或制品替换，唯一 Replace 只写 VM IP；生产路径无 exec/transfer/mount | 静态边界符合修订要求；F-001 表明真实引导尚未执行 | fail |
| CHG-eleph-http-deploy | 用户引导后手工编辑 provider/URL/SHA；无效或不完整组合 SSH 前失败；有效组合产生 14 步 deploy 并最终可访问 | `proposal.md` P-002 与 Success Criteria | 直接 `app.yaml` 默认无效；完整配置得到 14 步；F-005/F-006 的部分配置、scheme、credentials、fragment、hostname、port 反例均前置拒绝，环境/App 与 E2E 后置检查保留 | 本地实现契约已闭合；仅 F-001 的真实部署结果仍缺失 | fail |
| CHG-example-guidance | README 按“引导、编辑生成 App YAML、validate/plan、deploy、HTTP 验收”说明 | `proposal.md` P-003 | `README.md` 无 prepare JAR 参数，明确生成文件路径、三项替换规则、重跑 prepare 会恢复占位值及条件 E2E 命令 | 指南顺序与新基线一致；未发现新的文档命令缺陷 | pass |

## Independent Defect Discovery
| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
|----------|------------------|--------------------|-------------------|----------------------------------|--------|
| requirement-and-behavior | 无 JAR bootstrap、手工配置失败关闭、deploy-only 安装和真实可访问 | 修订 proposal P-001 至 P-003、plan、README、生产脚本、测试和本轮结果 | 搜索 bootstrap 制品处理，尝试默认、部分、不一致、无 host、坏端口和完整配置 | F-005/F-006 均关闭；仅 F-001 的最终真实可访问结果未满足 | fail |
| logic-and-control-flow | bootstrap 复制/发布、CLI load/plan/preflight、14 步执行、App rollback/E2E | `prepare-multipass.ps1`、examples CLI preflight、framework execution/download validation、App scripts 和 E2E | 追踪全部无效 URL 在 `_bound_cli`/transport 创建前的分支及有效配置后执行顺序 | 无效配置现于本地阻断，有效配置保持14步依赖与服务顺序，未发现新控制流缺陷 | pass |
| boundary-and-input | VM 参数、手工 provider/URL/SHA、密钥、IP/host key 和 E2E 输入 | PowerShell 参数、直接 app.yaml、examples preflight、framework download validation、SecretSettings、E2E helpers | 挑战占位、部分编辑、scheme mismatch、credentials/fragment/backslash/control、无 hostname、非法/越界端口 | hostname/port 在 try 内安全解析，F-005/F-006 及相邻 URL 边界均失败关闭 | pass |
| state-and-data-integrity | trust bundle、用户编辑的生成 App YAML、MySQL marker/schema、Redis/JAR/evidence | bootstrap 单目录发布、README 重引导语义、MySQL/Redis/App scripts、E2E evidence | 挑战重跑 prepare、混合信任修订、重复配置、导入失败、marker 无表和升级回滚 | 重跑明确恢复占位配置且 trust bundle 原子发布；F-003 保持关闭，未发现新持久状态损坏 | pass |
| error-handling-and-recovery | bootstrap、手工配置、SSH、apt/SQL/Redis/systemd/HTTP 失败 | PowerShell finally、examples/framework preflight、execution、App rollback、E2E asserts | 检查错误发生阶段、后续阻断、旧状态恢复和失败 evidence | URL ValueError 转为脱敏本地 preflight 错误；环境/App运行失败与 evidence 写入仍正确传播 | pass |
| resource-lifetime-and-cleanup | bootstrap staging、framework session/workspace/package、脚本临时文件和 HTTP 响应 | PowerShell finally、execution cleanup、App/环境 finally/with、E2E urlopen | 检查正常、异常、超时和部分下载时资源释放 | 临时文件、下载物、响应和会话具有清理路径；VM 保留为文档明确的操作者所有状态 | pass |
| concurrency-and-ordering | 单机串行 DAG、trust bundle 发布、手工编辑与 validate 顺序 | 14 步 plan、depends_on、单次 publish、README/E2E 顺序 | 挑战 App 先于依赖、配置先于 JAR、编辑早于 prepare 及证据早写 | 14 步拓扑和 README/E2E“prepare 后编辑”顺序正确，未见新竞态 | pass |
| interface-and-compatibility | 独立 pyproject、公开 deploy API、直接 App YAML、Ubuntu/JRE/MySQL/Redis/JAR 和 HTTP | pyproject、CLI、YAML、systemd、README、E2E 和公开 load/build 诊断 | 从非根 cwd 消费，验证完整/不一致/host/port 配置以及环境计划未退化 | 完整 HTTPS 配置产生 14 步，examples preflight 与 framework HTTP URL 边界对齐，未见新接口缺陷 | pass |
| security-and-capacity | SSH trust、sudo、secret、URL/hash、源连接元数据、下载/健康边界 | bootstrap/CLI、framework redactor/downloads、模板、SQL、E2E validator | 搜索 Multipass 绕过、JAR bootstrap 残留、旧源地址、secret 输出和 URL 解析旁路 | F-002/F-003/F-005/F-006 均保持关闭；相邻 URL 信任边界未见新旁路 | pass |
| test-adequacy | 单元、DV、契约、条件 E2E、统一 artifact 和 manual gap | 全部示例测试、testplan、`20260813T140033Z` JSON、本轮 49 passed/1 skipped | 检查 bootstrap 无 JAR、默认/部分/完整配置、scheme/host/port、后置状态和真实兼容 | F-005/F-006 回归覆盖充分；F-001 仍表示真实运行验证没有执行 | fail |

## Document Consistency
| Document | Source | Implementation Consistency | Finding | Status |
|----------|--------|----------------------------|---------|--------|
| design | `pipeline/plan.md` | bootstrap 无 JAR、直接 App YAML、14 步 DAG、手工编辑顺序和无效 URL SSH 前失败均与实现一致 | F-005/F-006 的历史偏差已关闭 | pass |
| testing | `testplan.yaml` 与 pipeline runtime state | 最新 artifact 覆盖修订及 hostname/port 反例，state 对真实 bootstrap/deploy 记录 manual gap | 静态与模拟覆盖一致；真实 E2E缺口被诚实记录 | pass |

## Result Summary
- Overall result: needs changes
- Outcome: bootstrap 无 JAR 修订成立，F-002～F-006 均确认关闭，49 个非真实 E2E 示例测试通过；当前仅缺真实运行证据。
- Blocking issues: 仅 F-001（真实 Multipass/JAR E2E 未执行）。
- Next action: 在具备 Multipass 和真实 JAR URL/SHA 的环境按 README 运行条件 E2E，生成 `.state/multipass-e2e-evidence.json` 后重新独立验收。

## Conclusion
- Accepted / rejected / needs changes: needs changes
- Reason: 新批准需求清晰且 F-002～F-006 已全部回归关闭；但提案明确禁止在真实 Multipass 验收缺失时宣称部署成功，因此 F-001 仍阻止 accepted。
