# sfo-deploy

一个供项目部署模块复用的 Deno 2 / TypeScript SSH 集群部署框架。控制端、公共 API 和远端生命周期
脚本都使用 TypeScript；每个集群是独立目录。当前 `cluster.yaml` 只接受 schema 2；Environment、
机器、用户配置和 App 版本文件使用 schema 1。App schema 1 使用顶层 `configs` 与
`management.kind: script|service`，旧 App schema 2/3/4 直接拒收。

集群配置和使用命令见[sfo-deploy 集群配置与使用指南](docs/guides/sfo-deploy-cluster-configuration.md)。

## 安装

先安装 Deno 2，并确认本机已有 OpenSSH 的 `ssh`、`scp`。如果配置使用 `filehub` provider，还要
先安装并配置 `filehub`。在本仓库根目录执行：

```bash
deno install --global --force --name sfo-deploy --allow-read --allow-write --allow-env --allow-net --allow-run=ssh,scp,filehub,ps ./src/cli.ts
sfo-deploy --help
```

这是通用 CLI 的最小权限类别：读取集群、密钥和快照，写入临时文件与发布历史，读取项目绑定所需的
环境变量，通过 HTTP/HTTPS 下载制品，并且只启动 `ssh`、`scp`、可选 `filehub` 和用于进程树
清理的只读 `ps`。它不使用
`--allow-all`。固定项目可以进一步把 read、write、env 和 net 限制为已知路径、变量和下载主机。 保留
`filehub` 的 run 授权不会安装该程序；不用 filehub 时可移除它。

Deno 把命令安装到 `$DENO_INSTALL_ROOT/bin`；未设置时通常是 `$HOME/.deno/bin`，Windows 为
`%USERPROFILE%\.deno\bin`。如果 shell 找不到 `sfo-deploy`，把对应 `bin` 目录加入 `PATH`。

正式环境应固定到已审核的 tag：

```bash
deno install --global --force --name sfo-deploy --allow-read --allow-write --allow-env --allow-net --allow-run=ssh,scp,filehub,ps https://github.com/wugren/sfo-deploy/-/raw/v0.1.0/src/cli.ts
```

升级时把 URL 中的版本换成目标固定版本并重新执行带 `--force` 的命令；卸载使用
`deno uninstall --global sfo-deploy`。仓库没有发布到 JSR、npm 或其他注册表；tag URL 只在对应 tag
已推送且当前网络可访问 GitLab 后可用。

## sfo-deploy-cluster skill

仓库内置 [sfo-deploy-cluster](skills/sfo-deploy-cluster/SKILL.md)，用于创建和维护 sfo-deploy
集群配置项目。它可辅助初始化集群目录、添加 Environment 及机器放置、添加带包或无包 App，并维护
版本、配置、服务管理和秘密声明。模板只生成配置；除非另行授权，不要执行远端部署动作。

### 安装 skill

把仓库内的 skill 目录复制到 Codex skills 目录；目标已存在时应先确认或删除旧副本。新 skill 在下一
轮对话中可用：

```bash
SKILL_SRC="$PWD/skills/sfo-deploy-cluster"
SKILL_DEST="${CODEX_HOME:-$HOME/.codex}/skills/sfo-deploy-cluster"
test ! -e "$SKILL_DEST"
mkdir -p "$(dirname "$SKILL_DEST")"
cp -a "$SKILL_SRC" "$SKILL_DEST"
```

### 安装提示词

可以直接复制以下提示词给 AI：

```text
请安装 https://github.com/wugren/sfo-deploy.git 中的 sfo-deploy-cluster skill。
```

## 命令行

```bash
sfo-deploy validate --cluster production
sfo-deploy plan --cluster production --app backend
sfo-deploy check --cluster production
sfo-deploy prepare --cluster production --env runtime
sfo-deploy fetch --cluster production --app backend
sfo-deploy deploy --cluster production --app backend
sfo-deploy start --cluster production --app backend
sfo-deploy stop --cluster production --app backend
sfo-deploy restart --cluster production --app backend
sfo-deploy history --cluster production
sfo-deploy rollback --cluster production --release-id <release_id>
sfo-deploy install-deno --cluster production --machine app-01 --yes
sfo-deploy secrets-deploy --cluster production --machine app-01
```

`--config-root` 省略时按 `./<集群名>`、`./clusters/<集群名>` 顺序发现；显式传入时不做当前目录
发现。可重复 `--machine`、`--app`、`--environment`/`--env`；`--executor-region` 覆盖执行器区域，
`--address-kind private|public` 显式覆盖地址类型。每个动作只接受其 `--help` 列出的筛选器。

默认按步骤输出英文人可读的进度行（步骤、机器、资源、动作与状态/跳过原因）、`[info]` 过程日志
（命令、本地准备、远端命令失败、上传、workspace、缓存、服务与发布操作），结束时给简洁汇总； `plan`
的详细预览包含序号、地址、依赖、包提供方、发布方式、脚本相对路径、秘密逻辑名称和受管服务/
配置信息。需要机器可解析结果时加 `--json`，使用稳定 JSON 契约；此时 stdout 不输出过程日志。
计划只包含敏感输入逻辑名称；执行器在输出离开边界前脱敏已知秘密，无法安全脱敏时丢弃输出。
过程日志只记录状态、路径、大小、hash、耗时和安全摘要，不记录 secret 值、private key 内容、 provider
凭据或未脱敏 stdout/stderr。

### 校验、准备和部署

`validate` 装载并检查全部 YAML、目录、依赖、放置和本地资源，不建立 SSH 连接。`plan` 只预览 App
deploy 计划，不下载包、不解析秘密值；空 App 选择集会失败。`check` 是环境动作，不接受
`--app`；省略环境筛选时检查当前范围内的全部环境。

`prepare` 是环境动作，不接受 `--app`。缺省全量时确认后执行；非交互必须 `--yes`。显式选择的环境
依赖必须同时选择，否则规划失败。环境更新失败不写版本标记。

`deploy` 只处理 App，不接受 `--environment` 或 `--with-dependencies`。执行前请求 `yes` 二次确认；
拒绝、EOF 或非交互未传 `--yes` 退出码 130，不创建发布记录。所有目标先完成 stage，再按依赖顺序逐
目标激活。这是阶段协调，不保证跨机器事务原子性，也不能撤销脚本的外部副作用。

`--no-activate` 适用于 `plan` 和 `deploy`：只上传、stage 和发布 managed 配置/版本，不切换
`latest`、不写 App 版本标记、不执行受管服务收敛。versioned App 只 stage；packageless App 发布受管
配置与脚本。配置脚本仍会执行，不能把服务重启藏在配置脚本里。后续普通 deploy 激活 versioned
产物；无包配置未变化时应显式 restart。

### 生命周期和依赖

`start`、`stop`、`restart` 默认只处理 App；显式 `--environment`/`--env` 才纳入环境。定向 App 不加
`--with-dependencies` 时只检查其传递环境依赖；加上后才执行当前筛选范围内的依赖动作。筛选器不会
隐式扩大。schema v2 的短依赖仍绑定当前机器上的同名 Environment；`机器/环境` 表示跨机依赖。

### install-deno

```bash
sfo-deploy install-deno --cluster production
sfo-deploy install-deno --cluster production --machine app-01 --yes
sfo-deploy install-deno --cluster production --deno-version 2.2.11 --install-to /usr/local
```

动作使用严格 OpenSSH 传输通过纯 SSH 安装 Deno。缺省安装最新稳定版，已有旧版本升级，已最新跳过；
显式版本只在精确匹配时跳过。缺省目标为 `/usr/local/bin/deno`，需要 root 或 `sudo -n`。若目标机 缺少
curl/wget 或 unzip/7z，会用 apt-get/apk/dnf/yum 提权安装（提权安装缺失工具后继续）。安装完成 后用
`deno --version` 复验。Deno 制品来自官方 GitHub Release，安装前校验同名官方 `.sha256sum`；基础工具
来自目标机发行版软件源。该动作不写发布历史，也不修改 `machines.yaml`；需要固定路径时手工填写
`machines[].deno`。

### 秘密命令

`secrets-deploy` 只接受 `--machine` 筛选。`--check` 只读报告缺失、漂移和未声明残留，返回非零退出
码；不能与 `--remove` 并用。消息和错误不打印秘密值。本地来源错误在连接前拒绝；远端缺失、权限错误
和漂移需要连接后检查。

### 并发、失败与退出码

start/stop/restart/deploy/rollback 创建控制端 release attempt，保存实际执行计划快照，并与目标锁
共同覆盖执行生命周期。每个目标上的受管状态转换在同一 App/目标 `flock`
租约内完成；控制端周期心跳续租， 断连或孤儿 holder 在有界租约 TTL
内自动退出并释放。租约丢失后受保护操作失败关闭；框架不自动重试 副作用动作。

固定退出码：成功 `0`，用法/配置错误 `2`，预检失败 `3`，下载/远端执行失败 `4`，用户取消 `130`。

## 发布历史与回退

```bash
sfo-deploy deploy --cluster production --app backend
sfo-deploy history --cluster production
sfo-deploy history --cluster production --release-id <release_id>
sfo-deploy rollback --cluster production --release-id <release_id>
```

`start`、`stop`、`restart`、`deploy` 和 `rollback` 创建 release attempt。成功结果中的 `release_id`
是本次发布 ID；远端版本一致、只记录跳过步骤时也会生成审计记录。`history` 省略 `--release-id` 列出
全部记录；`rollback` 必须提供 `--release-id`。历史与回退不能和机器、App、环境、区域、地址或依赖
筛选器混用。

每条记录保留原始调用选择（`selection`）和成功归档计划解析出的实际范围。历史查询和回退读取快照；
即使当前配置已不可装载，历史仍可浏览，但快照校验必须通过。

只有成功的 deploy/rollback 可作回退来源。start/stop/restart 只用于审计。回退重放 App deploy 和
已声明 configure；新 deploy 快照没有环境步骤。回退不执行环境 install/configure，也不撤销数据库
迁移、消息、外部 API 写入或其他脚本副作用。回退本身产生新发布记录。

新快照保存 Deno 运行时和逐脚本 `run`/`net`/`read`/`write` 权限。当前版本只支持 Deno，不读取或 回放
Python v1 快照。含 `run_as`/`access_group` 的旧计划和导入 `sfo_deploy.ts` 的脚本不安全或
不兼容时明确拒绝；不会自动注入兼容 shim。

历史固定在集群目录 `.sfo-deploy/releases/`，使用追加式 `intent.json`、可选 `outcome.json` 和不可变
`snapshot/`。框架不自动清理历史；运维方必须纳入容量监控、备份和恢复。快照不保存制品本体，回退时
原制品源必须可访问且哈希匹配。

HTTP/HTTPS 发布快照只接受不含用户名、密码、查询参数或 fragment 的稳定 URL；filehub 定位符必须是
规范四段目标。自定义下载 provider 参与可回退发布时必须实现版本化 `ReleaseSourceCodec`，提供稳定
schema 和严格往返的 `export_release_source`/`import_release_source`；仅实现 fetch 的旧 provider
不能进入审计发布。
