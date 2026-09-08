# Nginx App 配置目录化并改用 restart.ts

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  docs/versions/v0.1/modules/deployment-framework/045-packageless-nginx-config-dir/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/deployment-framework/045-packageless-nginx-config-dir/proposal.md
- Affected paths: `examples/eleph-server-multipass/**`,
  `tests/integration/packageless_app_scripts.test.ts`
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

`nginx` packageless App 使用 `install_directory: /etc/nginx` 指定配置目录。 `configure.ts` 移除
apt/dpkg 安装逻辑，读取模板、执行候选配置校验，并在目标目录内 生成临时文件后原子替换
`nginx.conf`。新增 `restart.ts` 作为独立 App `restart` 动作，只负责
`systemctl restart nginx`。目标机必须预装 Nginx；缺失时 `check` 失败关闭。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: yes
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

运行时影响限于 Multipass 示例的 nginx App：不再安装软件，配置写入显式目录后由独立 restart
脚本重启服务。框架 schema、计划器和执行器不变。

## Verification

- Targeted check:
  `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/integration/packageless_app_scripts.test.ts tests/integration/independent_remote_scripts.test.ts tests/integration/environment_placement.test.ts`；`deno run --allow-read --allow-run=deno tests/contract/verify_environment_placement_config.ts closure`；`deno run --allow-read tests/contract/verify_environment_placement_config.ts docs`
- Result: passed
- Residual risk or follow-up: 真实 Multipass/systemd 行为仍需目标环境验收。
