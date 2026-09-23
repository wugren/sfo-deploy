# 添加 App

确定名称、目标机器、环境依赖及类型。带包应用还需要规范的远端绝对安装路径、版本、可信 tar.gz
制品来源与哈希、SSH 部署身份；服务型应用还需服务运行账号、实际启动路径和参数。配置型应用需要
真实配置目标和适配格式，按需提供 validator。

## 带包应用

复制 `assets/app-versioned/` 到
`apps/<名称>/`，替换名称、路径、账号、启动命令。此模板针对带可执行文件 `bin/server`
的服务包；不需要服务的程序应删除 `management`。需配置文件时添加顶层 `configs` 及模板。

合并 `cluster.yaml.apps.<名称>`，并合并根 `app_versions.yaml`：

```yaml
schema_version: 1
apps:
  backend:
    version: "1.0.0"
    package:
      provider: https
      source:
        url: "https://artifacts.example.invalid/backend-1.0.0.tar.gz"
      hash:
        algorithm: sha256
        value: "REPLACE_WITH_TRUSTED_SHA256"
```

上例是待补草稿，URL 和摘要必须替换后才能验证交付。不要以随机摘要或全零摘要绕过校验。内置 filehub
改用 `provider: filehub`、`source: {target: "SERVER/PROJECT/VERSION/NAME"}`（SERVER
可带端口）；凭据由 filehub 客户端配置，不能塞进 package.source。其他 provider
先核对实际注册实现，不能假设支持 local/file。

- 新 app 使用 schema 1。`app.yaml` 不内联 version/package，也不添加
  parameters/defaults；它们不是允许的 App 字段。
- 非 packageless app 的内置发布自动使用 `deployment.kind: versioned`；App schema 1 不提供自定义
  deploy 脚本。
- versioned App 不声明 `run_as`/`access_group`：部署与解包身份就是机器的 SSH 用户；安装目录是规范
  绝对 POSIX 路径，不含 `..`。需要让其他身份（如 nginx worker）读取发布树时，在根节点声明 `mode`
  （八进制；`0644` 表示文件 0644、目录 0755），未声明时发布根保持 0750。
- 包必须为有效 tar.gz。包内容应包含启动入口；版本化发布将内容置于 `<install_directory>/<version>/`
  并切换 `latest`。systemd 模板使用 `working_directory: latest`，不是 `current`。
- 当前契约不支持自定义 deploy 脚本；配置逻辑放在 `configs.kind: script`，服务生命周期放在
  `management.kind: script`，不能以旧版 `scripts.deploy` 绕过内置发布。

## 无包配置应用

复制 `assets/app-config/` 到 `apps/<名称>/` 并按用途替换。示例 `settings` 发布结构化 JSON 到
`/home/deploy/settings.json`；它只演示已有目录的配置交付，不安装目录、不运行服务。

- `packageless: true`，配置由 `configs.kind: script`、managed config 或 `management.kind: service`
  的 `unit_config` 提供；App schema 1 不提供独立 check，不能声明 deploy 或 deployment。
- 必须存在根 `app_versions.yaml`，但该 app **不能**有版本记录。若全是无包应用，文件内容仍为
  `schema_version: 1` 和 `apps: {}`。
- 合并 `cluster.yaml.apps`，按需要追加环境依赖。

## Managed 配置和服务

App schema 1 使用顶层 `configs` 和 `management.kind`；不用旧的 management actions
列表，也不用已移除的顶层 `scripts`、templates、secret_values/secret_files 或
updater。模板文件本身仍可放在 `templates/`。

- config entry：`kind: file`，不声明 name，包含 App 内 source、远端绝对 target、format 必填；可选
  owner/group/mode、variables、validator、on_change。versioned App 的 target 可用
  `'${CURRENT_VERSION_DIRECTORY}/resources/application.yml'` 表示版本内路径；`${INSTALL_DIRECTORY}`
  是安装根，`${LATEST_DIRECTORY}` 是 latest 软链。目录变量必须在开头，路径不含 `..`，且 App 已声明
  install_directory。框架会在候选版本内创建缺失父目录，但不允许越界或符号链接逃逸。
- versioned App 的 target 可嵌入 `${APP_VERSION}`；它替换为 `app_versions.yaml` 中当前部署动作
  选中的版本字符串，随后仍执行 canonical path、越界和符号链接检查。例如
  `'${INSTALL_DIRECTORY}/${APP_VERSION}/config/application.yml'`。无包 App 不提供内置版本占位符； 若
  `APP_VERSION` 已声明为秘密，target 不适用秘密替换，但 structured config 内容仍可按秘密引用。
- structured managed config 的 yaml/json/toml/ini 内容可直接使用 `${APP_VERSION}`，无需为它声明
  `variables`。若 cluster 已声明名为 `APP_VERSION` 的秘密，内容中的占位符继续按秘密引用处理。
  `format: nginx` 不支持该占位符。它也不是远端脚本进程环境变量。
- 支持 yaml/json/toml/ini，源文件应能按对应格式解析；`format: nginx` 发布 UTF-8 原生 Nginx 片段，
  不解析 Nginx DSL，也不支持 variables 或秘密占位符。模板 mode 要用字符串，如 `"0600"`。
- config entry 也可以是 `kind: script`，包含 `path` 与 `permissions`；`permissions` 除 `run/net`
  外可分别声明 `read/write` 绝对路径。配置脚本在 `configure` 生命周期执行，必须幂等。
- `on_change: reload|restart` 要有 `management.kind: service`；纯文件配置使用 `none`。可选 validator
  为绝对可执行路径开头的 argv，必须恰有一个独立的 `"{candidate}"` 参数。
- 最多一个管理器。`kind: service` 必填以 `.service` 结尾的 `name`，`tool: auto|systemctl|service`
  覆盖 Ubuntu/CentOS。没有 unit_config 时管理已有服务；声明 unit_config 时生成 unit，必须
  `daemon_reload: true`，且 `tool` 不能是 `service`。
- `management.kind: script` 必须声明 `start/stop/restart` 三个脚本，每个是
  `{path: scripts/start.ts, permissions: {run: [], net: []}}` 形式的调用对象，不是列表或裸路径。
- service 管理器的 `enabled` 缺省为开机启动，显式 `false` 关闭；`on_deploy` 缺省为 `none`， 可选
  `start`/`reload`/`restart`。缺省 `enabled` 不覆盖 `on_deploy`/`on_change`；versioned App 显式
  `enabled: true` 时按原服务状态覆盖为 start/restart。无包 App 部署走
  configure，服务动作按文件变化的 `on_change` 收敛，不能依赖 `on_deploy` 触发。
- unit_config 的 working_directory 相对 install_directory 解析；也支持与 config target
  相同的目录变量 （`${INSTALL_DIRECTORY}`
  安装根、`${LATEST_DIRECTORY}`/`${CURRENT_VERSION_DIRECTORY}` latest 软链），
  变量必须在开头、只出现一次并已声明 install_directory。versioned App 还可嵌入
  `${APP_VERSION}`；它替换为当前部署版本字符串，随后执行既有目录路径校验。command
  相对该工作目录解析，必须包含 `/`（如 `bin/server`），或为绝对路径。args 是字面值列表，不是 shell
  命令。
- unit_config 可选声明崩溃拉起：`restart_policy`、`restart_sec`、`start_limit_interval_sec` 和
  `start_limit_burst`。它们分别映射为 systemd 的 `Restart`、`RestartSec`、 `StartLimitIntervalSec`
  和 `StartLimitBurst`；未声明时不写入新指令。这些字段只在框架生成 unit 时生效，不修改已有外部
  unit。
- App 顶层没有 `scripts`；`configs` 可同时包含 script 和 file，两类均会执行；`management.kind`
  只能是 script 或 service。省略 `management` 仍会发布文件配置和执行配置脚本，此时文件 `on_change`
  必须为 `none`。
- App 脚本以 SSH 用户身份执行（root SSH 即 root）；框架生成的 unit 用 `unit_config.user`，缺省取 SSH
  用户；显式 `unit_config.user` 必须为非 root 账号。root SSH 时必须显式指定该非 root 服务账号，
  否则准备阶段失败关闭。账号及目录实际存在、特权操作可用，需要部署环境 验证，不能由 plan 推断。

普通 `deploy` 将带包应用组织为所有目标 stage、所有目标 activate，再按管理器与策略执行服务动作；
有配置脚本时在 stage 前运行 configure。这是阶段协调，不保证跨机器事务原子性。

## 非激活部署与后续激活

`deploy --no-activate` 保留配置交付，`plan --no-activate` 只预览此行为。实际部署跳过框架管理的
daemon-reload、 enable、start/reload/restart。versioned App 仅 stage，不切换 `latest`、不写 App
版本标记； packageless App
仍写配置，但不让服务加载它。配置脚本仍运行，所以不要将服务启动或重启藏在配置脚本里，
也不能把此选项理解成脚本无副作用。

非激活部署成功后产物留在目标机。后续 versioned App 可用普通 deploy 激活；无包 App 若配置已无变化，
不能依赖 `on_change` 再次触发服务，应显式 restart。 这些都是远端操作，生成配置本身不授权执行。

`start`/`stop`/`restart` 默认只选择 App；要操作环境服务需显式使用 `--environment`/`--env`。 CLI
不提供独立 `install`/`configure` 命令：环境用 `prepare`，App 配置用 `deploy`。
