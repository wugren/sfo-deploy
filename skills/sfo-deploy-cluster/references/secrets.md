# 秘密和模板

秘密唯一声明点是 cluster.yaml：

```yaml
secrets:
  DB_PASSWORD:
    kind: value
    machines: [app-01]
  TLS_KEY:
    kind: file
    machines: [app-01]
```

秘密名使用大写字母开头的 `A-Z0-9_`。引用该秘密的 App 必须放置于已声明的机器。真实来源是未提交的集群根 `secrets.yaml`，顶层直接映射秘密名到值或文件相对路径，不加 secrets 包装层。文件来源必须在集群目录内，禁止路径或符号链接逃逸；生成示例说明即可，不捏造真实秘密。真实秘密文件以 0600 保存，项目忽略对应文件及私钥目录。

managed 源配置中直接使用 `${DB_PASSWORD}`；配置声明 format，不能手写内部 `__SFO_SECRET_...` marker。普通参数变量为 `__SFO_CONFIG_VAR_V1_<NAME>__`，独占完整值，并由 config action 的 `variables: [{name: NAME, path: [version]}]` 等声明绑定。无包 App 没有可任意新增的 parameters，不凭空引用参数。

脚本需要秘密时使用框架随步骤上传的 `./sfo-secret-loader.ts` 和 `DEPLOYMENT_SECRETS_DIR`，按目标实现的 loadSecrets 接口读取，不导入本机仓库绝对路径或把秘密写入日志、脚本、版本记录。仅在该脚本实际需要时添加 loader 使用，具体调用先核对目标实现。

secrets-deploy 是远端操作，单纯生成配置时不运行。validate/plan 不证明真实秘密已存在于远端。
