# RelayBridge

RelayBridge is a local Windows control plane for PowerShell and AI CLIs. It gives a human browser UI, a local REST API, and an MCP server so tools such as Codex and Claude can inspect work, open safe terminal sessions, delegate bounded prompts to configured providers, run small committees, and retrieve receipts.

RelayBridge binds to `127.0.0.1` only. Browser, REST, WebSocket, and MCP control use a generated local capability token. Provider CLIs can still make outbound requests to their own vendors.

## One-Line Install

Run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/maximyz3d/relaybridge/main/install.ps1 | iex
```

That installs RelayBridge to `%LOCALAPPDATA%\RelayBridge`, installs Node dependencies, starts `http://127.0.0.1:8787`, and opens the dashboard.

If PowerShell blocks scripts on a new computer, use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/maximyz3d/relaybridge/main/install.ps1 | iex"
```

After the core install, the installer lists every configured AI CLI in a numbered menu — installed or not, with the exact command each would run — and asks which ones to install (for example `1,3`, `A` for all missing, or Enter to skip). Nothing is installed without your selection, and sign-in still happens in each CLI on first use. Seats that share one installer are grouped, so Claude Code and Claude Fable are a single npm install and the local Ollama models are a single winget install.

For scripted or repeat installs, download `install.ps1` and pass parameters:

```powershell
.\install.ps1 -Providers cursor,claude   # install specific provider CLIs without the menu
.\install.ps1 -SkipProviderSetup        # core bridge only, no provider prompt
```

## Requirements

- Windows 10/11
- PowerShell 5.1 or PowerShell 7+
- Node.js 20.3 or newer
- Optional: GitHub CLI only if you want to contribute to the repo
- Optional provider CLIs: Codex, Claude, Cursor Agent, Antigravity/Gemini, GitHub Copilot CLI, Grok, Perplexity `pwm`, and Ollama

RelayBridge works with only PowerShell installed, but AI delegation requires the relevant provider CLIs to be installed and logged in.

## Start

From the install folder:

```powershell
Set-Location "$env:LOCALAPPDATA\RelayBridge"
.\start.ps1
```

Use a staging port:

```powershell
$env:PORT = '8788'
.\start.ps1
```

Do not set `RELAYBRIDGE_ALLOW_STICKY_DANGEROUS=1` unless you intentionally want the browser Full Permissions toggle to persist across restarts. It resets to off by default.

## Register MCP

After starting RelayBridge once:

```powershell
Set-Location "$env:LOCALAPPDATA\RelayBridge"
.\install-mcp.ps1
```

For a staged bridge:

```powershell
.\install-mcp.ps1 -BridgeUrl 'http://127.0.0.1:8788'
```

The installer registers a user-scoped MCP server named `relaybridge` with Codex and Claude when those CLIs are available. It stores the loopback URL and the path to the local token file, not the token value itself. Restart Codex or Claude after registration so they reload MCP configuration.

Useful checks:

```powershell
codex mcp get relaybridge --json
claude mcp get relaybridge
$env:RELAYBRIDGE_URL = 'http://127.0.0.1:8787'
npm run smoke:mcp -- --committee
```

## What AI Clients Can Do

The MCP server exposes read-only discovery, bounded provider calls, committees, lifecycle tools, and controlled terminal sessions.

Read-only tools include bridge health, provider readiness, routing preview, terminal/session summaries, saved collaborations, runs, receipts, and a bounded `get_context_bundle` handoff packet. MCP resources are also available at `psbridge://context`, `psbridge://health`, `psbridge://providers`, `psbridge://routing-policy`, `psbridge://evidence`, `psbridge://sessions`, `psbridge://collabs`, and `psbridge://runs`.

Action tools include starting/restarting/stopping the local bridge, opening safe terminal sessions, sending terminal input, asking one provider, routing a prompt to an appropriate provider, and running a bounded multi-provider committee. Action tools are annotated for host approval. A PowerShell terminal is still a real host shell; RelayBridge is a control plane, not a full OS sandbox.

## Provider Setup

Provider definitions live in `cli-config.json`. Each provider can define interactive safe/dangerous commands, one-shot safe/dangerous commands, readiness probes, install text, prompt caps, models, and environment variables to strip before execution.

Agentic one-shot providers use bounded multi-turn budgets. Grok receives up to
32 turns so a repository review can inspect evidence and still return a final
answer; the bridge deadline, process-tree cancellation, read-only sandbox, and
no-subagent rules remain the hard safety limits.

Common setup commands:

```powershell
npm install -g @openai/codex
npm install -g @github/copilot
irm 'https://cursor.com/install?win32=true' | iex
npm install -g @xai-official/grok
irm https://antigravity.google/cli/install.ps1 | iex
uv tool install --upgrade perplexity-web-mcp-cli
winget install --id Ollama.Ollama -e
ollama pull qwen2.5:1.5b
ollama pull llama3.2:3b
ollama pull qwen3:4b
ollama pull qwen2.5-coder:7b
```

Run each provider login once in a normal terminal, then restart RelayBridge and open `/api/diag` or the dashboard diagnostics view.

GitHub Copilot CLI can also be installed with `winget install GitHub.Copilot`. It requires an active Copilot plan and may ask you to trust the current workspace before it reads or changes files. RelayBridge configures Copilot as a bounded one-shot provider using `copilot --prompt`, and it strips GitHub token environment variables from child processes.

Cursor Agent uses the native Windows CLI (the `agent` binary in `%USERPROFILE%\.local\bin`). RelayBridge runs the interactive safe seat in plan mode and the bounded one-shot safe seat as read-only Q&A (`--mode ask` with `--trust`, since headless print mode otherwise has full write access and would prompt for workspace trust). No model is pinned, so your account default applies; run `agent models` to list options and pin one in `cli-config.json` if you want. `CURSOR_API_KEY` is stripped from child processes so calls use your Cursor subscription login rather than silently billing a metered API key.

The default Perplexity route uses the community `pwm` wrapper and strips paid API fallback variables. It depends on the connected Perplexity web account and may change if that upstream wrapper changes.

Hosted free/quota providers are intentionally opt-in. `groq_llama_fast` uses Groq's OpenAI-compatible endpoint with `GROQ_API_KEY`, pins Meta Llama `llama-3.1-8b-instant`, sets `allow_paid_fallback=false`, and is marked `autoRoute=false` so normal routing will not silently spend hosted quota. Direct China-hosted endpoints such as DeepSeek API and Alibaba DashScope are blocked by the hosted adapter. Local Qwen through Ollama remains available because it runs on your machine rather than a China-hosted service.

## Routing

`config/routing-policy.json` defines utility, standard, complex, and critical tiers. Utility prompts prefer cheap/local seats. Coding prompts prefer local coder seats before hosted escalation. Current research requires a source-capable provider. Medical, legal, financial, secrets, safety-critical, and destructive signals require explicit human acknowledgement and remain advisory.

`config/provider-evidence.json` records why providers and integrations are tagged the way they are. The registry is deliberately conservative: public benchmark links and model cards are references, not proof that a specific local CLI setup is best for your task. RelayBridge receipts are the local evidence trail.

## Browser UI

The dashboard includes:

- terminal tabs for PowerShell and configured AI CLIs
- provider diagnostics and install hints
- click-to-install: launching a provider whose CLI is missing opens a guided install dialog (shows the exact command, installs only after you confirm, then opens the terminal)
- saved collaboration rooms
- AI team controls for provider selection, routing, and committee runs
- runs and receipt history
- a Full Permissions toggle for browser-created sessions

New collaboration rooms preselect local seats when available. Hosted seats are opt-in so a fresh room does not accidentally spend subscription quota.

Provider entries may declare a string-only `oneshot_env` map for child-process isolation and use a validated `{cwd}` placeholder to bind tools to the requested workspace. RelayBridge applies overrides only to that provider's one-shot process and reports only the overridden variable names in route metadata. Grok one-shots disable automatic Claude/Cursor MCP discovery and bypass inherited leader processes, preventing a repository review from recursively reconnecting to RelayBridge; interactive Grok sessions retain their normal MCP configuration. Gemini one-shots receive the validated workspace explicitly so safe headless reads do not depend on launch-directory inference.

## REST API

`GET /api/health` and same-origin `GET /api/capability` are bootstrap endpoints. Other `/api/*` routes require `X-RelayBridge-Token`. `X-PS-Bridge-Token` remains accepted for older clients.

PowerShell example:

```powershell
$bridgeRoot = "$env:LOCALAPPDATA\RelayBridge"
$bridgeToken = (Get-Content -Raw (Join-Path $bridgeRoot '.bridge-token')).Trim()
$headers = @{ 'X-RelayBridge-Token' = $bridgeToken }

Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/diag' -Headers $headers

$jsonHeaders = @{
  'X-RelayBridge-Token' = $bridgeToken
  'Content-Type' = 'application/json'
}
$body = @{ kind = 'ollama_fast'; prompt = 'Define deterministic.'; dangerous = $false } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/oneshot' -Method Post -Headers $jsonHeaders -Body $body
```

Core routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness and instance identity |
| GET | `/api/capability` | Same-origin token bootstrap |
| GET | `/api/config`, `/api/diag`, `/api/permissions` | Configuration, readiness, permissions |
| POST | `/api/permissions` | Change browser/global permission state |
| GET/POST | `/api/sessions` | List or create sessions |
| GET/POST/DELETE | `/api/sessions/:id/...` | Read, write to, or stop a session |
| POST | `/api/exec` | Raw one-shot shell execution |
| POST | `/api/oneshot` | One provider call |
| POST | `/api/install` | Run a configured provider installer |
| GET/POST/PUT/DELETE | `/api/collabs...` | Collaboration rooms |
| GET/POST | `/api/projects` | Saved project labels |
| GET | `/api/activity` | Recent run and receipt summaries |
| POST | `/api/open-url` | Open an allowed HTTP(S) URL locally |
| POST | `/api/admin/shutdown` | Graceful bridge shutdown |

Direct REST callers holding the token are trusted operators.

## Data and Privacy

The default `data` directory contains saved collaborations, runs, receipts, cache entries, and project labels. It is git-ignored.

Runtime files that should not be committed:

- `.bridge-token`
- `.state.json`
- `.mcp-start.lock`
- `data/`
- `node_modules/`
- `*.log`

Set `RELAYBRIDGE_DATA_DIR` to move retained data. Set `RELAYBRIDGE_ALLOWED_ROOTS` to restrict process start directories. That setting is not a complete filesystem sandbox for already-running host processes.

Legacy `PS_BRIDGE_*` environment variables are still accepted as fallbacks for existing installations.

## Verification

No-spend checks:

```powershell
npm test
npm audit --omit=dev
```

Local MCP smoke:

```powershell
$env:RELAYBRIDGE_URL = 'http://127.0.0.1:8787'
npm run smoke:mcp -- --committee
```

The test suite validates configuration, safety boundaries, transport cleanup, routing, cancellation, MCP tools/resources, and browser script parsing with fake providers. It does not prove provider authentication, quota, model quality, or benchmark performance.

## For AI Agents

When an AI client connects through MCP, it should start with `get_context_bundle`. That returns a bounded snapshot with health, providers, active work, terminal tails, collaboration history, projects, recent runs, receipts, registry fingerprints, and the exact detail tools needed for anything omitted.

Use `route_preview` before spending a hosted provider call. Use `route_and_ask` for one bounded answer with policy routing. Use `run_committee` when you need independent advisory views. Use `start_safe_session` and `send_session_input` only when host shell execution is actually required and approved.

Every provider call writes receipts where possible. Use `list_runs`, `get_run`, `list_receipts`, and `get_receipt` to recover provenance instead of relying on a chat transcript alone.

## License

MIT.
