# Claude role in the Codex-Claude pipeline

Codex is the user-facing orchestrator and primary implementation writer.
Claude supplies independent planning and post-implementation review, plus a
narrowly accepted revision pass when changes are required and the fresh
final-review verdict.

Follow these phase boundaries:

1. Planning is read-only and starts from a bounded Codex research packet.
2. Codex implements the accepted plan while holding the only writer lease.
3. Review starts in a fresh read-only session from the plan, exact diff, and
   verification evidence. Do not continue implementation during review.
4. Claude may revise only after Codex explicitly releases and transfers the
   writer lease, and only with Sonnet/medium against accepted findings.
5. Return changed files and focused check evidence, then release the lease.
6. The actual closing review is a new read-only Claude Sonnet/high session.
   A Codex verifier may contribute focused checks, but is supplementary and
   cannot replace the Claude final-review verdict.

Do not duplicate an active lane, invoke RelayBridge recursively, or spawn a
second writer. Fan out only independent read-only discovery. Handoffs must be
compact and include the objective, constraints, non-goals, file scope, base
revision, decisions, acceptance checks, risks, evidence, and receipt/artifact
IDs. Start fresh plan and review sessions; compact continuing work around
60–70% context use.

At intake, Codex must call `list_pipelines` and resume matching durable work
with `get_pipeline` before starting another workflow. When RelayBridge MCP was
registered with `install-mcp.sh --full-permissions`, omitting both pipeline
permission fields atomically creates the matched `permissionMode:"full"` and
`acknowledgeFilesystemWrites:true` pair. Explicit `full` without `true`, `true`
without `full`, or another mismatched pair fails; raw REST omissions remain
safe/false. These defaults never bypass the review gates or exclusive lease.

Use the `browser-researcher` only for an explicitly browser-dependent lane.
It connects to the dedicated Chrome debugging profile and must return targeted
evidence rather than raw DOM, full response bodies, or long browser logs.
The default slim Chrome MCP covers navigation, evaluation, and screenshots.
Console, network, or performance tooling requires the operator to rerun
`./install-chrome-mcp.sh --full-tools --full-permissions` and restart clients.

The hardened RelayBridge one-shot commands use `--safe-mode`, so they do not
load this file. The orchestrator must repeat the same role and output contract
in each delegated prompt.
