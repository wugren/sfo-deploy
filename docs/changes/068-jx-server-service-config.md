# jx-server 启动与配置加载

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/068-jx-server-service-config/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/068-jx-server-service-config/proposal.md
- Affected paths: examples/eleph-server-multipass/cluster-template/apps/jx-server/app.yaml, examples/eleph-server-multipass/clusters/multipass/apps/jx-server/app.yaml, examples/eleph-server-multipass/README.md, tests/contract/verify_app_management_contract.ts, tests/integration/versioned_release.test.ts
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

按批准草稿同步模板及本地副本：latest 工作目录、base-entry.jar、JRE 11 GC 日志、原 JVM 内存及时区参数、loader.path 和 local profile。README 说明两个 YAML 的默认位置及制品布局。同步两处旧契约断言，避免继续要求旧 JAR 和 current 目录。未修改框架实现。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

上述筛查指重大边界影响；本次局部示例启动参数改变符合批准需求，沿用既有服务生命周期，不执行部署。

## Verification

- Targeted check: 实际本地集群 validate/plan；模板临时副本 validate/plan；verify_app_management_contract.ts；systemd_unit.test.ts 和 versioned_release.test.ts；实际装载并渲染 systemd unit；git diff --check。
- Result: passed

12 项测试通过，契约检查成功，两个部署计划均为 stage/activate/restart。
- Residual risk or follow-up: 未运行业务 JAR 或连接节点；两份业务 YAML 和实际 Java 需运行环境验收。本地集群配置为 Git 忽略文件，已同步但不会随普通提交发布。

模板本身无 machines.yaml，临时校验使用本地机器定义及明确标注的非 SSH 密钥测试文件，仅验证配置装载和计划。初次临时检查因缺少密钥文件失败，外部符号链接亦被路径边界校验拒绝；改用临时目录内测试文件后通过，临时目录已移除。


## 用户反馈补正：两个业务配置的发布声明

用户指出仅启用 profile 未添加配置发布声明。已在本地集群 apps/jx-server/app.yaml 引用现有 application.yml 和 application-local.yml，分别发布到 /home/ubuntu/eleph-server/ 下同名文件；owner/group 为 ubuntu、mode 为 0600、on_change 为 restart。启动参数增加 --spring.config.additional-location=file:/home/ubuntu/eleph-server/。

业务配置内容保持原样，未复制到受版本控制的模板；因此两份 app.yaml 不再完全一致，模板继续采用包内配置，本地副本具有两个 managed config 动作。README 已说明差异。此前“两个 YAML 业务内容未获得”的描述现仅指未验证其业务语义：当前已发现并通过装载校验这两个现有本地文件。

补正验证：本地 validate/plan 通过；装载得到两个 config 及对应目标、0600 和 restart 策略；契约检查、git diff --check 通过。独立审查确认 activate 阶段自动发布 managed configs、服务收敛位于配置发布后，无需额外 configure。主执行者发现配置发布要求父目录存在（transport.ts:612），将最初拟用的 config 子目录改为已有安装根目录，避免首次发布缺目录。未执行部署。


## 最终路径修正：JAR 同级 resources

用户明确要求两个配置安装到 JAR 所属目录的 resources。最终本地配置目标为 /home/ubuntu/eleph-server/latest/resources/application.yml 和 /home/ubuntu/eleph-server/latest/resources/application-local.yml；additional-location 为 file:./resources/，相对工作目录 latest。此前安装根目录目标方案已被此修正替代，业务源文件保持原样。

validate、plan、实际配置装载与 systemd 渲染路径一致性检查、既有契约检查及 git diff --check 通过。独立审查者 review_service_config 确认路径和 activate 后发布、服务收敛顺序一致；latest 父路径软链接不妨碍配置发布。

制品须包含 JAR 同级的真实 resources 目录（空目录也可），已写入 README。框架不自动创建配置父目录，缺目录会导致激活后的配置发布失败；本次未获取制品验证该前提，也不声称该失败自动回滚版本。未执行远程部署。
