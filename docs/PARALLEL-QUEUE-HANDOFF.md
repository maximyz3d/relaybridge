# External queue/reliability ownership handoff

Transfer ID: `RB-QUEUE-EXTERNAL-2026-09-07`.

## Assignment and authority

Shane assigns R13-R16 to the new-account chat. That chat is the lead writer for
this lane and may commit, push its own branch, and open/update its own pull
request. Its subagents do not write to GitHub. The original coordinator retains
all merging, main-branch publication and installation authority. No main push,
merge, release, runtime restart, credential change or force-push is authorized
for the external lane.

The original workflow `wf_mtri7r8q_aadbed9429eb` was intentionally cancelled
through RelayBridge on 2026-09-07 after its read-only planning task completed.
Readback confirmed `phase=cancelled`, no writer lease and no next actions.
The completed task `t_mtri8l1i_4t8pl2` and artifacts remain as evidence; they are
not an active implementation. Do not resume, retry or recreate this lane under
the original coordinator. The external chat may create one explicitly linked
successor workflow if its own managed implementation requires it; check for an
existing external successor first. This transfer is a durable ownership record,
not a claim that a runtime writer lease was granted.

Other workflows remain with the original coordinator:

- Delegation/fuel: `wf_mtri7rbw_b2353ca8c777` (R07-R12).
- Recovery: `wf_mtri7rem_dc654d15e982` (R17-R19).
- Release/setup: `wf_mtri7rh9_cc19e9dadb42` (R01-R06, R20).
- UI: `wf_mtpaap5g_13a021359026` (R21-R24).

Their planning tasks have completed, but their plans were not reconciled or
accepted by this handoff. No claim of implemented features follows from that.

## Source baseline and PR flow

Repository: `maximyz3d/relaybridge`. Parent: draft PR120,
branch `codex/control-center-repair`. Last code baseline:
`b42485c8aad82a6b45f6acaa22461e8c330fd38b`; the handoff is a later docs commit.

Fetch and inspect the current parent branch and main. Create a unique branch
and separate checkout/worktree based on the parent branch, not the installed
runtime or another agent's dirty worktree. Record the exact starting SHA.
Suggested new branch: `external/queue-reliability-20260907` (check it is unused).

If PR120 is unmerged, open a stacked PR with base `codex/control-center-repair`
so the diff contains only this lane. Identify PR120 as its dependency. The
original coordinator will handle merge order and retargeting to main. If main
already contains the parent changes, branch from main and target main instead.
Do not cherry-pick/reimplement the parent into a second competing repair.

Stage exact paths, use new conventional commits with an Evidence line and
`Refs #120` (plus the lane's own issue/PR when available). Never amend a reviewed
commit or force-push. Include sanitized tests, decisions, ownership, integration
needs and review evidence in the PR. Do not upload credentials, runtime data,
full private transcripts, node_modules or raw machine logs.

## Exclusive implementation scope

The original coordinator reserves these files for the external lane and will
not implement them in another group until ownership is explicitly returned:

- `lib/task-queue.js`
- `lib/incident-log.js`
- `lib/workflow-controller.js`
- `lib/workflow-store.js` if a new store is actually justified
- `test/task-queue.test.js`, `test/task-incident-integration.test.js`
- `test/incident-log.test.js`, `test/workflow-controller.test.js`
- New queue/backlog, incident-explanation and request-ledger test/module files
  specifically listed in the lane's accepted plan
- `docs/TASK-QUEUE.md` and a uniquely named lane evidence document

Do not edit `server.js`, `mcp-server.js`, UI files, provider/account routing,
quota-gauge modules, deployment scripts, shared package metadata or other
workflows' files. Read them to verify consumer contracts. If integration needs
an out-of-scope change, describe the exact interface and needed change in the
PR; coordinate a written scope transfer before editing it. Do not claim an
unwired optional hook is an end-to-end fix. Scope additions remain gated.

## Requirements and acceptance

R13 — Truthful admission and fewer false positives:

- Count actual admitted executions, not open chats.
- Include waiting tasks during admission backoff in truthful aggregate counts;
  preserve compatible `active`, `queued`, `maxConcurrent` semantics and document
  additive ready/deferred/blocked detail.
- Distinguish concurrency, authentication, observed provider quota, cooldown,
  dependency/approval, context/budget failure and unknown capacity.
- Investigate stale tracking with evidence. An empty or missing activity probe
  must NEVER release a potentially live execution slot or writer lease.
  Require authoritative process termination/fencing before replacement work.

R14 — Durable multi-task backlog:

- Persist deferred admission and retry timing; define dependency handling,
  cancellation, starvation protection and bounded backoff.
- Verify restart behavior with fixtures. Resume only explicitly eligible,
  never-started work; preserve authority/provenance and conservative legacy
  behavior. Interrupted or uncertain writers must never automatically replay.
- Prevent duplicate dispatch/spend and test shutdown/timer cleanup. Do not
  claim exactly-once execution without a demonstrated mechanism.

R15 — Request coverage and truthful completion:

- Correlate requirements, tasks, workflows, incidents and evidence durably.
- Separate planning/review execution from implemented, tested, approved,
  merged and deployed feature states. Terminal task success is not acceptance.
- Reuse existing persistence where suitable; a filename in an old plan is not
  a requirement to introduce a redundant store.

R16 — No-verdict incident reporting:

- Preserve and deduplicate sanitized incidents for context/budget overflow,
  missing/partial output, admission failures and interrupted work.
- Explain what failed, evidence/provenance and the next safe action in shared
  local task/conversation reporting. Never treat failure as approval.
- Preserve redaction, bounded storage and existing incident correlation.

Implement incrementally: first the aggregate-counter regression, then durable
admission/backlog and incident/request-state improvements in reviewed steps.
Use fake clocks/providers and temporary stores; do not overload live accounts.
Run focused queue/incident/controller tests and the full suite. Test genuine
quota limits still apply, no stale-probe double dispatch, cancellation during
backoff, legacy restart records and unknown-outcome writer recovery.

## Prior planning evidence and corrections

The preserved Claude planner inspected queue/incident/controller sources and
selected server consumers on parent `b0fc1bf`, without writing files or running
tests. It could not read operator documents outside its read boundary. Its
`PLAN_STATUS: READY` is a proposal, not accepted implementation or approval.

Useful leads to recheck on your exact base:

- Admission retries persisted `queued` but removed tasks from the in-memory
  pending list; aggregate stats used only that list.
- Startup reconciliation interrupted queued records, so recovery needed an
  explicit safe resumability policy rather than unconditional replay.
- Suggested persisted retry timing, dependencies, classified failures,
  request correlations and additive controller hooks need compatibility tests.
- Server admission counters and runtime hook wiring are outside this lane;
  identify integration gaps instead of silently editing those files.

Do not adopt the proposed stale-probe slot-reclamation watchdog: it can allow
overlapping work if a probe is incomplete. Nor is `dangerous=false` alone proof
that any arbitrary task is safe to replay. Reuse the prior analysis, correct
these assumptions, and obtain an independent review of the actual patch.

The parent quota fix keeps subscription capacity unknown absent current
vendor/operator evidence. Configured budgets must not report exhaustion or
steer subscription routing; real vendor gates remain. Do not undo that fix.
Local budget overflow is not automatically a vendor context-window limit.

## Operating and handback rules

On Shane's computer, use WSL under `/home/upton`; read `AI_WORKFLOW.md`,
`WORKSPACE_MAP.md`, applicable `AGENTS.md` and skills. If local files/MCP are
unavailable, use this GitHub packet and report the limitation. Do not pretend a
new cloud account has local tool access or an independent Claude seat.

Check current context/workflows before invoking providers. Use Claude for
appropriate independent planning/review with explicit model and effort;
preserve exact request/task/receipt IDs. Review against a frozen commit.
Use current subscriptions; no paid API setup, shared-auth overwrite or safety
bypass. Missing provider output is NO VERDICT; keep the PR draft if required
review is unavailable. A read-only plan cannot claim a writer lease.

Return PR URL, branch/base/head SHAs, changed-file list, requirement coverage,
tests and outcomes, review receipts/limitations, remaining integration needs
and explicit NOT MERGED / NOT DEPLOYED status. Do not start another backlog
lane when this one finishes. The original coordinator reviews and merges.
