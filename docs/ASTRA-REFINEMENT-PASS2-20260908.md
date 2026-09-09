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

Implementation, full-suite and closing review results are pending.

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
