# sfo-deploy

## Long-lived Boundary

- 命令执行在非 JSON 模式输出 `[info]` 单行过程日志到 stdout；JSON 模式保持稳定结果 JSON 且不输出过程
  日志。公共 API 通过 `RunDependencies.onInfo` 注入回调，未注入时静默。日志统一为 info 级别；记录
  状态、路径、大小、hash、耗时和操作摘要，不记录 secret 值、private key 内容、provider 凭据或未脱敏
  stdout/stderr。成功远端命令不逐条输出 started/completed 日志；失败命令继续输出失败摘要。日志回调
  异常不会改变部署语义、事务边界或退出码。
- `cluster.yaml` 支持可选 `deployer_version` 精确版本门禁：声明后要求运行中的 sfo-deploy
  版本完全一致， 否则装载集群后、任何 SSH 前 fail-closed 拒绝受控动作；缺省不启用。运行时版本取自
  `deno.json` 的 `version` 字段。
- App schema 1 使用顶层 `configs` 与 `management.kind`：配置条目没有 `name`，以 `kind: script|file`
  区分；管理器是 `kind: script|service`，service 通过 `tool: auto|systemctl|service` 覆盖
  Ubuntu/CentOS。旧 App v2/v3/v4 不兼容。
- Environment schema v1 现在支持顶层 `install` 和可选 `manager`：安装是 package/script，服务管理是
  system/script；script manager 必需 start/stop/restart；`manager` 缺省表示不管理应用运行。新契约
  没有独立 `check`，与旧顶层 `scripts` 互斥；旧 scripts 行为保持不变。
- App `management.kind: service` 与 Environment `manager.kind: system` 省略 `enabled` 时默认为开机
  启动（systemd `enable`、SysV `chkconfig on`）；显式 `enabled: false` 关闭。缺省 `enabled` 不覆盖
  `on_deploy`/`on_change`，仅显式 `enabled: true` 保留部署动作覆盖。Environment
  `start_after_install: false` 时 `prepare` 计划新增 `enable` 步骤；`start_after_install: true` 仍由
  `start`/`restart` 收敛 enable。
- Environment schema v1 还可选声明顶层 `init`：`init.before_start`/`init.after_start` 是两个可选
  Deno 脚本列表，用于环境应用 `prepare` 安装/更新流程的启动前/启动后初始配置；`init` 整体可选，
  未声明或列表为空时不生成额外步骤。执行顺序为 install → before_start → start/restart →
  after_start。
- versioned App 的 `install_directory` 是发布根；`latest` 是当前/候选版本选择器。App schema 1 不再
  声明 `run_as`/`access_group`：部署、解包、内置发布与脚本统一以 SSH 登录身份执行并拥有发布根。
  根级可选 `mode`（八进制）在提交前收敛发布根与版本树，声明值作为文件模式、目录与可执行文件按 `X`
  语义补执行位；未声明时发布根保持 0750。框架生成的 unit 使用 `unit_config.user`，缺省取 SSH 用户。
- `deploy`/`plan` 支持 `--no-activate`：不切换 `latest`、不写 `<app>.version`
  标记、不执行任何受管服务 收敛（不 daemon-reload、不 enable、不 reload/restart/start）。versioned
  App 只执行 stage（新版本目录 与配置/unit 落地）；packageless App
  仍发布受管配置与配置脚本，但配置只在目标机落地，未被服务加载。
  非激活执行视为已提交：命令完成后服务与 `latest` 保持原状，产物保留在目标机，供后续普通 `deploy`
  （`on_deploy`/文件变化）或 `restart` 动作激活复用。
- `plan` 的人可读预览为每个步骤输出序号、目标机解析地址与地址类型、依赖、包提供方、发布方式、
  脚本相对路径与运行时、声明密钥的逻辑名称以及受管服务/配置信息；缺省字段不输出空行，永不打印
  密钥值或脚本绝对路径。机器解析请使用稳定的 `--json` 契约。
- `start`/`restart`/`stop` 默认只处理 App：未显式选择环境时不生成 environment 步骤；显式传入
  `--environment`/`--env` 时才纳入对应环境节点。
- managed file config 支持 `format: nginx`：按 UTF-8 原文发布 Nginx 配置片段，不解析 Nginx DSL，
  不支持 variables 或秘密占位符；Nginx 语法由目标环境校验。
- managed config `target` 可使用 `${INSTALL_DIRECTORY}/` 表示安装根内的相对路径，
  `${CURRENT_VERSION_DIRECTORY}/` 表示当前动作的版本目录，`${LATEST_DIRECTORY}/` 表示
  `<install_directory>/latest`。deploy 重定位 current 变量和旧绝对 latest 前缀，deploy/rollback 的
  configure 步骤中 current 与 latest 都写当前版本。`${INSTALL_DIRECTORY}` 不做版本重定位。
- `${APP_VERSION}` 是当前 versioned App 部署版本的字符串占位符；managed config `target`、 service
  `unit_config.working_directory` 和 structured managed config 内容都可用它替换。 structured
  内容只支持 yaml/json/toml/ini。`nginx`、无包 App 和 Environment 配置不支持该变量。 若
  `APP_VERSION` 已声明为秘密，则内容中的占位符继续按秘密引用处理。
- versioned 部署会在已验证候选版本内创建缺失的受管配置父目录；无发布根的 configure 步骤仍要求
  父目录已存在。符号链接逃逸和越界路径始终拒绝。
- 绝对 `target` 保持既有含义，不因版本化部署自动重映射，除非精确命中 `<install_directory>/latest/`
  前缀。
