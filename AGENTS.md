# RelayBridge Agent Guide

This repository contains RelayBridge, a local Windows PowerShell and AI CLI control plane with browser, REST, and MCP interfaces.

## First Call

When connected through MCP, call `get_context_bundle` first. It returns the bounded handoff packet: health, provider readiness, active work, terminal tails, collaborations, projects, runs, receipts, registry fingerprints, and exact follow-up tools for omitted detail.

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
