# Trade rules and validation

Every trade is validated on the server three times: when an offer is made, again
when the offer is accepted, and once more inside the finalisation transaction.
The client-side checks exist only to keep residents out of dead ends — they are
never authoritative.

---

## The shape of a validation result

`validateTrade(context)` returns a structured result, never a boolean:

```ts
{
  valid: boolean,
  requiresApproval: boolean,
  approvalReasons: string[],
  checks: ValidationCheck[],     // every check, passed or failed
  failures: ValidationCheck[],   // status === "fail"
  warnings: ValidationCheck[],   // status === "warn"
  ruleIds: string[],             // the configured rules that were evaluated
  evaluatedAt: string,
}
```

Each check carries a category, the resident it applies to, a message written for
a resident, and — where it makes sense — the numbers again in structured form:

```
✕ This would leave only 7 hours between this shift and Tue, Aug 11 Night Float.
  The program requires 10 hours.
     Required: 10 hours · Available: 7 hours
```

### How the message is written

Three rules, asserted for every message the engine can produce in
`tests/unit/validation.test.ts`:

**The sentence carries the numbers.** The `detail` fields are rendered only on
the chief's approvals queue. A resident's offer sheet shows the message and
nothing else, so a message that said "would have insufficient rest" told the one
person who had to act the least — not how short they were, not what the limit
was, not which shift caused it.

**Dates are written the way the rest of the product writes them.** `Mon, Aug 10`,
never `2026-08-10`. `ShiftInfo.date` is an ISO day string because that is what
the comparisons need; it is not something to show anybody. Six messages
interpolated it directly.

**The message does not open with the resident's name.** Both surfaces that
render a check print `residentName` in front of it themselves, so a message that
began with the name produced "Jordan Rivera: Jordan Rivera would work too many
consecutive days." Where a name genuinely disambiguates, the surface supplies
it.

---

## Precedence

Failures are ordered by tier, so the most important reason is always the one a
resident reads first.

| Tier | Category            | Examples                                                          |
| ---- | ------------------- | ----------------------------------------------------------------- |
| 1    | Safety and coverage | minimum rest, consecutive days, consecutive nights, workload caps, overlapping assignments, resident is active, shift still exists |
| 2    | Program policy      | minimum notice, blackout dates, holiday policy, weekend limits, monthly trade cap, pending-offer cap, same program, distinct residents |
| 3    | Service / rotation  | non-tradeable services, service PGY eligibility, credential requirements |
| 4    | Shift-specific      | shift is tradeable, PGY range on the shift, trade deadline, approval flag |
| 5    | Preference          | soft matching preferences — warnings only, never blocking          |

Within a tier, failures come before warnings, and warnings before passes.

---

## Built-in structural checks

These are always enforced and cannot be configured away:

- both shifts belong to the caller's program;
- both residents are distinct and active;
- neither shift is cancelled or completed;
- both shifts are marked tradeable;
- no trade deadline has passed;
- the shift being received has not already started;
- the assignments on both shifts still match what the trade was built from.

The last one is what makes a pending trade safe when an administrator reassigns
a shift underneath it: finalisation refuses and nothing changes.

---

## Configurable rule types

Rules live in the `rules` table as `(rule_type, params)` pairs scoped to the
program, a service, a rotation or a single shift. Administrators manage them
under **Admin → Rules**.

| Rule type                 | Parameters                              | Effect |
| ------------------------- | --------------------------------------- | ------ |
| `min_rest_hours`          | `{ hours }`                             | Minimum hours between the end of one shift and the start of the next |
| `max_consecutive_shifts`  | `{ days }`                              | Longest run of consecutive worked calendar days |
| `max_consecutive_nights`  | `{ nights }`                            | Longest run of consecutive night shifts |
| `max_shifts_in_period`    | `{ maxShifts, windowDays }`             | Rolling-window workload cap |
| `no_overlapping_shifts`   | `{}`                                    | A resident may not hold two overlapping shifts |
| `min_notice_hours`        | `{ hours }`                             | Trades must complete this long before the shift starts |
| `blackout_dates`          | `{ dates: ["YYYY-MM-DD"] }`             | No trades touching these dates |
| `holiday_restriction`     | `{ dates: [...], mode: "approval" \| "block" }` | Holiday shifts need approval, or cannot be traded |
| `weekend_limit`           | `{ maxWeekendShifts, windowDays }`      | Weekend workload cap |
| `max_trades_per_month`    | `{ maxTrades }`                         | Completed trades per resident per calendar month |
| `max_open_pickups`        | `{ maxOpenOffers }`                     | Pending offers a resident may have outstanding |
| `non_tradeable_service`   | `{ serviceIds: [...] }`                 | Services that may never be traded |
| `service_requirement`     | `{ allowedPgy: [2, 3] }` (service-scoped) | Which PGY levels may cover a service |
| `credential_requirement`  | `{ credentials: ["Critical Care"] }`    | Credentials required to cover a service/rotation/shift |
| `pgy_requirement`         | `{ maxPgyDifference? }`                 | Enforces each shift's PGY range, and optionally caps the gap between the two residents |
| `approval_required`       | `{ always?, whenServiceDiffers?, whenPgyDiffers?, whenWithinHours? }` | When a chief must approve |

Each rule also carries:

- `severity` — `error` blocks the trade, `warning` surfaces but permits it;
- `overridable` — whether a chief may override the failure with a recorded
  reason;
- `active` — disabled rules are ignored entirely.

---

## Adding a new rule type

1. Add a handler to `src/server/domain/rules/handlers.ts`:

```ts
const maxHolidaysPerYear: RuleHandler = {
  type: "max_holidays_per_year",
  label: "Holiday workload",
  description: "Limits how many holiday shifts a resident may hold.",
  category: RULE_CATEGORY.program,
  summarise: (params) => `At most ${params.maxHolidays} holiday shifts`,
  evaluate: (rule, context) => context.legs.map((leg) => /* … */),
};
```

2. Add it to the `RULE_HANDLERS` array.

That is the whole change. The admin UI lists it automatically, the API accepts
it, and validation, approval routing and the audit trail pick it up — no change
to the trade workflow.

---

## Approval

A trade requires chief approval when any of these hold:

- the program's `default_trade_approval_required` flag is set;
- either shift carries `approval_required`;
- an `approval_required` rule matches (service differs, PGY differs, always, or
  the shift starts within N hours);
- a `holiday_restriction` rule in `approval` mode matches.

The reasons are returned in `approvalReasons` and shown to the chief.

### The chief's three options

- **Approve** — the switch finalises immediately (revalidated first).
- **Request changes** — the accepted offer is declined with a note, but the
  shift stays posted so the residents can try a different pairing.
- **Reject** — a reason is required; both residents keep their original shifts
  and the post is closed.

### Overrides

If a trade fails validation, a chief may still approve it — but only for rules
marked `overridable`, and only with a written reason. The override is recorded
in the audit log with the actor, timestamp, the rules overridden and the reason,
and the completed trade is flagged `override_applied`.

Rules marked non-overridable (and every built-in structural check) cannot be
bypassed by anyone.

---

## Match scoring

`scoreMatch` is deterministic arithmetic over the program's own criteria — it is
a matching score, not a prediction, and the UI never describes it as one. It
starts at 55 and adds points for:

| Signal                                    | Points |
| ----------------------------------------- | ------ |
| Viewer's PGY is eligible for the shift    | +10    |
| Same service                              | +12    |
| Same shift type                           | +8     |
| Exactly the shift the poster asked for    | +15    |
| A date the poster listed as preferred     | +10    |
| A service the poster listed as preferred  | +8     |
| A shift type the poster listed as preferred | +5   |
| Shift lengths within two hours            | +6     |
| Both day shifts or both night shifts      | +4     |
| Within the same week                      | +4     |

The score is capped at 100 and always shown with the reasons that produced it
("Eligible PGY · Same service · Preferred date") and any caveats ("You would
pick up a night shift").
