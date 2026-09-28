# Multiple accounts on one bridge

Several subscriptions per provider, a one-call swap between them, and a fan-out
that spends all of them at once.

## Why it works

Every subscription CLI keeps its credentials in a config directory it locates
from an environment variable: Claude Code reads `CLAUDE_CONFIG_DIR`, Codex reads
`CODEX_HOME`, the Copilot CLI reads `COPILOT_HOME`. Point that variable at a
different directory and the same binary runs as a different account, with no
`HOME` swapping and no re-login between calls.

That is the entire mechanism. A provider declares it in `cli-config.json`:

```json
"claude": {
  "credential_env": "CLAUDE_CONFIG_DIR",
  "credential_markers": [".credentials.json"],
  "quota_seat": "subscription:anthropic:default"
}
```

`credential_markers` is how the bridge knows an account has actually been signed
in: a non-empty marker file in the directory it owns. Without one, selection
skips the account instead of burning a dispatch to discover it is not logged in.

A seat that cannot relocate its credentials declares
`linked_accounts_supported: false` with a
`linked_accounts_unavailable_reason`, and keeps exactly one account. The Copilot
CLI is the shipped example: its auto-login can borrow OS or GitHub CLI OAuth from
outside `COPILOT_HOME`, so profile-directory pooling would not be
attribution-safe.

## Identity: one quota seat per account

Each account gets its own `quotaSeat`, derived from the seat's configured one:

| Account | quotaSeat |
|---|---|
| `default` | `subscription:anthropic:default` |
| `work` | `subscription:anthropic:default#work` |
| `personal` | `subscription:anthropic:default#personal` |

`quotaSeat` already means "the authenticated account whose finite allowance these
routes consume", so per-account fuel gauges, per-account cooldowns and load
levelling across accounts all fall out of machinery that already existed. Three
Claude plans read as three seats to drain, not one bar that empties three times
as fast.

The `default` account keeps the base seat verbatim, so existing ledger rows,
budgets and receipts keep matching after a second plan is linked. It also stays
*implicit*: it injects no environment at all and reads the operator's own config
directory, which is why linking a second plan cannot break the sign-in that was
already there.

## Linking a plan

```
POST /api/accounts/claude   { "id": "work", "label": "Work plan" }
```

The response carries the exact command that signs that account in. The bridge
cannot complete an interactive OAuth flow on the operator's behalf:

```
CLAUDE_CONFIG_DIR='/home/you/projects/.rb-wt/.../data/accounts/claude/work' claude /login
```

Run it once. The credential directory is created `0700`, and this module never
reads, copies or logs its contents — it only ever hands the path to a child
process.

`GET /api/accounts` then shows every plan with its own remaining allowance,
whether it is signed in, disabled, cooling or quarantined after an
authentication failure, and how many runs it has in flight.

## One sign-in per provider key

Credential directories are keyed by provider key, not by quota seat. `claude` and
`claude_fable` are two routes onto the same Anthropic login and share the base
`quota_seat`, but each keeps its own account rows and its own credential
directories. Linking `work` to both therefore means signing `work` in twice, once
per key.

That is usually not needed: link the second plan on the key you actually delegate
to, and the sibling key keeps running on the operator's existing sign-in. Do both
only when you want the second account reachable through both routes.

## Swapping

One call covers all three swaps an operator actually makes:

```
POST /api/accounts/swap  { "kind": "claude", "accountId": "work" }   # another plan, same AI
POST /api/accounts/swap  { "kind": "codex" }                          # a different AI
POST /api/accounts/swap  { "kind": "codex", "accountId": "personal" } # both at once
```

Both pins are written in a single atomic registry write, because a half-applied
swap would spend one vendor's allowance while the ledger attributed it to
another's.

- **The account pin is soft.** It is preferred whenever that plan can take work,
  and dispatch falls back to the least-drained usable account when it cannot.
  The swap response says which happened in `readiness.pinHonored`, and a pin can
  never cross a hard filter: a disabled, signed-out, quarantined, cooling or
  quota-blocked plan is not dispatched to no matter what is pinned.
- **The provider pin fills a blank.** A request that names no `kind` runs on the
  pinned provider. A request that names one always wins.
- `accountId: null` returns that seat to automatic selection.
  `setProvider: false` pins the account without changing which AI unqualified
  work goes to.

`GET /api/accounts/active` reports what unqualified work will run on right now,
and whether each seat is `pinned` or `automatic`.

Removing or disabling the pinned account releases the pin in the same write. A
dangling pin would make every strict registry load throw, which disables
dispatch entirely: losing the swap is acceptable, losing the bridge is not. A
registry hand-edited to pin a missing account still fails closed on load, since
quietly billing a different plan than the one named is the exact surprise this
layer exists to prevent.

## Running accounts in parallel

The rate limit a concurrent run competes for belongs to one authenticated login,
not one provider key. Admission is therefore keyed by `(provider, account)`:

| Limit | Default | Meaning |
|---|---|---|
| `maxActivePerAccount` | 4 | concurrent runs on one login |
| per-provider ceiling | 4 x usable accounts | so three plans give twelve slots |
| `maxActiveOneShots` | 8, +4 per linked plan | machine-wide fleet width |
| `oneShotCapacityCeiling` | 32 | absolute stop |

Only accounts the operator **explicitly linked and signed in** widen the fleet, so
a single-account install keeps exactly the width it had before: eight concurrent
calls, four per provider. Two linked plans take it to sixteen. Every limit is
overridable with `RELAYBRIDGE_MAX_ACTIVE_PER_ACCOUNT`,
`RELAYBRIDGE_MAX_ACTIVE_ONESHOTS` and
`RELAYBRIDGE_ONESHOT_CAPACITY_CEILING`.

`/api/health` reports `activeOneShotsByAccount`, the scaled
`maxActiveOneShots`, the `configuredMaxActiveOneShots` it was scaled from, and
`linkedAccountCount`.

## Super fan-out

`POST /api/fanout` spends the cross product:

```
providers  x  accounts per provider  x  (variants or replicas)
```

Where `/api/broadcast` spends one account per provider, this spends every linked
plan in parallel. Three Claude plans and two Codex plans running two variants
each is twenty agents in flight, not five.

```json
{
  "prompt": "Audit this module for unsafe concurrency.",
  "all": true,
  "accounts": "all",
  "variants": ["Cover the read path.", "Cover the write path."]
}
```

| Field | Meaning |
|---|---|
| `providers` / `tag` / `all` | which AIs, resolved exactly as broadcast does |
| `accounts` | `all` (default), `active` (only the pinned plan), `auto` (one agent per provider, least-drained pick), or `{ "claude": ["work","personal"] }` |
| `variants` | up to 16 per-branch assignments appended to the shared brief |
| `replicas` | 1-8 independent samples per account per variant |

Each member is **hard-pinned** to its own account. That pin is what makes the
multiplication real: without it every member would resolve to the same
least-drained plan and quietly serialise behind one allowance.

With no selection at all, the fan-out falls back to the swapped-to seat, so "fan
out" after a swap means "fan out on what I swapped to".

Accounts that cannot take work are reported in `skipped` with a reason rather
than failing the call. Members beyond the fleet width wait for a slot on the same
deadline as any other run. A ceiling of 64 members refuses an unbounded fleet
before anything spawns.

**Fan-out is read-only.** N unleased writers in one tree is the overlap the
delegation contract exists to forbid, so `dangerous: true` is refused rather than
silently downgraded. Fan out discovery and authoring, then apply the results
through a single leased writer (`POST /api/delegate`).

## MCP tools

| Tool | Purpose |
|---|---|
| `list_accounts` | every plan, its allowance, readiness and in-flight runs; plus fleet width |
| `active_seat` | which AI and account unqualified work runs on |
| `swap_account` | the swap verb, all three shapes |
| `link_account` | register a plan and get its exact sign-in command |
| `set_account_enabled` | take a plan out of rotation without signing it out |
| `super_fan_out` | the multiplied fan-out |

## Files

| Path | Contents |
|---|---|
| `<DATA_DIR>/accounts.json` | the registry: accounts, `enabled`, `active` pin, `activeProvider`, quarantine markers |
| `<DATA_DIR>/accounts.initialized` | durable proof that account management was set up, so a deleted registry fails closed instead of reading as a pristine single-account install |
| `<DATA_DIR>/accounts/<kind>/<id>/` | one credential directory per linked account, `0700` |
