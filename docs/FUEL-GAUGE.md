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

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/usage/gauges?windowMs=` | Per-seat gauges + fleet balance + totals |
| GET | `/api/usage/totals?windowMs=` | Tokens, runs, shadow vs metered cost |
| POST | `/api/usage/advise` | Re-rank candidates + tier-downgrade advice |

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
