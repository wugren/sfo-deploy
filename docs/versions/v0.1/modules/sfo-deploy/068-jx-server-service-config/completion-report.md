# jx-server 服务配置完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/068-jx-server-service-config.md

## Delivery Summary

- Outcome: 两份 jx-server/app.yaml 已同步批准配置，README 补充制品及 YAML 加载约定，两个既有测试更新旧断言。
- Handoff: systemd 在 /home/ubuntu/eleph-server/latest 启动 base-entry.jar，启用 local profile；本地忽略副本已同步。没有实际部署。

## Proposal Consistency

| change_id | Requirement or Boundary | Proposal Source | Delivery Evidence | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| CHG-jx-server-service-config | 服务入口、JVM 参数及两个 YAML 加载约定 | proposal.md P-001 及完整配置草稿 | 两份 app.yaml 与批准草稿一致；README；validate/plan 和实际 systemd 渲染 | matches | pass |

## Independent Defect Discovery

| Category | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | 独立审查者 review_service_config 检查 src/config.ts:1252、src/systemd_unit.ts:73 与两份 app.yaml | 比较提案，核对绝对目录解析、前台进程及 JVM/JAR 参数顺序 | latest 与 base-entry.jar 正确，loader.path 位于 -jar 前，无阻断缺陷 | pass |
| boundaries-and-failure-paths | 独立审查者检查 versioned_release.ts:208、:230、JRE 安装脚本和 README | 核对发布软链与 Java 11 参数，寻找配置位置及启动器假设遗漏 | latest 发布一致，README 明确配置与启动器边界；未声称业务启动已验证 | pass |
| regression-and-side-effects | 独立审查者比较原服务策略、依赖和用户；执行者检查旧测试引用与 Git 差异 | 保留服务动作及版本信息，更新旧 JAR/current 断言并运行相关测试 | 原策略保留，12 项测试通过，本地配置为忽略副本，未进行远端操作 | pass |

## Verification

- Targeted check: 本地及临时模板 validate/plan；deno run --allow-read tests/contract/verify_app_management_contract.ts；deno test --allow-read --allow-write --allow-env --allow-run tests/unit/systemd_unit.test.ts tests/integration/versioned_release.test.ts；loadCluster 与 generateSystemdUnitSkeleton 实际渲染；git diff --check。
- Result: passed
- Exception reason: not-applicable

模板校验补齐机器定义及非真实密钥测试文件，仅用于只读本地校验，模板制品哨兵不代表可部署制品。初次缺少密钥及外部软链错误已按路径规则修正，未改变实际机器或秘密文件。

## Findings

| ID | Severity | Evidence | Problem | Blocking |
| --- | --- | --- | --- | --- |
| F-001 | low | README 配置加载与启动器说明 | 业务 JAR、YAML 内容及实际 Java 未获得运行验证，需部署环境验收 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 已完成批准配置、说明及相应回归维护；实际生成命令、本地校验和独立缺陷审查一致，未发现阻断交付缺陷。


## 用户反馈补正：两个业务配置的发布声明

用户指出仅启用 profile 未添加配置发布声明。已在本地集群 apps/jx-server/app.yaml 引用现有 application.yml 和 application-local.yml，分别发布到 /home/ubuntu/eleph-server/ 下同名文件；owner/group 为 ubuntu、mode 为 0600、on_change 为 restart。启动参数增加 --spring.config.additional-location=file:/home/ubuntu/eleph-server/。

业务配置内容保持原样，未复制到受版本控制的模板；因此两份 app.yaml 不再完全一致，模板继续采用包内配置，本地副本具有两个 managed config 动作。README 已说明差异。此前“两个 YAML 业务内容未获得”的描述现仅指未验证其业务语义：当前已发现并通过装载校验这两个现有本地文件。

补正验证：本地 validate/plan 通过；装载得到两个 config 及对应目标、0600 和 restart 策略；契约检查、git diff --check 通过。独立审查确认 activate 阶段自动发布 managed configs、服务收敛位于配置发布后，无需额外 configure。主执行者发现配置发布要求父目录存在（transport.ts:612），将最初拟用的 config 子目录改为已有安装根目录，避免首次发布缺目录。未执行部署。


## 最终路径修正：JAR 同级 resources

用户明确要求两个配置安装到 JAR 所属目录的 resources。最终本地配置目标为 /home/ubuntu/eleph-server/latest/resources/application.yml 和 /home/ubuntu/eleph-server/latest/resources/application-local.yml；additional-location 为 file:./resources/，相对工作目录 latest。此前安装根目录目标方案已被此修正替代，业务源文件保持原样。

validate、plan、实际配置装载与 systemd 渲染路径一致性检查、既有契约检查及 git diff --check 通过。独立审查者 review_service_config 确认路径和 activate 后发布、服务收敛顺序一致；latest 父路径软链接不妨碍配置发布。

制品须包含 JAR 同级的真实 resources 目录（空目录也可），已写入 README。框架不自动创建配置父目录，缺目录会导致激活后的配置发布失败；本次未获取制品验证该前提，也不声称该失败自动回滚版本。未执行远程部署。
