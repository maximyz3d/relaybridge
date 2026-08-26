# RelayBridge — delegation guide for Codex

RelayBridge is a local control plane at `http://127.0.0.1:8787` that routes
prompts to AI CLIs installed on this machine, running each against the user's
existing subscription seat. Use it to hand work to a different model, and to
match the model to the difficulty of the task.

Full detail: `SKILL.md` and `reference.md` in this directory.

## Auth

Every request needs `X-RelayBridge-Token`, read from `.bridge-token` in the
install directory (`%LOCALAPPDATA%\RelayBridge`). Never put the token in a URL,
a log, or a prompt body.

Confirm the bridge is up with `GET /api/health` before routing anything.

## Delegating

`POST /api/oneshot` with
`{"kind":"<provider>","prompt":"<text>","requestId":"rest:<unique-uuid>"}`.
For concurrent raw calls, generate a different request ID per call and retain
the direct response's `requestId`/`invocationId`/`receiptId` tuple. Never infer
ownership from the newest receipt after a shell detaches.

**Do not send `timeoutMs`.** It is an optional hard ceiling, not a kill clock.
Runs are supervised by progress — a call producing new content is left alone to
finish; one that goes silent or repeats itself is stopped early. Sending
`timeoutMs` reinstates a fixed guillotine that cuts off long work mid-task.

## Which model for which task

Ask the bridge: `POST /api/route` with `{"task":"<description>"}` returns a
tier, a task tag, and a ranked provider list filtered to what is installed and
authenticated. Take the first entry; the rest are the escalation path.

Routing by hand:

- **Deterministic** (file lists, git status, versions, hashes) → `powershell`.
  No model at all. A command that returns the exact answer beats any model.
- **Utility** (definitions, lookups, conversions, one-line explanations) →
  `ollama_fast`, then `ollama_llama`. Local, free, instant.
- **Standard** (ordinary coding, a bug fix, a bounded review) → `ollama_coder`,
  then `copilot`, then `claude` / `cursor` / `codex`.
- **Complex** (architecture, migrations, cross-module debugging, threat models,
  long context) → `claude` / `claude_fable`, then `codex`, then `grok`. Go
  straight here; do not waste a round trip proving a 7B model cannot do it.
- **Critical** (irreversible, security, legal, financial, safety) → several
  providers for diverse review, and a human gate. Never auto-execute.
- **Research** (needs current web information with citations) → `perplexity`,
  then `grok`, then `gemini`.

Escalate on evidence — a wrong answer, empty output, or `dropped_out: true` —
not on a hunch that a task feels hard. Local routes cost nothing and preserve
subscription quota for work that needs it.

## Which model *within* the provider

Picking the CLI is only half of it. Claude Code can run Haiku or Opus; Codex can
run Luna or Sol. The routing tier selects the weight class automatically:

| Task tier | Model tier | Claude | Codex | Gemini |
|---|---|---|---|---|
| utility | light | `haiku` | `gpt-5.6-luna` | `gemini-3.5-flash-low` |
| standard | standard | `sonnet` | `gpt-5.6-terra` | `gemini-3.6-flash-medium` |
| complex / critical | heavy | `opus` | `gpt-5.6-sol` | `gemini-3.1-pro-high` |

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

## Reading the result

Check `stop_reason` before trusting `stdout`:

- `null` — finished normally.
- `loop_detected` — the CLI repeated itself and was stopped to save tokens.
  **Do not resubmit the same prompt.** Narrow the task, add the missing
  context, or switch providers.
- `idle_stall` — went silent with no CPU activity; usually a wedged CLI or a
  hidden interactive prompt. Check `/api/diag` for that provider's auth state.
- `hard_cap` — hit the 45 minute ceiling. Split the task.
- `output_cap` — runaway output, almost always a malformed prompt.

Also honor `rate_limited` (skip that provider for the session, do not retry),
`auth_failed` (needs an interactive login), and `dropped_out`.

For a long-running call, `GET /api/runs/active` shows whether it is `streaming`,
`quiet` (check `cpuMs` — CPU advancing means it is thinking, not stuck), or
`suspect_loop`, plus which limit fires next.

## Constraints

- `dangerous: true` lets a CLI act on the filesystem. Default to `false`.
- Never pass secrets or credentials in a prompt body.
- Concurrency is capped at 4 in-flight calls.
- Parallelize only independent read-only subtasks; never create two writers to
  the same files.
