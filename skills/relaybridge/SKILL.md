---
name: relaybridge
description: Use RelayBridge to delegate work to other AI CLIs (Claude, Codex, Cursor, Copilot, Gemini, Grok, Perplexity, local Ollama) on subscription seats the user already pays for. Use when a task should be handed to a different model, when work should be matched to a cheap/local vs frontier model, when running many independent subtasks, or when the user mentions RelayBridge, the bridge, delegating, or routing to another AI. Covers the HTTP API, provider selection by task difficulty, run supervision, and reading receipts.
---

# RelayBridge

A local control plane on `http://127.0.0.1:8787` that routes prompts to AI CLIs
configured on this machine. Providers may use a subscription, local inference,
or a metered API. Read the current transport and account evidence; a configured
token budget is not a provider allowance or a billing guarantee.

The point of delegating through it: **use the cheapest model that can actually
do the job**, and escalate only on evidence. A definition lookup should not
consume a frontier-model turn, and an architecture review should not be handed
to a 1.5B local model.

## Before anything else

When connected through MCP, call `get_context_bundle` first, then inspect
`bridge_status`, `list_providers`, and the matching active workflow. Resume its
recorded next action; do not create a duplicate because a prior chat ended.
A version probe proves installation, not authentication, safe execution, or
model availability. Check the separate execution and filesystem-policy gates.

For REST, use the configured `RELAYBRIDGE_URL` and private capability file
(`RELAYBRIDGE_TOKEN_FILE`, or the installed `.bridge-token`). Set `TOKEN` in
the calling process without printing it; never put it in a URL, log, prompt,
or committed file. The examples below use the default loopback URL. If the
bridge is unreachable, diagnose its existing process and configuration before
starting anything. A failed health request is not permission to restart a
shared runtime or replay its tasks.

## Delegating a task

```bash
REQUEST_ID="rest:$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
curl -s -X POST http://127.0.0.1:8787/api/oneshot \
  -H "X-RelayBridge-Token: $TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg requestId "$REQUEST_ID" \
    --arg prompt 'Explain what this regex matches: ^\\d{3}-\\d{4}$' \
    '{kind:"ollama_coder",prompt:$prompt,requestId:$requestId}')"
```

`kind` is the provider key from `cli-config.json`. The response carries
`stdout`, `exitCode`, `stop_reason`, `progress`, and the exact
`requestId`/`invocationId`/`receiptId` correlation tuple. Concurrent raw
callers must generate a unique `requestId` and retain the direct tuple
atomically. Never attribute a detached response by selecting the newest
receipt; find the exact request ID or treat provenance as unknown.

Omit `timeoutMs` for adaptive work; supply it only when an explicit deadline is
intended. Silence and elapsed time do not establish a stall. Honor token/output
budgets and current cited progress assessments. A partial answer cannot establish
a review verdict. A default MCP `pending` result contains a durable `taskId`:
collect `get_task_result` with `id=taskId`, without resubmitting.

For ongoing projects, reuse or register an external coordinator, preserve its
owner token/epoch, and checkpoint after decisions and completed work. Inspect
native quota in `get_context_bundle`; when instructed to yield, stop new work,
settle owned writers, and use `checkpoint_and_yield`. Preserve original provider,
model and writer restrictions. See [continuity](../../docs/CONTINUITY.md).

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

## Model and effort evidence

Use `plan_task` or `POST /api/plan` for the exact `primary.execution` tuple,
and pass that tuple unchanged to the supported execution surface. It binds the
provider, authority mode, resolved model and requested/applied effort to the
current configuration. A changed or unavailable model requires a new plan;
do not drop a rejected model flag and silently accept an account default.

`list_models` / `GET /api/models` distinguish configured entries from observed
catalog evidence. Refresh only when current discovery is needed. A static
model name is not proof the current account can invoke it, and an unavailable
catalog is not an empty subscription allowance.

Read `requestedEffort`, `appliedEffort`, `effortMethod` and
`effortFallbackReason` from the plan. Claude, Codex and Antigravity controls
may differ by installed version. Native Google Gemini CLI is a different
provider from Antigravity; never transfer its model, login, or effort claims
between identities.

## Optional output guidance and references

When a task benefits from a specific output standard, use
`list_output_profiles`, then supply its exact `{id, version, digest}` as
`outputProfile` to `plan_task`, `ask_provider`, `route_preview`, `route_and_ask`,
`run_committee`, `broadcast`, or `submit_task`. Preserve the original request;
the bridge appends the selected criteria and validates the complete prompt.
The Tasks panel exposes the same choice. Omit the selector for ordinary calls.
Do not send both the returned compiled prompt and the selector: that would
append guidance twice. No dedicated CLI profile flag is provided.

`list_workflow_library` lists pinned skill/MCP references and licenses, with
locally authored guidance. Entries marked `available_not_connected` are
references only. Inspect current tools and permissions before proposing a
connection; discovery does not install or execute upstream content.
See [reference.md](reference.md) for the REST fields.

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

The plan records both the desired effort and what the provider can actually
apply. Use the returned execution tuple instead of translating an effort label
into flags yourself. Requested `high` with no supported control remains an
explicit fallback, not an applied setting.

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

On Windows, use stdin or a UTF-8 file for diffs and other prompts that can
exceed the command-line limit:

```powershell
# PowerShell 7 preserves UTF-8 for native pipelines.
git diff --no-ext-diff | relaybridge ask --kind gemini --stdin

# PowerShell 5.1-safe path when the prompt is already in $prompt.
$prompt | Set-Content -Encoding utf8 -NoNewline .\review-prompt.txt
relaybridge plan --prompt-file .\review-prompt.txt
relaybridge ask --kind claude --prompt-file .\review-prompt.txt
```

Both `plan` and `ask` require exactly one prompt source: positional text,
`--stdin`, or `--prompt-file <path>`. The CLI rejects empty, invalid UTF-8,
missing, or conflicting input before making any bridge request, and it never
echoes the prompt into process arguments or error output.

`ask` refuses critical-tier tasks unless given `--force`, because those are
advisory-only by policy.

## Reading the result

Check `stop_reason` before trusting `stdout`:

- `null` — no supervisor stop was recorded. Also check exit status, provider
  terminal evidence, failure flags, and whether the requested artifact is complete.
- `loop_detected` — the CLI repeated itself and was stopped to save tokens.
  **Do not resubmit the same prompt**; it will loop again. Narrow the task,
  supply the missing context, or route to a different provider.
- `idle_stall` — the run went silent with no CPU activity. Usually a wedged CLI
  or a hidden interactive prompt. Check `/api/diag` for that provider's auth.
- `hard_cap` — hit the absolute ceiling (45 min default). The task is too big
  for one call; split it.
- `output_cap` — runaway output. Almost always a malformed prompt.
- `provider_incomplete_response` — the CLI exited cleanly but returned only
  future-work narration. Do not retry the identical prompt on that seat;
  narrow the task or switch providers. The original stdout remains in the
  response and receipt as evidence.

Also check `dropped_out`, plus `rate_limited`, `auth_failed`, and
`budget_exceeded`. A rate-limited provider should be skipped for the rest of the
session, not retried in a loop.

For Antigravity, `policy_reason=headless_command_permission_auto_denied` means
its headless process selected a terminal command whose Ask-mode permission
could not be displayed. Safe one-shots already carry a command-free built-in
file-reading policy. Do not retry the identical request, add a broad persistent
command grant, or switch to `--dangerously-skip-permissions`; narrow the task or
use another grounded provider.

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
concurrency at eight globally and four per provider by default. Two constraints: never create multiple writers to the same
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
`data/github-repos.json` (or `RELAYBRIDGE_GITHUB_REPOS`), RelayBridge automatically checkpoints the work
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
