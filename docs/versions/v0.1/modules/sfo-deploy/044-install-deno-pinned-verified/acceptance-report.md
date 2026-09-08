# install-deno 最新稳定版与发布包校验验收报告

## Findings

| ID   | Severity | Owning Stage | Correctness Category | Evidence                                                                                                                    | Problem                                                                                                                     | Blocking |
| ---- | -------- | ------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| F-01 | none     | none         | overall              | `testplan.yaml` manual_gaps：`real-ssh-install`、`latest-release-race`；任务级统一入口测试工件 20260904T085022Z             | 自动测试无法证明真实目标机工具链和 GitHub 两次下载之间无新版发布的运行行为；脚本已 fail-closed 且可重跑，记为非阻断残余风险 | no       |
| F-02 | none     | none         | overall              | `src/ssh_install.ts`、`src/integration.ts`、`src/cli.ts`、README、testing.md/testplan.yaml、任务测试工件与 `sh -n` 语法检查 | 除 manual gap 外，未发现阻断需求或安全边界缺陷                                                                              | no       |

## Object and Scope

- Task manifest: task.yaml
- Review date: 2026-09-04
- In-scope implementation: `install-deno` 缺省最新稳定版、已有旧版本升级、显式精确版本、 Deno 官方
  GitHub Release 下载与 `.sha256sum` 校验、CLI 帮助/README 契约和相关测试。
- Review mode: independent falsification；验收阶段重新读取 proposal/design/实现/测试与
  运行工件，先构造反例和检查残余风险，后选择结论。

## Requirement Coverage

| change_id                        | Requirement or Boundary                                                                                                                    | Source                                                      | Implementation Evidence                                                                                                                                                                                                                                                               | Finding                                                                      | Status |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| CHG-install-deno-latest-verified | 缺省安装最新稳定版；已有旧版本升级；显式 `--deno-version` 精确匹配；官方 zip + `.sha256sum` 校验；不执行 install.sh；CLI/JSON/退出码不扩展 | `proposal.md` PI-1、Success Criteria；`design.md` Key Flows | `src/ssh_install.ts` `InstallDenoOptions.version?: string`、latest/pinned URL、`sha256sum -c`、staged version 比较、`sfo-deno-present` 标记；`src/integration.ts` 不再注入固定默认；`src/cli.ts` 帮助；`tests/dv/install_deno.test.ts`、`tests/unit/ssh_install.test.ts`；README 契约 | 需求行为和边界逐条落地；动态 latest 的真实网络/竞态已记录为非阻断 manual gap | pass   |

## Independent Defect Discovery

| Category                      | Applicable Scope                              | Evidence Inspected                                                                                                     | Adversarial Check                                                                                                          | Finding or Not-Applicable Reason                                    | Status |
| ----------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| requirement-and-behavior      | 最新稳定版、升级、精确版本、校验、非目标      | proposal PI-1；src/ssh_install.ts `installDenoOnMachine`/`installerScript`；src/integration.ts `runInstallDeno`；tests | 检查“任意 Deno 2+ 即 present”“install.sh 管道”“latest 但不升级”等旧行为反例；当前实现均不成立                              | no defect found                                                     | pass   |
| logic-and-control-flow        | 显式/缺省分支、staged 比较和复验              | `installerScript` 条件、`installDenoOnMachine` probe/install/verify 状态流；unit/DV 用例                               | 反例：显式旧版本跳过、显式不同版本安装、latest 已最新跳过、latest 旧版升级、复验不匹配；测试覆盖预期分支                   | no defect found                                                     | pass   |
| boundary-and-input            | version、install-to、CPU 架构、待装输出       | `normalizeDenoVersion`、`validateInstallTo`、`uname -m` case、staged version case                                      | 非法 semver、Deno 1、注入字符、`..`、相对路径、空白路径、不支持架构、无法识别输出均被拒绝或 fail-closed                    | no defect found                                                     | pass   |
| state-and-data-integrity      | 远端 install-root/bin/deno 和 outcome 状态    | 临时目录、同目录 `cleanup_binary` + `mv`、`sfo-deno-present` 状态、InstallDenoResult                                   | 反例：半写二进制、校验失败覆盖、已最新误标 installed、复验版本漂移；脚本先校验后安装并原子替换，测试覆盖结果               | no defect found                                                     | pass   |
| error-handling-and-recovery   | 下载、校验、解压、安装、工具补齐失败          | TransportError 路径；FakeSession checksum/install/tool failure；DV 退出码                                              | 失败不静默降级；包管理器缺失/提权失败/校验失败/安装失败分别暴露并保持可重跑                                                | no defect found                                                     | pass   |
| resource-lifetime-and-cleanup | 远端临时目录、临时二进制、SSH session         | `trap ... EXIT HUP INT TERM`；DV `assert(session.closed)`                                                              | 检查成功、校验失败、安装失败和信号路径；trap 清理 `tmp_dir` 和未提交 `cleanup_binary`，SSH 会话由 integration finally 关闭 | no defect found；SIGKILL 属不可捕获边界，残留隐藏临时文件可重跑覆盖 | pass   |
| concurrency-and-ordering      | runInstallDeno 机器循环与远端安装脚本执行顺序 | `runInstallDeno` for-of 串行；installerScript 单次下载/校验/安装顺序                                                   | 无并行安装或共享安装状态声明；同 Release 资产两次下载竞态由哈希不匹配 fail-closed                                          | no defect found                                                     | pass   |
| interface-and-compatibility   | CLI 参数、JSON、退出码、帮助/README           | RunOptions/CLI tests、integration JSON tests、README contract                                                          | 未新增 CLI 参数或 JSON 字段；帮助语义更新；显式版本继续可用；文档示例命令保持有效                                          | no defect found                                                     | pass   |
| security-and-capacity         | 供应链、URL、shell 输入、提权                 | 官方 GitHub URL、同名 `.sha256sum`、`sha256sum -c` 前置、版本正则、路径校验、`quotePosix`/`validateArgv` tests         | 检查非官方镜像回退、未校验执行、shell 注入、路径逃逸和任意主版本跳过；均未发现绕过                                         | no defect found                                                     | pass   |
| test-adequacy                 | 单元/DV/集成/契约和统一入口                   | testplan U1/U2/D1/I1/I2；运行工件 20260904T085022Z；`sh -n` POSIX 语法检查                                             | 覆盖正常、边界、负向、错误、生命周期和文档契约；真实 SSH/工具链和 latest race 记录为 manual gaps                           | F-01：低风险 manual gap，不阻断当前验收                             | pass   |

## Document Consistency

| Document | Source                        | Implementation Consistency                                                              | Finding     | Status |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------- | ----------- | ------ |
| design   | `design.md`                   | optional version、latest/pinned URL、checksum 前置、staged 比较、原子替换和失败语义一致 | no mismatch | pass   |
| testing  | `testing.md`, `testplan.yaml` | U1/U2/D1/I1/I2 与实现行为一致；统一入口运行成功并写入工件                               | no mismatch | pass   |
| proposal | `proposal.md`                 | Scope、non-goals、success criteria 与实现一致；README/契约测试收口                      | no mismatch | pass   |

## Result Summary

- Overall result: accepted
- Outcome: 需求覆盖通过，独立缺陷发现未发现阻断缺陷；任务作用域测试全部通过。
- Blocking issues: none
- Next action: 记录验收收据、完成任务索引移除，并向用户交付变更摘要与 manual gap。

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 缺省最新稳定版、旧版本升级、精确版本和官方发布包校验均有可运行证据；供应链 失败路径
  fail-closed。真实目标机工具链与 latest Release 竞态作为非阻断 manual gap 记录。
