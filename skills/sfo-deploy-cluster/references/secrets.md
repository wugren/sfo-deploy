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

值秘密可选 `type: string|boolean|integer|number`，缺省为 string；file 秘密不能声明 type。
声明类型用于结构化配置替换，脚本 loader 读取值时仍返回字符串。

秘密名使用大写字母开头的 `A-Z0-9_`。引用该秘密的 App
必须放置于已声明的机器。真实来源是未提交的集群根
`secrets.yaml`，顶层直接映射秘密名到值或文件相对路径，不加 secrets
包装层，且必须恰好覆盖所有声明，不得缺项或额外添加秘密。来源值必须是非空字符串， 即使 type 为
boolean/integer/number 也写成带引号的字符串（如 `"true"`、`"5432"`），
后续再按声明类型校验。文件来源必须在集群目录内，禁止路径或符号链接逃逸；生成示例说明即可，不捏造真实秘密。真实秘密文件以
0600 保存，项目忽略对应文件及私钥目录。

managed 源配置中直接使用 `${DB_PASSWORD}`；配置声明 format，不能手写内部 `__SFO_SECRET_...`
marker。普通参数变量为 `__SFO_CONFIG_VAR_V1_<NAME>__`，独占完整值，并由 config action 的
`variables: [{name: NAME, path: [version]}]` 等声明绑定。无包 App 没有可任意新增的
parameters，不凭空引用参数。

`${APP_VERSION}` 例外：versioned App 的 managed config `target`、service
`unit_config.working_directory` 和 structured managed config 内容可直接使用它；框架替换为当前
部署动作选中的版本字符串，不需要通过 `variables` 声明。structured config 内容只支持
yaml/json/toml/ini。若 cluster 已声明名为 `APP_VERSION` 的秘密，内容中的占位符继续按秘密引用
处理；无包 App 不提供内置版本替换，但可以像其他秘密一样引用该同名秘密。它不是远端脚本进程 环境变量。

脚本需要秘密时使用框架随步骤上传的 `./sfo-secret-loader.ts` 和
`DEPLOYMENT_SECRETS_DIR`，按目标实现的 loadSecrets
接口读取，不导入本机仓库绝对路径或把秘密写入日志、脚本、版本记录。仅在该脚本实际需要秘密且
目标机器已有对应声明时使用 loader：

```ts
import { loadSecrets } from "./sfo-secret-loader.ts";

const { values, files } = await loadSecrets({
  dir: Deno.env.get("DEPLOYMENT_SECRETS_DIR")!,
  values: ["DB_PASSWORD"],
  files: ["TLS_KEY"],
});
```

`values.DB_PASSWORD` 是字符串，`files.TLS_KEY` 是步骤秘密副本的绝对路径。副本仅在当前步骤期间
有效，不保存这个路径供后续服务使用；有需要时由脚本在授权目标目录中交付文件。

secrets-deploy 是远端操作，单纯生成配置时不运行。validate/plan 不证明真实秘密已存在于远端。
