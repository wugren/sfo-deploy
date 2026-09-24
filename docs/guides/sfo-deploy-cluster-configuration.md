# sfo-deploy 集群配置与使用指南

本文承接 README 的安装和 `sfo-deploy-cluster` skill 入口，说明项目绑定、集群配置、生命周期、
受管配置、秘密边界和常用使用命令。安装要求与 skill 安装提示词见根目录 [README.md](../../README.md)。

## 安装

控制端需要 Deno 2，以及 OpenSSH 的 `ssh` 和 `scp`。若配置使用 `filehub` 包来源，还需要已登录
或已配置凭据的 `filehub` 客户端。在本仓库根目录执行：

```bash
deno install --global --force --name sfo-deploy --allow-read --allow-write --allow-env --allow-net --allow-run=ssh,scp,filehub,ps ./src/cli.ts
sfo-deploy --help
```

正式环境应固定到已审核的 tag，不要从变化中的分支安装：

```bash
deno install --global --force --name sfo-deploy --allow-read --allow-write --allow-env --allow-net --allow-run=ssh,scp,filehub,ps https://gitlab.mynode.site:8443/wugren/sfo-deploy/-/raw/v0.1.0/src/cli.ts
```

升级时替换 URL 中的版本并重新执行带 `--force` 的命令；卸载使用
`deno uninstall --global sfo-deploy`。命令不可用时，把 Deno 的安装 `bin` 目录加入 `PATH`。

## 选择集群

通用 CLI 省略 `--config-root` 时，按固定顺序查找当前目录下的 `./<集群名>` 和
`./clusters/<集群名>`。显式传入 `--config-root` 时不做当前目录发现，只在该
根目录下查找集群。项目通过 `createCli()` 固定配置根创建的命令不接受 `--config-root`。

## 项目绑定

```typescript
import { createCli, ProjectBindings } from "../../src/mod.ts";

const cli = createCli({
  configRoot: new URL("./clusters/", import.meta.url),
  bindings: new ProjectBindings({
    fileSecrets: {
      HTTPS_PRIVATE_KEY: new URL("./secrets/server.key", import.meta.url),
    },
    configSecrets: {
      DB_PASSWORD: () => obtainPassword(),
    },
  }),
});

if (import.meta.main) Deno.exitCode = await cli(Deno.args);
```

项目可用自己的 Deno task，或用 `deno install --global --name project-deploy ... ./project/cli.ts`
安装这个入口。 `createCli()` 在创建时把 `configRoot` 解析为绝对路径；项目命令不接受
`--config-root`，也不依赖 调用时的当前工作目录。固定版本消费者应把导入地址换成同一 tag 下的
`src/mod.ts` URL。

## 集群模型

```text
clusters/production/
├── cluster.yaml
├── machines.yaml
├── app_versions.yaml
├── known_hosts                   # 可选：优先于 ~/.ssh/known_hosts
├── secrets.yaml                  # 本地真实秘密来源，不要提交
├── environments/
│   └── runtime/
│       ├── environment.yaml
│       └── scripts/
│           ├── check.ts
│           ├── install.ts
│           └── configure.ts      # 可选
└── apps/
    └── backend/
        ├── app.yaml
        ├── templates/
        │   └── application.ini.tpl
        └── scripts/
            └── configure.ts      # 仅 configs.kind: script 使用
```

所有 YAML 严格装载：重复键、未知字段、缺少必填字段、非法路径或不闭合引用在 SSH 前失败。目录名、
定义名和放置键必须一致。

### cluster.yaml

```yaml
schema_version: 2
name: production
executor_region: cn-east
deployer_version: "0.1.0" # 可选
environments:
  runtime: [app-01]
apps:
  backend: [app-01]
secrets:
  DB_PASSWORD:
    kind: value
    machines: [app-01]
```

- `cluster.yaml.environments` 和 `cluster.yaml.apps` 是定义名到目标机器列表的完整映射；定义集合
  与映射必须完整一致。
- 每个映射目标至少一台机器，目标不能为空、不能重复，机器必须存在于 `machines.yaml`。
- `deployer_version` 是可选精确版本门禁：声明后必须与 `deno.json` 的 `version` 完全一致 （不做
  trim）；不一致时在 SSH 前拒绝 validate/plan/deploy/check/prepare/start/stop/restart。
  `history`、`rollback`、`fetch`、`install-deno` 和 `secrets-deploy` 不受该门禁约束。
- `secrets` 是唯一秘密声明点；未声明或未放置到目标机的秘密不会被投递。

旧 `cluster.yaml schema_version: 1` 与 `environments/<机器名>/<环境名>/` 每机布局已移除。框架
不再读取 v1；升级时应手工合并同名共享定义、移动完整资源目录并重建 v2 映射，不能只把版本号改为
`2`，也不能依赖框架自动迁移。旧 v2 目录无法回退运行旧每机布局；保留旧配置需另存迁移前备份。

### machines.yaml

```yaml
schema_version: 1
machines:
  - name: app-01
    region: cn-east
    private_ip: [10.0.0.10, 10.0.0.11]
    public_ip: [203.0.113.10, 203.0.113.11]
    ssh_user: deploy
    ssh_port: 22
    # ssh_private_key: secrets/id_ed25519
    deno: /usr/local/bin/deno
```

`private_ip` 和 `public_ip` 均可用单个 IP 或按优先级排列的非空列表。同区默认 private，跨区默认
public；`--executor-region` 和 `--address-kind private|public` 可覆盖。SSH 只在选定类别内按声明
顺序尝试，不会跨类别回退。`domains` 是描述信息，不参与 SSH 地址选择。

`ssh_private_key` 必须是集群目录内可读普通文件的相对路径；省略时沿用 OpenSSH 默认身份选择。
不要提交真实私钥。SSH 主机密钥严格校验：优先使用集群根 `known_hosts`，否则要求本地
`~/.ssh/known_hosts` 是可读普通文件；仅有系统全局记录不足。未知主机密钥失败关闭。

远端需要 Deno 2；`machines[].deno` 可写裸命令 `deno` 或规范绝对 POSIX 路径，不能带参数。
`install-deno` 可在不要求预装 Deno 的目标机上通过纯 SSH 引导安装。

### Environment

Environment 定义放在 `environments/<名称>/environment.yaml`，schema 1 必需 `name` 和字符串
`version`。生命周期在旧顶层 `scripts` 与新顶层 `install`（可选 `manager`/`init`）之间二选一。 可选
`parameters`、`defaults`、`depends_on`、`requires_privilege` 和 `package`。同一共享定义对
全部放置机器使用相同 version、参数、脚本和资源；没有逐机器 overrides，需要差异时创建不同名称的
Environment。

旧脚本生命周期按动作声明有序调用列表：

```yaml
schema_version: 1
name: runtime
version: "1.0"
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

`prepare` 先执行 `check`；通过且版本标记相同时整体跳过。未通过时执行 `install`，声明 `configure`
则继续执行。首次安装后自动执行已声明的 `start`，版本更新后自动执行已声明的
`restart`。未声明的动作不生成步骤。显式 `start`/`stop`/`restart` 需要对应脚本。

新生命周期推荐使用顶层 `install` 与可选 `manager`：

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

- `install.kind: package` 用 `apt-get` 或 `yum`。`auto` 按 `apt-get` → `yum` 探测；缺失包才安装，
  `update_cache: true` 只在需要安装时刷新索引。
- `install.kind: script` 使用单个 `{path, permissions}` 对象。
- `manager.kind: system` 的 `auto` 按 `systemctl` → `service` 探测；显式工具缺失即失败。 `enabled`
  缺省开启开机启动，显式 `false` 关闭；`start_after_install: false` 时 `prepare` 只执行独立 `enable`
  步骤。
- `manager.kind: script` 必须声明 `start`、`stop`、`restart` 三个单调用对象。
- `manager` 可缺省，表示只安装依赖，不管理应用运行。
- 新契约不声明 `check`；即使版本标记相同，`prepare` 也总是执行幂等 install/init。首次无版本标记 选择
  `start`，已有标记选择 `restart`。
- 可选 `init.before_start`/`init.after_start` 是 Deno 脚本列表；执行顺序为 install → before_start →
  start/restart（或仅 enable）→ after_start。任一 init 失败不写环境版本标记。显式
  `start`/`stop`/`restart` 不执行 init。

环境版本标记在目标机 `~/.sfo-deploy/environments/<环境名>.version`。任何步骤失败、阻断或取消都不
更新标记。环境版本是配方版本，不代表系统包管理器锁定某个上游软件版本。环境应用安装/配置默认不进入
release 发布快照，也不能用 `rollback` 回放。

### App 和版本

带包 App 的稳定结构在 `apps/<名称>/app.yaml`，每次发版变化的版本与包来源在集群根
`app_versions.yaml`：

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
        value: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

URL 和摘要必须来自可信制品；不要用全零或随机摘要通过校验。内置 filehub 使用规范四段
`source.target: SERVER/PROJECT/VERSION/NAME`，凭据由 filehub 客户端配置，不写入 YAML。其他 provider
必须核对实际注册实现；不要假设支持 local/file。App 包必须是 gzip tar 包；`fetch` 与部署 准备都校验
gzip 魔数。filehub 已校验内容后，sfo-deploy 仍要求并再次校验哈希。

带包 App 自动使用 `deployment.kind: versioned`；App schema 1 不提供自定义 `scripts.deploy`。
无包配置 App 用 `packageless: true`，不声明 `deployment` 或 `mode`，且不能有版本记录。即使全部 App
均无包，仍需包含 `schema_version: 1` 和 `apps: {}` 的 `app_versions.yaml`。

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

- `configs` 是有序条目列表，可混用 `kind: file` 和 `kind: script`。两类条目均不声明 `name`； file
  的远端目标唯一，script 的脚本路径唯一。
- `format` 支持 `yaml`、`json`、`toml`、`ini` 和 `nginx`。结构化源配置必须能解析；`nginx` 按 UTF-8
  原文发布，不解析 DSL，不支持变量或秘密占位符，语法由外部 validator 或 `nginx -t` 检查。
- `mode` 是三或四位八进制字符串，必须允许 owner 读取，禁止执行位和 group/other 写权限。
  `owner`/`group` 可选；`on_change` 为 none/reload/restart，后两者必须有 service 管理器。
- `validator.argv` 是固定 argv，首项为绝对可执行路径，且必须恰有一个独立 `{candidate}` 参数。
- `configs.kind: script` 使用现有 App 内 `.ts` 文件和权限声明，必须幂等；非零退出使当前步骤失败。
  versioned App 的配置脚本在 stage 前的 configure 运行，不能假定新包已经展开。
- `management` 只能有一个 service 或 script 管理器。script 管理器必须提供 start/stop/restart
  三个单调用对象。
- service `tool` 依次支持 `auto|systemctl|service`；显式工具缺失即失败。声明 `unit_config` 时生成
  root/root/0644 的 unit，必须 `daemon_reload: true`，且 `tool` 不能是 `service`。
- `enabled` 缺省 true（开机启动），显式 false 关闭；缺省 enabled 不覆盖 `on_deploy`/`on_change`。
  versioned App 显式 enabled true 时按原服务状态覆盖为 start/restart。
- `on_deploy` 可选 none/start/reload/restart，缺省 none。配置变化合并为至多一次服务动作， restart
  优先于 reload。
- `unit_config.user` 指定服务账号，缺省取 SSH 用户；root SSH 且未声明时准备失败。服务账号必须是
  存在的非 root 账号并能读取配置和发布根。
- `restart_policy`、`restart_sec`、`start_limit_interval_sec` 和 `start_limit_burst` 只影响框架
  生成的 unit，分别映射为 systemd 的对应指令；未声明时不写入新指令。

versioned App 根级可选 `mode` 在提交候选版本前收敛发布根和版本树：普通文件按声明值，目录和已有
可执行文件按 `X` 语义补执行位。例如 `"0644"` 得到普通文件 0644、目录 0755。未声明时发布根保持
0750。App 不支持 `run_as`/`access_group`；部署、解包、内置发布和 App 脚本统一以 SSH 登录身份执行，
非 root SSH 只在框架系统原语上使用非交互 `sudo -n`。

#### 配置路径和占位符

file 配置的 `target` 是规范远端绝对路径，或以下变量加相对路径：

| 变量                           | 含义                                  |
| ------------------------------ | ------------------------------------- |
| `${INSTALL_DIRECTORY}`         | 安装根，不自动重定位到版本目录        |
| `${CURRENT_VERSION_DIRECTORY}` | 当前动作的版本目录；deploy 为候选版本 |
| `${LATEST_DIRECTORY}`          | `<install_directory>/latest`          |

目录变量只能在开头，不能包含 `..`，使用变量必须声明 `install_directory`。旧绝对
`<install_directory>/latest/` 前缀会重定位；其他绝对路径保持原位置。框架校验 canonical path、
越界和符号链接逃逸。

`${APP_VERSION}` 是当前 versioned App 部署版本的字符串占位符，可用于 managed config
`target`、service `unit_config.working_directory` 和 structured managed config 内容。structured
内容只支持 yaml/json/toml/ini；`nginx`、无包 App 和 Environment 配置不支持它。若集群已声明名为
`APP_VERSION` 的秘密，内容中的占位符继续按秘密引用处理。

普通变量使用 `__SFO_CONFIG_VAR_V1_<NAME>__`，独占完整值，并用 `variables.path` 从步骤参数绑定。
秘密直接写 `${SECRET_NAME}`，必须在 `cluster.yaml.secrets` 声明类型并放置到目标机器。value
秘密可声明 `type: string|boolean|integer|number`；boolean/integer/number 必须独占完整值，string
可嵌入字符串。file 秘密注入投递后的稳定文件路径。非法占位符、缺少声明、放置不符或类型不匹配都失败。

#### 本地包缓存

```bash
sfo-deploy fetch --cluster production --app backend
```

`fetch` 缺省下载全部带包 App；`--app` 可重复。包按 provider 与算法-哈希内容寻址存放在
`~/.sfo-deploy/packages/`。用户级配置 `~/.sfo-deploy/config.yaml` 可设置：

```yaml
schema_version: 1
packages_dir: /data/sfo-deploy/packages
keep_versions: 5
```

`keep_versions` 默认 5，范围 1-100。服务与版本标记提交成功后始终保留当前版本，再按目录修改时间
保留较新版本。清理失败单独报告；已清理版本不可回滚。`deploy` 只从缓存取包；缺失时在任何 SSH 连接
前失败（退出码 3）并要求先 `fetch`。`rollback` 等动作缓存优先，缺失时按原 source 下载并回填。

### 敏感数据边界

`cluster.yaml.secrets` 只声明名称、类型和放置；真实来源是集群根未提交的 `secrets.yaml`，顶层直接
映射秘密名：

```yaml
DB_PASSWORD: "REPLACE_WITH_REAL_SECRET"
API_RETRY_LIMIT: "3"
HTTPS_PRIVATE_KEY: "secret-files/server.key"
```

- 来源必须恰好覆盖全部声明：缺失、多余、重复键或非字符串都拒绝；即使 type 是 boolean/integer/
  number，也必须写成带引号的非空字符串。
- file 来源必须是集群目录内可读文件的相对 POSIX 路径，禁止 `..`、绝对路径和符号链接逃逸。
- `secrets.yaml` 权限必须是 0600；真实私钥和秘密不要提交。
- `secrets-deploy` 幂等投递到安全目录（默认 `~/.sfo-deploy/secrets/`，目录 0700、文件 0600），
  并维护只含名称/类型/hash 的清单。`--check` 只读检查漂移；`--remove NAME` 显式移除；二者不能并用。
- 不传 `--machine` 时覆盖全部声明机器并请求确认；非交互需要 `--yes`。
- 框架不提供密码保险库、加密存储、生成或轮换；`deploy`/`prepare` 不自动读取 `secrets.yaml`。

执行带秘密的脚本步骤时，框架复制本机已声明放置秘密的机器范围副本到 0700 workspace，注入
`DEPLOYMENT_SECRETS_DIR`。脚本使用框架上传的 `sfo-secret-loader.ts`：

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

`values` 返回非空字符串；`files` 返回当前步骤秘密副本内的受限绝对路径。过滤参数不收窄声明授权。
副本调用结束即清理；不能把该路径交给常驻服务。持久配置应使用受管文件中的 file 秘密稳定路径，或由
授权脚本显式交付。秘密不进入环境变量、argv、部署包、历史骨架或长期进程。

非秘密脚本元数据由 `DEPLOYMENT_METADATA_PATH` 指向的 0600 JSON 提供，顶层包含 `machine`、`kind`、
`resource`、`action` 和 `parameters`；App 步骤有安装目录时包含 `install_directory`，实际交付包的
步骤包含 `package_path` 和 `package_hash`。纯动作脚本可以完全忽略这两个变量。

### 生命周期脚本

脚本必须是所属资源目录内已存在的 `.ts` 文件，且是自包含普通 TypeScript 程序；除框架上传的受限 loader
外，不导入 sfo-deploy 源码或任意兄弟模块。框架不会上传或执行旧 `sfo_deploy.ts` 辅助文件。

`permissions.run` 每项是规范绝对 POSIX 可执行路径；空列表表示不能直接启动子进程。
`permissions.read`/`permissions.write` 扩展 Deno 直接读写路径，workspace 始终授权，只读路径不能
写入或删除。`permissions.net` 默认空，只接受无 scheme、凭据、路径或通配符的主机/IP，可附带端口。
子进程不继承 Deno 文件/网络限制；为 apt-get 等子进程联网不需要 Deno `net`。Deno 授权按路径前缀
展开，且不是 OS 级沙箱；只声明实际需要的能力。

### 部署包和发布树

部署准备阶段从本地缓存固定原始 `tar.gz`，并将声明脚本、无秘密配置骨架、绑定清单和普通文件封装为
单一外层 `tar.gz`。节点校验外层摘要、成员集合、类型、长度和逐项 SHA-256，安全解包并写入 ready
标记后才消费。带包 managed App 的内层包还会做路径、类型、重复、成员数和展开大小验证。秘密不在
manifest 或包内。

versioned 发布树位于 `<install_directory>/<version>/`，`latest` 是当前版本选择器。内置 versioned
release 先完成配置和服务准备，再原子切换 `latest` 并立即启动/重启，成功后写
`.<app>.version`。候选配置和 validator 失败不替换最终配置；服务收敛失败尝试恢复本次发布配置及 操作前
enabled/active 状态，恢复不完整明确报告 partial/recovery。

## 常用命令

先在本地校验配置并预览部署；`plan` 不建立 SSH 连接、不下载包、不解析秘密值：

```bash
sfo-deploy validate --cluster production
sfo-deploy plan --cluster production --app backend
```

App 更新使用 `deploy`；环境应用安装、配置和更新使用 `prepare`：

```bash
sfo-deploy fetch --cluster production --app backend
sfo-deploy prepare --cluster production --env runtime
sfo-deploy deploy --cluster production --app backend
```

`deploy` 会请求二次确认；非交互环境显式传 `--yes`。只交付不激活时使用：

```bash
sfo-deploy plan --cluster production --app backend --no-activate
sfo-deploy deploy --cluster production --app backend --no-activate
```

检查和生命周期控制：

```bash
sfo-deploy check --cluster production
sfo-deploy start --cluster production --app backend
sfo-deploy stop --cluster production --app backend
sfo-deploy restart --cluster production --app backend
```

`start`、`stop` 和 `restart` 默认只处理 App。需要纳入环境时显式添加 `--environment [机器/]名称` 或
`--env [机器/]名称`。

远端 Deno 运行时缺失或需要固定版本时，可通过 SSH 引导安装：

```bash
sfo-deploy install-deno --cluster production
sfo-deploy install-deno --cluster production --machine app-01 --yes
sfo-deploy install-deno --cluster production --deno-version 2.2.11 --install-to /usr/local
```

声明式秘密使用专用命令投递、检查或移除；真实值由集群目录内未提交的 `secrets.yaml` 提供：

```bash
sfo-deploy secrets-deploy --cluster production --machine app-01
sfo-deploy secrets-deploy --cluster production --check
sfo-deploy secrets-deploy --cluster production --machine app-01 --remove DB_PASSWORD
```

发布历史与回退：

```bash
sfo-deploy history --cluster production
sfo-deploy history --cluster production --release-id <release_id>
sfo-deploy rollback --cluster production --release-id <release_id>
```

通用筛选器包括 `--machine`、`--app`、`--environment`/`--env`、`--executor-region` 和
`--address-kind private|public`。只有动作帮助中列出的筛选器可用于该动作；历史和回退不能与范围
筛选器混用。默认按步骤输出英文人可读进度，需要机器可解析结果时加 `--json`。固定退出码为：成功
`0`，用法/配置错误 `2`，预检失败 `3`，下载/远端执行失败 `4`，用户取消 `130`。

动作的精确参数和行为边界以 `sfo-deploy <action> --help` 为准。
