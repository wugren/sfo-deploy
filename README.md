# sfo-deploy

一个供项目部署模块复用的 Deno 2 / TypeScript SSH 集群部署框架。控制端、公共 API
和远端生命周期脚本都使用 TypeScript；每个集群是独立目录。当前 cluster schema v2 在
`environments/<环境名>/` 集中定义环境，并在 `cluster.yaml.environments` 声明目标机器；App schema v4
可选择内置版本化发布、配置文件和 systemd 服务管理，旧 v2/v3 App 继续按原脚本执行。

从零创建集群配置、编写生命周期脚本并完成首次部署，请参阅[使用 sfo-deploy 配置集群](docs/guides/sfo-deploy-cluster-configuration.md)。

## 安装命令

先安装 Deno 2，并确认本机已有 OpenSSH 的 `ssh`、`scp`；如果配置使用 `filehub`
provider，还要先安装并配置 `filehub`。在本仓库根目录执行：

```bash
deno install --global --force --name sfo-deploy --allow-read --allow-write --allow-env --allow-net --allow-run=ssh,scp,filehub ./src/cli.ts
sfo-deploy --help
```

这是通用 CLI
的最小权限类别：读取集群、密钥和快照，写入临时文件与发布历史，读取项目绑定所需环境变量，通过
HTTP/HTTPS 下载制品，并且只启动 `ssh`、`scp` 和可选的 `filehub`。它不使用
`--allow-all`；对固定项目还可以把 read、write、env 和 net
进一步限制为已知路径、变量和下载主机。即使不使用 filehub，保留 `filehub` 的 run
授权也不会安装该程序；若要收紧权限可从命令中移除它。

Deno 默认把命令安装到 `$DENO_INSTALL_ROOT/bin`；未设置该变量时通常是 `$HOME/.deno/bin`（Windows 为
`%USERPROFILE%\.deno\bin`）。如果安装成功但 shell 找不到 `sfo-deploy`，把对应 `bin` 目录加入 `PATH`
后重新打开终端。

正式环境应固定到已审核的 tag，不要从会变化的分支安装。仓库发布 `v0.1.0` tag 后，对应命令为：

```bash
deno install --global --force --name sfo-deploy --allow-read --allow-write --allow-env --allow-net --allow-run=ssh,scp,filehub https://gitlab.mynode.site:8443/wugren/sfo-deploy/-/raw/v0.1.0/src/cli.ts
```

升级时把 URL 中的 tag 换成目标固定版本并重新执行同一条带 `--force` 的命令；卸载使用
`deno uninstall --global sfo-deploy`。本仓库目前没有声称已发布到 JSR、npm
或其他注册表；上面的本地路径安装可直接用于检出代码，tag URL 只在相应 tag 已推送且当前网络可访问该
GitLab 后可用。

## 集群布局

```text
clusters/production/
├── cluster.yaml
├── machines.yaml
├── app_versions.yaml
├── environments/
│   └── postgresql/
│       ├── environment.yaml
│       └── scripts/
│           ├── check.ts
│           ├── install.ts
│           └── configure.ts   # 可选
└── apps/
    └── backend/
        ├── app.yaml
        ├── templates/
        │   └── application.ini.tpl
        └── scripts/
            └── deploy.ts
```

同区机器默认通过内网 IP 连接，跨区机器默认使用公网 IP。所有配置在首次 SSH 连接前完成严格校验。

`machines.yaml` 只声明机器身份与连接信息。schema v2 的 Environment 与 App 一样把定义和放置分开：
`environments/<环境名>/environment.yaml` 定义安装和配置方法，`cluster.yaml.environments`
决定哪些机器生成该环境实例。同一个定义对其全部目标机器使用相同的
version、parameters、defaults、脚本和资源； 不支持逐机器 overrides，需要差异时应创建不同名称的
Environment。

旧 `cluster.yaml schema_version: 1` 与 `environments/<机器名>/<环境名>/` 每机环境布局
已移除，框架不再接受 v1 配置；升级到 v2
时，应合并重复定义、移动其完整资源目录并显式填写放置映射。只支持 v2 的版本不能读取
v1；迁移时应恢复一份完整的 v2 `cluster.yaml` 和新目录布局并补齐共享环境定义，不能只把版本号改回
`2`。

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

项目可用自己的 Deno task 或 `deno install --global --name project-deploy ...`
安装这个入口。`createCli()` 接收实际导出的 `ProjectBindings`，并在创建时把 `configRoot`
解析为绝对路径；项目命令因此不接受
`--config-root`，也不依赖调用时的当前工作目录。固定版本消费者应把导入地址换成同一 tag 下的
`src/mod.ts` URL。

## 敏感数据边界

- 密钥值继续由 `ProjectBindings.configSecrets`/`fileSecrets` 在项目侧提供；`cluster.yaml.secrets`
  只声明密钥名称、类型（`value`/`file`）与放置机器（具体列表或通配符 `*`，默认不部署）。
- `sfo-deploy secrets-deploy` 把声明密钥幂等部署到目标机器安全目录（默认 `~/.sfo-deploy/secrets/`，
  目录 0700、文件 0600），并维护只含名称/类型/hash 的校验清单；`--check` 只读校验漂移，`--remove`
  显式移除。
- 执行 app/environment 脚本时，框架在开启秘密交付的步骤（环境 `configure`、App `configure`/`deploy`
  及含 updater/hook 的动作）把本机 `cluster.yaml.secrets` 已声明放置秘密的 机器范围副本放进 0700
  workspace，注入 `DEPLOYMENT_SECRETS_DIR`；脚本用框架随步骤上传的
  `sfo-secret-loader.ts`/`sfo_secret_loader.py`
  按名读取（值密钥返回字符串，文件密钥返回受限绝对路径）， 密钥不进入环境变量、argv 或长期进程。
- 旧 `config_secrets`/`file_secrets` 与 `DEPLOYMENT_CONTEXT_PATH` context JSON 机制已移除；
  非秘密步骤元数据改由 `DEPLOYMENT_METADATA_PATH` 指向的 0600 JSON 提供。
- 框架不提供密码保险库、加密存储、生成或轮换。

## 最小配置示例

`clusters/production/cluster.yaml`：

```yaml
schema_version: 2
name: production
executor_region: cn-east
environments:
  postgresql: [app-01]
apps:
  backend: [app-01]
```

`clusters/production/environments/postgresql/environment.yaml` 只定义一次 PostgreSQL
的版本、参数、依赖、 脚本和资源。映射中的每个 Environment/App
必须有同名定义且至少包含一台已声明机器；定义和映射必须完整闭合，
空列表、重复目标、未知定义或未知机器都会在 SSH 前被拒绝。

`clusters/production/machines.yaml`：

```yaml
schema_version: 1
machines:
  - name: app-01
    region: cn-east
    private_ip: [10.0.0.10, 10.0.0.11]
    public_ip: [203.0.113.10, 203.0.113.11]
    ssh_user: deploy
```

`private_ip` 和 `public_ip` 均可写成单个 IP 或按优先级排列的 IP 列表。规划仍先按区域或
`--address-kind` 选择地址类别，SSH 建连再按该类别的声明顺序尝试；不会在 private/public
之间自动切换。

带制品 App 的每次发版都会变化的安装版本、下载配置（provider/source）与版本 hash 统一放在集群根
`clusters/production/app_versions.yaml`；app.yaml 只声明稳定结构（含必填的远端
`install_directory`）。显式 `packageless: true` 的配置型 App 不需要版本/包和 `app_versions.yaml`
条目。

`clusters/production/app_versions.yaml`：

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

`clusters/production/apps/backend/app.yaml` 使用 schema v3 显式启用内置配置和 systemd 管理：

```yaml
schema_version: 3
name: backend
install_directory: /home/deploy/apps/backend
depends_on: [postgresql]
scripts:
  deploy:
    - path: scripts/deploy.ts
      permissions:
        run: [/usr/bin/install]
        net: []
management:
  run_as: deploy
  configs:
    - name: application
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
  service:
    type: systemd
    unit: backend.service
    enabled: true
    daemon_reload: false
    on_deploy: restart
    timeout_ms: 30000
```

对应 INI 源文件必须已经包含 selector 指向的完整值；普通变量 marker 也必须独占一个值：

```ini
[application]
version = __SFO_CONFIG_VAR_V1_APP_VERSION__

[database]
password = replace-on-target
```

秘密引用直接写在配置值中：

```ini
[database]
password = ${DB_PASSWORD}
```

同一集群根目录的 `cluster.yaml` 用 `secrets:` 显式声明每个密钥的放置目标（值密钥或文件密钥；
具体机器列表或通配符 `*`）；未声明的密钥不会出现在任何节点：

```yaml
secrets:
  DB_PASSWORD:
    kind: value
    machines: [app-01]
    # type 可选；缺省 string。
    # type: integer
  TLS_SERVER_KEY:
    kind: file
    machines: "*"
```

部署密钥时运行 `sfo-deploy secrets-deploy --cluster production --machine app-01`；不传 `--machine`
时覆盖全部声明机器（交互确认）。执行 `prepare`/`deploy` 前密钥必须已经部署到对应节点，
否则脚本步骤在 SSH 连接前失败关闭。

### App v3 内置管理

声明 `management` 时必须同时声明规范的非 root Linux 用户 `run_as`。SSH 用户为 root 时，框架先用固定
`getent passwd`/`id` 参数验证该账号存在且 UID 大于 0，并从 `getent` 取得规范绝对 HOME，再以等价于
`sudo -n -H -u <run_as> -- env HOME=<verified-home> DEPLOYMENT_*=... <command>` 的固定 argv 执行 App
updater、hook 和生命周期脚本。环境变量在降权后注入，绝不继承 root HOME；SSH 用户非 root 时必须与
`run_as` 完全一致，也会显式使用已验证 HOME。验证或降权失败时不会退回 root 执行。systemd 查询和最终
配置发布仍由框架的固定特权原语负责。

`management.configs` 只支持 `format: yaml|json|toml|ini` 的结构化配置。配置值中的 `${SECRET_NAME}`
引用 `cluster.yaml.secrets` 已声明并放置到目标机器的秘密；整值占位符按秘密声明的 `type` 注入， 缺省
`string`。嵌入字符串中的占位符只做字符串替换。`kind: file` 的占位符注入 `secrets-deploy`
后的稳定文件路径。已移除的 `updater` 字段会被定向拒收；自定义文本格式不再是 managed
配置契约的一部分。

控制端解析源配置、用步骤 `parameters` 填充声明的普通变量并写入秘密 marker，生成不含秘密的确定性
骨架。随后它把原始 App `tar.gz`（如有）、本 App 声明脚本、配置骨架、绑定清单和普通文件封装成一个
外层 `tar.gz`：

```text
manifest.json
package/app.tar.gz              # 带包 App 才有，原始字节保持不变
scripts/...
configs/<name>.skeleton
configs/<name>.skeleton.bindings.json
files/...
```

App 的非秘密投递内容通过这个单一部署包上传；节点校验外层摘要、成员集合、类型、长度和逐项 SHA-256，
安全解包并写入 ready 标记后才允许安装。带包 managed App 还会在执行脚本前列举内层 tar.gz，拒绝绝对或
非规范路径、链接/设备等非普通成员、重复成员以及成员数/总展开大小超限，然后解压到 attempt 隔离目录；
脚本从 metadata 的 `package_path` 取得该已验证目录，并用 `package_kind: validated-directory` 区分旧
tar.gz 协议。秘密不在 manifest 或包内；每个 config updater 和每次 lifecycle/hook 调用只复制自己
声明的秘密到全新的 0700 目录（文件 0600），调用结束立即独立清理；文件秘密只向渲染器暴露稳定路径。
框架固定渲染器在节点读取值秘密、生成候选文件；内置结构化渲染器携带 bundle 内的单文件离线 parser，
在禁用 remote/npm 的节点上解析后注入并按 YAML、JSON、TOML 或 INI
完整复解析。所有候选都经过框架守卫和可选 `validator.argv` 后，由框架设置 owner/group/mode
并原子发布。相同内容报告 `unchanged`，不触发
`on_change`；多个配置变更合并为至多一次服务动作，`restart` 优先于 `reload`。

`management.service` 首版只支持 `type: systemd`。框架以固定 argv 和 root/`sudo -n` 执行状态读取、
可选 enable/disable、daemon-reload 以及 start/stop/reload/restart，并在动作后确认状态。显式
`start`、`stop`、`restart` CLI 动作归该声明所有；因此不能再声明同名 App 脚本。类似地，只要
`management.configs` 非空，就不能同时声明 `scripts.configure`。App 特有流程应放在受支持的
`management.hooks`，或让整个旧 App 保持 v2/v3 脚本模式。

旧版 `updater.type: script/template` 已移除。含该字段的配置装载失败；自定义文本格式请迁移到
受支持结构化格式，或在 managed 配置之外使用显式生命周期脚本。

每个目标的 managed configure/deploy/start/stop/restart（以及回退重放）都在同一 App/目标 `flock`
租约内完成；控制端的 configure/start/stop/restart/deploy/rollback 也各自拥有 release attempt。
未取得锁不产生远端副作用，成功、失败、超时和取消都会清理并释放。任一候选生成或验证失败都不会改动最终配置；服务收敛失败时框架尝试恢复本次已发布配置及操作前的
enabled/active 状态。恢复不完整会明确报告 partial/recovery 失败，绝不伪报成功。v2/v3 App 无
`management` 字段时行为不变；迁移时先升到 `schema_version: 3`，删除每个配置的 `updater` 并改为
`format` 与源配置中的 `${SECRET_NAME}`，再逐项把 configure 与 start/stop/restart 所有权移入
management，不能只增加 management 而保留冲突脚本。

### App v4 统一 managed 资源

新 App 推荐使用 schema v4。`management.actions` 用同一个列表声明 `config` 和 `service`
两类资源；`deployment.kind: versioned` 声明内置版本化发布，没有 `scripts.deploy` 的带包 App
自动启用。 v4 不接受 `management.configs`、`management.service` 或 `management.hooks`
旧形状，也不再提供 hook。

```yaml
schema_version: 4
name: backend
install_directory: /home/deploy/apps/backend
deployment:
  kind: versioned
scripts: {}
management:
  run_as: deploy
  actions:
    - kind: config
      name: application
      source: templates/application.ini.tpl
      target: /home/deploy/apps/backend/application.ini
      owner: deploy
      group: deploy
      mode: "0600"
      format: ini
      on_change: restart
    - kind: service
      type: systemd
      unit: backend.service
      enabled: true
      daemon_reload: true
      on_deploy: restart
      unit_config:
        working_directory: current
        command: bin/server
        args: ["--config", "config/application.ini"]
```

`unit_config` 缺省时只控制目标节点已有 unit。声明它时会生成并发布 root/root/0644 的 systemd
unit；`working_directory` 相对 `install_directory` 解析，启动命令相对 working directory 解析为
`ExecStart` 绝对路径，参数保持固定字面值。unit 内容变化会 daemon-reload 后 restart。

映射必须在 app 目录集与 `app_versions.yaml` 之间完整闭合：缺失、多余、未知 App 条目与非法
`install_directory`（非绝对 POSIX 路径或含 `..`）都会在 SSH 前被拒绝。App 不再支持 v1 内联
version/package；必须使用 `app_versions.yaml` 提供版本记录。

### 使用 filehub 下载包

App 或环境的 `package` 可以使用内置 `filehub` provider；`source.target` 按
`SERVER/PROJECT/VERSION/NAME` 格式填写 filehub 目标：

```yaml
package:
  provider: filehub
  source:
    target: SERVER/PROJECT/VERSION/NAME
  hash:
    algorithm: sha256
    value: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

运行 sfo-deploy 前，必须先安装 `filehub` 客户端并完成登录或凭据配置；可使用 filehub
的默认配置，也可通过 `FILEHUB_CONFIG` 等上游支持的环境变量提供配置。 不要在部署 YAML 中加入
token、password 或其他 filehub 凭据字段。

App 部署包必须是 tar.gz 格式的可执行文件包：`fetch` 与部署准备阶段都会校验 gzip 魔数，非 gzip 包在
SSH 前直接失败。如果本机找不到 `filehub` 命令，sfo-deploy 会提示先安装客户端。安装、登录和配置方法见
[filehub 官方说明](https://github.com/wugren/sfo-filehub/blob/main/README.md)。即使 filehub
已经校验下载内容，部署 YAML 仍必须声明 `hash`；sfo-deploy 会再次校验文件大小和该哈希，
校验失败时不会继续部署。

### 本地部署包缓存（fetch）

部署 App 前先用 `fetch` 把安装包下载到部署机本地：

```bash
sfo-deploy fetch --cluster production --app backend
```

缺省下载全部 App 的安装包；`--app` 可重复使用以筛选。包按 provider 与算法-哈希内容寻址存放在
`~/.sfo-deploy/packages/`，本地已有同版本且哈希校验通过的包时输出 `cached` 并跳过远端下载。
目录可通过 `~/.sfo-deploy/config.yaml` 自定义：

```yaml
schema_version: 1
packages_dir: /data/sfo-deploy/packages
keep_versions: 5
```

`keep_versions`（默认 5，合法范围 1-100）控制旧版本自动清理：每次 App 部署成功并写入版本标记后，
目标机按版本字符串保留最新 N 个版本目录，删除更旧的 `<install_directory>/<version>/` 与
`~/.sfo-deploy/apps/<version>/` 安装包；同版本跳过、失败或回滚路径不清理。被清理版本不可回滚，
请按回滚需求调整保留数量。

`deploy` 只从该缓存取包：缺少目标 App 包时在预检期失败（退出码 3）并提示先运行 `fetch`，不会连接
远端或创建发布记录。`install`/`rollback` 等动作同样缓存优先，缓存缺失时仍按原有 source 下载并回填
缓存，回退旧版本的行为与契约不变。

部署准备阶段从本地缓存固定同一个原始 tar.gz，并与声明脚本、无秘密配置骨架及普通文件构建上述单一部署
包；执行期不会再次调用 package provider。目标机验证并安全解开外层包后，managed App 的内层包由框架
先完成路径、类型、重复、成员数和展开大小验证。内置 versioned release 把该目录发布到
`<install_directory>/<version>/`，原子切换 `latest` 并写 `.<app>.version`；自定义 deploy 脚本仍可在
验证目录上执行特殊安装协议；legacy 非-managed App 继续取得原始 tar.gz 并自行复验。

旧脚本模式的顶层 `templates`（app.yaml / environment.yaml 的 `templates:` 字段）已移除：它把额外普通
文件随脚本上传到 configure 步骤。现在模板文件交付统一由每个 `management.configs[].source`
明确源文件与持久目标，不再让自定义 configure 脚本猜测发布位置；配置绑定和渲染由框架的受限 updater
完成。

生命周期脚本是自包含的普通 TypeScript 程序，不导入任何 sfo-deploy
框架源码。框架只投递配置声明的脚本、该步骤需要的普通数据文件，以及框架提供的受限 loader
（`sfo-secret-loader.ts`/`sfo_secret_loader.py`）。密钥只经 `DEPLOYMENT_SECRETS_DIR` 指向的
步骤副本目录读取，非秘密步骤元数据（模板路径、包路径、安装目录、参数等）由
`DEPLOYMENT_METADATA_PATH` 指向的 0600 JSON 提供；纯动作脚本可以完全忽略这两个变量。
例如配置脚本先经 loader 取得密钥，再在步骤工作区渲染模板并通过显式允许的子进程发布：

```typescript
// sfo-secret-loader.ts 由 sfo-deploy 在远端脚本步骤上传到同一 workspace。
import { loadSecrets } from "./sfo-secret-loader.ts";

const secretsDir = Deno.env.get("DEPLOYMENT_SECRETS_DIR");
if (!secretsDir) throw new Error("DEPLOYMENT_SECRETS_DIR is not set");
const secrets = await loadSecrets({
  dir: secretsDir,
  values: ["DB_PASSWORD"],
});
const metadataPath = Deno.env.get("DEPLOYMENT_METADATA_PATH");
if (!metadataPath) throw new Error("DEPLOYMENT_METADATA_PATH is not set");
const metadata = JSON.parse(await Deno.readTextFile(metadataPath)) as Record<string, unknown>;
const password = secrets.values.DB_PASSWORD;
const template = `[application]
listen = 0.0.0.0:8080
password = __SHOULD_BE_REPLACED__`;
const rendered = template.replace(/\$\$|\$\{DB_PASSWORD\}|\$DB_PASSWORD/g, () => password);
await Deno.writeTextFile("application.ini", rendered, { mode: 0o600 });
const result = await new Deno.Command("/usr/bin/install", {
  args: ["-D", "-m", "0600", "application.ini", "/home/deploy/apps/backend/application.ini"],
}).output();
if (!result.success) throw new Error("configuration install failed");
```

上例采用 `$DB_PASSWORD`/`${DB_PASSWORD}` 约定，但该替换逻辑属于脚本而非框架 API。loader 只返回当前
`configure`/App `deploy` 步骤显式声明的密钥；文件密钥以受限绝对路径形式返回，由脚本自行
以只读方式打开。模板本身不是秘密，最终配置路径和权限由项目脚本负责。 框架不会在远端生成、上传或执行
`sfo_deploy.ts`；除受限 loader 外，也不部署其它框架源码。

目标机必须提供 Deno 2；`machines[].deno`
可指定裸命令名或规范绝对路径。每个脚本只获得当前步骤远端资源工作区的直接读写权限，默认拒绝网络、FFI
和未声明的子进程；`permissions.run` 必须列出绝对可执行文件路径，`permissions.net`
只在脚本确实直接联网时列出精确主机及可选端口。白名单子进程以目标机身份运行，不继承 Deno
文件或网络沙箱保证，因此持久目录和系统目录操作必须由运维方审查这些可执行文件及参数。

也可以让 sfo-deploy 自己完成运行时引导：`install-deno` 使用与部署相同的严格 OpenSSH 传输
（known_hosts、私钥、超时校验），通过纯 SSH 直连目标安装 Deno，不要求目标机预装 Deno。 缺省安装 Deno
最新稳定版；已有旧版本时升级。显式 `--deno-version` 仍安装精确版本。 缺省安装到远端
`/usr/local/bin/deno`；因为 `/usr/local` 是非当前用户可写目录，要求远端身份可 root 或
`sudo -n`。安装前会下载 Deno 官方 GitHub Release 压缩包和同名 `.sha256sum`，校验
通过后才解压；安装完成后用 `deno --version` 复验版本。若目标机缺少下载器（curl/wget）或
解压器（unzip/7z），`install-deno` 会尝试用目标机包管理器（apt-get/apk/dnf/yum）提权安装 缺失的 curl
与 unzip 后再安装 Deno；包管理器缺失、提权不可用或安装失败时给出明确提示并 fail-closed。
注意：基础工具来自目标机发行版软件源，Deno 信任边界为“GitHub Release + 官方 .sha256sum”。

## 环境应用部署与更新（prepare）

jre、nginx、mysql、redis 这类由环境承载的应用（环境应用）用专门命令部署/更新：

```bash
sfo-deploy prepare --cluster production --env jre
sfo-deploy prepare --cluster production --env mysql --machine app-01
```

`--env` 与 `--environment` 等价（更短），可重复，也支持 `[机器/]名称` 精确实例；`prepare`
是环境动作，不支持 `--app`。流程为 check → 按需 install；未声明 `configure` 时不再生成该步骤。
首次安装成功后自动执行 `start`，版本更新成功后自动执行 `restart`；同版本且检查通过时整体跳过；
未声明 `start`/`restart` 脚本的环境应用自动跳过对应步骤。框架把 `environment.yaml` 的 `version`
记录到目标机 `~/.sfo-deploy/environments/<环境名>.version` 作为更新标记，失败/阻断不更新。 `deploy`
只处理 App；发布前应先使用 `prepare` 确认依赖环境已就绪。

## 命令行

通用命令的 `--config-root` 可以省略。省略时在当前目录按 `./<集群名>`、`./clusters/<集群名>`
的固定顺序查找第一个存在的集群目录，因此常见布局均可直接输入集群名和部署动作：

```powershell
sfo-deploy validate --cluster production
sfo-deploy configure --cluster production --environment app-01/postgresql
sfo-deploy fetch --cluster production --app backend
sfo-deploy deploy --cluster production --app backend
sfo-deploy check --cluster production
sfo-deploy install --cluster production --yes
sfo-deploy prepare --cluster production --env postgresql
sfo-deploy install-deno --cluster production --yes
sfo-deploy install-deno --cluster production --machine app-01 --install-to /usr/local
```

也可以显式指定配置根目录；显式传入时不做当前目录发现，始终使用该配置根目录下的集群：

```powershell
sfo-deploy validate --config-root .\clusters --cluster production
sfo-deploy plan --config-root .\clusters --cluster production --app backend
sfo-deploy deploy --config-root .\clusters --cluster production --app backend
sfo-deploy check --config-root .\clusters --cluster production --environment app-01/postgresql
sfo-deploy install --config-root .\clusters --cluster production --environment app-01/postgresql
sfo-deploy install --config-root .\clusters --cluster production --yes
```

项目绑定命令固定使用 `createCli()` 创建时解析的绝对配置根，因此不接受
`--config-root`，且可从任意工作目录调用：

```powershell
project-deploy plan --cluster production --machine app-01
project-deploy deploy --cluster production --app backend
project-deploy check --cluster production --environment app-01/postgresql
project-deploy install --cluster production --yes
```

常用中文目标与动作的对应关系：配置环境或更新安全配置使用 `configure`（安全密钥与模板只随 `configure`
投递），更新程序使用 `deploy`，检查环境使用 `check`。

可重复使用 `--machine`、`--app` 和 `--environment`；`deploy`/`plan` 只处理 App，只接受
`--machine`/`--app` 范围筛选。`--executor-region` 覆盖执行器区域，`--address-kind private|public`
显式覆盖地址类型。默认在执行过程中
按步骤输出中文人可读的进度行（步骤、机器、资源、动作与状态/跳过原因），结束时给出
简洁汇总；需要机器可解析结果时追加 `--json`，输出保持稳定 JSON 契约（结构与键名与
既有版本一致）。计划只包含敏感输入的逻辑名称，不包含配置密钥值或文件私钥内容。执行器在 stdout、
stderr、错误和 cleanup 信息离开执行边界前使用本次操作解析出的全部秘密脱敏；无法安全建立或应用
redactor 时 stdout/stderr 置空，只返回固定错误类别和结构化状态。

`check` 和 `install` 是环境动作，且不能同时提供 `--app`。省略 `--environment [MACHINE/]NAME`
时，二者默认检查/安装当前选择范围内（未加 `--machine`
时为全部机器）的全部环境；显式传入时只处理所选环境。`check` 直接执行；`install`
在缺省全量时会先打印目标环境并等待输入 `yes` 确认，非交互终端必须显式传 `--yes`
才继续，明确拒绝或取消则退出码 130
且不执行任何远端步骤。若显式选择的环境依赖其他环境，必须同时明确选择这些依赖，否则规划失败。

`deploy` 是远端修改动作，只规划并执行 App；它不生成 environment 的 `check`/`install`/`configure`
步骤，也不支持 `--environment` 或 `--with-dependencies`。环境应用先用 `prepare` 安装、配置和更新。
deploy 同样在执行前请求二次确认：计划生成后会先打印将处理的步骤并等待输入 `yes`，确认后才创建发布
attempt 并真正连接远端执行；拒绝、EOF 或非交互终端未显式传 `--yes` 时按取消处理（退出码
130）且不执行任何远端步骤、不产生发布记录。内置 versioned App 的 deploy 分成 `stage`、`activate`
和 managed `restart` 阶段：所有目标先完成包校验、上传/解包和版本目录暂存；任一准备失败时，后续
activate/restart 都不会执行。全部准备成功后才统一切换 `latest`、更新版本标记并发布配置/unit；
activate 全部成功后才进入统一 restart 阶段。这是协调阶段边界，不是跨机器分布式原子事务。自定义 deploy
脚本仍保持原单步语义。App 部署脚本以 `app_versions.yaml` 的 `version`
为“待部署版本”，与远端上次成功部署记录的版本标记比对：版本一致时
不发布制品、不重启、不等待健康检查，远端不做任何修改；版本不同时才解压重打包、原子发布到版本目录、
切换 `latest`、更新版本标记并在统一 restart 阶段重启应用。 执行 `deploy` 前需先用 `fetch` 把 App
安装包下载到本地缓存（见上文“本地部署包缓存”），缓存缺失时 命令会在任何 SSH 连接前预检失败（退出码
3）并提示先运行 `fetch`。

`install-deno` 是运行时引导动作：只接受 `--machine` 筛选（缺省全部机器并请求确认，非交互需
`--yes`），可用 `--deno-version` 固定精确版本、`--install-to` 指定远端安装目录；省略版本时
安装最新稳定版，已有旧版本会升级，已最新时跳过。显式版本只在该精确版本已存在时跳过。
它对每台机器独立输出 `present`（已满足跳过）、`installed` 或 `failed`，全部机器都 成功时退出码
0，存在失败机器时退出码 4；取消仍为 130。该动作不写发布历史、不修改 `machines.yaml`；未写 `deno`
字段时，后续动作默认使用裸命令 `deno`，缺省安装到 `/usr/local/bin/deno` 后即可在默认 PATH
中直接找到。

schema v2 的集中放置不会改变筛选语义：Environment 在装载后仍是 `机器名/环境名` 实例，短依赖仍指向
当前机器上的同名 Environment，`机器名/环境名` 仍表示显式跨机器依赖。除 `deploy`/`plan` 外，定向 App
不加 `--with-dependencies`
时只检查其传递环境依赖，不安装或配置它们；加上该选项才执行当前机器和环境筛选范围内
的依赖动作，筛选器不会被隐式扩大。

固定退出码为：成功 `0`、用法/配置错误 `2`、预检失败 `3`、下载/远端执行失败 `4`、用户取消 `130`。

## 发布历史与回退

`configure`、`start`、`stop`、`restart`、`deploy` 和 `rollback` 都会创建控制端 release attempt，
保存本次实际执行计划的不可变快照并与目标锁共同覆盖执行生命周期；命令成功时，结果中的
`release_id`（`--json` 模式下的 JSON 字段）是本次发布
ID（即使远端版本一致、仅记录跳过步骤也会生成该审计记录）。可以浏览
全部记录、查看单条记录，或明确指定一次成功发布作为回退来源：

```powershell
# 发布并取得结果中的 release_id
sfo-deploy deploy --cluster production --app backend

# 浏览发布记录
sfo-deploy history --cluster production

# 查看单条发布记录
sfo-deploy history --cluster production --release-id r20260831T120000000000Z-0123456789abcdef

# 回退到指定发布；新结果会同时给出 release_id 和 source_release_id
sfo-deploy rollback --cluster production --release-id r20260831T120000000000Z-0123456789abcdef
```

项目绑定命令同样支持 `history`、`--release-id` 和 `rollback`。`rollback` 必须提供
`--release-id`；`history` 可以省略该参数以浏览全部记录。每条发布记录都保留原始调用的
`selection`（机器、App、环境、执行区域、地址类型和依赖开关；`history` 默认输出人可读列表，附加
`--json` 时输出同等内容的稳定
JSON），因此即使配置加载或规划提前失败也能看到当时请求的范围；`apps`、`machines` 和 `app_versions`
则表示成功归档计划解析出的实际范围。发布 ID
不能用于其它动作，历史与回退也不能和机器、App、环境、区域、地址或依赖过滤器混用。历史查询和回退直接读取快照，不依赖当前
`cluster.yaml`、App 或环境声明仍然可被加载。

只有成功的 deploy/rollback 记录可作为回退来源；configure/start/stop/restart 记录用于审计，不伪造
rollback plan。回退重放快照中的 App `deploy` 和已声明的 `configure`；旧 deploy
快照还会重放其传递依赖的环境 `check`。新 deploy 快照没有环境步骤。回退不会执行环境
`install`/`configure`，也不会自动回滚数据库变更、已发送消息、外部服务写入或其他脚本副作用。只有状态为
`succeeded`、快照完整且校验通过的记录可以回退；失败、取消、仍在执行或因进程中断而缺少终态的
`incomplete` 记录均不可回退。回退本身也会产生新的发布记录，可以继续审计和作为后续回退来源。

新发布快照保存 Deno 运行时以及逐脚本 `run`/`net` 权限。迁移前已有的 Python v1
快照仍可读取和回退，并继续采用其原有 Python 权限模型；框架不会把旧快照改写为
Deno，也不会允许新集群配置创建 Python 计划。

曾导入 `./sfo_deploy.ts`（或 Python 同类辅助文件）的 TypeScript
脚本必须改为自包含脚本后才能由当前执行器运行。
历史发布快照若保存了这类导入，同样需要迁移或改用与该快照匹配的旧版执行器；当前版本不会自动注入兼容
shim， 也不承诺这些快照可直接回放。

历史固定存放在集群目录的 `.sfo-deploy/releases/`，采用追加式的 `intent.json`、可选 `outcome.json`
和不可变 `snapshot/`
组件。框架不会自动清理历史；运维方必须监控该目录容量并把它纳入备份与恢复方案。快照保留执行脚本、模板、计划和经过严格
codec
处理的制品定位符，但不保存制品本体，因此回退时旧版本制品源仍须可访问，且内容必须继续匹配原哈希。

HTTP/HTTPS 发布快照只接受不含用户名、密码、查询参数或 fragment 的稳定 URL；带 userinfo 或预签名
query 的 URL 会在任何 SSH 连接前被拒绝。内置 filehub 定位符必须是规范的四段
`SERVER/PROJECT/VERSION/NAME`。自定义下载 provider 若要参与通过 `run(..., action="deploy")`
创建的可回退发布，必须在同一个 provider 对象实现版本化 `ReleaseSourceCodec`，提供稳定 schema
以及严格往返的 `export_release_source`/`import_release_source`；仅实现 `fetch` 的旧 provider
仍可直接用于执行计划，但审计发布会在 SSH 前失败关闭，迁移时不得把 token、密码或预签名 URL 写入 codec
payload。
