# App 内置服务管理、配置注入与单包投递第三轮验收报告

## Findings

| ID           | Severity | Owning Stage | Correctness Category     | Evidence                                                                                                                                                                                                                                                                                     | Problem                                                                                                       | Blocking |
| ------------ | -------- | ------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| T046-A3-NONE | none     | none         | requirement-and-behavior | `proposal.md` PI-1 至 PI-4、`pipeline/plan.md`、`src/config.ts`、`src/deployment_bundle.ts`、`src/remote_deployment.ts`、`src/transport.ts`、`src/execution.ts`、`src/service_management.ts`、`src/history.ts`、相关测试及 `20260904T161009Z-sfo-deploy+046-app-service-management-all.json` | 第三轮独立证伪未发现尚未记录的阻断缺陷；真实目标机 systemd/OpenSSH 组合仍保留为 testplan 已声明的人工验证缺口 | no       |

## Object and Scope

- Task manifest: task.yaml
- Review mode: independent
  falsification；验收任务未参与实现或测试，从当前批准提案重新读取设计、风险、生产代码、测试和最新机器工件后再选择结论
- Review date: 2026-09-04
- Runtime evidence:
  `.harness/test-results/test-runs/20260904T161009Z-sfo-deploy+046-app-service-management-all.json`，task
  `all` 的 12 个步骤全部 `exit_code=0`，覆盖四个 change_id；另独立重跑
  `managed_transport_security.test.ts`，3 个测试通过
- Lifecycle evidence: `lifecycle-check.py --require-prior acceptance`
  通过，仅用于确认本轮可进入验收，不作为正确性证明

### Returned Finding Closure

| Prior ID                | Independent closure evidence                                                                                                                                                                                                                                                                                                  | Status |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T046-RUNAS-ENV-009      | `src/transport.ts:397-450` 从唯一 getent 记录校验非 root UID 和规范绝对 HOME；`runAsApp` 在 `src/transport.ts:453-472` 生成 root 路径 `sudo -n -H -u deploy -- env HOME=verified-home DEPLOYMENT_*=... command`，非 root 路径生成 `env HOME=verified-home ... command`，且拒绝调用方覆盖 HOME；Python/Deno 均经该生产方法执行 | closed |
| T046-RUNAS-ENV-TEST-010 | `tests/integration/managed_transport_security.test.ts:178-320` 真实调用 `OpenSshRemoteSession.executeDeno` 和 `executePython`，断言 sudo 位于 env 外层、HOME/metadata/secrets 位于 env 内层；另覆盖非 root verified HOME、危险 HOME、HOME 覆盖、root run_as 和身份不匹配                                                      | closed |

### Earlier Finding Regression Sample

| Prior ID                 | Current evidence                                                                                                                    | Status        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| T046-REMOTE-ARGV-001     | `remote_deployment.ts` 和 `transport.ts` 的 stat format 均为独立 `%F/%s/%a/%U/%G` argv；真实 OpenSSH 测试确认无控制字符             | no regression |
| T046-FORMAT-REPARSE-002  | `config_updater.ts:199-205` 及随包 bundle 对 YAML/JSON/TOML/INI 调用离线 parser；逐格式无效候选在写出前失败                         | no regression |
| T046-SCRIPT-IDENTITY-003 | v3 必填非 root `run_as`，root/non-root UID 校验与降权生产路径仍在；本轮进一步验证 HOME/协议环境                                     | no regression |
| T046-SECRET-SCOPE-004    | 每个 config updater 和每次 lifecycle 调用仍通过 `createScopedSecretCopy` 获取独立 0700/0600 最小秘密集合并逐调用清理                | no regression |
| T046-SECRET-OUTPUT-005   | `operationRedactor` 汇集本次操作秘密；`safeOutput` 在 redactor 不安全时置空，值秘密/文件秘密/fail-closed DV 仍在最新 all 工件中通过 | no regression |
| T046-OPERATION-LOCK-006  | configure/start/stop/restart/deploy/rollback 均创建 attempt；managed 状态转换仍由目标 flock lease 包围，争用和取消测试验证回收      | no regression |
| T046-INNER-ARCHIVE-007   | 内层 tar 在 extract 前验证路径、regular/dir、重复、数量和总展开量；absolute/parent/link/device/容量反例确认零 extract               | no regression |
| T046-TEST-GAP-008        | testplan 和最新工件包含真实 OpenSSH、四格式失败复解析、逐消费者秘密、全操作 attempt/flock、恶意内层 tar 和输出 fail-closed          | no regression |

## Requirement Coverage

| change_id                     | Requirement Or Boundary                                                                                 | Source             | Implementation Evidence                                                                                                                     | Finding                                                     | Status |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| CHG-app-management-contract   | v3 opt-in 管理契约、四格式/script/systemd、必填非 root run_as、冲突拒绝及 v1/v2 兼容                    | `proposal.md` PI-1 | `src/types.ts`、`src/config.ts`、`src/planning.ts`、plan-v4 codec、配置正负测试及外部 contract consumer                                     | 未发现缺失、歧义或旧契约回归                                | pass   |
| CHG-app-file-delivery         | 原包字节保持、单个外层包、每目标一次上传、安全解包、摘要复验、复用和失败清理                            | `proposal.md` PI-2 | `src/deployment_bundle.ts`、`src/remote_deployment.ts`、`prepareExecution` local-only cache、外层篡改及恶意内层 tar 测试                    | 未发现部分包消费、二次 provider 获取或危险归档逃逸          | pass   |
| CHG-app-managed-runtime       | 控制端无秘密骨架、目标端四格式/script 更新、非特权身份、逐消费者秘密、原子配置、systemd、锁、补偿和脱敏 | `proposal.md` PI-3 | `src/config_generation.ts`、远端 updater bundle、`src/transport.ts`、`src/execution.ts`、`src/service_management.ts` 及 unit/DV/integration | 009 的 root 环境边界已实质关闭；未发现其他阻断              | pass   |
| CHG-app-management-validation | task 级测试、真实命令边界、兼容示例和中文文档闭环                                                       | `proposal.md` PI-4 | 最新 testplan、12-step all 工件、README、中文指南、nginx/jx-server 示例和 documentation contract                                            | 010 已增加真实 Python/Deno 环境断言；现有人工缺口已明确披露 | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                                                                       | Evidence Inspected                                                                                     | Adversarial Check                                                                    | Finding Or Not Applicable Reason                                                                                           | Status |
| ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| requirement-and-behavior      | 四个 change_id、显式 opt-in 与非目标边界                                               | 批准 proposal、最新 plan/risk、生产入口、README/指南/示例                                              | 逐项对照 configure/start/stop/restart/deploy/rollback、managed 与 legacy 结果        | 单包、配置注入、systemd、自定义扩展和兼容行为均在批准范围内实现，未发现遗漏或越界                                          | pass   |
| logic-and-control-flow        | prepare→bundle→identity→script/config→service→cleanup                                  | `src/planning.ts`、`src/execution.ts`、`src/transport.ts`、`src/service_management.ts`                 | 追踪 root/non-root Python/Deno 命令顺序、unchanged、失败跳转和补偿                   | sudo 现位于 env 外层，环境在降权后注入；配置和服务动作顺序与合并规则一致                                                   | pass   |
| boundary-and-input            | schema、四格式、argv、HOME/UID、归档、大小和路径                                       | config/generation/updater、remote deployment、transport 校验及负向测试                                 | 缺失/root/mismatch UID、危险/覆盖 HOME、无效格式、控制字符 argv、恶意 tar            | 危险输入在 SSH、解包、执行或发布前失败关闭，未发现绕过                                                                     | pass   |
| state-and-data-integrity      | bundle ready、候选/备份/最终配置、release snapshot 与 attempt                          | `src/remote_deployment.ts`、`src/execution.ts`、`src/history.ts`、cache/rollback 测试                  | 检查摘要漂移、重复消费、部分发布、unchanged、恢复和当前秘密回放                      | 内容/用途/attempt 身份绑定明确；失败恢复旧配置并报告恢复状态，snapshot 不含秘密值                                          | pass   |
| error-handling-and-recovery   | 上传、更新器、validator、systemd、锁、取消和清理失败                                   | executor catch/finally、publish/restore/commit、service convergence、DV 失败用例                       | 沿候选失败、hook 失败、service 失败、锁超时和取消检查终态                            | 失败不隐式重试副作用，配置/service 有界补偿，取消和锁错误均产生受控终态                                                    | pass   |
| resource-lifetime-and-cleanup | 本地 prepared、远端 workspace、scope、秘密目录、备份和 holder                          | `PreparedExecution.close`、session cleanup/close、逐消费者 finally、flock 回收测试                     | 检查成功/失败/超时/取消后的候选、secret copy、workspace 和进程回收                   | 所有权资源均有调用级或 session 级兜底；未发现可被后续步骤消费的半成品                                                      | pass   |
| concurrency-and-ordering      | 六操作 controller attempt 与目标 App flock                                             | `src/integration.ts`、`src/history.ts` OperationLock、`src/execution.ts` lease 包围、flock integration | 争用超时、取消和正常释放；检查未持锁前是否执行 managed 副作用                        | controller 锁持续到 attempt 终态，目标 lease 在 workspace/bundle/脚本/config/systemd 前获取并在 finally 释放               | pass   |
| interface-and-compatibility   | App v1-v3、plan v1-v4、CLI/JSON、OpenSSH、Python/Deno 协议                             | types/config/history/results/transport、legacy regressions、真实命令测试                               | root/non-root 捕获 HOME、metadata、secrets 的生产命令；旧 schema 解码和示例 contract | 009/010 关闭；新增字段保持可选，legacy 路径和既有输出字段未被强制迁移                                                      | pass   |
| security-and-capacity         | 非 root 执行、秘密最小暴露/脱敏、script 沙箱、归档上限                                 | identity/scoped secrets/updater/tar/redactor 生产路径和反例                                            | UID0、HOME 注入、跨消费者秘密、秘密回显、link/device/expanded-size 攻击              | root 无回退执行；script updater deny env/net/run/ffi；秘密不入包/argv/结果，容量边界在消费前执行                           | pass   |
| test-adequacy                 | normal、boundary、negative、error、lifecycle、concurrency、compatibility、cross-module | testplan、测试源码、161009Z all 工件及本轮定向重跑                                                     | 检查断言是否命中生产 session，而非只命中 Fake；重点复验 009/010 和旧八项             | root executeDeno/Python、非 root、HOME 负向、四格式、归档、秘密、锁、history 和文档均有直接可运行断言；真实主机 gap 已明确 | pass   |

## Document Consistency

| Document | Source             | Implementation Consistency                                                                                                                                | Finding                          | Status |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------ |
| design   | `pipeline/plan.md` | opt-in 契约、非 root sudo 降权、两阶段配置、单包、逐消费者秘密、全操作锁、补偿与兼容映射均由当前实现保持；`-H` 和降权后 env 是既定身份/脚本协议的安全细化 | 未发现设计与实现矛盾             | pass   |
| testing  | `testplan.yaml`    | I2 已明确 Python/Deno 降权后 metadata/secret/HOME、真实 OpenSSH、flock 和恶意内层归档；最新 artifact 执行同一 argv                                        | 测试声明、测试代码和机器证据一致 | pass   |
| proposal | `proposal.md`      | 四个 proposal item、秘密与权限边界、兼容和非目标未被下游缩小或扩张                                                                                        | 未发现需要用户裁决的需求问题     | pass   |

## Result Summary

- Overall result: accepted
- Outcome: App v3 已交付显式
  systemd/配置管理、控制端无秘密骨架、目标端四格式或受限脚本注入、单包安全投递、非 root
  生命周期、逐消费者秘密、六操作互斥/历史、补偿和兼容文档；第二轮 root 环境问题及测试缺口已关闭
- Blocking issues: none recorded
- Next action: 无自动返工；在可控 Linux 目标机上执行 testplan 已声明的真实 SSH/systemd
  人工验证，以确认具体发行版组合，不影响本轮基于固定 argv 和生产边界的接受结论

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 第三轮独立证伪覆盖全部四个 change_id 和恰好十类正确性风险，009/010 已由生产命令顺序、HOME
  防护和真实 Python/Deno 测试实质关闭，旧八项未见回归，且设计、测试与实现一致，无剩余阻断 finding。
