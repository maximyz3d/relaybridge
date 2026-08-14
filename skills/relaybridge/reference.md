# RelayBridge reference

Base URL `http://127.0.0.1:8787`. Every request needs the header
`X-RelayBridge-Token: <token>`, read from `.bridge-token` in the install
directory (default `%LOCALAPPDATA%\RelayBridge`).

## Endpoints

### `GET /api/health`
Liveness and mode. Returns `ptyMode`, `fullPermissions`, `sessionCount`,
`activeOneShotCount`, `maxActiveOneShots`, `version`. Use it to confirm the
bridge is up before anything else.

### `GET /api/diag`
Per-provider readiness. Each entry has `found` (binary resolves on PATH),
`ready` (probe succeeded, meaning authenticated), and `detail`. Probes are
redacted where the CLI echoes account information.

Route only to providers that are `found && ready`. A `found: true, ready: false`
provider needs a one-time interactive login and will fail every call until then.

### `POST /api/oneshot`
The main delegation call.

| Field | Type | Notes |
|---|---|---|
| `kind` | string | Provider key from `cli-config.json`. Required. |
| `prompt` | string | Required, non-empty. |
| `dangerous` | boolean | Optional. `false` (default) runs the read-only/plan slot. `true` allows the CLI to act agentically — only with explicit human intent. |
| `cwd` | string | Optional working directory, validated against the allow list. |
| `timeoutMs` | number | Optional **hard ceiling only**. Omit it; supervision decides when a run is stuck. |
| `taskTier` | string | Optional. `utility` / `standard` / `complex` / `critical` — selects the model weight class. |
| `modelTier` | string | Optional. `light` / `standard` / `heavy`. Overrides `taskTier`. |

Response:

| Field | Meaning |
|---|---|
| `stdout` / `stderr` | Cleaned output. |
| `exitCode` | Process exit code; `-1` on spawn failure. |
| `stop_reason` | `null` when the run finished by itself, else `idle_stall`, `loop_detected`, `output_cap`, `hard_cap`. |
| `stop_detail` | Human-readable explanation of the stop. |
| `progress` | Snapshot: `bytes`, `lines`, `idleMs`, `repeatPeak`, `cpuMs`, `phase`. |
| `dropped_out` | True when the call did not produce a usable answer. |
| `rate_limited` / `budget_exceeded` / `auth_failed` / `permission_denied` | Failure classification. |
| `model` | The model actually selected, or `null` when the account default applied. |
| `model_tier` | The weight class used. |
| `receiptId` | Points at the persisted receipt. |

### `GET /api/runs/active`
Live supervision state for in-flight calls: `phase`, `assessment`, `idleMs`,
`bytes`, `lines`, `repeatPeak`, `cpuMs`, `idleBudgetMs`, `hardCapRemainingMs`.
This is how you tell a thinking run from a wedged one without killing it.

### `POST /api/install`
Body `{ "kind": "cursor" }`. Runs that provider's configured vendor installer.
Requires user authorization — do not call it unprompted.

### `GET /api/models`
Discovered model registry: per provider, the models it can run, each with a
`tier` (light/standard/heavy) and a `bestAt` note. Includes `warnings` naming
any configured pin the provider no longer offers, and `staleness` for the
config's own verification date. `?refresh=1` re-probes.

### `POST /api/models/refresh`
Forces re-discovery. Run it after installing or upgrading a CLI.

### `POST /api/route`
Body `{ "task": "..." }`. Returns the classification (`tier`, tags), the primary
task tag, and a ranked, readiness-filtered provider list. Prefer this over
hand-picking a provider.

## Providers

| Key | CLI | Cost | Best for |
|---|---|---|---|
| `powershell` | built in | free | Deterministic facts; no model involved |
| `ollama_fast` | Ollama (Qwen 2.5 1.5B) | free, local | Lookups, classification, one-liners |
| `ollama_llama` / `ollama` | Ollama (Llama 3.2 3B / Qwen3 4B) | free, local | Short reasoning, summaries |
| `ollama_coder` | Ollama (Qwen Coder 7B) | free, local | First pass at ordinary coding |
| `copilot` | `@github/copilot` | Copilot quota | Everyday coding, repo-aware |
| `claude` / `claude_fable` | Claude Code | Claude subscription | Complex coding, architecture, long context |
| `cursor` | Cursor `agent` | Cursor subscription | Coding and review at standard tier |
| `codex` | `@openai/codex` | ChatGPT subscription | Complex coding, second opinion |
| `gemini` | Antigravity | Google quota | Vision-adjacent, hardware, general |
| `grok` | Grok CLI | xAI quota | Research, alternative reasoning |
| `perplexity` | `pwm` wrapper | Perplexity account | Current web research with citations |

Local Ollama routes cost nothing and never touch a subscription. Prefer them for
anything at utility tier.

## Supervision

Configured under `_supervisor` in `cli-config.json`; any provider may override
with its own `supervisor` block.

| Key | Default | Meaning |
|---|---|---|
| `idleMs` | 360000 | Silence before a run is suspect. Generous because print-mode CLIs emit nothing until done. |
| `hardCapMs` | 2700000 | Absolute ceiling (45 min). |
| `graceExtensions` | 3 | Idle windows granted when CPU proves work is happening. |
| `loopRepeatThreshold` | 12 | Identical lines before calling it a loop. |
| `noNewContentMs` | 240000 | Output growing with nothing new in it — churn. |
| `maxOutputBytes` | 12582912 | Runaway-output guard. |
| `onUnverifiableIdle` | `kill` | What to do when idle and CPU cannot be sampled. |

Progress is judged on new content, not elapsed time: a run producing new output
is never interrupted, and one repeating itself is stopped well before the
ceiling.

## Receipts

Every provider call appends to `data/receipts/YYYY-MM-DD.jsonl`: `receiptId`,
timestamp, provider, input/output hashes and character counts, `durationMs`,
`failureClass`, and the route. Hashes rather than content, so receipts are safe
to read and share. Use them to audit what a session cost and which providers
actually delivered.

## Constraints

- Never pass secrets, tokens, or credentials in a prompt body — they land in
  receipts hashes and vendor logs.
- `dangerous: true` lets a CLI act on the filesystem. Default to `false`.
- Concurrency is capped at 4 in-flight calls; a fifth is rejected rather than
  queued indefinitely.
- Do not resubmit a prompt that came back `loop_detected` — change the prompt or
  the provider.
