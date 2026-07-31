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
| Posted | Four shifts already posted for switching |
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

Plus nine more residents with ordinary rotations: Lindqvist, Mbeki,
Castellanos, Duong, Petrova, Kimura, Oyelaran, Brennan, Novak, Ferreira.

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

### 5. Multi-person swaps

**Not supported.** Every switch is between exactly two residents. The
`trade_legs` table carries a `leg_index`, so the schema would accommodate an
N-way rotation, but the domain implements two legs and nothing more. There is no
demo scenario for this because there is no feature to demonstrate.

### 6. Invitations

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
