# 使用 sfo-deploy 配置集群

本文说明如何从零创建一个 sfo-deploy 集群目录，校验配置并完成首次部署。示例使用单机 `production`
集群和一个 `backend` App；其中域名、IP、下载地址、哈希和路径都是占位值，部署前必须替换。控制端需要
Deno 2、OpenSSH 的 `ssh`/`scp`，并应先按根目录 README 从本地入口或固定 tag URL 安装
`sfo-deploy`；使用 filehub 包来源时还需要已配置的 `filehub` 客户端。

## 1. 先理解配置模型

sfo-deploy 把一个集群保存为自包含目录：

```text
clusters/production/
├── cluster.yaml
├── machines.yaml
├── environments/
│   └── runtime/
│       ├── environment.yaml
│       └── scripts/
│           ├── check.ts
│           ├── install.ts
│           └── configure.ts   # 可选
└── apps/
    └── backend/
        ├── app.yaml
        ├── scripts/
        │   └── deploy.ts
        └── templates/
            └── application.ini.tpl
```

四个核心概念是：

- `cluster.yaml` 定义集群名称、执行器所在区域，以及 Environment 和 App 分别放置在哪些机器上。
- `machines.yaml` 定义 SSH 目标和地址，不在这里声明环境。
- `environments/<环境>/environment.yaml` 集中定义一个 Environment 的安装、配置和生命周期脚本。
- `apps/<App>/app.yaml` 定义一个可部署 App、包来源、环境依赖和生命周期脚本。

所有 YAML 都采用严格装载：当前 `cluster.yaml` 使用 schema v2，`machines.yaml` 和 `environment.yaml`
使用 schema v1；新 App 推荐 schema v3，以显式选择内置配置/systemd 管理，旧 App 继续执行 schema v2
原脚本。`cluster.yaml` schema v1 与 App/YAML schema v1 内联版本已移除，配置必须先迁移到 v2/v3。
重复键、未知字段、缺少必填字段或不合法路径都会在建立 SSH 连接前失败。

## 2. 创建集群目录

从仓库或项目工作目录创建配置根：

```bash
mkdir -p clusters/production/environments/runtime/scripts
mkdir -p clusters/production/apps/backend/scripts
mkdir -p clusters/production/apps/backend/templates
```

通用 `sfo-deploy` 命令会按以下顺序查找集群：

1. 当前目录下的 `./<集群名>`；
2. 当前目录下的 `./clusters/<集群名>`。

也可以通过 `--config-root` 明确指定包含多个集群目录的根目录。

## 3. 配置 cluster.yaml

创建 `clusters/production/cluster.yaml`：

```yaml
schema_version: 2
name: production
executor_region: cn-east
environments:
  runtime: [app-01]
apps:
  backend: [app-01]
```

字段说明：

| 字段              | 说明                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `schema_version`  | 只支持 `2`；旧 v1 每机环境布局已移除。                                        |
| `name`            | 集群逻辑名称。建议与目录名一致；CLI 仍以目录名选择集群。                      |
| `executor_region` | 发起部署命令的默认区域，用于自动选择内网或公网地址。                          |
| `environments`    | Environment 到目标机器列表的完整映射。只在 schema v2 中存在。                 |
| `apps`            | App 到目标机器列表的完整映射。`apps/` 下每个 App 都必须出现，不能多也不能少。 |

每个 Environment 和 App 都至少要放置到一台机器，目标列表不能重复，引用的机器必须存在于
`machines.yaml`。`environments/` 和 `apps/`
下的定义集合必须分别与两个映射完整一致；缺失、多余、空列表、
重复目标和未知机器都会被拒绝。`environments: {}` 只在没有 Environment 定义时有效。

### 从 cluster schema v1 迁移（不支持降级）

schema v1 的 `environments/<机器名>/<环境名>/` 每机布局已移除：`cluster.yaml` 只接受
`schema_version: 2`，v1 配置会直接报错，不再扫描或回退到 v1 布局。框架不会自动移动或改写用户配置。

手工迁移时，先确认不同机器上的同名 Environment 定义及其 `scripts/`、`templates/`
等资源确实相同，再把它们 合并为一个 `environments/<环境名>/` 目录；将 `cluster.yaml.schema_version`
改为 `2`，并在 `environments` 映射中列出原来的全部机器。若配置或参数不同，必须拆成不同 Environment
名称，因为 v2 不提供逐机器 overrides。最后运行 `validate` 和 `plan` 核对每个派生实例和依赖。

v2 只读版本不再提供 v1 兼容读取，无法回退运行旧每机布局；需保留旧配置时应维护迁移前的 v1 目录备份，
或完整迁移到 v2 目录。已归档发布计划独立于当前目录布局，当前配置迁移 不会改写历史快照。

## 4. 配置 machines.yaml

创建 `clusters/production/machines.yaml`：

```yaml
schema_version: 1
machines:
  - name: app-01
    domains: [app-01.example.com]
    private_ip: [10.0.0.10, 10.0.0.11]
    public_ip: [203.0.113.10, 203.0.113.11]
    region: cn-east
    ssh_user: deploy
    ssh_port: 22
    ssh_private_key: secrets/id_ed25519
    deno: /usr/local/bin/deno
```

主要字段：

| 字段              | 必填 | 说明                                                                     |
| ----------------- | ---: | ------------------------------------------------------------------------ |
| `name`            |   是 | 机器名称，供 `cluster.yaml` 放置映射和 CLI 筛选器引用。                  |
| `region`          |   是 | 机器所在区域。                                                           |
| `ssh_user`        |   是 | SSH 登录用户。                                                           |
| `private_ip`      |   否 | 单个内网 IP 或按优先级排列的非空 IP 列表；同区连接默认选择这一类。       |
| `public_ip`       |   否 | 单个公网 IP 或按优先级排列的非空 IP 列表；跨区连接默认选择这一类。       |
| `domains`         |   否 | 与机器关联的描述性域名列表；当前不参与 SSH 地址选择。                    |
| `ssh_port`        |   否 | 默认 `22`，有效范围为 `1` 到 `65535`。                                   |
| `ssh_private_key` |   否 | 相对于集群目录的私钥文件路径。                                           |
| `deno`            |   否 | 远端 Deno 2 命令，默认 `deno`；可填写单个裸命令名或规范绝对 POSIX 路径。 |

如果机器 `region` 与 `executor_region` 相同，计划默认使用 `private_ip`；否则使用 `public_ip`。可以用
`--executor-region` 或 `--address-kind private|public` 覆盖选择。字段仍兼容原有单个 IP
字符串；使用列表时，SSH 会在选定类别内按声明顺序串行尝试，首次成功后停止。不会从 private 自动切到
public（反之亦然）；所选类别不存在地址时，规划会失败。空列表、重复地址或非法 IP
会在配置加载阶段被拒绝。

`ssh_private_key`
必须指向本地可读普通文件。不要把真实私钥提交到版本库；应把对应路径加入项目忽略规则，并通过安全渠道放置文件。省略该字段时使用
SSH agent，不会自动搜索 `~/.ssh` 中的私钥文件。

SSH 主机密钥采用严格校验：目标必须已存在于系统 known-hosts 或传输层显式配置的 known-hosts
文件中，未知主机密钥会被拒绝。首次部署前应通过可信渠道核对并登记目标指纹。

目标机必须预装 Deno，且主版本不低于
2。框架在执行新集群的第一个生命周期脚本前预检版本；命令缺失、输出异常或版本过低都会失败关闭。新集群不再以远端
Python 作为运行时依赖；历史发布中已有的 Python v1 快照仍可按原权限模型回退，且不会被静默转换成
Deno。

如果需要让框架自己完成运行时引导，可以在目标机可 SSH 直连、主机指纹已登记后使用
`install-deno`：它复用与部署相同的 OpenSSH 传输，通过纯 SSH（ssh/scp）在远端安装固定版本的 Deno
2，不要求目标机预装 Deno，也不使用 multipass/ansible 等外部工具：

```bash
# 全部机器（交互确认）或显式选中的机器（可跳过确认，非交互仍建议 --yes）
sfo-deploy install-deno --cluster production
sfo-deploy install-deno --cluster production --machine app-01 --yes

# 固定版本并安装到非默认目录
sfo-deploy install-deno --cluster production --deno-version 2.2.11 --install-to /usr/local
```

缺省安装到远端 `/usr/local/bin/deno`；`/usr/local` 是非当前用户可写目录，因此缺省 安装要求远端身份为
root 或可 `sudo -n`。安装后框架会用 `deno --version` 复验固定小版本，
已满足版本的目标自动跳过（`present`）。

目标机通常需要 `curl` 或 `wget`，以及 `unzip` 或 `7z`；缺少时 `install-deno` 会尝试用
目标机包管理器（支持顺序 apt-get → apk → dnf → yum）以提权身份安装缺失的 curl 与 unzip，然后继续
Deno 安装。自动补齐需要的提权与 `--install-to` 非默认目录相同： 远端身份必须为 root 或可
`sudo -n`。包管理器不可用、提权失败或安装后仍有缺失时，命令 fail-closed：提权问题按预检失败（退出码
3），执行问题按远端执行失败（退出码 4）。 基础工具来自目标机发行版软件源（`apt-get update`
会刷新远端索引），信任边界是 “发行版仓库 + deno.land
固定版本”；需要更严格供应链控制的环境应手工预装或在部署前 审批软件源变更。
该动作不写发布历史，也不修改 `machines.yaml`；未写 `deno` 字段时，后续动作默认使用裸 命令
`deno`。缺省安装到 `/usr/local/bin/deno` 后即可在默认 PATH 中找到；若显式 `--install-to $HOME/.deno`
或手工安装到非 PATH 目录，则需要把安装目录加入 PATH，或在 `machines[].deno` 中写实际路径。

## 5. 配置 Environment

schema v2 的 Environment 必须放在 `environments/<环境名>/` 中，目录名必须与 `environment.yaml` 的
`name` 一致；目标机器只由 `cluster.yaml.environments` 决定。

创建 `clusters/production/environments/runtime/environment.yaml`：

```yaml
schema_version: 1
name: runtime
version: "1.0"
parameters:
  install_root: /opt/example-runtime
depends_on: []
defaults:
  service_user: deploy
requires_privilege: true
scripts:
  check:
    - path: scripts/check.ts
      permissions:
        run: [/usr/bin/test]
        net: []
  install:
    - path: scripts/install.ts
      permissions:
        run: [/usr/bin/install]
        net: []
  configure:
    - path: scripts/configure.ts
      permissions:
        run: [/usr/bin/install]
        net: []
```

环境字段：

| 字段                 |   必填 | 说明                                                                                            |
| -------------------- | -----: | ----------------------------------------------------------------------------------------------- |
| `name`               |     是 | 必须与环境目录名一致。                                                                          |
| `version`            |     是 | 环境版本；脚本可从 `metadata.parameters.version` 读取。                                         |
| `scripts`            | 二选一 | 旧生命周期入口；动作到有序 TypeScript 脚本对象列表的映射，不能与 `install`/`manager` 同时声明。 |
| `install`            | 二选一 | 新生命周期入口，声明系统包安装或安装脚本；新契约必须声明，不能与 `scripts` 同时声明。           |
| `manager`            |     否 | 新生命周期的可选服务管理声明；缺省表示只安装依赖，不管理运行中的应用。                          |
| `parameters`         |     否 | Environment 参数，会覆盖 `defaults` 中的同名值，并用于该定义的全部目标机器。                    |
| `defaults`           |     否 | 环境默认参数。                                                                                  |
| `depends_on`         |     否 | 环境依赖；`runtime` 表示同机环境，`app-02/runtime` 表示指定机器环境。                           |
| `requires_privilege` |     否 | 默认为 `false`；为 `true` 时，环境脚本通过远端提权接口执行。                                    |
| `package`            |     否 | 环境安装需要的下载包；只在环境 `install` 步骤下载。                                             |

最终脚本参数按 `defaults`、`parameters` 的顺序合并；框架随后写入保留字段 `version` 和
`requires_privilege`，普通参数不能覆盖这两个字段。

一个共享定义的 version、parameters、defaults、依赖、权限、脚本、模板和包来源对所有放置机器
完全相同，没有逐机器覆盖或合并层。机器之间需要不同值时，应使用不同 Environment
名称和定义，并分别放置。

### 新生命周期：install/manager

新环境建议使用顶层 `install` 和可选 `manager`，而不是写 `check`/`install`/`start` 脚本。系统包
安装与服务控制在 Ubuntu/Debian 和 CentOS 7 上使用同一份 YAML：

```yaml
schema_version: 1
name: nginx
version: "1.24"
requires_privilege: true
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

`install.kind: package` 会让框架查询目标机包状态，只在缺少包时执行固定安装命令。
`install.manager: auto` 按 `apt-get`、`yum` 顺序探测；显式指定 `apt-get` 或 `yum` 时不会自动
降级。`update_cache: true` 只在实际需要安装时刷新软件源索引。

不需要框架启动应用时，`manager` 可缺省；此时只执行安装。需要应用运行管理时声明 `manager`。
`manager.kind: system` 的 `tool: auto` 按 `systemctl`、`service` 顺序探测，Ubuntu/Debian 通常命中
systemctl，CentOS 7 通常命中 service；显式指定工具时缺失即失败。`enabled` 控制目标状态。

特殊安装协议和启动协议可以使用脚本方式：

```yaml
schema_version: 1
name: runtime
version: "1.0"
requires_privilege: true
install:
  kind: script
  path: scripts/install.ts
  permissions:
    run: [/usr/bin/install]
    net: []
manager:
  kind: script
  start:
    path: scripts/start.ts
    permissions:
      run: [/usr/bin/systemctl]
      net: []
  restart:
    path: scripts/restart.ts
    permissions:
      run: [/usr/bin/systemctl]
      net: []
  stop:
    path: scripts/stop.ts
    permissions:
      run: [/usr/bin/systemctl]
      net: []
```

新契约不声明 `check`。`package` 安装的幂等性由包状态查询保证；`script` 安装必须自身可重复执行。
`manager.kind: script` 必须同时声明 `start`、`stop` 和 `restart`，脚本负责幂等处理。

### 环境脚本

生命周期脚本必须是环境目录内已存在的 `.ts`
文件。一个动作可以按列表顺序运行多个脚本。每个脚本都是自包含程序，除框架运行时上传的受限 loader
外不导入 sfo-deploy 源码；纯动作脚本不需要读取 context，需要步骤输入的脚本按第 7
节在本文件内解析普通 JSON。

`permissions.run` 的每一项必须是规范绝对 POSIX
可执行路径；空列表表示脚本不能直接启动子进程。`permissions.net` 默认空，只接受无
scheme、凭据、路径或通配符的主机/IP，可附带端口，例如 `127.0.0.1:8080`。不要为使用 `apt-get`
等子进程访问软件源而授予 Deno `net`：网络是该子进程自己的能力，不是 Deno 直接 API 的能力。

下面的脚本只是展示动作契约，生产环境应换成幂等且能正确处理失败的实现。

`scripts/check.ts`：退出码 `0` 表示环境已满足，非零表示未满足。

```typescript
const result = await new Deno.Command("/usr/bin/test", {
  args: ["-f", "/opt/example-runtime/.installed"],
}).output();
Deno.exit(result.success ? 0 : 1);
```

`scripts/install.ts`：

```typescript
await new Deno.Command("/usr/bin/install", {
  args: ["-d", "-m", "0755", "/opt/example-runtime"],
}).output();
await Deno.writeTextFile("installed.marker", "installed\n");
await new Deno.Command("/usr/bin/install", {
  args: ["-m", "0644", "installed.marker", "/opt/example-runtime/.installed"],
}).output();
```

`scripts/configure.ts`：

```typescript
const context = await readContext(); // 把第 7 节的函数直接定义在本文件中
const parameters = mapping(context.metadata.parameters, "metadata.parameters");
if (typeof parameters.version !== "string" || typeof parameters.install_root !== "string") {
  throw new Error("runtime parameters are invalid");
}
await Deno.writeTextFile("runtime.conf", `version=${parameters.version}\n`);
const result = await new Deno.Command("/usr/bin/install", {
  args: ["-m", "0644", "runtime.conf", `${parameters.install_root}/runtime.conf`],
}).output();
if (!result.success) throw new Error("runtime configuration install failed");
```

直接请求环境 `check`、`install`、`configure`、`start`、`stop` 或 `restart`
时，都要求配置中存在对应脚本，否则规划失败。一次包含环境的 `configure` 会规划环境安装；如果声明了
`check`，返回 `0` 时对应安装步骤会跳过，返回非零时才安装；未声明 `check` 时会直接安装。`install`
脚本必须存在；`configure` 是可选动作，省略时计划不生成该步骤。

单独执行 `install` 会直接运行安装脚本，不先执行 `check`。因此安装脚本本身仍应设计为幂等。

`requires_privilege: true` 会让该环境的所有动作要求远端身份为 root，或能够执行非交互
`sudo -n`；需要交互输入 sudo 密码的目标会在预检阶段失败。

### 环境应用部署与更新（prepare）

jre、nginx、mysql、redis 这类由环境承载的应用（环境应用）使用专门命令部署/更新：

```bash
sfo-deploy prepare --config-root ./clusters --cluster production --env mysql
sfo-deploy prepare --config-root ./clusters --cluster production --env jre --machine app-01
```

`--env` 与 `--environment` 等价（更短），可重复，并接受 `[机器/]名称` 精确实例。`prepare`
是环境动作，不支持 `--app`。单个环境应用的执行序列：

旧 `scripts` 环境的序列是：`check` 检查是否已满足；已满足且版本标记一致时整体跳过（不重启）；
未满足时按需执行 `install`；声明 `configure` 时执行；首次安装成功后自动执行 `start`，版本更新
成功后自动执行 `restart`；未声明 `start`/`restart` 脚本的环境应用跳过对应步骤并提示，不报错。

新 `install`/`manager` 环境没有 `check`：总是执行幂等 `install`；声明 `manager` 且
`start_after_install: true`（或脚本 manager）时，首次安装成功后自动执行 `start`，版本更新成功后
自动执行 `restart`。缺省 `manager` 不会产生服务动作。

框架把 `environment.yaml` 的 `version` 记录到目标机 `~/.sfo-deploy/environments/<环境名>.version`
作为更新标记；任何步骤失败、阻断或取消都不会更新 标记，下一轮 `prepare`
仍按旧版本处理。环境应用的安装/配置默认不进入 `.sfo-deploy/releases/` 发布快照与 `rollback` 回放。

## 6. 配置 App

App 目录名必须与 `app.yaml` 的 `name` 一致。带制品 App 每次发版都会变化的安装版本、下载配置
（provider/source）与版本 hash 统一放在集群根 `app_versions.yaml`，且包始终需要可信哈希。 纯配置型
App 用 `packageless: true` 显式声明，不需要版本/包，也不出现在 `app_versions.yaml`。App 只使用
`app.yaml schema_version: 1`；旧 v2/v3/v4 装载会直接失败，必须使用 `app_versions.yaml`
提供版本记录。

创建 `clusters/production/app_versions.yaml`：

```yaml
schema_version: 1
apps:
  backend:
    version: "1.0.0"
    package:
      provider: https
      source:
        url: https://downloads.example.invalid/backend-1.0.0.tar.gz
      hash:
        algorithm: sha256
        value: 0000000000000000000000000000000000000000000000000000000000000000
```

创建 `clusters/production/apps/backend/app.yaml`：

```yaml
schema_version: 1
name: backend
install_directory: /home/deploy/apps/backend
depends_on: [runtime]
deployment:
  kind: versioned
configs:
  - kind: file
    source: templates/application.ini.tpl
    target: /home/deploy/apps/backend/application.ini
    owner: deploy
    group: deploy
    mode: "0600"
    variables:
      - name: APP_VERSION
        path: [version]
        type: string
    format: ini
    on_change: restart
management:
  run_as: deploy
  kind: service
  name: backend.service
  tool: auto
  enabled: true
  daemon_reload: true
  on_deploy: restart
  timeout_ms: 30000
```

部署前必须把 URL 和 64 位 SHA-256 示例值替换为真实、可信的值。App 字段如下：

| 字段                | 必填 | 说明                                                    |
| ------------------- | ---: | ------------------------------------------------------- |
| `name`              |   是 | 必须与 App 目录名一致。                                 |
| `install_directory` |   是 | 远端绝对 POSIX 路径，版本目录与 `latest` 软链位于其下。 |
| `configs`           |   否 | App 配置段列表；每个条目用 `kind: script                |
| `depends_on`        |   否 | App 在每台放置机器上的环境依赖。                        |
| `management`        |   否 | 管理器声明；`kind: script                               |

### App schema 1 配置与服务

配置在顶层 `configs`，管理器由 `management.kind` 直接声明。配置条目不声明 `name`，以 `kind`
表达类型； 受管文件按远端目标路径唯一，配置脚本按 App 内相对脚本路径唯一。

```yaml
schema_version: 1
name: backend
install_directory: /home/deploy/apps/backend
deployment:
  kind: versioned
management:
  run_as: deploy
  kind: service
  name: backend.service
  tool: auto
  enabled: true
  daemon_reload: true
  on_deploy: restart
  unit_config:
    working_directory: latest
    command: bin/server
    args: ["--config", "config/application.ini"]
```

`kind: file` 支持 YAML、JSON、TOML、INI 和 Nginx 原生纯文本；`kind: script` 是 App 内 TypeScript
配置脚本，具备 `path` 和 `permissions`，并会在 `configure` 生命周期执行。`format: nginx` 按 UTF-8
原文发布，不解析 Nginx DSL，也不支持 variables 或秘密占位符。`kind: file` 的
`on_change: reload|restart` 需要 `management.kind: service`。脚本配置和服务脚本必须幂等；非零退出会
失败当前步骤。

`management.kind: service` 使用 `name` 指定服务，`tool: auto|systemctl|service`
选择发行版工具。`auto` 探测 `systemctl`，没有 systemd 时探测 `service`，可覆盖 Ubuntu/CentOS 常见
systemd 和旧 SysV 场景。 显式 `systemctl`/`service` 不自动回退。`unit_config` 可选：缺省时只控制已有
unit；声明时生成并 发布 root/root/0644 的 systemd unit，必须使用 `daemon_reload: true`，且不能与
`tool: service` 同时 声明。`working_directory` 相对 `install_directory` 解析，也支持与 config
target 相同的三个目录变量：`${INSTALL_DIRECTORY}` 解析为安装根，`${LATEST_DIRECTORY}` 与
`${CURRENT_VERSION_DIRECTORY}` 在装载期都解析为 `latest` 软链路径（unit 是静态文件，不随候选版本
重定位，`latest` 在 activate 切换后经软链指向当前版本目录）；变量必须在开头且只出现一次，可用
`变量/相对后缀`，使用变量时 App 必须声明 `install_directory`。命令相对 working directory 解析为
`ExecStart` 绝对路径。unit target 缺省为
`/etc/systemd/system/<name>`，文件名必须一致。

`management.kind: script` 必须声明 `start`、`stop` 和 `restart` 三个脚本；versioned 内置 deploy 会在
activate 后执行一次 `restart`。`tool: service` 不提供 daemon-reload 或 enable 状态语义，因此禁止
`unit_config`，也必须省略 `enabled`。

动作所有权仍然是唯一：App 顶层没有 `scripts` 节点。脚本配置只能放在 `configs.kind: script`；
服务动作只能放在 `management.kind: script` 或 `management.kind: service`。App schema 1 不提供 hook。

`deployment.kind` 首版只支持 `versioned`，是带包 App 的内置发布声明；非 packageless App 会自动启用。
它要求 `management.run_as`，禁止 packageless。内置 deploy 拆成 `stage` 与 `activate`：stage 建立
`<install_directory>/<version>/`、写入 `VERSION`， 并发布配置/unit、完成 systemd 的 daemon-reload 和
enable 准备；所有目标准备成功后，activate 逐目标原子切换
`<install_directory>/latest`，紧接着执行一次 start（服务未运行）或 restart（服务运行中）。
切换与服务命令之间不插入标记、配置、清理或其他应用操作。成功后写入 `.<app>.version` 并按
`keep_versions` 清理旧版本。无服务应用只提交版本。特殊安装/数据迁移仍应保留自定义 `scripts.deploy`。

版本内 managed config 的 target 使用 `<install_directory>/latest/` 前缀时，内置 deploy 会将其
解析到待发布版本目录，例如 `latest/resources/application.yml` 发布到
`<version>/resources/application.yml`。
框架会先校验发布根，再在候选版本内逐级创建缺失的目标父目录，并复核真实路径必须位于该版本目录内；
中间目录必须是普通目录，符号链接逃逸会在切换前拒绝。 其他绝对 target 保持原有位置，显式 configure
不进行版本重定位或切换。推荐 target 使用
`'${CURRENT_VERSION_DIRECTORY}/resources/application.yml'`；可用目录变量分别是
`${INSTALL_DIRECTORY}`（`install_directory` 安装根）、`${CURRENT_VERSION_DIRECTORY}`（当前动作的
版本目录，deploy 为候选版本，configure 为当前版本）和 `${LATEST_DIRECTORY}`（latest 软链）。
变量必须位于开头，后面的路径不含 `..`，且 App 必须声明 `install_directory`。旧 `latest/`
绝对路径写法继续兼容。旧 `${INSTALL_DIRECTORY}` 版本内写法是 breaking 变更，必须迁移到
`${CURRENT_VERSION_DIRECTORY}`。

旧三阶段 stage/activate/restart 历史计划在执行准备时归一到新的事务，保留步骤标识并跳过多余的
restart。 更早的单步 versioned deploy 历史计划在连接节点前拒绝执行，需用当前配置重新生成
stage/activate 计划； 自定义 deploy
脚本不受此限制。补偿失败时保留恢复所需的工作目录和备份，并在结果中报告，供后续修复。

`packageless: true` App 是显式的配置型 App：不需要版本/包，也不出现在 `app_versions.yaml`
条目中；`fetch` 会跳过它，`deploy` 请求展开为受管 `configure`。它不提供独立 `check`，配置只能由 顶层
`configs` 拥有，不能声明 `deploy` 或 `deployment`。 packageless App 可显式声明
`install_directory`。当前 Multipass 示例没有独立 nginx App；jx-web 的 versioned stage直接发布
Nginx server 片段，并在配置变化后 reload `nginx.service`。

### 配置占位符与安全边界

所有 managed App 都必须声明规范的非 root Linux 用户 `management.run_as`。SSH 连接本身为 root 时，
框架用固定 argv 执行 `getent passwd` 和 `id`，确认目标账号存在且 UID 大于 0，并从 `getent` 严格取得
规范绝对 HOME，再以等价于
`sudo -n -H -u <run_as> -- env HOME=<verified-home> DEPLOYMENT_*=... <command>` 的固定 argv 启动
渲染器/hook 和 App 生命周期脚本。环境变量只在降权后注入，绝不继承 root HOME；非 root SSH 用户必须 与
`run_as` 一致，也会显式使用该已验证 HOME。身份校验、UID/HOME 校验或 sudo 降权失败都会在 App
代码运行前失败关闭，绝不回退到 root。systemd 和最终配置发布是框架固定的特权原语，不随 App 脚本降权。

每个 `configs` 的 `kind: file` 条目必须声明 App 目录内的 `source`、规范远端绝对 `target`、
`format`，不声明 `name`；`owner`/`group` 可选，`mode` 默认为 `"0600"`，且必须允许 owner
读取、不能包含执行位或 group/other 写权限。`on_change` 可取 `none`、`reload`、`restart`。可选
validator 使用固定 argv，`{candidate}` 必须且只能作为一个独立参数：

```yaml
validator:
  argv: [/usr/local/bin/backend, check-config, "{candidate}"]
  timeout_ms: 10000
```

控制端会解析 YAML/JSON/TOML/INI 源文件并生成规范化、无秘密配置骨架；`format: nginx` 只验证 UTF-8、
框架保留标记和 `${...}` 占位符后保留原文。目标端所需 parser 会编译成
单文件载荷随外层 bundle 固定交付，以 `--no-remote --no-npm` 离线执行；结构化配置秘密注入后必须按
声明格式完整复解析成功才能发布，不会降级为 marker 检查。普通参数占位符使用
`__SFO_CONFIG_VAR_V1_<NAME>__`，必须独占一个完整值，并由 `variables[].path` 从步骤参数读取。带包 App
常用 `[version]`；packageless App 的参数为空，不能凭空引用自定义参数。秘密占位符直接写在源配置值中，
不能自行写 `__SFO_SECRET_...` 保留 marker。

秘密引用直接写在配置值中：

```yaml
database:
  password: ${DB_PASSWORD}
api:
  retry_limit: ${API_RETRY_LIMIT}
tls:
  key: ${TLS_CERTIFICATE}
```

`cluster.yaml.secrets` 是类型与放置授权的唯一声明点。`kind: value` 的 `type` 可选并缺省
`string`；可声明 `integer`、`number` 或 `boolean`。整值占位符按声明类型注入；嵌入字符串里的
占位符只做字符串替换。`kind: file` 固定注入 `secrets-deploy` 部署后的稳定文件路径，不能声明
`type`。占位符名称必须匹配 `[A-Z][A-Z0-9_]*`；未声明、未放置、类型不匹配、非法语法、非法 UTF-8、
危险目标或残留框架 marker 都会失败关闭。

已移除的 `updater.type: script/template` 不再是新契约；含 `updater` 的配置装载时定向拒收。
除 `format: nginx` 外，其他自定义文本格式请迁移到受支持结构化格式，或保持 legacy 脚本模式。

### systemd 与动作所有权

`management.kind: service` 只接受合法服务名和 `tool: auto|systemctl|service`。`enabled`
缺省表示保持节点当前状态，但 `tool: service` 时必须省略；`daemon_reload` 只适用于 `systemctl`。
`on_deploy` 可取 `none`、`start`、`reload`、`restart`。框架经 root/`sudo -n` 探测并收敛状态。 显式
CLI `start`/`stop`/`restart` 映射到对应服务动作。

同一个 App 不能让两个实现拥有同一动作：App 顶层 `scripts` 已移除。服务动作只由 `management.kind`
拥有。一次操作有多个配置变化时，框架最多通知 systemd 一次，`restart` 优先于 `reload`；所有配置
unchanged 时不因 `on_change` 触发服务动作。

`app_versions.yaml` 与 app 目录必须完整闭合：缺失/多余 App 条目、未知字段、非法 version 或 hash
都会在 SSH 前失败。`app_versions.yaml` 的 `version` 经装载合并到 App 定义后作为唯一版本来源传给
部署脚本或内置 versioned release。

创建模板 `clusters/production/apps/backend/templates/application.ini.tpl`：

```ini
[application]
version = __SFO_CONFIG_VAR_V1_APP_VERSION__
listen = 0.0.0.0:8080
data_dir = /home/deploy/apps/backend/data
[database]
password = replace-on-target
```

只有特殊安装协议才需要创建 `scripts/deploy.ts`。普通带包 App 使用内置发布；自定义脚本仍然消费：

```typescript
const context = await readContext(); // 把第 7 节的函数直接定义在本文件中
const packageRoot = context.metadata.package_path;
if (typeof packageRoot !== "string") throw new Error("package was not supplied");
if (context.metadata.package_kind !== "validated-directory") {
  throw new Error("managed deploy requires a framework-validated package directory");
}
// packageRoot 是框架在完整验证内层 tar 后生成的隔离解压目录；从中构建版本布局，与集群脚本、渲染配置、
// 版本元数据重新打包为真实安装包，发布到 ~/.sfo-deploy/apps/<version>/ 版本目录并切换 latest。
```

App 可执行包必须是 tar.gz：fetch 与部署准备阶段框架都会校验 gzip 魔数，非 gzip 包在 SSH 前失败。
managed App 在目标机执行脚本前，由框架列举内层 tar，拒绝绝对/非规范路径、链接、设备等非
regular/directory 类型、重复成员、成员数或总展开大小超限，再解压到 attempt 隔离目录。legacy
非-managed App 仍收到原始 tar.gz，并继续自行做哈希和归档安全检查。版本目录
`<install_directory>/<version>/` 自包含解压后内容、该版本渲染配置、集群脚本与版本元数据，
`<install_directory>/latest` 软链指向最新版本，systemd 从 `latest` 启动，健康检查失败时重建 `latest`
到上一版本。

legacy App 脚本默认以 SSH 用户权限执行；managed App 脚本固定以 `run_as` 执行。App 没有环境的
`requires_privilege` 开关。需要写系统目录时，应在机器初始化阶段建立明确的用户、目录和权限边界，
不要在 App 脚本中假定拥有 root 权限。持久路径写入应通过经过审查且在 `permissions.run`
中声明的子进程完成，Deno 自身的文件 API 不应直接访问步骤工作区之外。

## 7. 秘密装载与步骤元数据

旧生命周期脚本不会获得完整 sfo-deploy 源码。框架在开启秘密交付的脚本步骤（哪些步骤开启见第 9
节）把本机 `cluster.yaml.secrets` 已声明放置秘密的受限副本放进 0700 workspace 的 `secrets/`
子目录，并只注入 `DEPLOYMENT_SECRETS_DIR`；秘密副本目录的内容是机器范围集合（本机全部已声明
秘密，值与文件分集），不是某个 App 或脚本单独声明的子集。同一目录里还有上传好的
`sfo-secret-loader.ts`（Python 历史快照为 `sfo_secret_loader.py`）。loader 文件只存在于上传后的远端
workspace，集群目录不得定义或复制它。脚本用与自身同目录的相对导入取得 loader，再按名读取密钥；
`loadSecrets` 的 `values`/`files` 参数只是读取过滤器，名称必须真实存在于副本目录中，不构成新的
声明面。秘密副本目录不存在的步骤不得读取 `DEPLOYMENT_SECRETS_DIR`。
非秘密步骤元数据（模板远端路径、包路径、安装目录、参数、动作等）由 `DEPLOYMENT_METADATA_PATH` 指向的
mode `0600` JSON 提供。App schema 1 的受管配置不走这套模板渲染逻辑，而是把版本固定的
`sfo-config-updater.ts` 放入单部署包，由框架以更窄权限直接调用。例如旧脚本模式：

```typescript
// sfo-secret-loader.ts 由 sfo-deploy 在脚本步骤上传到同一 workspace。
import { loadSecrets } from "./sfo-secret-loader.ts";

type JsonObject = Record<string, unknown>;

function mapping(value: unknown, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

async function readMetadata(): Promise<JsonObject> {
  const path = Deno.env.get("DEPLOYMENT_METADATA_PATH");
  if (!path) throw new Error("DEPLOYMENT_METADATA_PATH is not set");
  return mapping(JSON.parse(await Deno.readTextFile(path)), "step metadata");
}

const secretsDir = Deno.env.get("DEPLOYMENT_SECRETS_DIR");
if (!secretsDir) throw new Error("DEPLOYMENT_SECRETS_DIR is not set");
const secrets = await loadSecrets({
  dir: secretsDir,
  values: ["DB_PASSWORD"],
  files: ["TLS_SERVER_KEY"],
});

function render(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(
    /\$\$|\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g,
    (token, braced, plain) => {
      if (token === "$$") return "$";
      const value = values[braced ?? plain];
      if (typeof value !== "string") throw new Error("template secret was not supplied");
      return value;
    },
  );
}

const metadata = await readMetadata();
const templates = mapping(metadata.templates, "step metadata templates");
```

这是协议示例，不是新的共享 SDK；每个生命周期脚本应内置适合自身输入的解析逻辑，并继续严格校验实际
消费的 metadata 字段类型。值密钥由 `loadSecrets().values` 返回非空字符串；文件密钥由
`loadSecrets().files` 返回副本内的受限绝对路径，脚本按需以只读方式打开。纯动作脚本无需复制这段代码。

`DEPLOYMENT_METADATA_PATH` 指向的 JSON 只含普通数据，不含任何秘密。常用字段包括：

| 字段           | 出现条件                          | 内容                                                                      |
| -------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `machine`      | 所有步骤                          | 当前机器名。                                                              |
| `kind`         | 所有步骤                          | `environment` 或 `app`。                                                  |
| `resource`     | 所有步骤                          | 当前环境或 App 名称。                                                     |
| `action`       | 所有步骤                          | 当前生命周期动作。                                                        |
| `parameters`   | 所有步骤                          | 环境合并参数，或 App 的 `version`。                                       |
| `package_path` | 环境 `install`、带包 App `deploy` | managed App 为框架安全验证后的隔离解压目录；legacy App/环境为临时包路径。 |
| `package_kind` | 带包 managed App `deploy`         | 固定为 `validated-directory`；用于与 legacy tar.gz 元数据区分。           |
| `templates`    | 仅 legacy/回滚步骤                | 顶层 `templates` 字段已移除；该映射恒为空，仅为兼容旧发布快照执行保留。   |

每个脚本步骤都有独立的远端资源工作区；声明的脚本、步骤元数据、秘密副本、模板和包只在该步骤中可见，步骤成功或失败后都会清理。
工作区中没有 `sfo_deploy.ts`；除受限 loader 外，也没有其它框架源码。Deno
固定只获准直接读写这个工作区，默认拒绝网络和
FFI；脚本必须通过已声明的子进程把需要保留的包、配置或数据复制到持久目录。

该权限边界只限制 Deno 直接 API。`permissions.run` 允许的原生子进程以目标机运行身份执行，不继承 Deno
的文件或网络限制；因此它不是针对恶意脚本的 OS 级沙箱，不能替代容器、namespace、seccomp
或独立低权限账号。

## 8. 配置包来源

### HTTP/HTTPS

```yaml
package:
  provider: https
  source:
    url: https://downloads.example.com/backend-1.0.0.tar.gz
  hash:
    algorithm: sha256
    value: <真实的 64 位十六进制 SHA-256>
```

HTTP 和 HTTPS 下载都会由 sfo-deploy 再次校验声明的哈希。为了让发布快照可用于回退，URL
必须稳定，不能包含用户名、密码、查询参数或 fragment；不要使用把凭据放在 URL 中的方式。

### filehub

```yaml
package:
  provider: filehub
  source:
    target: SERVER/PROJECT/VERSION/NAME
  hash:
    algorithm: sha256
    value: <真实的 64 位十六进制 SHA-256>
```

运行前必须安装并配置 `filehub` 客户端。`target` 必须是规范的四段标识，凭据由 filehub
自己的配置或环境变量管理，不能写入部署 YAML。即使 filehub 已校验内容，sfo-deploy 仍要求并验证
`hash`。

### 先 fetch 到本地缓存

执行 `deploy` 前先用 `fetch` 把 App 安装包下载到部署机本地缓存：

```bash
sfo-deploy fetch --config-root ./clusters --cluster production --app backend
```

缺省下载全部 App 的安装包，`--app` 可重复筛选。缓存默认位于 `~/.sfo-deploy/packages/`，按 provider
与算法-哈希内容寻址存储；本地已有同版本且哈希校验通过的包时输出 `cached` 并跳过远端下载。目录可通过
`~/.sfo-deploy/config.yaml` 自定义：

```yaml
schema_version: 1
packages_dir: /data/sfo-deploy/packages
```

`deploy` 只从该缓存取包，缺少目标包时在预检期失败（退出码 3）并提示先运行 `fetch`，不会连接远端或
创建发布记录。`install`/`rollback` 等动作缓存优先，缓存缺失时仍按原 source 下载并回填缓存；回退旧
版本仍要求原制品源可访问。

App 可执行包必须是 tar.gz：fetch 与部署准备阶段都会校验 gzip 魔数。首次 SSH 前，框架固定本地缓存的
原始包并生成所有 managed 配置骨架，再把原始包、声明脚本、骨架/绑定和普通文件连同 `manifest.json`
封装成一个确定性外层 tar.gz。原始包在外层包中固定为 `package/app.tar.gz`，字节和摘要不变；其它成员
分别位于 `scripts/`、`configs/`、`files/`。

每个 App 步骤的非秘密输入通过一次外层包上传。目标节点先验证外层长度/SHA-256，再拒绝归档中的链接、
目录、特殊文件、成员集合/顺序不符和越界内容；安全解包后逐项验证 manifest 长度、SHA-256 与期望 mode，
完整通过并写入 ready 标记后才允许 deploy/渲染器消费。相同 workspace 与 bundle digest 可直接复用已
验证内容。执行阶段不会再次调用 package provider。秘密永远不进入部署包、manifest 或控制端骨架；每个
值秘密按配置引用复制到独立 0700 目录（文件 0600）并在调用后清理；文件秘密只暴露 `secrets-deploy`
后的稳定路径。lifecycle/hook 仍只复制第 9 节描述的机器范围步骤集合，不会在消费者之间复用目录。

内置 versioned release 在 stage 建立版本目录并发布配置，在 activate 切换最新版本并启动服务； 自定义
deploy 脚本按 App 安装协议消费该目录；legacy deploy 脚本继续取得原始 tar.gz。managed
配置则由框架固定渲染器 在节点注入当前秘密、生成候选并单独原子发布，两者职责不要混淆。

旧版本自动清理由用户配置 `~/.sfo-deploy/config.yaml` 的 `keep_versions` 控制（默认 5，范围
1-100）。内置版本部署仅在服务与版本标记提交成功后清理：始终保留当前版本，再按目录修改时间保留
其他较新版本，合计最多 N 个。只识别包含匹配 `VERSION` 普通文件的版本目录，保留 logs 等普通目录。
同版本成功提交也会执行此保留策略；准备失败或补偿路径不清理旧版本。清理失败单独报告，已删除版本不可回滚。

## 9. 配置秘密、放置与秘密装载

部署 YAML 只声明秘密的逻辑名称、类型和放置目标，不保存秘密值。密钥名称必须匹配大写字母开头的
`A-Z0-9_` 标识。真实来源保存在集群目录内的未提交 `secrets.yaml`，顶层键直接使用密钥名，不添加
`secrets:` 包装层：

```yaml
DB_PASSWORD: "local-only-value"
HTTPS_PRIVATE_KEY: "files/server.key"
```

`cluster.yaml` 中的 `kind` 决定解释方式：`value` 是秘密字符串；`file` 是本地源文件路径。文件路径
相对于 `secrets.yaml` 所在目录解析，必须是集群目录内的相对 POSIX 路径，禁止 `..` 和符号链接逃逸。
该文件权限必须是 `0600`，并且不应提交到版本控制。

每个密钥必须在集群根 `cluster.yaml` 的 `secrets:` 显式声明放置机器（具体名称列表或通配符 `*`），
否则默认不部署到任何节点；未声明的密钥不会被 `secrets-deploy` 部署：

```yaml
secrets:
  DB_PASSWORD:
    kind: value
    machines: [app-01]
  HTTPS_PRIVATE_KEY:
    kind: file
    machines: "*"
```

通用 CLI 会在部署时自动读取 `<cluster-directory>/secrets.yaml`。随后运行
`sfo-deploy secrets-deploy --config-root ./clusters --cluster production`
把密钥部署到目标机器。重复执行 幂等；`--machine` 与放置声明相交，`--check`
只读校验目录权限与清单哈希并报告缺失/漂移/extra， `--remove NAME` 显式移除；后两者不要求
`secrets.yaml`。若集群目录存在 `known_hosts`，CLI 自动使用它。 安全目录默认
`~/.sfo-deploy/secrets/`（0700，文件 0600），可在 `machines.yaml` 按机器用 `secrets_dir` 覆盖。

脚本在开启秘密交付的步骤（环境 `configure`、App `configure`/`deploy` 及含 hook 的动作） 通过 loader
读取本机 `cluster.yaml.secrets` 已声明放置的全部秘密；值密钥返回非空字符串，
文件密钥返回副本内受限绝对路径（脚本以只读方式自行打开）。框架不解释模板内容，也不再提供远端
`renderTemplate()`；如果项目约定 `$DB_PASSWORD`、`${DB_PASSWORD}` 和 `$$`，替换、未知占位符拒绝、
临时文件原子写入和 mode `0600`
都由自包含脚本实现。持久目标目录、最终所有者和后续权限仍由项目脚本通过 显式白名单子进程负责。仓库
Multipass 示例展示了保留这些行为的文件内实现。

`secrets-deploy` 在部署前要求 `secrets.yaml` 覆盖 `cluster.yaml.secrets`
中的每个密钥；缺失来源、未知 密钥、重复键、路径逃逸或不可读文件都会在 SSH
前失败关闭（执行脚本步骤时提示先运行
`secrets-deploy`）。需要动态生成值或从自定义存储读取来源的项目，仍可通过公共 TypeScript API 的
`createCli()` 与 `ProjectBindings` 构造显式绑定入口。

## 10. 校验和预览计划

先在不建立 SSH 连接的情况下检查整个集群：

```bash
sfo-deploy validate --config-root ./clusters --cluster production
```

`validate` 会装载全部 YAML，检查目录、字段、依赖、App 放置和本地资源路径，成功时输出不含秘密的 JSON
摘要。

再预览一次 App 部署计划：

```bash
sfo-deploy plan \
  --config-root ./clusters \
  --cluster production \
  --machine app-01 \
  --app backend
```

`plan` 预览的是 `deploy` 动作，不建立 SSH 连接、不下载包、不解析秘密值。`plan` 只处理
App，不支持环境筛选或依赖展开。输出中的步骤顺序、目标地址、动作、包 provider
和秘密逻辑名称都应在执行前人工核对。

重点检查：

- 目标机器和 `private`/`public` 地址是否正确；
- 环境依赖已通过 `prepare` 就绪；
- 是否只选择了预期 App 和机器；
- 计划中不应出现秘密值或私钥内容。

## 11. 执行首次部署

先用 prepare 准备环境，再部署选中的 App：

```bash
sfo-deploy fetch \
  --config-root ./clusters \
  --cluster production \
  --app backend

sfo-deploy prepare \
  --config-root ./clusters \
  --cluster production \
  --machine app-01 \
  --env runtime

sfo-deploy deploy \
  --config-root ./clusters \
  --cluster production \
  --machine app-01 \
  --app backend
```

managed App 的 deploy 流程会：

1. 在控制端生成无秘密骨架和单一部署包，随后在节点验证、安全解包；
2. 内置 versioned App 在 stage 完成版本目录、配置事务及 systemd
   准备，保留工作目录和锁直到提交或恢复；
3. 全部 stage 成功后，每个 activate 执行相邻的 latest 切换与启动/重启，不再追加独立 restart 步骤；
4. 准备失败不切换版本；切换失败不启动新服务；服务失败恢复配置、原软链接与标记并补偿原服务，恢复失败明确报告；
5. 服务成功后提交版本标记并清理旧版本、配置备份及工作区。清理失败单独报告，不回滚已成功运行的版本。

自定义 deploy 和无包配置应用保留原有配置、通知合并及服务管理行为；跨机器不保证原子回滚。

App 部署包来自上一步 `fetch` 写入的本地缓存；未先 fetch 时，命令会在任何 SSH 连接前预检失败并提示
运行 `fetch`。

也可以先用专门命令准备好环境应用，再定向部署 App：

```bash
sfo-deploy prepare \
  --config-root ./clusters \
  --cluster production \
  --env runtime

sfo-deploy deploy \
  --config-root ./clusters \
  --cluster production \
  --app backend
```

deploy 不执行依赖环境检查；环境应用必须先通过 `prepare` 准备。

执行 `deploy` 前，CLI 会先打印计划步骤并等待输入 `yes` 二次确认；确认后才创建发布 attempt 与快照并
连接远端，拒绝、EOF 或非交互终端未显式传 `--yes` 时按取消处理（退出码 130）且不执行任何远端步骤。
自动化部署必须显式传 `--yes`。

`configure`、`start`、`stop`、`restart`、`deploy`、`rollback` 都在控制端 release attempt 中运行。
每个目标上的 managed 状态转换还会先获取同一 App/目标键的 `flock` 租约，持锁覆盖 bundle、配置、
脚本和 systemd 动作；获取失败时不产生副作用，成功、失败、超时和取消都在清理后释放租约。框架不会对
有副作用动作自动重试。

`--with-dependencies` 适用于 `configure`、`start`、`stop` 和 `restart` 等定向 App 动作；
它会保留当前 `--machine` 和 `--environment`
选择范围内的环境，再校验依赖闭包。生产操作应显式给出这两个筛选器；如果过滤掉必需依赖，规划会失败。
`deploy` 和 `plan` 不支持该开关。

内置部署以 `app_versions.yaml` 的 `version` 作为待部署版本。版本一致时跳过制品暂存，仍执行配置
事务与必要的服务启动/重启；同版本更新直接作用于当前版本文件，不具有新版本的目录隔离。
版本不同则先向真实版本目录发布制品与配置，全部目标准备成功后才逐目标切换并立即启动/重启。 生产 App
的 version 必须反映真实发布版本，服务验证成功前保留恢复所需的旧版本。

如果使用 `configure` 而不传 `--with-dependencies`，定向 App
动作只检查其传递环境依赖，不会自动安装或配置它们；检查不满足时 App
步骤会被阻断。这适合环境由其他流程预先管理的场景。

集中定义不改变实例和过滤器名称：放置到 `app-01` 的 `runtime` 仍用 `--environment app-01/runtime`
精确选择，也可用短名 `--environment runtime` 匹配当前机器范围内的同名实例。 Environment/App 的短
`depends_on` 始终绑定各自所在机器；只有显式 `机器名/环境名` 才是跨机器依赖。 `--machine` 和
`--environment` 不会为了满足依赖而自动扩大范围。

也可以单独管理环境：

```bash
# 检查全部机器上的全部环境
sfo-deploy check --config-root ./clusters --cluster production

# 只检查一个环境实例
sfo-deploy check --config-root ./clusters --cluster production \
  --environment app-01/runtime

# 直接安装全部环境；省略环境过滤器时需要确认
sfo-deploy install --config-root ./clusters --cluster production

# 非交互环境必须明确同意全量安装
sfo-deploy install --config-root ./clusters --cluster production --yes
```

`check` 和 `install` 是纯环境动作，不能与 `--app` 同时使用。省略 `--environment`
时会选择当前机器范围内的全部环境；可用重复的 `--machine` 或 `--environment [MACHINE/]NAME`
收窄范围。显式选择环境时，如果其依赖未同时入选，规划会失败，不会偷偷扩大范围。

`--machine`、`--app` 和 `--environment` 都可以重复。`deploy` 不加筛选器会覆盖配置中的全部 App，
不会覆盖任何环境；生产执行前应优先使用定向筛选器并检查 `plan`。

## 12. 发布历史与回退边界

`configure`、`start`、`stop`、`restart`、`deploy`、`rollback` 都会在集群目录的
`.sfo-deploy/releases/` 下创建记录。成功结果中的 `release_id` 可用于查询；只有成功的 deploy/rollback
记录包含 rollback plan 并可作为回退来源，其他四类记录只保存 actual plan 供审计：

```bash
sfo-deploy history --config-root ./clusters --cluster production
sfo-deploy history --config-root ./clusters --cluster production \
  --release-id <release_id>
sfo-deploy rollback --config-root ./clusters --cluster production \
  --release-id <release_id>
```

回退重放快照中的 App `deploy` 和已声明的 `configure`；旧 deploy 快照还会重放其传递依赖的环境
`check`，新 deploy 快照没有环境步骤。回退不会执行环境
`install`/`configure`，也不会撤销数据库迁移、消息发送或外部服务写入。旧包来源必须仍可访问并保持相同
哈希。plan-v4 快照只保存无秘密 management 声明和骨架输入；回退时重新读取目标节点当前已放置的秘密，
不会从历史恢复旧密码。

单次 managed 执行中，候选生成或 validator 失败时最终配置不变；配置发布后 service/hook 失败时，框架会
尝试恢复旧配置以及操作前读取到的 systemd enabled/active 状态。补偿本身失败会产生明确的
partial/recovery 结果，需要人工按实际状态处理。框架不会重试有副作用的脚本，也无法自动撤销 App deploy
脚本已完成的数据库或外部系统写入。

当前执行器不会为脚本上传兼容运行库。任何仍导入 `./sfo_deploy.ts`（或 Python
同类辅助文件）的现有集群脚本
都必须先迁移为自包含程序。包含此类导入的历史发布快照也不保证能由当前版本直接回放：应迁移快照，或保留并使用
与快照协议匹配的旧版执行器；框架不会自动检测导入并注入 shim。

`.sfo-deploy/releases/` 不会自动清理。应监控容量，并把它纳入备份和恢复方案。

## 13. 常见错误

### YAML 校验失败

- 确认 `cluster.yaml` 新布局使用 `schema_version: 2`，`machines.yaml`/`environment.yaml` 使用 v1；
  `cluster.yaml` 不支持 schema v1，旧每机 Environment 布局会被拒绝。新 managed App 使用 app schema
  v3， App 不支持 schema v1；旧 v2 App 不允许 `management`。
- 删除重复键和未支持字段。
- 确认 App/环境的 `name` 与目录名完全一致。
- 确认 `cluster.yaml.environments` 与 `environments/`
  共享定义集合一致，且每个目标列表非空、无重复并只引用已声明机器。
- 确认 `cluster.yaml.apps` 与 `apps/` 目录集合一致。
- 确认所有脚本、模板和 SSH 私钥路径均存在且没有 `..` 路径逃逸。

### 规划提示缺少 private/public IP

检查 `executor_region` 与机器 `region`。同区默认要求 `private_ip`，跨区默认要求
`public_ip`；也可以在明确了解网络路由的前提下使用 `--address-kind`
覆盖。字段为列表时还应检查声明顺序以及每个候选 IP 的 known-hosts
记录；所有同类候选都失败后才会返回聚合连接错误。

### 规划提示依赖被过滤

环境筛选不会自动扩大依赖范围。把依赖环境一起加入 `--environment`，或调整本次选择范围。定向 App
configure/start/stop/restart 如果希望管理其环境依赖，应使用 `--with-dependencies`。

### 配置步骤提示未绑定秘密

通用 CLI 会先读取集群本地 `secrets.yaml`，把 YAML 声明的全部 `secret_values`/`secret_files`
放置到目标 机器，再执行脚本步骤；`secrets.yaml` 缺失或来源无效，以及远端密钥未放置，都会在 SSH
前失败关闭。

### 下载失败或哈希不匹配

- 检查 URL/filehub target 和客户端认证；
- 从可信发布渠道重新获取哈希；
- 不要为了通过校验而把 YAML 改成失败输出里的未知哈希；
- 确认旧版本包在未来回退时仍可取得。
- 本地缓存缺失或校验失败时，先运行 `sfo-deploy fetch` 对应的 `--app`，或按错误提示移除损坏的缓存
  文件后重新 fetch。

### 脚本在远端失败

CLI 输出固定退出码为：成功 `0`、用法/配置错误 `2`、预检失败 `3`、下载或远端执行失败 `4`、用户取消
`130`。检查失败步骤的 `machine`、`resource`、`action`、固定错误类别和清理错误。框架用本次操作解析的
秘密全集在 stdout/stderr、错误和 cleanup 信息进入结果或历史前脱敏；redactor 无法安全构造或应用时会
丢弃 stdout/stderr，而不是返回原文。脚本仍不应主动打印秘密。

### App 部署缺少依赖环境

deploy 不再检查或安装依赖环境。先运行
`sfo-deploy prepare --env <依赖环境>`（缺省全量会请求确认），确认依赖环境就绪后重新执行 App 部署。

## 14. 上线前检查清单

- [ ] 所有示例域名、IP、URL、哈希、用户和目标路径已替换。
- [ ] SSH 私钥和项目秘密未提交到版本库。
- [ ] `cluster.yaml` v2 的 Environment/App 映射与定义目录完整闭合，所有目标机器均已声明且无重复。
- [ ] 同一 Environment 的所有目标机器可共用完全相同的参数和资源；需要机器差异的配置已拆成不同名称。
- [ ] 每台机器可通过所选地址和 SSH 用户访问，主机指纹已可信登记，并已安装配置的 Deno 2。
- [ ] 每个 TypeScript 脚本只声明实际需要的绝对 `run` 路径和精确 `net` 目标；无直接网络需求时 `net`
      为空。
- [ ] 需要提权的环境或文件秘密目标可使用 root 或非交互 `sudo -n`。
- [ ] 环境脚本可重复执行，`check` 能准确区分“满足”和“未满足”。
- [ ] App 脚本不依赖未声明的 root 权限。
- [ ] App schema 1 的 configure 与服务动作只有一个所有者，没有同时声明冲突的 legacy 脚本。
- [ ] 每个 managed App 都声明了已存在的非 root `run_as`，root SSH 可对该账号执行 `sudo -n -u`。
- [ ] managed 配置中的 `${SECRET_NAME}` 均已声明并放置到目标机器；普通变量 marker
      各出现且只出现一次。
- [ ] file 秘密稳定路径对 `run_as` 可读，证书/密钥轮换的服务动作策略已确认。
- [ ] systemd unit、enabled/on_deploy/on_change 与预期动作一致，远端可 root 或 `sudo -n`。
- [ ] 包来源稳定，哈希来自可信渠道；filehub 客户端已完成认证。
- [ ] 目标 App 的安装包已通过 `sfo-deploy fetch` 进入本地 `packages_dir` 缓存。
- [ ] `validate` 成功，`plan` 中的机器、地址、步骤顺序和选择范围已人工复核。
- [ ] 首次生产执行使用明确的 `--machine`/`--app`/`--environment` 范围。
- [ ] 数据库、消息、外部 API 等不可自动回退的脚本副作用有独立恢复方案。
- [ ] `.sfo-deploy/releases/` 已纳入容量监控和备份。
