# Included API credits and the 2% reserve

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
Do not accept a manually written JSON assertion as authority.

Then implement and independently review an eligible transport, exact identity
and receipt binding, checkpoint transfer, single-writer settlement, and durable
exhaustion state. Scope that state to organization, key/account and credit
period; stale/corrupt/mismatched evidence must fail closed. Only an exact
provider exhaustion result with matching funding evidence may release the
native reserve. Preserve existing provider restrictions and review gates.

No current status endpoint, CLI flag or config field satisfies these
requirements. Do not silently enable an API route to finish a task.

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
