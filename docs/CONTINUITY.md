# Usage-aware handoff and adaptive supervision

Usage protection, automatic handoff, dynamic supervision and bounded progress
assessment are on by default. Open **Fuel → Usage protection** to change them.
The default subscription reserve is **5%**, configurable from **2% to 5%**.
Settings persist in the bridge data directory. Usage protection takes effect
on active work. Dynamic timer mode applies to newly started runs; disabling
dynamic supervision or progress assessment immediately revokes assessments on
active runs, without changing their existing timer mode.

## Native allowance

Codex allowance comes from the installed CLI's native `account/rateLimits/read`
RPC, once per minute, with no thread or model generation. Claude allowance comes
from passive CLI rate-limit events and a bounded read of the default CLI's
`.claude.json` native utilization cache. This read never launches a CLI or an
authentication request. The optional status line remains an unbound observation.
Windows,
reset times, model buckets and configured linked accounts remain separate.
Shared provider aliases share one quota seat. Only backend-provided account IDs
are hashed as account identity; a configured profile alone cannot prove that a
login has not changed outside RelayBridge.

For recognized native Anthropic CLI entries, only the default profile layout is
currently qualified. A relocated `HOME`, any effective `CLAUDE_CONFIG_DIR`,
or alternate authentication/backend selector from the shipped identity-isolation
list (including inherited or explicit OAuth/API tokens) is unavailable. A
missing/unsafe metadata file, disabled account or removed account is unavailable;
there is no default-profile fallback. The reader checks a bounded regular file
through one nonblocking descriptor and rejects replacement or mutation during the read. It
returns only hashed OAuth account/profile identity and selected utilization
fields, never credentials or raw account identifiers.

Profile identity and allowance are separate. A stale or mismatched native cache
can identify the selected profile but cannot establish current capacity. Both
five-hour and weekly windows must be valid, tied to that account, and fetched
within three minutes, with no future timestamp. The original `fetchedAtMs` is
persisted; rereading identical bytes cannot renew freshness. A new fetch must
exceed both that account's persisted fetch watermark and the seat's latest
accepted observation, including across identity changes and bridge restarts.
Initial identity binding preserves legacy windows, depletion anchors and denials
as unattributed protection. A changed identity isolates the previous account's
evidence, and new work requires fresh evidence for the selected account. Returning
to a previously selected identity restores its windows, anchors and denials but
still requires a new complete fetch. Up to 32 inactive identity snapshots are
retained per seat; further unknown identities are refused rather than evicting
protection. A correctly bound stream's explicit denial is retained even when its
capacity update is rejected, without refreshing capacity timestamps. An older or
same-time affirmative event cannot clear that denial.

Native fractional reset instants retain their original ISO/nanosecond precision.
Native reset estimates may cross a whole-second boundary on successive fetches.
A versioned immutable reset anchor admits fresh native estimates within one
second in either direction, inclusive. This radius is a conservative local
reconciliation policy covering observed jitter, not a vendor-guaranteed window
identifier. Repeated updates and restarts cannot move the anchor or accumulate
more tolerance. Older native records bootstrap once from validated retained
provenance; millisecond precision and retained origin are labeled explicitly.
Caller-supplied anchor metadata and inconsistent persisted anchors are refused.
Retained native provenance is recognized even when its raw millisecond field is
missing. Malformed native state cannot become fresh headroom on reads or be
replaced through stream migration; existing low-capacity and denial protection
remains in force while its allowance is unavailable.

Streams still match only the anchor's original next-second ceiling. Unequal
stream reset values whose nearest-second rounding cell overlaps the anchored
band cannot establish a new window. Both ingestion orders and restarts retain
the earliest conservative expiry and depletion anchor. Same-window increases,
refreshes at or after that earliest expiry, and out-of-band resets before the
original rollover boundary are rejected by ordinary observation. A genuine later window requires the
original boundary to have elapsed and independent unambiguous reset evidence.
Invalid intervening samples retain prior protection and cannot restore capacity.

The verified default native-profile adapter has a separate counter-refresh path
for an out-of-band reset estimate. It requires a complete fresh authenticated
two-window fetch and complete valid prior native authority bound to that same
account. Both counters must stay equal or decrease; both original effective
deadlines must remain future at fetch and processing time. Any decrease within
one second of its prior observation rejects the complete counter refresh so
the rate estimator cannot clear existing depletion protection. An incoming reset
earlier than either retained expiry disqualifies this path. Reset ISO/ms/ns,
immutable anchor, boundary and effective expiry remain unchanged. A separate
`nativeCounterRefresh` record labels the incoming reset claim as unadmitted and
binds its fetch/evidence to the retained record. Counter freshness and depletion
rates advance normally; this never proves reset equivalence or replenishment.
Replay, expiry, identity, denial and reserve protections still apply. Generic
observations, streams and statusline ingress cannot select this path or supply
its marker. Repeated drift cannot slide an anchor or extend its deadline.

In CLI2.1.270, `/usage` displays freshly fetched utilization even when its
five-minute cache-write throttle suppresses a disk update. The bridge still
requires a persisted fetch within three minutes. A fresh display alone cannot
renew that evidence, and this repair does not extend its freshness lifetime.

The configuration snapshot that supplies the launch command fixes whether native
identity is required. A changed selected entry or quota seat refuses admission;
removing native markers cannot downgrade a pending launch to generic dispatch.
Each native launch binds the selected provider/account, quota seat, profile,
configuration/registry generation and independently read account fingerprint.
The bridge checks this binding at admission, immediately before spawn, and at
owned start/readiness/permit boundaries. Stream observations and continuity
ticks recheck the live profile; a change checkpoints and stops the old run.
These checks are launch-only and do not change physical settlement or recovery.
Eligible aliases share cache observations only when seat/profile/account agree;
disabled or removed aliases cannot be revived by deduplication. Custom transports
are not classified as native Anthropic merely because their kind is `claude`.

Observations expire after three minutes. Repeated cached Claude status-line
payloads do not make an old observation fresh. Explicit denial and stale low
capacity remain protected until affirmative native evidence clears them.
Unknown capacity allows ordinary calls on generic transports, but native
Anthropic CLI launches require fresh capacity bound to the selected profile.
Unknown capacity cannot qualify an automatic successor or assessor. Local token counts and operator estimates do not become
subscription percentages.

A window's `usedPercent`/`utilization` outside its valid 0-100/0-1 range is
rejected as invalid evidence, not clamped into a fabricated in-range value.
An invalid window is never silently dropped either: it poisons headroom for
its whole bucket to unknown, so a good sibling window cannot make the bucket
read as fully fresh. This applies to Codex's per-model `individualLimit` spend
window too — a supplied but unusable `remainingPercent` or `resetsAt` is
marked invalid rather than dropped (a missing/null reset is still allowed,
since spend limits may not carry one). An explicit native denial
(`ordinaryUsageAllowed:false`, spend-control reached, or a Claude `rejected`
status) still protects the seat even when every window in the same payload is
malformed. The last valid `percentRemaining`/reset for a window is retained
per window id (including across a restart) when a later reading for that same
window turns invalid, so a cached status-line reading cannot silently
supersede it and protection keeps being re-evaluated against the *current*
reserve setting rather than a snapshot taken under an earlier one, until an
affirmative valid reading of that window shows capacity above the reserve
again.

Measured percentage depletion per hour can trigger checkpointing before the
reserve is reached. The bridge persists a handoff before requesting finalization
or stopping a process. A finalization-capable Claude stream gets up to 90 seconds;
2% remaining, stale protected evidence, or a transport without finalization
causes an immediate controlled stop after the document is saved. Delayed or
missing vendor observations mean no tool can guarantee an absolute 2% floor.
The UI shows that uncertainty rather than claiming unused capacity.

For Claude host-chat usage, compose your existing `statusLine.command` with
`node /absolute/path/to/relaybridge/tools/usage-statusline.cjs`, forwarding the
same JSON stdin to both commands and keeping your current display output. The
helper is silent and forwards only `rate_limits.five_hour/seven_day` fields to
the authenticated loopback bridge. Set `RELAYBRIDGE_TOKEN_FILE` and
`RELAYBRIDGE_URL` when using nondefault paths; set `RELAYBRIDGE_USAGE_ACCOUNT_ID`
for a configured linked Claude account. No installer overwrites existing hooks.
See [Claude status-line data](https://code.claude.com/docs/en/statusline#available-data)
and [Codex native rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

## Durable project coordination

A connected host agent should call `get_context_bundle` first, reuse an existing
coordinator for the canonical workspace, or call `register_coordinator` once:

```json
{
  "cwd": "/absolute/project",
  "objective": "Implement and verify the requested feature",
  "kind": "codex",
  "mode": "external",
  "modelTier": "heavy",
  "effort": "high",
  "allowedProviders": ["codex", "claude"],
  "checkpoint": {"pending": "Implementation and review", "tests": "Not run"}
}
```

For retryable external registration, generate a cryptographically random
32-byte token locally (64 lowercase hexadecimal characters) **before** the call,
retain it privately, and supply it as `ownerToken`. Retry the identical inputs
with the same token after a lost response. This returns the current checkpoint
and original ownership generation without starting duplicate work. Changed
inputs or a released/replaced owner are rejected. Tokens are not included in
status, handoff documents or stored JSON; only private hashes are persisted.

Preserve the returned `id`, `ownerToken`, and `epoch`. Supply validated `model`
and `accountId` when the host uses a specific configured route. Record decisions,
completed/pending work, files, tests, next actions and base revision with
`checkpoint_coordinator` after meaningful milestones, not only at exhaustion.
Pass `continuityId` and `continuityEpoch` on associated `ask_provider` or
`submit_task` calls. Do not widen an existing project's provider restrictions.

When state becomes `awaiting_owner_release`, stop new delegation, finish the
checkpoint, and call `checkpoint_and_yield` with explicit release evidence after
all owned writers have stopped. A linked pipeline also requires its actual
`writerLeaseToken`; yielding stores unfinished work without claiming review or
implementation completion. Missing release evidence, a stale token, or unsettled
managed work rejects the handoff before releasing that lease.

The bridge then selects an originally permitted provider at the comparable
model tier/effort with fresh capacity above the reserve and greater headroom.
It persists a new ownership generation and a single task intent before dispatch.
Old ownership generations cannot start additional work. A restart never replays
an uncertain execution; unresolved physical ownership needs verified recovery
before another owner can proceed. Preserve those records for manual inspection;
absence from a new process table is not permission to clear uncertain ownership.

Managed mode runs an actual read-only delegator through the ordinary task queue.
It can inspect the checkpoint, propose bounded read-only assignments, collect
their results and update the handoff. It has a twelve-round limit and never
automatically acquires an implementation writer lease. If implementation needs
to continue in a host chat, `resume_from_checkpoint` returns the handoff and a
new owner token after physical settlement. It first collects any already-settled
coordinator/worker result and receipt, without launching another task. A completed
objective stays complete. Omitted `model`/`accountId` retain the current route
when the provider is unchanged; explicit routes must retain a comparable tier
and the original provider restrictions.

For retryable `resume_from_checkpoint`, supply a **new**, privately retained
`ownerToken` and `expectedEpoch` equal to the observed ownership generation,
along with `id`, `kind` and any explicit model/account selection. Exact retries
return the same acquisition only while that owner remains current and unreleased;
they preserve newer checkpoints and do not increment the epoch again. A changed
request, stale generation or different owner cannot reuse the acquisition.
Legacy calls omitting these optional token fields still receive a random token,
but cannot recover that token if the acquisition response is lost.

RelayBridge cannot change the model
of an arbitrary open Codex/Claude chat or force that host to write a checkpoint;
external coordination requires this cooperative protocol.

If no permitted provider has verified headroom, or automatic handoff is off,
retain the document and wait. Settings do not authorize a weaker model, a new
provider, metered fallback or overlapping writers.

Project Markdown and JSON live under `data/continuity/`; per-worker public
checkpoints are under `data/continuity/runs/`. The Fuel panel downloads project
handoffs. Raw reasoning, tool arguments and command output are excluded from
public progress and assessor prompts; partial checkpoints are explicitly partial.

## Dynamic progress checks

Omitting `timeoutMs` uses adaptive supervision. Healthy work can continue past
30, 45 or 120 minutes. Silence, CPU activity and elapsed time alone cannot prove
that work is good or stuck. An explicitly supplied deadline, a custom operator
hard cap, cancellation, and token/output budgets still stop work as requested.
Set `_supervisor.hardDeadline:true` to retain an intentional global 45-minute
ceiling; per-provider `supervisor.hardCapMs` always remains explicit.
Gemini's immutable native print wait has a separate 24-hour transport ceiling
plus a bounded drain margin; preview and execution report it consistently.

The Fuel panel shows public assistant checkpoints, structured operation counts,
retry information, and assessment state. Shipped Codex uses versioned JSONL
output; only accepted terminal records produce a completed answer. Unsupported
structured parsers provide partial observability, not invented progress.

After twenty minutes without useful progress (the default idle interval), a
permitted light/low model may inspect a bounded public snapshot. Useful progress
defers this check and renews its allowance of at most three attempts. Tool starts,
failures and the assessor's own opinion do not renew the allowance. Each check
uses ordinary capacity and fresh quota again at dispatch, with five-minute
spacing, one global assessor, a two-minute deadline and explicit token budgets.
No assessor recursively assesses another assessor. Missing capacity or ambiguous
evidence leaves work running and marks the assessment unavailable/unknown.

An automatic stuck stop requires repeated unchanged narrative or repeated
failures, stale useful progress, no active retry window, and a current assessment
that cites the exact supplied evidence. New useful progress or a distinct tool
operation invalidates an older assessment. An assessment alone cannot approve
an implementation or replace the pipeline's fresh review gates.

Turning off `dynamicSupervision` or `assessorEnabled` immediately invalidates
accepted/in-flight judgments and requests cancellation of obsolete assessors.
Re-enabling cannot revive those judgments. Cancelled assessors keep their slot
until their execution is durably settled; a missing parent cannot leave an
unaccounted background assessment. Existing adaptive runs keep their timer mode:
no elapsed-time or idle-only stop is added by toggling assessment off. Token/output
budgets, quota reserve protection and explicitly supplied deadlines remain active.
The dashboard reports disabled, deferred, unavailable and exhausted assessment
states, and identifies older judgments invalidated by new work.

## REST and MCP collection

Default `ask_provider`, routed and committee calls use durable queued work.
Collection normally lasts ten seconds (bounded by the enclosing request).
`pending:true, terminal:false, taskId` means collect the exact task using
`get_task_result({"id":"the returned taskId"})`; it is not a failed call or
permission to resubmit. `get_run` retains pending committee/member handles but
does not automatically continue a synthesis. Checkpointed pending members do
not authorize fallback calls or a premature chair answer. Collection cancellation
leaves the worker running; `cancel_task` requests actual worker cancellation.
Explicitly timed direct calls retain request-scoped cancellation.

REST endpoints: `GET/PUT /api/settings/continuity`, `GET/POST /api/usage/native`,
`POST /api/usage/native/refresh`, `GET/POST /api/continuity`,
`GET /api/continuity/:id`, `GET /api/continuity/:id/handoff`, and
`POST /api/continuity/:id/{checkpoint,yield,resume,cancel}`. Every endpoint uses
normal bridge authentication. Reads do not dispatch work.

## Upgrading custom Codex configurations

The Windows installer migrates the exact retired shipped Codex command/parser
contract together. Custom wrappers, arguments, explicit parsers and disabled
slots retain their original protocol. An external `RELAYBRIDGE_CONFIG_FILE`
remains operator-owned: to enable structured Codex progress, add `--json` to its
intended `codex exec` slots and select `oneshot_output_parser: "codex_json"` in
the same configuration write, after checking the installed CLI supports it.
The existing text parser remains available for custom configurations.
