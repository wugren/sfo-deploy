# sfo-deploy

## Long-lived Boundary

- `cluster.yaml` 支持可选 `deployer_version` 精确版本门禁：声明后要求运行中的 sfo-deploy 版本完全一致，
  否则装载集群后、任何 SSH 前 fail-closed 拒绝受控动作；缺省不启用。运行时版本取自 `deno.json` 的
  `version` 字段。
- App schema 1 使用顶层 `configs` 与 `management.kind`：配置条目没有 `name`，以 `kind: script|file`
  区分；管理器是 `kind: script|service`，service 通过 `tool: auto|systemctl|service` 覆盖
  Ubuntu/CentOS。旧 App v2/v3/v4 不兼容。
- Environment schema v1 现在支持顶层 `install` 和可选 `manager`：安装是 package/script，服务管理是
  system/script；script manager 必需 start/stop/restart；`manager` 缺省表示不管理应用运行。新契约
  没有独立 `check`，与旧顶层 `scripts` 互斥；旧 scripts 行为保持不变。
- versioned App 的 `install_directory` 是发布根；`latest` 是当前/候选版本选择器。
- managed file config 支持 `format: nginx`：按 UTF-8 原文发布 Nginx 配置片段，不解析 Nginx DSL，
  不支持 variables 或秘密占位符；Nginx 语法由目标环境校验。
- managed config `target` 可使用 `${INSTALL_DIRECTORY}/` 表示安装根内的相对路径，
  `${CURRENT_VERSION_DIRECTORY}/` 表示当前动作的版本目录，`${LATEST_DIRECTORY}/` 表示
  `<install_directory>/latest`。deploy 重定位 current 变量和旧绝对 latest 前缀，独立 configure 中
  current 与 latest 都写当前版本。`${INSTALL_DIRECTORY}` 不做版本重定位。
- versioned 部署会在已验证候选版本内创建缺失的受管配置父目录；无发布根的独立 configure 仍要求
  父目录已存在。符号链接逃逸和越界路径始终拒绝。
- 绝对 `target` 保持既有含义，不因版本化部署自动重映射，除非精确命中 `<install_directory>/latest/`
  前缀。
