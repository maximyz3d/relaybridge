# RelayBridge blueprint — plugin, MCP, skills, connectors, memory

How every surface connects to the bridge, and how to make it fire on **every
prompt** at peak token efficiency. One principle drives everything:

> **The cheapest model that can actually do the job, chosen by evidence, with a
> receipt.** Frontier tokens are for frontier problems.

## The five integration layers

| Layer | What it is | Where it lives | When it loads |
|---|---|---|---|
| **Memory** | The PRIMER block written into every agent's always-loaded memory file | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.cursor/rules/relaybridge.mdc`, `~/.config/relaybridge/AGENTS.md` | **Every session, every prompt** — this is the layer that guarantees the bridge is considered on each turn |
| **Skill** | Full on-demand playbook (SKILL.md + reference.md) | `skills/relaybridge/`, installed to `~/.claude/skills/relaybridge/` | Only when a task touches delegation — costs zero tokens otherwise |
| **MCP** | 35+ typed tools + `psbridge://` resources over stdio | `mcp/server.mjs`, registered by `install-mcp.ps1` into Codex + Claude | When the host lists tools; call `get_context_bundle` first |
| **Plugin surface** | Dashboard panels (terminals, 📡 Broadcast, 🧩 Agents, 🐙 GitHub) + REST | `public/index.html`, `http://127.0.0.1:8787` | Human-driven |
| **Connectors** | Provider seats (Claude, Codex, Copilot, Cursor, Gemini, Grok, Perplexity, Ollama) + the GitHub integration (`gh`-backed) | `cli-config.json`, `config/github-repos.json` | Per delegated call |

**Install order (one time per machine):**

```powershell
irm https://raw.githubusercontent.com/maximyz3d/relaybridge/main/install.ps1 | iex   # core
.\install-mcp.ps1     # register MCP with Codex + Claude, then restart those CLIs
.\install-skill.ps1   # write the primer into every agent memory file + skill folder
```

`install-skill.ps1` is the "used through every prompt" mechanism: memory files
load on every session and the block is marker-delimited, so reruns refresh in
place and never clobber your own notes. The primer is tested to stay under 700
words — always-loaded context is paid on every turn, so detail lives in
SKILL.md, which is free until needed.

## The per-prompt decision ladder (token efficiency)

Every prompt, in order, stopping at the first hit:

1. **Deterministic?** A command answers it (file lists, git status, versions,
   hashes) → `powershell` seat. Zero model tokens.
2. **Utility?** Definitions, conversions, one-liners → `ollama_fast` /
   `ollama_llama`. Local, free, instant.
3. **Standard?** Bounded coding, bug fix, focused review → `ollama_coder` →
   `copilot` → `claude`. Ask the bridge, don't guess: `POST /api/route` or the
   `route_preview` MCP tool ranks installed+authenticated seats for the task.
4. **Complex?** Architecture, migrations, long context → `claude`/`claude_fable`
   → `codex` → `grok` via `route_and_ask`.
5. **Critical?** Irreversible / safety / security / legal / financial →
   `run_committee` for independent advisory views **plus a human gate**. Never
   auto-execute. (For SQ4D this means: E-stop chains, ELMON/FORT wiring, PLC
   safety rungs, anything that moves the gantry.)

Rules that keep this cheap:

- **Never send `timeoutMs`** — progress supervision already stops wedged runs;
  a fixed clock kills healthy long work and wastes the spent tokens.
- **`route_preview` before spending hosted quota.**
- **Escalate on evidence** (`dropped_out`, empty output, `loop_detected`),
  never on "feels hard".
- **Broadcast narrowly** — one broadcast spends several seats at once.
- **Receipts over re-asks**: `list_receipts`/`get_receipt` recover what a
  provider said instead of asking again.

## Committee pattern (covering blind spots)

Different providers fail differently — that's the value. For a real committee:

```
run_committee(prompt, members from route_preview, dangerous:false)
```

Each member returns independently with a receipt; the bridge never merges them
into false consensus. Use for: safety-architecture review, wiring-doc
verification, PLC logic audits. The committee is **advisory** — decisions with
physical consequences go through the human gate, matching the SQ4D
committee-review principle.

## GitHub layer (work is tracked as a side effect)

Enrolled repos (`config/github-repos.json`) get automatic per-run checkpoint
commits, DEVLOG entries, draft PRs, and bump labels; the repo-side Actions own
assignment, duplicate-work warnings, and real `vX.Y.Z` tags on merge. Tag
prompts with `#issue` and `bump:level`. New repos: `github_onboard_repo` — one
action, full stack, draft PR. Details: `docs/GITHUB-INTEGRATION.md`.

## Claude.ai / Claude Cowork side

Claude in the browser cannot reach `127.0.0.1` directly; the bridge is reached
through the **Claude in Chrome** extension (drive the dashboard) or by asking
Claude Code (which has the MCP registration) to do the bridge work. The
division that works:

- **Claude.ai**: research, long documents, design review, anything needing web
  search or file generation.
- **RelayBridge seats** (via Claude Code / dashboard): repo-local work,
  multi-AI committees, PowerShell, anything that should leave receipts and
  checkpoint commits.
- Hand off with `get_context_bundle` — it's the bounded snapshot designed for
  exactly this.

## Verification (no-spend)

```powershell
npm test                      # includes github-tracker + agent-memory suites
npm run smoke:mcp -- --committee
```

Then the live dry-run: enroll a repo with `"dryRun": true`, run a prompt with
`#<issue> bump:minor`, and read the planned commit/label in the 🐙 GitHub panel
before flipping `dryRun` off.
