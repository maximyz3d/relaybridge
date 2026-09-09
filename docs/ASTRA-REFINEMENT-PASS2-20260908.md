# Astra refinement set 2

Canonical external run: `RB-ASTRA-REFINEMENT-2-20260908`.
Base: `03cfb00eae34ad8197e7a5d0d83e6927214dbb39` (main, v2.3.0).
Branch: `codex/astra-refinement-2-20260908`.

The owner requested another set of refinement passes and publication. Root is
the only writer and GitHub publisher; native delegates use Astra/ultra and are
read-only. This isolated worktree has no matching active managed workflow.
The connected older bridge does not support the Astra-only workflow profile,
so this packet tracks the external workflow permitted by AGENTS.md. The old
coordinator workflow and its retained lease are not resumed or replaced.
Intake context receipt: `rcpt_mtth484q_06dc8f5b`.

## Plan and scope

1. Independent read-only audits: lifecycle/version consistency, workflow UI,
   and provider/output correctness. Root separately checks dependency health.
2. Implement the confirmed bounded findings in independently testable commits.
3. Verify combined behavior with fixtures, browser tests, the full relevant
   suite and production dependency audit.
4. Obtain fresh independent Astra review, resolve material findings, and push
   the exact commits with sanitized evidence. CI/review determines merge readiness.

Root owns the accepted source/test/doc changes in this worktree. Initial
accepted dependency scope is `package-lock.json`: upgrade the existing
transitive Hono dependency within its supported range. No new dependency or
runtime installation is needed. Additional audited scopes and results are
recorded below before implementation.

The initial production audit found Hono 4.13.3 and three moderate advisories;
the upstream patched floor is 4.13.5: [static generation traversal](https://github.com/honojs/hono/security/advisories/GHSA-gqvv-2mrq-wpjv),
[body nesting](https://github.com/honojs/hono/security/advisories/GHSA-g6gw-c38x-mqfc),
and [query parsing](https://github.com/honojs/hono/security/advisories/GHSA-crvj-82cr-hjcx).
This dependency finding is not a claim that every affected helper is reachable
through RelayBridge. Existing MCP HTTP and stdio tests cover compatibility.

## Boundaries

No Claude/Fable calls, credential changes, provider authentication claims,
legacy task replay, uncertainty release, new queue/ledger/incident store, or
reserved no-HEAD review-packet work is part of this pass. Native Grok/Gemini
qualification, owner/controller/goal acceptance and deployment remain distinct.

The existing shared bridge still serves other callers. Its old shutdown code
cannot drain new admissions safely; upgrading source does not repair that
already-running process. Deployment needs an established pause of submissions
and completed outstanding calls. No shared cutover is performed by this pass.

## Evidence

Implementation checkpoints:

- `88076d9`: Hono 4.13.7; production audit clean, MCP compatibility 10/10 PASS.
- `ab715c9`: workflow draft/focus fixes; Chromium 2/2 PASS. Native Astra UI
  review APPROVE, plus independent synthetic detail-failure/recovery,
  creation-race and accessible-description checks.
- `bf8ce7c`: native Gemini/readiness fixes; focused 44/44 PASS. Native Astra
  review APPROVE, including 24 independent pure-function checks.
- `8d57637`: npm release metadata; version/build/template checks 96/96 PASS.
  Native review requested a fleet marker correction: the old maximum was
  already v5. `9f196d7` raises the shipped release workflow to v6; 65 focused
  version/GitHub checks PASS. Reviewed commits were not amended.
- Lifecycle fixtures: 36/36 passed before the added remote callback case;
  the new actual-server remote disconnect/barrier case passes independently.
  It uses the SDK's registered callback update API because assigning only the
  exposed handler would leave the cached executor unchanged.

Full suite on code head `aa494c318e11e63c3e8d56f2b3d358f7c3140cb4`:
1,060 tests, 1,056 passed, zero failed, four skipped (101 seconds).
Chromium tests ran using disposable tooling outside the repository. Skips were
the environment-dependent skill installer and three native Windows cases;
Windows qualification depends on CI. Production `npm audit --omit=dev` reports
zero vulnerabilities. Build preparation reports `2.3.0+7a059becfcbac0c5`.
Private fixture outputs are local; no raw machine logs or runtime transcripts
are published.

Fresh independent native Astra/ultra closing review `/root/astra_closing2`:
`REVIEW_VERDICT: APPROVE`, bound to the complete base-to-code-head diff above.
It inspected shutdown admission/lifetimes and the installed MCP SDK callback
update contract; no material code findings remained. Its nonblocking README
restart correction is included after the reviewed code commit. The release
auditor `/root/astra_ui_audit2` separately approved corrective `9f196d7`,
confirming both mirrors advertise v6 and the fleet upgrade regression passes.
The lifecycle and provider auditors also returned bounded APPROVE verdicts.
These native review identifiers are not RelayBridge provider receipt IDs or
Claude verdicts. No Claude was invoked. Provider authentication, legacy fencing,
Windows replacement and shared deployment are not qualified by these reviews.

Root staged only the named implementation/tests and this sanitized handoff;
the code commit was clean before review and was pushed without rewriting its
ancestry. The closing documentation commit also owns `README.md`.

## Accepted audit findings

The read-only native UI audit reproduced selection/draft loss when a selected
workflow falls outside the latest 40 records, and keyboard focus loss when
actions are rebuilt during a request. Root accepts fixes in
`public/workflow-panel.js`, `public/index.html`, and `test/workflow-ui.test.js`.
Acceptance preserves the selected ID/draft through list truncation, clears it
only on an explicit selection change, retains focus within the workflow on
action success/rejection, leaves editor focus alone, and exposes blocked-action
reasons as accessible visible text.

The native provider audit reproduced native `gemini_cli` refusal/progress-only
answers bypassing the existing Gemini detector, and auth refresh ignoring
configured probe expectations/rejection strings despite diagnostics honoring
them. Root accepts bounded fixes in `lib/provider-failure.js`, `server.js`,
`test/provider-failure.test.js`, `test/provider-output.test.js`, and
`test/operation-admission-rest.test.js`. Acceptance preserves exact-output,
translation and planning exceptions; signed-out exit-zero probes cannot report
ready or clear a quarantine, and incomplete probes remain non-authoritative.

The lifecycle audit identified that shutdown ignores admitted HTTP executions
and allows new admissions during its delayed stop. Root accepts correction in
`server.js` with fixture coverage in `test/http-lifecycle.integration.test.js`
and the existing REST admission tests. Closing admissions must be synchronous
with accepting shutdown, separate from cleanup idempotency, and must not
release uncertainty or replay tasks. Release-version consistency is still
under audit before selecting its exact scope.

The completed release audit confirms VERSION is 2.3.0 while root npm metadata
still says 2.0.1. Root accepts changes to the canonical and installed
`compute-version.cjs` and `version-on-merge.yml`, current `package.json` and
`package-lock.json`, plus `test/versioning.test.js`. The release commit will
update existing root npm version fields alongside VERSION without executing
npm lifecycle scripts, changing dependency entries, or requiring npm manifests
in non-npm repositories. Malformed/symlinked inputs must fail before writes.

Lifecycle integration additionally owns `lib/remote-mcp.js` and the existing
`test/bridge.test.js` compatibility assertion. Busy details identify overlapping
reservations rather than mislabeling their sum as a unique execution count.
The adjacent Windows REST restart helper has no retained-process handshake and
force-stops its target. The automatic `/api/admin/restart` endpoint now returns
501 on every platform, leaving the bridge running, until a qualified replacement
path exists. The MCP stop/start workflow remains separate. This deliberately
removes the unsafe automatic helper from the REST execution path; it does not
claim Windows restart qualification or change the standalone helper file.

## Live review transport finding and correction

PR: <https://github.com/maximyz3d/relaybridge/pull/128>.
Published checkpoint: `6bebfdba7468e8f0eccbfc89a1e06e74cdd1714d`.
Linux, Windows (including MCP registration and installer lifecycle) and CodeQL
passed on that checkpoint. Astra `/root/astra_closing2` also approved its
documentation-only delta from the prior reviewed code head.

Two bounded read-only live review attempts ran through a disposable bridge;
neither returned a complete verdict and neither is approval:

- First attempt: temporary MCP client harness used the wrong SDK timeout-option
  position and expired before a result. NO VERDICT. Context receipt
  `rcpt_mttib4ta_d4bd90dd`; preview receipt `rcpt_mttib4wa_045be07e`.
  No complete provider result/receipt was retained from this harness attempt.
- Second attempt: NO VERDICT. MCP receipt `rcpt_mttie1h7_2e2164df`, bridge receipt
  `rcpt_mttikhgh_a350336d`, run `run_mttie1ho_e7ebb182`, request/invocation
  `mcp:87b11cc0-b901-4599-abc7-85e0bdf4d07d`, attempt
  `mcp:87b11cc0-b901-4599-abc7-85e0bdf4d07d:attempt:1`.
  The HTTP fetch failed after 300,632 ms while the provider was producing
  output, despite its 900,000 ms configured budget. The bridge subsequently
  recorded client cancellation. Requested/outgoing model was `gpt-6-astra`,
  applied effort `ultra`; vendor-observed model remained unknown.

The timing is consistent with the installed Node v22.23.2 / Undici 6.28.0
[independent 300-second header/body defaults](https://raw.githubusercontent.com/nodejs/undici/v6.28.0/docs/docs/api/Client.md).
The generic fetch error alone cannot prove which internal timer fired.
Root accepts additional ownership of `mcp/bridge-client.mjs` and
`test/mcp-bridge-transport.test.js` to remove that hidden transport ceiling.
The existing loopback transport uses built-in Node HTTP with a dedicated socket,
the caller's bounded abort signal through body completion, unchanged identity
and token checks, no redirects or retries, and byte/chunk response bounds.
The two-second capability bootstrap remains separate. Accelerated regressions
cover buffered headers, request deadline and caller cancellation before/after
headers, malformed truncation, redirect refusal, and no repeated failed POST.
Fresh correction checks and closing evidence follow before merge.
