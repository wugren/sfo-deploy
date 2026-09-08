# install-deno 不再回写 machines.yaml.deno

- Status: complete
- Owner module: sfo-deploy
- Task manifest: docs/versions/v0.1/modules/sfo-deploy/034-drop-install-deno-config-sync/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/sfo-deploy/034-drop-install-deno-config-sync/proposal.md
- Affected paths: src/integration.ts, src/config.ts, tests/unit/config_planning.test.ts,
  tests/dv/install_deno.test.ts, tests/contract/verify_install_deno_contract.ts, README.md,
  docs/guides/sfo-deploy-cluster-configuration.md, examples/eleph-server-multipass/README.md,
  docs/changes/034-drop-install-deno-config-sync.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

移除 task 032 加入的 `install-deno`→`machines.yaml` 自动写回：

- `src/integration.ts` 不再调用 `syncMachineDenoConfig`，安装/跳过/失败后直接返回
  `InstallDenoResult`。
- `src/config.ts` 删除仅供该写回使用的 `syncMachineDenos`、`MachineDenoUpdate` 与 行级 YAML
  改写辅助代码；`machines.yaml.deno` 的严格装载与可选解析保持不变。
- 相关单元/DV 用例回归：DV 主流程改为断言 `machines.yaml` 在 install-deno 前后内容
  完全不变；删除配置写回单元用例与“同步失败”DV 用例。
- 文档契约同步：README、集群配置指南与示例 README 改为说明 install-deno 不修改 `machines.yaml`；未写
  `deno` 字段时默认使用裸命令 `deno`，远端 PATH 需能找到已安装 的可执行文件。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no（install-deno 不再写配置，减少持久 副作用）
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no（脚本预检/执行仍按
  `machines.yaml.deno`，缺省 `deno`；远端 PATH 前提已由文档披露）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

If any answer becomes `yes`, record the evidence. When it changes the confirmed requirement, scope,
or acceptance boundary, return the existing packet's `proposal.md` to draft, recommend the
appropriate tier, and obtain proposal/tier reconfirmation before further project mutation.

## Verification

- Targeted check: `deno test tests/unit/config_planning.test.ts tests/dv/install_deno.test.ts`、
  `deno run tests/contract/verify_install_deno_contract.ts`、`deno task check`、
  `deno task lint`、`deno task fmt --check`，随后全量 `deno task test`。
- Result: passed
- Residual risk or follow-up: install-deno 不再保证 machines.yaml 指向实际安装目录； 若远端 SSH
  非交互 PATH 不包含安装后的 Deno，prepare 会失败。README 已给出 `--install-to /usr/local` 建议与
  PATH 配置提示；用户也可手工维护 `machines.yaml.deno` 绝对路径。
