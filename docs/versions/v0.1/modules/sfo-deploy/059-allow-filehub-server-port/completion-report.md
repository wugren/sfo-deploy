# 轻量完成报告：允许 filehub server 段携带端口

## Object and Scope

- Task manifest: task.yaml
- Workflow tier: standard
- Change record: docs/changes/059-allow-filehub-server-port.md
- 对象：允许 filehub 发布 source target 的第一段为 `host` 或 `host:port`，端口限定为 1-65535；其余
  三段与四段形状规则保持不变。

## Delivery Summary

- Outcome:
  - `src/downloads.ts` 新增 `FILEHUB_SERVER_RE`，把 target 第一段作为 server 标识处理，允许一个可选
    数字端口；`releaseFilehubTarget` 在 65536、0、缺少端口数字、段数错误或其他段包含不安全字符时
    继续抛出 `DownloadError`。
  - `tests/unit/downloads_secrets.test.ts` 新增发布 source codec 回归：示例形态
    `filehub.mynode.site:8443/eleph-server/0.1.0/jx-server` 通过导出/导入，无端口形态保持可用，
    非法端口和非法形状关闭失败。
- Handoff: 现有使用 `host:port/project/version/name` 的 `app_versions.yaml` 可以进入 deploy 的发布
  快照归档；无端口 target、filehub CLI 调用和本地包缓存行为不变。

## Proposal Consistency

| change_id | requirement_or_boundary | proposal_source | delivery_evidence | finding | status |
| --- | --- | --- | --- | --- | --- |
| CHG-filehub-server-port | 接受第一段 `host` 或 `host:port` 的规范四段 filehub target | proposal.md P-001 | `FILEHUB_SERVER_RE` 与 `releaseFilehubTarget` 落实；聚焦测试覆盖示例带端口形态和无端口形态 | 与批准范围一致 | pass |
| CHG-filehub-server-port | 非法端口、段数错误和非法其他段关闭失败 | proposal.md P-002 | 测试构造 65536、0、缺少第四段、多出第五段和 project 段含冒号，均断言抛出 `DownloadError` | 与批准范围一致 | pass |

## Independent Defect Discovery

| category | evidence_inspected | adversarial_check | finding_or_not_applicable_reason | status |
| --- | --- | --- | --- | --- |
| behavior-and-logic | `releaseFilehubTarget` 的分段、server 正则、端口数值判断和 codec 往返；`FilehubDownloadProvider.exportReleaseSource/importReleaseSource` | 构造 0、65536、`host:`、多冒号、少段、多段、非第一段冒号和空 source；确认导出会先往返校验，导入会重导出并只返回 source payload | 未发现逻辑缺陷：带一个 1-65535 端口时通过，其他形状关闭失败；`Number` 只在正则保证 1-5 位数字后调用 | pass |
| boundaries-and-failure-paths | 发布快照 source codec、target trim、既有 `FILEHUB_PART_RE`、错误类别映射和单元测试覆盖 | 检查冒号是否泄漏到 project/version/name，检查空段、未知字段、非普通 target、错误 schema 与错误类别；确认错误仍在 SSH 前抛出 | 未发现新增信任边界：只放宽第一段一个可选端口，凭据、query、fragment 和任意 URL 仍未引入；失败保持 `DownloadError` | pass |
| regression-and-side-effects | 现有无端口 target、filehub provider fetch 调用、发布历史 codec 测试、示例更新脚本测试；`deno task check`、lint、fmt 和全量 `deno task test` | 运行完整测试矩阵确认原有 direct provider、HTTP provider、缓存、历史和公共 CLI 行为未被改变；检查示例生成的 target 可通过新校验 | 未发现本任务引入的回归：全量 246 个测试通过；仅端口放行改变行为，无端口 target 保持原路径 | pass |

## Verification

- Targeted check: `deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/downloads_secrets.test.ts`；`deno task check`；`deno lint src/downloads.ts tests/unit/downloads_secrets.test.ts`；`deno fmt --check src/downloads.ts tests/unit/downloads_secrets.test.ts`；`deno task test`
- Result: pass
- Exception reason: not-applicable

## Findings

| id | severity | evidence | problem | blocking |
| --- | --- | --- | --- | --- |
| F-0 | none | 三类独立缺陷发现 | 未发现需要修正或阻塞的缺陷 | no |

## Conclusion

- Accepted / rejected / needs changes: accepted
- Reason: 交付与用户确认的目标一致：带端口 server 段可以进入发布快照，安全段规则和失败关闭行为保持；
  聚焦测试、类型检查、lint、格式检查和全量测试均通过。
