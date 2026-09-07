# R13–R16 external lane evidence

Transfer: `RB-QUEUE-EXTERNAL-2026-09-07`.

## Ownership and revisions

- Contract: `docs/PARALLEL-QUEUE-HANDOFF.md` at
  `32838571fa3d2f6397f99e3d4330968f49e741bd`.
- Starting main: `7c0ccd41360b1c2157e3f4d74336afeb7fd7b655`.
- Starting base/PR120 head: `32838571fa3d2f6397f99e3d4330968f49e741bd`.
- Branch: `external/queue-reliability-20260907`, isolated Linux-native worktree.
- Stacked PR base: `codex/control-center-repair`. Depends on open draft PR120.
- Initial frozen implementation: `afc70ff31131231771747e099aedeff5ebfd2635`.
- Final code after timer corrections: `0089374d60d38f1b516da7a6fb87f25fcbba2674`.
- PR120 advanced during work to `fabba4ddf3d1df12e12615a3d6bba4267c12c772`
  through coordinator-owned prompt/config/docs changes. Ownership stayed unchanged.
  A Git merge-tree calculation found no conflicts; the feature branch was not merged
  or rebased, and combined-runtime integration remains the coordinator’s check.
- Only the external lead Codex wrote repository files and may publish this
  branch/PR. Subagents performed bounded read-only reviews and did not write GitHub.
- No server, UI, provider/routing, quota, release, shared package or workflow-store
  implementation files were changed.

## Requirement coverage and delivery boundaries

| Requirement | Delivered code and fixtures | Remaining boundary |
| --- | --- | --- |
| R13 | Admission-backoff aggregate regression; additive ready/deferred/blocked/uncertain counts; no conversation-based activity; retry only with affirmative pre-invocation evidence; real quota/auth remain terminal | Server global/provider admitted-execution counts and process lifecycle proof belong to coordinator |
| R14 | Persisted due time/deadline/provenance; existing-task dependencies; fair eligible dispatch; cancel/shutdown cleanup; opt-in, fenced-owner, never-started recovery; uncertain reservations; no interrupted writer replay | Trusted recovery/fencing and shutdown hooks must be wired in server; single-owner assumption, no exactly-once claim |
| R15 | New minimal request ledger with bounded sanitized references, immutable-revision assertions, independent milestones, adverse-evidence history and idempotency; optional controller links; existing queue/incident correlations reused | Controller injection and authenticated REST/MCP coverage operations remain unwired; no feature acceptance inferred from task/workflow success |
| R16 | Separate admission/auth/quota/cooldown/dependency/approval/unknown-capacity/budget/context/partial/empty/interruption explanations; sanitized incident/task-list/conversation reporting; partial APPROVE marker rejected; uncertain writer lease-release guards | Server process-tree fencing and pipeline expiry-only lock reclaim still need coordinator changes |

`lib/request-ledger.js` and `test/request-ledger.test.js` were the only new module
and test paths accepted by the external lead after the bounded Astra persistence
review. Existing workflow artifacts are a closed set with no public generic
write extension. The ledger stores only independent requirement assertions and
references; no duplicate workflow store was introduced. Detailed contracts and
integration requirements are in `docs/TASK-QUEUE.md`.

## Planning provenance and limitations

The original workflow `wf_mtri7r8q_aadbed9429eb` and preserved planning task
`t_mtri8l1i_4t8pl2` were not resumed, retried or recreated. Their analysis and
corrections were read from the GitHub handoff. This is transferred planning
evidence, not a new provider approval or runtime writer lease.

Local intake used context bundle `ctx_dff8647fa941f4966d08`, receipt
`rcpt_mtrqe35m_dfad9673`, and checked existing workflows before dispatch.
The connected bridge is a separate Linux-native environment; Shane's
`AI_WORKFLOW.md` and `WORKSPACE_MAP.md` were unavailable locally. Applicable
repository `AGENTS.md` and the Codex–Claude pipeline skill were read.

One explicitly linked successor, `wf_mtrqg68v_750fcfc7a25b`, queued Fable
heavy/high planning task `t_mtrqh6k8_an2u7z`. It remained in admission backoff
behind existing provider work. The lead intentionally cancelled this queued
successor, then read back `phase=cancelled`, no writer lease and no next actions.
No replacement workflow or managed writer lease was created. Implementation
continued under the user's explicit external-lane authority with the original
planning evidence, corrected local plan, and a single local Codex writer.
The new Fable planning attempt returned **NO VERDICT**. Other provider work was
neither cancelled nor restarted.

An exact RelayBridge Astra scout request (`gpt-6-astra`, high) was rejected before
invocation as `model_unavailable`. Native Codex Astra read-only analysis was used
instead; the bridge model configuration was not changed.

## Independent review evidence

Read-only queue review of commit `622a6f5` identified three regressions: mutable
submission aliases changing authority, a late exception reserving a settled slot,
and malformed restart records crashing scheduling. All were corrected with
passing dedicated fixtures in `afc70ff`.

Native Astra's ledger review identified expanding-redaction/reload inconsistency,
write/load byte-cap mismatch, unsanitized loaded fields, credential-shaped IDs,
fractional capacities, and mutable revision references. These were corrected
with focused fixtures before the frozen implementation commit.

A fresh native Astra review of `afc70ff` reproduced two timer defects: a due
admission retry lost its deadline wakeup behind occupied slots, and repeated
uncertain-writer reconciliation kept resetting the lease heartbeat. Commit
`0089374` fixes both with deterministic regression tests.

The fresh Claude final-review request explicitly selected Sonnet/high and frozen
commit `afc70ff31131231771747e099aedeff5ebfd2635`. It was rejected by admission
before any model invocation. Independent Claude final review is **NO VERDICT**,
not approval. The PR must remain draft pending coordinator review/integration.

| Attempt | Exact identity / receipt | Outcome |
| --- | --- | --- |
| RelayBridge Astra scout | Request/invocation `mcp:6392549f-a56e-4cb6-8680-0dda17ee98d7`; attempt suffix `:attempt:1`; receipt `rcpt_mtrqgger_2d2230e1`; transport `rcpt_mtrqggf7_99e3ed14` | Validation `model_unavailable`; physical attempts 0; no model invocation |
| Claude Sonnet/high final review | Request/invocation `mcp:8b3338f9-59e4-4efc-97d6-4fda6e6e33ba`; attempt suffix `:attempt:1`; receipt `rcpt_mtrra4bb_8c4baf96`; transport `rcpt_mtrra4cb_336a9a6a` | HTTP 429 `admission_limit`; physical attempts 0; no model invocation; NO VERDICT |

Exact receipts were fetched by ID. No newest-receipt matching, private provider
transcripts, tokens, runtime stores or raw machine logs were published.

## Verification

- Before changes: `npm test` — 616 passed, 2 skipped, 0 failed.
- Counter regression reproduced `queued=0` while one task was durably queued in
  admission backoff; corrected counter commit `54ed736` passed 32 focused tests.
- Durable queue commit `622a6f5` passed 48 focused queue/incident tests.
- Final focused command:
  `node --test test/task-queue.test.js test/task-incident-integration.test.js test/incident-log.test.js test/workflow-controller.test.js test/request-ledger.test.js`
  — 110 passed, 0 failed.
- Final `npm test` on `0089374` — 670 passed, 2 skipped, 0 failed
  (672 tests total).
- `npm audit --omit=dev` — 0 vulnerabilities.
- `git diff --check` passed.

Fixtures used fake providers, fake clocks and temporary stores; the feature was
not tested by restarting or modifying the shared bridge. Provider calls were
read-only planning/review attempts subject to existing admission safeguards.

## Handback

Outstanding integration: trusted `authorizeRecovery` / authenticated
`confirmStopped`, queue/controller shutdown, request-ledger injection and routes,
authoritative process-tree fencing, and prevention of expiry-only writer-lease
reclamation in `lib/workflow-pipeline.js`. See `docs/TASK-QUEUE.md` for exact
interfaces. The original coordinator owns those files, final review, merge order
and retargeting. The external lead stops after handing back this lane.

**NOT MERGED / NOT DEPLOYED.** No main/coordinator push, force-push, installation,
credential change, deployment or shared bridge restart was performed.
