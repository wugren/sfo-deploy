# 项目、机器与放置

## 初始化

`assets/cluster/` 是空集群骨架，复制后按用户意图替换 `production`、`app-01`、`cn-east`、示例 IP 和 `deploy`。创建空的 `apps/`、`environments/`；Git 不保留空目录，但装载器允许二者缺省。空的 `app_versions.yaml` 提前提供给后续无包或带包应用。

```text
<项目>/
  .gitignore
  clusters/<集群>/
    cluster.yaml
    machines.yaml
    app_versions.yaml
    environments/<环境>/environment.yaml
    apps/<应用>/app.yaml
```

`--config-root ./clusters --cluster production` 选择 `./clusters/production`，不是 `./clusters/production/production`。未指定 config-root 时依次查找 `./<集群>` 和 `./clusters/<集群>`。

## 字段与闭合关系

- cluster schema 为 `2`，必需 `name`、`executor_region`、`environments`、`apps`。可按需添加 `secrets`；不要在此加入任意业务字段。
- `environments` 和 `apps` 都是名称到机器名列表的映射。每个定义必须且仅有一条同名映射；目标非空、无重复、必须存在于 machines。没有定义时用 `{}`。
- 环境统一存放于 `environments/<名称>/`，不用旧的 `environments/<机器>/<名称>/`。机器不声明 environments，不支持逐机 overrides；需要不同参数时使用不同环境定义名。
- 目录名、定义的 `name`、映射键一致；使用简单字母数字和 `-`/`_` 命名，不含路径分隔符。
- machines schema 为 `1`，`machines` 为列表，每项必需 `name`、`region`、`ssh_user`；可选 `private_ip`、`public_ip`、`domains`、`ssh_port`、`ssh_private_key`、`secrets_dir`、`deno`。
- IP 字段可用字符串或非空无重复列表。同 region 默认选 private_ip，跨 region 选 public_ip；不在两类之间自动回退。domains 只是描述信息，不代替 SSH IP。
- ssh_port 默认 22；deno 默认裸命令 `deno`，也可填远端规范绝对路径，不能写带参数的命令。远端脚本需要 Deno 2。
- `ssh_private_key` 若声明，必须是集群内部已存在的可读普通文件相对路径；不要放一个不存在的示例 key 导致校验失败。省略时使用 SSH agent。实际 SSH 还要求可信 known_hosts。

## 增量添加

先确认机器已经存在；新增机器应有用户提供的地址、区域和账号。只在相应放置键合并机器列表。短依赖 `runtime` 表示当前机器上的环境，`db-01/mysql` 表示显式跨机依赖；依赖只指向 environment，不指向 app，且不能成环。app 每个放置目标都必须满足其短依赖。

不要复制示例的整个 cluster.yaml 覆盖现有文件。多个集群的版本和放置独立维护。
