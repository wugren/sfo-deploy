# Task Execution Rules

## Authority
- Current-user confirmation of the displayed proposal and tier under [Task Entry Gate Rules](task-entry-gate-rules.md) authorizes the entire confirmed task: artifacts, implementation, verification, independent review, corrections, and closeout. No extra mode, launch instruction, or stage approval is needed.
- Record the actual confirmation and approve the proposal. File presence, unrelated approval, and silence do not authorize a new task. Honor later pause, stop, or scope-narrowing instructions.

## Execution
- Standard uses the [lighter flow](task-entry-gate-rules.md#tier-default-flows). High-risk uses proposal → design → implementation → testing → acceptance, with `design.md`, `testing.md`, `testplan.yaml`, and durable `lifecycle.json` receipts.
- After a high-risk stage passes its done criteria/checks, run `task-transition.py advance` and continue. The command approves completed design/testing documents and binds receipts to their content; proposal approval remains the user's decision.
- Review and complete solutions already present in the proposal under the design/test owners' handoff guidance: preserve sound decisions, fix defects, fill gaps, and implement/run required tests.
- Follow design dependencies. Delegate useful independent work when available using the generated AGENTS step-to-agent mapping and stage responsibilities.
- Finish high-risk work only after independent acceptance succeeds, `task-transition.py complete` records acceptance, and `task-index.py remove` closes the task. Process checks do not substitute for delivery.

## Corrections and Stops
- Correct in-scope defects without another approval. From any high-risk stage, run `task-transition.py return --to <proposal|design|implementation|testing>` to return to the current or an earlier responsible stage; forward jumps are rejected. Acceptance first records `needs changes` for in-scope corrections. Retry invalidated checks and independent acceptance.
- Return clears the destination and all later lifecycle receipts and resets affected proposal/design/testing documents to draft, preserving their content and historical acceptance findings. Unaffected earlier receipts remain valid.
- `return --to proposal` also sets `workflow_tier: pending`. Record the requirement revision, display and reconfirm the proposal/tier, then record the confirmed tier and approve the proposal under Task Entry Gate Rules. Resume with `task-transition.py advance`; never reuse old downstream receipts or approve the proposal automatically.
- Record returned issues and iterations in acceptance evidence. Stop and report after more than 5 unsuccessful iterations of the same issue.
- Requirement decisions or material scope changes need a blocking requirement finding, `rejected` report when acceptance is active, and revised proposal confirmation.
- Keep required evidence, tests, scope checks, and acceptance gates. If an external prerequisite blocks progress, report the concrete blocker and preserve unfinished-task state.
