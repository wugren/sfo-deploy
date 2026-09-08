---
task_manifest: task.yaml
status: approved
confirmed_by: user
confirmation_at: 2026-09-04
---

# Nginx App 配置目录化并改用 restart.ts 提案

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- Tier rationale / triggered boundaries:
  - 变更只集中在 Multipass `nginx` packageless App 的 YAML、脚本和定向测试，不修改 sfo-deploy
    schema、计划器或公共执行器。
  - 虽然 Nginx 重启是运行时动作，但本任务不新增安装/升级逻辑，只移除 apt 安装分支、
    把配置写入显式目录并拆出 restart 动作；影响范围和回退路径清晰。
  - 保留候选配置语法检查和原子替换，避免语法错误或半写文件直接导致服务不可用。
- Proposal and tier confirmation: 用户已于 2026-09-04 确认本提案与 standard 层级。

## Background and Goal

当前 `nginx` packageless App 在 configure 中包含安装 Nginx 的 apt 分支，并直接管理
`/etc/nginx/nginx.conf`。用户要求不要处理 Nginx 安装，而是把配置写入指定目录， 再通过独立的
`restart.ts` 重启 Nginx。

目标是让 nginx App 更聚焦：`configure` 只负责把模板生成的配置写入
`install_directory/nginx.conf`；`restart` 只负责重启服务；Nginx 必须由目标机 预先安装，App
不负责安装。

## Scope

### In scope

- 在 `apps/nginx/app.yaml` 增加显式 `install_directory: /etc/nginx`。
- `check.ts` 只检查 Nginx 可执行文件和当前配置，不检查或执行包管理器安装。
- `configure.ts` 移除 apt/dpkg 安装分支；读取模板后写入
  `${install_directory}/nginx.conf`，写入前先校验候选配置并原子替换。
- 新增 `restart.ts`，只执行 `sudo systemctl restart nginx`。
- 同步模板与 live 集群、定向测试和示例说明。

### Out of scope

- 不安装、升级、删除或自动发现 Nginx。
- 不修改 sfo-deploy 的 packageless App schema 或计划行为。
- 不新增 TLS、域名、防火墙、缓存或负载均衡。
- 不改变 `jx-web` 和 `jx-server` 的部署语义。

### Boundary with neighboring modules

- 目标机运维负责预装并启用 Nginx；App 只负责配置和受控重启。
- sfo-deploy 继续负责 packageless App 的 `check/configure/restart` 编排。
- `/etc/nginx/nginx.conf` 的内容由 nginx App 配置模板拥有；服务进程由 systemd 拥有。

## Requirement Review

需求合理。把安装职责移出 App 能减少脚本权限和远端副作用；显式 `install_directory`
避免硬编码目标路径。使用独立 `restart.ts` 也与“配置更新”和“服务重启”职责分离。

保留 `nginx -t` 和原子替换是必要的：配置写坏后直接重启会让站点不可用；写一半就被 systemd
读取也可能失败。App 仍不负责安装，缺失 Nginx 时 check 会失败。

## Proposal Items

| proposal_id | change_id            | requirement                                                       | boundary                                                | tradeoff                         | success_evidence                       | non_goal     |
| ----------- | -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- | -------------------------------------- | ------------ |
| P-001       | CHG-nginx-config-dir | nginx App 显式声明配置目录，configure 只写入该目录下的 nginx.conf | 使用 packageless App 的 `install_directory`；不下载制品 | 增加显式配置路径，避免脚本硬编码 | 单元/集成测试覆盖目录路径和原子替换    | 不安装 Nginx |
| P-002       | CHG-nginx-config-dir | 移除 apt/dpkg 安装逻辑；Nginx 缺失时 check 失败                   | 不调用包管理器，不自动安装                              | 简化权限，但要求目标机预装 Nginx | 测试确认没有 apt/dpkg 调用且缺失时失败 | 不管理软件包 |
| P-003       | CHG-nginx-config-dir | 新增 restart.ts 并通过 App restart 动作重启 Nginx                 | restart 只执行 systemctl restart；不写入配置            | 配置与重启分离，动作更清晰       | 集成测试验证 restart 命令与失败传播    | 不重复配置   |

## Success Criteria

- Concrete user-visible or system-visible result: 目标机预装 Nginx 后，`configure` 将配置写入
  `install_directory/nginx.conf`；随后可通过 `restart --app nginx` 执行 `restart.ts` 重启服务。
- Required evidence: 模板/live YAML 和脚本一致；定向集成测试覆盖无安装调用、
  配置写入指定目录、候选校验、原子替换和 restart 成功/失败。
- Explicit non-goals: 不安装 Nginx，不修改框架 schema，不引入 TLS/域名/防火墙。

## Risks

- 目标机未预装 Nginx 会导致 check 失败；这是明确的失败关闭，而不是自动安装。
- 写入 `/etc/nginx` 需要 `sudo`；权限白名单会限制到必要的 nginx/test/install/mv/systemctl。
- 错误配置不能直接重启；仍保留候选 `nginx -t` 和原子替换。

## Unresolved Questions

- 无。默认“指定目录”使用 nginx App 的 `install_directory: /etc/nginx`，配置文件为该目录下的
  `nginx.conf`。
