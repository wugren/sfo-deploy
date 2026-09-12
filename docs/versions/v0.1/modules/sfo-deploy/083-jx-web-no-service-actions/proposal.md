---
task_manifest: task.yaml
status: approved
---

Risk profile: ./risk-profile.yaml

# Proposal：jx-web 承载 Nginx server 配置并保持静态站点无服务启停

## Workflow Tier Judgment

- Proposed tier: high-risk
- Final tier: high-risk
- Tier rationale / triggered boundaries: 需要新增 `nginx` 受管配置格式这一公开
  契约，改变 versioned App 的配置发布能力；同时调整真实 Multipass 部署面，
  涉及 Nginx 配置、服务 reload、失败补偿和页面/API 可访问性。属于部署/回滚、
  公开契约与 runtime integration 的实质影响，因此建议 high-risk。
- Proposal and tier confirmation: 用户于 2026-09-11 确认显示的提案和
  `high-risk`；静态根目录采用 `/home/projects/ui/latest`。授权完整设计、实现、
  测试、真实 Multipass 部署验收与收尾。

## Background and Goal

当前 `nginx` App 用 `format: yaml` 发布 `/etc/nginx/nginx.yaml`。Nginx 不会加载
该文件；发行版默认主配置实际加载的是 `/etc/nginx/conf.d/*.conf`。因此当前配置
不能让 Nginx 服务 jx-web，也不能代理 jx-server。

目标是把 Nginx 站点配置从独立 `nginx` App 合并到 `jx-web`，使用一个独立的
Nginx server 配置发布到 `/etc/nginx/conf.d/jx-web.conf`。`jx-web` 版本发布仍
只安装并切换 `latest`，不启动/停止任何 `jx-web` 服务；当站点配置变化时，
只对已运行的 `nginx.service` 执行 reload，使部署后能访问 jx-web 页面和
jx-server 接口。

## Scope

### In scope

- 新增受管配置格式 `nginx`：按 UTF-8 纯文本处理，只用于 Nginx 原生配置；
  首版禁止秘密占位符，避免把无结构解析的文本当作安全注入边界。
- 扩展配置装载、远端 updater、历史计划兼容、类型、单元/集成测试和配置文档。
- 将 Nginx server 配置合并到 `jx-web` App，目标为
  `/etc/nginx/conf.d/jx-web.conf`，文件属主 `root:root`，权限 `0644`。
- `jx-web` 添加 `nginx` environment 依赖；`jx-web` 的 service 管理外壳指向
  `nginx.service`，`on_deploy: none`，不声明 `enabled`，配置变化触发 reload。
- 从 live/template 集群移除旧的 `nginx` App 放置和 App 目录；保留 `nginx`
  environment，由它继续负责 Nginx 软件安装。
- 更新示例 README、配置指南、模块契约和 sfo-deploy-cluster 技能说明。
- 部署到 Multipass `eleph-server` 并验证：
  - `/etc/nginx/conf.d/jx-web.conf` 存在且 root 可读；
  - `nginx -t` 成功；
  - HTTP 入口能访问 jx-web 页面；
  - HTTP 代理路径能访问 jx-server 接口且状态码小于 500。

### Out of scope / explicit non-goals

- 不实现完整 Nginx DSL parser，不验证任意 Nginx 指令语义；`nginx` 格式只保证
  UTF-8 纯文本发布，部署验证通过 `nginx -t` 和真实 HTTP 请求完成。
- 不在 `nginx` 配置格式中支持秘密占位符。
- 不安装或升级 Nginx；软件安装继续由 `nginx` environment 的 prepare 完成。
- 不管理 `/etc/nginx/nginx.conf` 主配置，也不清理发行版默认站点（如发行版
  默认 include 引起冲突，将在部署验证中单独提出并经用户确认后调整）。
- 不改变包版本、来源、哈希或文件权限。

## Boundary with neighboring modules

`src/config.ts` 和 `src/types.ts` 拥有配置格式契约；`src/remote_runtime/config_updater.ts`
拥有目标端候选渲染；`src/execution.ts` 拥有 stage/activate 和 reload 编排。
示例集群配置只消费新格式，不绕过受管配置事务自行写 `/etc/nginx/conf.d`。

## Requirement Review

请求合理，但必须先解决实现限制：现有受管配置格式会把源文件按 YAML/JSON/TOML/INI
解析，不能表示 Nginx 原生 `server { ... }`。因此不能直接把 `.conf` 声明为
`ini` 或 `yaml`。建议新增最小 `nginx` 纯文本格式，并用 `nginx -t` 和真实请求
验证。

jx-web 使用 sfo-deploy versioned 发布布局：包内容位于
`/home/projects/ui/<version>/`，`/home/projects/ui/latest` 是当前版本选择器。
因此用户提供的静态根目录 `/home/projects/ui` 需适配为
`/home/projects/ui/latest`；其余 location、代理头、错误页和 API 前缀按用户提供
的参考配置保留。

jx-web 是静态资源包，不需要自己的服务。保留 versioned App schema 1 要求的
`management.run_as`，但把 service 管理外壳指向 `nginx.service`，并且 `enabled`
不声明、`on_deploy: none`。配置变化使用 `on_change: reload`，这是让新 server
配置生效的最小服务动作；不会 start/stop/restart Nginx。

主要取舍：新增 `nginx` 格式扩大公开契约，但比让 App 脚本用 sudo 写系统目录更
安全；纯文本格式也明确承认本任务不做完整 Nginx DSL 解析。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-jx-web-nginx-server-config | 受管配置支持 `nginx` 原生纯文本格式。 | 只支持 UTF-8 文本、无秘密占位符；不实现完整 DSL parser。 | 扩大契约，换取能安全发布 `/etc/nginx/conf.d/*.conf`。 | 装载/远端渲染/历史兼容测试通过。 | 不解析或改写 Nginx 指令。 |
| P-002 | CHG-jx-web-nginx-server-config | jx-web 发布独立 Nginx server 配置并按需 reload。 | 配置合并到 jx-web；移除独立 nginx App；保留 nginx environment。 | jx-web 的管理外壳指向 nginx.service，但只在配置变化时 reload。 | validate/plan 通过；真实部署后配置存在、`nginx -t` 通过、页面和接口可访问。 | 不安装 Nginx，不启停 jx-web 或 Nginx。 |
| P-003 | CHG-jx-web-nginx-server-config | 文档与技能说明反映新契约和示例拓扑。 | 只更新与配置契约、示例部署和验证直接相关的内容。 | 文档同步成本增加，避免用户继续使用不可加载的 nginx.yaml。 | 文档契约检查与示例 validate/plan 通过。 | 不迁移仓库外用户配置。 |

## Nginx Server Configuration

发布到 `/etc/nginx/conf.d/jx-web.conf` 的基线如下；唯一与用户参考不同的值是
静态根目录，原因是 jx-web 由 sfo-deploy 以 versioned 布局发布：

```nginx
server {
    listen       80;
    server_name  localhost;
    charset      utf-8;

    # 前端静态页面
    location / {
        root   /home/projects/ui/latest;
        try_files $uri $uri/ /index.html;
        index  index.html index.htm;
    }

    # 后端 API 反向代理
    location /prod-api/ {
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header REMOTE-HOST $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_pass http://localhost:8080/;
    }

    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   html;
    }
}
```

## Success Criteria

- `jx-web` 的 versioned 发布仍只有 stage/activate 语义；`on_deploy` 为 `none`，
  不声明 enabled；同版本重复部署不因服务策略主动 start/stop/restart。
- `/etc/nginx/conf.d/jx-web.conf` 由受管配置事务发布，内容为 Nginx server 块，
  root:root 0644。
- 配置变化时只向 `nginx.service` 发出 reload；无配置变化时不执行服务动作。
- 部署后宿主机通过 HTTP 访问 jx-web 页面成功，通过配置的 API 前缀访问
  jx-server 接口且状态码小于 500。
- 本地 `deno task check`、相关单元/集成测试、`deno task test`、示例 validate
  和 plan 通过。

## Risks

- Nginx server 配置的监听端口、server_name 和 API 前缀必须与前端实际请求一致；
  错误的 proxy 路径会导致页面可访问但接口失败。
- 发行版默认站点或主配置可能与新 server 配置冲突；本提案不默认改主配置，若
  真实验证发现冲突会停止并确认处理边界。
- `nginx -t` 不是框架内置 validator，直接把 server 片段作为主配置测试会失败；
  因此验证策略需要在设计中明确，不能伪装成完整的 Nginx parser。
- 真实部署会修改 Multipass 节点上的 Nginx 配置和 jx-web 版本状态；失败时依赖
  既有受管配置和 versioned release 补偿。
