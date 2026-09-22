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
├── app_versions.yaml
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
        └── templates/
            └── application.ini.tpl
```

四个核心概念是：

- `cluster.yaml` 定义集群名称、执行器所在区域，以及 Environment 和 App 分别放置在哪些机器上。
- `machines.yaml` 定义 SSH 目标和地址，不在这里声明环境。
- `environments/<环境>/environment.yaml` 集中定义一个 Environment 的安装、配置和生命周期脚本。
- `apps/<App>/app.yaml` 定义安装目录、环境依赖、配置交付与服务管理；带包 App 的版本和包来源
  单独放在集群根 `app_versions.yaml`。

所有 YAML 都采用严格装载：`cluster.yaml` 使用 schema 2，`machines.yaml`、`environment.yaml`、
`app_versions.yaml` 和 `app.yaml` 使用 schema 1。旧 cluster schema 1 每机环境布局及旧 App schema
2/3/4 均不兼容；当前 App schema 1 也不接受旧的内联 version/package。
重复键、未知字段、缺少必填字段或不合法路径会被拒绝。具体契约以当前
[`src/config.ts`](../../src/config.ts)、[`src/planning.ts`](../../src/planning.ts) 和 CLI 帮助为准；
也可使用配套的[集群配置技能](../../skills/sfo-deploy-cluster/SKILL.md)生成配置。

## 2. 创建集群目录

从仓库或项目工作目录创建配置根：

```bash
mkdir -p clusters/production/environments/runtime/scripts
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
deployer_version: "0.1.0" # 可选：要求精确匹配的 sfo-deploy 版本
environments:
  runtime: [app-01]
apps:
  backend: [app-01]
```

字段说明：

| 字段               | 说明                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`   | 只支持 `2`；旧 v1 每机环境布局已移除。                                                                                                                                                                                                |
| `name`             | 集群逻辑名称。建议与目录名一致；CLI 仍以目录名选择集群。                                                                                                                                                                              |
| `executor_region`  | 发起部署命令的默认区域，用于自动选择内网或公网地址。                                                                                                                                                                                  |
| `deployer_version` | 可选。要求运行中的 sfo-deploy 版本与之精确一致（全等字符串，不 trim）；不一致时在 SSH 前 fail-closed 拒绝 validate/plan/deploy/check/prepare/start/stop/restart。缺省不启用门禁。运行时版本来自仓库根 `deno.json` 的 `version` 字段。 |
| `environments`     | Environment 到目标机器列表的完整映射。只在 schema v2 中存在。                                                                                                                                                                         |
| `apps`             | App 到目标机器列表的完整映射。`apps/` 下每个 App 都必须出现，不能多也不能少。                                                                                                                                                         |

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
    # 可选：先放置真实私钥文件再启用，省略时沿用 OpenSSH 默认身份选择。
    # ssh_private_key: secrets/id_ed25519
    deno: /usr/local/bin/deno
```

主要字段：

| 字段              | 必填 | 说明                                                                             |
| ----------------- | ---: | -------------------------------------------------------------------------------- |
| `name`            |   是 | 机器名称，供 `cluster.yaml` 放置映射和 CLI 筛选器引用。                          |
| `region`          |   是 | 机器所在区域。                                                                   |
| `ssh_user`        |   是 | SSH 登录用户。                                                                   |
| `private_ip`      |   否 | 单个内网 IP 或按优先级排列的非空 IP 列表；同区连接默认选择这一类。               |
| `public_ip`       |   否 | 单个公网 IP 或按优先级排列的非空 IP 列表；跨区连接默认选择这一类。               |
| `domains`         |   否 | 与机器关联的描述性域名列表；当前不参与 SSH 地址选择。                            |
| `ssh_port`        |   否 | 默认 `22`，有效范围为 `1` 到 `65535`。                                           |
| `ssh_private_key` |   否 | 相对于集群目录的私钥文件路径。                                                   |
| `deno`            |   否 | 远端 Deno 2 命令，默认 `deno`；可填写 `deno` 或规范绝对 POSIX 路径，不能带参数。 |

如果机器 `region` 与 `executor_region` 相同，计划默认使用 `private_ip`；否则使用 `public_ip`。可以用
`--executor-region` 或 `--address-kind private|public` 覆盖选择。字段仍兼容原有单个 IP
字符串；使用列表时，SSH 会在选定类别内按声明顺序串行尝试，首次成功后停止。不会从 private 自动切到
public（反之亦然）；所选类别不存在地址时，规划会失败。空列表、重复地址或非法 IP
会在配置加载阶段被拒绝。

`ssh_private_key`
必须指向本地可读普通文件。不要把真实私钥提交到版本库；应把对应路径加入项目忽略规则，并通过安全渠道放置文件。省略该字段时沿用
OpenSSH 默认身份选择，包括 SSH agent、用户 SSH 配置及默认私钥；框架不自行扫描或上传默认私钥。

SSH 主机密钥采用严格校验：CLI 优先使用集群根 `known_hosts`，否则传输层要求本地 `~/.ssh/known_hosts`
是可读普通文件（公共 API 也可显式传入文件）。仅有系统全局主机记录不足以
满足这个文件检查。未知主机密钥会被拒绝；首次部署前应通过可信渠道核对并登记目标指纹。

目标机必须预装 Deno，且主版本不低于
2。框架在执行新集群的第一个生命周期脚本前预检版本；命令缺失、输出异常或版本过低都会失败关闭。当前
版本只支持 Deno；Python v1 历史快照会被明确拒绝，不再回放或静默转换。

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
`deno`。缺省安装到 `/usr/local/bin/deno` 后即可在默认 PATH 中找到；若显式指定远端绝对安装目录（如
`--install-to /home/deploy/.deno`） 或手工安装到非 PATH 目录，则需要把安装目录加入 PATH，或在
`machines[].deno` 中写实际路径。

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

| 字段                 |   必填 | 说明                                                                                                                |
| -------------------- | -----: | ------------------------------------------------------------------------------------------------------------------- |
| `name`               |     是 | 必须与环境目录名一致。                                                                                              |
| `version`            |     是 | 环境版本；脚本可从 `metadata.parameters.version` 读取。                                                             |
| `scripts`            | 二选一 | 旧生命周期入口；动作到有序 TypeScript 脚本对象列表的映射，不能与 `install`/`manager` 同时声明。                     |
| `install`            | 二选一 | 新生命周期入口，声明系统包安装或安装脚本；新契约必须声明，不能与 `scripts` 同时声明。                               |
| `manager`            |     否 | 新生命周期的可选服务管理声明；缺省表示只安装依赖，不管理运行中的应用。                                              |
| `init`               |     否 | 新生命周期的可选初始配置声明；支持 `before_start`/`after_start` 两个可选 Deno 脚本列表，不能与 `scripts` 同时声明。 |
| `parameters`         |     否 | Environment 参数，会覆盖 `defaults` 中的同名值，并用于该定义的全部目标机器。                                        |
| `defaults`           |     否 | 环境默认参数。                                                                                                      |
| `depends_on`         |     否 | 环境依赖；`runtime` 表示同机环境，`app-02/runtime` 表示指定机器环境。                                               |
| `requires_privilege` |     否 | 默认为 `false`；为 `true` 时，环境脚本通过远端提权接口执行。                                                        |
| `package`            |     否 | 环境安装需要的下载包；只在环境 `install` 步骤下载。                                                                 |

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

不需要框架启动应用时，`manager` 可缺省；此时执行安装及已声明的 init。需要应用运行管理时声明
`manager`。 `manager.kind: system` 的 `tool: auto` 按 `systemctl`、`service` 顺序探测，Ubuntu/Debian
通常命中 systemctl；CentOS 7 也可能使用
systemctl，不能仅按发行版名称推断工具。显式指定工具时缺失即失败。`enabled` 控制目标状态，缺省为
`true`（开机启动），显式 `false` 关闭。`start_after_install: false` 时 `prepare` 会新增独立 `enable`
步骤，按 `enabled` 收敛开机状态（缺省开启、显式 false 关闭），不执行 start/restart。

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

需要 app 启动前/启动后初始配置时，可在 `install`/`manager` 之外声明可选 `init` 段。`init`
整体可选；`before_start`/`after_start` 各自也是可选列表，未声明或为空时对应步骤不生成：

```yaml
init:
  before_start:
    - path: scripts/before-start.ts
      permissions:
        run: [/usr/bin/install]
        net: []
  after_start:
    - path: scripts/after-start.ts
      permissions:
        run: [/usr/bin/install]
        net: []
```

`prepare` 对新生命周期按
`install → before_start（如声明）→ start/restart 或 enable（按 manager 声明）→ after_start（如声明）`
的顺序执行：启动前初始配置位于服务启动之前，启动后初始配置位于服务启动/重启 成功之后；若没有 manager
或只执行 enable，init 仍按声明执行，after_start 并不保证服务已启动。
任一初始配置步骤失败都会让该环境实例的 prepare 失败，且不写入环境版本标记。新生命周期没有 check，
不会因为版本标记相同就跳过 install/init；包安装查询是否缺包，脚本安装与 init 必须自行幂等。显式
`start`/`stop`/`restart` 不执行 `init` 脚本， `init` 只属于 `prepare` 安装/更新流程。

### 环境脚本

生命周期脚本必须是环境目录内已存在的 `.ts` 文件。旧 `scripts.<动作>` 和 `init` 使用有序调用列表；新
`install.kind: script` 与 `manager.kind: script` 的每个动作使用单个 `{path, permissions}`
对象。每个脚本都是自包含程序，除框架运行时上传的受限 loader 外不导入 sfo-deploy
源码；纯动作脚本不需要读取 context，需要步骤输入的脚本按第 7 节在本文件内解析普通 JSON。

`permissions.run` 的每一项必须是规范绝对 POSIX 可执行路径；空列表表示脚本不能直接启动子进程。
`permissions.read` 与 `permissions.write` 分别列出 Deno 直接 API 的扩展路径；每项必须是规范绝对
POSIX 路径，不含根、`.`、`..`、逗号、空白或控制字符。workspace 始终在两类权限中，扩展路径按 Deno
路径前缀语义展开；只读路径不能写入或删除。`permissions.net` 默认空，只接受无 scheme、凭据、路径或
通配符的主机/IP，可附带端口，例如 `127.0.0.1:8080`。不要为使用 `apt-get` 等子进程访问软件源而授予
Deno `net`：网络是该子进程自己的能力，不是 Deno 直接 API 的能力。

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
const directory = await new Deno.Command("/usr/bin/install", {
  args: ["-d", "-m", "0755", "/opt/example-runtime"],
}).output();
if (!directory.success) throw new Error("runtime directory creation failed");
await Deno.writeTextFile("installed.marker", "installed\n");
const marker = await new Deno.Command("/usr/bin/install", {
  args: ["-m", "0644", "installed.marker", "/opt/example-runtime/.installed"],
}).output();
if (!marker.success) throw new Error("runtime marker install failed");
```

`scripts/configure.ts`：

```typescript
const metadataPath = Deno.env.get("DEPLOYMENT_METADATA_PATH");
if (!metadataPath) throw new Error("DEPLOYMENT_METADATA_PATH is not set");
const metadata = JSON.parse(await Deno.readTextFile(metadataPath));
const parameters = metadata?.parameters;
if (typeof parameters?.version !== "string" || typeof parameters?.install_root !== "string") {
  throw new Error("runtime parameters are invalid");
}
await Deno.writeTextFile("runtime.conf", `version=${parameters.version}\n`);
const result = await new Deno.Command("/usr/bin/install", {
  args: ["-m", "0644", "runtime.conf", `${parameters.install_root}/runtime.conf`],
}).output();
if (!result.success) throw new Error("runtime configuration install failed");
```

`prepare` 等环境流程按需规划 `check`、`install`、`configure`、`start`、`stop` 或 `restart`
步骤；规划到的步骤要求配置中存在对应脚本，否则规划失败。旧 `scripts` 环境包含环境时，`prepare`
先执行 `check`，返回 `0` 时对应安装步骤会跳过，返回非零时才安装；未声明 `check` 时会直接安装。
`install` 脚本必须存在；`configure` 是可选步骤，省略时计划不生成该步骤。新 `install`/`manager`
环境没有 `check`，总是执行幂等 `install`；安装脚本本身仍应设计为幂等。

`requires_privilege: true` 会让该环境的所有动作要求远端身份为 root，或能够执行非交互
`sudo -n`；需要交互输入 sudo 密码的目标会在预检阶段失败。该字段控制环境脚本；内置 package 安装 和
system 服务操作自行请求提权，不能用 `requires_privilege: false` 禁用它们的提权。

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
成功后自动执行 `restart`；未声明的 start/restart 不生成对应步骤。

新 `install`/`manager` 环境没有 `check`：总是执行幂等 `install`；声明 `manager` 且
`start_after_install: true`（或脚本 manager）时，无旧版本标记选择 `start`，已有标记选择 `restart`，
即使版本字符串相同也一样。缺省 manager 不产生服务动作，init 仍执行；start_after_install 为 false
时仅收敛 enabled 状态。环境 version 是配方版本，不是系统包管理器自动锁定的软件版本。

框架把 `environment.yaml` 的 `version` 记录到目标机 `~/.sfo-deploy/environments/<环境名>.version`
作为更新标记；任何步骤失败、阻断或取消都不会更新 标记，下一轮 `prepare`
仍按旧版本处理。环境应用的安装/配置默认不进入 `.sfo-deploy/releases/` 发布快照与 `rollback` 回放。

## 6. 配置 App

App 目录名必须与 `app.yaml.name` 一致，使用 `schema_version: 1`。当前 App 字段如下；
`version`/`package` 不写在 app.yaml，`parameters`/`defaults`、顶层 `scripts`、`templates`、
`secret_values`/`secret_files`、`updater` 和 hook 均不是当前 App 契约。

| 字段                | 必填       | 说明                                                             |
| ------------------- | ---------- | ---------------------------------------------------------------- |
| `schema_version`    | 是         | 固定为 `1`，旧 App schema 2/3/4 不兼容。                         |
| `name`              | 是         | 与 App 目录名和放置键一致。                                      |
| `install_directory` | 带包时必填 | 规范远端绝对 POSIX 路径；无包 App 可选。                         |
| `mode`              | 否         | versioned 发布树权限，三或四位八进制字符串。                     |
| `packageless`       | 否         | 缺省 false，true 表示无安装包配置应用。                          |
| `deployment`        | 否         | 只支持 `kind: versioned`；带包 App 自动启用，无包 App 不得声明。 |
| `depends_on`        | 否         | 环境依赖，短名指向每台放置机器上的环境。                         |
| `configs`           | 否         | `kind: file` 或 `kind: script` 的配置条目列表，可混用。          |
| `management`        | 否         | 单个 `kind: service` 或 `kind: script` 管理器。                  |

### 带包应用：版本、配置和服务

创建 `clusters/production/app_versions.yaml`。以下 URL 和摘要是**待补草稿**，必须先换成真实可信值，
才能校验交付；不要用全零或随机摘要伪装可部署制品：

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
        value: "REPLACE_WITH_TRUSTED_SHA256"
```

`app_versions.yaml` 只列出带包 App，集合必须与带包定义完全一致；缺失记录、多余记录及无包 App
的版本记录都被拒绝。即使全部 App 都无包，仍需 `schema_version: 1`、`apps: {}` 的版本文件。

创建 `clusters/production/apps/backend/app.yaml`。本例假设 tar.gz 包包含 `bin/server`，该程序接受
`--config config/application.ini`；必须按实际制品替换这些约定：

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
    target: "${CURRENT_VERSION_DIRECTORY}/config/application.ini"
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
  kind: service
  name: backend.service
  tool: auto
  enabled: true
  daemon_reload: true
  on_deploy: restart
  timeout_ms: 30000
  unit_config:
    working_directory: latest
    command: bin/server
    args: ["--config", "config/application.ini"]
    restart_policy: on-failure
    restart_sec: 5
    start_limit_interval_sec: 30
    start_limit_burst: 5
```

创建 `clusters/production/apps/backend/templates/application.ini.tpl`：

```ini
[application]
version = __SFO_CONFIG_VAR_V1_APP_VERSION__
listen = 0.0.0.0:8080
```

普通部署将包发布到 `<install_directory>/<version>/`，在候选版本中生成配置，再切换 `latest`。
因此上例配置目标、unit 工作目录和启动参数指向同一版本。框架会在候选版本内创建缺失的配置父目录；
无法保证其他绝对目标的父目录存在，应由环境准备或运维流程提前建立。

App schema 1 不提供自定义 `scripts.deploy`。配置逻辑使用 `configs.kind: script`，服务逻辑使用
`management.kind: script`；不能把旧自定义部署协议直接带入新配置。

### 无包应用与配置脚本

无包 App 通过 `packageless: true` 声明，不提供独立 check，不允许 deployment 或 mode，也没有
app_versions 记录。示例 `apps/settings/app.yaml`：

```yaml
schema_version: 1
name: settings
packageless: true
configs:
  - kind: file
    source: templates/settings.json
    target: /home/deploy/settings.json
    format: json
    mode: "0600"
    on_change: none
```

相应 `apps/settings/templates/settings.json`：

```json
{
  "log_level": "info"
}
```

按需在 `cluster.yaml.apps` 添加 `settings: [app-01]`，确保 `/home/deploy` 已存在。此例不管理服务；
省略 management 不会丢弃配置。`deploy` 为无包 App 生成 configure 步骤，fetch 跳过它。

配置脚本条目使用 App 内现有的 `.ts` 文件及权限声明：

```yaml
configs:
  - kind: script
    path: scripts/configure.ts
    permissions:
      run: []
      net: []
      read: [/home/deploy/input]
      write: [/home/deploy/output]
```

这是需要配套真实脚本的声明片段。file 和 script 条目可以混用；脚本按声明顺序执行，文件由框架统一
发布。配置脚本必须幂等，非零退出会使当前步骤失败。versioned App 的配置脚本在 stage 前的 configure
运行，不能假定新包此时已经展开。无包 App 的参数为空，不凭空引用 version 或自定义 parameters。

### Managed 配置、目录变量与占位符

每个 file 条目必填 source、target、format，不声明 name。source 是 App 内可读文件；target 是规范
远端绝对路径，或以下变量加相对路径。变量只能在开头，不能包含 `..`，使用变量必须声明
install_directory。

| 变量                           | 含义                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `${INSTALL_DIRECTORY}`         | 安装根，不自动重定位到版本目录。                          |
| `${CURRENT_VERSION_DIRECTORY}` | 当前动作的版本目录，deploy 为候选版本。                   |
| `${LATEST_DIRECTORY}`          | latest 路径；deploy/rollback 的配置发布会定位到对应版本。 |

旧绝对 `<install_directory>/latest/` 前缀仍会重定位；其他绝对 target 保持原位置。框架校验真实路径，
拒绝符号链接逃逸或越界，不能靠变量绕过发布根检查。

format 支持 yaml/json/toml/ini/nginx。结构化源配置会生成无秘密骨架，由框架携带的离线渲染器在目标机
注入当前秘密并重新解析后发布；`format: nginx` 按 UTF-8 原文发布，不解析 Nginx DSL，不支持 variables
或秘密占位符，语法需通过实际 Nginx validator 检查。

owner/group 可选；文件 mode 缺省 `"0600"`，必须允许 owner 读取，不允许执行位或 group/other 写权限。
`on_change` 可取 none/reload/restart，后两者必须有 service 管理器。可选 validator 使用固定 argv，
首项为绝对可执行路径，且必须恰有一个独立 `{candidate}` 参数，例如：

```yaml
validator:
  argv: [/usr/local/bin/backend, check-config, "{candidate}"]
  timeout_ms: 10000
```

普通变量使用 `__SFO_CONFIG_VAR_V1_<NAME>__`，独占完整值，并用 variables 的 path 从步骤参数绑定。
带包 App 可绑定 `[version]`；不要手写内部 `__SFO_SECRET_...` marker。 秘密直接写
`${SECRET_NAME}`，必须在 cluster.yaml 声明类型和目标机器：

```yaml
database:
  password: ${DB_PASSWORD}
api:
  retry_limit: ${API_RETRY_LIMIT}
tls:
  key: ${HTTPS_PRIVATE_KEY}
```

value 秘密整值按声明的 string/boolean/integer/number 类型注入。只有 string 类型可嵌入字符串；
boolean/integer/number 必须独占完整值，否则拒绝生成配置。 file 秘密注入 secrets-deploy
后的稳定文件路径。非法占位符、缺少声明、放置不符或类型不匹配都会失败。 不支持的文本格式可由 configs
脚本处理，不使用已移除的 updater 或 templates 字段。

### 服务管理与部署身份

service 管理器的 name 必须是合法的 `.service` 名称。tool 为 auto/systemctl/service；auto 依次探测
systemctl、service，显式工具缺失即失败。省略 unit_config 时控制既有服务，不改写其运行用户。 声明
unit_config 时生成 root/root/0644 的 unit，必须 daemon_reload: true，tool 不能是 service。 unit
target 缺省 `/etc/systemd/system/<name>`，文件名必须与 name 一致。

unit 的 working_directory 相对 install_directory 解析，也支持三个目录变量；在 unit 中 current 和
latest 都解析为静态 latest 软链路径。command 必须包含 `/`，可以是相对该工作目录的路径或绝对路径；
args 为字面值数组，不是 shell 命令。restart_policy、restart_sec、start_limit_interval_sec 和
start_limit_burst 只影响框架生成的 unit，分别对应 systemd 的崩溃重启和启动频率限制指令。

enabled 缺省 true，systemd 用 enable/disable，SysV 用 chkconfig on/off 收敛开机状态。 on_deploy 可选
none/start/reload/restart，缺省 none；缺省 enabled 不覆盖 on_deploy/on_change。 versioned App 显式
enabled: true 时按原服务状态覆盖为 start/restart。无包 App deploy 走 configure， 按实际配置变化的
on_change 决定服务动作，不能依赖 on_deploy。多个配置变化最多合并一次服务通知， restart 优先于
reload；配置不变不触发 on_change。`--no-activate` 则跳过这些受管服务动作。

脚本管理器必须声明三个单调用对象，不是脚本列表：

```yaml
management:
  kind: script
  start:
    path: scripts/start.ts
    permissions: { run: [/usr/bin/systemctl], net: [] }
  stop:
    path: scripts/stop.ts
    permissions: { run: [/usr/bin/systemctl], net: [] }
  restart:
    path: scripts/restart.ts
    permissions: { run: [/usr/bin/systemctl], net: [] }
```

相应脚本须真实存在并实现需要的动作；versioned 普通 deploy 在 activate 后执行脚本 restart。 同一个
App 最多一个管理器，不能同时声明 service 和 script。

部署、解包、发布树与 App 脚本统一使用机器 SSH 身份，不支持 run_as/access_group，也没有 App
requires_privilege 开关。root SSH 会以 root 运行脚本；非 root SSH 只在框架系统原语上使用非交互
sudo， 配置脚本不自动获得 root。生成的 unit 可用非 root `unit_config.user` 指定服务账号，缺省取 SSH
用户； root SSH 时必须显式给出存在的非 root
服务账号，否则准备阶段失败。服务账号还需能读取配置、穿越发布根。

versioned 根级 mode 为三或四位八进制字符串，拒绝特殊权限位。声明后收敛发布根和版本树：普通文件按
声明值，目录与已有可执行文件按 `X` 语义补执行位；如 `"0644"` 得到普通文件 0644、目录 0755。
未声明时发布根保持 0750，不递归改权限。给其他服务账号开放权限前，应确认包中不含应保持私有的内容。

## 7. 脚本元数据与秘密 loader

每个脚本自包含，不导入本机 sfo-deploy 源码或任意兄弟模块。框架通过 `DEPLOYMENT_METADATA_PATH` 提供
mode 0600 的普通 JSON，顶层就是步骤信息，没有额外 context.metadata 包装，也不含秘密值。
需要输入的脚本可内置以下读取函数：

```typescript
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

const metadata = await readMetadata();
const parameters = mapping(metadata.parameters, "parameters");
```

常用字段：

| 字段                                    | 出现条件             | 内容                                                              |
| --------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| `machine`、`kind`、`resource`、`action` | 所有脚本步骤         | 机器、资源种类、资源名及当前动作。                                |
| `parameters`                            | 所有脚本步骤         | 环境合并参数，带包 App 的 version，或无包 App 的空对象。          |
| `install_directory`                     | App 步骤有安装目录时 | 远端安装根；不要假定配置脚本已处于候选版本。                      |
| `package_path`、`package_hash`          | 当前步骤实际交付包时 | 临时包路径及摘要；环境 install 可按需使用，不是配置脚本必有字段。 |

当前 App 没有自定义 deploy；内置 stage/activate 的私有元数据不是扩展 API。顶层 templates 已移除，
不要依赖 metadata.templates 自动上传业务模板；受管文件用 configs.file，脚本需要的普通输入须按
实际交付机制准备。

脚本需要秘密时，使用框架上传的 `./sfo-secret-loader.ts`；不要把它复制到集群或导入本机源码。
仅有秘密可用的步骤才有 loader 和 `DEPLOYMENT_SECRETS_DIR`。下例需要本机声明并已投递的两个秘密：

```typescript
import { loadSecrets } from "./sfo-secret-loader.ts";

const dir = Deno.env.get("DEPLOYMENT_SECRETS_DIR");
if (!dir) throw new Error("DEPLOYMENT_SECRETS_DIR is not set");
const secrets = await loadSecrets({
  dir,
  values: ["DB_PASSWORD"],
  files: ["HTTPS_PRIVATE_KEY"],
});
```

values 返回非空字符串，files 返回当前秘密副本内的受限绝对路径。values/files 是读取过滤器，不是
秘密授权声明；声明与放置只在 cluster.yaml。副本会被清理，不能把其临时路径交给后续常驻服务；
持久配置应使用受管文件中的 file 秘密稳定路径，或由授权脚本明确交付文件。

workspace 始终允许 Deno 读写，额外路径通过 permissions.read/write 授权；默认拒绝网络和 FFI。
permissions.run 只限制允许启动的程序，原生子进程不继承 Deno 文件/网络限制。这不是 OS 级沙箱。
脚本只应请求必要权限，不打印秘密；工作区成功或失败后会清理，恢复失败时可能保留供排障。

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
创建发布记录。环境 `prepare` 需要的下载包和 `rollback` 使用缓存优先策略，缓存缺失时按原 source
下载并回填。 缓存命中不要求制品源在线；为未来缓存缺失时可恢复，仍应保留原制品源。CLI 没有独立
install 命令。

App 可执行包必须是 tar.gz：fetch 与部署准备阶段都会校验 gzip 魔数。首次 SSH 前，框架固定本地缓存的
原始包并生成所有 managed 配置骨架，再把原始包、声明脚本、骨架/绑定和普通文件连同 `manifest.json`
封装成一个确定性外层 tar.gz。原始包在外层包中固定为 `package/app.tar.gz`，字节和摘要不变；其它成员
分别位于 `scripts/`、`configs/`、`files/`。

每个 App 步骤的非秘密输入通过一次外层包上传。目标节点先验证外层长度/SHA-256，再拒绝归档中的链接、
目录、特殊文件、成员集合/顺序不符和越界内容；安全解包后逐项验证 manifest 长度、SHA-256 与期望 mode，
完整通过并写入 ready 标记后才允许 deploy/渲染器消费。相同 workspace 与 bundle digest 可直接复用已
验证内容。执行阶段不会再次调用 package provider。秘密永远不进入部署包、manifest 或控制端骨架；每个
值秘密按配置引用复制到独立 0700 目录（文件 0600）并在调用后清理；文件秘密只暴露 `secrets-deploy`
后的稳定路径。用户配置/服务脚本按第 9 节的机器范围规则获得秘密副本，不能复用已清理的目录。

内置 versioned release 在 stage 建立版本目录并发布配置，在普通 activate 切换版本并按服务策略收敛。
受管配置由框架渲染器注入当前秘密、生成候选并发布，不需要项目提供自定义 deploy 或渲染库。
包必须包含真实启动入口，归档路径、链接和成员类型由框架检查；脚本不负责替代内置安全解包。

旧版本自动清理由用户配置 `~/.sfo-deploy/config.yaml` 的 `keep_versions` 控制（默认 5，范围
1-100）。内置版本部署仅在服务与版本标记提交成功后清理：始终保留当前版本，再按目录修改时间保留
其他较新版本，合计最多 N 个。只识别包含匹配 `VERSION` 普通文件的版本目录，保留 logs 等普通目录。
同版本成功提交也会执行此保留策略；准备失败或补偿路径不清理旧版本。清理失败单独报告，已删除版本不可回滚。

## 9. 配置秘密与显式投递

秘密的唯一声明点是 cluster.yaml.secrets。名称须匹配 `[A-Z][A-Z0-9_]*`，machines 是已声明机器列表
或字符串 `"*"`；引用秘密的配置必须放置在有对应授权的机器上。以下为可选功能片段，主示例不依赖秘密：

```yaml
secrets:
  DB_PASSWORD:
    kind: value
    machines: [app-01]
  API_RETRY_LIMIT:
    kind: value
    type: integer
    machines: [app-01]
  HTTPS_PRIVATE_KEY:
    kind: file
    machines: "*"
```

value 可声明 type:string/boolean/integer/number，缺省 string；file 不接受 type。真实来源放在集群根
未提交的 secrets.yaml，顶层直接映射名称，不加 secrets 包装。下面仍是待替换示例：

```yaml
DB_PASSWORD: "REPLACE_WITH_REAL_SECRET"
API_RETRY_LIMIT: "3"
HTTPS_PRIVATE_KEY: "secret-files/server.key"
```

来源必须恰好覆盖声明：缺失、多余名称、重复键或非字符串都会被拒绝。即使 type 为 integer/boolean，
来源也须为带引号的非空字符串，之后按类型校验。file 来源须是集群内可读文件的相对 POSIX 路径， 禁止
`..`、绝对路径和符号链接逃逸。secrets.yaml 权限必须为 0600，真实私钥和秘密不要提交版本库。 可在项目
`.gitignore` 合并：

```gitignore
**/secrets.yaml
**/secrets/
**/secret-files/
**/.sfo-deploy/
```

先创建真实来源文件并收紧权限，再**显式**投递：

```bash
chmod 600 clusters/production/secrets.yaml
sfo-deploy secrets-deploy --config-root ./clusters --cluster production
```

普通 deploy/prepare 不会自动读取 secrets.yaml 并部署密钥，它们消费远端已投递的秘密。 secrets-deploy
重复执行幂等；--machine 与放置声明相交。`--check` 只读检查目录权限、清单和漂移， `--remove NAME`
显式移除，二者不能并用，且不要求本地 secrets.yaml。安全目录缺省 `~/.sfo-deploy/secrets/`（0700、文件
0600），machines.secrets_dir 可用远端绝对路径或 `~/` 覆盖。 若集群根存在 known_hosts，CLI
使用它；否则要求本地 `~/.ssh/known_hosts` 存在且可读，并包含可信记录。

实际执行的环境 check/install/configure/init/manager 脚本、App 配置脚本和脚本管理器动作可通过 loader
获得本机声明放置的全部秘密。loader 的过滤参数不收窄授权。框架内置部署脚本不是业务秘密消费者；
受管配置渲染器按该配置引用的值秘密取副本，file 引用返回稳定投递路径。秘密不写入部署包和历史骨架。

本地来源错误在 secrets-deploy 连接前拒绝；远端缺失、权限错误和漂移需要连接后检查，不能用 validate 或
plan 通过证明密钥已投递。公共 API 的 ProjectBindings 是显式输入绑定方式，不代表通用 CLI 自动投递。

## 10. 校验和预览计划

先在不建立 SSH 连接的情况下检查整个集群：

```bash
sfo-deploy validate --config-root ./clusters --cluster production
```

`validate` 会装载全部 YAML，检查目录、字段、依赖、App
放置和本地资源路径，成功时输出不含秘密的摘要；加 `--json` 获取结构化结果。

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
和秘密逻辑名称都应在执行前人工核对。详细预览还显示依赖、发布方式、脚本、配置及服务信息；
机器解析请使用 `--json`，不要依赖人类可读输出排版。版本以 app_versions.yaml 为准。

空集群或仅有环境时，validate 可成功，plan 会以退出码 2 报
`The filter selected no deployment targets`，不要为消除该错误伪造 App。validate/plan 不下载制品、
不验证实际服务，也不装载或投递真实秘密。

重点检查：

- 目标机器和 `private`/`public` 地址是否正确；
- 环境依赖已通过 `prepare` 就绪；
- 是否只选择了预期 App 和机器；
- 计划中不应出现秘密值或私钥内容。

## 11. 首次部署、非激活部署与服务操作

以下命令会下载制品或操作远端机器，应在示例已替换、主机指纹及权限已就绪后执行；配置生成和本地
验证本身不包含这些操作。主示例先 fetch，准备 runtime，再部署 backend；需要秘密时先完成第 9 节投递。

```bash
sfo-deploy fetch --config-root ./clusters --cluster production --app backend
sfo-deploy prepare --config-root ./clusters --cluster production --machine app-01 --env runtime
sfo-deploy deploy --config-root ./clusters --cluster production --machine app-01 --app backend
```

prepare 只管理环境；deploy/plan 只处理 App，不执行环境检查或安装，也不接受 --environment 或
--with-dependencies。依赖在装载时校验闭合，真实环境是否就绪需由 prepare 及目标状态确认。

普通带包部署的阶段：

1. 在控制端准备并归档无秘密输入，连接目标后验证部署包；配置脚本（若有）先执行 configure。
2. 各目标 stage 建立版本目录、落地配置/unit，并准备受管服务状态。
3. 所有 stage 成功后依次 activate，切换 latest，并按 service 策略执行动作；script 管理器另有 restart
   步骤。
4. 按执行结果提交版本标记、清理旧版本和备份。失败时尝试恢复受管配置、软链接、标记及服务状态；
   恢复失败会明确报告并可能保留工作区。跨机器不保证事务原子性，也不能撤销脚本的外部副作用。

同版本部署可复用制品目录，但仍处理配置与服务策略；同版本更新直接作用于现有版本目录，不具备
新版本目录隔离。发布版本必须反映真实制品版本。清理失败单独报告，不能把已清理的旧版本视为可恢复。

CLI deploy 会先打印计划并等待 `yes`；拒绝、EOF 或非交互未传 --yes 时按取消处理（130）。自动化部署
应显式传 --yes。缓存缺失在创建 release attempt 和连接远端前失败，需要先 fetch。

### 仅交付、不激活

```bash
sfo-deploy plan --config-root ./clusters --cluster production --app backend --no-activate
sfo-deploy deploy --config-root ./clusters --cluster production --app backend --no-activate
```

plan 只本地预览；实际非激活 deploy 的行为如下：

| App 类型    | 仍执行                                            | 跳过                                            |
| ----------- | ------------------------------------------------- | ----------------------------------------------- |
| versioned   | 配置脚本（若有）、stage、版本目录及配置/unit 落地 | latest 切换、App 版本标记、所有框架受管服务收敛 |
| packageless | 配置脚本和受管文件发布                            | 框架受管服务收敛，配置尚未由服务加载            |

跳过的服务动作包括 daemon-reload、enable、start、reload、restart。配置脚本仍会执行，不能将服务
重启藏在配置脚本里，再假定此选项可阻止它。成功后产物保留在目标机；versioned 后续用普通 deploy
激活。无包 App 若文件已无变化，on_change 不会再次触发服务，应用显式 restart 加载配置。
非激活部署也会留下发布记录；不要把 rollback 当作后续激活命令，或假定回退保留 no-activate 限制。

### 环境与 App 服务筛选

`start`/`stop`/`restart` 默认只处理 App，不检查其环境依赖，单独增加 --with-dependencies 也不会
自动选择环境。只需要应用服务动作时明确指定 App：

```bash
sfo-deploy restart --config-root ./clusters --cluster production --machine app-01 --app backend
```

显式 --environment/--env 才把环境纳入范围。start/restart 还可能选择 App，需结合 --app、--machine 和
--with-dependencies 核对依赖闭包；stop 带环境过滤时只选择环境。筛选器不会自动扩展到缺失的依赖。
如果显式环境参与定向 App 操作且未带 --with-dependencies，依赖可能变成 check-only；新 install/manager
环境不支持 check，应使用 prepare 和明确的环境管理动作。

环境操作示例：

```bash
# 主示例的旧 scripts 环境支持 check；新 install/manager 环境没有独立 check。
sfo-deploy check --config-root ./clusters --cluster production --environment app-01/runtime

# 准备所选范围内全部环境，省略环境筛选时需要确认；非交互需 --yes。
sfo-deploy prepare --config-root ./clusters --cluster production --yes

# 停止显式选择的环境服务（该环境必须声明停止动作/管理器）。
sfo-deploy stop --config-root ./clusters --cluster production --env nginx
```

`--machine`、`--app`、`--environment` 可重复；环境短名匹配所选机器上的同名实例，`机器/环境`
精确选择一个实例。短 depends_on 绑定当前机器，显式 `机器/环境` 才是跨机依赖。check/prepare 不接受
--app；环境依赖未同时选中时计划会失败。

### 并发与失败边界

start/stop/restart/deploy/rollback 进入控制端 release attempt。每个 App/目标键上的受管状态转换
还使用远端 flock 租约，覆盖包、配置、脚本和服务动作；控制端以心跳续租，断连或孤儿进程会在有界 TTL
内释放。租约丢失后后续受保护操作失败关闭，仅内部清理使用无守卫命令。框架不会自动重试有副作用动作。

## 12. 发布历史与回退边界

start/stop/restart/deploy/rollback 在集群 `.sfo-deploy/releases/` 下记录执行。成功的 deploy/rollback
记录可作为回退来源；其他生命周期记录供审计，不提供回退计划。选择已确认的 release_id：

```bash
sfo-deploy history --config-root ./clusters --cluster production
sfo-deploy history --config-root ./clusters --cluster production --release-id <release_id>
sfo-deploy rollback --config-root ./clusters --cluster production --release-id <release_id>
```

回退重放归档步骤，当前版本化计划可包含 configure、stage、activate 和脚本管理器 restart；无包 App
回放配置步骤。旧快照可能包含传递环境依赖 check，但不回放环境 install/configure。回退不撤销数据库
迁移、消息发送或外部服务写入，也不是切回任意远端目录的快捷命令。

使用缓存中匹配哈希的包；缓存缺失时需要原源仍可访问。历史只归档无秘密配置输入，回放时读取目标机
当前投递的秘密，不恢复旧密码。回退也不是对 no-activate 的继承承诺，执行前应检查归档计划与当前状态。

旧 Python 运行时、含 run_as/access_group 的历史和早期单步 versioned deploy 计划有兼容限制，当前
执行器会拒绝不安全回放；不要把新配置装载成功当成旧历史一定可回放。旧三阶段 versioned 计划可能被
归一化，但不是通用迁移机制。仍导入 ./sfo_deploy.ts 的脚本应改为自包含程序，框架不上传兼容 shim。

受管文件候选/validator 失败时不替换最终配置；发布后服务失败会尝试恢复配置与 enabled/active 状态。
补偿失败须人工处理实际状态，脚本写入外部系统的内容无法自动恢复。`.sfo-deploy/releases/` 不自动清理，
需纳入容量监控、备份和恢复方案。

## 13. 常见错误

### YAML 校验失败

- cluster 使用 schema 2，其余配置使用 schema 1；旧 App schema 2/3/4 不兼容。
- App/环境的 name 与目录名及放置键一致，目标机器存在、非空且无重复。
- app_versions 只覆盖带包 App；无包 App 不能有版本记录，但仍需要版本文件。
- 删除未知字段；App 不使用顶层 scripts/templates/secret_values/secret_files。
- 所有声明的脚本、source 和 SSH 私钥必须真实存在且不逃逸所属目录。
- 摘要占位符必须替换，不能以随机哈希绕过校验；deployer_version 必须与工具精确匹配。

### 缺少 private/public IP 或依赖被过滤

同 region 默认 private，跨 region 默认 public，不自动跨类别回退。可用 --executor-region 或
--address-kind 显式选择。地址列表还需逐一具备可信主机密钥记录。

环境筛选不会自动扩大依赖闭包，把必要环境一并选中。App 默认服务动作不含环境，deploy/plan 更不会
准备依赖；先运行 prepare。新 install/manager 环境没有 check，不能把它当旧脚本环境发起检查。

### 秘密缺失或未绑定

核对 cluster.yaml 的声明、kind/type、放置和实际引用。需要投递时先准备完整的本地 secrets.yaml，
再显式 secrets-deploy；deploy 不会替你执行这一步。远端缺失或权限错误在连接后发现，可先用
secrets-deploy --check 检查。不要在 App/环境内恢复已删除的秘密声明字段。

### 下载失败或哈希不匹配

检查 URL/filehub target、认证和可信发布摘要；不要把失败输出中的未知摘要直接写入配置。 缓存缺失时先
fetch；损坏缓存按错误提示处理后重新获取。为回退保留稳定制品源。

### 脚本失败、服务未启动或未加载配置

检查失败步骤、固定错误类别及清理/恢复结果。配置脚本必须检查每个子进程退出状态，不能只 await output
后忽略失败。unit 的非 root 用户必须存在，启动文件、配置、目录权限与服务工具需在目标机确认。

无包 App 的 on_deploy 不负责触发 configure 服务动作；用文件 on_change，或显式服务命令。
--no-activate 成功只代表产物落地，不代表服务已加载；文件未变时再次普通 deploy 未必触发
reload/restart。

退出码：成功 0、用法/配置错误 2、预检失败 3、下载或远端执行失败 4、取消 130。CLI 会脱敏已知秘密，
无法安全脱敏时丢弃输出；脚本仍不应主动打印秘密。补偿失败后应按实际远端状态处理，不盲目重试。

## 14. 上线前检查清单

- [ ] 所有示例域名、IP、URL、哈希、用户和目标路径已替换。
- [ ] SSH 私钥和项目秘密未提交到版本库。
- [ ] `cluster.yaml` v2 的 Environment/App 映射与定义目录完整闭合，所有目标机器均已声明且无重复。
- [ ] 同一 Environment 的所有目标机器可共用完全相同的参数和资源；需要机器差异的配置已拆成不同名称。
- [ ] 每台机器可通过所选地址和 SSH 用户访问，主机指纹已可信登记，并已安装配置的 Deno 2。
- [ ] 每个 TypeScript 脚本只声明实际需要的绝对 `run` 路径和精确 `net` 目标；无直接网络需求时 `net`
      为空。
- [ ] 需要提权的环境或文件秘密目标可使用 root 或非交互 `sudo -n`。
- [ ] 环境安装/init 可重复执行；旧 scripts 的 check（若声明）能准确判断状态，新生命周期不声明
      check。
- [ ] App 脚本不依赖未声明的 root 权限。
- [ ] App schema 1 使用 configs 和单个 management，无旧 scripts/hook；无管理器配置的 on_change 为
      none。
- [ ] 确认部署使用的 SSH 用户就是期望的发布树属主；root SSH 时确认接受 App 脚本以 root 运行。
- [ ] versioned App 的根级 `mode`（若声明）只开放实际需要的读/穿越范围，且目录可达；未声明时确认为
      0750 默认行为。
- [ ] 生成的 unit 服务用户为非 root；root SSH 时显式声明存在的非 root
      unit_config.user，并确认可读配置。
- [ ] managed 配置中的 `${SECRET_NAME}` 均已声明并放置到目标机器；普通变量 marker
      各出现且只出现一次。
- [ ] file 秘密稳定路径对 SSH 部署身份可读，证书/密钥轮换的服务动作策略已确认。
- [ ] systemd unit、enabled/on_deploy/on_change 与预期动作一致，远端可 root 或 `sudo -n`。
- [ ] 包来源稳定，哈希来自可信渠道；filehub 客户端已完成认证。
- [ ] 目标 App 的安装包已通过 `sfo-deploy fetch` 进入本地 `packages_dir` 缓存。
- [ ] `validate` 成功，`plan` 中的机器、地址、步骤顺序和选择范围已人工复核。
- [ ] 首次生产执行使用动作支持的明确筛选器；deploy 不传环境筛选，环境先通过 prepare 准备。
- [ ] 使用 --no-activate 时已确认配置脚本副作用，并安排实际激活及服务加载。
- [ ] 数据库、消息、外部 API 等不可自动回退的脚本副作用有独立恢复方案。
- [ ] `.sfo-deploy/releases/` 已纳入容量监控和备份。
