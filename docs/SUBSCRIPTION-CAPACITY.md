# Subscription capacity is not a local token budget

The usage ledger measures RelayBridge runs, not every conversation on an
account. Cached context tokens are usage evidence, not a published subscription
allowance. Exhausting `config/usage-budgets.json` therefore does not establish
that Claude, Codex, or another subscription seat is unavailable.

For subscription gauges without a current quota observation:

- `basis` is `configured` when a local budget exists, otherwise `unknown`.
- `capacity`, `remaining`, `percentRemaining`, and `hoursToEmpty` are null.
- Budget calculations remain under `configuredEstimate`, separately from
  measured `used` and `burn` fields. They must not establish availability.
- Routing stress, tier adjustment and fleet balance exclude these estimates,
  including legacy numeric `configured` inputs. Dashboard fuel is neutral
  `unknown`, never an inferred red zero.

Current `vendor_observed` evidence retains priority over `native_observed`
allowance windows and expiring `operator_observed` percentages. Operator reports remain advisory, not verified
vendor limits. Recognized, scoped, unexpired vendor exhaustion can still gate
admission. Authentication, actual concurrency and cooldown guards are unchanged.
Unknown capacity does not guarantee that an invocation will succeed.

Fleet balance reports the basis of each included quota seat and lists
`unknownSeats` separately. With fewer than two included seats, `balanced` and
`spread` are null. Consumers must not coerce null to zero or claim fleet-wide
balance from partial observations. Metered spending budgets and local/free
seats retain their previous meaning.

Operations: do not erase quota history, invent a fresh operator percentage, or
reset genuine rate-limit observations to repair a display error. Install this
change only after the shared runtime is idle or its owner has handed it off;
source/test completion is not proof that a running process has been updated.

Native allowance, reserve settings, freshness and handoff behavior are described
in [Usage-aware continuity](CONTINUITY.md). Protection defaults to 5%; local
token estimates never supply missing native percentages.
