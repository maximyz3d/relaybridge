---
name: relaybridge
description: Use RelayBridge to delegate work to other AI CLIs (Claude, Codex, Cursor, Copilot, Gemini, Grok, Perplexity, local Ollama) on subscription seats the user already pays for. Use when a task should be handed to a different model, when work should be matched to a cheap/local vs frontier model, when running many independent subtasks, or when the user mentions RelayBridge, the bridge, delegating, or routing to another AI. Covers the HTTP API, provider selection by task difficulty, run supervision, and reading receipts.
---

# RelayBridge

A local control plane on `http://127.0.0.1:8787` that routes prompts to AI CLIs
installed on this machine. Each call runs the vendor's own CLI against the
user's existing subscription seat, so cost is quota, not metered API billing.

The point of delegating through it: **use the cheapest model that can actually
do the job**, and escalate only on evidence. A definition lookup should not
consume a frontier-model turn, and an architecture review should not be handed
to a 1.5B local model.

## Before anything else

```bash
# The token is created at first boot and lives in the install directory.
TOKEN=$(cat "$LOCALAPPDATA/RelayBridge/.bridge-token")
curl -s -H "X-RelayBridge-Token: $TOKEN" http://127.0.0.1:8787/api/health
```

If that fails, the bridge is not running — start it with
`powershell -ExecutionPolicy Bypass -File "$LOCALAPPDATA\RelayBridge\start.ps1"`.
Every request needs the `X-RelayBridge-Token` header. Never put the token in a
URL, a log line, or a prompt body.

Check what is actually usable before routing:

```bash
curl -s -H "X-RelayBridge-Token: $TOKEN" http://127.0.0.1:8787/api/diag
```

Each provider reports `found` (CLI on PATH) and `ready` (authenticated). A
provider that is `found: true, ready: false` needs a one-time `login` in a
terminal — it will fail every call until then, so route around it rather than
retrying.

## Delegating a task

```bash
curl -s -X POST http://127.0.0.1:8787/api/oneshot \
  -H "X-RelayBridge-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"ollama_coder","prompt":"Explain what this regex matches: ^\\d{3}-\\d{4}$"}'
```

`kind` is the provider key from `cli-config.json`. The response carries
`stdout`, `exitCode`, `stop_reason`, `progress`, and a `receiptId`.

**Do not pass `timeoutMs`.** It is an optional hard ceiling, not a kill clock.
Runs are supervised by progress: a call that keeps producing new content is left
alone to finish, and one that goes silent or starts repeating is stopped early.
Setting `timeoutMs` reinstates a fixed guillotine and will cut off long work.

## Choosing the model — the whole point

Match the model to the difficulty of the task, not to habit. Ask the bridge
rather than guessing:

```bash
curl -s -X POST http://127.0.0.1:8787/api/route \
  -H "X-RelayBridge-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"task":"Refactor the auth middleware and add regression tests"}'
```

It returns a tier, a task tag, and a ranked provider list filtered by what is
actually installed and authenticated. Use the first entry; the rest are the
escalation path.

If routing by hand, this is the ladder:

| Tier | What it looks like | Route to |
|---|---|---|
| **deterministic** | Facts a command can answer: file lists, git status, versions, hashes | `powershell` — no model at all |
| **utility** | Definitions, lookups, spelling, unit conversion, one-line explanations | `ollama_fast` → `ollama_llama` (local, free, instant) |
| **standard** | Normal coding, a bug fix, a bounded review, a focused question | `ollama_coder` → `copilot` → `claude` → `cursor` → `codex` |
| **complex** | Architecture, migrations, cross-module debugging, threat models, long context | `claude` / `claude_fable` → `codex` → `grok` |
| **critical** | Irreversible, high-stakes, or safety/security/legal/financial | Multiple providers for diverse review **plus a human gate** — never auto-execute |
| **research** | Anything needing current web information with citations | `perplexity` → `grok` → `gemini` |

Three rules that matter more than the table:

1. **Start low and escalate on evidence.** Escalate when the cheap model
   actually failed — wrong answer, empty output, `dropped_out: true` — not on a
   hunch that the task "feels hard". A local model handling utility work costs
   nothing and leaves subscription quota for work that needs it.
2. **Escalate immediately when the tier is complex or critical.** Do not burn a
   round trip proving a 1.5B model cannot design a migration.
3. **Never auto-execute destructive or high-stakes work.** Tasks tagged
   `destructive`, `secrets`, `medical`, `legal`, `financial`, or
   `safety_critical` are advisory only: return the recommendation and let the
   human decide.

## Which model *within* the provider

Picking the CLI is only half of it. Claude Code can run Haiku or Opus; Codex can
run Luna or Sol. The routing tier selects the weight class automatically:

| Task tier | Model tier | Claude | Codex | Gemini |
|---|---|---|---|---|
| utility | light | `haiku` | `gpt-5.6-luna` | `gemini-3.5-flash-lite` |
| standard | standard | `sonnet` | `gpt-5.6-terra` | `gemini-3.6-flash` |
| complex / critical | heavy | `opus` | `gpt-5.6-sol` | `auto` |

`POST /api/route` returns `modelTier` and per-provider `model` + `modelArgs`.
`POST /api/oneshot` accepts `taskTier` or `modelTier` and applies the flag
itself — you do not need to build the argument.

```bash
curl -s -X POST http://127.0.0.1:8787/api/oneshot \
  -H "X-RelayBridge-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"claude","taskTier":"utility","prompt":"What does ECONNRESET mean?"}'
```

Two things that keep this from breaking:

- **Cursor, Copilot, Grok and Perplexity send no model flag at all.** Their
  lineups depend on the account and org policy, so the account default applies.
  A missing flag runs; a retired model id fails every call.
- **Model identifiers rot on a weeks-long cycle.** `gpt-5.4` retires 2026-08-31;
  Gemini's Flash line has turned over twice this year. Claude pins use stable
  aliases (`opus`/`sonnet`/`haiku`) for that reason. `/api/route` returns
  `modelConfig.stale` — when it is true, re-verify with the commands in
  `_models.verifyCommands` (`agent models`, `codex --help`, Gemini's `/model`)
  and update `modelsCheckedAt` in `cli-config.json`.

### Finding out what models exist

The bridge probes each CLI at boot and keeps the result, so you can ask what is
actually callable rather than assuming:

```bash
curl -s -H "X-RelayBridge-Token: $TOKEN" http://127.0.0.1:8787/api/models
```

Each provider reports its models with a `tier` and a `bestAt` note. Add
`?refresh=1` (or `POST /api/models/refresh`) to re-probe after installing or
upgrading a CLI.

This is what makes the pins above self-correcting. If a configured model is not
in a provider's own list, it has been retired: the bridge logs a warning, drops
the flag, and lets the account default answer instead of failing the call.
`warnings` in the response names any pin in that state. Providers with no list
command (Copilot, Grok) are left alone rather than second-guessed — only a
positive probe result can veto a pin.

### Seeing what other agents and the dashboard are doing

Every bridge API call is logged with its origin — the dashboard tags as `ui`,
this MCP path tags as `mcp`. Read it before assuming you are the only actor:

```bash
curl -s -H "X-RelayBridge-Token: $TOKEN" "http://127.0.0.1:8787/api/telemetry?limit=50"
```

Over MCP the same picture comes from three read-only tools: `bridge_activity`
(this log), `list_models` (the discovered model registry), and
`list_active_runs` (supervision snapshots for in-flight calls). If
`list_active_runs` shows another client's run in `streaming` or `working`,
leave it alone — do not launch a duplicate of the same task.

## Plan before you delegate: company, model, effort

Routing answers "which CLI". That is not the whole decision. Three things have to
be chosen together, and each one wastes money independently:

- **company** — whose seat pays (or none, for local and deterministic work)
- **model** — which weight class inside that vendor
- **effort** — how hard that model is told to think

Ask for all three at once:

```bash
relaybridge plan "refactor the auth middleware and add regression tests"
```

or over MCP, `plan_task`. Either returns the tier, the chosen company/model/
effort, the exact args, the **cheapest capable alternative**, and fallbacks.

Effort by tier: utility → `low`, standard → `medium`, complex/critical → `high`.
`max` is never automatic; it costs far more for a usually marginal gain.

Providers express effort three different ways, and the plan resolves whichever
applies — do not hand-build these:

| Provider | How effort works |
|---|---|
| Codex | a flag: `--config model_reasoning_effort=high` |
| Cursor | a model variant: `gpt-5.6-sol-low` … `-high` … `-max` |
| Claude, Gemini | no knob — the model choice *is* the effort |

The cost classes the plan reports: `none` (a shell command, no model), `local`
(free, on this machine), `subscription` (a seat you already pay for), `metered`
(billed per call). An unknown transport is treated as metered on purpose, so an
unclassified provider is never quietly preferred over one known to be free.

## Using it from a terminal

The CLI is the third surface, for agents and scripts with no MCP support:

```bash
relaybridge status                 # bridge health + who is signed in
relaybridge plan "<task>"          # company, model, effort
relaybridge ask "<task>"           # plan it, then run it
relaybridge ask --kind claude "…"  # force a provider
relaybridge models --refresh       # what each provider can run, by tier
relaybridge runs                   # live runs: streaming, quiet, looping
relaybridge activity               # recent calls from every client
relaybridge auth                   # who is installed but signed out
relaybridge mcp-config             # MCP JSON for any client
```

`ask` refuses critical-tier tasks unless given `--force`, because those are
advisory-only by policy.

## Reading the result

Check `stop_reason` before trusting `stdout`:

- `null` — the run completed on its own. Normal.
- `loop_detected` — the CLI repeated itself and was stopped to save tokens.
  **Do not resubmit the same prompt**; it will loop again. Narrow the task,
  supply the missing context, or route to a different provider.
- `idle_stall` — the run went silent with no CPU activity. Usually a wedged CLI
  or a hidden interactive prompt. Check `/api/diag` for that provider's auth.
- `hard_cap` — hit the absolute ceiling (45 min default). The task is too big
  for one call; split it.
- `output_cap` — runaway output. Almost always a malformed prompt.

Also check `dropped_out`, plus `rate_limited`, `auth_failed`, and
`budget_exceeded`. A rate-limited provider should be skipped for the rest of the
session, not retried in a loop.

## Watching a long run

A quiet run is not necessarily a stuck run — print-mode CLIs buffer everything
until the end. To tell the difference:

```bash
curl -s -H "X-RelayBridge-Token: $TOKEN" http://127.0.0.1:8787/api/runs/active
```

`assessment` gives a plain-language read, and `phase` is the raw signal:
`streaming` (producing output), `working`, `quiet` (silent — check `cpuMs`, as
CPU advancing means it is thinking), `suspect_loop` (repeating; watch it).
`idleBudgetMs` and `hardCapRemainingMs` say which limit fires next.

## Parallel work

Independent read-only subtasks can run concurrently — the bridge caps
concurrency at 4. Two constraints: never create multiple writers to the same
files, and give each provider a genuinely independent slice. Fan out for
analysis, fan in for the decision.

## More detail

- `reference.md` — full endpoint list, request/response fields, provider table,
  supervision tuning.
- Config lives in `cli-config.json` (providers, supervision) and
  `config/routing-policy.json` (tiers, priorities).
- Every call writes a receipt to `data/receipts/YYYY-MM-DD.jsonl` with hashes,
  duration, and failure class — read those to see what a session actually cost.

## GitHub tracking (enrolled repos)

If the run's working directory is inside a repo enrolled in
`config/github-repos.json`, RelayBridge automatically checkpoints the work
after each successful run: commit → DEVLOG → (opt-in) push → draft PR → bump
label. Associate work by tagging the prompt:

- `#123` / `issue:123` — link the issue (drives assignment + duplicate-work
  warnings via the repo's `claim-on-start.yml`)
- `bump:patch|minor|major` or `version:X.Y.Z` — dictates the PR label that the
  repo's `version-on-merge.yml` turns into a real `vX.Y.Z` tag on merge

MCP tools: `github_repo_activity`, `github_track_run`, `github_list_versions`,
`github_show_version`, `github_checkout_version` (rollback = new branch from a
tag, never a reset), `github_onboard_repo` (provision a new repo in one
action). Full contract: `docs/GITHUB-INTEGRATION.md`. RelayBridge never writes
tags or version numbers — GitHub owns the version.
