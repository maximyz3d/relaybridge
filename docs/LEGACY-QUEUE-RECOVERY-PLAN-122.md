# Issue 122: bounded legacy reservation recovery proposal

Status: READ-ONLY PROPOSAL; no implementation, migration, task replay, or recovery authorization. Transfer: `RB-QUEUE-EXTERNAL-2026-09-07`. The coordinator must assign exact interfaces and file ownership before implementation. Review evidence is recorded in [the publication handoff](OWNER-STORAGE-HANDOFF-20260907.md).

## Decision and evidence boundary

**None of the six reservations can presently be proved releasable. Keep all six held.** The inspected owner foundation has no contemporaneous, trusted association from these legacy task IDs to their original attempts, installation, host/boot, and contained process domains. An APPROVE verdict on this proposal would approve its fail-closed design only; it would not supply termination evidence or authorize migration.

The coordinator reports installed main `5f55ad641ebc1d71fdf4ac2561cb487eed31810a`, v2.1.6, with active=0, queued=0, maxConcurrent=3, uncertain=6. That report concerns the coordinator's host. This external agent's connected bridge is an older, different installation; its uptime, process census, receipts, and absence of active calls cannot prove anything about those legacy executions.

Exact proposed migration membership, as supplied by the coordinator:

| Task ID | Existing state | Provider | Reported date |
| --- | --- | --- | --- |
| `t_mtobsci4_49ixsx` | interrupted | Claude | September 5, 2026 |
| `t_mtpdp9oa_mhlce1` | cancelled | Fable | September 6, 2026 |
| `t_mtptcg0j_7vwxg9` | cancelled | Claude | September 6, 2026 |
| `t_mtq2qpnd_mz8fmt` | cancelled | Codex | September 6, 2026 |
| `t_mtrbisw0_ay9mm9` | interrupted | Claude | September 7, 2026 |
| `t_mtrq26ju_qt91rj` | cancelled | Claude | September 7, 2026 |

Membership permits examination, never release. Dates, provider labels and state names are descriptive, not authority. Record bytes, digests and trusted historical ownership evidence have not been obtained from that installation in this handoff. Do not invent them.

## Existing interfaces and why they are insufficient

Source anchors below refer to main `5f55ad641ebc1d71fdf4ac2561cb487eed31810a`, not this preserved branch:

- `lib/task-queue.js:165-175`: `recoveryProof()` calls the configured `authorizeRecovery(task)` and accepts `{ authorized: true, ownerFenced: true, actor, evidenceId }`. The shape is a hook contract, not independent proof. It also participates in recovery of queued work, so it must not carry a legacy release decision that accidentally authorizes execution.
- `lib/task-queue.js:190-209`: startup treats explicit in-flight/uncertain execution and running records as potentially live; interrupted records without a recognized settlement state remain held. Cancelled records qualify when `startedAt != null`, or through an explicit uncertain/in-flight execution state. Source alone does not establish the exact fields of the six reported records. In particular, this document does not assert that all six lack `startedAt`.
- `lib/task-queue.js:362`: admission reserves `active + uncertain.size`. An empty activity probe must never override this reservation.
- `lib/task-queue.js:382-392`: `confirmStopped()` rejects in-flight callbacks, asks for proof, **rewrites the original task JSON**, deletes its uncertain reservation, and schedules pumping. It cannot implement the required immutable-record migration unchanged.
- `server.js:5412-5418`: queue construction has no `authorizeRecovery`; there is no REST/MCP exposure of `confirmStopped`. This is an integration gap, not permission to add an untrusted caller override.

The existing request ledger, incident logger, task queue and workflow controller remain the coordinator's implementations. The request ledger is already wired into REST/MCP and explicitly exposes assertion-based evidence. No second ledger, queue or incident logger is proposed.

## What the owner/storage foundation can establish

At preserved code `fc9a415445b2e3e369e243a053aab39daa51d382`, `lib/linux-physical-owner.js`, `lib/linux-owner-identity.js`, `lib/owner-control.js` and `tools/pid1-gate.js` provide a foundation for **new, correctly associated local runs**. They launch the gate as actual namespace PID1, pin process birth/namespace/boot identity before allowing execution, authenticate bounded per-run control, and retain quarantine when evidence is unavailable. Physical settlement requires the expected transport closure/drain and a successful identity-bound namespace-death probe. Missing or failed probes leave `physicalDone` unresolved.

These guarantees assume the qualified same host and trusted launch-time binding. Namespace death can establish the death of descendants contained within that namespace; it does not establish remote provider termination, external-effect reconciliation, safe replacement-writer access, or protection against equivalent OS authority. In particular, interpreting `boot_changed` against an unrelated host's pin is invalid.

`lib/linux-durable-file.js` supplies confirmed file and parent-directory barriers, atomic replacement and exclusive publication with conservative handling of ambiguous publication. It is an **unwired primitive**, not a controller lock, journal, outbox, or transaction engine. Its trusted-directory/single-writer assumptions remain required. The accepted plan requires a true cooperative flock on a retained descriptor and stable private inode; expiry, lock-file deletion/replacement or an owner diagnostic JSON do not substitute for it. The controller lock is not implemented by P1B.

## Proposed proof and migration contract

1. **Read-only inventory.** The coordinator obtains a bounded manifest from the actual installation, binding the six exact IDs, expected terminal states, SHA-256 of each original file's bytes, installation/store identity and independently established host identity. Private records remain on that host; publish only sanitized digests and evidence references. Record a consistent snapshot under qualified exclusion before any later mutation. A filename or caller-supplied store ID does not authenticate provenance.
2. **Independent verifier.** A trusted coordinator-host adapter retrieves and validates contemporaneous task-to-attempt-to-contained-domain ownership evidence from an already trusted source. An eligible proof would need that exact binding plus authenticated evidence that the entire associated domain terminated (or authenticated original host/boot association plus proof that that boot ended). No such source or association is currently established for these six records. The adapter must reject imported, cross-host, stale, fabricated, incomplete or ambiguously bound evidence. A new lock only excludes current cooperating controllers; it does not kill or retroactively own historic children. Without the binding, return `unverified` and retain the reservation indefinitely pending a separate coordinator decision.
3. **Distinct decision type.** Produce a bounded `legacy_reservation_release` decision bound to migration ID, exact task ID, original record digest, store/host identity, independently verified authority/proof reference, expected revision/predecessor, verifier schema/version and `replay:false`. This is not the current generic `authorizeRecovery` result and is not accepted as a queued-task recovery authorization. Age, PID absence, no `startedAt`, review receipts, operator assertions and `ownerFenced:true` are explicitly rejected as proof sources. Semantic provider output or `execution.state=settled` is not namespace-death proof.
4. **Append-only audit using the existing storage foundation.** Under one qualified controller lock, validate the closed event schema and append immutable evidence/decision records with deterministic event IDs, payload digests and predecessor checks. Reuse an existing suitable append-only facility if the coordinator identifies one that meets the confirmed-barrier contract; otherwise the bounded adapter must implement only these migration audit records using the existing strict file helper, not a general task/incident/requirement store. A decision becomes authoritative only after confirmed file and directory durability. Any failed or ambiguous barrier keeps its reservation held, even if bytes are visible. Do not truncate/replace an existing event or silently heal corrupt authority. Identical event IDs with identical payload are idempotent; conflicting payloads fail closed. Sanitized audit fields contain references/digests, not tokens, raw prompts, outputs, environment values or machine logs.
5. **Coordinator-owned reservation projection.** Before admission, restore all uncertain reservations, then read only validated and durably confirmed migration decisions as a per-ID release projection. Release exactly a proven reservation without rewriting the original task JSON, status, execution metadata, outputs, requirements or cancellation intent. No `submit`, execute, retry, resubmit, replay or automatic `pump()` is called by the migration operation. Normal admission can resume only through the coordinator's explicit integration after restore completes; migration itself cannot start work. Startup must not pass these records through a write-back recovery path. Byte preservation therefore requires coordination with startup reconciliation, not just an alternative to `confirmStopped()`.
6. **Crash and concurrency semantics.** A crash before durable authority leaves the reservation held. Recovery validates the manifest, authority and committed event chain before applying the projection; visibility of an incomplete append is not authority. Reconstructing the same durable release after restart is projection restoration, never replay of the task. Repeated application cannot decrement capacity twice. A changed record/store/host binding invalidates the decision and fails closed; unresolved corruption must block admission rather than silently manufacture capacity. Restored reservations may exceed the configured limit. Controller-lock loss stops mutation; a newly obtained lock does not settle any execution or writer hold. Exact lock and durability-qualification interfaces require coordinator agreement before implementation.
7. **Keep other holds separate.** Local process-domain death alone does not reconcile workspace changes, approve output, prove remote provider completion or settle billing. Do not release a writer lease/workspace-effect hold through this capacity-only migration. A safe replacement writer requires its separately satisfied ownership and workspace reconciliation contract.

No destructive action, capacity increase, global uncertainty clearing, credential change, restart, forced takeover or legacy replay is requested. If historical proof cannot be established, this proposal intentionally does not solve the capacity shortage by bypassing it.

## Required acceptance tests before implementation can be accepted

| Area | Required evidence |
| --- | --- |
| Identity and scope | Exact six-ID allowlist with independently bound store/host and byte digests; unknown seventh ID, missing historical binding, wrong host/boot, reused PID, stale proof and mismatched record all remain blocked. |
| Proof trust | Old age, empty probe, missing timestamp, a model verdict, caller `ownerFenced`, unrelated namespace death and process census never release capacity or writer leases. |
| Preservation | All six original files remain byte-for-byte identical through inventory, decisions, projection and restart. Terminal/cancel intent remains unchanged. |
| No invocation | Spies prove no task execution, submission, retry, replay, migration-triggered pumping or generic queued-work recovery authorization. |
| Audit | Closed schema; immutable records; complete reference/digest binding; malformed/truncated/duplicate/conflicting/out-of-order events fail closed or deduplicate exactly as specified; no secrets. |
| Durability | Faults at each file/directory barrier and crash before/after confirmed decision; visible-but-unconfirmed bytes do not release; recovery obtains new confirmed authority only through an explicitly specified validation/barrier protocol. |
| Restore/admission | Reservations restore before accepting work, even above configured capacity; one valid per-ID release does not affect any other record; repeated restore/release is idempotent. |
| Exclusion | Real retained flock, contention, controller death, stable inode, no ordinary-child/provider descriptor inheritance; lock loss stops writes and does not release outstanding physical holds. |
| Separate effects | Capacity proof cannot settle writer/workspace holds, remote effects, request approval, or goals. Unknown/unverified records remain blocked permanently unless qualifying proof arrives. |

These are a proposed test plan, not tests already implemented or run. Existing passing owner/storage tests do not qualify the coordinator's installed host or prove the legacy bindings.

## Exact ownership request, not an assumed transfer

Request retention of existing owner/storage responsibility for these paths only:

```
lib/linux-owner-identity.js
lib/linux-physical-owner.js
lib/owner-control.js
lib/linux-durable-file.js
tools/pid1-gate.js
test/linux-physical-owner.test.js
test/owner-control.test.js
test/pid1-gate.test.js
test/linux-durable-file.test.js
docs/LINUX-DURABLE-FILE.md
```

Request these **two new implementation/test paths only if the coordinator transfers the bounded verifier**:

```
lib/legacy-recovery.js
test/legacy-recovery.test.js
```

Use this existing proposal document, `docs/LEGACY-QUEUE-RECOVERY-PLAN-122.md`, for its contract. Implementation remains blocked on exact trusted-proof, controller-lock, audit-authority and queue-projection interfaces. No changes to the above source/test paths are made in this handoff.

The coordinator retains `lib/task-queue.js`, `test/task-queue.test.js`, `lib/workflow-controller.js`, `lib/workflow-pipeline.js`, their tests, `lib/attempt-lifecycle.js` and its test, `server.js`, `mcp/server.mjs`, request-ledger/incident modules and their tests, and every production recovery/exposure/admission integration. Any required shared-lifecycle edit needs a separate exact transfer. Persistent goals remain outside this assignment. The five reserved no-HEAD file-review packet files in `RB-REVIEW-PACKETS-EXTERNAL-20260907` are not claimed or edited.
