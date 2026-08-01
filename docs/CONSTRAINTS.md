# The constraint model and the schedule validator

`src/server/domain/constraints/`

Every scheduling constraint a programme's configuration can express, in one
list, each declaring whether it is **hard** — a schedule that violates it is
wrong — or **soft**, a preference that is scored.

This is the oracle. Whatever builds schedules later is only as good as the
thing that says whether its output is legal, and on its own the validator is
what makes a manual edit safe and an imported schedule checkable the moment it
lands.

---

## Hard or soft

The line is not about severity. It is about what happens to a person.

**Hard.** A ward is uncovered, or somebody is scheduled who cannot work, or
somebody is in two places at once. A schedule with one of these in it must not
be published, and no amount of being good elsewhere compensates.

**Soft.** The month is lopsided, somebody did not get the day they asked for,
a cohort got scattered. Real, worth fixing, and people will still work the
schedule. Scored, never enforced.

That distinction is why a resident's **accommodation** lives in
`residents.constraints` and a resident's **wish** lives in
`residents.preferences`. A wish must never be able to make a schedule invalid,
and an accommodation must never be quietly traded away as a wish.

## The catalogue

### Hard

| Constraint | What it means |
|---|---|
| `coverage-minimum` | A service has at least the people its requirement asks for, on every day it applies |
| `coverage-maximum` | No service is staffed above its cap |
| `coverage-pgy-mix` | A requirement asking for a senior overnight actually gets one |
| `shift-unstaffed` | No shift on a service that must be covered has nobody on it |
| `resident-availability` | Nobody scheduled has left the programme or is marked not available |
| `personal-unavailability` | Recorded leave, and standing commitments like a weekday of observance |
| `service-pgy-eligibility` | Nobody covers a service outside its configured training levels |
| `shift-pgy-eligibility` | Every shift is held inside its own PGY range *(rules engine)* |
| `service-eligibility` | Services restricted to particular levels are covered only by them *(rules engine)* |
| `credential-eligibility` | Services requiring a credential are covered only by people who hold it *(rules engine)* |
| `site-eligibility` | Nobody works a site they are not credentialed for |
| `service-exclusion` | Services somebody cannot be assigned to at all |
| `block-structure` | People work the service their cohort is assigned for that block |
| `block-override` | A recorded exception is actually reflected in the schedule |
| `blackout-dates` | Nobody is scheduled on a date the programme has protected |
| `overlapping-assignments` | Nobody is in two places at once *(rules engine)* |
| `rest-hours` | The hours off between shifts the programme requires *(rules engine)* |
| `consecutive-days` | Days in a row *(rules engine)* |
| `consecutive-nights` | Nights in a row *(rules engine)* |
| `workload-window` | Shifts in a rolling window *(rules engine)* |
| `weekend-window` | Weekend shifts in a rolling window *(rules engine)* |

### Soft

| Objective | Weight | What it measures |
|---|---|---|
| `undesirable-balance` | 4 | Nights, weekends and holidays *together*, because somebody can be within tolerance on each and still hold every bad shift |
| `workload-fairness` | 3 | Shifts per person within a training level |
| `night-balance` | 3 | Nights within a training level |
| `weekend-balance` | 3 | Weekends within a training level |
| `stated-preferences` | 2 | Days requested off, services asked to avoid |
| `continuity` | 2 | How often somebody's service changes inside one block |
| `service-distribution` | 2 | Whether one person carries a service |
| `cohort-consistency` | 1 | A cohort split across services in a block nobody assigned it |
| `minimise-change` | 1 | How much of the published schedule a draft rewrites |

## It calls the rules engine; it does not copy it

Rest, consecutive days and nights, rolling workload, weekend caps, overlaps,
PGY ranges, service eligibility and credentials are already modelled in
`src/server/domain/rules/`, configured per programme in the `rules` table, and
already tested. A second implementation would be a second set of numbers to
keep in step, and the first time they drifted the product would refuse a trade
for a limit the validator said was fine.

So those constraints call the handler and translate the verdict
(`rule-bridge.ts`). A trade asks *"if this resident took this shift, on top of
everything else they hold, would that be legal?"*; a schedule asks *"this
resident holds this shift, on top of everything else they hold — is that
legal?"* Same question, different tense.

What is **not** reused is the wording. A rule speaks to somebody about to make
a switch (*"this would leave only 6 hours"*); the validator speaks to a chief
reading a schedule that already says something (*"has 6 hours between…"*).

**Trade policy is not schedule policy.** `min_notice_hours`,
`holiday_restriction`, `max_trades_per_month`, `max_open_pickups` and
`non_tradeable_service` govern switching. They say nothing about whether a
schedule is correct and are deliberately not bridged.

## It is pure

A constraint evaluates over a `ScheduleSnapshot` handed to it. No connection,
no query, no clock it was not given. `snapshot.ts` is the only file in the
directory that touches the database.

Three consequences, all of them the point:

- the whole model runs under `npm run verify:fast`, in about a second;
- a failing test names a constraint rather than a fixture;
- the same validator runs over a draft, a published schedule, an uploaded file
  being previewed, or a proposal that exists only in memory.

## What the score is for

`scoreSchedule` returns 0–100 with a row per objective — how much each cost, in
points. One number cannot be acted on; "nights are lopsided, everything else is
fine" can. Every objective appears, including the ones that scored perfectly,
because *"we checked fairness and it is fine"* and *"we did not check
fairness"* must not look the same.

Hard violations never touch the score. A schedule with one is not a
low-scoring schedule — it is an invalid one, and putting a number on it would
invite publishing it anyway.

**The arithmetic is deterministic and has a gradient.** Fairness penalties are
`gap / (max + tolerance)`, not `gap / max`: the obvious formula saturates at 1
the moment anybody has none, so "two shifts versus none" and "twelve versus
none" would score identically and halving a gap would not move the number.
That is fatal for an oracle a generator will be graded against.

## Where it appears

| Surface | What it validates |
|---|---|
| **Admin → Scheduler** | The live schedule, from today to the last shift scheduled |
| **A draft's page** | That draft, against its own period, compared to what it would replace — directly above the publish button |
| **Admin → Schedule** | The live schedule, scoped to whatever the filters are set to. This is where a shift is moved by hand, so it is where "did that break anything" needs answering |
| **Admin → Import** | The window that was just imported, offered the moment it lands |

Always on demand. It reads the whole window and runs every constraint, and a
chief opening the dashboard for one number should not pay for a validation
they did not ask for.

## Per-person configuration

`residents.constraints` (**hard**) and `residents.preferences` (**soft**) are
jsonb. The keys the validator honours are named in `person.ts` and nowhere
else — a value nothing reads is a value that silently does nothing.

```jsonc
// residents.constraints — facts about one person
{
  "unavailableWeekdays": [5],            // cannot work Fridays
  "unavailableDates": ["2026-08-03"],    // leave already agreed
  "excludedServiceIds": ["…"],           // no VA rotations, no parking pass
  "excludedSiteIds": ["…"]
}

// residents.preferences — wishes, scored and never enforced
{
  "preferredServiceIds": ["…"],
  "avoidServiceIds": ["…"],
  "requestedDaysOff": ["2026-08-07"],
  "preferredShiftType": "night"
}
```

Every accessor tolerates rubbish. These columns can be written by an import or
a future screen, and a constraint that threw on an unexpected value would take
the whole report down — reporting nothing about a schedule, which is worse than
ignoring one malformed key.

## What is deliberately absent

**Per-resident rotation quotas** — "every PGY-1 does at least two blocks of
MICU". The configuration cannot express this. A programme says what a *cohort*
does in a block and what one person does differently, and `block-structure` and
`block-override` check both. A quota table is the obvious next thing to add;
until it exists, inventing a default would mean enforcing a curriculum no
programme agreed to.

**Travel time between sites.** Two non-overlapping shifts at hospitals an hour
apart is a real problem and nothing records the hour.

**A generator.** This decides whether a schedule is valid. It does not build
one.

## Tests

| | |
|---|---|
| `tests/unit/constraints.test.ts` | Every constraint violated on purpose, asserting the *exact* set reported. A constraint added with no case fails the suite. |
| `tests/unit/constraint-messages.test.ts` | The wording properties, across every message at once: a real date, the numbers in the sentence, no name prefix, whole sentences, no identifiers. |
| `tests/unit/constraint-scoring.test.ts` | Bounds, determinism, the breakdown adding up, and hard violations not touching the score. |
| `tests/integration/schedule-validation.test.ts` | The loader: that a snapshot arrives with what the constraints expect, that a draft is loaded when named, and that one programme's schedule stays out of another's report. |
| `tests/e2e/scheduler.spec.ts` | A chief checking a schedule and reading why it is or is not valid. |

The strictness matters. Each case asserts the exact set of constraint ids, not
"includes" — a constraint that fired on everything would otherwise pass every
test in the file.
