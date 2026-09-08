# Preserved owner/storage lane: coordination handoff

Transfer `RB-QUEUE-EXTERNAL-2026-09-07`; publication date September 8, 2026 UTC (September 7 on the originating host). **DRAFT; NOT MERGED; NOT DEPLOYED.** This document publishes the existing private roadmap as a sanitized, updated coordination artifact. It does not authorize recovery or claim the complete controller, goal-tracking, or unattended acceptance criteria have passed.

## Revisions, preservation and scope

| Identity | Full SHA |
| --- | --- |
| Current main / requested PR base | `5f55ad641ebc1d71fdf4ac2561cb487eed31810a` |
| Preserved original code head (P1A plus P1B) | `fc9a415445b2e3e369e243a053aab39daa51d382` |
| Existing PR118 head | `776692a64eba9b9c9c216ba67f94e2cb3d96d099` |
| Actual common merge base with current main | `7c0ccd41360b1c2157e3f4d74336afeb7fd7b655` |
| P0 integration merge | `7b4b428f4c6393ada7734d581cbba571f5acf9fd` |
| P1A expiry protection | `ca2b8e839094f52efa908dd6de2ccecd6b185efe` |
| P1B original reviewed unit, retained locally | `06d149d11a35b01dff6f1350245121d59f15f232` |
| PR120 merged commit | `08d901eb4bda06892951d84af54ac1a47cb23a44` |
| PR121 merged commit | `3d7ac2a4b004287cb7e5741c108b7f10f871f90b` |

Publication PR: [#123](https://github.com/maximyz3d/relaybridge/pull/123). Publication branch: `external/owner-storage-handoff-20260907`, based directly on the preserved original code head. Initial documentation commit: `e322383abaa6cd1a868e989567fb2c928bb247d8`. The final publication commit/head SHA is recorded in the PR and final handback; a file cannot contain the SHA of its own enclosing commit. Every publication-only commit is a descendant of `fc9a415`; no reviewed commit was amended, reset, dropped, reordered, or force-pushed.

The P0 merge retains **both** parents, PR118 head `776692a64eba9b9c9c216ba67f94e2cb3d96d099` and upstream `7c0ccd41360b1c2157e3f4d74336afeb7fd7b655`. This publication deliberately retains the broad PR118 history and its conflicts. It is not a clean-main implementation candidate. Before these documentation commits the preserved branch changed **133 paths** from the actual merge base; the exact path inventory is below. Those inherited paths are not newly claimed ownership or newly reviewed changes in this turn.

At intake, the source worktrees for `codex/durable-coordinator` at `fc9a415`, detached owner-recovery at `ca2b8e8`, detached owner-durability at `06d149d`, and the original PR118 checkpoint all had empty `git status --short` (tracked and ordinary untracked files). Ignored private data was retained in place. The shared project checkout had an unrelated untracked `.bridge.pid`, which was untouched. An isolated publication worktree was created at the preserved head; only this document and [the issue122 proposal](LEGACY-QUEUE-RECOVERY-PLAN-122.md) are added by this handoff. No runtime state, credentials, raw machine logs, transcripts, or private `data/` files are staged.

The source roadmap was `data/current-coordinator-roadmap.md` in the owner-recovery worktree, last updated after the outage at 2026-09-08 00:06 UTC. Its linked durable-coordinator design and accepted P1 interface corrections were read. Applicable repository `AGENTS.md` and the Codex-Claude pipeline skill were applied. The canonical existing workflow is `wf_mtnpzm3o_37de07ab5b0e`; status-only inspection found it implementing with an expired lease. It was not renewed, reconciled, restarted or replaced. No new managed workflow was created. The cancelled transfer workflow `wf_mtri7r8q_aadbed9429eb` remains cancelled.

## Existing reviewed ownership slices

The nine-file owner foundation, published in PR118, is:

```
lib/attempt-lifecycle.js
lib/linux-physical-owner.js
lib/linux-owner-identity.js
lib/owner-control.js
tools/pid1-gate.js
test/attempt-lifecycle.test.js
test/linux-physical-owner.test.js
test/owner-control.test.js
test/pid1-gate.test.js
```

P1A (`ca2b8e8`) protects expired writer ownership and makes the implementation-lease block visible. Its exact six reviewed paths are:

```
lib/workflow-controller.js
lib/workflow-pipeline.js
server.js
test/expired-writer-admission.test.js
test/workflow-controller.test.js
test/workflow-pipeline.test.js
```

P1B (`06d149d`, integrated as `fc9a415`) adds a strict Linux durable-file primitive. Its entire three-file scope is:

```
lib/linux-durable-file.js
test/linux-durable-file.test.js
docs/LINUX-DURABLE-FILE.md
```

Historical ownership of P1A does not authorize new changes to the coordinator's now-integrated queue/controller/server paths. The precise requested future owner/storage and legacy-verifier scope is in the issue122 proposal. This turn adds documentation only.

## Exact overlap with merged PR120 and PR121

GitHub readback confirms PR120 and PR121 are merged and main is the full SHA above. Both histories changed these **17 exact paths** since their common merge base:

```
README.md
cli-config.json
docs/FUEL-GAUGE.md
lib/provider-failure.js
lib/task-queue.js
lib/workflow-controller.js
lib/workflow-pipeline.js
mcp/server.mjs
package-lock.json
package.json
server.js
test/bridge.test.js
test/mcp.integration.test.js
test/prompt-file-cli.js
test/provider-failure.test.js
test/workflow-controller.test.js
test/workflow-pipeline.test.js
```

A read-only `git merge-tree --write-tree --name-only LOCAL MAIN` diagnostic found these **seven actual textual conflicts**, without changing a branch or worktree. Its conflicted diagnostic tree is `b70a82078bfc21c3de02fec29a0698c83b0da611`, not a reviewed integration commit.

| Conflict path | Exact integration decision needed |
| --- | --- |
| `lib/workflow-pipeline.js` | Reconcile local `WRITER_LEASE_HELD_EXPIRED` and genuine ENOENT-race handling with main `WRITER_EXECUTION_UNCERTAIN`. Both protect expired locks; expiry must never authorize takeover. |
| `test/workflow-pipeline.test.js` | Reconcile error-code assertion while retaining local concurrent-process, unchanged-lock-byte and corrupt/unreadable-lock coverage. |
| `server.js` | Reconcile `sendOneShotResult` failure/cooldown accounting, shared `planTask` refactor versus bounded admission/cancellation/exact execution controls, and final provider-output classification. |
| `mcp/server.mjs` | Retain local execution/grounding controls alongside main request-ledger imports and deferred/dependency/correlation task schema. |
| `test/bridge.test.js` | Retain both local-budget result assertion and main assertion that it creates no shared quota cooldown. |
| `package.json` | Reconcile inherited dependency/release metadata without reverting current main's release. |
| `package-lock.json` | Reconcile the corresponding lockfile with the final agreed dependency metadata. |

Textual automatic merging does not resolve these semantic overlaps:

- **Task admission:** local `lib/task-queue.js` retains explicit `model`, `execution`, `requiresWorkspaceAccess`, and `inlineEvidence`; main's submission body at lines 587-608 omits those fields. Preserve those controls alongside PR121's durable waits, dependencies, correlation, deadlines and uncertain reservations. The coordinator owns the merge and runtime validation.
- **Controller actions:** local `implementationLeaseBlock` suppresses completion/renewal when an implementing lease is expired or absent, and reports `unavailable_unbound_owner`. Main still advertises those actions in `nextActions`. Retain truthful blocking alongside main request links, revision heartbeats, incident classification and retry correlation.
- **Token budget versus provider quota:** local `retryableProviderFailure()` returns null for `failureClass === 'token_budget'` before considering rate-limit flags. Preserve that local-budget replay safeguard while retaining genuine quota/auth/concurrency safeguards and cooldown behavior. Configured token budgets do not measure subscription allowance.
- **Execution versus physical lifetime:** a returned response labeled `execution.state='settled'` in main's queue is not independently established namespace/descendant death. Integration must retain separate physical and semantic settlement, ownership, workspace effects and accepted usage.
- **Provider/server history:** inherited exact model/effort contracts, grounding and bounded operations overlap PR120 shared planning/delegation policy and PR121 vendor-evidence incident classification. This handoff requests no independent rewrite of those coordinator-owned areas.

## Evidence and review receipts

Fresh verification on preserved code `fc9a415`, in the isolated publication worktree, Linux, Node `v22.23.2`, npm `10.9.8`:

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Exit 0; lockfile unchanged. |
| `node --test test/linux-durable-file.test.js test/workflow-pipeline.test.js test/workflow-controller.test.js test/expired-writer-admission.test.js` | **69/69 passed**, zero failed/skipped; 446.050767 ms. |
| `npm test` | **833 tests: 829 passed, 4 skipped, 0 failed/cancelled**, exit 0; 83,196.185956 ms. |
| `npm audit --omit=dev` | **0 vulnerabilities**, exit 0. |

The four skips are the skill-installer source-resolution test and three native Windows tests (REST hostile argv/env, official Cursor child PATH, native argument roundtrip). This is fresh Linux verification of preserved code, not Windows/CodeQL verification of a reconciled merge candidate. No installed bridge was restarted or smoke-tested by this handoff. The coordinator separately reports current main Linux/Windows/CodeQL PASS, Claude closing APPROVE, and installed Sonnet read-only smoke PASS; exact receipts for those coordinator-host checks were not supplied here.

The following complete historical verdicts and exact task/result receipts were independently dereferenced during this handoff. They are narrow approvals, not approval of the whole preserved branch, its merge conflicts, deployment or legacy recovery. Raw review text and runtime receipts remain private.

| Reviewed slice | Model / effort observed | Task | Result receipt | Complete verdict |
| --- | --- | --- | --- | --- |
| Nine-file owner foundation, subsequently committed in PR118 head | `claude-fable-5` / high | `t_mtp7dw7h_yowght` | `rcpt_mtp7konu_e488ed8f` | `REVIEW_STATUS: APPROVE` |
| P0 integration snapshot, subsequently committed in `7b4b428` | `claude-sonnet-5` / high | `t_mtrpztsf_745eit` | `rcpt_mtrq5dhs_dc67113f` | `APPROVE_P0` |
| P1A six-file expiry safeguard | `claude-sonnet-5` / high | `t_mtrurdoe_14t2bn` | `rcpt_mtruw36n_407f4098` | `APPROVE_P1A` |
| P1B three-file unwired storage primitive | `claude-sonnet-5` / high | `t_mtrwkoey_qo31kh` | `rcpt_mtrwofr1_bab1725e` | `APPROVE_P1B` |

Complete correlation IDs (request ID equals invocation ID; each attempt appends `:attempt:1`):

| Slice | Request / invocation ID |
| --- | --- |
| Foundation | `oneshot:49fd4615-3cb1-445e-98de-b1b92bddd959` |
| P0 | `oneshot:1e2c15f3-36b2-46ba-a722-5a0c7aa95875` |
| P1A | `oneshot:c2d4f0cc-8443-498f-ac5e-9a2301255ecd` |
| P1B | `oneshot:78ee83c5-177e-4aa9-bb99-eb96b1ba4f64` |

Foundation review bound a pending snapshot at base `457380a702e0a3a0703ea07b3506ed744d706a3b`, later committed as PR118 head. It excludes backend admission, Windows owner, durable quarantine, census and cutover; callers must consume both streams, handle rejected `allowProvider`, and treat the namespace-local PID as diagnostic only. P0 reviewed frozen tree `44861ba1b130b909826cb8378cd395a36cfc99dc`, did not execute tests/audit, and did not fully trace Windows installer ordering. P1A/P1B were read-only source/test inspections, not independent test execution or full commit-hash verification. P1B approval excludes production wiring, power-loss qualification and protection against a concurrent equivalent-authority writer; its documented trusted-directory/exclusion assumptions apply.

Preserved planning/revision trail:

| Purpose | Exact task / result receipt | Outcome and limitation |
| --- | --- | --- |
| Original architecture plan | `t_mtq2h9js_d9tnfy` / `rcpt_mtq2k8qi_30800a11` | Fable/high `PLAN_READY`; proposal only. |
| P1 proposed interfaces | `t_mtrpvppt_jfw6sw` / `rcpt_mtrq1mic_d9027cba` | Opus/max `PLAN_READY`; not implementation approval. |
| P1 Fable design audit | `t_mtrurctq_qq2a0c` / `rcpt_mtrv8b7n_04e6f562` | Fable/max `REVISE_P1_DESIGN`; no subsequent whole-P1 approval claimed. |
| P1 corrected interface analysis | `t_mtrvgmer_hgo5gq` / `rcpt_mtrw2zdb_e9a5fca9` | Opus/max analysis with root corrections; not blanket approval. |
| P1B first revision | `t_mtrvd43a_zoe6rn` / `rcpt_mtrvx2nf_363c0cfc` | `REVISE_P1B`; directory mode/stage corrections precede approval. |
| P1B second revision | `t_mtrw8o69_zsomqr` / `rcpt_mtrwfrd1_bc2bda0a` | `REVISE_P1B`; conservative mkdir handling clarified before approval. |

P1 design-audit request/invocation: `oneshot:bf122a59-f34a-4a20-96bf-c1af1f1c5ea1`; corrected-interface request/invocation: `oneshot:65104b00-9102-43a5-b357-e8a45ec5d3b6`; both attempts append `:attempt:1`. Interrupted original calls `t_mtrq4th1_660g8i` and `t_mtrqw9mw_329r4j` supplied **NO VERDICT**. They are unrelated to issue122's six task IDs and are not their termination evidence.

Historical Windows evidence in the source roadmap: P1A 28 workflow/controller tests plus one native API test passed; P1B's 40 Linux-only tests intentionally skipped and its Windows import guard had no side effects. Those historical checks were not rerun on Windows during this publication. Historical P0 was 786 total/782 pass/4 skip; P1A was 793/789/4; P1B unit worktree was 826/822/4; combined code was 833/829/4 and has now been freshly reproduced on Linux above.

### Fresh issue122 proposal review

First complete architecture review: Claude **Opus/high**, observed `claude-opus-5`, returned **`RECOVERY_PLAN_VERDICT: REVISE`**, exit 0, completed/end_turn, nonpartial, untruncated, one physical model invocation, zero transport retries. This was a direct safe one-shot, not a queued task: result `rcpt_mtryxd9l_9207f303`; transport `rcpt_mtrz1p0z_588d4058`; request/invocation `mcp:81ae9dbc-8c14-42bf-9766-bd00089fbd72`; attempt `mcp:81ae9dbc-8c14-42bf-9766-bd00089fbd72:attempt:1`. Reviewed proposal SHA-256 `5876b52e06f8cbaca336cd289d1d8723bcc69f29dbca58a3d89c95f47c22516f`; full cleaned verdict SHA-256 `731c458e7a07cac749f31b1da765eb78a58e9b3512b8f18ac5401db3d78e3bdb`. No raw verdict/transcript is published.

Opus confirmed that the proposal correctly keeps all six reservations held. Required corrections were missing anchored audit reads, an explicit coordinator-owned lock mechanism/dependency, and a concrete fresh file/directory confirmation protocol after crash. Additional corrections bound event names/size/scanning, made audit-facility selection a coordinator prerequisite, assigned preservation/no-dispatch acceptance jointly with the queue owner, specified per-ID stale-binding failure and fresh re-inventory/proof, and added explicit negative legacy-probe tests. These are documentation-only revisions. No source/test interface is implemented. The evidence document was created while that review was running, so it was absent during the reviewer's early read; it is now committed with the proposal.

Opus statically read the preserved owner/storage modules, not current main or the installed host, and ran no tests. Native read-only agents independently audited current-main anchors and documentation inventories; that supplementary audit is not a substitute for Claude review or historical termination proof. Fresh closing review: Claude **Sonnet/high**, observed `claude-sonnet-5`, returned complete **`RECOVERY_PLAN_VERDICT: APPROVE`** on the corrected documentation. Result `rcpt_mtrz7a1q_1e0ec686`; transport `rcpt_mtrz9qcg_6d953f11`; route-preview `rcpt_mtrz6o4b_b5ebe9ee`; request/invocation `mcp:ac99b61f-11cc-44d6-87a2-778c1d6b4d79`; attempt `mcp:ac99b61f-11cc-44d6-87a2-778c1d6b4d79:attempt:1`. Exit 0, completed/end_turn, one physical model invocation, nonpartial and untruncated output. The exact result receipt was independently dereferenced. Full cleaned verdict SHA-256: `5ad4d3a5dc060018e242178dcdb4570cf83e34cf983f549e47deb273c529ef04`.

Sonnet directly inspected the existing owner/storage APIs, confirmed the new interfaces remain unimplemented, and found the Opus design corrections present. Its approval is for the **conditional design/documentation only**. It supplies no historical process proof, file-ownership transfer, implemented recovery, integration, merge, deployment, controller or goal acceptance. It used only read-only file tools and did not execute tests, Git ancestry/digest checks, current-main inspection, receipt verification, or installed-host probes. Root/native verification supplies those separately bounded claims.

Sonnet flagged the different old/new proposal hashes as a nonblocking provenance question because its tools could not compute hashes. Root subsequently reproduced both directly from immutable Git blobs, resolving that question without changing the proposal:

| Reviewed version | Containing commit | Exact proposal SHA-256 |
| --- | --- | --- |
| Original proposal reviewed by Opus (`REVISE`) | `e322383abaa6cd1a868e989567fb2c928bb247d8` | `5876b52e06f8cbaca336cd289d1d8723bcc69f29dbca58a3d89c95f47c22516f` |
| Corrected proposal reviewed by Sonnet (`APPROVE`) | `30f8539f8a3aca4c5c9e0a1162cdf55be07e61fc` | `2b738bc79c34f0fdb65fff7d5cda2ca3f9de258baf4bfbe0387742df11892332` |

The closing evidence commit changes this handoff's receipt/provenance summary only; the Sonnet-reviewed proposal remains byte-identical. The final source worktree status checks again confirmed original heads and clean tracked/ordinary-untracked state. **All six legacy reservations remain blocked and untouched.** The initial route-preview receipt is `rcpt_mtryta46_f3974828`, requesting Claude Opus/high in forced safe read-only mode. A first non-invoked request was rejected because an inferred-effort execution contract conflicted with explicit request controls: result `rcpt_mtrywup6_43ac2cc9`, transport `rcpt_mtrywupq_c66931f4`, `execution_control_conflict`, zero physical attempts/model invocation. This is a validation **NO VERDICT**, not a provider quota or model review failure. The corrected direct call keeps explicit Opus/high and does not bypass provider safeguards or replay a queue task.

## Remaining acceptance gaps and coordinator decisions

| Area | Existing evidence | Unmet acceptance / ownership boundary |
| --- | --- | --- |
| Owner foundation | New-run Linux PID1/control/identity helpers and focused tests; retained quarantine on unknown proof. | Not instantiated by production server dispatch; no installed-host qualification, Windows native owner, legacy identity binding, complete census or safe cutover. |
| Storage | Strict Linux file/directory durability primitive, 40 focused cases, explicit uncertainty. | Unwired; no retained controller flock, typed durable attempt journal, transactional authority, restored holds or durable deduplicated effect outbox. |
| Expired writer | P1A protects locks and reports blocked implementation actions. Main independently protects expiry too. | Error/interface reconciliation and whole integration review required. Expiry-only takeover remains forbidden. |
| Restart-safe controller | PR121 durable waits/dependencies/deadlines and uncertainty reservations exist; main now calls queue/controller shutdown. | Need durable owner/attempt associations, typed physical/semantic/cleanup/workspace/effect facts, crash-safe holds restored before listening, confirmed persistence before spawn/proceed, bounded stream drain and effect deduplication. A response marked settled is insufficient physical proof. |
| Request/requirement ledger | PR121 ledger is now runtime-wired at `server.js:5587-5595`, REST `:5657-5675`, and MCP; evidence is revision-bound/idempotent assertions. | `assertionsOnly:true` is not validated completion. Atomic rename alone is not strict fsync. Persistent goal acceptance below is unmet; do not duplicate this ledger. |
| Legacy issue122 | Six uncertain reservations reported; main has a proof callback interface but no trusted runtime wiring. | No established contemporaneous host/domain binding; all six remain blocked. Exact ownership, proof, lock/audit and queue-projection interfaces must be agreed before implementation. |

Accepted P1 corrections still constrain future implementation: journal state is a product of independent facts, not a linear status rank; typed expected-revision/id/payload-hash transitions replace generic patches; intent must be durably confirmed before spawn and launch pin/release-may-happen before proceed; unknown dispatch cannot be relabeled never-invoked. Root exit plus both stream EOFs and bounded drain seal semantics independently of late physical proof. `physicalDone` and ownership/effect holds remain pending until their own verified durable settlement. An outbox receipt ID alone is not exactly-once effect consumption. Controller death releases its OS lock, not outstanding execution/writer reservations.

The preserved roadmap's later acceptance criteria remain **unmet**:

- **P2 persistent controller/goal episode:** two requirements survive foreground disconnect and daemon restart, a result is consumed once, waiting spends zero model tokens, and completion requires current evidence for all requirements.
- **P3 additive intent:** original and added requirements persist; new feedback/revisions invalidate affected evidence; compaction preserves intent and reports budgets truthfully.
- **P4 presentation/roles** and **P5 operational qualification:** not this lane; no completion claim. Real managed episodes, fault injection, platform qualification and canary acceptance remain coordinator work.

The private roadmap predated current main. Its statements that request-ledger wiring, shutdown wiring and queue Claude approval were absent are superseded by main source and the coordinator's current report. Historical receipts are preserved without carrying those obsolete conclusions forward.

## Coordinator handback

Keep this PR draft and resolve integration against current main with both histories visible. Do not merge it as-is or retarget PR118 silently. Review [the issue122 proposal and exact ownership request](LEGACY-QUEUE-RECOVERY-PLAN-122.md) before authorizing any implementation. No new queue, incident logger, request ledger, controller, persistent-goal implementation, UI, model-routing, fuel-gauge, self-repair, release, or reserved five-file no-HEAD review-packet lane is taken by this handoff.

## Preserved 133-path ancestry inventory

Generated from `git diff --name-only 7c0ccd41360b1c2157e3f4d74336afeb7fd7b655...fc9a415445b2e3e369e243a053aab39daa51d382`. These paths precede this documentation-only publication and are not its requested future ownership.

```
.github/dependabot.yml
.github/workflows/claim-on-start.yml
.github/workflows/version-on-merge.yml
README.md
bin/relaybridge.js
cli-config.json
config/github-repos.example.json
config/github-repos.json
config/provider-evidence.json
docs/BLUEPRINT.md
docs/FUEL-GAUGE.md
docs/GITHUB-INTEGRATION.md
docs/LINUX-DURABLE-FILE.md
install.ps1
lib/attempt-lifecycle.js
lib/bounded-command.js
lib/bounded-json-read.js
lib/build-identity.cjs
lib/cli-deadline.js
lib/effort-controls.js
lib/execution-contract.js
lib/github-onboard.js
lib/github-tracker.js
lib/http-provider-stream.js
lib/http-provider-terminal.js
lib/linux-durable-file.js
lib/linux-owner-identity.js
lib/linux-physical-owner.js
lib/onboard-safety.js
lib/operation-admission.js
lib/owner-control.js
lib/partial-checkpoint.js
lib/path-citations.js
lib/platform.js
lib/prompt-transport.js
lib/provider-accounts.js
lib/provider-budget.js
lib/provider-cooldown.js
lib/provider-failure.js
lib/quota-seat.js
lib/remote-mcp.js
lib/routing-eligibility.js
lib/run-supervisor.js
lib/task-plan.js
lib/task-queue.js
lib/validation-contract.js
lib/win-shim-launch.js
lib/workflow-controller.js
lib/workflow-pipeline.js
lib/workspace-grounding.js
lib/writer-diff-summary.js
mcp/router.mjs
mcp/server.mjs
package-lock.json
package.json
server.js
skills/relaybridge/SKILL.md
start.sh
templates/github-automations/claim-on-start.yml
templates/github-automations/version-on-merge.yml
test/accepted-provider-usage.test.js
test/attempt-lifecycle.test.js
test/auth-gate.test.js
test/authority-keys.test.js
test/bounded-command.test.js
test/bounded-json-read.test.js
test/bridge.test.js
test/browser-launch.test.js
test/build-identity.test.js
test/claude-stream-cli.js
test/cli-deadline.integration.test.js
test/cli-deadline.test.js
test/cli-prompt-input.test.js
test/codex-progress.test.js
test/effort-controls.test.js
test/execution-contract.test.js
test/execution-handoff.integration.test.js
test/expired-writer-admission.test.js
test/finalization-input.test.js
test/fixtures/windows-shims/cursor-agent.cmd
test/fixtures/windows-shims/cursor-agent.ps1
test/fixtures/windows-shims/npm-package.cmd
test/fixtures/windows-shims/npm.cmd
test/fixtures/windows-shims/npx.cmd
test/github-onboard-integration.test.js
test/github-tracker.test.js
test/grounding-contract.integration.test.js
test/helpers/temporary-bridge.js
test/http-lifecycle.integration.test.js
test/http-provider-handler.test.js
test/http-provider-stream.test.js
test/http-provider-terminal.test.js
test/issue99-cache-budget.test.js
test/linux-durable-file.test.js
test/linux-physical-owner.test.js
test/mcp-checkpoint-sanitize.test.js
test/mcp-cwd-cache-policy.test.js
test/mcp-smoke.test.js
test/mcp.integration.test.js
test/onboard-safety.test.js
test/operation-admission-rest.test.js
test/operation-admission.test.js
test/output-truth.integration.test.js
test/owner-control.test.js
test/partial-checkpoint.test.js
test/pid1-gate.test.js
test/planning-admission-rest.test.js
test/platform.test.js
test/prompt-file-cli.js
test/prompt-preflight-mcp.test.js
test/prompt-preflight-rest.test.js
test/prompt-transport.test.js
test/provider-failure.test.js
test/quota-budget-truth.test.js
test/remote-mcp.test.js
test/rest-rejection-receipts.test.js
test/router.test.js
test/server-startup-identity.test.js
test/supervisor.test.js
test/task-plan.test.js
test/windows-launch-rest.test.js
test/windows-provider-path.test.js
test/windows-shim-injection.test.js
test/workflow-controller.test.js
test/workflow-pipeline.test.js
test/workspace-grounding.test.js
test/writer-diff-summary.test.js
tools/mcp-smoke.mjs
tools/migrate-github-registry.cjs
tools/pid1-gate.js
tools/pplx.js
tools/test-install-mcp.ps1
tools/test-install.ps1
```
