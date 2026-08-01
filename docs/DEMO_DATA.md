# The demo program

A complete, entirely invented residency programme you can seed into a
development or staging database to demonstrate ShiftSwitch, explore it, or run
a scenario end to end without touching anyone's real schedule.

```bash
npm run demo:seed      # rebuild it from scratch
npm run demo:reset     # remove it, leave nothing behind
npm run demo:status    # what is currently seeded, if anything
```

Everything it creates is fictional. Every address is under `demo.invalid` — a
domain RFC 2606 reserves so that it can never resolve and can never belong to a
real person. No message sent to one can leave the machine.

---

## Safety

The demo commands refuse to run unless the environment positively says it is not
production. Three gates, all of which must pass:

1. `NODE_ENV` is not `production`.
2. The database is on this machine — unless `ALLOW_REMOTE_DEMO_DATA=true` is set
   deliberately, which is how a staging deployment opts in.
3. Neither the database name nor `APP_URL` contains `prod`, `production` or
   `live`.

A refusal exits non-zero and explains which gate failed. On top of that, every
destructive statement is scoped to the program named
`ShiftSwitch Demo Residency`, so even a misconfigured environment can only
replace the demo. `npm run demo:status` is read-only and always runs; it reports
when seeding would be blocked and why.

The interlock is `scripts/demo/guard.ts` and is tested in
`tests/integration/demo-data.test.ts`.

---

## What gets created

| | |
|---|---|
| Program | ShiftSwitch Demo Residency, Fictional Teaching Hospital, `America/New_York` |
| People | 18 residents (six each PGY-1/2/3), 2 chief residents who also work shifts, 1 administrator who does not |
| Services | Demo MICU, Demo Wards, Demo Night Float, **Demo Clinic** (not tradeable), Demo Emergency, Demo Scenario Ward |
| Rotations | Critical Care, Inpatient Medicine, Ambulatory, Emergency Medicine |
| Schedule | Four weeks, ~370 shifts, anchored to the Monday of the current week |
| Rules | Minimum rest 10h, max 6 consecutive days, no overlaps, PGY requirements, max 24 shifts per 28 days, approval when PGY levels differ |
| Posted | Eight shifts posted for switching |
| Trades in flight | One offer waiting on a decision, one switch awaiting a chief, one completed switch, one declined offer |
| Notifications | ~11, already delivered in-app, every one of them tapping through to a real screen |
| Invitations | One pending, one expired, one revoked |

The schedule contains day shifts, 12-hour overnight shifts that cross midnight,
24-hour weekend call, non-tradeable clinic sessions, six-day consecutive blocks,
and residents on visibly different rotations.

### Determinism

Seeding is idempotent and deterministic. The same anchor date always produces
byte-identical data, because the rotation is arithmetic rather than random:
resident *i* in week *w* is on `BLOCK_SERVICES[(i + w) % 4]`. Anyone reading the
seeded data can work out why a given person is where they are.

Re-seeding *removes and rebuilds* rather than merging. A merge-style seeder has
to decide what to do about a shift somebody edited or an offer somebody made,
and every answer to that produces "the demo is in a weird state" bugs. This way
the demo is either exactly as designed or absent.

The anchor is the Monday of the week you seed in, so weekday shifts always land
on weekdays and the call shift always lands on a Saturday.

---

## Signing in

None of these accounts has a Google identity attached, so **nobody can sign in
as them through Google**. In a development environment with
`ALLOW_TEST_LOGIN=true` you can sign in as any of them from the development
panel on the sign-in page, which is what they are for.

To use the demo as yourself on a staging deployment, sign in with your own
Google account and have the administrator invite you — or seed the demo, then
invite your address from **Admin → Users**.

---

## Accounts

| Address | Name | Role | Notes |
|---|---|---|---|
| `demo.admin@demo.invalid` | Priya Raghunathan | administrator | No shifts. Invites, imports, edits the schedule |
| `demo.whitfield@demo.invalid` | Dana Whitfield | chief | Approvals queue, schedule, import |
| `demo.aliyev@demo.invalid` | Emin Aliyev | chief | |
| `demo.rivera@demo.invalid` | Camila Rivera | PGY-2 | **Valid swap** — has posted a shift |
| `demo.okonkwo@demo.invalid` | Chidi Okonkwo | PGY-2 | **Valid swap** — holds the matching shift |
| `demo.nakamura@demo.invalid` | Kenji Nakamura | PGY-3 | **Invalid swap** — has posted a PGY-3-only shift |
| `demo.abiodun@demo.invalid` | Blessing Abiodun | PGY-1 | **Invalid swap** — cannot legally take it |
| `demo.tanaka@demo.invalid` | Aiko Tanaka | PGY-3 | **No available match** — has posted a shift |
| `demo.varga@demo.invalid` | Zsofia Varga | PGY-1 | **No available match** — her whole month is clinic |
| `demo.haddad@demo.invalid` | Yusuf Haddad | PGY-2 | **Conflicting schedule** — has posted a morning shift |
| `demo.sorensen@demo.invalid` | Freya Sorensen | PGY-2 | **Conflicting schedule** — already works that afternoon |

| `demo.petrova@demo.invalid` | Irina Petrova | PGY-2 | **Has an offer waiting** on a shift she posted |
| `demo.kimura@demo.invalid` | Hana Kimura | PGY-2 | **Made that offer**, waiting on Petrova |
| `demo.brennan@demo.invalid` | Siobhan Brennan | PGY-2 | **Completed a switch** — History and the program email are populated |
| `demo.novak@demo.invalid` | Tomas Novak | PGY-2 | The other half of that completed switch |
| `demo.duong@demo.invalid` | Linh Duong | PGY-1 | **Awaiting chief approval** — accepted an offer that tripped the approval rule |
| `demo.ferreira@demo.invalid` | Beatriz Ferreira | PGY-3 | The other half of that pending approval |
| `demo.mbeki@demo.invalid` | Thandiwe Mbeki | PGY-1 | **Declined an offer**, with a reason |
| `demo.castellanos@demo.invalid` | Mateo Castellanos | PGY-2 | Whose offer was declined — see "Recently closed" |

Plus Lindqvist and Oyelaran with ordinary rotations and nothing in flight.

---

## Scenarios

Each is asserted in `tests/integration/demo-data.test.ts` through the same
domain functions the UI calls, so the demo cannot drift into advertising
behaviour it no longer has.

### 1. A valid two-person swap

Sign in as **Okonkwo**, open Rivera's post on the switch board. Okonkwo's
Scenario Ward shift appears as an eligible candidate with every rule passing.
Offering it and having Rivera accept completes the switch: both schedules change
in one transaction and both residents are notified.

### 2. An invalid swap

Sign in as **Abiodun** (PGY-1) and open Nakamura's post. The shift requires
PGY-3, and Abiodun's own shift is PGY-1-only, so the rules engine fails it in
both directions. The candidate is shown as ineligible with the reason, and the
server refuses the offer even if the check is bypassed in the client.

### 3. No available match

Sign in as **Varga** and open Tanaka's post. She has nothing to offer: her whole
month is continuity clinic, which this program marks non-tradeable. This is the
empty state a resident actually meets, rather than a contrived rule failure.

### 4. A conflicting/overlapping schedule

Sign in as **Sorensen** and open Haddad's post. Taking his 07:00–19:00 shift
would collide with the 12:00–20:00 shift she already works that day. Both the
overlap rule and the rest rule fail; the offer is refused.

### 5. Every state of a trade, without making one

The four states above are all things you *do*. These four already exist when the
seed finishes, because some states cannot be reached by looking:

| Sign in as | You meet |
|---|---|
| **Petrova** | A posting with an offer on it, and "Review offers" on the home screen |
| **Duong** | A switch sitting with the chiefs — "Waiting for chief approval" |
| **Brennan** | A completed switch in History, and "Notify your program" still to do |
| **Castellanos** | A declined offer under **Recently closed**, with the decliner's reason |

All four are produced by calling the same domain functions a resident's taps
call — `postShiftForTrade`, `createOffer`, `acceptOffer`, `rejectOffer` — so the
notifications, audit entries, assignment swaps and generated program email are
the real ones. A demo assembled with INSERT statements would show the right rows
and none of the behaviour.

`npm run demo:status` reports the counts, and
`tests/integration/demo-data.test.ts` fails if any of the four states stops
being produced.

### 6. Multi-person swaps

**Not supported.** Every switch is between exactly two residents. The
`trade_legs` table carries a `leg_index`, so the schema would accommodate an
N-way rotation, but the domain implements two legs and nothing more. There is no
demo scenario for this because there is no feature to demonstrate.

### 7. Invitations

| Address | State |
|---|---|
| `demo.newcomer@demo.invalid` | Pending, expires in 14 days — open the link from Admin → Users |
| `demo.lapsed@demo.invalid` | Expired three days ago |
| `demo.withdrawn@demo.invalid` | Revoked |

Two behaviours to try from **Admin → Users → Invite**:

- Inviting `demo.rivera@demo.invalid` is **refused** — she is already a member,
  and a second identity for the same person is exactly what invitations exist to
  prevent.
- Inviting the same new address twice **supersedes** rather than duplicating:
  the first link stops working immediately and exactly one invitation stays
  live.

Opening an expired, revoked or superseded link shows one neutral message.
Distinguishing them would only help somebody guessing tokens.

---

## What a demo cannot show you

- **Accepting an invitation** needs a real Google account, so it cannot be
  demonstrated with seeded accounts alone. Invite your own address instead. The
  redemption logic itself is covered in `tests/integration/invitations.test.ts`,
  including the email-mismatch and concurrent-acceptance cases.
- **Email delivery.** Without `RESEND_API_KEY` the invitation link is copied or
  sent from the administrator's own mailbox. Nothing reports a delivery that did
  not happen. See `docs/ONBOARDING.md`.
- **Push notifications.** Without FCM credentials every attempt is recorded as
  skipped, never as sent.

---

## Where it lives

| | |
|---|---|
| The program as data — people, patterns, scenarios | `scripts/demo/plan.ts` |
| Writing and removing it | `scripts/demo/seed.ts` |
| The production interlock | `scripts/demo/guard.ts` |
| The CLI | `scripts/demo.ts` |
| Proof the scenarios behave as described | `tests/integration/demo-data.test.ts` |

The separate, much smaller `scripts/seed-demo.ts` builds the isolated
**App Review** program on the production database for store reviewers. That one
is not this; see `release/REVIEWER_NOTES.md`.

---

## The scheduling foundation

`npm run demo:seed` also configures the programme as a scheduler would, through
the same domain functions the scheduler screens call:

| | |
|---|---|
| Sites | Demo University Hospital and Demo VA Medical Center |
| Service configuration | Site, PGY eligibility and typical shift length on every service |
| Coverage | Six requirements exercising all three scopes — an ordinary week, a Saturday, Thanksgiving as a named date, and the winter holiday block as a period. The numbers describe the schedule the seed actually produces, not an ideal it does not meet |
| Cohorts | Two per PGY class, paired so they alternate, with all 20 residents distributed between them |
| Block year | Thirteen four-week blocks alternating Inpatient and Ambulatory — generated from `weeks: 4` and two kinds, not from anything that knows what "4+4" means |
| Block assignments | Every cohort from the **second** block onward, with the paired alternation visible in the grid. The first block is the four weeks the seed already scheduled by hand — the position of every programme adopting a tool mid-year |
| Phone numbers | All 20, validated and normalised. Visible to a chief, absent from a resident's payload entirely |
| Not schedulable | Varga, on parental leave — active on the roster but off the schedule |
| Site eligibility | Abiodun and Sorensen not credentialed for the VA |
| Exception | One PGY-2 on Demo Clinic for block 2 instead of their cohort's service, with a reason — the row that would otherwise be a spreadsheet column called NOTES |
| Availability | Three absences covering all three states: a confirmed vacation clear of the schedule (the ordinary case), a confirmed vacation over a shift somebody works (a hard violation with a reason in it), and an unconfirmed conference over shifts somebody works (scored, never enforced) |
| Draft schedule | A fortnight copied from the published one, so the diff has something to show, and every shift in it editable |

Some things are deliberately left wrong, because a demo where nothing is wrong
cannot show what any of the checking is for.

- **Demo Emergency is marked as needing coverage and has none.** The scheduler
  dashboard flags it under "Needs a decision".
- **The last week of the window has nothing scheduled.** The seed builds a
  scenario set, not a complete month, and *Check this schedule* says so a day
  at a time: "Demo Wards has 0 people and needs 4".
- **Varga went on parental leave holding nine Clinic shifts.** Exactly the
  situation the availability constraint exists to catch — she is on the roster,
  off the schedule, and still on nine shifts somebody has to cover.
- **Aliyev works eight days in a row**, against a programme limit of six.
- **Mbeki is on approved vacation and is scheduled for Demo Clinic that day.**
  One line, naming the person, the day, the service and the reason — which is
  what a structured absence buys over a date in a jsonb array.

Varga deliberately has **no** recorded absence, even though she is on leave. Her
leave is already expressed by `schedulable = false`, and recording it twice
reported her nine shifts twice — which teaches a chief to skim the report.

Sign in as **demo.whitfield@demo.invalid** (chief resident) and open
**Admin → Scheduler** to meet it. Press **Check it** for the whole report:
around thirty problems, each naming a date, a service and the numbers, plus a
quality score in the high fifties with its per-objective breakdown.

To see a programme with a *different* shape, build a second block year from the
cohorts screen with a different block length. Nothing in the schema or the code
knows how long a block is.
