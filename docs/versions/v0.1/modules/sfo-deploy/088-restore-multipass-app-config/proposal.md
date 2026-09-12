---
task_manifest: task.yaml
status: approved
---

# 恢复 Multipass 被覆盖的 App 配置

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: standard
- 理由：恢复涉及部署安装目录、服务启动参数及业务配置，触及部署行为边界。
- 确认状态：2026-09-13 当前用户确认“确认，按简单任务恢复就好”，选择 standard，授权完整恢复、验证及收尾。部署行为风险已告知，按用户选择执行轻量流程。

## Background and Goal

prepare 使用模板替换了生成集群。找到 `/tmp/opencode/multipass-fixed/apps` 的
2026-09-11 22:01 副本，包含五个文件，但不能证明它等于覆盖前最后一刻的全部内容。
084 变更记录另证明生成目录的 working_directory 后来采用 `${LATEST_DIRECTORY}`。
目标是基于可核查副本和明确后续记录恢复 App 配置。

## Scope

恢复 `clusters/multipass/apps` 中两个 app.yaml、jx-web/templates/jx-web.conf、
jx-server/application.yml 和 application-local.yml。执行前独立备份当前 apps 和恢复源。
仅恢复本地 App 文件；不重建 VM、不部署、不修改机器信息、SSH 密钥、环境、版本清单、模板或 prepare。

## Requirement Review

找到的副本是恢复候选而非已证实的最终备份。副本恢复 /opt/eleph-server、/opt/jx-web、
jx-server.jar、服务重启策略、Spring 配置引用及 test.eleph-label.com。
将 working_directory 按 084 明确记录恢复为 `${LATEST_DIRECTORY}`。
业务配置文件可能包含秘密，不在提案或终端输出其值，不提交到 Git。

## Proposal Items

| proposal_id | change_id | requirement | success_evidence |
| --- | --- | --- | --- |
| P-001 | CHG-restore-multipass-app-config | 备份现状，从上述五文件副本恢复，补上明确记录的 working_directory 后续修改 | 核对恢复差异并完成本地配置校验，保留对未知后续修改的限制说明 |

## Success Criteria

五个文件恢复且内容可追溯至候选副本和 084 记录；本地配置校验通过，或明确指出既存外部依赖阻塞。
当前 apps 有可回退备份。无 VM、远端部署及其他集群配置变更。

## Risks

无法保证恢复未留下记录的后续修改；源副本并非原子替换留下的正式备份。
恢复安装目录及启动参数会影响将来的部署。以后再次运行 prepare 仍会覆盖这些本地修改。
