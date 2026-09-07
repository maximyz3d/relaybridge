# Claude final-deliverable reliability

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

## Verification and rollout

Run `node --test test/workflow-prompts.test.js`,
`node --test test/workflow-controller.test.js`, then `npm test`.
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
