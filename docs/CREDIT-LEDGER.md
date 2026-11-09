# Credit spend ledger

A schema v2 owner permit adds a local spend ledger to the owner-authorized
credit routes: `authorized_prepaid` (OpenAI, read-only API agent) and
`authorized_promotional` (Claude, read-only API agent). v1 permits are unchanged
and have no ledger. `included_api_credit` is not affected and stays blocked
until a provider confirms grant-only funding.

## Flow

1. The owner issues a v2 permit (below). The server re-reads it on every
   verify; a missing, expired, revoked, malformed or credential-mismatched
   permit dispatches nothing.
2. Before each provider request the dispatcher reserves the worst-case cost of
   that turn in `<data-dir>/credit-ledger/`. If `spent + held + estimate`
   exceeds `ledger.budgetCents` the turn is not sent and the run stops.
3. After the response the reservation is settled to the actual charge computed
   from the reported usage. A provider funding error (`funding_exhausted`,
   `account_credit_low`, `spend_limit`, `funding_ambiguous`) marks the ledger
   exhausted; no further turn is reserved.
4. A request whose outcome is unknown (the fetch threw) is charged at its full
   reservation and is never re-sent.
5. Each settled or held turn appends a line to `credit-ledger/receipts.jsonl`
   (provider, organization, scope, authorization id and hash, request key,
   model, reserved and charged cents, usage, disposition, spent and remaining
   cents). Receipts hold no credential, header, prompt or response text.

The estimate is `ceil((requestBytes * max(input, cacheWrite) + maxOutputTokens
* output) / 1e6)` cents using the owner-declared per-model rates.

## Pessimistic OpenAI cached-token charging

OpenAI reports cached input tokens as a subset of input tokens. The ledger
charges them at both the input rate and the cache-read rate, so spend is never
under-counted. Real cost can be lower.

## v2 permit fields

All v1 fields plus a closed `ledger` object:

- `budgetCents`: spendable amount, excluding the reserve. Must fit within the
  smaller of the observed balance (promotional balance for Claude) and the
  provider cap.
- `reserveCents`: held back and never spent by the ledger.
- `pricing`: for every permitted model, `inputCentsPerMTok`,
  `outputCentsPerMTok`, `cacheWriteCentsPerMTok`, `cacheReadCentsPerMTok`.

v2 windows are bounded (see `MAX_WINDOW_MS_V2` in the authorization modules).
The permit must end before the credit expiry and before the next provider
monthly reset. Pricing is owner-declared and not verified against the provider.

## Issuing a permit (owner-run)

```
node scripts/issue-credit-permit.js --provider openai|claude \
  --data-dir <dir> --key-file <path> [--replace]
```

The script prompts for the values you observed in the provider console,
computes `credentialHmac` from the key file without printing the key, validates
with the module's own `validateAuthorization`, and writes the permit mode 0600
atomically. It refuses to overwrite an unexpired permit unless `--replace` is
given. It makes no network calls and is not reachable from the server, CLI or
MCP. Revoke by setting `revokedAt` or deleting the file.

## Unified Claude fallback

A unified run may list a Claude API entry with
`fundingRoute: "authorized_promotional"`. It is chosen only when every listed
native seat is positively exhausted (fresh, finite, at or below 0%), requires a
v2 permit (a v1 permit gives `promotional_unified_unsupported`), never releases
the subscription reserve, re-proves exhaustion at admission, and the run returns
to the subscription at the next segment boundary after verified recovery.

## Status

`relaybridge credit --json` and the credit status endpoint show, for a v2
permit, `ledger` (limits) and `ledgerSpend` (spent, held, exhausted, turns).
Each provider reports `providerConfirmedGrantEvidence: { state: "unavailable",
missing: [...] }`:

- OpenAI: no supported API exposes per-request funding source or the remaining
  credit-grant balance for a project key; Admin cost reports are post-hoc and do
  not separate grant from purchased funds.
- Anthropic: no supported API exposes promotional versus purchased balance or
  per-request funding source; Admin usage and cost reports are post-hoc.

## Not covered

- Interactive Claude Code and Codex CLI API-key usage are not funded by the
  included grants and are not tracked by this ledger.
- Spend by other clients, dashboard changes and provider-side cap lag are not
  seen. The ledger is a local bound, not billing isolation.
- Subscription routes are unchanged. No purchase, reload or renewal is made.
