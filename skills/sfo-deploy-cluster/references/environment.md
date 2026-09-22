# 添加 Environment

必需输入：名称、版本、目标机器，以及环境用途。需要安装时确认目标
OS、包管理器或安装包、实际检查条件及是否提权。无需环境的 app 可以完全不声明依赖。

共享定义 `environments/<名称>/environment.yaml` 使用 schema 1，必需 `name`、字符串
`version`；生命周期在旧顶层 `scripts` 与新顶层 `install`/可选 `manager` 之间二选一。可选
`parameters`、`defaults`、`depends_on`、`requires_privilege`、`package`。顶层
`templates`、`secret_values`、`secret_files` 已移除，不声明 App `management`。

`scripts.<动作>` 是调用列表，每项包含相对于环境目录的 `.ts` 路径和 `permissions`，不是一个裸字符串：

```yaml
schema_version: 1
name: nginx
version: "1.24"
depends_on: []
requires_privilege: true
scripts:
  check:
    - path: scripts/check.ts
      permissions:
        run: [/usr/bin/test]
        net: []
        read: [/opt/example-runtime/state]
  install:
    - path: scripts/install.ts
      permissions:
        run: [/usr/bin/apt-get]
        net: []
        write: [/opt/example-runtime]
```

`assets/environment-nginx/` 是 Ubuntu/Debian apt 的具体示例：检查 `/usr/sbin/nginx`
可执行，安装发行版 nginx 包。它不固定 apt 包版本，也不验证已安装版本等于声明的版本；将 `version`
作为该安装配方的版本标签，若用户要求精确 nginx 版本，改用已确认的软件源/包版本并增加版本检查。其他
OS 需换实现，不直接套用 apt。

新环境可用声明式生命周期：

```yaml
install:
  kind: package
  manager: auto
  packages: [nginx]
  update_cache: false
manager:
  kind: system
  name: nginx
  tool: auto
  enabled: true
  start_after_install: true
  timeout_ms: 300000
```

`install.kind: package` 只支持 `apt-get`/`yum`，`auto` 按此顺序探测；`manager.kind: system` 的
`tool: auto` 按 `systemctl`/`service` 顺序探测。系统服务 `enabled` 缺省为 `true`（开机启动），显式
`false` 关闭；`start_after_install: false` 时 `prepare` 新增独立 `enable` 步骤，仍设为开机启动但不
启动服务。`manager` 可缺省，缺省时不管理应用运行。脚本方式用 `install.kind: script` 和
`manager.kind: script`，后者必须声明 `start`/`stop`/`restart`。新契约不声明 `check`；顶层 `scripts`
与 `install`/`manager` 互斥。

新生命周期还可选声明 `init` 初始配置段，用于环境应用安装/更新流程的启动前/启动后配置：

```yaml
init:
  before_start:
    - path: scripts/init-before.ts
      permissions:
        run: [/usr/bin/install]
        net: []
  after_start:
    - path: scripts/init-after.ts
      permissions:
        run: [/usr/bin/install]
        net: []
```

`init` 整体可选；`before_start`/`after_start` 各是可选脚本列表，未声明或为空时不生成对应步骤。
`prepare` 对声明顺序按 install → before_start → start/restart → after_start 执行；启动前/启动后
失败都会阻断该环境实例的 prepare 且不写版本标记。显式 start/stop/restart 不执行 init 脚本。

复制到 `environments/nginx/` 后，在 `cluster.yaml` 合并 `environments.nginx: [app-01]`。需要它的 app
再添加 `depends_on: [nginx]`。给现有环境增加机器时复用定义，不复制每机目录。

## 脚本规则

- 每个脚本自包含；框架不会上传任意兄弟模块，不导入过去的 `sfo_deploy.ts` 辅助文件。秘密 loader
  是特殊框架资源，见 secrets 参考。
- run 权限列出实际子进程的规范绝对路径；net 列出实际 Deno 网络目标，不能写 URL 或通配符。read/write
  分别列出 Deno 直接读/写 API 的规范绝对扩展路径；workspace 始终授权，只读路径
  不能删除或写入。子进程自身网络行为不由 Deno net 列表限制。
- check 使用真实状态判断，成功返回 0，不满足返回非零。install/configure
  实现实际需求并可重复执行，不生成始终成功的空实现。
- 通过 `Deno.Command` 的固定 argv 传参；参数需要从框架上下文读取时，使用 `DEPLOYMENT_METADATA_PATH`
  指向的 JSON 文件并核对目标实现的上下文结构，不能猜测业务参数环境变量。
- `requires_privilege: true` 只在环境脚本确需提权时设置。App 脚本以 SSH
  身份执行，与环境提权是不同机制。

当前 `prepare` 负责环境 check/install/可选 configure、新生命周期的 install/manager/init； `deploy`
和 `plan` 不执行环境步骤。创建配置时不自动运行 prepare。
