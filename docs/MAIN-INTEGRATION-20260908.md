# Main integration evidence — September 8, 2026

This is the tested integration candidate for the user's subsequent authorization to prepare final main and merge as `maximyz3d` if good. It supersedes the **publication-only status** of the historical [owner/storage handoff](OWNER-STORAGE-HANDOFF-20260907.md), without changing that document's original evidence. It does not deploy or install RelayBridge, replay legacy tasks, or complete the controller/goal/recovery acceptance criteria.

## Preserved ancestry and scope

- Main parent: `5f55ad641ebc1d71fdf4ac2561cb487eed31810a` (v2.1.6; PR120 and PR121 already merged).
- Preserved handoff parent: `9311c9dc6f7bb296b431e22124ef224a29813a5a`, [PR123](https://github.com/maximyz3d/relaybridge/pull/123).
- Preserved source: `fc9a415445b2e3e369e243a053aab39daa51d382`; PR118 ancestor: `776692a64eba9b9c9c216ba67f94e2cb3d96d099`.
- Actual common ancestor: `7c0ccd41360b1c2157e3f4d74336afeb7fd7b655`.
- Branch: `external/main-integration-20260908`, with a real two-parent merge. No reset, amendment, reordering, force-push, or cherry-pick hides the original conflicts. PR118 and PR123 branches remain preserved.

The seven textual conflicts were `server.js`, `mcp/server.mjs`, `lib/workflow-pipeline.js`, `test/workflow-pipeline.test.js`, `test/bridge.test.js`, `package.json`, and `package-lock.json`. The wider main diff retains the existing PR118 source history; its inventory and prior bounded review receipts are in the handoff. This integration is broader than a new owner-only implementation.

The merge keeps main's single queue, durable dependencies/deferred admission, uncertain reservations, incident and assertion-only request ledger, quota handling and delegation. It keeps the preserved explicit model/effort contracts, grounding/complete-prompt checks, physical-owner foundation, fail-closed expired writer protection and unwired strict Linux durable-file primitive. Main's package and lock pins are retained byte-for-byte. `VERSION` remains authoritative v2.1.6; package metadata still says 2.0.1, as on the main parent.

Semantic integration additionally touches `lib/delegation.js`, `lib/task-plan.js`, and the existing delegation, grounding, output-truth and expired-writer tests. Delegation stores exact invocation intent in its existing record. The mandatory production preparation hook validates every complete rendered task before any batch submission. Implicit requested effort stays implicit across initial dispatch and budget/model-tier-only escalation; explicitly approved effort changes receive a freshly validated tuple before approval is persisted. Provider intent in `task.body.execution` remains distinct from queue lifetime in `task.execution`.

## Verification and independent review

The canonical earlier workflow `wf_mtnpzm3o_37de07ab5b0e` remains untouched; no duplicate managed workflow or writer was started. Root is the sole source writer in this isolated checkout. Native and hosted reviewers are read-only. The shared bridge was neither restarted nor replaced. Its older build is not evidence about the coordinator's installed host.

- Fresh main baseline: 683 tests, 681 passed, 2 skipped, zero failed; production dependency audit zero vulnerabilities.
- Initial integration focus: 205/205 passed.
- Corrected integration checks: 43/43 passed, including real disposable REST/MCP/HTTP fixtures. These establish that model/evidence intent survives delegation and deferred dependency execution, no future task starts early, malformed or oversized rendered batches do not partly dispatch, implicit effort remains implicit, and changed model controls are validated before approval.
- An initial full integration run had 993 tests: 988 passed, 4 skipped, one failed. Its VM harness lacked the newly shared `receiptFailureKind` import; the harness was corrected. The corrected full Linux rerun passed: **994 tests, 990 passed, 4 skipped, zero failures**, 117648.669968 ms, Node 22.23.2 / npm 10.9.8. Production dependency audit: **zero vulnerabilities**. CI remains a separate gate.
- Native read-only audits confirmed the workflow union adds no background sweep, expired-settled release shortcut, or uncertainty-clearing API. They found two integration defects (missing original prompt in candidate grounding, and implicit effort promoted during model-tier escalation); both were corrected with regressions.

Accepted Claude integration plan: Sonnet/high, complete `PLAN_STATUS: READY`; result `rcpt_mts2vndd_a664f08c`, transport `rcpt_mts2xytj_3705efee`, request/invocation `mcp:b44c82ea-72f5-461b-a9db-4a8b7d107210`, attempt `mcp:b44c82ea-72f5-461b-a9db-4a8b7d107210:attempt:1`; observed `claude-sonnet-5`.

Supplementary RelayBridge Codex review: requested `gpt-5.6-sol`/high (observed revision unavailable), complete exit 0; result `rcpt_mts3j99k_ff1840b6`, transport `rcpt_mts3ls8m_f4804212`, request/invocation `mcp:edbed048-0871-4a49-8a1e-e5f58ebddda0`, attempt suffix `:attempt:1`. It returned **REVISE** for tuple-less legacy consumers without the optional preparation hook, and explicitly did not inspect the production hook. Root and the independent native reviewer found no production bypass: the server always supplies the validator and invokes it before durable approval for every escalation. Optional standalone consumers without that hook are not qualified end-to-end execution. This receipt is not an approval.

Fresh Sonnet/high closing review: **VERDICT: APPROVE**, conditional on exact-head Linux/Windows/CodeQL passing. Task `t_mts3sijg_eoge66`; submission receipt `rcpt_mts3siji_d5a12d19`; completed bridge/provider receipt `rcpt_mts3xqhh_42090d99`; request/invocation `oneshot:6060794a-cd16-4122-80ef-4bad60f3f593`; attempt `oneshot:6060794a-cd16-4122-80ef-4bad60f3f593:attempt:1`. Completed 2026-09-08T03:26:03.605Z; observed `claude-sonnet-5`; exit 0, result subtype success, provider terminal completed, no partial result, no truncation or failure classification. Receipt output SHA-256: `c9429c5807249c526a4baad60ffdf59a5eda718a75c29a929b5eb5f434097048`.

Reviewed code commit: `b4ffbfd26008dea918e5b06e29b17f0a3c9b389a`. The subsequent receipt commit changes only this document. Claude independently confirmed the mandatory production preparation hook resolves the Codex concern, and found no material integration defects in all six requested areas: delegation validation, exact model/requested effort, batch prevalidation, main request/deferred fields, quota/budget precedence, expired writer fail-closed behavior. It inspected the full 1429-line bounded merge packet and relevant source. It did not re-review all inherited PR118 paths, did not read every handoff/request/incident/fuel module in full, and did not execute tests or CI. Its verdict does not retroactively change the earlier Codex REVISE receipt or establish controller/recovery/goal acceptance.

Delivery: [PR124](https://github.com/maximyz3d/relaybridge/pull/124); final immutable head and exact-head CI/check URLs are recorded in the PR. The original handoff [PR123](https://github.com/maximyz3d/relaybridge/pull/123) remains accessible.

Earlier failed provider calls remain **NO VERDICT**: Codex model-unavailable `rcpt_mts1zgzk_ace9cc99`; tool-constrained inspection `rcpt_mts20u00_d8d3d7d9`; long transport failure `rcpt_mts27680_6382a2e4` / `rcpt_mts2dm4n_acc0fba5` (`mcp:8432038d-f0fd-4e01-8030-e28d44b1d3eb`, client cancelled, zero output); long Claude planning failure `rcpt_mts2fjkh_73d718bf`. Missing/partial output is never approval. No raw transcripts, runtime state, credentials or machine logs are committed.

## Remaining refinements and acceptance gaps

1. [Issue122](https://github.com/maximyz3d/relaybridge/issues/122): the [bounded legacy recovery proposal](LEGACY-QUEUE-RECOVERY-PLAN-122.md) remains a design, conditional on independent historical fencing proof, a qualified controller lock, assigned append-only audit integration and coordinator-owned reservation projection. The exact six records stay untouched and held. Age, missing PID, absent activity, missing metadata, task settlement labels and review verdicts cannot establish termination.
2. Owner/storage primitives are not a restart-safe controller. No durable writer outbox, qualified controller lock, complete owner-backed recovery or unattended acceptance is claimed. Existing workflow settlement-label trust remains a separate acceptance gap; this merge grants no new recovery authority.
3. Persistent request evidence remains attributed assertions, not automatically verified goal acceptance. No new goal store or completion claim is added.
4. Router classification can mistake code-review wording containing “current/source/evidence” for research, and negated deployment wording for a destructive request. Lowering a delegated task tier can also remain conservatively blocked by earlier eligibility. Refinement needs targeted positive/negative cases while preserving real capability and human gates.
5. Long direct MCP provider calls failed near 300 seconds despite a larger requested timeout. The exact cause is not yet proven; queued read-only work with a durable result ID avoids holding a single client response open. Do not retry uncertain writers or infer a verdict from transport completion.
6. The separate five-file no-HEAD review-packet lane remains unmodified. There is no installed smoke claim for this candidate: installation and shared restart are outside this operation.

Merge is conditional on the final Linux suite, Windows checks, CodeQL and a complete fresh Claude closing verdict. Deployment remains separate.
