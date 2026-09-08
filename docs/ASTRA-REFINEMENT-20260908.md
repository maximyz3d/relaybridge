# Astra refinement and remaining acceptance

Base: `b04ae3a0fec6a8ef5245711aabf6c18f729397fb` (main v2.2.2).
Branch: `codex/astra-remaining-20260908`, isolated Linux worktree.
The owner's September 8 instruction transfers remaining implementation to this
root writer and prohibits Claude/Fable for the rest of this chat. Earlier merge
authorization remains in force. Native delegates are read-only Astra/ultra;
only root edits, commits and writes GitHub. Historical reviewed work and its
ancestry remain preserved. No shared restart, deployment, credential changes,
paid API setup, old workflow/task replay or uncertainty release is performed.

The prior overnight workflow is complete. The old durable-coordinator workflow
has an expired external lease; it is not resumed or replaced as a writer. This
branch refines current main in a new isolated workspace. Current GitHub had no
open PRs when work started. Review restrictions apply to provider calls, not
deterministic tests whose fixture provider identifiers include historical names.

## Pass 1: explicit model policy and external revisions

The existing workflow store now persists a Codex-only Astra/ultra policy.
Planning and review cannot append a prohibited provider fallback, including on
retry/restart. Exact model/effort follows the existing task body, CLI controls
and archived workflow binding. Extreme effort remains explicitly authorized;
unsupported CLI controls cannot silently downgrade it. The shipped Codex heavy
tier identifies Astra, consistent with [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model).
That documentation and configuration do not prove this account's live access.

The supported external revision path retains the existing lease and artifact
store. Explicit external ownership survives reconciliation and cannot use
provider binding/orphan cleanup. Historically ambiguous revisions remain held.
Completion stores corrective evidence; a fresh closing review is still needed.
No new queue, ledger, incident logger, owner journal or goal store exists.

Independent read-only native audit `astra_workflow` found that the first patch
compared execution controls at the wrong task-record level. Root corrected it
to the real persisted task body, added body/provider/workspace correlation and
a real REST/queue/CLI fixture, and strengthened loaded binding phase checks.
Schema-2 workflow policy uses the existing schema-1 lock format for compatibility.
This audit is a finding receipt, not a claimed final approval or Claude verdict.

Focused validation checkpoint: 77/77 passed across workflow state/controller,
prompts, exact controls, real REST queue dispatch and MCP integration. The skill
validator and whitespace check passed. Later commits record full-suite and
independent closing results. Tests dispatch fixture scripts, not hosted models.

Full pass-1 suite: 1,021 tests, 1,016 passed, zero failed, five intentional
platform/optional skips. The subsequent model-family metadata addition passed
its focused suite together with workflow state/controller checks. Production
dependency audit reported zero vulnerabilities. Live Astra/ultra invocation and
closing review are not established by these deterministic results.

## Remaining acceptance inventory

Three Astra/ultra native read-only audits compared all 23 open issue bodies and
comments against this exact base. Existing implementation is distinguished from
installed qualification and remaining code:

| Area | Current base and remaining work |
| --- | --- |
| #16 grounding | Capability/inline evidence implemented; explicit workspace omission and durable citation presentation need attention. |
| #17 quota | Durable shared-seat gates implemented; exact Gemini individual exhaustion/reset and qualitative unknown-count authority missing. |
| #19 MCP transport | Identity preflight implemented; surviving stdio supervision/reconnect missing. |
| #24 safe one-shots | Codex/Claude policy controls and budgets implemented; other native seats lack complete no-write qualification. |
| #70 active local calls | HTTP lifecycle and long CLI input regression coverage exists; installed evidence is separate. |
| #75 prompt integrity | One-shot full-prompt enforcement exists; interactive input integrity remains distinct. |
| #76 Copilot | Candidate permission flags available in source; writer qualification and structured first-denial handling missing. |
| #77 routing | Original semantic/capability regressions covered; no additional bounded defect confirmed by audit. |
| #78 Gemini deadlines | Original fixed print deadline corrected; startup and descendant-stop evidence remain separate. |
| #79 refusal | Reported refusal signature is classified unusable with regression coverage. |
| #80 local HTTP | Null/omitted budget and typed validation regressions implemented. |
| #85 write scope | No enforced declared-path boundary; diff reporting is diagnostic, not confinement. |
| #86 descendants | CPU aggregation exists; fanout limits, buffered progress and physical settlement remain incomplete. |
| #87 citations | Nested paths/file URLs fixed; successful/warning citation metadata needs durable propagation. |
| #93 hosted models | API-key presence still overstates configured-model readiness. |
| #94 exact controls | Shared model/effort contract and drift rejection implemented. |
| #97 budget truth | Local budget stops remain separate from authoritative provider quota. |
| #98 incomplete Gemini | Reported progress-only output cases are rejected with detector/hash evidence. |
| #102 Perplexity | Empty-answer sentinel rejected; explicit answer-path diagnostics missing. |
| #104 result recovery | Queue persists results, but direct caller timeout can lose answers; sanitized pending/result/acknowledgement protocol missing. |
| #105 Windows update | Bounded cutover retries exist; early locking-client preflight/qualification missing. |
| #112 enrollment | Runtime registry and migration implemented; actual host enrollment is operational, not proved by these tests. |
| #122 legacy recovery | Six reservations lack trusted historical owner bindings; all remain blocked and untouched. |

Additional verified gap: MCP run listing rewrites overdue records by age during
a read. That does not prove termination and should become an inert diagnostic.

The original P1–P5 roadmap still requires retained controller exclusion,
qualified attempt journal/physical settlement and effects reconciliation before
an unattended controller can be accepted. Its two-requirement restart/disconnect
episode, additive intent/evidence invalidation and managed canary are not
provided merely by the existing assertion ledger or this workflow profile.
No controller, persistent-goal, authenticated Grok/Gemini, unattended-ready or
deployment completion is claimed. Open issues are not closed by this inventory.

Next bounded passes cover result delivery/inert status, provider failure and
readiness accuracy, then cross-surface validation. Changes are committed in
independently testable slices; unqualified recovery/containment remains blocked.

## Pass 2: inert status and local-review routing

MCP run listings now retain the recorded status and file bytes. An overdue
progress horizon is returned only as a diagnostic with unknown execution state;
it does not rewrite a run as interrupted or release any resource. A regression
checks repeated list/read calls against exact bytes and mtimes for overdue,
legacy, invalid-deadline, future and completed records.

The first production-mode Astra review preflight exposed an existing routing
false positive: local code-review prompts mentioning current source/research
handoffs/evidence were classified as external research. Root narrowed that
heuristic while retaining explicit web/official-document retrieval gates. The
failed preflight invoked no model; receipt `rcpt_mtssmpo3_92f73f57`, request
`astra-review-d27453dc-901d-496a-a6c7-3105782c744e`, reports validation failure,
zero physical attempts and not-invoked usage. An earlier malformed planning
request also failed before invocation. Neither is review evidence.

All 18 focused router/status tests passed, including genuine external-retrieval
negatives. Live review is still pending. The shared bridge was unchanged.

## First live Codex review and corrections

A disposable production-mode RelayBridge instance reviewed frozen
`4eccef491171deeda7ac705204195ed366eb0cba` against the original base. Configured
and outgoing model were `gpt-6-astra`; requested and applied effort were literal
`ultra`, with no fallback. The CLI returned exit 0, one invoked result and a
complete **REVISE** verdict. Independently observed model and provider terminal
reason were unavailable; this is explicit-control invocation evidence, not an
observed model revision or a Claude review.

- Request/invocation: `astra-review-7f214879-1b82-443b-afc2-0e23f67a7823`.
- Attempt: `astra-review-7f214879-1b82-443b-afc2-0e23f67a7823:attempt:1`.
- Receipt: `rcpt_mtssyyhh_deab6766`.
- Runtime build: `2.0.1+87991f47c3a13bd1`.
- Complete answer: 4,888 characters, SHA-256
  `bed0632f8835fa9cd75876ac0381ed1a90a819cd81f74dd8844070e5b09faebd`.

The private runtime was shut down after review. Its receipt-store identity was
not retained by the harness, so this receipt is not advertised as recoverable
from the unchanged shared bridge. Raw answers/runtime state are excluded from
Git; the bounded findings and identifiers are retained here.

The reviewer found two material defects: an externally owned policy could load
with a contradictory provider ownership mode and reach orphan release; explicit
HTTP(S) retrieval inside a code task could lose its research gate. Root added
policy/ownership cross-validation plus an orphan-entry guard, and preserved
retrieval classification for explicit URL-fetch requests. Regressions verify
that all reconciliation/cancellation/orphan paths preserve the exact lock bytes
under contradictory ownership, and mixed URL retrieval keeps Codex ineligible
under the existing aptitude policy. All 59 focused workflow/router tests passed.
These corrections still require fresh independent closing review.

## Pass 2 continued: explicit queued result delivery

`submit_task` and `/api/tasks` now accept opt-in queued delivery with a
caller-known task ID. The existing task JSON stores the result contract,
sanitized semantic bytes/hash and explicit acknowledgement. GET is inert;
acknowledgement requires the exact store/hash and cannot release or replay work.
Known IDs never replay. New admissions retain unknown-execution reservations.
Workspace/prompt/control identity is pinned before dispatch, invalid correlation
and oversized prompts reject before invocation, and CLI run references now
propagate through the existing route/receipt path.

Independent Astra `astra_reliability_audit` found and root corrected short-ID
normalization, non-boolean partial flags, unvalidated loaded identity, exact
attempt matching and recognized environment credential-redaction gaps. Tests
include a corrupt file that attempts to redirect ACK onto another record;
neither file changes. No runtime credential was used in those tests.

The contract is explicitly scoped in `docs/TASKS.md`: no automatic conversion of
direct one-shots, no delivery event journal or fsync-qualified power-loss claim,
no universal removal of unknown secrets/tool narration from generic text, and
no exactly-once client consumption. Unsupported provider terminal identity stays
unknown. Issue #104 remains open for its broader acceptance requirements.

Delivery validation checkpoint: all 77 focused queue, result contract,
redaction, REST and MCP tests passed with zero skips. Those fixtures exercise
real bridge/queue wiring with local stand-in CLIs, not live provider accounts.
Fresh independent review of the final combined head remains required.

## Pass 3: browser workflow controls

The existing Tasks dialog now exposes a staged-workflow panel for the persisted
Astra policy and external revisions. It verifies policy, uses server next
actions, keeps GET refresh distinct from dispatch/reconciliation, and retains
lease tokens only in memory with explicit copy/paste controls. Other profiles
remain inspectable without accidentally dispatching a legacy advisor.

Native Astra `astra_workflow` identified response/selection races, permanent
blocking after confirmed token rejection, missing returned-policy verification,
and mismatched scope caps. Root corrected those findings. All eight focused
state/browser checks passed with headless Chromium, including real page scripts
under CSP, late list and claim responses, wrong-token correction, unsupported
profile rejection, four-hour renewal, final-review gating, and 390/640-pixel
layouts. Provider responses were local fixtures; this is browser acceptance,
not installed runtime or live provider qualification. Screenshots were inspected
locally and contain only fixtures. Full-suite and closing review remain pending.

Pass-3 full suite at `1849dcca41fd23476b9569140f6122a602f0dedb`:
1,040 tests, 1,036 passed, zero failed, four platform/optional skips; both
Chromium browser cases ran. A subsequent Astra review found two small UI
isolation defects: creating a new workflow retained the prior evidence input,
and workflow edits invalidated the unrelated task preview. Root corrected both,
added saved plan/acceptance inspection, and reran all eight state/browser checks
successfully. Evidence typed during an in-flight action is preserved.

## Pass 4: truthful Gemini quota exhaustion

Failed Gemini one-shot terminals now recognize the exact individual-quota
message, including punctuation/newline reset variants and bounded compound
hours/minutes/seconds. This is account exhaustion with unknown numerical
allowance. It is appended to the existing vendor ledger, projected across
configured aliases, and enforced before new explicit calls. Local budget stops,
successful quotations and mixed answers cannot become this authority.

MCP/REST receipts preserve the evidence and reset; the UI displays unknown
allowance. Existing numeric Grok quota semantics remain unchanged. Active
qualitative observations use the longest remaining reset; two already-in-flight
failures cannot shorten response/receipt retry guidance with a later weaker
observation. Heuristic cooldowns retain their actual capped deadline separately.

Astra `astra_provider_audit` found and root corrected a routing provider-key
collision, message variants, hostile timestamp coercion, and the concurrent
reset timing mismatch. All 121 focused provider/quota/accounting/MCP tests and
eight Chromium/state checks passed. New integration exercises real isolated
REST/queue-adjacent admission and receipts with synthetic CLI failures. No live
Gemini, Grok or Claude calls occurred. Interactive quota ingestion, native seat
qualification and pre-reset recovery proof remain separate acceptance work.

## Closing review at the complete feature head

Frozen code head `e0cbaf48fe383bade49c60837706d9e159ab6936` passed the full
local suite: 1,048 tests, 1,044 passed, zero failed, four platform/optional skips,
including both Chromium browser cases. Audit reported zero vulnerabilities;
skill validation passed. GitHub Linux and CodeQL passed; Windows was pending.

A fresh read-only Codex review through an isolated production-mode RelayBridge
returned a complete **REVISE** verdict, exit 0, one model invocation, no failure
or partial-result flag. Requested/outgoing model was `gpt-6-astra`, requested and
applied effort `ultra`, no effort fallback. Observed model and provider terminal
reason were unavailable. The receipt labels token accounting `chars_div_4`, so
no authoritative provider token usage is claimed.

- Request/invocation: `astra-review-38c42924-730b-44a1-a1a3-72f88d41cdc1`.
- Attempt: `astra-review-38c42924-730b-44a1-a1a3-72f88d41cdc1:attempt:1`.
- Run: `run_mtsurpy8_3b3b83d3`; receipt: `rcpt_mtsuxrmk_3fac1bbd`.
- Build: `2.0.1+98d079639595859f`.
- Receipt store: `12b10926143631c3f6aefcfb04b740ec6c0c746cb44fa1ba073e10ae1be9f869`.
- Complete answer: 3,942 characters; SHA-256
  `6b620a1f6051940899bf11a5b63cb728f281ffe5812fb672e21dc3bf034a79fd`.

The isolated runtime was cleaned up; its receipt envelope and identity were
retained privately. These identifiers do not refer to the shared bridge. No
raw transcript, runtime data or credential is published here.

Two findings were corrected: idempotent submission now validates the loaded
record against the caller's ID and collects using that caller ID; URL retrieval
classification allows bounded multiline/Markdown-list references. The new real
REST regression proves a corrupted source record cannot redirect a retry to a
victim result or modify either record. All 84 focused queue/delivery/router/MCP
checks passed. A fresh closing verdict is still required after these fixes.
