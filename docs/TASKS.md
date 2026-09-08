# Background tasks — start anywhere, collect anywhere

`/api/oneshot` holds the HTTP connection until the provider finishes. That's
fine for a quick question and wrong for real work: close the tab, drop the
tunnel, or end the chat session, and the result is gone.

Tasks decouple **submission** from **collection**. Submit returns an id
immediately; the run continues in the background; the result is durable on disk
for any surface to fetch later.

## The workflow this exists for

| | |
|---|---|
| Submit from a Chat session (via Chrome) | `POST /api/tasks` → `{id}` |
| …close the laptop | run continues on the bridge |
| Collect from Cowork, the CLI, or your phone | `GET /api/tasks/<id>` |

RelayBridge stores task state independently of the client that submitted it.
Authenticated clients can collect that state from another surface.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tasks` | Submit `{kind, prompt, collab?, title?, cwd?, user?, source?}` → task record |
| GET | `/api/tasks` | List (filters: `collab`, `status`, `limit`) + queue stats |
| GET | `/api/tasks/:id` | One task with full result, exit code, route, usage |
| POST | `/api/tasks/:id/cancel` | Cancel |
| GET | `/api/tasks/:id/result` | Sanitized pending/result projection for explicit queued delivery |
| POST | `/api/tasks/:id/result/ack` | Acknowledge exact `{receiptStoreId, sha256}` bytes |

MCP tools: `submit_task`, `get_task`, `list_tasks`, `cancel_task` — available
over stdio *and* through the connector's safe profile, because bounded
delegation is exactly what remote access is for.

## Explicit result delivery

Use `submit_task` or `POST /api/tasks` with `deliveryMode:"queued"` and a
caller-generated `taskId` matching `t_[A-Za-z0-9_]{1,120}`. For example:

```json
{"deliveryMode":"queued","taskId":"t_example_unique_20260908","kind":"codex","prompt":"Review the local change.","cwd":"/path/to/checkout"}
```

The server returns HTTP 202 with a pending handle before provider completion.
The provider request ID is exactly `queued:<taskId>`; an explicit different
request/attempt identity is rejected before invocation. Submission binds the
validated workspace, full prompt and execution controls. Oversize prompts are
rejected, never truncated. Repeating the same submitted intent and ID returns
the existing record without replay. Changed intent conflicts. Resolved config,
workspace and source fields participate in that comparison, so after a config
change or a switch of surfaces use collection rather than repeating submission.

`get_task_result({id})` reads the exact task with no dispatch, acknowledgement
or write. A recovered result includes sanitized text, its SHA-256 and UTF-8 byte
count, request/invocation/attempt identifiers, and provider run/receipt references
when available. Completion, partial output and observed provider completion are
separate fields; unsupported terminal metadata stays unknown. Cancelled and
interrupted tasks never install a late answer. Missing/corrupt/uncorrelated
results are unavailable, never a successful empty answer.

Recognized credentials are redacted before the 200,000-byte result bound. Text
over that bound, or over the redactor's input limit, is unavailable; a prefix is
never presented as the full answer. This is recognized-secret sanitization of
the adapter's semantic text, not a guarantee that arbitrary text adapters never
emit tool narration or an unknown secret. Structured stderr, prompts and raw
transport are excluded from this projection.

After collecting, `ack_task_result({id,receiptStoreId,sha256})` records delivery
of those exact sanitized bytes. It is idempotent and conveys no answer approval,
writer release or execution permission. Read and acknowledgement remain usable
when unknown execution reservations block new submissions.

These records use the existing write-then-rename task store. This does not claim
fsync-qualified power-loss durability, a delivery-event receipt journal, or
exactly-once client consumption. Direct `ask_provider`/`/api/oneshot` callers do
not automatically gain this protocol; issue #104 retains those acceptance gaps.

## Status model

`queued → running → done | failed | cancelled | interrupted`

**`interrupted`** matters: a task that was in flight when the bridge restarted
is reconciled to this state at startup. It is never left claiming to run, which
would strand a poller waiting for a result that can no longer arrive. Inspect
the exact execution and ownership evidence before any replacement is considered.
Never automatically replay an interrupted or uncertain writer. An empty activity
list, old timestamp, or missing process is not trusted termination proof.

## Threads

Pass `collab: "c_..."` and the result is appended to that collab's transcript
when the task settles. That gives a shared thread any surface can read — the
piece that makes "continue the conversation from anywhere" work.

## Limits and guarantees

- Concurrency capped (`RELAYBRIDGE_MAX_TASKS`, default 3); the rest queue.
- Results capped at ~200KB, prompts at 100KB — a runaway CLI cannot fill the disk.
- Every state change is written before it is announced, via write-then-rename,
  so a crash mid-write cannot leave a half-parsed task.
- Task ids are validated against a strict pattern; a crafted id cannot escape
  the tasks directory.
- Cancelling a *running* task marks it and stops the result being recorded. It
  does not claim to have killed the provider process — that child belongs to
  the run supervisor.

## Verify

```powershell
$t = (Get-Content "$env:LOCALAPPDATA\RelayBridge\.bridge-token" -Raw).Trim()
$h = @{ "X-RelayBridge-Token" = $t; "Content-Type" = "application/json" }
$id = (Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/tasks -Headers $h `
        -Body '{"kind":"ollama_fast","prompt":"reply with exactly: TASK_OK"}').id
Start-Sleep 20
(Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/tasks/$id" -Headers $h) | Select status, result
```
