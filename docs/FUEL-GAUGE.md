# Fuel gauge, usage ledger, and load levelling

Answers four questions the bridge could not previously answer:

1. **How much is left on each seat?** — the fuel gauge
2. **How fast are we burning it?** — tokens/hour, projected hours to empty
3. **What would this cost on metered pricing?** — shadow cost, while on plans
4. **Which seat should take the next job** so the fleet drains evenly?

## Honesty about what is known

Subscription plans **do not publish a token quota**. So for those seats the
gauge measures against a budget *you configure* in
`config/usage-budgets.json`, and reports `basis: "configured"` — the UI marks
those with `· est`. Getting a budget wrong changes advice, not correctness.

| basis | meaning |
|---|---|
| `configured` | measured against your estimate, not a vendor number |
| `metered` | measured against a real spend cap |
| `unmetered` | local/free seat — nothing to exhaust, always reads full |

Shadow cost uses **list API rates** to answer "what would these tokens have
cost if we were paying per token." It is an order of magnitude, not an invoice:
vendors change prices and a CLI may quietly use a different model than
requested.

## What gets recorded

Every run exits through `sendOneShotResult`, so one hook catches CLI, local
Ollama, and hosted adapters alike. Rows are append-only JSONL in
`data/usage/usage-YYYY-MM-DD.jsonl` — a crash cannot corrupt history, and a
malformed line is skipped rather than breaking the gauge.

Per run: seat, model, cost class, input/output tokens, elapsed ms, ok/failed,
failure kind, task id, and computed `costUsd`.

## Levelling

Two goals, in priority order:

**1. Don't spend depth you don't need.** A trivial lookup on a frontier seat is
waste that compounds — it drains the seat you'll want for something hard.
`suggestTierAdjustment` downgrades **one step only**, never below `utility`,
and **never** for `critical` or high-stakes work or an explicitly requested
seat. A wrong answer on critical work costs far more than the tokens saved.

**2. Drain seats evenly.** One seat hitting a wall while others sit at 90%
means work stops while capacity exists. `levelCandidates` re-ranks seats the
router already judged capable — it never widens the candidate set and never
overrides capability. Stress is **squared** so a small fuel difference (90% vs
85%) leaves router order intact while a genuinely drained seat (8% vs 95%)
falls behind.

Local seats carry **zero** stress penalty and sort forward: using them is how
metered seats get saved.

`fleetBalance` reports the spread between freshest and most-drained metered
seat — the single number that says whether levelling is working. Over 20
points, it names which seat to shift away from.

Normal `/api/plan` and `/api/route` calls apply the durable cooldown state
before candidate selection and then apply fuel levelling to the capable
providers that remain. An explicitly preferred provider is never filtered.
The response includes `fleetState` and per-provider `loadLevelling` evidence
so the changed order is visible rather than implicit.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/usage/gauges?windowMs=` | Per-seat gauges + fleet balance + totals |
| GET | `/api/usage/totals?windowMs=` | Tokens, runs, shadow vs metered cost |
| POST | `/api/usage/advise` | Re-rank candidates + tier-downgrade advice |
| POST | `/api/plan` | Fleet-aware primary provider and model plan |
| POST | `/api/route` | Fleet-aware ranked provider candidates |

MCP: `usage_gauges`, `usage_totals`, `usage_advise` — all reads, so they stay
available through the connector's safe profile. Knowing how much fuel is left
is exactly what a remote surface needs to decide whether to delegate at all.

Dashboard: **⛽ Fuel** — per-seat bars, burn rate, time-to-empty, per-model
breakdown, plan value vs metered spend, and a fleet-balance banner.

## Tuning budgets

Start from observed usage: run a normal day, open ⛽ Fuel, and set
`tokensPerDay` to roughly double what a comfortable day consumed. Too low and
the leveller downgrades work it shouldn't; too high and it won't protect a seat
before it hits a real wall.

## Provider cooldown (issue #17)

A readiness probe proves **authentication, not usable quota**. Before this, a
seat that returned a subscription 429 still reported ready, so routing kept
sending it work that could not succeed — unless every caller remembered an
out-of-band "don't use that seat right now" rule.

`lib/provider-cooldown.js` makes that state first-class:

- **Durable** — survives a bridge restart; a corrupt file resets loudly rather
  than blocking startup.
- **Shared** — Claude Code, Cowork and the dashboard schedule against one picture.
- **Explained** — `/api/cooldowns` and the `provider_cooldowns` MCP tool report
  the seat, the reason, time remaining, and whether the window came from the
  provider's `Retry-After` or our backoff.

Rules:

| | |
|---|---|
| What cools a seat | `rate_limited`, `overloaded` — **only** quota classes |
| What does not | auth failures, missing binaries, bad prompts, internal timeouts |
| Window | provider `Retry-After` when sent, else backoff 5m → 15m → 1h → 4h |
| Overload | 60s — transient, not a quota wall |
| Repeat offences | escalate; reset after 6 quiet hours |
| Concurrent 429s | never shorten an existing longer window |
| Success | clears the cooldown, keeps the offence count so a flapping seat still escalates |
| Explicit request | **never silently withheld** — reported as cooling and left in |

`Retry-After` is read from a header, an HTTP date, or CLI prose
("try again in 5 minutes"). A value already in the past is ignored.

When every candidate is cooling, the response says `allCooling: true` — so it
is not mistaken for "no capable provider," which would send someone chasing a
config problem that does not exist.

## Workspace grounding (issue #16)

An audit task — "inspect the git diff in this cwd and report findings" — was
routed to `ollama_coder`, which talks over local HTTP and has **no filesystem
access**. It could not see the workspace, so it invented one: a confident patch
for two files that do not exist. Exit 0, no errors, 416 tokens, receipt
recorded as a **successful call**.

Silent, confident, recorded as success — the worst shape a failure can take. A
crash would have been better, because a crash gets noticed.

The defect is routing, not the model: asked to read files it cannot see, a
model can only refuse or guess, and models lean toward being helpful.

**Two layers**, because neither alone suffices:

1. **Pre-dispatch gate.** `checkGrounding()` blocks a workspace task on a
   non-grounded seat before any tokens are spent, and says what to do instead.
   Grounding is inferred from the adapter: `local:*`, `hosted:*`, `api:*` reach
   the model over HTTP and cannot read files; `subscription:*` CLIs run in the
   working directory. An unknown adapter is assumed grounded — a false "cannot
   read" would block legitimate work.
2. **Post-hoc verification.** A grounded seat can still hallucinate.
   `verifyReferencedPaths()` extracts file citations from the answer and checks
   them against the workspace, annotating the payload with
   `grounding_warning` when they are absent.

| confidence | meaning |
|---|---|
| `ok` | cited paths exist |
| `partial` | some new paths — a legitimate proposal is not fabrication |
| `suspect` | most cited paths are absent |
| `likely-fabricated` | **every** cited path is absent |

Inline work (`review this code: …`) is never blocked — local seats must stay
useful for what they are best at. A `cwd` alone does not make a task
workspace-bound. `groundingOverride: true` allows an ungrounded opinion
deliberately, and flags the answer as unverified.
