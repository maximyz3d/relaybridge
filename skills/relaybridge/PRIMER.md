# RelayBridge is available on this machine

This block is loaded into every session on purpose. It is deliberately short:
always-loaded context costs tokens on every turn, so it carries only what must
never be forgotten and points at the full reference for everything else.

**What it is.** A local control plane at `http://127.0.0.1:8787` that runs other
AI CLIs on subscription seats already paid for on this machine: Claude Code,
Codex, Cursor Agent, GitHub Copilot, Gemini, Grok, Perplexity, and local Ollama
models. Auth header `X-RelayBridge-Token`, read from `.bridge-token` in the
install directory (`%LOCALAPPDATA%\RelayBridge`).

**Use it when** a task would be better, cheaper, or faster on a different model:
a local model for a lookup, a frontier model for architecture, a second opinion
on a risky change, or independent read-only subtasks in parallel. Delegation is
not a last resort — you are not the only tool available.

**Reachable three ways:** MCP tools (preferred), the `relaybridge` CLI, or raw
HTTP. Use whichever your surface has.

**Ask for a plan before delegating anything non-obvious.** `plan_task` over MCP,
or `relaybridge plan "<task>"`. It returns three decisions together — **company,
model, and effort** — because getting any one wrong costs real money: spending a
frontier seat on a CSS tweak, or max-effort reasoning on arithmetic, or sending
an architecture migration to a 1.5B local model. The plan names the cheapest
capable option and says why.

**Match the model to the task, do not habitually reach for the biggest.**

| Tier | Work | Route to |
|---|---|---|
| deterministic | file lists, git status, versions, hashes | `powershell` — no model at all |
| utility | definitions, lookups, one-line explanations | `ollama_fast` (local, free) |
| standard | ordinary coding, a bug fix, a bounded review | `ollama_coder` → `copilot` → `claude`/`cursor` |
| complex | architecture, migrations, cross-module debugging | `claude` → `codex` → `grok` |
| critical | irreversible, security, legal, financial | several providers **plus a human gate** |
| research | needs current web information with citations | `perplexity` → `grok` → `gemini` |

Ask the bridge rather than guessing: `POST /api/route {"task":"..."}` returns a
tier, a ranked provider list filtered to what is installed and signed in, and
the model tier to use inside each provider.

Effort scales with tier: utility → `low`, standard → `medium`, complex and
critical → `high`. `max` is never automatic — it costs far more for a marginal
gain. Providers express effort as a flag (Codex), a model variant (Cursor), or
the model choice itself (Claude, Gemini). The plan resolves whichever applies —
never invent a flag.

**Four rules that matter more than the table:**

1. **Never send `timeoutMs`.** Runs are supervised by progress, not a clock. A
   call producing new content is left alone to finish; one that goes silent or
   repeats itself is stopped early. Sending `timeoutMs` reinstates a fixed
   guillotine that kills long work mid-task.
2. **Check `stop_reason` before trusting `stdout`.** `loop_detected` means the
   CLI repeated itself and was stopped — do **not** resubmit the same prompt;
   narrow the task or switch providers. `idle_stall` means it wedged.
3. **Escalate on evidence, not on a hunch.** A wrong answer, empty output, or
   `dropped_out: true` justifies a bigger model. "Feels hard" does not.
4. **Never auto-execute destructive or high-stakes work.** Return the
   recommendation and let the human decide.

**If a call returns `409 auth_required`,** that provider is installed but signed
out. Nothing was spent. Tell the user to sign in from the dashboard, or run the
provider's own login command; then retry.

**Full reference:** `SKILL.md` (usage and delegation) and `reference.md` (every
endpoint, provider table, supervision settings) in this same directory. Read
them before doing anything non-obvious with the bridge — they exist so this
block can stay short.

**GitHub tracking.** Runs in an enrolled repo auto-commit, devlog, and label
PRs. Tag prompts `#<issue>` and `bump:patch|minor|major`; merge creates the tag.

**MCP tools.** If the RelayBridge MCP server is registered, prefer its tools
over raw HTTP: `plan_task` (start here), `bridge_status`, `list_providers`,
`route_preview`, `list_models`, `list_active_runs`, `bridge_activity`,
`ask_provider`, `route_and_ask`, `run_committee`. They carry the same guarantees and write
receipts automatically.
