# sfo-deploy Acceptance Report

## Findings
| ID | Severity | Owning Stage | Correctness Category | Evidence | Problem | Blocking |
|----|----------|--------------|----------------------|----------|---------|----------|
| F-000 | none | none | overall | proposal/design, `src/config.ts`, `src/planning.ts`, `src/execution.ts`, `src/service_management.ts`, history codecs, task tests, and full test run 293/293 inspected | no finding | no |

## Object and Scope
- Task manifest: task.yaml
- Review date: 2026-09-09
- In-scope implementation: App schema 1 loader/planning/execution/history, system/script service lifecycle, docs, skill templates, examples, and contract tests. A prior needs-changes finding for `tool: auto` was fixed and re-reviewed.
- Review mode: independent falsification review of current proposal, implementation, tests, and runtime evidence; conclusion selected only after findings and category review.

## Requirement Coverage
| change_id | Requirement or Boundary | Source | Implementation Evidence | Finding | Status |
|-----------|-------------------------|--------|-------------------------|---------|--------|
| CHG-001 | App schema 1 only; top-level configs without entry names; script/file mutual type; unique identifiers; reject v2/v3/v4 | `proposal.md` P-001 | `src/config.ts` `appSchemaVersion`, `appConfigs`, `appManagement`; `tests/unit/app_management_config.test.ts`; `tests/contract/app_schema1_removed_consumer.ts` | no requirement defect or missing behavior found | pass |
| CHG-002 | system/script service management; system tool auto, systemctl, or service covering Ubuntu/CentOS fallback | `proposal.md` P-002 | `src/service_management.ts` `prepareSystemd`, `executePreparedSystemd`, `restoreSystemd`; `tests/unit/service_management.test.ts` auto service-only fallback test | no requirement defect found; detected tool now persists through convergence and is re-resolved for recovery | pass |
| CHG-003 | docs, skill templates, and examples follow schema 1 | `proposal.md` P-003 | `README.md`, guide, `skills/sfo-deploy-cluster/references/app.md`, example app files, `tests/contract/verify_app_management_contract.ts` | no documentation mismatch found | pass |

## Independent Defect Discovery
| Category | Applicable Scope | Evidence Inspected | Adversarial Check | Finding or Not-Applicable Reason | Status |
|----------|------------------|--------------------|-------------------|----------------------------------|--------|
| requirement-and-behavior | schema/service contract and non-goals | proposal P-001/P-002/P-003, `src/config.ts`, `src/service_management.ts`, examples and tests | searched for narrowed behavior, unintended compatibility, and unsupported host behavior | no defect found; schema is breaking, and auto/systemctl/service behavior matches the approved contract | pass |
| logic-and-control-flow | loader, planner, and service convergence branches | `appConfigs`, `appService`, `buildPlan`, `prepareSystemd`, `executePreparedSystemd` | challenged tool retention, action selection, branch ownership, and fail-closed behavior | no defect found; prepare stores the resolved tool and recovery re-resolves it | pass |
| boundary-and-input | YAML fields, paths, permissions, enums, time limits | `appConfigs`, `appService`, `managedConfigFiles`, `systemdUnitConfig`, unit and contract tests | tried malformed/empty/unknown fields, duplicate targets/scripts, path escapes, and invalid enums | no defect found; loader rejects the malformed and duplicate cases | pass |
| state-and-data-integrity | release transaction, config publication, service state | versioned stage/activate, `publishConfigs`, `restoreSystemd`, history codecs | challenged partial publication, stale state, duplicate actions, and rollback lineage | no defect found; transactions are bounded and history checks reject tampering | pass |
| error-handling-and-recovery | script, config, service, and cancellation failures | `#executeStep`, `recoverDeployment`, `restoreSystemd`, DV failure tests | challenged swallowed errors, partial recovery, cancellation, and cleanup escalation | no defect found; failures propagate and recovery failures are recorded | pass |
| resource-lifetime-and-cleanup | workspaces, bundles, scoped secrets, files, sessions | package/bundle preparation, scoped secret cleanup, workspace close, remote metadata removal | inspected success, failure, timeout, and cancellation cleanup | no defect found; cleanup failures are surfaced and do not mask the primary error | pass |
| concurrency-and-ordering | plan order, operation locks, versioned phases | plan dependencies, `acquireOperationLock`, stage-before-activate dependencies | challenged reordered service actions and concurrent targets | no defect found; managed lifecycle is serialized and ordered by dependencies | pass |
| interface-and-compatibility | exported types, YAML contract, history snapshots | `src/mod.ts`, history v1-v4 codecs, external consumer checks | challenged removed APIs and old snapshot replay | no defect found; old history remains readable while old app YAML is rejected | pass |
| security-and-capacity | permissions, run_as, secret scoping, path traversal, bundle safety | `requiredManagedRunAs`, scoped secret copies, managed target validation, transport/bundle tests | challenged secret leakage, root execution, traversal, unbounded inputs, and unsafe archive members | no defect found; secrets are scoped/redacted and unsafe paths fail closed | pass |
| test-adequacy | normal, failure, boundary, lifecycle, cross-module evidence | task unified run: 5 contract checks, 43 unit, 32 DV, 20 integration; full suite 293/293 | looked for failures that could escape current assertions | no adequacy defect found; service-only auto fallback and red-green counterexamples are now covered | pass |

## Document Consistency
| Document | Source | Implementation Consistency | Finding | Status |
|----------|--------|----------------------------|---------|--------|
| design | `design.md` | loader/planner/runtime follows the documented schema and service abstraction; auto tool retention was corrected to match the design | no mismatch | pass |
| testing | `testing.md`, `testplan.yaml` | task plan and evidence match the delivered behavior, including the new auto fallback test | no mismatch | pass |

## Result Summary
- Overall result: accepted
- Outcome: The schema 1 lifecycle, breaking contract, cross-distribution service behavior, history, security boundaries, docs, and examples are delivered with passing task and repository evidence.
- Blocking issues: none
- Next action: complete acceptance and remove the task from the active index.

## Conclusion
- Accepted / rejected / needs changes: accepted
- Reason: The direct falsification search, including the prior auto fallback counterexample, found no remaining blocking defect; all required categories and change IDs pass.
