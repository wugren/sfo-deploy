# sfo-deploy

一个供项目部署模块复用的 Python SSH 集群部署框架。每个集群是独立目录，机器级声明环境实例，环境和 App 的全部生命周期操作由 Python 脚本完成。

## 集群布局

```text
clusters/production/
├── cluster.yaml
├── machines.yaml
├── environments/
│   └── postgresql/
│       ├── environment.yaml
│       └── scripts/
│           ├── check.py
│           ├── install.py
│           └── configure.py
└── apps/
    └── backend/
        ├── app.yaml
        ├── templates/
        │   └── application.ini.tpl
        └── scripts/
            ├── configure.py
            ├── deploy.py
            └── restart.py
```

同区机器默认通过内网 IP 连接，跨区机器默认使用公网 IP。所有配置在首次 SSH 连接前完成严格校验。

## 项目绑定

```python
from pathlib import Path
from sfo_deploy import create_cli

main = create_cli(
    config_root=Path(__file__).resolve().parent / "clusters",
    file_secrets={
        "HTTPS_PRIVATE_KEY": Path(__file__).resolve().parent / "secrets/server.key"
    },
    config_secrets={"DB_PASSWORD": lambda: obtain_password()},
)
```

项目可将 `main` 注册为自己的 console script。项目绑定使用绝对配置根目录，不依赖调用命令时的当前工作目录。

## 敏感数据边界

- `file_secrets` 由项目提供本地文件，集群配置声明目标机器、绝对路径和限制性权限；框架负责原子投递。
- `config_secrets` 只提供给显式声明它们的 Python 配置脚本。
- 配置脚本可以读取 `context.config_secret("DB_PASSWORD")`，或使用固定的 `$DB_PASSWORD`、`${DB_PASSWORD}` 模板替换；`$$` 表示字面量 `$`。
- 框架不提供密码保险库、加密存储、生成或轮换。

## 最小配置示例

`clusters/production/cluster.yaml`：

```yaml
schema_version: 1
name: production
executor_region: cn-east
apps:
  backend: [app-01]
```

`clusters/production/machines.yaml`：

```yaml
schema_version: 1
machines:
  - name: app-01
    region: cn-east
    private_ip: 10.0.0.10
    ssh_user: deploy
    environments: []
```

`clusters/production/apps/backend/app.yaml`：

```yaml
schema_version: 1
name: backend
version: "1.0.0"
package:
  provider: https
  source:
    url: https://downloads.example.invalid/backend-1.0.0.tar.gz
  hash:
    algorithm: sha256
    value: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
depends_on: []
scripts:
  configure: [scripts/configure.py]
  deploy: [scripts/deploy.py]
  start: [scripts/start.py]
  stop: [scripts/stop.py]
  restart: [scripts/restart.py]
config_secrets: [DB_PASSWORD]
templates: [templates/application.ini.tpl]
```

`templates` 是相对于当前环境或 App 同名目录的文件列表，只能声明已存在的普通文件；绝对路径、`..` 逃逸、目录和重复路径都会在 SSH 前被拒绝。模板只随 `configure` 步骤上传，框架不会猜测模板的持久化目标。

生命周期脚本是普通 Python 文件，通过 `sfo_deploy.DeploymentContext.from_environment()` 读取当前动作上下文。配置脚本从只读 metadata 映射取得模板的远端临时路径，再明确选择生成位置：

```python
from pathlib import Path
from sfo_deploy import DeploymentContext

context = DeploymentContext.from_environment()
template = Path(context.metadata["templates"]["templates/application.ini.tpl"])
context.render_template(template, Path("/etc/backend/application.ini"))
```

模板内容可以包含 `$DB_PASSWORD`、`${DB_PASSWORD}` 和 `$$`。上下文仍只包含当前 `configure` 步骤通过 `config_secrets` 显式声明的密钥；模板本身不是秘密，最终配置路径和权限由项目脚本负责。

## 命令行

通用命令必须显式提供配置根目录和其中的集群名：

```powershell
sfo-deploy validate --config-root .\clusters --cluster production
sfo-deploy plan --config-root .\clusters --cluster production --app backend
sfo-deploy deploy --config-root .\clusters --cluster production --app backend
sfo-deploy check --config-root .\clusters --cluster production --environment app-01/postgresql
sfo-deploy install --config-root .\clusters --cluster production --environment app-01/postgresql
```

项目绑定命令固定使用 `create_cli()` 创建时解析的绝对配置根，因此不接受 `--config-root`，且可从任意工作目录调用：

```powershell
project-deploy plan --cluster production --machine app-01
project-deploy deploy --cluster production --app backend --with-dependencies
project-deploy check --cluster production --environment app-01/postgresql
```

可重复使用 `--machine`、`--app` 和 `--environment`；`--executor-region` 覆盖执行器区域，`--address-kind private|public` 显式覆盖地址类型。输出为 JSON，计划只包含敏感输入的逻辑名称，不包含配置密钥值或文件私钥内容。

`check` 和 `install` 是环境定向动作，必须至少提供一个 `--environment [MACHINE/]NAME`，且不能同时提供 `--app`。`check` 只运行所选环境的检查脚本；`install` 只运行所选环境的安装脚本，不会隐式运行 App 或环境配置脚本。若所选环境依赖其他环境，必须同时明确选择这些依赖，否则规划失败。

固定退出码为：成功 `0`、用法/配置错误 `2`、预检失败 `3`、下载/远端执行失败 `4`、用户取消 `130`。
