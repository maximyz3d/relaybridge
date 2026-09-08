# Overnight refinement — September 8, 2026

Work in progress on `codex/overnight-refinement-20260908`, based on
`df8ea13c7aa31e67f8ff69af2719f0f0116badbc`. PR125 merged that preserved
integration as `b79ee08b9414e42c3b13986c39ea43bcbb6967aa`; release automation
advanced main to `fb6ffd556e97ef8cafaacd64d21643739bef0374` (v2.2.1).
The installed shared bridge remains unchanged. This document is an evidence
record, not an unattended-operation or deployment certificate.

## Accepted plan and implementation decisions

Canonical workflow: `wf_mts54ggk_485952d5a861`. Fresh read-only Claude
Opus/high planner task `t_mts59j0o_22gza5`, receipt
`rcpt_mts5rcac_58f5d647`, request/invocation
`oneshot:e0dabf55-5281-4863-a357-f3fda5c63f53`, attempt suffix `:attempt:1`.
Observed model `claude-opus-5`, completed/nonpartial, result subtype success,
terminal completed/end_turn; `PLAN_STATUS: READY`. Full result: 27,960
characters, SHA-256
`2ba870c6a2303bc98c784272c832c23719adbd41374e45808bf17f9648e57480`.
The workflow artifact clipped the middle to 24,000 characters. Root retrieved
and read the complete task result before accepting the plan; the clipped
artifact alone was insufficient.

Root alone holds the implementation writer lease. Native researchers and
hosted reviewers remain read-only and do not write GitHub. Four passes:
task UI; output guidance and curated discovery; native provider qualification;
cross-area refinement, behavioral evaluation and independent closing review.

Decisions correcting or narrowing the planner's suggestions:

- Keep the existing queue module untouched. Resolve optional output guidance
  once at supported submission boundaries into ordinary prompt text, appended
  after the original task. Preserve original classification through existing
  tier fields; validate original and compiled grounding conservatively. Reject
  compiled queued prompts above the queue's 100,000-character limit rather
  than allow silent clamping. Never reinterpret raw prompts as special
  envelopes. The stored text records criteria/version/digest; it is not a new
  structured profile lifecycle or authenticated provenance field.
- Profiles grant no authority. Cache identity must include the actual admitted
  prompt. Existing queued text remains unchanged when a catalog changes; it
  is not recompiled or revalidated against a newer profile version.
- The user's Grok request authorizes bounded native package qualification.
  The planner's suggested installation non-goal was narrower than that request.
  Root downloaded the pinned Linux x64 1.0.13 archive and verified its registry
  SHA-512 before any execution. This is not yet runtime qualification.
- Installed Gemini 0.57.0 discards local `admin.*` settings and has MCP
  allowlist-intersection hazards. Do not use those settings or plan mode as
  enforcement. Use a dedicated configuration home and effective non-admin
  restrictions; keep execution blocked until actual negative tests and
  authentication establish the supported boundary.
- Add useful discovery to existing surfaces without running third-party
  plugins or pretending an unprobed MCP reference is connected. Locally
  authored guidance and immutable source/license references are distinct.
- Optional workflow guidance is not claimed end-to-end unless existing
  runtime artifacts actually supply it. No unwired optional-hook completion
  claim or second architecture is permitted.

## Standing limits

No paid API authorization has been received; use existing/free/subscription
access only. No credential copying, shared restart, installation of the new
bridge, old task replay, or recovery changes. Issue122's six legacy uncertain
records remain held. No new queue, incident logger, request ledger, controller
or persistent-goal store. The reserved no-HEAD review-packet lane is untouched.

## Pass 1 — task interface

Task counts expose ready/deferred/dependency/uncertain states without deriving
activity from conversations. Details display all bridge-retained output,
receipt/correlation and failure evidence. Explicit plan preview submits the
returned execution tuple; changed drafts invalidate previews. Polls preserve
controls and reject stale responses. Late submissions cannot erase a new
draft; contradictory partial-output flags remain NO VERDICT.

Validation: five pure state tests and one actual Chromium browser test passed
(6/6), plus the existing inline-page/server/MCP syntax check. The browser
loaded the actual page, local assets and CSP using synthetic API responses;
it never contacted a running bridge, provider, credential file or external
origin. It covered focus retention, filtered-row reorder, Tab containment,
Escape/focus restoration, stale/failed responses, late agent-list responses,
changed drafts during submission, exact preview tuple, and 390/640px layouts.
Screenshots were visually inspected. The 640px check establishes reflow,
**not actual 200% desktop browser zoom**. No screen-reader audit is claimed.

The optional browser test is in `test/dashboard-state.test.js`. Run with
`RELAYBRIDGE_BROWSER_MODULE` pointing to an existing Playwright package;
`RELAYBRIDGE_BROWSER_EXECUTABLE` can select an existing Chromium executable.
It skips when no browser package is configured, so ordinary CI does not
silently claim browser coverage. Local qualification used Playwright 1.63.0
and cached Chromium headless shell build1243, with missing Ubuntu libraries
extracted into a private temporary directory. No system packages were installed.

Independent native read-only review found and root fixed four concrete
submission/focus/partial-output/stale-preview defects; regression cases passed afterward.
This supplements rather than replaces the pending fresh Claude closing gate.

## Pass 2 — output criteria and public workflow references

Six optional profiles now reach REST/MCP preview, direct/routed execution,
committee members/chair, broadcast and queued tasks. Queue records retain
ordinary compiled text and existing execution/tier fields. Full prompt checks
preserve original grounding, reject expanded queue overflow, pin admission to
dispatch with the actual final-prompt hash, and prevent inconsistent responses
from becoming cacheable completed results. No new execution-state store exists.

The Tasks composer exposes exact profile choices and criteria; stale selections
remain visible rather than silently disappearing. A curated library contains
six immutable public source/license references with source-file digests and
locally authored guidance. Every entry is explicitly unconnected. A standalone
output-quality skill and corrected RelayBridge usage instructions are included;
existing client registrations and the shared installed bridge are unchanged.

Validation: 16/16 focused tests passed, including actual Chromium UI acceptance,
profile/compiler/catalog checks and disposable REST/MCP/queue/grounding fixtures.
The fixture provider captured actual delivered prompt text. Cases include
multiple profile versions, removed selections, reference-link focus after
refresh/failure, cached-result admission tampering, missing actual response hash,
policy drift rejected before invocation, and a later committee member's expanded
input rejection before any member starts. An additional 17/17 bridge/MCP
integration tests passed. Both changed/new skills passed `quick_validate.py`;
`git diff --check` passed.

Native read-only reviews found and root corrected profile version collisions,
removed-selection fallback, link focus loss, committee preflight omission,
routing selector omission and prompt-hash correlation gaps. Focused backend
re-review reported no remaining material findings. This is supplementary static
review, not the fresh Claude closing gate. Behavioral evaluation prompts are
committed, but no measured model-output improvement is claimed yet.

## Pass 3 — native Grok and Gemini qualification

Native provider JSON now has separate strict parsers, including Gemini errors
written to stderr. Malformed, missing, contradictory, cancelled and warning-stop
results cannot become successful answer text. Only qualified nonzero error
envelopes supply authentication authority; answer text and auxiliary warnings
cannot invent account failures. Diagnostics use the existing secret redactor
before truncation. Unknown usage, observed model and Gemini terminal reason
remain unknown. Grok's candidate `end_turn` indicates a transport result,
not artifact approval. Unverified launch policies still block execution.

Grok was qualified in a private temporary directory, not installed on PATH.
The official Linux x64 1.0.13 archive (46,387,591 bytes) matched registry SHA-512
`t0TpPmsEZwwS0utHq07L1oPX7tMgufAazIziccGn8IdTpo8ihqZ7KjaI6wikROXExfjvwTh83m4B0PL2ErPeiw==`.
Only the reviewed regular binary member was extracted. Its SHA-256 is
`edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1`;
the actual version is `grok 1.0.13 (5e9a58528b76)`. Version, help and a headless
negative smoke ran in a fresh bubblewrap namespace with no network, host home
or credentials. The headless call exited 1 with the structured signed-out error.
Hidden `--no-auto-update` and `--no-leader` flags were accepted by the headless
parser; an invented flag was rejected. Acceptance does not prove enforcement.

The positive Grok grammar is provisional, derived from the immutable upstream
[headless documentation and emitter](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md).
That source revision differs from the package gitHead
`5e9a58528b76b6128ee610059d79aecaa71b9b8d`; an authenticated binary result has
not confirmed equivalence. Existing historical 0.2.106/Grok 4.5 evidence is
preserved but explicitly does not qualify 1.0.13/Grok 4.6. Current model
availability and authenticated invocation remain unverified.

The installed native Gemini CLI reports 0.57.0. Its separate `gemini_cli`
entry is opt-in and does not replace the existing Antigravity `gemini` entry.
A fresh, network-isolated configuration home, explicit OAuth subscription
requirement, native headless arguments and candidate deny policy produced exit
41 with a structured authentication-not-configured error on stderr. No real
credential files were read or copied and no login was started. Native Gemini
has no qualified `--effort`, `--cwd` or Antigravity `--print` compatibility.

The candidate settings and policy files are qualification fixtures, **not
runtime-wired enforcement**. In the installed 0.57.0 components, the effective
policy denied all seven tested tool names (shell, write, replace, exit-plan,
skill, agent and unknown tool). The tool registry contained zero tools and a
child-process launch trap recorded zero attempts. This is component evidence;
it does not establish complete CLI startup isolation with inherited settings,
MCP discovery or system policies. Local `admin.*` settings are discarded,
empty/intersected MCP allowlists can become unrestricted, and system policy
files can displace `--admin-policy`. The production launcher must independently
qualify these cases before lifting the existing unverified-policy block.

Qualification-file SHA-256 values:

- `config/gemini-safe-policy.toml`:
  `c90d31b6c027738350459ef9745339a2bd24ba6221eabbd41aa5ae87571278a4`
- `config/gemini-safe-settings.json`:
  `02828af63a5edae52090d458af7b0cb36161c7305ed7a33c35059cdc28a356f6`
- Installed Gemini entry chunk `gemini-OYYGXMHL.js`:
  `704ff10d3472184f689e81ed6fe6aa26be1ab9df30dfc66c04d5f69cd4c4f3f6`
- Installed settings chunk `chunk-GAROUUGQ.js`:
  `d71bc4ccf306f66ad0ef844137f96b60ea5132616ead94bf042325938ac71c21`
- Installed core chunk `chunk-7HKQGPWB.js`:
  `9cce071bd5b23596e4b7e59b278107fe92c594d852443274e04e5fa2e5d1f080`

Validation: 20/20 native parser, disposable REST wiring and existing bridge
tests passed. These include actual signed-out envelope shapes, stopped and
mismatched authentication exits, warning/error precedence, secret redaction,
unknown telemetry and zero invocations through an unverified provider policy.
Independent native read-only re-review reported no remaining material findings.
There is **NO VERDICT on authenticated Grok/Gemini usability or complete native
filesystem enforcement**. No paid API or credential changes were attempted.


## Pass 4 — cross-area checks and measured limitations

Short substantive planning, collaboration and constrained decisions now reach
standard reasoning without relaxing critical/destructive or deterministic
routing gates. Paired action/criteria checks preserve simple scheduling and
word-definition cases. Native re-review identified and root fixed overly broad
meeting/calendar/terms exclusions and polite-request wrapper omissions.
The routing suite passed 16/16. Version-only authentication refreshes now say
that authentication is unverified, or use the configured probe detail; a
successful version probe still cannot clear a durable live auth failure.
The existing linked-account regression verifies both presentation and authority.

### Evaluation method and earlier regressions

Initial exploratory samples used the older shared bridge build
`2.0.1+c3c865c097afa2e8`, which launches Claude in plan mode. Both conditions
included a no-tools/no-files instruction. The planner-style output complained
about unavailable Write access; that statement is not proof of a tool attempt.
These samples exposed verbosity and evidence-language regressions and are
retained below, not combined with the later current-code comparison.

| Case | Baseline words / receipt | Profiled words / receipt | Limit |
| --- | --- | --- | --- |
| cache-race | 119 / `rcpt_mts7zj0h_4fd17f33` | 172 / `rcpt_mts7znhv_4db69d89` | 140 |
| handoff-plan | 188 / `rcpt_mts84lsy_aff3caa0` | 162 / `rcpt_mts8516t_8bb63fa0` | 160 |

The profiled pseudocode answer called its deduction reproduced; the plan added
unnecessary architecture and proposed a rollback that dropped required retry.
Root revised the criteria and rubric. Rubric version 1 remains in Git history;
version 2 separates word limits, evidence honesty and required behavior.

The controlled comparisons below used disposable current-code RelayBridge
instances: production identity validation, fresh private data/token/port,
empty GitHub enrollment registry, discovery and warm probes disabled, and only
the current Claude configuration. No task or workflow was created or replayed.
Each instance was shut down after its own calls. The installed shared bridge
was not restarted. Existing subscription authentication was used without
copying or changing credentials; this is shared account usage, not a new quota.

Every pair used the same original prompt, no-tools preamble, Sonnet alias,
standard tier, medium effort, 180-second timeout and requested budgets
(output 4,000, total 120,000, cache read 100,000, cache creation 30,000, turns 2).
Only the optional profile differed. Calls were sequential and order alternated
by case. The observed model was `claude-sonnet-5`; all 20 current-code calls
exited zero without a classified failure. Transport completion is distinct from
answer acceptance. No automatic answer truncation or rewrite concealed failures.
Configuration SHA-256 for both runs:
`ca56bd51319ee2317174cae803c8dc05b0943ab14b1e3c28050f33284b327907`.
Rubric v2 canonical JSON SHA-256:
`d71f70bd1c46a5d6d855f8f207d6c59b5de1abb89b469b547641da6d759e4cdd`.
Private result packets preserve request/attempt tuples and prompt/output hashes;
raw responses, credentials and runtime stores are excluded from this handoff.

### Six-case comparison

Head `de9000e09024f8860acda5ed5ee8dc453aaf8642`, build `2.0.1+a62b4e7477e7687f`,
receipt store `66dd496010feb0bdc549de0a0eb2df9651aaa142c823c97253e4dad8d82a747b`.

| Case | Baseline words / receipt | Profiled words / receipt |
| --- | --- | --- |
| cache-race | 110 / `rcpt_mts8u080_7136d820` | 122 / `rcpt_mts8u3sb_405fd361` |
| handoff-plan | 155 / `rcpt_mts8ue9q_81944705` | 140 / `rcpt_mts8u8tg_e026b8a7` |
| queue-design-choice | 134 / `rcpt_mts8ukbs_63c5afb5` | 160 / `rcpt_mts8uovn_6ed7190d` |
| source-gap | 79 / `rcpt_mts8uwth_17b08881` | 80 / `rcpt_mts8utut_89cb6b7b` |
| review-disagreement | 96 / `rcpt_mts8v01e_371c6746` | 89 / `rcpt_mts8v3rq_3d7bcd33` |
| dialog-friction | 108 / `rcpt_mts8vb9p_36fb7fe5` | 114 / `rcpt_mts8v79c_34add25f` |

### Bounded four-case recheck after criteria changes

Head `aa8e6960e98216b90a13da91f86f1189455c164c`, build `2.0.1+b9f3cb20a323ea5b`,
receipt store `90b253bd8b9f4012558e38069f95d0b5edaf55af35bf186d48f0175122d86b00`.

| Case | Baseline words / receipt | Profiled words / receipt |
| --- | --- | --- |
| cache-race | 126 / `rcpt_mts90xcn_283c54c5` | 171 / `rcpt_mts911oi_e356763b` |
| handoff-plan | 145 / `rcpt_mts91dc0_fb6f109f` | 163 / `rcpt_mts918dd_c642e62d` |
| queue-design-choice | 111 / `rcpt_mts91h0z_7ea3b6d0` | 119 / `rcpt_mts91m3n_f0074e6a` |
| dialog-friction | 105 / `rcpt_mts91sst_b3b30c91` | 85 / `rcpt_mts91ppn_02d1ad75` |

The six-case outputs were assessed with condition labels blinded by a separate
Codex call: configured `gpt-5.6-terra`, high effort; no observed model revision,
usage or provider terminal reason was reported. Receipt
`rcpt_mts8wovb_fefedd65`, transport receipt `rcpt_mts8xejb_77980ad6`,
request/invocation `mcp:360430b0-ce4b-47e0-b306-ed6a7297f329`, attempt suffix
`:attempt:1`. Exit zero, one physical invocation, nonpartial complete JSON
covering all six cases; answer SHA-256
`03cbfbbd7117b031bf8d8fffb2b6fcf1a007720ef4bcadd63e5c262da37f3343`.
Requested provider budget enforcement was unavailable for this Codex adapter;
the process timeout and read-only mode were still configured. This is an
advisory assessment, not a closing code-review verdict.

Its criterion totals were baseline 52/58 and profiled 51/58, with two accepted
answers per condition. It preferred baseline for planning/UI, profiled for
collaboration, and tied the other three. Root retained the scores and their
limits: the collaboration replay distinction is an assessor interpretation,
not proof that any execution occurred. The code samples omitted rejected-promise
cleanup; the planning sample did not first establish the shared contract.
The decision and UI profiled samples exceeded their explicit limits.

Root tightened the decision/UI guidance and added failure-path and shared-
contract criteria. The recheck delivered the intended cleanup and contract
content and brought decision/UI below their limits, but coding (171/140) and
planning (163/160) still breached explicit limits. The planning answer still
proposed job infrastructure without establishing it was necessary. This
recheck is root inspection, not another blinded score or a reliable gain estimate.
No aggregate model-quality or general improvement claim follows from these
small, adaptive samples. Profiles remain opt-in and cannot certify length,
correctness, approval or acceptance; omit them when the original request
already supplies sufficient criteria. Required-output checking remains an
agent/reviewer responsibility. No automatic quality scoring store was added.

## Closing validation

Implementation head `aa8e6960e98216b90a13da91f86f1189455c164c` passed
`npm test`: 1,014 tests, 1,009 passed, zero failed, five skipped (optional
browser fixture, skill installer and three native Windows cases). A separate
actual Chromium run passed all six dashboard tests, including the normally
skipped browser fixture. `npm audit --omit=dev` reported zero vulnerabilities.
Both changed/new skill manifests passed the skill validator. `git diff --check`
passed. Native Windows acceptance belongs to the exact-head GitHub Windows job.
Fresh Claude review evidence and final CI results will be appended when complete.
No unattended-ready, native-provider-ready, recovery/controller/goal completion
or deployment claim is made by this record.
