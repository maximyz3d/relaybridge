# Execution ownership and declared write boundaries

RelayBridge has a gated execution-owner journal, immutable task settlement records, and explicit workflow recovery APIs. Native Claude/Codex workflow execution and a complete provider write-set sandbox are still awaiting qualification. The production backend currently qualifies storage and local process-control primitives only; it refuses unsupported provider profiles before dispatch.

This setting is separate from usage continuity. Usage protection, automatic handoff, dynamic supervision and the assessor are already enabled by default, with a 5% reserve configurable between 2% and 5%. Execution ownership defaults off:

```json
{
  "_ownership": {
    "enabled": false
  }
}
```

Omitting `_ownership` also means disabled. The setting is read when the server constructs its backend, so changing it requires a coordinated restart after active work is handled. Setting it true is not evidence that a provider is supported and does not silently wrap ordinary runs.

## Current production behavior

When ownership is enabled, startup qualifies Linux storage and retained process control before opening the listener or pumping the task queue. Qualification checks private directories, supported local filesystems, native helper identities, exclusive controller locking, strict durability operations, and a disposable Node process inside the gate. Unsupported platforms, filesystems or helpers fail closed; there is no unwrapped fallback.

The production qualification currently has scope `storage_only`. It does not authorize a Claude, Codex or other native provider launch. A separate test capability authorizes only one exact disposable Node/script/argv/environment/cwd tuple and reports `fixture_only`. Passing that fixture, or a bounded Claude Read/Write/Edit experiment, does not qualify a general native workflow profile, account/auth mapping, descendant containment, or staged filesystem/network policy.

New owned revisions are explicitly requested with `ownedLease: true` on `POST /api/workflows/:runId/revision/start`, or on the local MCP tool `start_pipeline_revision`. They require an eligible full-permission provider revision and a qualified backend/profile. In the present production configuration, unsupported provider requests refuse before dispatch. Omitting `ownedLease` preserves the existing revision path; it does not retroactively enroll the process in the new journal.

Existing owned journal records are restored even if new owned launches are disabled. All held reservations are restored before the queue resumes, and matching workspace writer holds block ordinary successor writers. Disabling ownership does not clear reservations, stop tracking an unresolved owner, or authorize a replacement writer. Corrupt, foreign, legacy, version-incompatible, or ambiguously published records are not converted into release evidence.

## What an owner proves

A new owner binds the exact workflow lease, canonical workspace, task/reservation, provider/account, request/invocation/attempt, execution identity and one immutable owner set before the provider may proceed. Recovery does not select a different current account or adopt a PID from a request.

Physical task capacity is released only after trusted process-tree settlement, wrapper exit, both output streams ending, exact namespace identity/death evidence, durable journal publication, and the corresponding durable projections. A semantic result, timeout, cancellation request, expired lease, empty process list, or caller-provided `ownerFenced` value cannot provide that authority.

There is a narrower irreversible `never_permitted` decision for an owned launch that has no durable permit. It permanently prevents that owner from later proceeding and can release only the writer lease. Physical task capacity remains held until independently established physical settlement. An absent process or prepared-only restart is not silently treated as physical completion.

Normal successful finalization also requires complete accepted revision output and exact task evidence. A provider's claim that it finished is insufficient. Recovery rolls forward committed decisions idempotently; it never replays the provider.

## Inspect and recover an enrolled writer

These local REST routes are protected by the bridge capability token. They are not a force-release interface, and no raw journal/control/PID proof is exposed.

`GET /api/workflows/:runId/owner-recovery` is an inert status read. It does not dispatch, signal a process, generate proof, reconcile the workflow, or clear a reservation. Responses identify a state:

| State/reason | Meaning |
| --- | --- |
| `unavailable_unbound_owner` | The workflow has no trusted enrolled owner; this includes legacy/manual leases. |
| `unavailable_unqualified_backend` | The qualified recovery backend is unavailable. |
| `awaiting_physical_proof` | Physical evidence is not durably sufficient. |
| `ready_for_recovery` | Durable physical proof is present; the mutation must still satisfy lease expiry and identity/revision checks. |
| `application_pending` | An immutable decision exists and its durable projections require exact roll-forward. |
| `released` | The committed decision and required projections were applied. |

An eligible status response includes `ownerId`, `bindingHash`, `ownerRevision`, `workflowRevision`, and `ownerSetHash`. Use those exact values in an explicit recovery request. The mutation also requires `X-RelayBridge-Expected-Build-Id` and `X-RelayBridge-Expected-Receipt-Store-Id`, in addition to the capability header, matching the current bridge identity from `/api/health`.

`POST /api/workflows/:runId/owner-recovery` accepts exactly:

```json
{
  "ownerId": "<ownerId from status>",
  "recoveryId": "operator-recovery-unique-id",
  "expectedOwnerRevision": 4,
  "expectedBindingHash": "<bindingHash from status>",
  "expectedWorkflowRevision": 12,
  "expectedOwnerSetHash": "<ownerSetHash from status>",
  "reason": "The exact enrolled writer is stopped and its lease has expired."
}
```

The numeric values above are illustrative; take fresh exact values from the status read. `recoveryId` is chosen once for that intent. The matching lease must actually be expired, and the owner/workflow revisions and entire binding must still agree. Unknown fields, asserted proof, different owners, changed bindings and stale identities/revisions are rejected. An exact completed retry returns the same decision without another dispatch. When a request may already have committed, inspect its state and preserve its original intent; do not generate a new ID or adjust revisions to bypass a pending decision.

There is no age-based recovery, automatic legacy migration, PID adoption, `force` flag, global uncertainty reset, or reservation-clearing option. Expired manual/legacy leases and old uncertain task records remain held where trusted evidence is unavailable.

## Declared write paths

`dangerous: true` still authorizes provider filesystem writes under the existing provider permission model. Prompt-declared filenames alone do not confine those writes. Inspect the actual worktree diff, including existing dirty and untracked files; provider prose is not a boundary verdict.

Requests may carry `allowedWritePaths`, but execution support is not yet enabled. The validator recognizes a bounded list of unique exact repository-relative files; aliases, globs, traversal, control paths and special-file targets are rejected. Any otherwise valid explicit list, including an empty list, currently returns `filesystem_contract_unsupported` before invocation, with `model_invocation: false` and zero physical attempts. The boundary is never silently converted into prompt guidance or dropped.

The candidate-staging module copies a bounded complete current working tree baseline, including dirty tracked and untracked files, into a private area outside the workspace. It records manifests, compares actual final create/modify/delete/restore changes, and quarantines out-of-set changes, source drift, incomplete scans and failed runs. It rejects unsafe aliases/links and never uses hardlinks back into the original workspace. It does not promote a candidate or apply a patch to the original. Its evidence covers the final filesystem difference, not an assertion that no transient forbidden operation occurred.

Production write-set support still requires a closed native launch profile that combines the gate with original-workspace read-only enforcement, staged write exposure, descendant and filesystem/network containment, pinned provider/account/auth inputs, and receipt/result integration. Unsupported requests continue to refuse until that complete path is independently validated.

## Remaining acceptance work

Issue85 remains incomplete until a supported real-provider execution path enforces the declared boundary independently of provider compliance and reports actual changed paths and boundary outcome, including concurrent disjoint writer tests. Candidate staging and explicit refusal are foundations, not a claim that dangerous native runs are confined.

Issue122 remains incomplete for general native and legacy/manual recovery. The new journal/projection path has local fixture coverage for exact ownership, active/uncertain/restarted states, immutable decisions and non-overlapping recovery. Actual native workflow profile qualification and the end-to-end production path still require independent validation. Existing legacy owners must not be declared recoverable based on those new-protocol tests.


A failed enrollment before a durable owner reference exists remains held. This
includes cancellation while the owned task is still queued and interrupted
preparation/binding. The workspace fence still applies after restart. There is
no inferred zero-launch release or operator force switch for this gap. Native
workflow enrollment stays unavailable until the complete profile and lifecycle
are qualified. Missing journals with persisted owned task markers refuse startup.
