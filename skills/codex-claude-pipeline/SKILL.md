---
name: "codex-claude-pipeline"
description: "Coordinate Codex-led implementation with Claude planning, review, and bounded revision when a task benefits from explicit cross-agent phase gates."
---

# Codex-Claude Pipeline

Use Codex as the orchestrator and primary writer. Use Claude for an independent
plan, a fresh post-implementation review, and one bounded revision per accepted
review cycle when changes are required.

## Invariants

- Keep one canonical run packet with the objective, constraints, non-goals,
  scoped files, base revision, decisions, acceptance checks, and artifact IDs.
- Give every delegated lane one bounded question and one output contract. Return
  summaries and evidence, never whole transcripts or large file bodies.
- Check active runs before dispatch. Do not repeat work already in progress or
  rerun a completed phase merely to recover context; read its receipt/artifact.
- Let the bridge handle its bounded durable backoff for typed transient
  planning/review failures. Read state with `get_pipeline`, then invoke
  `reconcile_pipeline` only when named in `nextActions`; do not create a replacement.
  Use `retry_failed_pipeline_provider` only for an older terminal run whose
  durable task record proves a transient read-only failure. Never replay a
  failed writer automatically. For a bridge-interrupted read-only task, first
  confirm the former provider process is no longer alive; polling alone must
  not launch its replacement.
- Fan out only independent read-only discovery. Never fan out writers.
- Use the `browser_researcher` or `open_in_chrome` only when live UI,
  console, network, screenshot, or browser-only evidence is required. Keep
  Chrome evidence bounded; do not transfer raw DOM or full network bodies.
  The default slim Chrome MCP supplies navigation, evaluation, and screenshots.
  Console, network, or performance work requires the operator to rerun
  `./install-chrome-mcp.sh --full-tools --full-permissions` and restart clients.
- Maintain one writer lease containing owner, file scope, and base revision.
  Codex normally owns it. Release it before the Claude reviser can acquire it.
- Start planning and review in fresh, non-persistent Claude sessions. Do not let
  implementation conversation or earlier conclusions anchor the reviewer.
- Compact a continuing coordination thread near 60–70% context use. Preserve
  only decisions, file scope, artifact IDs, risks, and verification state. Start
  a fresh phase session instead of compacting a completed phase into the next.

## Phase gates

1. **Intake:** Codex states the bounded objective and acceptance checks, calls
   `list_pipelines`, and resumes a matching active run with `get_pipeline`.
   Only when none exists, call `start_codex_claude_pipeline` once and keep its
   pipeline ID. An `install-mcp.sh --full-permissions` registration atomically
   defaults a fully omitted permission pair to `permissionMode:"full"` and
   `acknowledgeFilesystemWrites:true`; use explicit `safe`/`false` when this run
   must remain safe.
2. **Research:** Codex uses read-only scouts only when lanes are independent,
   then records one evidence-backed brief with `submit_pipeline_research`.
3. **Plan:** Dispatch Claude `pipeline-planner` with the brief. Use Sonnet/medium
   for standard plans, Opus/high for complex plans, and the explicit Fable heavy
   tier only for the hardest planning work.
   Use `reconcile_pipeline` by ID while a provider phase is active; use
   status-only `get_pipeline` when no advance is intended. Do not submit a duplicate.
   Gate on a complete plan packet; a promise to continue is not completion.
4. **Implement:** Codex calls `claim_pipeline_implementation`, acquires the
   writer lease, and implements the accepted plan. Renew a long-running lease
   with `renew_pipeline_writer_lease`, then report the exact diff and checks via
   `complete_pipeline_implementation`. No other writer may run.
5. **Review:** Release the lease, capture the exact diff and checks, then start a
   fresh Sonnet `pipeline-reviewer` session. Gate on actionable findings or an
   explicit no-material-findings result.
6. **Revise:** When review requests changes, call `start_pipeline_revision`,
   grant the lease only to `pipeline-reviser`, route through the `claude`
   Sonnet/medium writer slot, and accept only the approved file scope. Repeat
   only if a fresh final review identifies another concrete required change.
7. **Final review:** Call `start_pipeline_final_review` for the actual closing
   gate: a fresh read-only Claude Sonnet/high review. A Codex verifier may run
   focused supplementary checks and compare the final diff to the plan, but it
   does not replace Claude's verdict. Close only when acceptance checks and
   material findings are resolved. Use `cancel_pipeline` for an intentional
   stop; do not simulate completion.

## Permissions and routing

Planning, research, and review are read-only. RelayBridge's safe Claude/Fable
one-shots use restricted mode, explicit read tools, empty MCP config, no session
persistence, and a 150k auto-compact window. Fable has no writer slot.

`auto` is not full permission. When RelayBridge MCP was registered with
`install-mcp.sh --full-permissions`, omitting both workflow permission fields
causes the MCP handler to inject the matched full/true pair atomically. If a
caller supplies either field, no missing dangerous half is inferred: explicit
`full` without `true`, `true` without `full`, and mismatched pairs fail closed.
Raw REST omission remains safe/false. Any writer still needs the resolved
full/true workflow, a scoped exclusive lease, and an isolated trusted
environment. Never escalate a safe failure into a dangerous retry
automatically.

If RelayBridge MCP is available, begin with `get_context_bundle`, use
`route_preview` before a hosted call, retain the returned request/invocation/
receipt tuple, and inspect the exact receipt instead of selecting the newest one.
Use `get_pipeline` as the sole side-effect-free status read for an active
pipeline. Use identity-gated `reconcile_pipeline` only when `nextActions` names
it; that operation may settle or dispatch provider work. A slow phase is not
permission to start another copy.
