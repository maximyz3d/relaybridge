# Claude final-deliverable reliability

## Operator hotfix verification (2026-09-07)

Source changes are published in PR120; publishing does not deploy a running
bridge. The approved Claude/Fable headless arrays from164859a were separately
applied to the effective operator configuration. The existing server reads that
configuration per request, allowing this scoped mitigation without a restart.
Every other parsed configuration field was preserved. The prompt-module change
and the whole candidate branch have **not** been installed by this operation.

A real safe bridge-mediated Sonnet/medium call returned a complete
`VERIFICATION: PASS`: outer receipt `rcpt_mtruwlq1_98dcc207`, transport receipt
`rcpt_mtruwtmd_2eae4764`, five turns, exit0, no permission denials, provider errors
or retries. This verifies that model/profile combination, not all accounts,
Fable generation, the whole PR, or every pipeline phase. A successful call also
cleared the existing seat cooldown through ordinary success handling; no quota
records were manually reset. A separate supervisor-token-budget versus rate-limit
accounting contradiction remains diagnosed but unrepaired.

### Repair client identity before retrying provider work

An existing MCP process pins its expected build when it starts. Reconnect it
after upgrades. If a fresh process still fails, check the checkout selected by
the launcher against the actual running server: a fresh client from a different
or stale-manifest checkout cannot fix itself simply by reconnecting again.
Align MCP, CLI and autostart launchers to the same verified frozen release;
do not copy a build ID, bypass identity checks, or repeatedly restart a healthy
shared listener. Move client and server together at the next reviewed deployment.

Validate an identity-gated, non-provider action such as `route_preview`, not only
the ungated health/status endpoint. The local launcher correction passed this
check without changing the running server PID/build. Old adapters still require
one reconnect; other clients can use a fresh matching adapter in the meantime.
Preserve failed workflows as no verdict and resume only their authorized next
action; connection repair is not permission to replay an interrupted writer.

## Failure and bounded mitigation

A successful Claude CLI exit is not an accepted plan or review. In an observed
planning failure, the terminal result contained only a short closing note
referring to a plan "above", without the required marker. Earlier substantive
output is a hypothesis, not a recovered or accepted plan. A separate planning
call explicitly reported BLOCKED because required evidence was outside its
readable workspace. Neither case established subscription exhaustion.

RelayBridge's Claude transport uses the terminal result's `result` field. This
repair preserves that boundary and the existing status parsers. It does not
concatenate intermediate assistant text, recover earlier approval markers,
change permissions, retry failed workflows, or replay interrupted writers.

`lib/workflow-prompts.js` now reserves final-delivery instructions in the output
contract, outside clipped handoff artifacts. Planning, review, final review and
revision require the complete artifact plus the phase's existing marker in one
self-contained final response, not a separate postscript. Read-only phases also
explicitly avoid plan files, Write/Edit/Bash and ExitPlanMode. The leased
revision writer retains its existing tools and authority limits.

## Evidence handoff and failure classes

The coordinator must embed bounded, sanitized required evidence in the phase
handoff or stage it within the approved readable workspace before dispatch.
Include exact paths/revisions and distinguish coordinator-reported checks from
checks the reviewer independently performed. Do not paste credentials or full
chat transcripts, or broaden read permissions to satisfy a missing input.

- Missing terminal artifact/marker: UNKNOWN, no verdict; narrow the handoff.
- Essential inaccessible evidence: explicit BLOCKED/BLOCK with the missing
  input and smallest required handoff. Optional unrun verification is reported
  as a gap, not an automatic blocker or invented success.
- Local token-budget overflow: identify the local budget, not an assumed
  provider context window.
- Vendor quota/context limits or transport interruption: preserve observed
  failure/provenance; do not relabel these as an approval or blindly retry.

Incident storage, queue scheduling and controller changes remain with the
external R13–R16 lane; this patch does not implement those features.

## Confirmed headless Plan Mode conflict

A subsequent fresh review explicitly refused a verdict because built-in Plan
Mode required a plan file and ExitPlanMode, while the same invocation exposed
only Read/Glob/Grep. Prompt instructions cannot override that CLI scaffold.
The prompt-only mitigation was therefore insufficient and its failed review
was preserved as no verdict.

The companion configuration change replaces `plan` with `dontAsk` only in
`claude.oneshot_safe` and `claude_fable.oneshot_safe`, explicitly pre-approving
Read/Glob/Grep. The available-tool list remains exactly those three tools;
restricted workspace access, safe mode, strict empty MCP, subscription auth
environment stripping and no session persistence remain unchanged. Interactive
and writer profiles are untouched; Fable still has no writer profile.

The installed CLI's help lists `dontAsk`; the official
[permission-mode documentation](https://code.claude.com/docs/en/permission-modes)
describes it as denying tool requests that would otherwise require approval.
This is not bypassPermissions and not an OS sandbox. One isolated Sonnet call
with these flags returned a complete assessment, successful exit and no tool
permission denials. This does not verify every model/account or Fable runtime.

## Verification and rollout

Run `node --test test/workflow-prompts.test.js`,
`node --test test/workflow-controller.test.js`, then `npm test`.
Also run `node --test test/claude-headless-config.test.js test/bridge.test.js`
for the companion configuration change.
Fixtures verify contract retention under oversized artifacts, role separation,
postscript-only UNKNOWN and unchanged explicit blocking semantics. They do not
prove a model always obeys the prompt or validate a complete review's substance.

This is a prompt mitigation, not a guarantee of zero future no-verdict results.
Require a complete fresh Claude response and independent patch review. The
coordinator's manual plan acceptance keeps observations separate from inferred
causes. Keep all actual verification limitations visible.

Source changes are candidate-only until the reviewed build is installed at an
idle/handoff boundary. An already-running bridge continues using its loaded
prompt module; changing a worktree does not update it. No runtime restart,
main merge or deployment is part of this patch. Rollback is a new revert of
the scoped patch, with no data migration.

Operator overrides may retain old command arrays after an upgrade. Inspect
the effective Claude/Fable headless profiles during the separate installation
handoff; do not claim changing the packaged default migrated a live override.

## Frozen candidate evidence — 2026-09-07

- Prompt patch: `eedb3d2`; companion headless configuration: `164859a`.
- Planning workflow `wf_mtrr483h_f92550b20163` produced a complete plan via
  `t_mtrr4tb6_6yg8pk` / `rcpt_mtrr6i7n_d9be39f7` (Sonnet/medium).
- Its old-configuration review `t_mtrraf8p_0uvlsd` /
  `rcpt_mtrrbtg9_d21730d2` explicitly identified the Plan Mode conflict and
  omitted a verdict. That workflow remains failed, not retroactively approved.
- Root's follow-up used a documented one-writer loop. An isolated Claude call
  assessed the companion plan; root resolved its missing CLI-semantics and
  implementation evidence before the fresh closing review.
- Fresh non-persistent Sonnet/high review of `164859a`, using the candidate's
  generated final-review prompt and headless configuration, returned
  `REVIEW_VERDICT: APPROVE`, successful exit, no permission denials, and no
  blocking findings. This was direct local CLI verification because the live
  bridge retained the faulty scaffold; it has no fabricated RelayBridge receipt.
- Root verified 12 focused configuration/prompt tests and the updated full
  suite: 625 passed, 2 skipped, zero failed. The earlier prompt/controller
  compatibility run passed 20 tests. `git diff --check` passed, and parsed
  configuration comparison proved all fields outside the two headless arrays
  unchanged from `eedb3d2`. Source remained frozen during closing review.

Reviewer limitations: current-file inspection, not independent git-diff or test
execution; runtime evidence initially supplied by root. The review call itself
adds another successful Sonnet run but does not establish Fable/all-account
coverage. Local sanitized review evidence is retained by the coordinator; no
raw provider transport or private configuration is published here. This is
candidate approval, not main-merge, release or installation approval.
