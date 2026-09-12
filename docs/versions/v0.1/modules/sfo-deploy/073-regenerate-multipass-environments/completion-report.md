# multipass 环境配置重生成完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/073-regenerate-multipass-environments.md

## Delivery Summary

- Outcome: multipass 模板中的 `jre`、`mysql`、`nginx`、`redis` 已迁移到新 `install`/`manager`
  生命周期；Nginx 使用内置 package/system，MySQL 使用 package install 加跨发行版 service
  manager，JRE 和 Redis 使用跨发行版 script install，Redis 另有跨发行版 service manager。README
  已同步 Ubuntu/CentOS 边界、prepare 行为和无效命令说明。
- Handoff: 同一份模板可通过 `validate`，三个 App 均可 `plan`。真实部署仍需先提供制品、软件源、SSH
  信任和授权；本任务未连接 Multipass、Ubuntu 或 CentOS 节点，未执行安装或服务动作。

## Proposal Consistency

| change_id                             | Requirement or Boundary                                            | Proposal Source   | Delivery Evidence                                                                                                    | Finding | Status |
| ------------------------------------- | ------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| CHG-regenerate-multipass-environments | 优先使用系统包安装和系统服务管理，并支持 Ubuntu/Debian 与 CentOS 7 | proposal.md P-001 | 四份 environment.yaml、六个保留脚本、validate/plan 输出和环境管理契约检查；脚本探测 apt-get/yum 与 systemctl/service | matches | pass   |
| CHG-regenerate-multipass-environments | 移除旧生命周期脚本并同步 README prepare 语义                       | proposal.md P-002 | 旧 check/install/stop 脚本已删除；README 记录新生命周期、跨发行版边界、软件源前提和 plan 命令修正                    | matches | pass   |

## Independent Defect Discovery

| Category                     | Evidence Inspected                                                                                        | Adversarial Check                                                                                                                       | Finding or Not-Applicable Reason                                                                                                                           | Status |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | 四份 YAML、六个自包含 TypeScript 脚本、`src/config.ts`、`src/environment_runtime.ts` 和 `src/planning.ts` | 核对新契约装载、package/script 二选一、system/script manager 字段、start/restart 计划、包名探测和服务单元候选顺序                       | 初查发现 systemctl 存在但 SysV-only 服务时 `systemctl cat` 可能失败，以及启动后未校验 active；已改为先试 systemd 再回退 SysV，并在动作后校验 active/status | pass   |
| boundaries-and-failure-paths | 权限清单、脚本子进程 argv、README 支持边界、CentOS 软件源说明和 validate/plan 结果                        | 检查所有 `Deno.Command` 路径是否声明、无网络权限、缺包/缺 unit/缺 init 脚本是否 fail-closed；验证 plan 不接受 `--with-dependencies`     | 删除了无效 README 命令；CentOS 上 MySQL/Nginx/Redis 可能仍需用户预置软件源，已明确记录为部署前提                                                           | pass   |
| regression-and-side-effects  | `cluster.yaml.environments`、App 依赖、App YAML、README、Git diff、相关单元测试和契约检查                 | 比较环境名称、版本标签、放置和依赖闭包；确认未改 App schema、机器定义、框架行为和密钥放置；检查旧 stop/check 入口移除后不再被 YAML 引用 | 集群放置和 App 依赖保持不变；环境级 script manager 不提供 stop，这是新契约边界且未影响 App managed service 的 stop                                         | pass   |

## Verification

- Targeted check: `deno task check`；六个环境脚本 `deno check`、`deno lint` 和
  `deno fmt --check`；临时模板补齐 machines/key 后运行 `sfo-deploy validate` 和
  `sfo-deploy plan --app jx-server|nginx|jx-web`；`deno test` 环境 config/planning/runtime
  用例；`deno run --allow-read tests/contract/verify_environment_management_contract.ts`；`git diff --check`。
- Result: passed
- Exception reason: not-applicable

`validate` 报告 1 台机器、4 个环境实例和 3 个 App。三个 App 的 plan 分别生成 stage/activate 或
check/configure 两步。临时验证只复制 `cluster-template` 并生成一次性 SSH
key，不连接节点。相关测试结果为 14 passed / 0 failed。

## Findings

| ID    | Severity | Evidence                              | Problem                                                                                                         | Blocking |
| ----- | -------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| F-001 | low      | README 软件源说明与本地验证范围       | CentOS 的 MySQL/Nginx/Redis 可能依赖 EPEL 或社区仓库；本次不执行远端安装，无法证明真实包可用性                  | no       |
| F-002 | low      | 新 environment manager 契约和脚本目录 | MySQL/Redis 环境级 script manager 只支持 start/restart，不支持环境级 stop；App managed service 的 stop 不受影响 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 批准的配置重生成、跨发行版边界、README
  同步、独立缺陷审查和本地验证一致；未发现阻断交付缺陷。真实节点部署和软件源可用性明确留在任务范围之外。
