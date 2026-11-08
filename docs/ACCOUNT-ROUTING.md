# Organization, project and funding selection

Profiles select metadata and a subscription account for **explicit requests**.
They do not sign in, link provider organizations, load keys, change billing, or
activate API spending. Requests without `funding` retain existing behavior.
The saved Auto/Off/Manual preference remains independent: automatic switching
at 2% and release of the final subscription reserve are not implemented.

## Funding boundary

Included API execution is blocked with `grant_only_funding_unverified`.
No production grant-only adapter is qualified. A read-only API agent transport
with no write tools exists ([unified usage](UNIFIED-USAGE.md)) but is never dispatched,
no funding is enabled and nothing switches automatically: decisions report
`apiTransportImplemented: true` with `qualification: null`. A profile needs a
bound `credentialRef` and `creditPeriod` (else `api_credential_unbound`) and a
current period (else `grant_expired`) before qualification is even consulted.
A balance, screenshot, key, local budget, profile, environment variable or
client-supplied `qualification` field cannot override this gate. Off reports `credit_preference_off` for an API choice.
For OpenAI profiles `blockedReason` is still `grant_only_funding_unverified`;
the Codex API-key exclusion is reported separately as
`apiLimitation:"codex_api_key_excluded"` with
`eligibleApiSurface:"openai_responses_agent"`.

As checked on 2026-10-31, [OpenAI credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)
are organization-bound and can fall through to purchased funds; Codex API-key
usage is excluded. The eligible surface would be a separate Responses agent.
[OpenAI enforced spend limits](https://developers.openai.com/api/docs/guides/spend-limits)
can overshoot and are not a grant-source lock.
[Claude grants](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)
apply to eligible API usage, but other organization funds can be used after
the grant. Messages/Agent SDK is the planned eligible surface here.
For the current accounts, grant-only enforcement has not been verified.
Never buy credits, enable reload, or consume purchased or invoiced funds.

| Route | Who decides | Runs |
| --- | --- | --- |
| `subscription` | Subscription admission | The existing CLI seat |
| `included_api_credit` | Grant-only qualification (none in production) | Nothing: `grant_only_funding_unverified` |
| `authorized_prepaid` | The owner's private prepaid permit, one OpenAI profile | The read-only Responses agent, one-shots only |

`authorized_prepaid` is the only exception to the grant-only rule. It reports
`fundingPolicy: "owner_authorized_prepaid"` and `grantOnly: false`, never
releases the subscription reserve, and is never used by unified runs. It
needs a valid permit; see
[owner-authorized prepaid](ALLOCATED-CREDIT.md#owner-authorized-prepaid-openai-only)
for the permit, its block reasons and its limitations. A grant decision never
reads the permit, so it is unchanged when a permit exists.

An explicitly authorized subscription fallback may run **before admission**:
it invokes the existing CLI once with the same provider/model/effort and exact
subscription account. It requires fresh applicable quota above the protected
reserve (at least 2%), even if ordinary usage protection is disabled. Unknown
quota, stale evidence, cooldown, a generic 429, or an unverified grant never
release the reserve. A failed or partial run is not replayed on another route.
This applies to each provider separately: a Codex fallback needs a fresh native
quota observation for the Codex seat, otherwise it stops with `quota_unknown`.

## Create and select a profile

Read `relaybridge profiles list` for `storeRevision`. Save a metadata-only JSON
file in a private local directory, outside board documents and repositories:

```json
{
  "id": "claude-personal",
  "provider": "claude",
  "label": "Personal Claude",
  "subscription": { "kind": "claude", "accountId": "default" },
  "organization": { "ref": "org_actual_id", "label": "Linked organization" },
  "project": { "ref": "workspace_actual_id", "label": "Workspace" },
  "credentialRef": null,
  "creditPeriod": null
}
```

Use the actual organization/project identifiers; names are display labels,
not proof of ownership. OpenAI profiles use `provider:"openai"` and subscription
`kind:"codex"`. `accountId` refers to an existing RelayBridge subscription
account, including `default`. A profile never creates a login. Optional
`creditPeriod` has ISO UTC `start`/`end`; these are unverified metadata.
Optional `credentialRef` permits only `{ "type":"reserved_env", "name":
"RELAYBRIDGE_ANTHROPIC_CREDIT_API_KEY" }` (or the OpenAI reserved name for
OpenAI). The value is never read. Do not put a key in the file or command line.

```bash
relaybridge profiles set --file /private/profile.json --revision 0
relaybridge profiles list
relaybridge profiles select claude-personal --revision 1
relaybridge profiles preview --kind claude --route included_api_credit
relaybridge profiles preview --kind claude --route included_api_credit --fallback subscription
```

Use the freshly returned **storeRevision** for every mutation; examples assume
an empty store. `set` creates or replaces, `remove <id> --revision N` removes,
and `select none --revision N` clears the default. A revision conflict requires
reading and reconciling state. No mutation accepts balances or funding proof.

State is private: `DATA_DIR/funding-profiles/profiles.json` (0600), directory
0700, and a deletion sentinel. Corrupt, unsafe, symlinked or deleted initialized
state fails closed. Stop submissions and restore a trusted backup to repair it;
there is no silent reset or API activation. Deleting/recreating a profile does
not reuse its revision. Selection affects new requests only; changing profile
contents invalidates queued work bound to the old revision. Running work and
historical receipts are unchanged.

## Request contract

REST `/api/oneshot` and `/api/tasks`, and MCP `ask_provider` and `submit_task`,
accept this optional strict envelope alongside their existing model/effort,
workspace, and execution controls:

```json
{
  "kind": "claude",
  "prompt": "Inspect the supplied task",
  "funding": {
    "route": "included_api_credit",
    "profileId": "claude-personal",
    "expectedProfileRevision": 1,
    "fallback": "subscription"
  }
}
```

`route` is `subscription`, `included_api_credit` or `authorized_prepaid`; `fallback` is required and
is `none` or `subscription`. Default to `none` when spending authorization is
unclear. Omitted profile/revision resolve at admission and are persisted before
queueing. Integrators should send the exact displayed profile and revision.
`auto` is rejected. An explicit `expectedAccountId` must match the profile.
Provider/account mismatch fails instead of substituting an account or model.

CLI execution uses the same gate:

```bash
relaybridge ask --kind claude --funding-route included_api_credit \
  --funding-profile claude-personal --funding-revision 1 \
  --funding-fallback subscription "Inspect this task"
```

Profile MCP tools: `list_funding_profiles`, `set_funding_profile`,
`remove_funding_profile`, `select_funding_profile`, `preview_funding_route`.
REST equivalents:

| Action | Endpoint |
| --- | --- |
| List | `GET /api/funding-profiles` |
| Set | `POST /api/funding-profiles` with `{profile,expectedRevision}` |
| Replace | `PUT /api/funding-profiles/:id` with the same body |
| Remove | `DELETE /api/funding-profiles/:id` with `{expectedRevision}` |
| Select | `PUT /api/settings/funding-selection` with `{profileId,expectedRevision}` |
| Preview | `POST /api/funding-route/preview` with `{kind,funding}` |

All require normal bridge authentication; MCP mutations retain build/store
identity preflight. Preview is a dry run: it makes zero calls, does not check
subscription admission, and a refused preview returns 400 without a receipt. Its `actual` is the proposed route, not evidence of execution.
Only execution receipts establish what ran. Context includes a bounded profile
summary through `allocatedCredit.fundingProfiles`.

## Integration and limitations

For an Etchwise integration, first require these capabilities on the deployed
bridge. Read profiles, display the selected organization/project and funding
blocker, then preview the explicit request. Preserve the bound `funding`, task
ID, provider/model/effort, and existing workspace contract. Collect the exact
task/receipt; never resubmit a partial or uncertain attempt to another route.
`route.funding` records requested and actual funding, profile revision,
organization/project/period, fallback, account, blocker, and decision hash.
Blocked requests record zero model calls. Queued delivery's compact semantic
result may omit route detail: use `get_task` or its exact provider receipt to
obtain it. Funded MCP calls bypass answer caching.

Session, committee, broadcast, automatic routing, coordinator and workflow
wrappers reject funding selectors rather than dropping them. `delegate_tasks`
and `POST /api/delegate` reject a batch whose tasks carry `funding`,
`expectedAccountId` or a legacy alias, because delegated invocations cannot
carry them. Funding-bound
owned workflow execution also stops with `funding_owned_binding_unsupported`;
its immutable writer binding has not been extended. This change does not
switch running Etchwise writers or implement checkpoint transfer. Preserve
single-writer ownership and the existing independent review gates.

Before future API execution can ship, qualify a provider-enforced grant-only
mechanism bound to organization/project/credential generation and grant period,
and add a reviewed adapter for that provider. The read-only transport,
checkpoints, exhaustion classification and receipts exist and are tested only
against a local fake; writer transfer and owned-workflow API execution are
still not implemented. Never weaken the closed gate to make a
smoke test pass. This branch requires a separately scheduled deployment; the
current live v2.6.0 process has not been restarted by this work.
