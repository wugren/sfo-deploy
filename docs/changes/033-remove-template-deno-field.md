# 示例模板不再写入 machines.yaml.deno 参数

- Status: complete
- Owner module: deployment-framework
- Task manifest:
  docs/versions/v0.1/modules/deployment-framework/033-remove-template-deno-field/task.yaml
- Approved proposal:
  docs/versions/v0.1/modules/deployment-framework/033-remove-template-deno-field/proposal.md
- Affected paths: examples/eleph-server-multipass/cluster-template/machines.yaml.tpl,
  examples/eleph-server-multipass/README.md, docs/changes/033-remove-template-deno-field.md
- Explicit tier override: none
- Expanded high-risk packet: none

## Approach

删除 `cluster-template/machines.yaml.tpl` 中机器条目的 `deno: /usr/local/bin/deno`。 框架对
`machines.yaml.deno` 的既有默认值本来就是裸命令 `deno`，因此重新生成的集群会 直接使用默认 `deno`
命令，无需在模板中硬编码安装路径。

示例 README 同步删除“与模板 machines.yaml 的 deno 路径一致”的旧说明，改为说明模板不 写 `deno`
字段、框架默认调用 `deno`，并保留 `--install-to /usr/local` 建议（该目录 通常在默认 PATH 中）与
install-deno 自动同步的实际路径说明。验证命令从 `/usr/local/bin/deno --version` 改为
`deno --version`。

## Risk Screen

- Public contract, protocol, or CLI change: no
- Persistent data, schema, or migration change: no（`machines.yaml.deno` 字段仍为可选，
  只是模板不再覆盖默认值）
- Security, privacy, or trust-boundary change: no
- Concurrency, lifecycle, or runtime integration change: no（框架默认行为未改；远端 `deno` 命令的
  PATH 前提在 README 说明）
- Material dependency/build graph, supply-chain trust, produced artifact, production default/feature
  rollout, release/deployment, compatibility, or rollback impact: no
- Material UI, accessibility, localization, or navigation workflow change: no
- Harness rule, checker, or test-infrastructure change: no
- Cross-project or architectural boundary change: no

If any answer becomes `yes`, record the evidence. When it changes the confirmed requirement, scope,
or acceptance boundary, return the existing packet's `proposal.md` to draft, recommend the
appropriate tier, and obtain proposal/tier reconfirmation before further project mutation. When it
is newly discovered risk inside the unchanged confirmed scope, keep the user-selected tier and
record the residual risk instead of silently upgrading.

## Verification

- Targeted check: `deno test tests/integration/environment_placement.test.ts`（含模板 复制替换 IP 后
  loadCluster 与 plan）、`deno run tests/contract/verify_install_deno_contract.ts`、
  `deno task check`、`deno task lint`、`deno task fmt --check`；随后全量 `deno task test`。
- Result: passed
- Residual risk or follow-up: 本任务不改 `install-deno` 的配置同步行为；安装成功后
  自动同步仍会把实际安装路径写回 `machines.yaml.deno`。若要“永远不写该字段并始终使用 裸命令
  `deno`”，需要再调整同步行为；该场景与本次模板改动属于不同范围。
