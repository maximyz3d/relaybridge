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

RelayBridge is the durable layer, and every Claude surface is a thin client
over it. Claude's own storage is per-surface; task state is yours, on your
disk, reachable from all of them.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tasks` | Submit `{kind, prompt, collab?, title?, cwd?, user?, source?}` → task record |
| GET | `/api/tasks` | List (filters: `collab`, `status`, `limit`) + queue stats |
| GET | `/api/tasks/:id` | One task with full result, exit code, route, usage |
| POST | `/api/tasks/:id/cancel` | Cancel |

MCP tools: `submit_task`, `get_task`, `list_tasks`, `cancel_task` — available
over stdio *and* through the connector's safe profile, because bounded
delegation is exactly what remote access is for.

## Status model

`queued → running → done | failed | cancelled | interrupted`

**`interrupted`** matters: a task that was in flight when the bridge restarted
is reconciled to this state at startup. It is never left claiming to run, which
would strand a poller waiting for a result that can no longer arrive. Resubmit
those.

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
