# 完成报告：Multipass 集群密钥随机值生成脚本

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/090-generate-cluster-secrets.md

## Delivery Summary

- Outcome: 新增 `examples/eleph-server-multipass/scripts/generate-cluster-secrets.ts` 与示例任务
  `generate-cluster-secrets`，读取 `cluster.yaml` 的 `secrets` 声明，为 `kind: value` 密钥生成 64 位
  十六进制随机值并以 0600 原子写入 `clusters/multipass/secrets.yaml`；默认 dry-run、拒绝覆盖、
  `--force` 先备份、文件密钥失败关闭，终端从不打印秘密值。已为当前集群生成 0600 的真实
  `secrets.yaml`（三个声明键，框架本地装载验证通过）。
- Handoff: 在 `examples/eleph-server-multipass` 运行 `deno task generate-cluster-secrets` 预览、
  `deno task generate-cluster-secrets --write` 生成或（追加 `--force`）轮换本地秘密来源；实际投递
  仍需用户授权的 `secrets-deploy`，本任务未执行任何 SSH/部署动作。

## Proposal Consistency

| change_id                      | requirement_or_boundary                                                                     | proposal_source                  | delivery_evidence                                                                                                                                  | finding                                              | status |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------ |
| CHG-multipass-secret-generator | P-001 解析 `secrets` 声明并为 `kind: value` 生成强随机十六进制值                            | proposal.md P-001                | 脚本 `parseSecretDeclarations`/`generateSecretValues` 与 9 项单测；真实 dry-run 列出三个声明键且未打印值                                           | 与批准需求一致                                       | pass   |
| CHG-multipass-secret-generator | P-002 `--write` 以 0600 原子写入，已存在拒绝覆盖，`--force` 先备份                          | proposal.md P-002                | 真实 `--write` 生成 0600 文件；重复 `--write` 退出码 1；隔离目录验证备份内容与权限、无临时文件残留                                                  | 与批准需求一致                                       | pass   |
| CHG-multipass-secret-generator | P-003 文件密钥失败关闭且不写半成品来源文件                                                   | proposal.md P-003                | 隔离目录中声明 `kind: file` 时 `--write` 退出码 1 并列出密钥名，目录内仅有 `cluster.yaml`                                                           | 与批准需求一致                                       | pass   |
| CHG-multipass-secret-generator | P-004 示例任务与 README 同步，固定最小权限与不打印秘密值                                      | proposal.md P-004                | `deno.json` 新任务权限仅 `--allow-read/--allow-write=clusters/multipass`；README 第 1 节说明用法、备份语义与 Windows 权限差异；`--help` 输出正常  | 与批准需求一致                                       | pass   |

## Independent Defect Discovery

| category                     | evidence_inspected                                                                                                                 | adversarial_check                                                                                                                                                            | finding_or_not_applicable_reason                                                                                                 | status |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| behavior-and-logic           | 脚本 `parseSecretDeclarations`/`generateSecretValues`/`renderSecretsYaml`/`ensureWritableTarget`/`writeSecretsAtomically` 与单测实现 | 用注入随机源核对十六进制长度与大小写；以 `--length 16` 实跑确认为 32 个十六进制字符（16 字节），确认无按名分支或跨密钥复用；框架 loader 解析三个值均 `hex64: true`              | 未发现生成逻辑、长度语义或 YAML 渲染缺陷                                                                                         | pass   |
| boundaries-and-failure-paths | 覆盖保护、备份命名、0600 chmod、符号链接拒绝、文件密钥失败关闭、临时文件清理与参数解析错误路径                                      | 在隔离目录构造文件密钥声明、重复 `--write`、`--force` 轮换、符号链接目标、非法 `--length` 与非法参数；核对失败后目录无 `secrets.yaml`、无 `.secrets.*.tmp` 残留               | 未发现会泄漏凭据、误覆盖旧值、写出半成品或绕过长度/参数校验的失败路径缺陷                                                        | pass   |
| regression-and-side-effects  | `git status` 差异、示例 `deno.lock`、SSH 身份文件时间戳、`git check-ignore`、仓库全量测试与 lint/fmt 任务                          | 确认 `deno.lock` 未被改写、`clusters/multipass/secrets/id_ed25519*` 未修改、`secrets.yaml` 仍被忽略；根 `deno task test`（340 项）与 `update-filehub` 既有单测全部通过        | 未发现对既有示例脚本、集群 SSH 信任、框架代码或版本控制边界的回归；lint 配置新增仅覆盖示例项目内的 `no-import-prefix` 豁免      | pass   |

## Verification

- Targeted check: `deno task test`（含 9 项新单测）、根 `deno task check`/`lint`/`fmt`、示例
  `deno task check`；真实 `deno task generate-cluster-secrets` 与 `--write` 后检查权限/键集合/值格式、
  重复写入拒绝与 `git check-ignore`；框架本地装载 `resolveSecretsForMachine` 验证三个值密钥
- Result: pass
- Exception reason: not-applicable

## Findings

| id    | severity | evidence                                                                                                       | problem                        | blocking |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------- |
| F-001 | none     | 单测、全量回归、真实 dry-run/写入、框架 loader 校验与隔离目录失败路径验证全部通过，无值泄漏到输出或版本控制    | 独立缺陷搜索未发现交付缺陷     | no       |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与已批准提案的 P-001 至 P-004 一致；目标文件受 0600 与 Git 忽略保护，覆盖保护、备份、
  文件密钥失败关闭和不打印秘密值均经独立验证，未发现行为、边界或回归缺陷。
