# sfo-deploy 集群配置技能

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/067-cluster-configuration-skill/task.yaml
- Approved proposal: docs/versions/v0.1/modules/sfo-deploy/067-cluster-configuration-skill/proposal.md
- Affected paths: skills/sfo-deploy-cluster/**；本任务流程文档；默认 Codex skills 安装目录
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

新增中文技能入口，按初始化、环境、应用、秘密分流参考资料，提供空集群、Ubuntu/Debian nginx 环境、带包服务应用与无包配置应用模板。模板按现有源码确认 schema 和动作所有权；不引入重复实现 YAML 合并的生成器，由代理保留现有配置增量编辑。安装到本地 skills 目录。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

本次只新增技能和示例，不修改框架协议或连接真实节点。实际生成项目需要真实业务输入，不能把本地校验等同于部署成功。

## Verification

- Targeted check: 技能结构校验、隔离临时项目的 validate/plan、自包含脚本类型检查、独立缺陷审查。
- Result: passed
- 已运行系统 Python 的 quick_validate.py（源码与安装副本均通过）；14 项隔离 CLI 验证与预期拒绝检查全部通过；3 个脚本通过 deno check/fmt，2 个 check 脚本返回值与实际前置条件一致。
- 证据：.harness/evidence/v0.1/067-cluster-configuration-skill/smoke-results.json。空集群及仅环境集群的 plan 返回无部署对象，属框架既有边界；添加 app 后计划成功，并确认 versioned 的 stage/activate/restart 顺序和 latest 启动路径。
- 技能源与 /root/.codex/skills/sfo-deploy-cluster 的 17 个文件内容一致；相对文档引用完整。
- Residual risk or follow-up: nginx 模板使用发行版包而非精确版本固定；真实机器与业务制品由使用者提供。

独立验收由 skill_acceptance 单独执行；从模板重建空集群、环境、无包与带包应用，验证成功及依赖失败路径，确认既有 settings 文件逐字节保留，结论接受。
