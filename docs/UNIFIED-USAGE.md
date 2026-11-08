# Unified usage: included API credit agent

This build contains an API agent for included provider API credit. It is
read-only by default; an API-only unified run with an exact write contract can
also edit existing files (see [API writer segments](#api-writer-segments)).
It is **implemented but not activated**: production has no qualified provider,
so no request is ever dispatched to the Claude Messages or OpenAI Responses
API. Nothing in environment variables, settings, HTTP, MCP or a profile can
change that. Funding qualification, and with it activation, needs a reviewed
code change; see [Activation prerequisites](#activation-prerequisites).

Read [account routing](ACCOUNT-ROUTING.md) and [included API credits](ALLOCATED-CREDIT.md)
first. Those docs explain funding profiles and the 2% policy.

## What exists

| Part | Module | Notes |
|---|---|---|
| Wire formats | `lib/api-agent-wire.js` | Claude Messages and OpenAI Responses. Fixed HTTPS endpoints and `redirect: 'error'`. |
| Read-only tools | `lib/api-agent-tools.js` | `read_file`, `list_dir`, `search` (literal substring) |
| Patch tool | `lib/api-agent-patch.js` | `apply_patch` on exact allowed existing files, journaled in the checkpoint |
| Durable checkpoints | `lib/api-agent-checkpoint.js` | `DATA_DIR/api-agent/<runId>/`, directories 0700, files 0600 |
| Agent loop | `lib/api-agent-run.js` | Multistep tool loop with no turn, token or time budget |
| Qualification | `lib/api-agent-qualification.js` | Branded authority. Production has no adapters. |
| Admission and receipts | `lib/api-agent-dispatch.js` | Binds the decision, credential and workspace, then runs one attempt |
| Routing gate | `lib/funding-routing.js` | Decision version 2 includes `qualification` in the hash |

`server.js` constructs exactly one authority with
`createQualificationAuthority({ adapters: Object.freeze({}) })`. Its effects:

- The OpenAI and Claude decisions both report `actual: "none"` with `blockedReason: "grant_only_funding_unverified"`.
- They also report `qualification: null` and `apiTransportImplemented: true`.
- The credential thunk is never called, so the reserved key is not read for API execution.
- No `api-agent` checkpoint directory is created.

The `included_api_credit` branch in `executeOneShot` is unreachable in
production. It is kept so the end-to-end wiring can be reviewed.

`GET /api/allocated-credit` reports `apiTransport: "implemented_not_activated"`.

The one exception is the separate `authorized_prepaid` route. A valid
owner permit for one OpenAI profile admits the read-only Responses agent for
one-shots (see [owner-authorized prepaid](ALLOCATED-CREDIT.md#owner-authorized-prepaid-openai-only))
and for unified-run entries that opt in (see [Prepaid fallback](#prepaid-fallback)).
While the permit is valid, the status reports
`apiTransport: "owner_authorized_prepaid_supervised"`. The permit's
`authorizationId` and hash are bound into the checkpoint as `fundingPolicy`,
and the model must be one the permit lists, for new runs, resumes and linked
attempts. Prepaid exhaustion is terminal and never carries
`reserve_release_evidence`.

A request cannot assert its own qualification. Fields such as `qualification`,
`qualificationId` and `apiQualification`, whether inside or beside `funding`,
are rejected with `invalid_funding_envelope` before admission.

## Gate order

For `route: "included_api_credit"`, the checks run in this order:

1. `credit_preference_off`
2. `api_credential_unbound`: the profile has no `credentialRef` or `creditPeriod`.
3. `grant_expired`: the current time is outside the credit period.
4. `grant_only_funding_unverified`: there is no authority, or no adapter for the provider.
5. `api_qualification_invalid`: the authority or result is unbranded.

Each provider qualifies independently. A balance, screenshot, periodic check,
key or local budget is never treated as grant-only enforcement.

## Run semantics

- **Models.** Only concrete API IDs in the code-owned table are accepted. CLI
  aliases are never translated and models are never substituted.

  | Model | Provider | Efforts | Effort wire |
  |---|---|---|---|
  | `claude-opus-5-5` | Claude | `low`, `medium`, `high`, `xhigh`, `max` | `output_config.effort` |
  | `claude-sonnet-5-5` | Claude | `low`, `medium`, `high`, `xhigh`, `max` | `output_config.effort` |
  | `gpt-6-astra` | OpenAI | `low`, `medium`, `high`, `xhigh`, `max` | `reasoning.effort` |
  | `gpt-6.1-sol` | OpenAI | `low`, `medium`, `high`, `xhigh`, `max` | `reasoning.effort` |
  | `claude-haiku-4-5-20251001` | Claude | none | none |
  | `claude-sonnet-4-5-20250929` | Claude | none | none |
  | `gpt-5` | OpenAI | `minimal`, `low`, `medium`, `high` | `reasoning.effort` |
  | `gpt-5-mini` | OpenAI | `minimal`, `low`, `medium`, `high` | `reasoning.effort` |

  The last four are earlier entries kept unchanged. An unmapped model, including
  any CLI alias, fails with `api_model_unmapped`. If the provider reports a
  different model, the run stops with `api_model_mismatch`; that turn was billed
  and is not acted on.
- **Effort.** An effort is sent only on the entry's wire and only if the entry
  lists it; anything else, including `ultra`, fails with
  `api_effort_unsupported`. Entries without efforts send no effort control.
- **Per-request output maximum.** `max_tokens` and `max_output_tokens` are the
  ordinary per-request maxima the APIs require; they are not run budgets.
  - Reaching one ends the run with `output_limit_reached`. This covers Claude
    `max_tokens` and OpenAI `incomplete`.
  - Claude `pause_turn` is re-sent.
- **No artificial caps.** There is no turn, token or wall-clock cutoff. The
  supervisor runs with `stallAction: "notify"` and no hard deadline. Progress
  is reported per turn; cancellation goes through the caller's signal or the
  attempt lifecycle.
- **Tools.** The tools are read-only and stay within the request's allowed cwd.
  - Every path component is checked with `lstat`.
  - These are denied: symlinks, hardlinked files, FIFOs and devices, dot-paths, secret-like names, and `DATA_DIR`, the config file and the token file.
  - Files are opened with `O_NOFOLLOW` and checked again with `fstat`.
  - If the workspace identity changes, the run stops with `cwd_identity_changed`.
  - Before any bytes are returned, `read_file` and `search` scan the whole file
    from one open descriptor. A file containing the run's credential is refused
    with `credential_present` (`search` counts it as skipped). If the file
    changes or a read is short during the scan, the call fails closed
    (`path_changed` or `read_incomplete`). Returned bytes come from the scanned
    snapshot.
  - The credential is also redacted from tool output and from persisted model output.

## Checkpoints and resume

Each run writes:

- the manifest, which holds the binding;
- per-turn intent, received and not-sent records;
- per-tool-call intent and done records.

Each record is written atomically before the next step. The binding covers:

- provider, API model and effort;
- profile id and revision;
- organization and project;
- credit period;
- credential fingerprint;
- decision hash, which covers the qualification id;
- workspace identity.

The credential fingerprint is an HMAC under a per-`DATA_DIR` salt; the key
itself is never stored.

- **Resume** requires full re-admission. Any binding change fails with
  `checkpoint_binding_stale` and lists the changed fields. A terminal
  checkpoint is returned as stored, with zero provider calls.
- **Leases.** A run lease is created with `O_EXCL` and records the owner's pid,
  process start time, hostname, boot id and PID namespace. Its owner is proven
  dead only when hostname, boot id and PID namespace all match this process and
  the pid is gone or has a different start time. Anything else, including a
  lease without boot id or namespace, is `owner_live_or_unknown` and is never
  reclaimed. Reclaim creates a marker, re-reads the lease, proceeds only if the
  nonce is unchanged, and always removes its marker.
- **Startup reconciliation** runs only if `DATA_DIR/api-agent` already exists.
- **Uncertain outcomes.** A fetch rejection or abort after dispatch,
  including cancellation mid-request, marks the turn `uncertain`. The run
  becomes terminal with `outcome_uncertain`, and that turn is never re-sent.

  The only way to continue is `startLinkedAttempt`. It requires
  `{ parentRunId, fromTurn, confirmDuplicateBillingRisk: true }`, full
  re-admission and the same provider, model, effort and workspace. It creates a
  new run with `supersedes` set. The parent checkpoint is never modified.

## Provider errors

| Signal | Class |
|---|---|
| OpenAI 429 `credit_balance_exhausted` | `funding_exhausted` |
| OpenAI `insufficient_quota` | `funding_ambiguous` |
| Anthropic 400 low credit balance | `account_credit_low` |
| Spend-limit codes or messages | `spend_limit` |
| Other 429 | `rate_limited` (resumable) |
| 529, `overloaded_error`, 5xx | `provider_unavailable` (resumable) |
| 401 / 403 | `auth` / `permission` |

`funding_exhausted` counts as reserve-release evidence only when a
qualification was active. The Codex fallback path is not used for API credit.

## Identity binding

- **OpenAI** requests send the profile's organization and project as the
  `openai-organization` and `openai-project` headers.
- **Anthropic** has no request header for the organization. The profile's
  organization is a declared label and is not verified.
- **Future work:** verify the Anthropic organization with
  `GET /v1/organizations/me`.

Credentials are read only from the reserved variables, in two places:

- lazily by a qualification adapter, through the thunk built by
  `credentialSourceFor(profile.provider)`; production has no adapter, so this
  never runs;
- by the dispatcher at admission, after qualification, through
  `readCredential(decision.identity.provider)`. A value shorter than 8
  characters is `api_credential_unbound`.

They never appear in logs, receipts or checkpoints.
The email on a profile is a label, not an identity.

## Unified runs

A unified run carries one objective across the segments the caller lists. Each
segment is a durable queue task bound to one listed entry: kind, account,
transport, model and effort. The engine is `lib/unified-run.js`; the handoff
between segments is `lib/neutral-handoff.js`.

| Surface | Create | Status | Resume | Link | Cancel |
|---|---|---|---|---|---|
| HTTP | `POST /api/unified-runs` (202) | `GET /api/unified-runs/<id>` | `POST /api/unified-runs/<id>/resume` | `POST /api/unified-runs/<id>/link` | `POST /api/unified-runs/<id>/cancel` |
| CLI | `relaybridge unified run --file <request.json>` | `relaybridge unified status <id>` | `relaybridge unified resume <id>` | `relaybridge unified link <id> --digest <d> [--confirm-duplicate-billing-risk]` | `relaybridge unified cancel <id>` |
| MCP | `unified_run_create` | `unified_run_status` | `unified_run_resume` | `unified_run_link` | `unified_run_cancel` |

All three surfaces return the same validation `errorCode`.

```json
{ "objective": "Fix the failing test in a.txt", "cwd": "/path/to/repo",
  "dangerous": true, "acknowledgeFilesystemWrites": true, "advisoryFileScope": ["a.txt"],
  "segments": [
    { "kind": "claude", "accountId": "default", "transport": "native", "model": "opus", "effort": "high" },
    { "kind": "claude", "accountId": "work", "transport": "native", "model": "sonnet", "effort": "medium" } ] }
```

- **Accounts.** `accountId` is required on every segment. `"default"` means the
  login the CLI already uses, with no funding profile and no `funding` envelope
  on the queued task. It needs no registry or profile file and creates none. A
  missing or `null` account, a disabled default, a provider tombstone (an empty
  `accounts` array) and any account not in the registry are refused with
  `account_binding_required` before anything is written. No other account is
  ever substituted. The bound `accountId` and `quotaSeat` are stored and
  rechecked before each later segment; a change stops the run with
  `account_identity_changed`.
- **Selection.** The first segment uses the first listed native entry with fresh
  headroom above the reserve. When a segment stops at the reserve, the next
  segment uses the listed native entry on a different quota seat with the most
  fresh headroom. Then come qualified API entries, then the native reserve
  (only after a qualified API entry was exhausted), then an opted-in prepaid
  entry (only when every listed native seat is positively exhausted; see
  [Prepaid fallback](#prepaid-fallback)), then a stop. Stale capacity gives
  `waiting_for_quota`. Accounts that are not listed are never used.
- **Reserve authority.** Only a qualified API segment that ends with
  `funding_exhausted` records a reserve release. A generic provider failure or
  rate limit records none. The release is private to the run and is consumed by
  exactly one reserve task. It is not carried in the queue body, and a release
  consumed by one task cannot authorize any other task. Before selection, at the
  dispatch gate and at every supervision check, the server rebuilds the
  authority from these sources:
  - the queue's private running-task context;
  - the exact task, intent, account and seat;
  - the prior API binding (profile, revision and qualification);
  - fresh native usage.

  It admits the reserve only while fresh headroom is above 0%. Headroom at 0%,
  stale or invalid usage, or any binding mismatch refuses with `quota_reserve`,
  `quota_unknown` or `reserve_release_unavailable`. There is no fallback. A
  refused reserve task is never retried automatically.
- **Handoff.** Each successor receives a bounded, redacted handoff: objective,
  constraints, advisory scope, prior segment results and the workspace diff
  summary. Its SHA-256 is the segment's `handoffDigest`. Provider-private
  reasoning (`thinking`, `signature`, `encrypted_content`, reasoning item IDs)
  anywhere in the input is refused with `handoff_banned_content`.
- **Write boundary.** A run without `allowedWritePaths` reports
  `writeBoundary: "advisory_unenforced"`. `advisoryFileScope` is shown to the
  provider only; nothing enforces it. `allowedWritePaths` is accepted only for
  an API-only run (see [API writer segments](#api-writer-segments)); with any
  native segment it is refused (`filesystem_contract_unsupported`, 409, or a
  400 when it is malformed) rather than downgraded. `dangerous: true` requires
  `acknowledgeFilesystemWrites: true`.
- **Writer exclusion.** A dangerous run holds its workspace from create until it
  is terminal. Overlap is checked both ways, including parent and child paths,
  with platform-aware canonical paths (Windows folds case). Unified writers,
  continuity writers, live or unsettled dangerous one-shots and queue tasks,
  and workflow writer locks all exclude each other. An unreadable lock or run
  manifest holds every workspace. Plain runs never hold. A workflow writer
  first reads its own exact workspace lock, read-only. If that lock exists, its
  own diagnostic wins over the shared check: `WRITER_CONFLICT` with the run,
  actor and expiry, or, once expired, `WRITER_EXECUTION_UNCERTAIN` with
  `expired: true` and `recovery: "unavailable_unbound_owner"`. A corrupt,
  linked or non-file lock gives `LOCK_CORRUPT`. An expired lock is never
  removed, renewed or exempted, and the lease token is never reported.
- **API segments.** API segments need an explicit `fundingProfileId` and
  `expectedProfileRevision`. Without a write contract they are read-only, and
  a dangerous run never selects one (`api_write_unavailable`). CLI aliases give
  `api_model_unmapped`. In production every API segment stops with
  `grant_only_funding_unverified` and makes no request.
- **Durability.** Each segment's intent, including its fixed queue task ID and
  exact queue input, is written before submit. A restart resubmits only a
  missing task with that same intent, and never replays an existing one.
  Manifests are published by write, fsync and rename, followed by a directory
  fsync. This directory barrier is enforced only on Linux.
  - **Other platforms.** On every other platform, including Windows, create,
    resume, link and cancel refuse with `unified_run_platform_unsupported`
    before any effect, and the tick does nothing.
  - **Write failures.** A write that fails before the rename returns
    `unified_run_write_failed` with `publication: "unchanged"`.
  - **Barrier failures.** A failed barrier after the rename returns
    `unified_run_publication_uncertain` with `publication: "uncertain"`. The run
    keeps its workspace hold and dispatches nothing, from a later tick or a
    resume, until a later save re-establishes the barrier.
  - **After a restart.** A reopened engine treats every persisted manifest as
    `publication: "unconfirmed"`. Before it dispatches a segment, reserves
    authority or releases a writer hold, it fsyncs the run root, its parent and
    the run directory. Until that succeeds the run is `uncertain`: it keeps its
    hold, including a terminal run, and submits nothing.
  - **Manifest validation.** On load the stored intent hash is recomputed from
    the queue input. The input must also match the run and segment field by
    field: `dangerous`, `cwd`, kind, account, quota seat, model, effort,
    request ID, `unifiedRun` binding and funding route. Any mismatch, such as a
    flipped `dangerous`, makes the manifest corrupt. A corrupt manifest holds
    every workspace, and status, resume and cancel refuse.

  Status reports `durability: { platform, directoryBarrier, publication }`.
- **Submit errors.** A submit that throws never proves that nothing ran. The
  queue's record of the fixed task ID decides:
  - if a task exists with the same intent, the run uses it;
  - if a task exists but submit threw or its intent differs, the segment becomes
    `uncertain` (`TASK_INTENT_CONFLICT` or the submit error code) and keeps its
    hold;
  - if no task exists, the segment stays an open `intent` with `submitError`.
    The run stops `needs_attention` without rewriting an unchanged record.
    Resume resubmits that same intent and never starts a second segment.
    Cancel refuses it, because a missing record does not prove non-execution.
    A legacy `not_submitted` segment is handled the same way.
- **Uncertain writers.** If a dangerous segment's process state is lost (for
  example, the bridge was killed), the run stops with `writer_execution_uncertain`
  and keeps its hold. Resume refuses. `link` continues only when the task is
  physically fenced, the caller echoes the current `workspaceEffectsDigest` from
  status, `confirmDuplicateBillingRisk` is set if a call may have been sent, and
  no other writer holds the workspace. A workspace that is not a Git repository
  gives `workspace_reconciliation_unavailable`. A terminal run's resume makes no
  submit and no call.
- **Physical settlement.** An unowned task counts as physically stopped only
  from the queue's own execution record. An owned task counts only through the
  queue's private owned-settlement projection (`isOwnedSettled`). Legacy native
  uncertainty is never settled from receipts, PID absence, lease expiry or
  continuity bits, so `link` refuses for it.
- **Cancel.** Cancel never stops live work, and it takes no fields. It succeeds
  only when the run's own record, or the queue's durable record of the exact
  intent, proves that nothing is running and nothing will start. That covers
  three cases:
  - a waiting run with no open segment;
  - a segment still `queued`, with `never_started` execution and the same
    intent hash, which the server cancels and then re-reads to verify;
  - a segment already physically settled, which is recorded as settled.

  These are refused:
  - a running segment (`unified_run_segment_running`);
  - an uncertain segment;
  - a recorded intent with no queue record, the crash gap
    (`writer_execution_uncertain` or `outcome_uncertain`);
  - an intent mismatch (`TASK_INTENT_CONFLICT`);
  - an owned queued task (`owned_task_cancel_unsupported`);
  - a queue cancel that cannot be verified (`unified_run_cancel_unverified`).

  A cancelled run drops `pendingStart` in the same save that makes it terminal,
  so no tick or resume starts pending work.
- **Recovery view.** Status reports `recovery` with these fields:
  - `cancel`: `available`, `refused` or `not_applicable`, plus `cancelRefusal`
    when it is refused;
  - `link`: `after_physical_settlement_and_reconciliation` for an uncertain
    segment;
  - `automaticRetry: false`. An uncertain, crashed or refused segment is never
    replayed.
- **Internal fields.** `unifiedRun` and `reserveRelease` are set only by the
  engine. A public request carrying either, on any route, is refused with
  `invalid_funding_envelope`.

### Prepaid fallback

An API entry may opt into the owner's `authorized_prepaid` permit with
`"fundingRoute": "authorized_prepaid"`. Without that field an API entry stays on
the included-credit grant path exactly as before, even while a permit is valid.
Any other `fundingRoute` value is refused with `invalid_funding_envelope`.

```json
{ "objective": "Review the parser", "cwd": "/path/to/repo",
  "segments": [
    { "kind": "codex", "accountId": "default", "transport": "native", "model": "gpt-5", "effort": "medium" },
    { "kind": "codex", "accountId": "default", "transport": "api", "model": "gpt-5", "effort": "medium",
      "fundingProfileId": "api_openai", "expectedProfileRevision": 3, "fundingRoute": "authorized_prepaid" } ] }
```

- **Create checks.** A prepaid entry needs a listed native entry for the same
  provider and account (`prepaid_exhaustion_source_required`, 400). A run with
  `dangerous: true` or `allowedWritePaths` and any prepaid entry is refused with
  `api_agent_read_only` (409). Prepaid runs only the read-only API agent; it is
  never a writer and never mixes with an API writer contract.
- **Positive exhaustion.** Prepaid is selected only when every listed native
  entry is positively exhausted. For each one the engine rebinds the exact
  account and seat and requires a fresh observation for that seat with a finite
  remaining percentage of 0. A seat that is stale, unobserved, invalid, or in the
  protected band (above 0% but at or below the reserve) is not exhausted, so the
  run waits (`waiting_for_quota`). A vendor block or cooldown is not used as
  evidence. It can mean a transient rate limit or overload, and is neither
  required nor sufficient. Auth failures are not exhaustion either.
- **Permit.** The permit is resolved through the same `authorized_prepaid`
  route as one-shots, so it must be valid, supervised, for this OpenAI profile
  and revision, list the model, and expire within 24 hours. There is no renewal
  endpoint. A missing or invalid permit stops the run with its blocked reason
  (for example `prepaid_authorization_missing`); exhaustion alone never spends.
- **Segment record.** The manifest stores a `prepaidBinding`
  (`authorizationId`, `authorizationHash`, `profileRevision`) and an
  `exhaustionEvidence` row per native seat (`quotaSeat`, `accountId`,
  `observedAt`, `percentRemaining`, `evidenceHash`). A prepaid segment has no
  grant `apiBinding`. Grant segments keep their existing shape and hashes. A
  manifest whose prepaid segment lacks valid evidence or binding is treated as
  corrupt.
- **Admission.** Before the task starts, the server rebuilds the authority from
  the private running-task context: the exact run, segment, task, intent and
  account; the same permit `authorizationId`, hash and profile revision; and
  current native usage. If a listed native seat has recovered above the floor,
  the task is refused with `prepaid_subscription_available`. If exhaustion can
  no longer be shown, it is refused with `quota_unknown`. Both refusals happen
  before any model call, so the prepaid entry stays usable and the run selects
  again. The API agent also revalidates the permit before each turn.
- **Recovery.** A native seat that recovers is used at the next segment
  boundary, never mid-turn: an in-flight prepaid segment finishes on prepaid,
  and only the next selection returns to native. There is no duplicate
  invocation and no transfer between stores.
- **Reserve.** A prepaid segment never records a reserve release. Prepaid
  `funding_exhausted` marks that entry exhausted, and the run waits.
- **Limits.** Native usage is probed about every 60 seconds (Codex through its
  app-server, Claude through the statusline endpoint), so recovery and
  exhaustion are seen no faster than that. A Codex "credits depleted" state that
  does not report 0% remaining is not treated as exhaustion. Claude prepaid is
  not supported.

### API writer segments

An API-only dangerous run can name the existing files its API segments may
edit:

```json
{ "objective": "Rename the greeting", "cwd": "/path/to/repo",
  "dangerous": true, "acknowledgeFilesystemWrites": true, "allowedWritePaths": ["src/app.js"],
  "segments": [ { "kind": "codex", "accountId": "default", "transport": "api", "model": "gpt-6.1-sol",
    "effort": "low", "fundingProfileId": "one", "expectedProfileRevision": 3 } ] }
```

- **Contract.** Every listed segment must have `transport: "api"`. Paths are
  workspace-relative, normalized and exact: no globs, directories, hidden
  components or secret names (`.env`, keys, certificates). An empty or
  malformed list gives `invalid_write_contract`; a missing acknowledgement gives
  `filesystem_acknowledgement_required`. The normalized list and its hash are
  stored in the run and bound into each segment's queue input, its checkpoint
  binding (`toolsetHash`, `writePathsHash`) and its checkpoint ID. There is no
  separate transport field; the `segments` list is the contract.
- **Tools.** A writer segment gets `read_file`, `list_dir`, `search` and
  `apply_patch`. `apply_patch` replaces exact text (each `oldText` must occur
  exactly once, at most 32 edits) in one allowed file that already exists as a
  regular, singly linked, non-symlinked file of at most 1 MiB, given the
  `expectedSha256` returned by `read_file`. It keeps the file's permission
  bits and owner. A setuid or setgid file is refused (`path_denied`) before any
  journal record or effect, and those bits are never applied to the temp file.
  Every directory on the path, not only the workspace root, must be on a
  qualified local filesystem (ext4, xfs, btrfs or tmpfs). A path through any
  other mount gives `api_write_unavailable` with no effect. There is no
  create, delete, rename or shell tool. A read-only segment never offers
  `apply_patch`.
- **Boundary.** The run reports `writeBoundary: "per_segment"`; each segment
  reports its own boundary. A writer segment's is
  `{ kind: "in_process_tool_contract", osSandbox: false, atomicCompareAndSwap: false, scope: "exact_allowed_existing_files", createOrDelete: false, shell: false }`.
  These are checks inside the bridge process, not an OS sandbox. The hash and
  identity checks before the rename are not an atomic compare-and-swap; another
  process can still change the file in between, and that is detected after the
  fact, not prevented.
- **Journal.** Each patch is journaled in the checkpoint before any effect:
  `prepared` (target identity, pre- and post-image hashes, the post bytes), then
  `temp_bound` once the private temp file's identity is recorded, then
  `committed` after the rename and directory fsync. Just before `committed` is
  written, the named root and full directory chain, the file's identity, mode,
  owner and post-image hash are checked again. Any mismatch is uncertain. The patch record is never
  overwritten by the generic tool record. Before every patch the server checks
  that this segment still holds the workspace and that no other writer does.
- **Uncertain outcomes.** A target that changed under the patch
  (`target_displaced`), a lost workspace hold or an unconfirmed fsync stops all
  further tools. The run keeps the temp file as evidence, keeps its workspace
  hold and stops with `writer_execution_uncertain`. The receipt lists
  `effects_pending`.
- **Reconciliation.** Resume first proves the checkpoint owner stopped and the
  segment still holds the workspace. Every owning attempt is recorded with its
  full process identity (pid, start time, host, boot ID, PID namespace). Each
  attempt needs stopped evidence that names that exact identity and has its
  file and directory fsyncs confirmed. A malformed attempt or evidence record
  proves nothing. An empty attempt set is never accepted on absence alone. It
  counts only with bound `not_dispatched` evidence, which is written when
  checkpoint creation fails before its first attempt record is durable. That
  evidence must name this run, binding and owner. The directory must also be
  consistent with no dispatch: an `active` manifest with no outcome, or a
  `resumable` one whose outcome is exactly `interrupted`, and no turn, tool,
  patch, attempt or non-canonical stopped record. Any contradiction, such as a
  terminal manifest with its attempts missing or recorded turns or patches
  without an owner, gives `owner_not_proven_stopped`. A crash between the lease
  and the first attempt record leaves only `owner_dead` evidence, which proves
  no such thing; that run needs an operator. If an attempt record or its
  evidence cannot be made durable, the lease is kept. Every patch record, `committed` ones included,
  must be valid for the bound write list, match its `apply_patch` tool record
  and name only stopped attempts. Resume revalidates each record's path,
  target identity, mode, link count, run and segment binding before acting. A
  `prepared` or `temp_bound` record is rolled forward or committed only on the
  recorded temp inode. Its mode and owner are checked before and after the
  fsync barriers, as are the directory chain and post image. A temp file whose
  identity was never recorded is left in place (`unproven_temp`), as is any file at a temp name with a different
  identity. A matching post-image hash alone never proves the run published it.
  Only a checkpoint whose every patch is journal-settled releases the hold or
  continues the run without native reconciliation; an API transport alone never
  does. A read-only checkpoint can never be resumed or linked as a writer
  (`checkpoint_binding_stale`).
- **Production.** The production authority has no adapters, so writer segments
  stop with `grant_only_funding_unverified`, make no request and write nothing.
  `test/unified-run-api-writer.integration.test.js` proves the path end to end
  with a test-only qualification preload and a scripted local provider.

### Known limitations

- `authorized_prepaid` applies to a unified run only for an entry that opts
  in with `fundingRoute`, and only after positive exhaustion of every listed
  native seat. A prepaid permit never releases the reserve and never authorizes
  a writer.

- The production queue never fences an uncertain task, so a server-level `link`
  after an uncertain writer is always refused. Fence-and-link is covered at the
  engine level only.
- Waiting runs (`waiting_for_quota`) are re-evaluated by the server tick. That
  is selection of a new segment, not a retry of an earlier one.
- Physical owner records from the private owner journal hold their workspaces,
  whichever workflow or run started them. The only exemption is the owner bound
  to the exact running task, reservation and owner ID; an equal
  `workflowRunId` is not an exemption.
- Cancel cannot stop running or owned work; those wait for settlement.
- Checkpoint evidence is a local file, not a signature. A process that can write
  `DATA_DIR/api-agent` as this user can forge a consistent `not_dispatched`
  record. The checks reject inconsistent or mismatched records only.
- The scope is advisory for runs without `allowedWritePaths`; see above.
- On WSL2 or tmpfs, the patch and crash tests prove the code path, not disk
  durability.
- The `credential_present` check covers only the configured credential strings
  bound to the run. It is not a general secret scanner: other secrets in an
  edited file or in a model's edit are not detected.
- `apply_patch` preserves only the file's permission bits and owner (as a check,
  not a `chown`). Group ownership, POSIX ACLs and extended attributes are not
  preserved. The published file gets the group any new file gets in that
  directory, and no copied ACLs or xattrs.

## Activation prerequisites

Each provider must meet all of the following before it can be activated:

- a provider-enforced grant-only funding mechanism, bound to organization, project, credential generation and grant period;
- a reviewed adapter;
- a review of writer authority and crash reconciliation for owned workflows (`funding_owned_binding_unsupported` and `owned_transport_unsupported` remain);
- a separately scheduled deployment.

Even then, there are no purchases, reloads, invoiced funds or hosted shared
credentials, and the only write tool is `apply_patch` on exact allowed existing files.

## Tests

All provider traffic in tests goes to a local fake (`test/helpers/fake-provider-api.js`).
Child processes and in-process server imports get an environment from
`test/helpers/isolated-env.js`, which removes `RELAYBRIDGE_*`, `PS_BRIDGE_*` and
provider secrets; `test/test-env-isolation.test.js` enforces this statically and
with a poisoned parent environment.

- `test/api-agent-*.test.js` cover the wire formats, tools, checkpoints, crash
  recovery (`test/fixtures/api-agent-crash-child.js`), the agent loop and dispatch.
  `test/api-agent-patch.test.js` covers patch refusals and displaced or
  hold-lost publication. `test/api-agent-patch-crash.test.js` SIGKILLs a child
  (`test/fixtures/api-agent-patch-crash-child.js`) at each patch step and checks
  exactly-once recovery and that unproven temp files are kept.
- `test/unified-run-api-writer.integration.test.js` runs the real server with a
  test-only qualification preload and a scripted provider: an API writer run
  edits an allowed file, contract refusals make no request, and the production
  authority makes no request and no write. A writer or contract run with a
  prepaid entry is refused with `api_agent_read_only` and makes no request.
- `test/funding-routing.test.js` and `test/unified-run.test.js` cover the
  positive-exhaustion predicate and prepaid selection, admission, recovery,
  restart and corrupt-manifest cases with fakes.
- `test/api-agent-server.integration.test.js` starts the real server with
  `test/helpers/deny-egress.js` preloaded. With keys and plausible activation
  variables set, it checks that:
  - no request leaves loopback;
  - no attempt or checkpoint is created;
  - forged qualifications are rejected.

  A unified-run case uses a fake Codex app-server and the Claude statusline
  endpoint. It checks that unobserved and protected seats wait, that a missing
  permit or a missing opt-in spends nothing, that an exhausted pair runs prepaid
  read-only, and that a seat recovering mid-turn is used only at the next
  segment.
- `test/unified-run.test.js` and `test/unified-run-writer-holds.test.js` cover
  the engine with a fake queue: selection, reserve release, reauthorization,
  crash restarts, fence-and-link, cancel, durability failures and writer holds.
- `test/unified-run.integration.test.js` runs a real server with a fixture CLI.
  It checks account, API, writer-hold, restart and cancel behaviour over HTTP,
  CLI and MCP. It also checks that a cancelled run submits nothing after a
  restart.
- The durability-dependent tests run only on Linux. On other platforms a test
  checks that create refuses with `unified_run_platform_unsupported` and leaves
  no files.
- `test/unified-run-owner-holds.test.js` runs the real `server.js` with a
  test-only preload that replaces only `heldWorkspaces()` rows. It checks that
  parent and child owner rows hold one-shot, queued and unified writers, that
  sibling and read-only work run, that a matching task ID alone is not an
  exemption, and that unavailable owner authority holds every workspace.
  `test/owned-execution-backend.test.js` checks the exact
  task, reservation and owner exemption on real owner rows.
- `test/unified-run-reserve-dispatch.test.js` runs the real `server.js` native
  dispatch. A test-only `--require` preload provides a fake qualification
  adapter and a fake provider response; production `server.js` stays
  adapterless. The test checks that the reserve dispatches at 98% and 99% used.
  It checks refusal at selection, at the dispatch gate and under supervision for
  each of these cases:
  - 0% headroom;
  - stale usage;
  - a forged binding;
  - a generic provider failure (at selection).

  It also checks that an exhausted prepaid segment records no reserve release,
  so the reserve stays closed at 2% remaining.
