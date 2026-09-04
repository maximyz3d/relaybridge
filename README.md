# RelayBridge

RelayBridge is a local Windows control plane for PowerShell and AI CLIs. It gives a human browser UI, a local REST API, and an MCP server so tools such as Codex and Claude can inspect work, open safe terminal sessions, delegate bounded prompts to configured providers, run small committees, and retrieve receipts.

RelayBridge binds to `127.0.0.1` only. Browser, REST, WebSocket, and MCP control use a generated local capability token. Provider CLIs can still make outbound requests to their own vendors.

## One-Line Install

Run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/maximyz3d/relaybridge/main/install.ps1 | iex
```

That installs RelayBridge to `%LOCALAPPDATA%\RelayBridge`, installs locked Node dependencies in a sibling staging directory, starts `http://127.0.0.1:8787`, verifies the exact staged build, and then opens the dashboard.

The installer also adds that install directory to your user `PATH` and ships a stable `relaybridge.cmd` launcher, so `relaybridge status`, `relaybridge plan`, and the other CLI commands work in new terminals. When the installer runs directly in the current PowerShell process (for example, `irm ... | iex`), it also updates that process's `PATH` immediately. When it is launched through a child `powershell -File` process, open a new terminal afterward so it inherits the updated user `PATH`. Custom `-InstallDir` values are registered the same way.

For diff-sized prompts on Windows, do not place the prompt on the command line.
Pipe UTF-8 text over standard input or read it from a UTF-8 file instead:

```powershell
# PowerShell 7 preserves UTF-8 for native pipelines.
git diff --no-ext-diff | relaybridge ask --kind gemini --stdin

# PowerShell 5.1-safe path when the prompt is already in $prompt.
$prompt | Set-Content -Encoding utf8 -NoNewline .\review-prompt.txt
relaybridge plan --prompt-file .\review-prompt.txt
relaybridge ask --kind claude --prompt-file .\review-prompt.txt
```

`plan` and `ask` accept exactly one prompt source: positional text, `--stdin`,
or `--prompt-file <path>`. Empty input, invalid UTF-8, missing files, and
conflicting sources fail locally before RelayBridge plans or starts a provider.
The prompt body is sent in the HTTP request body; it is never copied into child
process arguments or error output.

Updates are transactional. The installer tests the staged release before draining a matching old bridge, atomically promotes it, and restores and restarts the previous build if promotion, startup, health verification, or MCP registration fails. `.bridge-token`, `.state.json`, and `data/` move with the release instead of being copied, while existing `cli-config.json` and `config/*.json` values win a schema-aware merge so operator model pins, tags, routing policy, and unknown providers are preserved. Optional provider installation happens only after the core cutover succeeds.

If PowerShell blocks scripts on a new computer, use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/maximyz3d/relaybridge/main/install.ps1 | iex"
```

After the core install, the installer lists every configured AI CLI in a numbered menu — installed or not, with the exact command each would run — and asks which ones to install (for example `1,3`, `A` for all missing, or Enter to skip). Nothing is installed without your selection, and sign-in still happens in each CLI on first use. Seats that share one installer are grouped, so Claude Code and Claude Fable are a single npm install and the local Ollama models are a single winget install.

For scripted or repeat installs, download `install.ps1` and pass parameters:

```powershell
.\install.ps1 -Providers cursor,claude   # install specific provider CLIs without the menu
.\install.ps1 -SkipProviderSetup        # core bridge only, no provider prompt
.\install.ps1 -MigrateFrom 'C:\old\RelayBridge'  # explicitly move token/state/data from one legacy root
```

`-MigrateFrom` is deliberately explicit. If both the destination and migration source already exist, the installer stops rather than silently merging two security tokens or two data histories; archive the unwanted root and rerun with the intended source of truth.

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

`start.ps1` does not install or update dependencies. It refuses to open the dashboard until the listener reports the install's exact `buildId`; rerun `install.ps1` if the locked dependencies are missing.

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

For the recommended WSL-native Codex + Claude deployment, keep this checkout
under the Linux home filesystem (for example `~/src/relaybridge`) and run:

```bash
./install-skill.sh --register-mcp --register-chrome --full-permissions
./start-chrome-debug.sh
```

The first command links the pipeline skill and roles, registers this exact
checkout's RelayBridge MCP server, and registers the pinned Chrome DevTools MCP
in slim mode. The second starts a dedicated Chrome debugging profile. Restart
open Codex and Claude clients after registration. On plain Linux or macOS, omit
`--register-chrome` unless a compatible local Chrome debugging endpoint is
available. To install only the pipeline and RelayBridge integration, use
`./install-skill.sh --register-mcp --full-permissions`; omit the final flag for
the safe-reset default. Existing client config and role targets are backed up
before replacement, registrations are verified, and the Codex MCP tool timeout
is derived from `config/timeout-policy.json`.

This deployment uses `--full-permissions` because the owner explicitly
requested persistent auto/full-permission operation. The option adds
the sticky and start-full permission variables to both RelayBridge MCP
registrations and pre-approves the Codex-side MCP tool policy for the registered
servers. It is off by default for general installations; omit it to make Full
Permissions reset off after restart.

For MCP pipeline creation, that owner-level opt-in also establishes the
per-workflow default: when a `start_codex_claude_pipeline` call omits both
permission fields, the MCP handler atomically sends
`permissionMode:"full"` and `acknowledgeFilesystemWrites:true`. This shortcut
applies only when both fields are absent. Explicit `permissionMode:"full"`
without `acknowledgeFilesystemWrites:true`, or an explicit acknowledgement
without `full`, is not completed from the environment and fails closed. Send
`permissionMode:"safe"` and `acknowledgeFilesystemWrites:false` to override the
installed default for one workflow. Raw REST workflow creation does not use the
MCP shortcut: omitted REST fields remain `safe`/`false`.

The resolved pair is stored on that workflow; it does not bypass planning,
review, accepted-finding, or exclusive writer-lease gates. Existing workflows
are not changed when MCP registration defaults change.

The POSIX installers register `relaybridge` and, when requested,
`chrome-devtools` in the current user's Codex and Claude configuration. Skill
and agent links are also user-scoped under `~/.agents`, `~/.codex`, and
`~/.claude`; they point back to this exact checkout, so do not move or delete it
without reinstalling. The RelayBridge registration stores the loopback URL and
the path to the local token file, not the token value itself, and rolls back
both client configurations after a partial registration. The PowerShell installer
also removes recognized legacy names (`ps_bridge` and `ps-bridge`) only when
their command is confirmed to target a RelayBridge `mcp/server.mjs`; unrelated
lookalikes are retained. Restart Codex or Claude after registration so they
reload MCP configuration.

### WSL-native runtime and Chrome boundary

On WSL, RelayBridge, its checkout, state/data/token/config files, Node, npm/npx,
and provider CLIs should all be Linux-native and live under the Linux
filesystem. The POSIX installers refuse a checkout or Node/npx resolved through
`/mnt`; the server also fails closed when its checkout, data, token, config, or
Node path crosses that boundary. This avoids DrvFs/9p latency, path translation,
and mixed Windows/Linux process trees. The server has an explicit
`RELAYBRIDGE_ALLOW_SLOW_WSL_FS=1` diagnostic override, but the installers still
require a native checkout. Windows-only provider binaries are not selected by
default; install their Linux CLI instead of relying on WSL interop.

Windows Chrome is the intentional GUI exception. `start-chrome-debug.sh` uses
`powershell.exe` only to launch Windows Chrome with a separate profile at
`%LOCALAPPDATA%\RelayBridge\ChromeDevToolsProfile`, bound to
`http://127.0.0.1:9222`; the MCP process and AI clients remain in WSL. Mirrored
networking reaches that endpoint directly. Under WSL NAT, the launcher instead
creates a narrow two-hop forward: Linux-native `socat` listens only on WSL
`127.0.0.1:9222`, and Windows `node.exe` listens on a distinct high port only
on the verified Hyper-V WSL adapter. The Windows helper accepts only the current
distro IP and forwards only to Chrome's Windows loopback. It does not add or
weaken firewall rules. The NAT fallback therefore requires Linux `socat` and
Windows Node; installing either under `/mnt` is still not allowed for the main
RelayBridge runtime.
This profile is separate from normal Chrome, but it is persistent and may retain
cookies or site data. Treat anyone able to reach its DevTools port as able to
control that browser: do not publish either listener to wildcard, LAN, VPN, or
internet addresses, use only accounts appropriate for automation, and close the
dedicated Chrome when finished. Mirrored networking remains the preferred path;
the source-restricted private adapter hop exists only for WSL NAT compatibility.

Chrome MCP installs in slim mode by default. Slim mode covers the usual
navigation, page evaluation, and screenshot workflow while keeping the tool
surface and context cost small. When a task genuinely requires console,
network, or performance tooling, replace the user-scoped registration and then
restart open AI clients:

```bash
./install-chrome-mcp.sh --full-tools --full-permissions
```

For the staged Codex-orchestrated planning, implementation, and review workflow,
see [Codex-Claude pipeline](docs/CODEX-CLAUDE-PIPELINE.md).
At the start of each new or resumed client session, use `list_pipelines` before
creating a workflow. Resume a matching active run with status-only
`get_pipeline` and follow its `nextActions`; active provider phases advance only
through the identity-gated `reconcile_pipeline` action. Do not duplicate durable
work after a disconnect or while a provider phase is merely slow. The pipeline guide maps every MCP phase tool to
its authenticated `/api/workflows...` REST operation. The closing review gate
is a fresh read-only Claude Sonnet/high run; Codex verification may add focused
evidence but does not replace that final Claude verdict. Typed transient
read-only failures use durable bounded backoff; older terminalized 429/timeout
runs can use `retry_failed_pipeline_provider`, while writer and semantic
failures remain terminal. Restart-interrupted tasks require that explicit
recovery action so status reads cannot overlap a potentially surviving process.

MCP actions that cross into REST or provider admission fail closed unless the MCP process and REST listener report the same exact build and receipt store. The store identity is a SHA-256 value bound to a persisted random seed and the canonical store location; health, errors, and receipts never expose the raw data path. Read-only status tools and local cache replays remain available during a mismatch so an operator can inspect the listener and use the lifecycle tools to replace a stale build. A rejected provider action records `modelInvocation:false`, `tokenUsageSource:not_invoked`, zero retries, and no transport receipt.

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

Provider definitions live in `cli-config.json`. Each provider can define interactive safe/dangerous commands, one-shot safe/dangerous commands, readiness probes, install text, prompt caps, models, and environment variables to strip before execution. A probe may combine `probe_expect` with a `probe_reject` string array; rejected output always wins, even when the CLI exits zero or the positive phrase is also present as part of a negative status.

Provider keys identify routes and models; `quota_seat` identifies the signed-in
account whose allowance they share. Claude and Claude Fable therefore retain
separate receipts/model identities but aggregate fuel, burn rate, generic
quota cooldowns, and fleet balancing under
`subscription:anthropic:default`. Grouping is explicit rather than inferred
from `transport`, because two installations may use the same vendor transport
with different accounts. Status output lists every alias in each quota seat.
Vendor evidence marked `scope: "model"` remains model/provider scoped; generic
429 and overload evidence is conservatively shared across the account group.

When the account owner knows a seat is lower than its configured estimate, the
Fuel panel can record an explicit quota-seat percentage with provenance and an
expiry/reset time. The bridge stores only those bounded fields in
`data/usage/operator-quota.jsonl`; it never scrapes a vendor dashboard or
accepts credentials/free-form dashboard content. A current vendor observation
has first precedence, then a current operator observation, then the labelled
configured estimate. Operator observations automatically stop affecting
routing at expiry and apply to every provider alias in the declared quota seat.
REST clients may use `GET`, `PUT`, and `DELETE /api/usage/operator-quota`.

Agentic one-shot providers use bounded multi-turn budgets. Grok receives up to
32 turns so a repository review can inspect evidence and still return a final
answer; the bridge deadline, process-tree cancellation, and no-subagent rules
remain safety limits. A provider CLI's nominal plan/read-only flag is not by
itself proof that the CLI cannot persist state outside the workspace.

Safe one-shots now fail closed on an explicit filesystem-effects contract. Each provider declares
`oneshot_safe_filesystem_policy` as exactly one of:

- `read_only_enforced`: the transport has a proven no-write boundary;
- `isolated_home`: RelayBridge starts the CLI with a fresh disposable HOME,
  USERPROFILE, AppData, and XDG tree, then deletes only that marker-owned temp
  child after exit; no credentials or settings are copied into it. This
  contains conventional provider-state paths but is not reported as an OS-wide
  read-only sandbox;
- `unverified_provider_policy`: the safe request is rejected before admission
  with `safe_filesystem_unverified`, zero provider tokens, and migration
  guidance.

Responses and receipts report `filesystem_policy`, `read_only_enforced`, and
the terminal isolated-home cleanup state. If ownership validation or deletion
fails, RelayBridge preserves that exact temp directory for inspection and marks
the run dropped as `isolation_cleanup`; it never broadens deletion to the real
provider home. `dangerous:true` remains the only explicit human-authorized
writer path, and no safe rejection is automatically retried as dangerous.
Claude and Fable safe one-shots are `read_only_enforced` only because their
launch vectors combine `--safe-mode`, `--restricted`, an explicit empty strict
MCP config, `--tools Read,Glob,Grep`, plan permission mode, no session
persistence, and a 150k auto-compact window. Restricted mode confines built-in
file tools to the working directories and refuses bypass-permissions mode.
Changing or removing that complete launch boundary requires returning the
provider to `unverified_provider_policy` until the replacement is verified.
Other unproven subscription CLIs remain unavailable for safe one-shots.

Filesystem eligibility is applied before routing, not only at execution.
`/api/diag`, `/api/agents`, MCP provider summaries, route candidates, plans,
and usage advice distinguish provider login readiness from safe-one-shot
readiness. Normal safe routing excludes `unverified_provider_policy` seats and
reports them in `filesystemSkipped`; explicitly requesting one keeps it visible
as a blocked, pre-invocation plan instead of silently choosing it.
Writer-capable route/plan previews require both `dangerous:true` and
`acknowledgeFilesystemWrites:true`; neither field changes execution authority
by itself.

The global `_supervisor.providerBudget` sets provider-reported ceilings for
output tokens, total tokens (including cache traffic), cache reads, cache
creation, and turns. Provider entries may override them generally with
`supervisor.providerBudget` or by task tier with
`supervisor.providerBudgetByTaskTier`. REST/MCP callers may supply a sparse
`providerBudget` for one run; `null` disables one dimension. The CLI exposes
the same override as `--provider-budget '<json>'` on `plan` and `ask`.
`maxTurns` ships as `null`. An agentic CLI spends one turn per tool call, so a
turn count measures how many files a model read rather than what the run cost
or whether it is still alive; a fixed shipped ceiling stopped healthy, complete
terminal results while every token ceiling stayed far from tripping. Set a
positive `maxTurns` globally, on a provider entry, or per request when a turn
ceiling is genuinely wanted, and it is enforced exactly as before. Upgrades
replace only the exact retired shipped value declared in
`_config_merge.managed_supervisor_budget_fields` and report the replacement;
any other installed value is kept as an operator choice.
These gates never use cleaned-output character estimates. Claude stream-json
assistant usage can stop a run incrementally; terminal-only provider usage is
classified truthfully as terminal enforcement and cannot recover tokens already
spent. A `token_budget` stop is not retried or escalated automatically.

Antigravity 1.1.19 is an explicit unenforceable boundary: its documented text,
JSON, and stream-JSON modes expose messages but no authoritative token or turn
usage. Gemini diagnostics, agent status, and the Fuel panel therefore publish
`usageCapability.budgetEnforcement: "unenforceable"`; RelayBridge does not turn
output characters into a token estimate. The version and inspection evidence
are carried with the capability so a future CLI upgrade can be re-evaluated.

Standard Claude planning defaults to Sonnet/medium; complex plans route to
Opus/high and the hardest plans can use Fable's explicit heavy tier. Fable has
no dangerous slot. Bounded Claude revisions use the `claude` provider's
Sonnet/medium writer slot. Maximum effort is never inferred: a caller must send
both `effort: "max"` and `maxEffortOverride: true`. Claude accepts max directly;
Codex maps that cross-provider request to `xhigh`, its highest supported normal
CLI configuration value, rather than silently reducing it to high.

Provider prompts default to a 20-minute deadline and accept an explicit
`timeoutMs` up to 45 minutes. The liveness supervisor also grants buffered
print-mode CLIs the full 20-minute default silence window, so a healthy Claude
response is not killed by the earlier six-minute idle heuristic.
`ask_provider`, routed calls, committees,
broadcasts, the REST one-shot path, and the MCP transport all use
`config/timeout-policy.json`; direct REST values above the cap are clamped and
reported as `route.effective_timeout_ms`. Routed work still shares one overall
tier deadline, and caller cancellation still terminates the provider process
tree. Rerun `install-mcp.ps1` or `install-mcp.sh` after changing this policy so
Codex receives a host-side tool timeout long enough to cover the provider cap and transport
grace. These longer deadlines do not change `dangerous:false`, advisory-only
committee behavior, or any human gate.

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

Provider buttons and terminal tabs describe configured launch seats; they are not proof that a provider can complete a bounded one-shot. Diagnostics distinguish binary discovery (`found`) from the configured authentication/readiness probe (`ready`), and probe success is still not a quota or task-quality claim. Require a current one-shot receipt before claiming end-to-end availability for delegation or committee work.

GitHub Copilot CLI can also be installed with `winget install GitHub.Copilot`. It requires an active Copilot plan and may ask you to trust the current workspace before it reads or changes files. RelayBridge configures Copilot as a bounded one-shot provider using `copilot --prompt`, and it strips GitHub token environment variables from child processes.

Cursor Agent uses the native Windows CLI (the official PowerShell installer places the `agent` launcher in `%LOCALAPPDATA%\cursor-agent`). RelayBridge prepends that directory for child processes, so a bridge that started before Cursor was installed can resolve it without inheriting a refreshed shell PATH. The configured bounded safe slot uses Q&A (`--mode ask` with `--trust`), but the provider's cross-filesystem no-write behavior is not verified, so it fails closed until that boundary or credential-free isolated-home authentication is proven. No model is pinned, so your account default applies; run `agent models` to list options and pin one in `cli-config.json` if you want. `CURSOR_API_KEY` is stripped from child processes so calls use your Cursor subscription login rather than silently billing a metered API key.

The configured Antigravity safe slot uses `--mode plan` and a visible, config-driven
command-free review prefix. Headless Antigravity cannot display an Ask-mode
command permission card, and its current CLI has no per-invocation narrow
command allow flag. Persistent `command(prefix)` grants accept trailing
arguments, so RelayBridge does not install a broad `git`, PowerShell, or `rg`
grant and cannot truthfully call one read-only. The safe prompt instead directs
the model to built-in workspace file reading and code search only. If a command
is still selected, the response and receipt report
`headless_command_permission_auto_denied`, mark the run dropped, and prohibit an
identical retry. RelayBridge never switches that failure to
`--dangerously-skip-permissions`; the dangerous slot remains explicit user intent.
Because provider-home writes are also unverified, admission now fails before
invocation unless a stronger filesystem policy is proven and configured.

The default Perplexity route uses the community `pwm` wrapper and strips paid API fallback variables. It depends on the connected Perplexity web account and may change if that upstream wrapper changes.

Hosted free/quota providers are intentionally opt-in. `groq_llama_fast` uses Groq's OpenAI-compatible endpoint with `GROQ_API_KEY`, pins Meta Llama `llama-3.1-8b-instant`, sets `allow_paid_fallback=false`, and is marked `autoRoute=false` so normal routing will not silently spend hosted quota. Direct China-hosted endpoints such as DeepSeek API and Alibaba DashScope are blocked by the hosted adapter. Local Qwen through Ollama remains available because it runs on your machine rather than a China-hosted service.

## Routing

`config/routing-policy.json` defines utility, standard, complex, and critical tiers. Utility prompts prefer cheap/local seats. Coding prompts prefer local coder seats before hosted escalation. Current research requires a source-capable provider. Medical, legal, financial, secrets, safety-critical, and destructive signals require explicit human acknowledgement and remain advisory.

`config/provider-evidence.json` records why providers and integrations are tagged the way they are. The registry is deliberately conservative: public benchmark links and model cards are references, not proof that a specific local CLI setup is best for your task. RelayBridge receipts are the local evidence trail.

## Agent Tags and Broadcast

Every provider in `cli-config.json` carries a `tags` array (for example `coding`, `audit`, `delegation`, `search`, `research`, `general`, `reasoning`, `utility`, `local`, `hosted`). Tags group providers for broadcast targeting and are editable from the 🧩 Agents dialog, `POST /api/agents/:id/tags`, or the `set_agent_tags` MCP tool.

`POST /api/broadcast` sends one prompt through the same bounded one-shot path as `/api/oneshot` to every resolved target: an explicit `providers` list, every AI provider carrying `tag`, or `all:true`. Tag and all selection always skip opt-in `autoRoute:false` hosted seats (such as `groq_llama_fast`) unless they are named explicitly, the global one-shot concurrency cap still applies (extra members queue), and each member writes a normal provider receipt plus one broadcast run record. A broadcast deliberately spends several providers' quota or local compute at once — target it narrowly.

## Browser UI

The dashboard includes:

- terminal tabs for PowerShell and configured AI CLIs
- provider diagnostics and install hints
- click-to-install: launching a provider whose CLI is missing opens a guided install dialog (shows the exact command, installs only after you confirm, then opens the terminal)
- saved collaboration rooms
- AI team controls for provider selection, routing, and committee runs
- runs and receipt history
- a Full Permissions toggle for browser-created sessions
- 📡 Broadcast: send one prompt to several providers at once (pick a tag or check providers; opt-in hosted quota seats start unchecked) and read per-provider result cards
- 🧩 Agents: a provider table with model, readiness, the autoRoute flag, and editable routing tags saved back to `cli-config.json`
- ⟳ Restart and ⏻ Stop buttons: restart relaunches the bridge through `restart.ps1` and reloads the page when the new instance is healthy; stop shuts the bridge down and shows an offline screen

New collaboration rooms preselect local seats when available. Hosted seats are opt-in so a fresh room does not accidentally spend subscription quota.

Provider entries may declare a string-only `oneshot_env` map for child-process environment overrides and use a validated `{cwd}` placeholder to bind tools to the requested workspace. This field alone is not filesystem isolation. RelayBridge applies overrides only to that provider's one-shot process and reports only the overridden variable names in route metadata. `isolated_home` adds the complete disposable provider-state tree described above. Grok one-shots disable automatic Claude/Cursor MCP discovery and bypass inherited leader processes, preventing a repository review from recursively reconnecting to RelayBridge; interactive Grok sessions retain their normal MCP configuration. Gemini one-shots receive the validated workspace explicitly so safe headless reads do not depend on launch-directory inference.

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
$requestId = 'rest:' + [guid]::NewGuid().ToString('D')
$body = @{
  kind = 'ollama_fast'
  prompt = 'Define deterministic.'
  dangerous = $false
  requestId = $requestId
} | ConvertTo-Json
$result = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/oneshot' -Method Post -Headers $jsonHeaders -Body $body
if ($result.requestId -ne $requestId -or $result.invocationId -ne $requestId -or -not $result.receiptId) {
  throw 'RelayBridge returned an invalid correlation tuple; do not infer provenance from receipt ordering.'
}
$correlation = [ordered]@{
  requestId = $result.requestId
  invocationId = $result.invocationId
  receiptId = $result.receiptId
}
$correlation | ConvertTo-Json -Compress
```

### Concurrent raw-call provenance

Every concurrent raw caller must generate its own `requestId` and retain the
direct response's `requestId`, `invocationId`, and `receiptId` as one atomic
tuple. Persist that tuple before launching or collecting another call. Never
attribute work by reading the newest/latest receipt: a slower request can start
first and append its receipt after a faster request has already completed.

If the direct response is lost, provenance is unknown until the exact caller
`requestId` is found in `list_receipts`; then pass that row's exact `receiptId`
to `get_receipt`. Do not substitute the first or newest row. The CLI applies
this rule automatically: `relaybridge ask` generates and prints its request ID
before waiting, then rejects any response whose correlation tuple does not
match.

Shell/curl callers should retain the response itself, not a later receipt-list
snapshot:

```bash
request_id="rest:$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
response_file="$(mktemp)"
jq -n --arg kind ollama_fast --arg prompt 'Define deterministic.' \
  --arg requestId "$request_id" \
  '{kind:$kind,prompt:$prompt,dangerous:false,requestId:$requestId}' |
  curl -sS -X POST http://127.0.0.1:8787/api/oneshot \
    -H "X-RelayBridge-Token: $TOKEN" -H 'Content-Type: application/json' \
    --data-binary @- > "$response_file"
jq -e --arg requestId "$request_id" \
  'select(.requestId==$requestId and .invocationId==$requestId and (.receiptId|type=="string")) |
   {requestId,invocationId,receiptId}' "$response_file"
```

Use the emitted `receiptId` for exact `get_receipt` retrieval. If the final
`jq` check fails, do not attribute the output to that caller.

Core routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness, exact build identity, and instance identity |
| GET | `/api/capability` | Same-origin token bootstrap |
| GET | `/api/config`, `/api/diag`, `/api/permissions`, `/api/workspace` | Configuration, readiness, permissions, effective cwd policy |
| POST | `/api/permissions` | Change browser/global permission state |
| GET/POST | `/api/sessions` | List or create sessions |
| GET/POST/DELETE | `/api/sessions/:id/...` | Read, write to, or stop a session |
| POST | `/api/exec` | Raw one-shot shell execution |
| POST | `/api/oneshot` | One provider call |
| GET | `/api/agents` | AI providers with tags, autoRoute, and cached readiness |
| POST | `/api/agents/:id/tags` | Replace one provider's routing tags in `cli-config.json` |
| POST | `/api/broadcast` | Fan one prompt out to many providers (by `providers`, `tag`, or `all:true`) |
| GET/POST | `/api/workflows...` | List/resume and advance the phase-gated Codex-Claude pipeline; see the pipeline guide for the one-to-one MCP mapping |
| POST | `/api/install` | Run a configured provider installer |
| GET/POST/PUT/DELETE | `/api/collabs...` | Collaboration rooms |
| GET/POST | `/api/projects` | Saved project labels |
| GET | `/api/activity` | Recent run and receipt summaries |
| POST | `/api/open-url` | Open an allowed HTTP(S) URL locally |
| POST | `/api/admin/shutdown` | Graceful bridge shutdown |
| POST | `/api/admin/restart` | Full restart via the detached `restart.ps1` helper (Windows; 501 elsewhere) |

Direct REST callers holding the token are trusted operators.

## Data and Privacy

The default `data` directory contains saved collaborations, runs, receipts, cache entries, and project labels. It is git-ignored.

Runtime files that should not be committed:

- `.bridge-token`
- `.state.json`
- `.mcp-start.lock`
- `build-info.json`
- `data/`
- `node_modules/`
- `*.log`

Set `RELAYBRIDGE_DATA_DIR` to move retained data. Set `RELAYBRIDGE_ALLOWED_ROOTS` to a semicolon-separated list of directories to restrict process start directories. When an explicit allowlist excludes your user profile, RelayBridge defaults new browser, REST, MCP, and provider-installer work to the first existing allowed root; it never broadens the configured list. The authenticated `/api/workspace` endpoint reports the effective default and allowed roots. This setting is not a complete filesystem sandbox for already-running host processes.

Legacy `PS_BRIDGE_*` environment variables are still accepted as fallbacks for existing installations.

## Verification

No-spend checks:

```powershell
npm test
npm run test:install
npm run test:install-mcp
npm audit --omit=dev
```

POSIX installer and metadata checks:

```bash
sh -n install-mcp.sh
sh -n install-skill.sh
sh -n install-chrome-mcp.sh
bash -n start-chrome-debug.sh
node -e "JSON.parse(require('fs').readFileSync('cli-config.json', 'utf8'))"
```

Local MCP smoke:

```powershell
$env:RELAYBRIDGE_URL = 'http://127.0.0.1:8787'
npm run smoke:mcp -- --committee
```

The test suite validates configuration, safety boundaries, transport cleanup, routing, cancellation, MCP tools/resources, browser script parsing, transactional update/rollback, config and runtime preservation, exact-build health, and MCP name migration with fake providers and fake client CLIs. It does not install or call providers, and it does not prove provider authentication, quota, model quality, or benchmark performance.

## For AI Agents

When an AI client connects through MCP, it should start with `get_context_bundle`. That returns a bounded snapshot with health, providers, active work, terminal tails, collaboration history, projects, recent runs, receipts, registry fingerprints, and the exact detail tools needed for anything omitted.

Use `route_preview` before spending a hosted provider call. Use `route_and_ask` for one bounded answer with policy routing. Use `run_committee` when you need independent advisory views. Use `start_safe_session` and `send_session_input` only when host shell execution is actually required and approved.

Agent management tools: `list_agents` lists AI providers with tags, autoRoute, and cached readiness without spawning probes; `set_agent_tags` replaces one provider's routing tags; `broadcast` fans one prompt out to many providers at once and can therefore spend multiple providers' quota in a single call — prefer a narrow tag or explicit provider list.

Every provider call writes receipts where possible. Direct REST validation,
configuration/auth, and admission-limit rejections also write a privacy-safe
zero-invocation receipt and return its identity in the response headers. Use
`list_runs`, `get_run`, `list_receipts`, and `get_receipt` to recover provenance
instead of relying on a chat transcript alone.

Every admitted MCP provider call has one canonical `requestId`/`invocationId`,
one `attemptId` ending in `:attempt:1`, and a preallocated outer receipt ID.
The REST transport receipt links back through `outerReceiptId`; the MCP outer
receipt links forward through `transportReceiptId`. If the caller disconnects
before REST can respond, MCP waits briefly for the late transport receipt and
reconciles its invocation, route, progress, retry, and token truth into exactly
one outer attempt. Direct disconnects are `client_cancelled`; a disconnect at
the MCP transport deadline is `mcp_deadline_cancelled`. Neither is retried.
`modelInvocation` remains truthful, and token usage stays `unknown` unless the
provider itself reported usage; raw transport bytes are never treated as billed
tokens. Completion and sticky supervisor verdicts win races idempotently, and
process-tree cleanup still drives the active one-shot census back to zero.

Timeout receipts distinguish the causal layer. A Relay liveness stop reports
`providerTimeoutSource: relay_supervisor`; an upstream HTTP timeout reports
`provider_api_status`; and a provider CLI that exits with an authoritative
internal-timeout diagnostic reports `provider_cli_diagnostic`. All three are
normalized to `timed_out` / `failureClass: timeout`, while `stopReason` and
`supervisorStopReason` preserve whether Relay itself killed the process. Token
usage remains unknown when the provider did not report it.

Provider success is based on the normalized terminal result, not only the
process exit code. In particular, a Perplexity exit-zero response whose exact
first line is `No answer received` is returned as `dropped_out: true`,
`failureClass: incomplete_response`, and `partial_result: true`. Its sentinel
and any trailing URL/text fragments are disclosed as `failure_sentinel` and
`partial_diagnostic`; ordinary `stdout` is empty so consumers cannot mistake
those fragments for a completed answer. Receipts retain hashes/counts for the
raw transport and normalized partial diagnostic. MCP exposes the same fields in
camelCase, and the CLI labels partial diagnostics on stderr and exits nonzero.
The bridge never retries this failure automatically on the same seat.

## License

MIT.
