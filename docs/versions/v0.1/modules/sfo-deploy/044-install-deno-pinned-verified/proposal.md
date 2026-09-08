---
task_manifest: task.yaml
status: approved
---

# install-deno 安装最新稳定版并验证发布包提案

Risk profile: ./risk-profile.yaml

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 本任务把 `install-deno` 的生产默认 从固定 2.2.11
  改为动态“最新稳定版”，并要求已安装旧版本时升级。该行为
  触发生产默认/发布语义、远端运行时生命周期和供应链信任边界变化；用户还 要求固定发布资产 URL
  并验证官方 `.sha256sum`。这不是仅改常量，需要设计、 实现、测试与独立验收，因此建议 high-risk。
- Proposal and tier confirmation: 用户已于 2026-09-04 回复“确认，自动完成”， 确认本 high-risk
  方案并授权自动完成完整生命周期。

## Background and Goal

当前默认安装 Deno 2.2.11，该版本在用户给出的 CVE-2026-44726 受影响范围内。
同时，`installDenoOnMachine` 只要探测到已有主版本 Deno 2+ 就返回 `present`，
不检查是否有更新；因此已受影响的旧版本不会被升级。安装流程还通过管道把
`https://deno.land/install.sh` 直接交给 `/bin/sh` 执行，没有显式固定发布资 产 URL，也没有校验官方
`.sha256sum`。

目标：缺省安装 Deno 最新稳定版；远端已有 Deno 时下载并校验最新稳定版，若
已有版本较旧则升级。显式传入 `--deno-version` 时仍安装该精确版本。安装时 直接从 Deno 官方 GitHub
Release 下载发布压缩包和官方校验文件，先校验成功 再解压安装，不再执行远程 install.sh。

## Scope

### In scope

- 移除“缺省固定 2.2.11”的语义；缺省使用 Deno 最新稳定版。
- `--deno-version VERSION` 继续作为显式精确版本请求；只有远端已有 Deno 的
  精确版本等于该请求版本时才跳过。
- 缺省安装使用 Deno 官方 GitHub `latest/download` 固定资产 URL：
  `https://github.com/denoland/deno/releases/latest/download/deno-<target>.zip`， 同时下载同名
  `<archive>.sha256sum`。
- 显式版本安装使用该版本的官方 GitHub Release URL：
  `https://github.com/denoland/deno/releases/download/v<version>/deno-<target>.zip`， 同时下载同名
  `<archive>.sha256sum`。
- 远端脚本校验 `.sha256sum`，校验通过后在临时目录解压并探测待装版本；缺省
  模式下已有版本等于待装最新版本时返回 `present`，版本不同则升级；显式版 本模式下精确匹配时跳过。
- 将 Deno 可执行文件安装到 `DENO_INSTALL/bin/deno`，安装后复验实际版本。
- 支持 Linux `x86_64` 与 `aarch64` 发布资产；遇到不支持的远端架构时失败并 给出明确提示。
- 继续复用现有 curl/wget、unzip/7z 探测与自动补齐逻辑。
- 更新 README 与 install-deno 文档契约中关于默认版本、精确版本跳过和信任边 界的说明。
- 更新单元、DV 和契约测试，覆盖旧版本升级、新版本跳过、URL/脚本形态和校 验失败拒绝安装。

### Out of scope

- 不新增或修改 `install-deno` 的 CLI 参数、JSON 字段、退出码或确认门禁。
- 不改变 `--install-to` 路径验证、提权判定、机器循环或后续 Deno 路径使用。
- 不增加 Windows/macOS 远端目标支持。
- 不引入新的第三方下载器、镜像源或离线校验包。
- 不自动选择预发布版；GitHub `latest/download` 只解析当前最新稳定 Release。
- 不处理本仓库其他依赖版本或示例脚本。

## Requirement Review

用户最新要求合理：默认跟踪最新稳定版可以避免默认常量滞后导致已知 CVE 持续 进入新目标机；已有 Deno
也不能只看主版本而跳过。使用官方 GitHub `latest/download` 加同名 `.sha256sum`
可以保留最新版语义，同时把信任边界限 制在 Deno 官方 Release 和 HTTPS，不执行远程安装脚本。

取舍：动态最新版可重复运行时可能下载新 Release；压缩包和校验文件两次请求
之间如果正好发生新版发布，会因哈希不一致失败并可重跑。为了判断已有版本是
否已是最新，需要下载并校验最新资产后再比较；这比每次无条件覆盖更保守，但
比固定版本运行需要更多网络操作。

## Proposal Items

| proposal_id | change_id                        | requirement                                                                                                    | boundary                                                       | tradeoff                                                                        | success_evidence                                                                | non_goal                    |
| ----------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| PI-1        | CHG-install-deno-latest-verified | 缺省安装最新稳定版并升级已有旧版本；显式版本仍精确安装；安装前校验官方 `.sha256sum`，不再执行远程 install.sh。 | 只改远端 Deno 引导和对应文档/测试；不扩展平台或 CLI 参数契约。 | 用动态最新版换取默认版本不过期；升级前下载/校验最新资产，已最新时返回 present。 | 相关单元/DV/契约测试证明最新版 URL、升级/跳过语义、校验失败拒绝安装和文档一致。 | 不新增 CLI 参数或结果字段。 |

## Success Criteria

- Concrete user-visible result: 缺省安装使用当前最新稳定版；已有旧 Deno 的目
  标会升级；已有最新稳定版的目标返回 `present`；显式版本请求仍精确匹配。
- Required evidence: 远端安装脚本使用官方 GitHub Release/latest 资产 URL 和 `.sha256sum`
  校验，不包含 install.sh 管道；校验失败时不安装；相关测试通过。
- Explicit non-goals: 不保证其他 CPU 架构或非 Linux 远端可用；不缓存发布资 产；不安装预发布版。

## Risks

- 若目标机缺少 `sha256sum` 或 `install`，新安装路径会失败；这比静默执行未校
  验脚本更安全，错误应明确暴露。
- 动态最新版可能引入未在本次验收时点的行为变化；`latest/download` 的解析结 果依赖 GitHub
  当前最新稳定 Release。
- 从官方 GitHub Release 下载仍依赖网络与 GitHub 可用性；HTTPS 与官方校验文 件是本次选择的信任边界。
