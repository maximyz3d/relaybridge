# Included API credits and the 2% reserve

Organization/project selection and explicit subscription fallback are documented in
[ACCOUNT-ROUTING.md](ACCOUNT-ROUTING.md). Use `relaybridge profiles` or MCP profile tools.
Included API execution remains blocked until grant-only spending is enforceable;
no keys, purchased funds, billing changes, or automatic 2% switching are enabled.
The one exception is the explicit, supervised
[owner-authorized prepaid](#owner-authorized-prepaid-openai-only) route for a
single OpenAI profile, and the separate supervised
[owner-authorized promotional](#owner-authorized-promotional-claude-only) route
for a single Claude profile. Neither changes `included_api_credit` or claims
grant-only funding.


**Automatic switching is not active in this build.** The bridge records the
requested policy, exposes readiness, and rejects unqualified credit routes.
There is no qualified provider-enforced grant-only funding adapter. Saving an
API key or linking an organization does not remove this blocker. Existing
subscription admission and continuity settings remain unchanged.

## Requested order

1. Use the provider's subscription while its applicable native quota windows
   have more than 2% remaining.
2. At or below 2%, checkpoint and use only the linked organization's included
   monthly API grant, once that funding path can be enforced.
3. After provider-verified included-credit exhaustion, use the remaining native
   subscription reserve if still available.
4. Stop when both are exhausted. Never buy credits, enable auto-reload, consume
   purchased funds, or spill to an invoice.

This is a subscription quota percentage, not the conversation context window
or a local estimate of tokens. Use fresh account/model-bound vendor evidence.
Switching requires a safe checkpoint and physical settlement of the previous
writer. It cannot migrate the current chat's hidden state or change its billing.
The final reserve is not a fresh monthly allocation. Reset/expiry/account
changes require new evidence; generic 429s do not prove grant exhaustion.

## Inspect without spending

```bash
relaybridge credit
relaybridge credit --json
relaybridge credit setup claude
relaybridge credit setup openai
```

`setup` only prints instructions and works offline. It does not open a browser,
request a key, alter billing or invoke a model. Authenticated REST clients use
`GET /api/allocated-credit`; MCP clients use `allocated_credit_status`.
`mode: readiness_only`, `automationAvailable: false`, and
`dispatchAllowed: false` are intentional. The preference below is not an enable
switch; API dispatch stays blocked in every mode.

## Preferences and Codex options

**Auto is the default preference; automatic switching is still unavailable.**
View settings with `relaybridge options`, or choose explicitly:

```bash
relaybridge credit mode auto
relaybridge credit mode off
relaybridge credit mode manual subscription
relaybridge credit mode manual included_api_credit
```

| Preference | Effective credit route in this build |
|---|---|
| Auto (default) | Subscription only; automatic switching unavailable |
| Off | Credit fallback disabled |
| Manual / subscription | Subscription only |
| Manual / included API credit | Blocked: grant-only funding unverified |

These settings do not change ordinary subscription admission, existing jobs,
quota observations or `usageProtection`. Manual API does not relabel ordinary
subscription work as API-funded. No mode reserves the final 2% today.

The status returns `preference` separately from `effective`. Preferences persist
privately in `DATA_DIR/allocated-credit/preference.json`. Missing state defaults
to Auto; invalid, oversized or symlinked state selects Off with
`source: invalid_store` until an explicit setting repairs it. Failed writes
leave the in-memory preference unchanged. The server accepts only `mode` and
optional `manualTarget`; clients cannot assert funding eligibility or timestamps.

Authenticated `PUT /api/settings/allocated-credit` accepts, for example,
`{"mode":"auto"}` or `{"mode":"manual","manualTarget":"subscription"}`
and returns the full readiness status. Manual requires a target; Auto/Off take
no target (or null). MCP uses `set_allocated_credit_mode` with the same fields
and requires a matching bridge build/store identity. `get_context_bundle`
includes a compact preference/effective summary for the next AI.

Run `./install-skill.sh` (Windows: `./install-skill.ps1`) and start a fresh Codex
session. Type `/` and select `/prompts:relaybridge`, or use `/skills` →
relaybridge. There is no registered bare `/relaybridge` command. Examples:

```text
/prompts:relaybridge
/prompts:relaybridge credit off
/prompts:relaybridge credit auto
/prompts:relaybridge credit manual subscription
```

The default entry only shows options. The prompt runs fixed commands for exact
listed selections and rejects other arguments. Installers respect `CODEX_HOME`
for the Codex skill and prompt; the shared skill also lives in `~/.agents/skills`.
The compatibility prompt uses Codex's [custom prompts](https://developers.openai.com/codex/custom-prompts)
feature; the [skill](https://developers.openai.com/codex/skills) is the maintained
discovery path if a client no longer supports custom prompts.

The reserved kinds `claude_credit` and `openai_responses_credit`, and entries
or requests declaring `funding_route: allocated_api_credit` or
`billing_mode: allocated_credit_only`, fail before one-shot/session execution.
One-shot rejection retains the normal zero-invocation receipt. These guards
are not a general firewall for arbitrary user-authored shell commands or
other independently configured paid providers.

## Provider eligibility (verified 2026-10-30)

Claude Max 20x offers $200/month; other tiers have different allocations.
The grant belongs to the linked Console organization, is shared by that
organization, and expires on its credit schedule. Independently run API-key
`claude -p` and Agent SDK calls are eligible. Cowork and interactive Claude Code
extra usage are separate billing products. See the
[Claude subscriber FAQ](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)
and [API-credit terms](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).

OpenAI allocations depend on the eligible plan; do not assume $200. The benefit
covers eligible API work, but explicitly excludes **Codex usage through API
keys**. Re-authenticating the Codex CLI with an API key is not a valid grant
fallback. A separate eligible API agent with explicit tool/workspace semantics
would be required; no such agent is implemented here. See
[ChatGPT API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits).

Both providers can consume other funding after included credits. Auto-reload,
purchased balances and invoicing must not be confused with included grants.
A local dollar cap, estimated usage ledger or generic insufficient-credit
error cannot prove that only the grant was consumed. OpenAI also documents
possible enforcement delay for [spend limits](https://developers.openai.com/api/docs/guides/spend-limits).

## Obtain and protect a key

For Claude, sign into [Console API keys](https://platform.claude.com/settings/keys)
yourself, select the organization linked in the subscription's API-credits
panel, and create an appropriately restricted key. The subscription screenshot
is not a key. See [Anthropic's key instructions](https://platform.claude.com/docs/en/get-api-key).
For OpenAI, link the eligible organization first, then use its
[API keys page](https://platform.openai.com/api-keys).

Do not paste a key into an AI chat, command argument, task prompt or repository.
Use a private secret store, or a file owned by the current user with mode 0600
inside a directory with mode 0700. Keep keys out of shell history and logs.
Do not put a grant key in ordinary `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for
subscription CLI runs: that can change their billing.

The dedicated names `RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY` and
`RELAYBRIDGE_OPENAI_CREDIT_API_KEY` are reserved for a future qualified adapter.
This build reports only their presence in the bridge environment and strips
them, case-insensitively, from provider child environments. It does not read
secret files or load those variables into a billing route. A saved key file is
therefore not automatically detected or used. Do not export keys just to make
the readiness display green: dispatch will remain blocked.

## Requirements before a future implementation may activate

Obtain provider-authoritative, fresh, organization-bound funding enforcement
that cannot spill beyond the included grant, including concurrent organization
usage. Verify account/key identity, credit period/expiry, included balance,
absence of purchased funding, disabled auto-reload and no invoiced spillover.
Do not accept a manually written JSON assertion as grant-only authority.

Then implement and independently review an eligible transport, exact identity
and receipt binding, checkpoint transfer, single-writer settlement, and durable
exhaustion state. Scope that state to organization, key/account and credit
period; stale/corrupt/mismatched evidence must fail closed. Only an exact
provider exhaustion result with matching funding evidence may release the
native reserve. Preserve existing provider restrictions and review gates.

No current status endpoint, CLI flag or config field satisfies these
requirements. Do not silently enable an API route to finish a task.

## Owner-authorized prepaid (OpenAI only)

The owner may authorize prepaid OpenAI credit for **one** OpenAI funding
profile, outside RelayBridge, with a short-lived private permit. It is a
separate explicit route, `authorized_prepaid`; `included_api_credit` stays
grant-only and blocked, and the permit never changes it. Claude profiles are
refused with `prepaid_provider_unsupported`. Only the read-only Responses agent
runs (`dangerous: true` is `api_agent_read_only`), only for one-shots;
unified runs never select it and it never releases the 2% reserve.

The permit is the file `prepaid-authorization.json` in the bridge data
directory (`RELAYBRIDGE_DATA_DIR`). The path is fixed. No HTTP, MCP, CLI,
setting or environment variable can write it, move it or renew it. It must be a
regular file, mode `0600`, owned by the bridge user, not a symlink or hard
link, and at most 16 KiB. Every request and every agent turn re-reads and
re-verifies it.

```json
{ "schemaVersion": 1, "authorizationId": "pa_2026_11_10_a",
  "policy": "owner_authorized_prepaid", "provider": "openai", "surface": "openai_responses_agent",
  "supervised": true, "noPurchases": true,
  "profileId": "<profile id>", "profileRevision": 1, "organization": "<org ref>", "project": "<project ref>",
  "credentialHmac": "hmac-sha256:<64 hex>", "models": ["gpt-5"],
  "issuedAt": "2026-11-10T09:00:00.000Z", "expiresAt": "2026-11-10T21:00:00.000Z", "revokedAt": null,
  "providerControls": { "autoReload": "off", "hardLimitCents": 12000, "hardLimitScope": "organization",
    "hardLimitEnforced": true, "observedAt": "2026-11-10T08:50:00.000Z" },
  "balance": { "observedBalanceCents": 20100, "observedAt": "2026-11-10T08:50:00.000Z",
    "earliestCreditExpiry": "2027-10-01" } }
```

Rules (any failure is `prepaid_authorization_invalid`): no extra or missing
keys; `models` lists 1–16 OpenAI API models; the window is at most 24 hours,
ends before the earliest credit expiry date and before the next UTC month (the
monthly cap reset); both observations are at most 12 hours before `issuedAt`;
auto-reload is off and the hard limit is enforced; and the hard limit is at
most 80% of the observed balance. The profile id, revision, organization and
project must match the selected profile (`prepaid_scope_mismatch`), the
credential must match `credentialHmac` (`prepaid_credential_mismatch`), and a
model outside `models` is `prepaid_model_not_permitted`.

`credentialHmac` is HMAC-SHA256, keyed by `authorizationId`, over the key in
`RELAYBRIDGE_OPENAI_CREDIT_API_KEY`. Compute it in the bridge environment
without printing the key:

```bash
node -e 'console.log(require("./lib/prepaid-authorization").credentialHmac(process.argv[1], process.env.RELAYBRIDGE_OPENAI_CREDIT_API_KEY))' pa_2026_11_10_a
```

Write the file with `umask 077`, then `chmod 600`. Check it with
`GET /api/allocated-credit`: `prepaidAuthorization.state` is `valid` or
`blocked` with a reason, and `apiTransport` is
`owner_authorized_prepaid_supervised` only while it is valid. Status output
never contains the key, the HMAC or the credential fingerprint.

Revoke by deleting the file or setting `revokedAt`; an edit, deletion, revocation
or expiry stops a running agent before its next turn (`funding_decision_changed`,
turn `not_sent`). Renewal is manual: a new file with a new `authorizationId`,
fresh observations and a new HMAC. A resume needs the byte-identical permit, and
a linked attempt never crosses to a new `authorizationId`.

Limitations, recorded in every receipt as `route.funding.limitations`:

- The provider hard cap is the only spending backstop. Provider cutoff can lag
  and overshoot it. With a $201 balance and a $120 cap, the $81 difference is a
  nominal cushion, not a guaranteed reserve, and there is no absolute bound on
  the balance spent.
- There is no local spend ledger or accounting; RelayBridge counts no dollars.
- Spend by other clients, keys or projects in the organization is not seen.
- Dashboard changes after `observedAt` (cap, auto-reload, balance) are not
  monitored; the permit only records what the owner observed.
- Use is supervised and short-lived (at most 24 hours). RelayBridge never
  purchases, reloads, or changes billing.

## Owner-authorized promotional (Claude only)

The owner may authorize Anthropic promotional credit for **one** Claude
funding profile, outside RelayBridge, with a short-lived private permit. It is
a separate explicit route, `authorized_promotional` (policy
`owner_authorized_promotional`, `grantOnly: false`). It never changes
`included_api_credit` (still grant-only and blocked) or `authorized_prepaid`
(still OpenAI only; Claude stays `prepaid_provider_unsupported`). OpenAI
profiles are refused with `promotional_provider_unsupported`.

Scope of this increment:

- Only explicit read-only API one-shots (`POST /api/oneshot` with
  `funding.route: "authorized_promotional"`). `dangerous: true` is
  `api_agent_read_only`; an API writer is `api_write_unauthorized`.
- Unified runs never select it: a segment cannot name the route, and a request
  carrying `unifiedRun` is `promotional_unified_unsupported`. Existing prepaid
  unified recovery is unchanged.
- It never releases the 2% subscription reserve. Spend-limit and low-balance
  errors (`spend_limit`, `account_credit_low`) are terminal and are not reserve
  release evidence.

The permit is the file `promotional-authorization.json` in the bridge data
directory. It is read under the same rules as the prepaid permit: fixed path,
regular file, mode `0600`, owned by the bridge user, not a symlink or hard
link, at most 16 KiB, and nothing in RelayBridge writes, moves or renews it.
The root operator creates it out of band. Every request and every agent turn
re-reads and re-verifies it.

```json
{ "schemaVersion": 1, "authorizationId": "pp_2026_11_02_a",
  "policy": "owner_authorized_promotional", "provider": "claude", "surface": "claude_messages_agent",
  "supervised": true, "noPurchases": true,
  "profileId": "<profile id>", "profileRevision": 1, "organization": "<org ref>", "workspace": "<workspace ref>",
  "credentialHmac": "hmac-sha256:<64 hex>", "models": ["claude-sonnet-5-5"],
  "issuedAt": "2026-11-02T09:00:00.000Z", "expiresAt": "2026-11-02T21:00:00.000Z", "revokedAt": null,
  "providerControls": { "autoReload": "off", "billingMode": "pay_as_you_go",
    "operatorSpendLimitCents": 12000, "operatorSpendLimitScope": "organization",
    "operatorSpendLimitActive": true, "observedAt": "2026-11-02T08:50:00.000Z" },
  "balance": { "observedPromotionalCents": 19999, "observedPurchasedCents": 370,
    "observedMonthSpendCents": 0, "promotionalExpiry": "2026-11-05",
    "observedAt": "2026-11-02T08:50:00.000Z" } }
```

Rules (any failure is `promotional_authorization_invalid`): no extra or
missing keys; `models` lists 1–16 Claude API models; billing is pay-as-you-go
with auto-reload off and an active organization spend limit; the window is at
most 24 hours, ends at least 24 hours before `promotionalExpiry` and no later
than the next UTC month (the monthly spend-limit reset); both observations are
at most 12 hours before `issuedAt`; and the spend limit still available this
month (`operatorSpendLimitCents - observedMonthSpendCents`) is positive and at
most 80% of `observedPromotionalCents`. Purchased balance never counts toward
that check. Anthropic counts promotional usage toward the monthly spend limit,
which is why month spend is subtracted. The profile id, revision, organization
and workspace (the profile's `project` reference, or `null` for none) must match
the selected profile (`promotional_scope_mismatch`), the key in
`RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY` must match `credentialHmac`
(`promotional_credential_mismatch`), and a model outside `models` is
`promotional_model_not_permitted`. A deleted, revoked or expired permit is
`promotional_authorization_missing`, `_revoked` or `_expired`.

`credentialHmac` uses the same HMAC as the prepaid permit, keyed by
`authorizationId`:

```bash
node -e 'console.log(require("./lib/prepaid-authorization").credentialHmac(process.argv[1], process.env.RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY))' pp_2026_11_02_a
```

Check it with `GET /api/allocated-credit`: `promotionalAuthorization.state` is
`valid` or `blocked` with a reason, and `promotionalTransport` is
`owner_authorized_promotional_supervised` only while it is valid. `apiTransport`
still describes only the prepaid route. Status never contains the key, the HMAC
or the credential fingerprint. Revocation, edits, renewal, resume and linked
attempts behave as for the prepaid permit: any change stops a running agent
before its next turn (`not_sent`).

This is supervised, short-lived authorization, not a grant-only guarantee.
Limitations, recorded in every receipt as `route.funding.limitations`:

- Anthropic spends promotional credit before purchased credit, but that order
  is not billing isolation. The purchased balance is not authorized, yet an
  overshoot can charge it.
- The organization spend limit is the only backstop, and its enforcement can
  lag. The 80% rule is a nominal cushion, not a guaranteed reserve.
- There is no local spend ledger or accounting.
- Spend by other clients, keys or workspaces is not seen, and dashboard changes
  after `observedAt` are not monitored.
- RelayBridge never purchases, reloads, or changes billing.

## Quick handoff for a new AI

Read `AGENTS.md`, call `get_context_bundle`, and inspect existing pipelines
before dispatching anything. Read this page and `allocated_credit_status`
before discussing credit fallback. Use `route_preview` before a hosted call;
retain the exact run/request/invocation/receipt IDs. Reuse active work rather
than submitting duplicates. Follow [continuity](CONTINUITY.md) for checkpoints
and ownership, and [subscription capacity](SUBSCRIPTION-CAPACITY.md) for fresh
native quota evidence. Unknown, timeout, quota failure and partial output are
not acceptance. Machine-specific installation paths and pending setup belong
in the operator's local handoff, not in this repository.
