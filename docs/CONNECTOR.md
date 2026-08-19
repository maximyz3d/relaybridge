# Full integration — every surface, one bridge

RelayBridge reaches Claude through **five** mechanisms. They are not
alternatives; each covers a surface the others can't.

| Layer | Surface it serves | Transport | Setup |
|---|---|---|---|
| **Memory (primer)** | every CLI agent, every session | file | `install-skill.ps1` |
| **Skill** | Claude Code / Cowork, on demand | file | `install-skill.ps1` |
| **MCP (stdio)** | Cowork, Code, Cursor, Codex, Gemini, Claude Desktop | stdio | `install-mcp.ps1`, `install-mcp-clients.ps1` |
| **Connector (remote MCP)** | **Chat tab, claude.ai, mobile** | HTTPS | this doc |
| **Dashboard + REST** | humans, browser automation | loopback HTTP | always on |

Why the connector is separate: the Chat surface **cannot spawn local
processes**. It only talks to remote MCP servers over HTTPS. That's why
relaybridge appears in Cowork but not in Chat — not a misconfiguration, a
different transport. `lib/remote-mcp.js` closes that gap by serving the *same*
`buildServer()` tool set over HTTP.

---

## Which surface am I on?

Ask the session: **"do you have a `bridge_status` tool?"**

- **Yes** → stdio MCP is working. Nothing more needed.
- **No** → you're on Chat/mobile. You need the connector below.

---

## Enabling the connector

### 1. Turn on the endpoint

It is **off by default**, deliberately. Enable and restart:

```powershell
[Environment]::SetEnvironmentVariable('RELAYBRIDGE_REMOTE_MCP','1','User')
$p = (Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue).OwningProcess | Select -Unique
if ($p) { Stop-Process -Id $p -Force }
Start-Sleep 3
cd "$env:LOCALAPPDATA\RelayBridge"; .\start.ps1
curl.exe -s http://127.0.0.1:8787/api/remote-mcp/status
```

Expect `{"enabled":true,"path":"/mcp","profile":"safe"}`.

### 2. Give it a public HTTPS URL

The Chat surface reaches the internet, not your loopback. Use a **stable**
hostname — Tailscale Funnel is the right tool; a random `trycloudflare.com` URL
changes on every restart and breaks the connector each time.

```powershell
tailscale funnel --bg 8787
tailscale funnel status     # note the https://<machine>.<tailnet>.ts.net URL
```

Cloudflare quick tunnels work for a one-off test but are not durable:

```powershell
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel --url http://127.0.0.1:8787
```

### 3. Add it in Claude

**Settings → Connectors → Add custom connector**

- **URL**: `https://<your-host>/mcp`
- **Auth**: Bearer token — paste the contents of
  `%LOCALAPPDATA%\RelayBridge\.bridge-token`

Print the token with:

```powershell
Get-Content "$env:LOCALAPPDATA\RelayBridge\.bridge-token" -Raw
```

Then start a **new** Chat and ask for `bridge_status`.

---

## What is and isn't exposed remotely

A public URL fronting a real PowerShell is a serious thing, so the endpoint is
deliberately narrower than stdio.

**Never remote, at any profile** — not advertised, so a model never plans
around them: `run_powershell`, `exec`, `open_session`, `send_session_input`,
`close_session`, `read_session_buffer`, `start_provider_signin`.

**`safe` profile (default)** additionally withholds repo-mutating tools:
`github_track_run`, `github_onboard_repo`, `github_checkout_version`,
`set_agent_tags`, `restart_bridge`. You still get status, model discovery,
routing, `route_and_ask`, `run_committee`, receipts, and all GitHub **read**
tools — ~30 tools.

**`full` profile** adds the mutating tools back. It requires **two** flags, so
it can't be reached by flipping one:

```powershell
[Environment]::SetEnvironmentVariable('RELAYBRIDGE_REMOTE_MCP_PROFILE','full','User')
[Environment]::SetEnvironmentVariable('RELAYBRIDGE_REMOTE_MCP_FULL','1','User')
```

Terminal tools stay blocked even then. If you want remote shell access, use the
dashboard over the tunnel with the token — an explicit, visible choice rather
than something a model can invoke.

**Auth**: bearer token on every request, compared in constant time; a wrong
token of the same length fails. Unauthenticated requests are rejected *before*
any protocol handling.

**Rotating the token** (do this if a tunnel URL leaks): delete
`.bridge-token`, restart the bridge, and re-paste the new value into the
connector and any MCP clients.

---

## Recommended posture

Run the connector in `safe` profile with a Tailscale Funnel URL. That gives
every surface — phone included — the ability to check status, route work, and
run committees, while the operations that change your machine stay on stdio
where they require a local, already-trusted client.

Turn the funnel off when you don't need it:

```powershell
tailscale funnel --https=443 off
```

---

## Verifying the whole stack

```powershell
cd "$env:LOCALAPPDATA\RelayBridge"
node tools\mcp-smoke-call.mjs        # stdio: expect 36 tools, all PASS
curl.exe -s http://127.0.0.1:8787/api/remote-mcp/status   # connector: enabled
npm test                              # 122 tests
```

Then, in a Chat session with the connector added, ask for `bridge_status`. If
it answers, all five layers are live.
