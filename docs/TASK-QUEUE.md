# Task queue and requirement evidence

## Counts and admission

`stats()` preserves `active`, `queued`, and `maxConcurrent`. `active` counts
outstanding queue executor calls, including a running task whose cancellation
was requested. It never counts conversations. It is not a measurement of vendor
subscription capacity or the server's separate global/provider admission count.

`queued = ready + deferred + blocked`. Deferred includes admission backoff and
`notBefore` scheduling; blocked includes unresolved dependencies. `uncertain`
counts additional reserved slots whose former execution might still be alive.
Dispatch requires `active + uncertain < maxConcurrent`. An empty activity probe
does not change either reservation. No quota or provider-routing logic is changed.

Only HTTP 429 with `failureClass: 'admission_limit'`, affirmative
`model_invocation: false`, and no contradictory invocation/count evidence is
automatically retried. Authentication, observed vendor quota, and ambiguous
admission responses remain terminal. Unknown capacity is not zero, and configured
token budgets are not subscription allowances.

Admission waits persist their count, initial time, absolute deadline, last
rejection receipt, and `nextAttemptAt`. Backoff grows from one second by 1.7 to a
30-second ceiling, with a default one-hour total wait. The queue expires a wait
without another provider dispatch at its deadline. Eligible work is visited in
stable creation order; a deferred or blocked item does not block independent work.

## Durable backlog

Existing per-task JSON files remain the task store. Schema version 2 adds
execution certainty, dependency IDs, scheduling, recovery provenance and request
correlation. Provider execution controls, including explicit invalid values,
remain subject to the executor's validation. `requestId`,
`expectedCwdIdentityHash` and `expectedCwdPolicyId` reach that executor unchanged.

Submission accepts these additive fields:

```js
queue.submit({
  kind: 'claude', prompt: 'bounded work',
  notBefore: 1788816000000,       // optional epoch milliseconds
  dependsOn: ['t_existing_1'],   // optional, at most 64 distinct existing IDs
  recovery: {                  // optional, read-only work only
    mode: 'never-started', actor: 'operator', evidenceId: 'authorization_1'
  },
  requirementIds: ['R14'],
  correlation: { requestId: 'request_1', runId: 'wf_1' }
});
```

Dependencies must already exist at submission; forward references, self-edges
and duplicates are refused. This makes submitted dependency graphs acyclic.
Missing dependency files block recovery; a failed, cancelled or interrupted
dependency fails dependent work. A dependency's `done` status establishes only
task execution success, never feature acceptance or approval.

Cancellation removes queued work and clears obsolete timers. A running
cancellation retains its slot until its executor responds; a late response may
record execution settlement but cannot resurrect the cancelled task.
`shutdown()` is idempotent, stops dispatch and clears timers while preserving
durable waits and live execution reservations. Submission after shutdown fails.
Inject `now`, `setTimeout` and `clearTimeout` for deterministic scheduling tests.

## Restart and execution uncertainty

Before dispatch, a task is durably marked `in_flight`. A definitive pre-admission
rejection can restore `not_invoked`. A normal final executor response records
`settled`. An exception or silent handler records uncertainty and reserves
capacity. `settled` preserves the existing final-response contract; it is not
independent proof that every descendant process has terminated.

Recovery requires BOTH persisted `recovery` authorization and a trusted
constructor callback. The callback is synchronous, receives a defensive task
copy, and must return affirmative evidence:

```js
authorizeRecovery(task) {
  // The host must verify the prior owner/process fencing and current authority.
  return { authorized: true, ownerFenced: true,
    actor: 'host-supervisor', evidenceId: 'verified-fence-1' };
}
```

This is a host interface, not a request-body permission switch. Missing, empty,
partial, throwing or asynchronous evidence never authorizes recovery. Eligible
records must be schema 2, explicitly opted in, valid, read-only, never started,
and either `never_started` or `not_invoked`. Retry deadlines and the original
execution body survive recovery. Everything else remains conservatively
interrupted; interrupted writers never automatically replay, even after fencing.

`confirmStopped(taskId)` consults the same trusted callback to record fencing and
release an uncertain reservation for a terminal task. It refuses while that
queue's execution callback remains in flight. It never resubmits the task.
Repeated startup reconciliation on a live queue is inert.

This is a single-owner queue. Atomic file replacement, reserved task IDs and
in-process dispatch exclusion are not cross-process exactly-once execution.
Recovery authorization must fence the prior owner before a successor dispatches.
Atomic rename protects record integrity; power-loss/fsync guarantees are not
claimed. Corrupt legacy task records are not automatically executable.

## Request coverage

`createRequestLedger()` in `lib/request-ledger.js` stores requirement definitions,
explicit workflow links and evidence references. It does not duplicate task,
workflow, incident, receipt or provider-output stores. The existing workflow
pipeline has a closed artifact set and phase-specific mutations; it cannot host
this independent coverage through its public API.

Create a request with `create({requestId, actor, requirements})`, associate it with
`linkWorkflow(requestId, {runId, actor})`, and append an assertion using:

```js
ledger.record('request_1', {
  eventId: 'evidence_1', requirementId: 'R14', actor: 'tester',
  revision: '<full 40-character commit SHA or 64-character artifact digest>',
  milestone: 'tested', outcome: 'confirmed',
  evidence: [{ kind: 'test', ref: 'test_run_1' }],
  correlation: { runId: 'wf_1', taskId: 't_existing_1', receiptId: 'receipt_1' }
});
```

Milestones are independent: `planned`, `implemented`, `tested`, `approved`,
`merged`, `deployed`. Outcomes are `confirmed`, `rejected`, or `missing`.
Confirmation requires evidence; rejection/missing requires a reason. These are
attributed assertions, not independently verified external facts. Caller
authentication and authority remain the integrating control surface's job.
No task or workflow transition automatically confirms any milestone. No
aggregate `complete` flag is exposed. Mutable revision names are refused.

`get(requestId, {revision})` projects the last explicit assertion for each
requirement/milestone on that immutable revision, otherwise `unknown`. Earlier
adverse evidence remains in history. Event IDs are idempotent; conflicting reuse
fails. Records are sanitized, bounded, atomically replaced and defensively copied.
Default capacity is 200 requests, 1,000 events per request and 32 MiB; configurable
bounds must be positive integers within supported limits. Capacity refuses new
data instead of silently dropping acceptance history. Corrupt/incompatible
ledgers fail visibly without replacing evidence with an empty store.

Optional controller integration exposes `createRequest`, `linkRequest`,
`recordRequirementEvidence`, `getRequest` and read-only `requestLinks` in views.
The controller reports `REQUEST_LEDGER_UNAVAILABLE` without a configured ledger.

## Incidents and no verdict

Task, receipt, workflow and requirement references accompany classified incidents.
Authentication, observed quota, admission, cooldown, dependencies, required
approval, unknown capacity, local budget, provider context, partial/empty output
and interruption have distinct explanations and safe next actions. The incident
inbox keeps its existing bounded deduplication and acknowledgement semantics.
Only sanitized text, output digest/length and correlation metadata enter incidents;
failed conversation entries and task-list errors are sanitized too. Full task
results remain in the existing private task store for deliberate inspection.

Controller reconciliation rejects partial/failure flags even if output contains
`REVIEW_VERDICT: APPROVE`. Missing, cancelled-live, malformed or interrupted writer
execution evidence prevents explicit lease release. Interrupted read-only retry
also requires recorded fencing. Missing activity is never used as proof.

## Required coordinator integration

Coordinator integration status (2026-09-07 release candidate; deployment is a separate gate):

1. In `server.js`, configure `authorizeRecovery` only after implementing exact
   owner/process fencing and revalidating authority. Without it, automatic restart
   recovery remains disabled. Expose authenticated `confirmStopped` only with that
   trusted evidence boundary; do not accept a caller's assertion as process proof.
2. Implemented: queue/controller shutdown hooks run before child termination.
   Administrative shutdown refuses active tasks/processes/sessions unless explicitly forced.
3. Implemented: authenticated `/api/requests` create/list/read, workflow linking and
   evidence recording; MCP `create_request`, `list_requests`, `get_request`,
   `link_request_workflow`, `record_requirement_evidence`. REST and MCP share bounded
   schemas. Milestones are attributed assertions, never automatic acceptance.
   `submit_task` now forwards dependencies, not-before time and requirement correlations.
   Browser coverage editing remains outstanding.
4. The server's global/provider counts and response-driven admission release are
   separate. Supply authoritative lifecycle evidence distinguishing process-tree
   termination/fencing from an exit grace period with surviving descendants.
5. Implemented: ALL existing expired writer locks fail closed with
   `WRITER_EXECUTION_UNCERTAIN`, including legacy markerless locks and restart.
   Expiry never proves termination. Expired manual/unbound locks can remain stranded;
   do not delete them or claim token-owned cancellation works after expiry.
   Operator recovery with authoritative owner fencing remains outstanding.

The external R13–R16 lane did not change server/pipeline integration files; the
coordinator integration adds the delivered surfaces above without enabling recovery.
