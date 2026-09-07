# Delegation, handoff contracts, and the incident inbox

Three parts of one loop: a cheap coordinator prepares bounded work, the bridge
queues it on the cheapest capable seat, and anything that goes wrong is recorded
with the exact identifiers needed to find it again.

## Why a contract

A prompt is not a boundary. "Fix the retry bug" tells a writer nothing about
which files it may touch, which revision it is working from, what counts as
done, or what it must not do. Given that gap, a capable model does the helpful
thing: it widens scope. That is how a one-file fix becomes a refactor that
collides with another agent's work.

`lib/handoff-contract.js` makes the boundary explicit and machine-checkable. A
lower-tier coordinator — Codex, a script, the MCP connector — builds one; the
writer receives it rendered into its prompt.

The contract is a request record, **not a sandbox**. The generic delegation
endpoint currently accepts only read/search policy and `dangerous:false`.
Writable or additional-tool requests fail with `WRITE_SCOPE_UNENFORCED`; use
the existing managed writer workflow for implementation. Its lease coordinates
writers, but is not a host filesystem sandbox either. Provider readiness and
actual runtime policy must still be checked.

| field | meaning |
|---|---|
| `ownedFiles` | requested file scope; normalized, not OS-enforced confinement |
| `cwd` | working directory, not a sandbox root |
| `baseSha` | the revision the work was planned against |
| `taskTier` | `deterministic` → `utility` → `standard` → `complex` → `critical` |
| `model` | provider, model tier, effort, cost class |
| `toolPolicy` | requested allow/deny list; the helper does not intercept provider tool calls |
| `permissions` | filesystem is `read_only_enforced` unless the delegator set `dangerous` |
| `budget` | token/turn bounds forwarded as `providerBudget`; unsupported USD/wall-clock bounds are rejected |
| `doneWhen` | the acceptance test, stated up front |
| `nonGoals` | what the writer must leave alone |

`objective`, `baseSha`, `ownedFiles`, and `doneWhen` are mandatory. A contract
that cannot say what "done" means is not a contract, so building one throws
rather than queueing unbounded work.

## Out of bounds is a record, not a decision

`evaluateRequest(contract, request)` returns either `{decision: 'allowed'}` or:

```json
{
  "decision": "escalation_needed",
  "scopeExpanded": false,
  "kinds": ["file_scope", "tool_policy"],
  "requiredAction": "requestEscalation",
  "gate": { "approvers": ["human", "delegator"], "requiresJustification": true }
}
```

`evaluateRequest` is a pure helper: the result neither intercepts a CLI tool
call nor writes an incident automatically. Calling code must enforce and record
the decision. Nothing widens as a side effect of evaluating a request.

To actually widen, `requestEscalation` demands a structured justification citing
**observed** evidence — `wrong_result`, `empty_result`, `partial_result`,
`failed_result`, `out_of_scope_request`, `blocked_by_permission` — plus what was
observed and what is blocked without the change. "This looks hard" is not on the
list, and a missing `evidence` field throws.

Escalations touching `task_tier`, `model_tier`, or `permission` set
`gate.humanRequired`. A delegator approving one of those raises
`HUMAN_GATE_REQUIRED`; **a model may never approve its own escalation.**

Approval does not edit the contract. `applyApprovedEscalation` returns a *new*
contract with a lineage entry, so receipts written under the old one still
describe the bounds that were actually in force.

## Delegating a batch

`POST /api/delegate` accepts up to 50 tasks. For each: classify, rank, plan,
contract, queue.

Submission is capped at 60 batches per minute per client IP, with at most 50
tasks per batch checked before planning. A rejected submission returns HTTP 429,
`Retry-After`, `failureClass: bridge_request_rate_limit`, and `accepted: false`.
This is a local request-burst guard, not provider concurrency or vendor quota;
already accepted tasks and status reads are unaffected. Clients must retain a
rejected request and retry after the indicated interval, not report it queued.

- **Classify** — `classifyTask` decides the tier. A caller may declare a *lower*
  tier than the classifier, never a higher one; raising it here would be an
  ungated escalation by another name.
- **Rank** — tier first (riskiest work visible at the top), then the caller's
  `priority`, then submission order, so ranking is stable and reproducible.
- **Plan** — routed through the same `planTask` helper that backs `/api/plan`,
  and takes `plan.cheapestCapable`. A second copy of the routing policy here
  would drift from the one an operator previews.
- **Queue** — into the one existing task queue. Delegation owns no processes and
  no second queue. No capacity is not an error: the queue is durable, so the
  work waits.

Two tasks claiming overlapping paths in the same workspace fail the **whole
batch** with `409 OWNERSHIP_CONFLICT` before anything is dispatched. This is a
batch-local consistency check, not a global writer lease.

The record is persisted *before* any task becomes runnable. A crash during
submission retains a reserved task ID before queue submission. Reconciliation
can find an already-persisted task without blindly dispatching a duplicate.
Interrupted or blocked work is not automatically retried.

### Resuming elsewhere

Nothing is held in memory. `GET /api/delegations/:id` re-reads the record and
reconciles it against current task-queue state, so Cowork, the CLI, or a fresh
MCP session sees identical truth. Every entry carries
`requestId`, `invocationId` (`<requestId>:task:<n>`), `attemptId`
(`<invocationId>:attempt:<n>`), `taskId`, `receiptId`, and `contractId`.

### Outcomes

`POST /api/delegations/:id/outcome` takes `accepted` or one of the four evidence
classes with a mandatory `observed`. Only evidence opens a *pending* escalation;
nothing re-dispatches until `POST /api/delegations/:id/escalation` clears the
gate. An approval widens the contract and requeues under the new one.
Acceptance requires a `done` task and its matching receipt. Escalation cannot
replace an active task, and provider changes require a new plan. List and fleet
stats reconcile from queue state without dispatching new work.

## The incident inbox

A provider that returns prose but no verdict marker is the worst failure shape:
the pipeline correctly refuses to advance, but from outside it looks like a
crash, a timeout, and a quota block all at once. Without a record of which, the
same broken prompt gets retried for days.

`lib/incident-log.js` records the five no-verdict conditions the workflow
controller already detects — `empty_output`, `plan_not_ready`, `no_verdict`,
`blocked_verdict`, `revision_not_applied` — plus `contract_escalation` and
`delegation_escalation`. Queue failures and failed workflow tasks also report
budget, explicit context-limit, unavailable-provider, timeout, interrupted, or
generic provider failure incidents. `token_budget` means local supervisor
exhaustion, not proof of vendor quota or context capacity. Other budget signals
retain uncertainty about the source of the limit.

**Sanitized.** The offending output is exactly the text most likely to contain a
capability token, an API key, or an absolute home path, so the raw text is never
stored. Only a `outputDigest` (sha256, 16 hex) and `outputChars` are kept —
enough to tell "the same failure again" from "a new one". Summaries pass through
credential and home-path redaction and are truncated.

**Deduplicated.** Identity is the failure, not the observation: one incident per
(classification + task/receipt ids when available), with an `occurrences` counter. A
wedged workflow re-settling the same attempt does not flood the inbox.
Workflow reconciliation enriches the queue incident instead of duplicating it.
Acknowledging a specific immutable task failure remains acknowledged on repeated
observation. A later failed task has a distinct identity and opens a new incident.

Queue and workflow hooks contain logging failures so diagnostics cannot change
execution status. Direct incident API calls can still report storage errors.
The durable JSON inbox is under the configured data directory; it is not yet an
automatic export into a separate cross-chat Markdown inbox.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/delegate` | Classify, rank, contract, and queue a batch |
| GET | `/api/delegations` | List delegations |
| GET | `/api/delegations/:id` | Read one, reconciled against the queue |
| POST | `/api/delegations/:id/outcome` | Record what actually happened |
| POST | `/api/delegations/:id/escalation` | Approve or deny; `403` on `HUMAN_GATE_REQUIRED` |
| GET | `/api/incidents` | Open/acknowledged incidents |
| GET | `/api/incidents/:id` | One incident |
| POST | `/api/incidents/:id/ack` | Acknowledge with an optional note |
| GET | `/api/fuel` | Capacity view — see [Fuel gauge](FUEL-GAUGE.md#the-capacity-view-apifuel) |

MCP: `delegate_tasks`, `get_delegation`, `list_delegations`,
`record_delegation_outcome`, `decide_delegation_escalation`, `list_incidents`,
`acknowledge_incident`, `fuel_gauge`. All are covered by the same capability
token gate as every other `/api/*` route.
