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

Final tests, reviewed SHAs, provider qualification results and closing verdicts
will be recorded here when obtained. No overnight completion claim yet.
