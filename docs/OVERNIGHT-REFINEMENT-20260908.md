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

Final suite results, reviewed SHAs and closing verdicts will be recorded here
when obtained. No overnight completion claim yet.
