# 轻量完成报告

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/045-packageless-nginx-config-dir.md

## Delivery Summary

- Outcome: `nginx` packageless App 现在通过 `install_directory: /etc/nginx` 指定配置目录；
  `check.ts` 只确认 Nginx 已预装且配置可解析，`configure.ts` 移除 apt/dpkg 安装逻辑并原子写入
  `nginx.conf`，新增 `restart.ts` 作为独立 `restart` 动作执行服务重启。
- Handoff: 目标机必须预装 Nginx。部署配置使用 `deploy --app nginx`，需要单独重启时使用
  `restart --app nginx`；真实 Multipass/systemd 行为需在目标环境验收。

## Proposal Consistency

| change_id            | Requirement or Boundary                                            | Proposal Source   | Delivery Evidence                                                                                                                                             | Finding | Status |
| -------------------- | ------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| CHG-nginx-config-dir | 使用 `install_directory` 指定配置目录，configure 写入 `nginx.conf` | proposal.md P-001 | `cluster-template/apps/nginx/app.yaml` 声明 `/etc/nginx`；`scripts/configure.ts` 读取 metadata 并写入 `${install_directory}/nginx.conf`；测试断言目标文件内容 | matches | pass   |
| CHG-nginx-config-dir | 不安装 Nginx；缺失时 check 失败                                    | proposal.md P-002 | `app.yaml` check/configure 权限移除 apt-get/dpkg-query；configure 无安装分支；check 要求 `/usr/sbin/nginx` 存在；测试使用会失败的 apt/dpkg 替身仍成功         | matches | pass   |
| CHG-nginx-config-dir | 新增独立 restart.ts 并通过 App restart 重启 Nginx                  | proposal.md P-003 | `scripts/restart.ts` 只执行 `sudo systemctl restart nginx`；`app.yaml` 声明 restart；集成测试覆盖成功路径                                                     | matches | pass   |

## Independent Defect Discovery

| Category                     | Evidence Inspected                                                                       | Adversarial Check                                                                    | Finding or Not-Applicable Reason                                                                                            | Status |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | `check.ts`、`configure.ts`、`restart.ts`、`app.yaml` 与定向集成测试                      | 检查安装调用移除、配置目标路径、候选校验和原子替换顺序；确认 restart 不写配置        | 测试证明 configure 仍成功而 apt/dpkg 替身退出 1，restart 脚本只输出服务重启；未发现错误分支                                 | pass   |
| boundaries-and-failure-paths | 配置目录路径校验、Nginx 缺失分支、nginx -t 失败、临时文件 finally 清理、restart 非零输出 | 构造非绝对/`..`/根目录路径和不成功命令；检查临时文件残留和失败传播                   | `safeDirectory` 拒绝根目录、相对路径和 `..`；临时文件仅在已创建且未成功替换时清理；真实软件源/systemd 行为记录为 manual gap | pass   |
| regression-and-side-effects  | 模板/live 脚本 diff、独立远端脚本契约、Multipass 集成测试、jx-web 测试和文档             | 检查脚本数量从 16 到 17、模板/live 一致、普通 packageless 语义不变、无意外安装或重启 | closure/docs 契约与 11 个集成测试通过；jx-web 发布/清理测试未回归，也没有发现越界副作用                                     | pass   |

## Verification

- Targeted check:
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/integration/packageless_app_scripts.test.ts tests/integration/independent_remote_scripts.test.ts tests/integration/environment_placement.test.ts`；`deno run --allow-read --allow-run=deno tests/contract/verify_environment_placement_config.ts closure`；`deno run --allow-read tests/contract/verify_environment_placement_config.ts docs`
- Result: passed
- Exception reason: not-applicable

## Findings

| ID  | Severity | Evidence                                               | Problem                                                       | Blocking |
| --- | -------- | ------------------------------------------------------ | ------------------------------------------------------------- | -------- |
| F-1 | low      | `completion-report.md` Verification 与 Manual gap 说明 | 自动化测试使用替身，未启动真实 Multipass/systemd/filehub 服务 | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与已确认提案一致；安装职责移除、配置写入指定目录、候选校验、原子替换和独立 restart
  均有定向测试覆盖。
