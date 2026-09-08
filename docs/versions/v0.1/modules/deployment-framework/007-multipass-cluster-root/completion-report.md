# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/007-multipass-cluster-root.md

## Delivery Summary

- Outcome: 两个 prepare 入口现在把完整信任包原子发布到示例内标准集群根
  `clusters/multipass/`，`machines.yaml` 位于集群根与 `cluster.yaml` 同级；示例 CLI
  改从该配置根读取；旧版 `.state/clusters/multipass`
  完整信任包在互斥锁内一次性迁移；生成目录整体保持 git 忽略。
- Handoff: 现有 `.state/clusters/multipass` 信任包已迁移到
  `clusters/multipass/`（本工作区）；部署、JAR 手工配置、SSH 信任与失败关闭语义未改变；`.state/`
  仅保留锁、staging 与 E2E 证据。

## Proposal Consistency

| change_id                  | Requirement or Boundary                                                            | Proposal Source   | Delivery Evidence                                                                                                                           | Finding        | Status |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| CHG-multipass-cluster-root | 完整生成集群发布到 `clusters/multipass/`，`machines.yaml` 位于集群根，保持原子发布 | proposal.md P-001 | sh/ps1 的 `clusters_root`、`cluster_root` 与发布调用；fake 成功流断言新路径同步生成 `cluster.yaml`、`machines.yaml`、`known_hosts`、secrets | 实现与要求一致 | pass   |
| CHG-multipass-cluster-root | 示例 CLI 从新 `clusters` 根读取集群与 `known_hosts`                                | proposal.md P-002 | `cli.py` 的 `CONFIG_ROOT` / `KNOWN_HOSTS`；CLI contract 测试及真实 `eleph-deploy validate` 从新根进入 preflight                             | 实现与要求一致 | pass   |
| CHG-multipass-cluster-root | 旧版完整信任包一次性受信迁移，非法/歧义状态失败关闭                                | proposal.md P-003 | `migrate_legacy_cluster` / `Move-LegacyClusterToStandardRoot`；迁移成功、双位置、文件、符号链接、旧备份负例测试                             | 实现与要求一致 | pass   |
| CHG-multipass-cluster-root | 新路径下生成配置与敏感材料仍被 git 忽略                                            | proposal.md P-004 | `.gitignore` 的 `clusters/` 条目；`git check-ignore` 对 machines.yaml、known_hosts、bootstrap.json、私钥命中；测试覆盖                      | 实现与要求一致 | pass   |

## Independent Defect Discovery

| Category                     | Evidence Inspected                                                                              | Adversarial Check                                                                                                                                                                                                                                                                   | Finding or Not-Applicable Reason                                                                                                                         | Status |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | sh/ps1 的路径定义、迁移调用点、发布事务、CLI 配置根和 README 路径                               | 反向核查迁移是否在锁内、发布是否仍单目录原子完成、`.tpl` 是否仍被替换删除、迁移后 trusted rerun 是否保留既有实例/密钥/host-key 校验                                                                                                                                                 | fake 首次创建与可信重跑只调用一次 `launch`、无 `start`；迁移后第二次运行成功且密钥不变；未发现行为分叉                                                   | pass   |
| boundaries-and-failure-paths | 迁移分支、旧备份检查、符号链接/非目录目标、双位置歧义、发布失败恢复                             | 构造新、旧位置同时存在、旧路径为文件/符号链接、旧集群备份残留、publish mv 失败 1/2/3 次、chmod 失败、launch 失败和信号中断                                                                                                                                                          | 所有构造均失败关闭：保留新旧状态或唯一恢复备份、锁与 staging 清理；迁移不触碰不完整或怀疑状态                                                            | pass   |
| regression-and-side-effects  | 示例测试套件、仓库根测试、README/契约测试、CLI contract、`.gitignore`、known_hosts/私钥发布位置 | 运行完整示例套件（不含环境缺失的 pwsh 用例）与仓库根全量测试；搜索 `CONFIG_ROOT`/`.state/clusters` 消费关系；逐个对 `clusters/multipass/{machines.yaml,known_hosts,bootstrap.json,secrets/id_ed25519}` 执行 `git check-ignore` 并断言 `.gitignore` 条目；验证 validate 从新根读集群 | 示例 91 项通过（1 项条件 skip；2 项 pwsh 环境缺失为既有 manual gap）；仓库根 62 项全通过；四个敏感/生成路径全部被 `clusters/` 命中；未发现框架或示例回归 | pass   |

## Verification

- Targeted check: `bash -n`、Python
  语法检查、示例测试套件（`uv run --extra test python -m pytest examples/eleph-server-multipass/tests -q -k "not bootstrap_is_valid_powershell and not bootstrap_generates_unencrypted_key"`）、仓库根
  `tests` 全量、`eleph-deploy validate --cluster multipass` 从新根进入制品
  preflight、`git check-ignore` 覆盖检查
- Result: passed
- Exception reason: 本机无 `pwsh`，两个 PowerShell 运行时用例未执行（既有环境缺口）；真机 Multipass
  E2E 仍属任务环境缺口

## Findings

| ID  | Severity | Evidence                                     | Problem              | Blocking |
| --- | -------- | -------------------------------------------- | -------------------- | -------- |
| F-1 | none     | 四类独立证伪、针对性验证、真实验证命令均通过 | 未发现任务范围内缺陷 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付满足批准提案与四个 proposal item，新旧位置迁移、失败关闭、原子发布和 git
  忽略均有针对性测试与真实命令证据；遗留的 pwsh/真机 E2E 为明确环境缺口而非本次变更回归。
