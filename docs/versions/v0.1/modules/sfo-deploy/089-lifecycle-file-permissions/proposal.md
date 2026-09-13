---
task_manifest: task.yaml
status: approved
---

# 生命周期脚本文件权限配置

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment
- 建议层级：high-risk；用户最终确认层级：high-risk。
- Final tier: high-risk
- 用户已于 2026-09-13 11:08:08 CST 回复“确认”，确认本提案和层级并授权整个任务执行。
- 原因：改变脚本权限安全边界、配置契约、远端执行行为，并移除 Python 运行时支持（含历史快照兼容），属于安全/契约/迁移类触发边界。
- 待确认事项：本提案按用户当前指令不要求支持 Python，并删除 sfo-deploy 中全部 Python 相关逻辑；该决策已并入下方范围。

## Background and Goal
用户要求自定义生命周期脚本的读写权限能够通过配置控制。当前 ScriptPermissions 仅有 run/net，Deno 直接读写权限固定为远端工作目录。此前用户认可 App 安装目录及远端 ~/.sfo-deploy 内的文件操作，但这不等于要求默认开放整个目录。
用户同时明确：不要求 sfo-deploy 支持 Python 运行时；仓库中现有的 Python 专属逻辑应删除。

## Scope
- 支持脚本级独立 read/write 路径配置，贯通解析、计划、部署包脚本、历史快照编解码及执行入口。
- 保持框架运行所需最小文件访问权限；未配置 read/write 的脚本保持现有远端工作目录读写行为，框架必要权限与用户扩展授权分别处理。
- 明确缺省行为、Deno 原生路径前缀展开语义，以及删除操作受 write 授权控制的语义。
- 移除 Python 运行时支持：删除 python.py 秘密 loader、preflightPython/executePython、ScriptRuntimeKind 的 python 值及其调用链；历史 schema v1（Python 快照）不再解码/回放，遇到时明确拒绝。
- 更新相关文档、示例并验证允许与拒绝行为。
- 不修改内置版本保留策略、密钥删除流程及框架临时目录位置。
- 子进程操作系统级隔离仍不在本次范围：run 中授权的程序可自行读写，框架只负责 Deno 原生文件权限配置。

## Requirement Review
需求合理。方向是在现有 permissions 下增加 read/write 规范绝对位置列表，直接映射到 Deno 运行时 --allow-read/--allow-write。保持未配置脚本现有直接文件访问行为；框架必要权限（远端工作目录）始终保留，用户扩展授权与框架必要权限分别合并后生效。
Deno 的文件权限不能限制获准启动的外部程序；不能把传入路径配置或环境变量称为强制隔离。由于用户明确不要求 Python 支持，本提案删除全部 Python 专属逻辑，不保留任何 Python 运行时或历史快照编码路径。

## Proposal Items
| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-lifecycle-file-permissions | 脚本可分别声明 `read`/`write` 远端路径，贯通装载、计划、快照与执行。 | 只授予 Deno 原生文件 API 的路径；框架 workspace 读写始终保留，未配置时不扩大边界。 | 用户获得更精确授权，但外部程序仍不受 Deno 文件权限限制。 | 实际 Deno 运行验证授权读写成功，未授权写/删除被拒绝；快照往返和旧配置兼容通过。 | 不提供子进程操作系统级隔离。 |
| P-002 | CHG-remove-python-runtime | 删除 Python 运行时支持，新版本只接受 Deno。 | 移除 Python loader、session 方法、运行时 kind 和 schema v1 兼容解码。 | 减少双运行时维护面，但旧 Python v1 快照不可回放。 | 源码无 Python 执行链，schema v1 解码返回明确不支持错误，检查与测试通过。 | 不迁移或改写旧 Python v1 历史快照。 |

## Success Criteria
- 配置可分别授权读取与写入；未获写入授权的直接写入/删除被拒绝；只读授权不能删除文件。
- 实际 Deno 运行验证授权成功及越界拒绝；仅命令参数 mock 不作为权限有效的充分证据。
- 配置解析、部署与重放传递正确；旧配置（未声明 read/write）和内置发布流程保持兼容。
- 源码中不再存在 Python 运行时专属逻辑；schema v1（Python）快照解码返回明确的不支持错误。
- 文档准确说明默认文件访问边界、扩展授权结构与子进程边界。

## Risks
- run 中授权的程序可以绕过 Deno 的 read/write 限制；本提案不提供子进程隔离。
- 路径前缀、逗号、软链接与权限缺省行为需要边界验证。
- 移除 Python 后，已归档旧 Python v1 快照不再可回放；需要迁移或使用匹配旧快照的旧版执行器。历史 codec 与内置运行时权限必须同步检查。
