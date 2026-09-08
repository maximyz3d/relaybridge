# PR120 + PR121 coordinator release candidate

## Immutable inputs and ownership

- Main input: `7c0ccd41360b1c2157e3f4d74336afeb7fd7b655`.
- PR120: `3a8a62eee371fad36d06d9aafc469d280fe85d14`.
- PR121: `6b38c5863c0163f1a029760dc5719cfcd37e3bd5` (external code `0089374d60d38f1b516da7a6fb87f25fcbba2674`).
- Local merge base: `7ca74d9311b0a47ae85403cd460a6e7bd7e93e77`.
- Pipeline `wf_mtrvnnyh_781de9e112bf`; Claude Opus/high planner task `t_mtrvobjc_aheirc` completed with PLAN_STATUS READY.
- Root Codex is sole writer. PR121 queue/controller/ledger/incident modules are frozen inputs.
- Integration files: server.js, mcp/server.mjs, lib/provider-failure.js,
  lib/workflow-pipeline.js, their existing tests, docs/TASK-QUEUE.md and this packet.
  Scope clarification: add lib/request-contract.js for one shared REST/MCP schema,
  and test/prompt-file-cli.js for a harmless interrupted tool-prose regression fixture.

## Changes and plan refinements

1. Supervisor-stopped raw stdout is not vendor evidence. Local token-budget receipts
   retain token-budget accounting even when interrupted task/tool prose mentions 429.
   Actual structured HTTP429 remains account-limit evidence. Retry-after extraction
   excludes interrupted prose; supervisor classification prevents narrative auth quarantine.
2. Queue/controller shutdown hooks precede child termination; admin shutdown checks
   active work. Mutating API requests are refused during shutdown.
3. All expired writer locks fail closed, including legacy locks after restart.
   This deliberately tightens the planner's marker-only suggestion: legacy expiry
   is no better evidence of termination. No caller-asserted fencing API is added.
   Native read-only scout accepted this minimum safety policy and documented the
   availability cost: expired manual locks need future trusted recovery.
4. Bounded attributed request evidence is wired through REST/MCP with immutable
   revision-specific coverage. Evidence does not auto-approve or advance workflows.
5. MCP task submission forwards scheduling/dependency/correlation fields.

## Incident evidence

At 2026-09-07 23:23:29 UTC, receipts `rcpt_mtrv9s6c_456a5e3a` and
`rcpt_mtrv9mvi_8e247de2` recorded supervisor token_budget, exit143, total42430
against18000, no API status, errors or retries; the old accounting path recorded
rate_limited. This is bridge supervision evidence, not a verified vendor quota.
Do not blanket reset account cooldowns or claim provider usage availability.

## Verification

Closing-review revision: Claude task `t_mtrwkf8y_sjmux0` requested explicit busy/idle
administrative shutdown tests. Root Codex owns the bounded test/doc-only repair;
the safe pipeline was intentionally cancelled for the documented Codex-only revision
loop, not marked complete or escalated to a Claude writer. Existing verdicts remain.
Added a live busy409/still-healthy assertion, idle200/process-exit assertion and a
source-order regression guard; existing queue tests cover stopping dispatch timers.
Fresh read-only Claude closing review follows the frozen repair commit.
The stricter expired-lock recovery fast-follow is GitHub issue #122, satisfying the
reviewer's alternative to enabling unproven recovery. Root acknowledges the shared
schema/fixture/MCP scheduling scope amendment as normal coordinator integration.

- Combined unmodified baseline: 679 passed, 2 skipped, 0 failed (681 tests).
- Focused classifier/pipeline after first repair: 38 passed, 0 failed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- Final integration suite after shutdown-test revision: 681 passed, 2 skipped,
  0 failed (683 tests); `/tmp/relaybridge-shutdown-revision-20260908.log`.
- Fresh Claude reviews: pending; see coordinator implementation/review artifacts
  bound to the final commit. This document is not approval.

Reviewers have Read/Glob/Grep, not Bash. Read the actual files and supplied immutable
Git facts; lack of shell access is not a code finding. Require a complete explicit
verdict, never infer acceptance from a partial response or tool silence.

## Not delivered / blocked

- PR118: conflicting broad branch, failing CodeQL check; excluded pending triage.
- Automatic restart recovery and confirmStopped remain unconfigured pending trusted
  process-tree/owner fencing. Exit/grace timeout is not such proof.
- Git-unborn/uncommitted snapshot review fallback is not solved by cooldown fixes.
- Full UI request coverage editing, fuel telemetry from every vendor, workload
  fairness and remaining original user requests are not all complete.
- Main merge and runtime installation are separate gates, not implied by CI.

## Upgrade / rollback

Prepare an immutable reviewed main checkout and dependencies before downtime. Verify
no active providers, queued dispatch or terminals; preserve workflows and data. Hold
the autostart lock with child inheritance disabled and pause the watchdog through the
upgrade. Stop the exact old bridge, update CLI/MCP/start paths together, start the new
build, verify authenticated health and a real bounded Claude call. Reconnect old MCP
clients; do not weaken build/receipt-store identity checks. Restore prior runtime
paths on a failed startup; never replay uncertain tasks or erase state to recover.
