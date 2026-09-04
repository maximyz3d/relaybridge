# RelayBridge Agent Guide

This repository contains RelayBridge, a local Windows PowerShell and AI CLI control plane with browser, REST, and MCP interfaces.

## First Call

When connected through MCP, call `get_context_bundle` first. It returns the bounded handoff packet: health, provider readiness, active work, terminal tails, collaborations, projects, runs, receipts, registry fingerprints, and exact follow-up tools for omitted detail.

## Codex-Claude Pipeline

Codex is the orchestrator and primary implementation writer. Use the
`$codex-claude-pipeline` skill for cross-agent work:

1. Codex records a bounded research brief.
2. A fresh read-only Claude planner returns the implementation plan.
3. Codex alone implements the accepted plan.
4. A fresh read-only Claude reviewer reports prioritized findings.
5. When review requests changes, the Claude Sonnet reviser may write only after
   Codex releases and explicitly transfers the single writer lease.
6. A fresh Claude Sonnet/high final review is the closing review gate. A
   read-only Codex verifier may supply focused supplementary evidence.

Never run overlapping writers or duplicate an active task. Parallelize only
independent read-only discovery, and return compact summaries instead of raw
transcripts. Keep each handoff bound to the run/request/receipt identifiers,
file scope, base revision, decisions, risks, and acceptance evidence. Start a
fresh session at plan and review boundaries; compact a continuing coordination
thread around 60–70% context use.

For an MCP-managed run, call `list_pipelines` before
`start_codex_claude_pipeline`. If a matching canonical workspace/objective is
already active, resume it with `get_pipeline`, load its bounded artifacts, and
obey `nextActions`; durable state, not chat history, is authoritative. Create
one new run only when no matching active run exists, submit the brief with
`submit_pipeline_research`, read status with `get_pipeline`, and invoke
`reconcile_pipeline` only when `nextActions` names it. Acquire and renew the
writer lease through `claim_pipeline_implementation` and
`renew_pipeline_writer_lease`; finish that phase with
`complete_pipeline_implementation`. Use `start_pipeline_revision` only for
accepted findings, `start_pipeline_final_review` for the fresh closing review,
and `cancel_pipeline` for an intentional stop. Never create a replacement run
because polling is slow or a client session restarted.

With an MCP registration installed by `install-mcp.sh --full-permissions`, a
`start_codex_claude_pipeline` call that omits both permission fields atomically
defaults to `permissionMode:"full"` plus
`acknowledgeFilesystemWrites:true`. This is a per-workflow creation default,
not a phase bypass. Supplying either dangerous half explicitly disables the
shortcut: `full` without `true`, `true` without `full`, and mismatched explicit
pairs fail closed. Send `safe`/`false` to force a safe workflow. Raw REST
omission remains `safe`/`false`. The resolved full+ack pair still does not
bypass the accepted-review gate or the exclusive writer lease.

The MCP workflow operations map directly to authenticated REST routes:
`list_pipelines`/`GET /api/workflows`, status-only `get_pipeline`/`GET
/api/workflows/:runId`, `reconcile_pipeline`/`POST
/api/workflows/:runId/reconcile`, create/`POST /api/workflows`, research/`POST
/api/workflows/:runId/research`, implementation claim and complete/`POST
/api/workflows/:runId/implementation/{claim,complete}`, revision/`POST
/api/workflows/:runId/revision/start`, final review/`POST
/api/workflows/:runId/final-review/start`, lease renewal/`POST
/api/workflows/:runId/lease/renew`, and cancellation/`POST
/api/workflows/:runId/cancel`. `get_pipeline` never settles or dispatches work;
the identity-gated reconciliation action advances a finished task exactly once
and may dispatch a due read-only retry.

Provider one-shots must not invoke RelayBridge again or spawn overlapping work.
They receive their phase role in the prompt because hardened Claude safe mode
and Codex `--ignore-user-config` intentionally skip inherited customizations.

## WSL and Browser Automation

The recommended WSL bootstrap from a checkout beneath the Linux home directory
is:

```bash
./install-skill.sh --register-mcp --register-chrome --full-permissions
./start-chrome-debug.sh
```

The skill, roles, RelayBridge MCP, and Chrome MCP are registered for the current
user and point back to the exact checkout. Restart Codex and Claude after
registration. On WSL, keep the checkout, runtime data/token/config, Node,
npm/npx, and model CLIs Linux-native; installers reject `/mnt` checkouts and
Windows Node/npx, and the server fails closed on mixed runtime paths.

Windows Chrome is the intentional GUI interop boundary. The launch script uses
`powershell.exe` to start a dedicated
`%LOCALAPPDATA%\RelayBridge\ChromeDevToolsProfile` while MCP and AI clients stay
inside WSL. It binds DevTools to `127.0.0.1:9222`; mirrored WSL networking may be
required. Browser control is powerful: never expose or tunnel that port, avoid
sensitive personal sessions in the automation profile, and close the dedicated
Chrome when the task is complete.

Chrome MCP defaults to slim navigation, evaluation, and screenshot tools. If
console, network, or performance evidence is required, the operator should
replace the user-scoped registration with
`./install-chrome-mcp.sh --full-tools --full-permissions`, restart Codex and
Claude, and then keep the resulting evidence bounded.

## Safe Workflow

1. Use `bridge_status` and `list_providers` when you need current readiness.
2. Use `route_preview` before spending a hosted provider call.
3. Use `route_and_ask` for one bounded routed provider response.
4. Use `run_committee` for independent advisory responses from multiple providers.
5. Use `list_runs`, `get_run`, `list_receipts`, and `get_receipt` for provenance.

For concurrent raw REST calls, generate a unique `requestId` per call and keep
the direct `requestId`/`invocationId`/`receiptId` tuple together. Never assign a
detached response by selecting the newest receipt.

## Terminal Control

`start_safe_session(kind:"powershell")` opens a real host PowerShell process. `send_session_input` can execute arbitrary commands under the user's account after host approval. RelayBridge is not a filesystem sandbox.

Use terminal tools only when the user has authorized host execution or when the current task clearly requires it. Prefer read-only discovery and provider routing for analysis.

## Environment

Preferred variables:

- `RELAYBRIDGE_URL`
- `RELAYBRIDGE_TOKEN`
- `RELAYBRIDGE_TOKEN_FILE`
- `RELAYBRIDGE_CONFIG_FILE`
- `RELAYBRIDGE_DATA_DIR`
- `RELAYBRIDGE_ALLOWED_ROOTS`

Legacy `PS_BRIDGE_*` variables remain supported for older installations.

## Security Boundary

RelayBridge binds to `127.0.0.1`. The capability token controls REST, WebSocket, and MCP access. Do not print the token in logs, chat, issues, pull requests, or documentation.

Loopback is a reachability boundary, not authentication. Do not expose the port
through a tunnel or reverse proxy, and keep the token file readable only by the
owning user. A process running as that user can still attempt to access it.

Do not commit runtime files:

- `.bridge-token`
- `.state.json`
- `.mcp-start.lock`
- `data/`
- `node_modules/`
- `*.log`

## Verification

Run:

```powershell
npm test
npm audit --omit=dev
```

For local MCP smoke testing against a running bridge:

```powershell
$env:RELAYBRIDGE_URL = 'http://127.0.0.1:8787'
npm run smoke:mcp -- --committee
```
