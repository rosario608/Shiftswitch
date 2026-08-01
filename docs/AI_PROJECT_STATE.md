# Project state

Authoritative checkpoint for any new session. **Read this first**, inspect only
what the current task needs, verify with targeted commands, and continue.

Last updated: 1 August 2026, after making **failure invisible to residents and
self-reporting to the operator**: an error boundary on every route, a mid-flight
mutation reported as *uncertain* rather than failed, reads that degrade to a
labelled last-known state, a startup schema gate that refuses rather than fails
halfway, structured error reports carrying a release, a route, a role and a
six-character reference and no resident's name, and one page an administrator
can open that says in a sentence whether residents are affected. See
`docs/FAILURE_PATHS.md` for the enumeration and `docs/RUNBOOK.md` for what to do
about each verdict.

Before that, an **independent product, security, scheduling and
pilot-readiness audit** whose brief was that `npm run verify` passing is the
floor, not the finding. It treated this document as a claim to be
checked rather than a description, and it found nine defects — three of them by
racing the scheduler the way the trade lifecycle was already raced, one by
reading every route handler off disk, and one by pressing a button in a browser
and reading the screen. All nine are fixed at the root with a regression test.
See **Audit, 1 August 2026**.

Before that, turning the scheduler into an **operational workflow**: structured
availability that feeds the constraint model, locks that survive a
regeneration, an approval step before publication, a grid the schedule is
actually built on, coverage checked by the constraint model when a trade is
proposed, and corrections to a schedule people are already working. See
`docs/SCHEDULE_OPERATIONS.md`.

Before that, the **draft schedule generator**: a scheduler asks for a month and
gets one, graded by the validator, with locks, a time budget, a per-objective
score and an explanation when no schedule fits. See `docs/GENERATOR.md`.

Before that, the constraint model and the schedule validator: every scheduling
constraint the configuration can express, declared hard or soft, evaluated
purely, with a deterministic score whose breakdown is per objective. See
`docs/CONSTRAINTS.md`.

Before that, the scheduler foundation: sites, service configuration, coverage
requirements, cohorts, configurable block years, resident scheduling data, a
scheduler dashboard, and draft schedules that can be started, edited, diffed
and published.

Before that, making the repository runnable unattended:
`/CLAUDE.md`, a single `npm run verify`, guards on every irreversible script,
and this document reconciled against the code by inspection.

Before that, the resident-facing product and the trade lifecycle audit: dead
ends, rule wording, notification routing, five-role gaps, and concurrency.

---

## Current phase

`AUDITED, AND SELF-REPORTING` — the product has been through an independent
audit whose brief was that a green test suite is the floor rather than the
finding, and every defect it found is fixed at the root with a regression test.
On top of that, every failure path enumerated in `docs/FAILURE_PATHS.md` now has
a designed outcome, and a problem in production announces itself at
`/admin/diagnostics` and `/api/health` rather than waiting to be noticed by a
resident. What remains before a pilot is not code: two migrations to apply, a
preview database branch, one repository setting, and the institution's roster.
See **User action required**.

## Current status

Live at `https://shiftswitch.vercel.app` with one administrator and the program
named **Internal Medicine / DUH / America/New_York**. No residents, services or
shifts in production yet.

`npm run verify` exits 0 on this tree, and from a clean clone whose only
preparation was `npm ci && npm run setup:local`. That is the one claim about
this repository that is checked rather than asserted, and it is checked in
full — see **Tested**.

It is also, as the audit of 1 August 2026 put it, the **floor rather than the
finding**. Every defect that audit found was in a tree where `verify` already
exited 0: three of them needed the scheduler to be raced against itself, one
needed every route handler read against the documented permission matrix, and
one needed somebody to press a button in a browser and read the screen. A green
suite means nothing it tests is broken; it says nothing about what it does not
test.

### Migrations

| | |
|---|---|
| In the repository | `0001` – `0009` |
| Applied locally, and proven to apply to an **empty** database in order | `0001` – `0009` |
| Reported applied to production by the session of 31 July 2026 | `0001` – `0006` |
| Reported applied to production by hand, 31 July 2026 | `0007_notification_route.sql` |
| **Not applied to production** | **`0008_scheduler_foundation.sql`**, **`0009_schedule_operations.sql`** |

**`0008` and `0009` must both be applied to production, in that order, before
the code on `main` is deployed.** `0008` adds the scheduling tables and
`shifts.schedule_version_id`; without it every schedule query fails, because
that column is now part of the definition of a live shift. `0009` adds
`resident_absences`, `schedule_version_locks`, `schedule_corrections`, the
approval columns on `schedule_versions` and `shifts.published_version_id`;
without it publishing a schedule fails, because publication now stamps the
provenance column. Nothing applies migrations automatically — there is no build
hook, only `npm run db:migrate` against the production `DATABASE_URL`. Both are
listed under **User action required**.

`0007_notification_route.sql` **was applied**, by hand in the Neon SQL Editor on
31 July 2026 — reported, with the confirmation named: the `route` column exists
on `notifications`, and `schema_migrations` carries a row for the file with its
checksum. That second part matters more than the first. A column added by hand
without the `schema_migrations` row would make the next `npm run db:migrate`
try to apply the file again and fail on the existing column; with the row
present and the checksum matching, the runner skips it exactly as it would skip
a migration it had applied itself.

A note on the row above it, because this document previously contradicted
itself — one section said `0005` was "applied locally, **not yet applied to
production**" while three others said `0001`–`0006` were applied everywhere.
Both cannot be true, and **this session cannot settle it by inspection**:
sessions do not connect to the production database (see `/CLAUDE.md`), so
production's actual schema is not observable from here. What is observable is
that the "not yet applied" line was written when `0005` was new and was never
updated, while the later statements were written after a session that reported
running the migration and comparing a structural fingerprint. The stale line has
been removed and the table above now states the provenance of each claim rather
than presenting a second-hand report as a verified fact.

**Anything in this document about production is a report from a session that had
access, not something the current session verified.** Everything about the
repository is verified by `npm run verify`.

## Current blocker

The program has no people and no schedule. Neither can be invented: they are the
institution's real roster and real block schedule, and no amount of engineering
produces them. Nothing technical is blocked — `npm run demo:seed` builds a
21-person programme with a month of shifts and a trade in every lifecycle state,
which is what every feature since has been built and tested against.

The audit of 1 August 2026 did not find a blocker either. What it found were
nine defects, all fixed; what it leaves behind is a short list of things a
session cannot do, under **User action required**, of which only the first three
are genuine prerequisites for a pilot.

## User action required

**1 to 4 are the prerequisites for a pilot.** Two of them are hosted
infrastructure and the production database, which `/CLAUDE.md` forbids a session
from touching; two are the institution's own data, which cannot be invented.
5 is a one-time repository setting. 6 to 8 are store accounts and identities,
needed only for the mobile release.

1. **Configure a separate Neon branch for preview deployments.** The Neon
   integration set one `DATABASE_URL` across production, preview and
   development, so **a pull-request preview writes to production data** — a
   preview that seeds, migrates or truncates would do it to the live programme.
   Previews are SSO-protected, so nobody outside the team can reach one, which
   is why this has not been urgent; it stops being merely untidy the moment a
   second person opens a pull request. Neon → Branches → create a `preview`
   branch, then Vercel → Settings → Environment Variables → set `DATABASE_URL`
   for the Preview environment only. A session cannot do this: it is a change to
   hosted infrastructure, and reaching the production database to make it is
   forbidden by `/CLAUDE.md`.

2. **Apply `db/migrations/0008_scheduler_foundation.sql` and then
   `db/migrations/0009_schedule_operations.sql` to production**, before the code
   on `main` is deployed. `npm run db:migrate` against the production
   `DATABASE_URL` applies both in order. Without `0008` every schedule query
   fails; without `0009` publishing a schedule, recording availability and
   correcting a published shift all fail. Sessions do not do this — see
   `/CLAUDE.md`.

3. **The residents' email addresses**, for **Admin → Users & roles → Invite
   people**. Any format: commas, semicolons, one per line, or a spreadsheet
   column. This is the institution's real roster; it cannot be invented, and
   `npm run demo:seed` exists so that nothing waits for it.
4. **The block schedule**, as CSV or XLSX, for **Admin → Import**. Likewise the
   institution's, and likewise not blocking any development.
5. **Make CI a required check on `main`.** The `CI` workflow already runs
   typecheck, both lints, the unit, integration and both end-to-end suites, and
   a production build on every pull request, and reports its verdict — but
   nothing currently stops somebody merging past a red one. Branch protection is
   a repository *setting*, not a file, so no session can write it. **GitHub →
   Settings → Rules → Rulesets → New branch ruleset**, target `main`, enable
   **Require a pull request before merging** and **Require status checks to
   pass**, and add these four by name: `Typecheck, lint, tests, build`,
   `End-to-end`, `Client — typecheck, lint, tests, build`,
   `Native client — end-to-end`. Also in `docs/RUNBOOK.md`.
6. **A Google Play developer account.** $25 plus identity verification.
7. **An Apple Developer account.** $99/year plus identity verification.
8. **A bundle id on a domain the institution controls**, replacing
   `org.shiftswitch.app`. It can never be changed after the first store upload.

Also eventually: a Mac for the iOS build, and 12 real testers for 14 days if
Play requires closed testing.

Do not ask the user for passwords or verification codes at any point.

## Next action

Nothing is blocked, and the repository is now set up to be worked on
unattended: `/CLAUDE.md` carries the standing rules, `npm run verify` is the
single definition of done, and the three scripts that issue irreversible
statements refuse any target that is not demonstrably local.

**For a new development session.** Pick up whatever the goal names. The product
work that most recently landed is the scheduler: service configuration and
coverage, the Duke IM service library, cohorts and configurable blocks,
resident scheduling data and the roster screen, the scheduler dashboard, and
schedule versions — drafts that can be started, edited, diffed and published.
Its shape was decided before it was built, and the reasoning is under
**Decisions → The shape of the scheduler**; a session changing those screens
should argue with that reasoning rather than work around it.

On top of it sits the **constraint model and schedule validator**
(`docs/CONSTRAINTS.md`): every constraint the configuration can express, each
declared hard or soft, evaluated purely over a snapshot, with a deterministic
score whose breakdown is visible per objective. It is the oracle — whatever
builds schedules later is graded against it.

On top of *that* sits the **generator** (`docs/GENERATOR.md`): a scheduler names
a period and gets a draft, built from the coverage requirements, the block year,
everybody's availability and eligibility, and the configured rules — then graded
by the validator before it is emitted. It supports locks, optimises the soft
objectives over a fixed number of iterations under a recorded seed — so a run
that finishes is reproducible on any machine — and when no schedule fits it
names the smallest set of constraints whose relaxation would admit one, in a
chief's words. **Build the rest again**, on the grid, runs it over an existing
draft and keeps what is locked.

On top of *that* sits the **operational workflow**
(`docs/SCHEDULE_OPERATIONS.md`): structured availability, persisted locks, an
approval step, the grid a schedule is built on, publication that notifies
everybody affected, a trade coverage check that asks the constraint model, and
corrections to a schedule people are already working — with the visible
difference between what was published and what is true now.

Everything above has been through the audit of 1 August 2026 — read that section
before changing the scheduler, because several of its conclusions are about
*why* something is written the way it is, and a plausible-looking simplification
reintroduces a defect it names.

What is *not* built, in the order it is worth doing:

1. **Incremental scoring in the generator.** Each improvement iteration
   re-scores the whole schedule, which is what stops a large programme's run
   from finishing its search and therefore from being reproducible. Recomputing
   only the objectives the two swapped residents affect would fix it. This is
   the one item that is a *correctness of the claim*, not a feature.
2. **Per-resident rotation quotas** — "every PGY-1 does at least two blocks of
   MICU" — which the configuration still cannot express, so neither the
   validator nor the generator can honour it. Inventing a default would mean
   enforcing a curriculum no programme agreed to.
3. **Multi-person switches.** Every trade is between exactly two residents;
   `finaliseTrade` writes two legs and the schema would carry more.
4. **Travel time between sites.** Two non-overlapping shifts at two hospitals an
   hour apart is a real problem and nothing in the configuration records the
   hour.

**For onboarding the first real program** (a human sequence, not a session's):
**Admin → Program settings** → **Admin → Services** → **Admin → Users & roles →
Invite people** → **Admin → Import** (`docs/ONBOARDING.md`). To exercise it
without real data, `npm run demo:seed` and the invitation sandbox — see
`docs/DEMO_DATA.md`.

**For the mobile apps.** `mobile/.env.production` already points at the live
host. Still needed: `ANDROID_PACKAGE_NAME`, `ANDROID_CERT_FINGERPRINTS`,
`APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, and FCM credentials.

## Audit, 1 August 2026

An independent product, security, scheduling and pilot-readiness pass. The
brief: treat the code and its observed behaviour as the only source of truth,
treat this document as a claim to be checked, walk every persona, attack the
scheduler, and fix every defect at the root with a regression test.

Nine defects. What is worth noticing is *how* each was found, because that is
the argument for keeping those methods:

| # | Defect | Found by |
|---|---|---|
| 1 | A chief could not set the coverage the generator reads | Reading every route handler against the documented matrix |
| 2 | Two overlapping drafts published at once left two schedules live | Racing publication |
| 3 | Withdrawing an approval could strip a *published* schedule's sign-off | Racing publication against withdrawal |
| 4 | Two regenerations into one draft stacked into one doubled draft | Racing generation |
| 5 | Nothing in the product ever regenerated an existing draft | Following a padlock to the button it promises |
| 6 | Every written client-side failure message was replaced by "Something went wrong" | Pressing a button in a browser and reading the screen |
| 7 | The generator's determinism claim was false whenever the budget was non-zero | An integration test failing under load and passing alone |
| 8 | A single-cell draft edit was missing from the change history | Reading what the history panel queries |
| 9 | The live schedule's editor could reach into a draft | Asking what makes an `ended` assignment row trustworthy |

### 1. Coverage requirements were behind the wrong capability

`/api/admin/coverage` and `/api/admin/coverage/[coverageId]` required
`services.manage`. A **chief resident does not hold it** — a chief schedules the
programme's services, they do not invent them — while `roles.ts`, the refusal
message in `guards.ts`, `docs/ROLES.md` and step one of
`docs/SCHEDULE_OPERATIONS.md` all said coverage planning is `scheduling.plan`.

A coverage requirement is the generator's primary input. So the one person who
runs the generator could not state what it should aim for, and any programme
where chiefs build the schedule had to route every coverage change through an
APD. Enforcement and documentation had drifted, and nothing tested the pair.

Fixed at the guard. No role lost anything: APD, PD and administrator hold both
capabilities. The service configuration screen, where the editor lives, now
opens to either capability and shows each caller their own half —
`services.manage` edits what a service *is*, `scheduling.plan` edits what it
needs, and whoever lacks the first reads a summary rather than a form whose
Save button would return 403.

**`tests/unit/route-guards.test.ts`** is the generalisation: it reads every
route handler off disk, pins the capability each one requires, keeps a written
exemption list for the seven that authorise nothing at all — the three sign-in
routes, the two environment-gated sandboxes, and the two `.well-known`
documents — and asserts the class of defect directly: a workflow whose
page one capability opens and whose API another closes. A static read rather
than an HTTP call, because "no route lacks a guard" is a statement about every
handler in the tree, and a request-based test only ever covers the ones somebody
remembered.

### 2. Overlapping publications left two schedules live

`publishScheduleVersion` locked its own version row, which is not enough. Two
*different* drafts whose periods overlap each lock their own row and each
replaces its own window; under `READ COMMITTED` the second one's `DELETE` was
planned against a snapshot in which the first draft's shifts were still drafts,
so it never selected them. The overlapping days ended up holding **both**
schedules — every service double-staffed, and residents rostered in two places
on the same morning.

A programme publishing next block and then a replacement week that overlaps its
tail is an ordinary Sunday evening. Fixed with a programme-scoped advisory lock
taken before anything is read; publishing is rare enough that a queue of one
costs nothing.

### 3. Withdrawing an approval could strip a published schedule

`withdrawApproval` read the status with one statement and cleared the approval
with another, with no lock and nothing in between. The gap was wide enough to
drive a publication through: read "draft", somebody publishes, then clear the
approval — leaving a **published** schedule whose record says nobody ever signed
it off. The two-step approval exists to produce exactly that record. Now one
transaction with the row locked.

### 4. Two regenerations stacked into one draft

Regeneration is a read-modify-write across seconds. Two runs interleaved into a
single draft holding both of them — twenty shifts where the programme needs ten
— with both chiefs told they had succeeded. Not a torn write: two correct
transactions composing into a wrong schedule, because the second one's `DELETE`
was planned before the first one's `INSERT`s existed.

Handled by **refusing rather than queueing**. Making the second chief wait out
the first run's budget and then silently discarding their result is worse than
telling them what happened. A fingerprint of the draft's shift set is taken
before the run and rechecked under an advisory lock at the moment of writing.

The same investigation found that regeneration took its **period from the
caller**. `persist` replaces every unlocked shift in the version, so a run told
to cover a narrower window would delete the days outside it and put nothing
back — and the grid shows at most 120 days of a longer draft, so the window on a
scheduler's screen is a *view*, not the schedule. The period is a fact about the
draft and is now read from the draft.

### 5. Locks promised something no screen delivered

A chief could lock a resident's month, see it listed, and read "locking keeps a
placement through the next regeneration" — and there was no next regeneration to
survive. `versionId`, `locksForGeneration` and the API all existed and were
tested at the domain level; the only route to the generator in the interface
created a **new** draft. Forty locks and no button they applied to.

**Build the rest again** now sits on the grid beside *Repeat a week*. It says
what it will keep before it does anything, offers the seed, reports what it
filled and the quality score, and on an infeasible run shows the generator's own
relaxations — smallest first, each with how many slots it would recover. A
refusal without a next move is a screen somebody escalates rather than acts on.

### 6. Every written client-side message was thrown away

`useAction` is the single funnel every mutation goes through. It kept the
message when the failure came back from the server and replaced every other one
with *"Something went wrong. Please try again."* — including the eight places a
component raises a written explanation before calling the server: *"Add at least
one email address."*, *"Choose a date."*, *"Give the service a name."*, *"This
service would be open to PGY-3 through PGY-1, which is nobody."*

Each of those is the entire value of the failure, and each was invisible. Worse,
the replacement is indistinguishable from the app genuinely breaking, so the
honest reaction to it is to stop trusting the screen. Found by pressing a button
in a browser and reading what appeared.

Fixed in the funnel; the generic message stays for what it was for — a network
failure, a driver error, a thrown non-`Error`. **`tests/unit/action-messages.test.ts`**
asserts both halves, including that every message a component throws still reads
as a sentence somebody can act on.

### 7. The generator was not deterministic under a time budget

`docs/GENERATOR.md` said "same inputs, same seed, byte-identical output". The
improvement phase was bounded by wall-clock time, so a fast machine performed
more swaps than a loaded one and the same seed produced different schedules. The
unit tests missed it because they run with a budget of `0`, which skips the
search entirely. What surfaced it was `schedule-lifecycle` failing under load and
passing alone — the shape of a "flaky test" that is really a wrong claim.

The search is bounded by **iterations first, time second**. A run that finishes
its iterations is byte-identical on any machine.

It is not a complete fix and the document now says so. Each iteration re-scores
the whole schedule, so a **large** programme still hits the budget first and such
a run is genuinely not reproducible. That is reported rather than hidden:
`stoppedOnBudget` now means precisely "the search was cut short, so this depends
on how busy the server was", the scheduler is told, and the seed field says the
claim holds "as long as the run finishes". The real fix — incremental scoring, so
only the two swapped residents' objectives are recomputed — is named and not
done.

### 8. Single-cell draft edits were missing from the history

`bulkAssign` wrote an audit entry; `assignDraftShift` did not. The workspace's
change panel reads `audit_logs`, so drag-selecting four cells was recorded and
changing one was not — a history that is quietly selective is worse than one
that is absent. Both write one now.

### 9. The live editor was a back door into a draft

`updateShift` and `deleteShift` — the verbs behind **Admin → Schedule**, the
screen for the schedule people are working — did not exclude a shift belonging
to a draft. `assignDraftShift` already refuses to touch a *published* shift,
with the comment "this endpoint is not a back door into the live schedule"; the
converse was simply missing. Sending a draft shift's id to the live editor
skipped the draft's own status checks and edited a schedule nobody is working
through the screen meant for one they are.

Found by asking what makes an `ended` assignment row trustworthy, which is the
question the consistency check below turns on: if the live editor can reassign a
draft shift, an `ended` row can appear on one, and the distinction that check
depends on stops holding. Both verbs now refuse, naming the draft and where to
go instead.

### The consistency check itself

`assertDatabaseConsistent()` said "every live shift has exactly one holder",
which was true before drafts existed and is not true now: a draft may
legitimately be published with an unfilled slot, because approval is
deliberately not a validity check.

Loosening an invariant is exactly the change that quietly stops catching the
thing it was written for, so it was reformulated rather than relaxed: **a live
shift with nobody on it must be explicable** — either it never had a holder, or a
correction records why. A first attempt drew the line with timestamps and was
wrong, because `now()` is transaction-*start* time in PostgreSQL: a draft edit
beginning after a publication begins and committing before it carries an
`ended_at` later than the version's `published_at`, despite genuinely happening
while the shift was a draft. That failed about one run in three.

The line is drawn structurally instead. Clearing a draft cell **deletes** the
assignment row rather than ending it — nobody has worked a draft shift, so there
is no history to keep, and the draft's history is the audit log — which leaves an
`ended` row meaning one thing only: somebody was taken off a shift they were
working. Two tests in `scheduler-concurrency.test.ts` assert both halves
directly: a published gap is accepted, and a shift emptied with nothing to
account for it is still caught.

### What was checked and found sound

Not everything the audit looked at was broken. Recorded so a later session does
not re-derive it:

- **Every mutating route is guarded.** The seven without a capability check are
  each defensible and are now listed with their reason.
- **Cross-programme access, role escalation, malformed identifiers, session
  expiry, deactivation mid-session** — covered by `red-team.spec.ts` and
  `security.spec.ts`, and re-read against the new surfaces.
- **Push cannot break a publication.** `notify` inserts the in-app row inside
  the transaction and defers the push to `afterCommit`; `sendPush` swallows its
  own failures and records every attempt in `push_deliveries` with a status. A
  rolled-back publication cannot produce a notification, and a push outage
  cannot roll back a publication.
- **Nothing claims delivery that did not happen.** The default invitation
  transport returns `{ delivered: false, reason }` and the interface says to
  copy the link.
- **No scheduling screen scrolls horizontally on a phone.** Previously only the
  resident pages were checked; the admin screens — the dense ones, with a grid —
  are now in the same test and pass.
- **Coverage mutations are transactional and audited**, like every other
  scheduling mutation.

### Accessibility, honestly

What is checked, in `tests/e2e/mobile-ux.spec.ts`: no page scrolls horizontally
at phone width — now including the admin screens, which are the dense ones;
primary controls and every bottom-navigation item meet a 44-pixel tap target;
a keyboard user can reach the main content and operate a sheet; empty states say
what to do next; and the offline banner blocks schedule changes rather than
failing silently. Controls are labelled elements (`<label for>`, `aria-label` on
icon-only buttons) and the navigation is a landmark with a name.

What is **not** checked: there is no automated accessibility audit — no axe pass,
no contrast measurement, and nothing has been driven with a real screen reader.
Saying "accessible" on the strength of the tests above would be overclaiming.
The nearest thing to a next step is an axe-core check over the primary screens
in the end-to-end suite.

## Decisions

Choices made without asking, as `/CLAUDE.md` requires. Each says what was
chosen, why, and what was rejected, so any of them can be revisited by someone
who disagrees rather than rediscovered.

### The three questions each role arrives with

Named so that a screen can be judged against them rather than against whether it
works. Each has to be answerable **on arrival** — no filter to configure, no
search to run, no report to build.

**A chief resident** — on a ward, between rounds, on a phone.

1. *Is anything uncovered?* → `/admin` leads with the verdict: "3 things to
   fix", "2 things waiting on you", or "All clear", and an unfilled-positions
   count that opens coverage.
2. *Is anything waiting on me?* → the same line counts it: unfilled positions,
   pending approvals, drafts to sign off, and a schedule approved but not
   published.
3. *Is the schedule healthy?* → a red banner when the published schedule breaks
   a hard constraint, above everything else, because a count of completed
   switches is interesting and a ward with nobody on it is not.

**An APD** — accountable for how the programme is running, not for tonight.

1. *Is switching actually working for us?* → `/admin/analytics` now says it in a
   sentence: "14 of 22 posted shifts found a switch", with the completion rate
   and average approval time beside it. It used to be eight equal tiles, which
   is a data dump: whoever arrived had to decide which number was the point.
2. *What are we refusing, and why?* → the blocked-reasons list on the same
   screen, ranked by how often each rule fired. A rule that blocks half the
   programme's switches is a rule to revisit, not a rule working correctly.
3. *Is next block's schedule ready?* → the drafts tile on `/admin`, which
   distinguishes "in progress" from "waiting for sign-off" in its label.

**A PD** — accountable to the institution.

1. *Is the published schedule the one people are working?* → "Changed since it
   was published" on `/admin`, the most recent corrections with who made them,
   and every correction's stated reason on `/admin/corrections`.
2. *Are approvals holding anybody up?* → a warning on the analytics screen when
   the average decision takes more than a day, in the terms that matter: a
   posted shift expires while it waits.
3. *Who is carrying the programme?* → **not yet answered.** There is no
   per-resident load view; the roster holds the data and nothing renders it as a
   comparison. Recorded here rather than papered over, and named under **Known
   issues**.

**An administrator** — accountable for the software.

1. *Is it working?* → `/admin/diagnostics`, one sentence and a copyable report.
2. *Did the invitations reach anybody?* → `/admin/users`, where an invitation
   that could not be emailed says so and offers the link to copy, rather than
   claiming it was sent.
3. *What changed, and who did it?* → `/admin/audit`.

Rejected throughout: a single "dashboard" with everything on it for everybody.
Five roles with five different first questions get one screen that answers
whichever one it was built for and none of the others. What varies is expressed
through the capability matrix, never a role literal — every role literal ever
written in this repository became a bug the day APD and PD were added.

### What the product costs in taps

Counted in a real browser at phone size, not estimated:
`tests/e2e/taps.spec.ts` installs a click listener in the capture phase and
reads the total out of `sessionStorage` after each flow, so what is measured is
what the *browser* saw. The ceilings are asserted, so a change that adds a step
fails the suite and names the flow.

| From a cold open, signed in | Before | After |
| --- | --- | --- |
| Post a shift | **2** | **2** |
| Offer one of yours on a posted shift | **3** | **2** |
| Accept an offer | **3** | **2** |

**Posting was already at its floor and stays there.** Two taps: the button on
the next-shift card, and the confirmation. The sheet is not ceremony — it is
where the resident sees which shift they are giving away and can add the note
that gets them a better offer.

**Offering lost the tap that only re-showed a decision already made.** The sheet
picked the best eligible shift for you and then asked you to confirm that pick;
the candidates are now loaded when the screen loads instead of when the sheet
opens, so the button can *name* the shift it will offer — "Offer Tue, Aug 11 ·
MICU". Choosing a different one is still one tap away and the ranked list behind
it is unchanged. Offering is reversible until it is accepted, which is why it
gets a direct button.

**Accepting lost a tap of transport, not of safety.** A single waiting offer is
now decided on the home screen, because one offer is a yes-or-no and navigating
somewhere to answer it spends a tap on getting there. *Several* offers still
link out: choosing between them is a comparison, and the switch screen is built
for comparing. The confirmation that spells out "You give / You receive" is
untouched in both cases — accepting hands somebody else your call shift, and
that is the one tap on this list worth paying for.

### The resident's first ten seconds

The home screen answers two questions before anything is tapped: **what am I
working next**, and **does anything need me**. It used to open with "Hello,
Alice" and a sentence describing itself, which is two lines of the most valuable
space on a phone spent on neither. The heading is now the answer — "Needs you"
when something does, "Next shift" when nothing does, "No upcoming shifts" when
there is nothing at all — so a resident reads one line and knows.

Rejected: keeping the greeting and moving it below the content, which is the
usual compromise and still costs a line to say nothing. Also rejected: a
notification-style badge count in the heading, which tells somebody there is a
number without telling them what it is about.

The "Quick actions" card is gone. Three links, two of which duplicated the
bottom navigation and one of which duplicated the button on the card directly
above it.

### Failure, and what counts as an error worth reporting

The judgements behind `docs/FAILURE_PATHS.md`, `src/server/health/` and
`src/server/observability/`. The organising question throughout: *who is this
message for, and what can they do about it?*

**A mutation interrupted mid-flight is reported as uncertain, not as failed.**
This is the decision the rest of the offline handling hangs off. `fetch` cannot
tell a request that never left the phone from one whose response was lost on the
way back, but the *product* can: if the browser was already offline when the
call started, nothing was sent and the resident is told exactly that — "nothing
was sent and nothing has changed". If the connection dropped after the request
went out, the honest answer is that ShiftSwitch does not know, and the amber
banner says so and offers *Reload and check*. Rejected: calling it a failure,
which is the conventional choice and is *wrong here* — a resident told their
offer failed will make it again, and a duplicate offer on a shift somebody has
already accepted is precisely the state the trade lifecycle is built to
prevent. Also rejected: retrying automatically, which turns "we don't know" into
"we did it twice".

**Stale reads are shown, and labelled.** The service worker previously cached
nothing, on the reasoning that a wrong schedule is a clinical problem. That is
right about the risk and wrong about the remedy: a resident on a hospital lift
with no signal got a blank screen, which tells them nothing at all, rather than
last night's schedule with the time it was captured written across the top. The
new rule is *shown with its age, never silently*: page shells are cached with an
`x-shiftswitch-cached-at` stamp and a banner names the capture time in the
product's own date words. `/api/` is still never cached — the labelled
last-known state is a *page*, not a data source a mutation could be built on.

**A missing migration is a failure; an unexpected one is only degraded.** The
build carries its manifest and compares it to `schema_migrations`. Missing means
the code is ahead of the schema, and the next query is going to name a column
that is not there — refuse now, with the filename. Extra means the *database* is
ahead, which is what a rollback deliberately leaves behind, and every migration
here is additive, so older code runs happily against a newer schema; saying
"broken" would push an operator toward a down-migration, which is how a database
loses data. A checksum that has *changed* is failed rather than degraded: an
applied migration whose bytes differ means the two histories have diverged, and
nothing downstream can be trusted to mean what it says.

**Doubt is not drift.** When the comparison cannot be made at all — the database
is unreachable — the gate lets the request through rather than blaming the
schema. The query that follows raises a database error saying exactly what is
wrong; converting that into "a migration is missing" would send somebody to
apply migrations against a database that is not answering. `migrationState()`
returns `MigrationState | null` rather than a boolean so this cannot be got
wrong by accident.

**Drift is reported once per verdict, not once per refused request.** Every
request in flight raises `schema_drift`, so reporting at the point of refusal
would emit one report per resident per tap for as long as the drift lasted —
burying whatever else was wrong, at the moment somebody is trying to read the
dashboard. The report is raised where the verdict is computed, which the
thirty-second cache already limits to once per window. This is the general rule
in miniature: **a refusal the product designed is not an incident; the condition
that caused it is.**

**Unconfigured delivery is degraded, never failed; unconfigured sign-in is
failed.** Nobody's schedule is wrong because email is not set up, and the
product already says out loud wherever it matters that an invitation was not
sent — so it is the "when convenient" verdict. Nobody can use the product at all
if Google sign-in is unconfigured, so it is the loud one. With one environmental
exception: where `ALLOW_TEST_LOGIN` is open — development and the end-to-end
suites — missing OAuth credentials are `degraded`, because there *is* a way in
and calling it broken would make every local diagnostic red and teach whoever
reads it to ignore the colour. Production cannot reach that branch:
`describeEnvironment` refuses the test door twice over.

**4xx is expected noise; 5xx is an incident.** A refused capability, a validation
failure, a rule the swap breaks — these are the product working, and they are
logged at `warn` with the request id and never reported. Only a 5xx becomes a
report, because only a 5xx means nobody designed what just happened. Rejected:
reporting everything and filtering at the dashboard, which puts the judgement
somewhere the person who owns this project will never go.

**Client reports carry a scrubbed route, never the URL.** `/trades/<uuid>`
becomes `/trades/:id` before it leaves the browser, long opaque segments become
`:token`, digits become `:n`. What survives is the shape, which is what tells you
*which screen*, and nothing that identifies a resident or a shift. The four
scrubbers on the server side — email addresses, phone numbers, connection
strings, bearer tokens — apply to every message and stack, bounded to 2000
characters, so a driver error that quotes a row cannot smuggle one out. The
native boundary deliberately omits React's `componentStack`, which quotes props.
Tags are a *fixed typed set* — release, route, role, request id, kind, code —
rather than a free map, so leaking is a type error rather than an oversight.

**The report carries the role, never the person.** "chief", not who. Everything
an operator needs to reproduce a fault is in the release, the route and the
role; a name adds nothing they can act on and turns an error dashboard into a
place resident data lives.

**Six characters, from an alphabet with no ambiguous letters.** The request id a
resident reads off their screen and says down a corridor. No `0`/`O`, no `1`/`l`,
lower case. Rejected: a UUID, which is unsayable and therefore never actually
gets quoted, which is the whole point of having one.

**`/api/health` needs no sign-in.** It is the answer to "the site will not load
at all", and a check you cannot reach while broken is not a check. It reports
component names, a release id, filenames and whether settings are *configured* —
never a value, never a connection string, never a count of anybody. It answers
503 when residents are affected and 200 when they are not, so an uptime monitor
can be pointed at it without reading the body.

**No error-reporting SDK.** `DsnTransport` writes the Sentry envelope format
directly, in about forty lines. Rejected: adding the SDK, which would install a
global error hook, its own fetch patching and a large dependency into a product
whose entire error surface is already enumerated in `docs/FAILURE_PATHS.md` — and
would make the "never send resident data" rule a matter of configuring somebody
else's default rather than a property of the one function that builds the
payload. With no `ERROR_REPORTING_DSN` set, the default transport logs and
reports `delivered: false`, in keeping with the standing rule that nothing here
claims a delivery that did not happen.

**Source maps are not published.** Rejected: `productionBrowserSourceMaps`,
which would serve the whole client source to anybody who asked; the native
bundle already ships deliberately without maps, for the same reason. What
replaces symbolication: the error *name and message* survive minification
unchanged, the scrubbed route says which screen, the release id pins the build,
and the request id joins the client report to the server log line that has the
full unminified stack. If an error service is ever configured, uploading maps to
it needs that service's credential and is a human step.

### The audit

**Coverage belongs to `scheduling.plan`, not `services.manage`.** Rejected:
granting a chief `services.manage`, which would also let them create and delete
services — a much wider change made to fix a narrower problem. Also rejected:
splitting the coverage editor onto its own screen, which would mean a chief
configuring coverage and an APD renaming the service never see each other's
half, and is how a service ends up marked as needing coverage with nothing
saying how much. Chosen: move the guard, and let one screen open to either
capability and show each caller the half that is theirs.

**Two schedulers regenerating one draft is refused, not queued.** Rejected:
serialising the runs, because the second chief would wait out the first run's
time budget and then have their result silently discarded. They pressed the
button and are looking at the screen; the useful answer is "somebody else just
regenerated this — look at theirs, or run again".

**Publication is serialised across the whole programme, not per draft.**
Rejected: locking only the rows in the window, because which windows can collide
is not knowable before either transaction has read anything. Publishing is rare
enough that a queue of one costs nothing.

**A draft edit that clears a cell deletes the assignment row rather than ending
it.** Rejected: keeping the row and distinguishing draft edits from live changes
by timestamp, which is unsound — `now()` is transaction-start time, so a draft
edit that begins after a publication and commits before it looks later than the
publication. Nobody has worked a draft shift, so there is no history to lose,
and the draft's history is the audit log. This is what lets an `ended` row mean
one thing: somebody was taken off a shift they were working.

**The generator's improvement search is bounded by iterations, with time as a
safety valve.** Rejected: leaving it time-bounded and softening the determinism
claim in the documentation — a scheduler who runs it twice and gets two
different schedules cannot tell whether their own edit caused the difference,
which the documentation itself calls fatal. Accepted as a *partial* fix and
recorded as such: a large programme still hits the budget, and the remedy —
incremental scoring — is named rather than pretended away.

**A live shift with nobody on it is legal.** Rejected: keeping "every live shift
has exactly one holder", which was true before drafts existed. Approval is
deliberately not a validity check, so a chief may publish a schedule with a hole
in it when the alternative is no schedule at all, and the coverage report and
unfilled queue exist to show it. What replaced it is stricter where it matters:
a shift *emptied* without a correction to account for it is still caught.

### The operational workflow

**Publication requires an approval, and there is no combined verb.** A draft
must be signed off before it can be made live, and `publishScheduleVersion`
refuses an unapproved one. *Rejected:* an "approve and publish" button, which
would leave an approval record nobody ever paused over — the record would exist
and mean nothing. *Rejected also:* making approval a validity check that refuses
a schedule with hard violations. A chief who approves a month with two gaps
because the alternative is no schedule at all is making a real decision; the
product's job is to record it, not to overrule it. What it must never do is let
that happen invisibly, so the accepted violations are stored with the approval.

**Approval stores what the approver was shown, rather than being recomputed.**
`schedule_versions.approval_report` carries the score, the counts and the hard
violations accepted, in the words they were shown in. *Rejected:* recomputing on
demand, which answers a different question — next month's roster and next
month's rules produce a different report about the same schedule. The report is
computed **server-side at the moment of approval**, not taken from the client:
an approval carrying a score the browser worked out three edits ago is a
signature on a document nobody read.

**`schedule.publish` is its own capability**, held by the same four roles as
`scheduling.plan` today. *Rejected:* reusing `scheduling.plan`, on the grounds
that the holders coincide. They coincide because there are five roles, not
because the two authorities are the same thing: building a schedule changes
nothing, and publishing one replaces a month of what people are working. The
capability is what `rolesWith` will be asked when the product needs to know who
to tell that a schedule is waiting for sign-off.

**Locks are rows keyed by what the scheduler pointed at, not flags on shifts.**
*Rejected:* a `locked` column on `shifts`. Three of the five lock kinds — a
resident, a cohort, a service — do not name a shift at all, and regeneration
deletes and recreates the unlocked shifts, which would take a per-shift flag
with them. An assignment lock is stored as a **person and a day** and resolved
to a shift id at generation time, for the same reason.

**A lock whose target no longer exists is listed, not dropped.** `target_id` is
not a foreign key, because the four kinds point into four tables. *Rejected:*
silently ignoring an unresolvable lock, which is how a scheduler loses the
placement they were most careful about without ever being told.

**Structured availability has no constraint of its own.** `resident_absences`
merges into `unavailableDates` and `requestedDaysOff` inside `person.ts`.
*Rejected:* a `recorded-absence` constraint alongside `personal-unavailability`,
which would mean a schedule that scheduled over somebody's leave was wrong in a
*different* way depending on which screen recorded it, and a chief would have to
learn two names for one problem. The merge also meant every existing constraint,
generator check and test picked up the feature without changing a line.

**Hard versus soft on an absence is a column, not derived from the kind.**
*Rejected:* deriving it, which would mean either refusing the transition a
conference makes when the programme approves it, or inventing a second kind for
every kind that has one.

**A resident may record their own absence and may not confirm it.** *Rejected:*
letting them, which would give any resident a way to invalidate the programme's
schedule unilaterally; the first time it was used to get out of a night float,
nobody would trust the field again.

**Coverage for a trade is asked of the constraint model, not the rules engine.**
`checkTradeCoverage` runs the hard coverage constraints twice and reports only
what the swap introduces. *Rejected:* a coverage rule in the rules engine, which
would be a second definition of "covered" — and the first time the two disagreed
the product would be telling a resident one thing and a chief another.
*Rejected also:* reporting every coverage violation on the affected days, rather
than only the introduced ones: a programme whose numbers are aspirational
already has shortfalls, and blocking every switch that touched a day already
short would block nearly all of them while fixing nothing.

**A correction cancels live switches rather than refusing.** Publication refuses
to destroy a switch; a correction does not. *Rejected:* symmetry with publish. A
correction usually *is* the response to whatever made the switch impossible, and
refusing would leave a resident holding a shift the programme has already
decided they are not working. `invalidateTradesForShift` notifies everybody
involved, so cancelling here is not silent.

**Corrections are recorded as a list of departures, not as a second version.**
*Rejected:* snapshotting the published schedule so the "original" could be
diffed against it. Publication makes the draft's rows the live ones; there is no
second copy, and creating one would double every published shift. What somebody
actually asks is "what changed and why", and a diff of two snapshots could not
have answered the second half.

**The workspace uses the draft's declared period, capped at 120 days.**
*Rejected:* clamping to the span of shifts that exist, which was the first
implementation and which hid exactly the gap somebody opens the screen to find —
a Tuesday with nothing on it. The cap is what makes a draft declared over
"everything, ever" survivable.

**The scheduling invariants are scoped to published shifts.**
`assertDatabaseConsistent`'s "exactly one holder" rule now excludes draft
shifts. *Rejected:* applying it everywhere, which would make every generator
test that legitimately leaves a slot unfilled look like a torn write. A draft
shift with *two* holders is still a defect, and is still checked.

**`verify` is a TypeScript script, not a chain of `&&` in package.json.**
`scripts/verify.ts` can set per-step environment — the from-scratch migration
needs `NODE_ENV=test` so it drops the test database and never the development
one — and it reports which step failed and how long each took. *Rejected:* a
shell chain, which cannot vary environment per step and reports only the exit
code of whatever died. *Cost:* one more file, and `tsx` is required to run the
runner, which every other script in this repository already needs.

**`build` runs before the Playwright suites, not after.** Both Playwright
configs start `next dev`, and `next dev` and `next build` contend over `.next`.
Building first means no dev server is running yet. *Rejected:* the literal order
in the request, which put the end-to-end suites first and produced an avoidable
race. The full set of steps is unchanged.

**Destructive scripts refuse non-local targets rather than warning.**
`migrate.ts --reset` and `e2e-fixture.ts` had no guard at all, and `verify` runs
both on every invocation. They now refuse before opening a connection.
*Rejected:* a confirmation prompt, which would make `verify` non-interactive in
name only, and a single global override variable — each caller opts in under its
own name so that unlocking one does not unlock the rest.

**The concurrency invariant reads assignment history, not current holders.**
`assertDatabaseConsistent` checks the assignment that was active at the moment a
trade completed, reconstructed from `shift_assignments`. *Rejected:* comparing
current holders, which was the original implementation and which reported a torn
write as soon as an administrator legitimately reassigned a shift after a switch
— an ordinary action, and one the accept-versus-reassign race performs by
design. Atomicity is a question about the moment of the transaction; the later
state of a shift is a different question.

### The shape of the scheduler

Decided before building the screens, because a scheduler assembled from whatever
the tables happen to contain is the failure mode this feature has in every
product that has one. What follows is the reasoning, so that somebody who
disagrees can argue with the reasoning rather than guess at it.

**Who this is for.** A chief resident. They are a doctor, they have the job for
a year, nobody trained them on it, and they are doing it between clinical
duties — usually on a phone, often while standing up. They did not ask for a
database. They asked for next block's schedule to be right.

**What they do first.** Not "create a cohort". On the day they inherit the job
the question is *what is the state of this and what is broken* — so the
dashboard leads with **Needs a decision**: mandatory services with no coverage,
unfillable PGY mixes, upcoming shifts with nobody on them, residents in no
cohort. Each names the problem in a sentence and links to where it is fixed.
When there is nothing wrong it says so in a sentence rather than showing an
empty box, because "no problems" is information and blankness is not.

**What they see on arrival**, in this order and for this reason:

1. **Problems** — the reason the screen was opened, most of the time.
2. **Drafts in progress** — the work actually in hand.
3. **The four pieces** a schedule is made of — residents, cohorts, services,
   blocks — each a *door* with a one-line state, not a table.
4. **The live schedule** — one number and whether anything is uncovered.

**What is one tap away.** The weekly cycle: open a draft → read the diff →
publish. And the roster, because "who can work" is the question that interrupts
everything else — somebody calls in sick and the chief needs a phone number and
a list of who is free, now, not after three screens.

**What is deliberately buried.** Setup, which is done rarely and then never
again: building a block year (once a year), configuring a service's coverage
(once a term), loading the service template (once, ever). These live one level
down behind a labelled door. They are not hidden — a scheduler who wants them
finds them immediately — but they do not compete for attention with the work
that happens weekly. Putting a thirteen-column block grid on the landing screen
would make the common case worse to serve the rare one.

**The one table that earns its place** is the cohort/block grid: cohorts down
the side, blocks across the top, a service in each cell. Every programme already
keeps that exact table in a spreadsheet, so showing it directly — with each cell
editable — is the difference between a tool a chief uses and one they export to
Excel and abandon. It scrolls inside itself; the page never scrolls sideways.

**What this rules out.** No screen in the scheduler is a list of rows with an
Edit button and nothing else. Every one leads with what the reader wants to
know — is this right, what changed, who is free — and offers the record
underneath. Where that was not true, it was a defect to fix rather than a layout
to accept: the coverage editor reads as a sentence ("weekdays, 07:00–19:00, 2 to
3 people, at least one senior") rather than as a row of columns, and the roster
leads with availability rather than with a directory.

### The generator

**The generator does not decide whether its own output is legal.** Every run
ends by handing the schedule to `validateSchedule`, and a run whose schedule has
hard violations reports infeasibility and emits *nothing*. That is why the
validator was built first. *Rejected:* trusting the construction logic, which
would mean the only thing standing between a bug and a ward with nobody on it is
the bug not existing.

**An infeasible run writes nothing at all — not even the version row.** A
half-built draft is something somebody finds later and publishes. *Rejected:*
emitting the partial schedule with a warning, which is the same thing with a
label nobody reads.

**Slots are ranked once, not after every placement.** Re-ranking is more
accurate and quadratic: on the demo programme's 200 slots it turned a run that
should take a second into fifty, and every one of those seconds came out of the
budget the improvement phase never got to spend. What single-pass ranking costs
is the occasional greedy trap, and those are repaired directly — when a slot
cannot be filled, move one person aside to admit somebody who can. One level
deep, bounded, every step still checked. On the demo it closes four slots out of
two hundred.

**The fast feasibility checker reads the programme's own numbers and never has
the last word.** The search asks two hundred thousand questions in the time the
validator answers ten, so it cannot be the validator. It takes its limits from
the same `rules` rows the engine reads, and if it ever disagreed with the
validator the consequence is a generator that fails loudly — never one that
quietly produces an illegal month. A rule configured as a *warning* is skipped
entirely: the programme has said a schedule may break it.

**Nobody can hold two places at the same service at the same time, and that is
not configuration.** It is arithmetic about people, so it is enforced
structurally rather than through `no_overlapping_shifts`, which a programme
might never have created. Without it the generator satisfied "three people on
the MICU" with one person three times over — and the validator agreed, because
`coverage-minimum` counted *rows*. Both were defects; both are fixed and have
regression tests. **This is the clearest thing the generator has been worth so
far**: it exercised the validator hard enough to find a hole a human reading the
code would not have.

**Somebody's leave is never proposed as a relaxation.**
`resident-availability`, `personal-unavailability`, `service-exclusion` and
`block-override` are facts about individuals. They are named as blockers when
they are one, and never offered as something to give up. When the roster is
simply too small, it says that instead, because no rule change fixes it.

**The budget bounds the search, not the construction.** Construction is not
optional — a schedule with a hole in it is not a schedule — so it runs to
completion and `stoppedOnBudget` describes the improvement phase. The default is
two seconds, which is enough for the search to matter and short enough that the
integration suite runs a dozen generations without anybody noticing.

**A generated schedule is a `ScheduleSource` like any other.** It produces the
same flat records an uploaded spreadsheet produces, validated and committed by
the same path. *Rejected:* letting the generator insert shifts directly, which
would be a second route into the schedule model, and the second route is always
the one that misses the rule the first one grew last month.

### The constraint model

**Hard and soft is about what happens to a person, not about severity.** A hard
violation means a ward is uncovered or somebody is scheduled who cannot work —
publish it and somebody is harmed. A soft one means the month is lopsided, and
people will still work it. That single distinction is why a resident's
*accommodation* lives in `residents.constraints` and a resident's *wish* lives
in `residents.preferences`: a wish must never be able to invalidate a schedule,
and an accommodation must never be silently traded away as a wish. *Rejected:*
one column with a severity flag, which makes it one careless edit to turn
somebody's parental leave into a preference.

**The constraints call the rules engine rather than reimplementing it.** Rest,
consecutive days and nights, rolling workload, weekend caps, overlaps, PGY
ranges, service eligibility and credentials are already modelled, already
configured per programme, already tested. A second implementation would be a
second set of numbers to keep in step, and the first time they drifted the
product would refuse a trade for a limit the validator called fine. What is not
reused is the wording — a rule speaks to somebody about to make a switch, the
validator to a chief reading a schedule that already exists. *Rejected:* also
bridging the trade-policy rules (notice, holiday tradeability, trades per
month), which say nothing about whether a schedule is correct and would produce
violations nobody could act on.

**The model is pure; one file reads the database.** Constraints evaluate over a
snapshot handed to them. The whole model therefore runs under
`npm run verify:fast` in about a second, a failing test names a constraint
rather than a fixture, and the same validator runs over a draft, a published
schedule, an uploaded file being previewed, or a proposal held in memory.

**A constraint that throws is reported, not swallowed.** The validator catches
per constraint and emits "could not be checked — treat this schedule as
unverified". The alternative is one malformed row in one programme's
configuration silently producing "no problems found", which is indistinguishable
from a good schedule and is the worst thing this code could do. It earned its
keep immediately: the first integration run reported `Invalid time value` from
a caller passing a `Date` where an ISO string was expected, instead of
returning a clean bill of health.

**Fairness penalties are `gap / (max + tolerance)`, not `gap / max`.** The
obvious formula saturates at 1 the moment anybody has none, so "two shifts
versus none" and "twelve versus none" score identically and halving a gap does
not move the number. That is fatal for the thing the score is *for* — it is the
oracle a generator will be graded against, and an objective with no gradient
cannot be optimised towards.

**Hard violations do not touch the score.** A schedule with one is not a
low-scoring schedule; it is an invalid one, and putting 82 on it would invite
publishing it anyway.

**`minimise-change` matches slots, not shift ids.** A draft copied from the
published schedule holds new rows with new ids for the same slots, so comparing
ids found no shift in common and reported that nothing had changed however much
had. Matched on service, start and end instead — the same pairing problem the
publication diff already solves.

**The demo's coverage numbers describe the schedule the seed actually
produces.** They were written aspirationally — two to three on the MICU while
the plan rostered five — so validating the demo reported 241 problems, every
one of them true and all saying the same thing: the configuration was written
about a different programme. A demo whose own validator condemns it teaches
nobody anything. What is left is a coherent report: the last week of the window
has nothing scheduled, one resident went on leave holding nine shifts, and
somebody works eight days in a row. The block grid now starts at the *second*
block, because the first is the four weeks the seed already scheduled by hand —
the situation of every programme adopting a tool mid-year.

**Editing a draft is cheap; editing the live schedule is expensive.** Assigning
a draft shift is an inline `<select>` that saves on change, with no
confirmation, no revalidation of trades, no notification and no offer
invalidation — because a draft shift is invisible to residents and cannot be
traded, so none of those consequences exist. The live editor in
`src/server/domain/admin.ts` keeps all of them. That asymmetry is the entire
value of drafts: building a month's schedule means doing this a hundred times in
a sitting, and a dialog per change would make it unbearable. *Rejected:* routing
draft edits through the live path "for consistency", which would make the safe
operation feel like the dangerous one; and a sheet per shift, which is three
taps for a change that should be one. `assignDraftShift` and `removeDraftShift`
answer "that shift is not part of this draft" for a *published* shift as well
as a missing one — deliberately the same answer, so the endpoint is not a back
door into the live schedule and the wording does not invite trying.

**Nobody-yet is a value, not a missing one.** Clearing a draft shift is
allowed, and the API field is required-and-nullable rather than optional: an
absent key would be ambiguous between "leave it" and "clear it", and the two
differ by somebody's weekend. A half-built schedule with unstaffed shifts is
the normal intermediate state, and it is what the "shifts with nobody on them"
count exists to surface. *Rejected:* forcing every shift to hold somebody,
which would make schedulers park people on shifts they are not meant to work.

**Assigning somebody not available to schedule is refused, not warned.** It is
not a judgement call made deliberately from that screen — it is the wrong row in
a long list, and the cost is discovering in three weeks that a shift has nobody
who can actually work it. The message names the person and says where to change
it. *Rejected:* a warning, which is read as noise by the twentieth assignment.

**Rules are read-only on the service screen.** A service's configuration page
lists every active rule that governs a trade on it — program-wide ones
included, because they apply there too and listing only service-scoped rules
would read as "nothing applies" on a programme whose rules are all program-wide.
The link to change them goes to Trade rules, and only appears for a role with
`rules.manage`. *Rejected:* editing rules in two places, which gives two screens
the power to change program policy and no single place that shows it whole.

**An exception must be removable.** `clearResidentOverride` exists because an
override that can be created but never removed is a trap: the first one entered
by mistake would sit in the year forever, and a scheduler who cannot undo a
thing stops using it. The reason stays required on creation — an override with
no reason is indistinguishable from a mistake six months later, and the person
who made it will not be in the room.

**A new draft copies the published schedule by default.** Next month is last
month with things moved, not a blank page. Starting empty is offered and the
consequence is stated in the form: publishing an empty draft deletes every
published shift in the period. *Rejected:* defaulting to empty, which is the
option that silently clears a month.

**Blank-field messages come from the domain, not from Zod or the client.** The
cohort routes cap the label's length but no longer require `min(1)`, and the
client no longer throws its own `Error` for an empty label. Both paths produced
a worse sentence than the domain's — Zod's "some of the information provided
isn't valid", and `useAction`'s generic fallback for a non-`ApiError`. One
authority, one sentence, written for the person reading it.

**`verify` passes `CI` through rather than forcing it.** An earlier version set
`CI=1` so Playwright would always start its own servers. That also turns on
`retries: 1` — wrong for a command whose job is to say whether the tree is good,
because a retried flake reads as a pass — and it makes the native config refuse
to reuse a server, so `verify` failed on any machine with the dev server
running. *Rejected:* forcing `CI=1` for determinism. Real CI sets it itself and
gets both behaviours; locally, reuse is robust and no retries is honest.

**A fresh checkout gets `npm run setup:local` rather than a longer README.**
"Clone, install, verify" did not work: `.env.local` is not committed, correctly,
so a clean checkout has no `DATABASE_URL` and no `AUTH_SECRET`. One command now
creates both databases, writes `.env.local` from `.env.example` with a generated
secret, and migrates. *Rejected:* committing a development `.env`, which puts a
session secret in git and invites someone to reuse it; and leaving the manual
steps in `docs/SETUP.md`, which is fine for a person and a dead stop for an
unattended session. It deliberately does not configure Google OAuth — those are
real credentials that cannot be invented, and the suites do not need them.

**The CI workflow was left as two parallel jobs rather than one `npm run verify`.**
`.github/workflows/ci.yml` already covers the same ground, and its two jobs use
*separate* databases — `shiftswitch_test` for the unit and integration run,
`shiftswitch_e2e` for the browser run — which is a better arrangement than
verify's single serial pass and is why the end-to-end job can run concurrently.
Collapsing it would make CI slower and couple the two. *Rejected:* rewriting
`ci.yml` to call `verify`, which the request allows but does not ask for.
`verify` is usable in CI — no prompts, one exit code — and is the command for a
developer or a session; the workflow is the command for a machine with two
databases and a reason to parallelise.

**Claims about production are labelled as reports, not verified facts.**
Sessions no longer connect to the production database, so its schema is not
observable from a session. Statements about it now name their provenance.
*Rejected:* deleting them, which would lose real information, and leaving them
stated as verified, which is how this document came to contradict itself about
migration `0005`.

## Completed

- **Phase 1–2** — schema, migrations, Google OIDC sign-in, the full trade domain
  (posting, offers, atomic finalisation with row locks, approvals), the rules
  engine, program-notification email, admin tooling. PR #1, merged.
- **Phase 3** — native iOS and Android apps on Capacitor with a bundled React
  client; backend support for native clients (bearer sessions, PKCE sign-in
  handoff, identity linking, push with after-commit dispatch, calendar feeds,
  account deletion); both native projects configured; the complete store
  compliance package. PR #2, merged.
- A signed Android release bundle has been **built and verified** — see Tested.
- **Onboarding** — admin-only invitations (hashed expiring tokens, resend,
  revoke, batch invite, public acceptance page, Google-only acceptance with a
  required email match), the downloadable schedule template and the documented
  column set, manual shift create/edit/delete, and the Google-only sign-in
  wording audit. Migration `0004_invitations.sql`, applied locally **and to the
  production Neon database**.
  PR #3, merged.
- **Baseline audit** — schema/migration verification against production, an
  authorization red team, an idempotency and concurrency pass, the three-role
  leftovers removed from the web and native clients, and observability gaps
  closed. Migration `0006_supporting_indexes.sql`. Applied everywhere.
- **Roles, services and the invitation sandbox** — the five-role model
  (Resident, Chief, APD, PD, Administrator) as an explicit capability matrix
  replacing the old three-tier rank; a Services screen; a conventional
  multi-address invite field; role management with assignment rules; and a
  development-only invitation sandbox. Migration `0005_roles_and_services.sql`.
- **Demo program and schedule architecture** — `ShiftSwitch Demo Residency`
  (21 people, 330 shifts over four weeks, 8 posted switches, a trade in every
  lifecycle state, three invitations in three states) with idempotent, deterministic seed/reset
  commands and a three-gate production interlock; the `ScheduleSource` seam so
  MedHub can become a source later without touching the scheduling model; and
  shift editing extended to move a shift in time.
- **The scheduler** — sites, service configuration, coverage requirements,
  cohorts, configurable block years, resident scheduling data, a scheduler
  dashboard, and draft schedules that can be started, edited, diffed and
  published. Migration `0008_scheduler_foundation.sql`.
- **The constraint model, the validator and the generator** — 30 constraints in
  one catalogue (21 hard, 9 soft), evaluated purely over a snapshot, with a
  deterministic per-objective score; and a seeded generator that the validator
  grades and that explains what would have to give when no schedule fits. Its
  search is bounded by iterations, so a run that finishes is reproducible. No
  migration.
- **The operational workflow** — structured availability
  (`resident_absences`) that merges into the constraint model rather than
  duplicating it; persisted locks that survive a regeneration; an approval step
  before publication, behind its own `schedule.publish` capability; a grid with
  filters, bulk edits, a coverage heat map, an unfilled queue and undo;
  publication that notifies everybody with a shift in the window; a trade
  coverage check that asks the constraint model rather than the rules engine;
  and corrections to a published schedule with a reason, an impact report and a
  visible record. Migration `0009_schedule_operations.sql`.
  See `docs/SCHEDULE_OPERATIONS.md`.
- **The independent audit** — nine defects found and fixed at the root, each
  with a regression test: a capability that stopped a chief configuring the
  generator's input; three scheduler races (overlapping publications,
  approval-withdrawal against publication, two regenerations into one draft); a
  promise the padlock made that no screen kept; every written client-side
  failure message being replaced with "Something went wrong"; a false
  determinism claim; and a missing history entry. Plus a scheduler concurrency
  suite, a static guard sweep over every route handler, and a consistency
  check reformulated to be sound rather than merely strict. No migration.
  See **Audit, 1 August 2026**.
- **Resilience and self-reporting** — every failure path enumerated by walking
  the code (`docs/FAILURE_PATHS.md`, 26 numbered paths across six areas) and
  given a designed outcome:
  route-level error boundaries on the web and in the native client, including a
  `global-error` that renders its own document when the layout itself is what
  failed; mutations that report *not sent* and *we don't know* as different
  things; reads that degrade to a last known state with the time it was
  captured written on it; a schema gate that compares the build's migration
  manifest against `schema_migrations` and refuses with the filename rather than
  failing halfway through; `/api/health` and an administrator-reachable
  `/admin/diagnostics` that prints a plain-language verdict and a copyable,
  resident-free report; and structured error reporting on both sides tagged with
  release, route, role and a six-character reference the resident can read off
  their screen. No migration; the manifest is generated by
  `npm run migrations:manifest`. See `docs/RUNBOOK.md`.

## Demo data

`npm run demo:seed` · `npm run demo:reset` · `npm run demo:status`

Builds **ShiftSwitch Demo Residency**: 18 residents, 2 chiefs, 1 administrator,
six services, 330 shifts across four weeks including overnights and 24-hour
weekend call, 8 posted switches, and invitations in pending, expired and revoked
states. Everything is invented and every address is under `.invalid`, which can
never be delivered to.

It also leaves a trade in **every lifecycle state** — one offer waiting on a
decision, one switch awaiting a chief, one completed, one declined — each
produced by calling the domain functions a resident's taps call, so the
notifications, audit entries and assignment swaps are the real ones.
`npm run demo:status` reports the counts.

Refuses to run unless `NODE_ENV` is not production, the database is local (or
`ALLOW_REMOTE_DEMO_DATA=true` is set deliberately), and neither the database
name nor `APP_URL` looks like production. Every destructive statement is scoped
to the demo program's name.

Deterministic: the same anchor Monday always produces byte-identical data.
Idempotent: a seed removes and rebuilds rather than merging.

Accounts, the trade scenarios and the three invitation scenarios are documented
in `docs/DEMO_DATA.md` and asserted in `tests/integration/demo-data.test.ts`,
which fails if any lifecycle state stops being produced.

The interlock is shared with the other two scripts that issue irreversible
statements — `migrate.ts --reset` and `e2e-fixture.ts` — through
`scripts/db-guard.ts`, so "does this look like production" has one answer rather
than one per script. See `tests/unit/db-guard.test.ts`.

**Multi-person swaps are not supported** — every switch is between exactly two
residents. `trade_legs.leg_index` would accommodate more; the domain does not.

## Roles

Five, in seniority order: **Resident → Chief resident → APD → PD →
Administrator**. Permissions are an explicit capability matrix, not a rank —
`src/server/auth/roles.ts` is the source of truth and `docs/ROLES.md` describes
it.

Guards name a capability (`requireCapability("services.manage")`), the admin
navigation is generated from the same matrix, and a role may only ever be
assigned to somebody strictly junior to the assigner. Nobody may change their
own role.

`tests/unit/route-guards.test.ts` reads every route handler off disk and pins
the capability it requires, with a written exemption list for the seven that
authorise nothing. It exists because the matrix and its enforcement had drifted
once — coverage requirements were guarded by `services.manage` while four
documents said `scheduling.plan` — and nothing detected it, because a missing
or wrong guard is a line of code that is simply not there.

## Environment safety

`src/server/config/environment.ts` answers two separate questions, and they are
deliberately not the same one:

- **Can email reach a real person from here?** Only in a production build *and*
  with `RESEND_API_KEY` set. A staging deployment holding production's
  credentials still sends nothing.
- **Is the invitation sandbox available?** Only outside production *and* with
  `ALLOW_TEST_LOGIN=true`. Two independent locks; a production build cannot
  reach it whatever the flag says.

Every administrative screen shows a badge naming the environment whenever it is
not production-with-email.

### Irreversible scripts

Three of them: `migrate.ts --reset` (DROP SCHEMA), `e2e-fixture.ts` (TRUNCATE
every table, run by every end-to-end spec) and the demo seeder. Only the third
was guarded until this session — the other two executed against whatever
`DATABASE_URL` happened to be exported, and `npm run verify` now runs both on
every invocation.

All three refuse a target that is not demonstrably local, **before opening a
connection**, naming the host and every reason at once. The detection is shared
(`scripts/db-guard.ts`, asserted by `tests/unit/db-guard.test.ts`) so "does this
look like production" has one answer. Each caller opts in to a remote target
under its own variable — `ALLOW_REMOTE_DB_RESET`, `ALLOW_REMOTE_E2E_FIXTURE`,
`ALLOW_REMOTE_DEMO_DATA` — so unlocking one does not unlock the others, and no
override defeats a production-looking database name.

Consolidating it fixed a real gap in the original pattern, which matched the raw
URL: `postgresql://[::1]:5432/db` was treated as remote, pushing somebody toward
setting an override, while `localhost.evil.com` matched as local — which fails
in the dangerous direction. The hostname is now parsed and compared.

## Important configuration

| Thing | Value |
|---|---|
| Bundle / application id | `org.shiftswitch.app` — **placeholder**, must be changed to a domain the institution controls before the first store upload; it can never be changed after |
| App version | 1.0.0, versionCode 1 (`mobile/version.json` is the single source of truth for both platforms) |
| Android target SDK | 36, min 24 |
| Android permissions | `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS` declared; `VIBRATE`, `WAKE_LOCK`, `c2dm.RECEIVE` merged in by the push plugin. CI fails if this set changes |
| Custom URL scheme | `shiftswitch://` (sign-in handoff only) |
| Legal URLs | `/legal/privacy` and `/legal/terms`, public, no sign-in |
| Dev signing key | `~/.shiftswitch-dev-keys/dev-upload.jks` — **outside the repo, never for release** |
| Production URL | `https://shiftswitch.vercel.app` — public, no deployment protection |
| Vercel env vars | Set on **production** only: `APP_URL`, `NEXT_PUBLIC_APP_NAME`, `DATABASE_SSL`, `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. `DATABASE_URL` is managed by the Neon integration and must not be overridden |
| `BOOTSTRAP_ADMIN_EMAILS` | **Removed**, and production redeployed to drop it, now that an administrator exists. It was already inert — the bootstrap only fires while the instance has no administrator at all — but leaving it set would make it live again if that account were ever deleted |
| Invitation email | **Not configured.** `RESEND_API_KEY` is the single credential that would enable automatic delivery. Without it invitations are created normally and the administrator sends the link — nothing reports a delivery that did not happen |
| First program | **Internal Medicine / DUH / America/New_York** — corrected from the placeholders by the administrator. The timezone governs every shift time, so it is worth a second look before the first import |
| Administrator | One, the repository owner's Google account: role `admin`, identity linked, first sign-in 31 July 2026 17:29 UTC |
| Vercel project | `shiftswitch`, team `rosario608-2488s-projects`, builds from `main`, root directory. Preview deployments are SSO-protected; production is not |
| Database | Neon, PostgreSQL 17.10, region us-east-1. Migrations `0001`–`0007` reported applied as of 31 July 2026 — `0001`–`0006` by the runner, `0007` by hand in the Neon SQL Editor with a matching `schema_migrations` row. `0008` **not applied**; see Current status. Contents when last reported: 1 program, 1 user, 0 residents, 0 services, 0 shifts |
| Connection pooling | The **pooled** Neon endpoint is safe — verified empirically, see docs/DEPLOYMENT.md |

Secrets are never in the repository. `.env.production`, `key.properties`,
`*.jks`, `*.p8`, `*.p12` and `google-services.json` are all git-ignored.

## Defects found and fixed, by session

The most recent are under **Audit, 1 August 2026**, near the top. The sections
below are earlier sessions, newest first. They are kept rather than summarised
because several of them explain *why* a piece of code looks the way it does, and
a later session that does not know will simplify the defect back in.

### Defects found and fixed (resilience session)

Four, all found by running the thing rather than reading it — three of them by
`npm run verify` refusing the tree the resilience work had just produced.

1. **Two screens still rendered a mid-flight failure as a flat refusal.** The
   mechanical pass that replaced `Alert tone="error"` with `ActionAlert` missed
   `corrections-panel.tsx` and `draft-shift-editor.tsx`, because neither took
   the message from a `useAction` state in the shape the sweep matched — the
   corrections sheet took a `string | null` prop and the draft editor hand-rolls
   its own request state. So the one case the whole change exists for, a
   connection dropping mid-write, appeared in red as *it failed* on the two
   screens that move a real resident's shift. Both now carry the action itself.
2. **A correction was never announced.** The result banner had no live region,
   so a chief using a screen reader submitted the sheet, watched it close, and
   was told nothing — including who had been notified, which is the part they
   need. It is `role="status"` now. Found because the end-to-end assertion could
   not tell the banner from the badge on the row it had just created.
3. **The red-team indistinguishability check was broken by the request id.**
   Every response now carries one, so two refusals necessarily differ — the test
   compared whole bodies and failed. The property it defends is still right, so
   it now asserts the reference separately (present, six characters, and
   *different* between the two requests, which is what proves it is not derived
   from the resource) and compares everything else.
4. **`npm run verify` could be defeated by a dev server somebody left running.**
   `next dev` and `next build` share `.next`, so the build step corrupts the
   running server, and what surfaces four minutes later is a handful of
   end-to-end tests failing on `ECONNRESET` and phantom strict-mode violations —
   indistinguishable from flakes, and it cost this session a full twelve-minute
   run before the cause was clear. The script's own header already reasoned
   about this ordering; it just never checked. `preflight()` now refuses the run
   and says why. The Playwright web-server timeout went from two minutes to
   four at the same time, because a cold start on this filesystem after a build
   can outrun the default, and that too reads as "the suite is broken".

### Defects found and fixed (baseline audit)

1. **Program leadership could not reach administration.** The app shell, the
   profile page, the shift detail page and the switch detail page all tested
   `role === "chief" || role === "admin"` literally. A PD or an APD signed in,
   saw a resident's application, and had no route to the admin area at all
   unless they knew the URL — and the header badge called them "Chief". All four
   now derive from a capability. Regression test in
   `tests/e2e/roles-and-onboarding.spec.ts`.
2. **Two simultaneous invitations for the same address crashed** on the partial
   unique index, surfacing a message naming a database constraint. The
   supersede-then-insert is read-modify-write; it is now serialised with a
   transaction-scoped advisory lock keyed on program and address.
3. **The same race existed for services**, with the same fix.
4. **The native client only knew three roles.** Its `UserRole` union, its
   administrative-area check and its profile label all predated APD and PD. It
   now has its own labelled copy of the vocabulary (it cannot import server
   code) plus a test that stops the copy drifting.
5. **Four database failures bypassed the structured logger** — idle client
   errors, after-commit failures and rollback failures went to `console.error`,
   so they were the only errors in the application not captured as JSON and not
   passed through the redactor.
6. **Five foreign keys had no supporting index** on paths that scan them: the
   Services screen counted rotation shifts with a sequential scan per rotation
   (confirmed with EXPLAIN), and every shift deletion scanned `completed_trades`
   and `trade_legs` in full to enforce ON DELETE RESTRICT.

Two things examined and deliberately **not** changed:

- A deactivated account observes 401 rather than 403, because the session query
  declines to resolve it before the guard runs. Access is denied either way, the
  Google callback explains the reason at sign-in, and deactivation deletes every
  session the user held. The guard's `active` check is unreachable-by-
  construction and is documented as belt-and-braces rather than removed.
- A malformed identifier produces a different message from a well-formed one
  that does not exist. That distinguishes only what the caller already knows —
  the shape of the id they typed. A well-formed id belonging to *another
  program* is indistinguishable from one that exists nowhere, which is the
  property that matters and is now asserted.

### Defects found and fixed (roles/services session)

Reported from hands-on use, plus two the new tests surfaced:

1. **The invite field could not be typed in.** Root cause was not the field —
   `Sheet`'s focus effect depended on `onClose`, which every caller passes as an
   inline arrow, so its identity changed on every render. The effect re-ran on
   every keystroke and pulled focus back to the sheet's close button. Every
   sheet in the app was affected: shift editor, offer sheet, service sheet. The
   effect is now keyed on `open` alone, with `onClose` held in a ref.
2. **The invite field was a textarea with parsing rules you had to know.**
   Replaced with a conventional chip input: Enter/comma/semicolon commit,
   pasting a list or a spreadsheet column works, each address is a removable
   chip, invalid ones are flagged red and duplicates amber, individually.
   Separators are detected from the value rather than the keystroke, because
   Android soft keyboards report punctuation as keyCode 229.
3. **There was no way to add a service.** They only existed as a side effect of
   importing. Added **Admin → Services** with create, rename, short name,
   swappable flag, deactivate/reactivate, and case-insensitive duplicate
   prevention.
4. **Accepting a *chief* invitation created no resident record.**
   `acceptInvitation` checked `role === "resident"` literally, so every invited
   chief got an account that could not hold a shift or trade — the exact failure
   the surrounding comment warned about. Now uses the shared
   `expectsResidentRecord` predicate.
5. **Roles were a three-tier rank** (`resident < chief < admin`) with
   permissions expressed as `rank >= n`. Replaced with five roles and an
   explicit capability matrix.

### Defects found and fixed (resident experience & trade lifecycle session)

Twelve, all found by tests or by walking the product as a resident, all fixed at
the root with regression coverage. The last three are the serious ones.

**Dead ends a resident could reach**

1. **A declined offer vanished completely.** `listMyTradeActivity` returned only
   live offers, so the moment an offer was declined it left every screen. The
   resident got a notification saying it had happened and found nothing in the
   app that agreed. There is now a **Recently closed** section — two weeks of
   resolved postings and offers, each with the reason in plain English.
2. **"No offers yet" under a "Pending approval" badge.** The line counted
   *pending* offers, and accepting one makes it non-pending, so a posting waiting
   on a chief contradicted itself about the one thing the resident opened it to
   learn. It now describes the state.
3. **Tapping a notification about an offer led to the trades board** — the list
   of everyone else's postings, with no mention of the offer. The in-app list
   re-derived a link from the related entity and had no case for `trade_offer`,
   while push used a different derivation that did. The route is now **stored on
   the notification** (migration `0007`) by the code that knows what it is about,
   and both surfaces read that one value.
4. **A decline notification was just the reason text** — "I need something
   earlier in the week" — naming no shift. A resident with two offers out could
   not tell which. It now names the shift.
5. **`invalidateOffer` sent no route at all**, which is the notification a
   resident is least able to act on: they did nothing, somebody else's offer was
   accepted first. It also said "An offer is no longer available"; it now says
   "Your offer", and leads to the posting.

**Five-role gaps left by the earlier session**

6. **`listProgramApprovers` was `role IN ('chief','admin')`.** A program whose
   approver was a PD or APD raised approval requests that notified *nobody* — the
   queue filled up silently and the only symptom was switches that never moved.
7. **`assertApprover` refused APDs and PDs.** The approvals queue is guarded by
   `requireCapability("approvals.decide")`, so an APD could open it, see the
   switches waiting, press Approve, and be told they were not allowed.
8. **An invited PD was emailed "You have been invited as a resident."** The role
   label was a three-branch conditional whose `else` was "resident".
9. Three more hardcoded `chief || admin` checks (`dashboard`, `email`,
   `cancelTradeRequest`). All now read the capability matrix; `rolesWith()` was
   added so a role *list* is never hand-written again.

**Rule messages** (goal item 4)

10. **Six rule messages showed raw ISO dates** — "2026-08-10 is a blackout
    date". Messages also omitted the numbers (`detail` is rendered only on the
    chief's page, so a blocked resident was never told the limit) and duplicated
    the resident's name, which both surfaces already print. All rewritten;
    `tests/unit/validation.test.ts` now asserts these as properties across every
    message the engine can produce, so a rule added later cannot regress them.

**Data integrity — found by the new concurrency suite**

11. **An expired posting could still complete.** `acceptOffer` checked the
    offer's expiry but never the posting's. The two normally agree, because an
    offer inherits the posting's deadline — but only at creation, so a posting
    whose shift was moved earlier expires first, and until the sweep caught up a
    tap could still complete a switch on a closed posting.
12. **Shifts leaked into a permanently untradeable state**, three separate ways:
    `invalidateOffer` never released the offered shift; `invalidateTradesForShift`
    released nothing at all, so an administrator reassigning a shift stranded
    every shift offered on it; and an expiring posting closed itself without
    closing its offers. A stranded shift sits in `offer_pending` with no trade
    referencing it, and `postShiftForTrade` refuses anything not `scheduled` —
    so the resident permanently lost the ability to trade that shift, with no
    error and nothing on any screen to explain it.
13. **`releaseShiftIfIdle` had a read-modify-write race.** Two transactions
    closing two different offers on the same shift each counted before the other
    committed, each still saw one live offer, and neither released it. Both were
    individually correct and the shift was stranded. It needed genuine
    concurrency to produce — running the same sequence one call at a time never
    reaches it. The shift row is now locked first.

### Defects found and fixed (demo data & lifecycle session, earlier)

All found by tests that did not exist before, and all fixed:

1. **`scripts/seed-demo.ts` configured four rule types that do not exist**
   (`max_consecutive_days`, `min_rest_between_shifts`, `pgy_level_match`,
   `max_hours_per_week`). `rules.rule_type` is plain text with no foreign key, so
   the rows inserted happily and were then never evaluated — the App Review demo
   program looked governed and was not, which is the one thing that seeder exists
   to avoid. Corrected to the real identifiers, and **both** seeders now refuse
   to insert a rule type with no registered handler.
2. **`scripts/seed-demo.ts` could be run once but not twice.** It deleted users
   before shifts, and `shift_assignments.resident_id` is ON DELETE RESTRICT, so
   the second run failed on a foreign key despite the file claiming re-running
   was safe. Fixed by deleting in dependency order.
3. **Editing a shift into a daylight-saving gap returned a 500.**
   `zonedWallTimeToInstant` correctly refuses a wall-clock time that does not
   exist, but `updateShift` let the error escape untranslated. It is now a 422
   carrying the explanation.
4. **The first version of the demo schedule violated the program's own
   `max_consecutive_shifts` rule** — a Sunday ward shift chained into the
   following Monday, giving seven days in a row before any trade. Every candidate
   in the demo was therefore ineligible for a reason unrelated to the trade being
   demonstrated. Patterns now stop at six days and Sunday is covered by the
   weekend call shift, which is asserted directly.
5. **The import's "unknown resident" message told administrators to add people
   under Users**, which predates invitations. It now says to invite them.

## The scheduler foundation

Migration `0008`. Everything additive: the trade lifecycle, shifts, assignments
and services all behave exactly as before, and a programme that never opens the
scheduler screens sees no change.

The idea running through all of it: **a programme's shape is data.** Block
length, pairing, coverage patterns, PGY mix and the service list are rows, not
constants.

| | |
|---|---|
| **Sites** | Where a service happens. Site eligibility per resident is a real constraint with credentialing behind it, not a note in a location string |
| **Service configuration** | Site, PGY eligibility, typical shift length, mandatory coverage, tradeability, notes and contact |
| **Coverage requirements** | How many people, when. One table with a `scope` discriminator — weekday, date range, one named day — because a scheduler reads them as one list. Most specific wins, resolved in `requirementsFor` so nobody has to remember the order |
| **Block structures** | An ordered list of named date spans. `generateBlocks({weeks, count, kinds})` produces them; **4+4 is `weeks: 4` with two kinds**, a fortnightly programme is `weeks: 2`, a thirteen-block year passes no kinds at all |
| **Cohorts** | Groups within a PGY class, paired reciprocally so they alternate. Membership is a table because it carries dates: a resident who moves cohort in January must still be findable in September's schedule |
| **Resident scheduling data** | Phone (validated, normalised, capability-gated), schedulability separate from account status, preferences, constraints, site eligibility |
| **Schedule versions** | Draft and published. `shifts.schedule_version_id` is null for a live shift, so **null means published** and nothing needed backfilling |

**"Weekend" is not a scope.** Programmes disagree about whether Friday night
counts, so `days_of_week` says exactly which days and "weekend" is a preset in
the interface.

**Publishing replaces the live schedule within the draft's window only**, which
is what makes it safe to publish one block without disturbing the year. It
refuses when a live shift in the window is entangled in a trade, and names who
is involved — cancelling two residents' agreed switch as a side effect of
publishing is not something to do silently. The override is a second explicit
confirmation and is audited.

A **database trigger** refuses a trade request against a versioned shift. A
query filter is something a future query can forget; a trigger is not.

**A draft can be started, edited and thrown away entirely from the interface.**
"Start a draft" is on the scheduler and defaults to copying the published
schedule for the period; the draft's own page lists its shifts with an inline
picker for who is on each one, above the diff and the publish button.
`listDraftShifts` / `assignDraftShift` / `removeDraftShift` are separate from
the live editor in `admin.ts` and deliberately cheaper — see **Decisions**.
The page loads the first 300 shifts and says so when there are more.

**A service's screen lists the rules that govern a trade on it**, read-only,
program-scoped rules included, with a link to Trade rules for a role that may
change them.

**One resident off their cohort's block is a row, not a note.**
`resident_block_overrides` is created and removed from the cohorts screen; the
reason is required, and `clearResidentOverride` exists so the first one entered
by mistake is not permanent.

### The default service library

`src/server/domain/service-templates.ts`. Duke Internal Medicine as a starting
point: wards, MICU, CICU, cardiology, malignant haematology, neurology, ED,
night medicine, day float, ambulatory, consults, electives, and VA and community
sites. Applying it is `createService` plus `createCoverage` in a loop — the same
calls the Services screen makes — so a service added by hand is
indistinguishable afterwards and **a new local service needs no code change**.

It skips what already exists rather than overwriting, and says what it skipped.
The interface presents it as one programme's answers rather than as correct,
because a template accepted as authoritative at eleven at night is how a
programme ends up with the wrong MICU staffing all year.

## Concurrency

`tests/integration/concurrency.test.ts` races accept against every other verb —
cancel, withdraw, decline, an administrator reassigning or cancelling a shift,
the expiry sweep — plus two chiefs deciding at once, and an uncoordinated storm
of six residents firing everything in parallel.

`tests/integration/scheduler-concurrency.test.ts` does the same for the
scheduler, and the blast radius is worse: a trade that tears leaves two
residents confused about one shift; a publication that tears leaves a month of a
programme's schedule wrong, and nobody finds out until somebody does not turn
up. It races two schedulers editing one draft, two publications of one draft,
two **overlapping** drafts publishing at once, publication against an accept, a
correction against an accept, two corrections, two regenerations, a lock landing
mid-regeneration, an approval being withdrawn as a schedule publishes, and a
storm of all of it at once.

The assertion that matters is `assertDatabaseConsistent()` in
`tests/integration/helpers.ts`, run at the end of each. Counting successes is not
enough: "one accept won and one lost" is compatible with a database in which a
shift has two holders or a switch was recorded but never applied. It checks that
no shift has two holders, that a live shift with nobody on it is explicable,
that every completed switch has two legs and actually swapped the two residents,
that nobody is in two places at once, that no offer is left accepted on a
finished request, and that no shift claims to be in a trade that does not exist.

The invariants about *when* something was true are reconstructed from
`shift_assignments` history rather than read off current rows, because "was this
state ever impossible" and "is this state wrong now" are different questions and
only the first is about atomicity.

**Three of the trade defects, and three of the scheduling ones, were found this
way and by nothing else.** The scheduling suites are run **twelve consecutive
times** when they change; anything below 12/12 is treated as a defect rather
than flakiness, and taking that seriously is what exposed both the unsound
timestamp comparison in the consistency check and the generator's time-bounded
search — each of which looked exactly like an intermittent test and was in fact
a wrong assertion and a wrong claim. Last run: **12/12**.

## Known issues

- **iOS has never been compiled.** Building it needs Xcode, so macOS. The
  project, entitlements, privacy manifest and icons are complete and committed,
  but nothing about the iOS binary has been observed.
- **Push delivery is untested.** Without FCM/APNs credentials the no-op
  transport records every attempt as *skipped*; it never claims delivery.
- **The Capacitor plugins are untested on a device** — secure storage, push
  registration, the OS back button, haptics. They have no browser
  implementation, so the end-to-end suite cannot reach them.
- **Preview deployments share the production database.** The Neon integration
  set `DATABASE_URL` for all three targets, so a pull-request preview writes to
  production data. Previews are SSO-protected, so this is not urgent, but a
  separate Neon branch for preview should be configured before anyone else
  works on the repository. A session cannot do it — it is hosted infrastructure,
  and reaching production is forbidden. Listed first under **User action
  required**.
- **CI is not yet a *required* check.** It runs on every pull request and
  reports its verdict, but branch protection is a repository setting rather than
  a file, so nothing currently stops a red pull request being merged. One
  five-minute setting, written out step by step in `docs/RUNBOOK.md` and listed
  fifth under **User action required**.
- **A large programme's generated schedule is not reproducible.** The
  improvement search is bounded by iterations, so a run that *finishes* is
  byte-identical on any machine; each iteration re-scores the whole schedule, so
  a large programme hits the time budget first and that run depends on how busy
  the server was. It is reported — `stoppedOnBudget`, and the scheduler is told
  in those words — rather than hidden. The fix is incremental scoring; see
  `docs/GENERATOR.md`.
- **Multi-person swaps are not implemented.** Every switch is between exactly
  two residents; `finaliseTrade` writes two legs. The schema would carry more.
  Nothing in the product claims otherwise.
- **No invitation has been *accepted* through a real Google account.** The live
  path was verified up to Google's own consent screen (see Tested); the step
  past it needs a second human Google account and cannot be automated. The
  redemption logic itself is tested directly with the identity the callback
  supplies, and the callback's signature verification against a local OpenID
  provider.
- **No per-resident load view.** A PD arriving with "who is carrying the
  programme" cannot answer it here: the roster holds every resident's shifts and
  nothing renders them as a comparison. Named under **Decisions → The three
  questions each role arrives with** as the one question of the twelve that the
  product does not answer. It is a screen, not a schema change — the data is
  already there.
- **No error-reporting service is configured.** With `ERROR_REPORTING_DSN`
  unset — which is the current state everywhere — reports go to the log and
  record `delivered: false` rather than pretending. The envelope transport that
  sends them to a service is written and unit-tested against a fake endpoint,
  but no report has ever been *received* by one, because there is nothing to
  receive it. Everything else in the diagnostic chain works without it:
  `/api/health` and `/admin/diagnostics` read the live system directly.
- **Client stacks are minified in production and are not symbolicated.** Source
  maps are deliberately not published — see **Decisions → Failure**. A client
  report therefore carries the error's name and message (which survive
  minification), the scrubbed route, the release and the request id, but not
  legible line numbers. The server side is unaffected: its stacks are logged
  unminified.
- **One unexplained log line.** During an end-to-end run a single
  `api.rejected … /api/admin/schedule-workspace … "The request body was not
  valid JSON."` appeared while the browser was navigating away from the grid.
  Every caller of that route sends `JSON.stringify(...)`, and the shape is
  consistent with a request aborted mid-flight being logged as a client
  validation failure — but that is a hypothesis, not something reproduced
  deliberately. No user-visible effect; recorded rather than tidied away,
  because an aborted request logged as a client fault is misleading in
  production.
- **App Links / Universal Links are unverified.** The route-parsing logic is
  unit-tested, including that it refuses foreign origins, but verification needs
  a real host and a real device.

## Tested

**`npm run verify` exits 0.** That is the whole answer, and the only one worth
quoting — it runs every row below in one command with one exit code. Last full
run: 10 steps, **942 seconds**, 1 August 2026, on the tree the resilience
session left behind.

| Step | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | clean |
| Lint, server + web | clean, no warnings |
| Lint, native client | clean |
| Server unit + integration (`vitest run`) | **735 passed**, 41 files |
| Native client unit (`npm --prefix mobile run test`) | **37 passed**, 6 files |
| Production build (`next build`) | succeeds |
| Web end-to-end (`playwright test`) | **172 passed**, mobile + desktop projects |
| Native end-to-end (`--config playwright.mobile.config.ts`) | **16 passed**, including the 9 screenshot specs |
| Migrations from scratch (`migrate.ts --reset`) | **0001–0009 apply to an empty database** |
| Integration suite against the rebuilt schema | **411 passed**, 22 files |

960 distinct tests. The final 411 is the integration subset re-run against the
freshly rebuilt schema, which is why it is not added again.

The run before this one **failed**, at the web end-to-end step, and is worth
recording rather than tidying away: three of its four failures were real
defects in the resilience work and one was `verify` being defeated by a dev
server left running. All four are under **Defects found and fixed (resilience
session)**.

Run **separately** from `verify`, because it is about flakiness rather than
correctness: the two concurrency suites plus `schedule-lifecycle`, twelve
consecutive times — **12/12**. See **Concurrency**.

Also verified by execution, not inspection:

- Android debug APK, R8-minified release APK (1.64 MB) and a **signed** release
  AAB (2.44 MB) all built; certificate, permission set and non-debuggability
  checked with `keytool` and `aapt2`.
- The production bundle contains no test-login path, no local API URL and no
  source maps — and a production build **refuses** `VITE_ALLOW_TEST_LOGIN=true`.
- `npm run setup:production` refuses a development configuration without
  changing anything, completes against a clean database, and is idempotent on
  re-run.
- `scripts/seed-demo.ts` builds the isolated reviewer program.
- The CI permission gate was run against the real APK.
- **Against the real Neon database:** all three migrations applied, all 7 core
  tables confirmed readable, and row locking verified correct through the
  pooled endpoint (a competing transaction blocked 1535 ms for a 1501 ms hold;
  ten concurrent read-modify-write transactions lost no updates).
- **Against the live production deployment** (no env vars set): `/legal/privacy`
  and `/legal/terms` return 200 publicly, which is what both stores require;
  `/api/session` returns `{"authenticated":false}` without touching the
  database; both `/.well-known` deep-link files are served; and all five
  security headers are present, including HSTS with preload.
- `next build` succeeds with no environment variables at all, so a fresh
  deployment cannot fail at build time for want of configuration.
- **Against the fully configured production deployment:** `/calendar/<bad token>`
  returns 404 "Calendar not found", which proves the app reached the database
  and ran the query rather than failing to connect; and
  `/api/auth/google/start` returns a redirect to `accounts.google.com` carrying
  the correct client ID, the production callback as `redirect_uri`, and a PKCE
  `code_challenge`.
- **The Google OAuth client is valid**: Google's authorisation endpoint
  returned 302 to its sign-in page for this client ID and the production
  redirect URI, so the client exists and the URI is registered.
- **The authorization red team** (`tests/e2e/red-team.spec.ts`, 9 tests, driven
  over real HTTP against a fixture that now contains a **second program** and a
  **deactivated account**): deactivating an account kills the session it is
  already holding and deletes it, so reactivating does not hand the old cookie
  back; another program's administrator can neither list nor patch this
  program's users, shifts or services, and a guessed identifier changes nothing;
  a payload cannot move a user between programs; a resident cannot patch
  themselves to administrator; an unconfigured account is refused on every
  route, not only the home page; a well-formed identifier from another program
  is indistinguishable from one that exists nowhere; a native bearer token
  carries exactly the same limits as a cookie and a tampered one carries none;
  and the invitation sandbox derives its identity from the invitation, so it
  cannot be pointed at somebody else's.
- **Idempotency and concurrency** (`tests/integration/idempotency.test.ts`,
  11 tests): simultaneous and repeated invitations leave exactly one live
  invitation with exactly one working token; a refused invitation writes
  nothing; revoking twice produces one audit entry; simultaneous service
  creation produces one service and a readable conflict for the losers;
  double-tapped renames and deactivations settle; repeated role changes leave
  one resident record; and audit entries and shift assignments survive the
  deactivation of the people in them.
- **Migrations from empty** — `0001`–`0009` applied to a brand-new database, as
  a step of `npm run verify`, with the integration suite then run against the
  rebuilt schema. An earlier session additionally compared the resulting schema
  field by field against the development database and against production and
  found all three identical; that comparison covered `0001`–`0006` and has not
  been repeated, because sessions no longer connect to production.
- **The self-test path** (`tests/e2e/roles-and-onboarding.spec.ts`, 15 tests):
  an administrator finds Services in the navigation and creates one, is refused
  a case-insensitive duplicate and a deactivation that would strand upcoming
  shifts; the invite field is driven the way a person drives it (Enter, comma,
  semicolon, an invalid address, a duplicate, Backspace-to-edit, per-chip
  removal); a synthetic resident and a synthetic chief are invited, accepted
  through the sandbox, and land with the right role, program and resident
  record; a resident is refused every administrative route; a chief gets the
  schedule and approvals but not users, services or settings; an APD gets people
  and services but not program settings or maintenance; a PD can rename the
  program but cannot appoint a peer or touch an administrator; nobody can change
  their own role; and a revoked invitation cannot be accepted even in the
  sandbox.
- **The whole lifecycle over real HTTP** (`tests/e2e/lifecycle.spec.ts`, 8
  tests): an administrator signs in, invites, watches a superseded link die and
  the current one work, is refused when inviting an existing member, downloads
  the template, previews an import (writing nothing), commits it, re-imports it
  idempotently, is refused a PDF renamed `.xlsx` and a file with the wrong
  columns, then moves a shift in time, reassigns it, is refused an impossible
  edit, creates one by hand and deletes it — after which a resident posts a
  shift, a colleague sees ranked candidates and offers, the wrong person is
  refused the acceptance, the right one completes it, both schedules move, and
  the same offer cannot be accepted twice.
- **The onboarding path end to end** (`tests/integration/onboarding.test.ts`):
  an empty program, two residents invited, both accepting with the Google
  identity the OAuth callback would supply, a CSV block imported, each resident
  seeing only their own shifts with the overnight row stored as one 12-hour
  shift, and a completed post-and-offer between them. Google itself is the only
  substituted piece; the signature verification that produces the identity is
  covered in `tests/integration/oidc.test.ts`.
- **The authorization boundaries around it** (`tests/e2e/security.spec.ts`,
  driven over HTTP against the real server): a resident gets 403 on the import
  template, the import preview, the import commit, the invitation list, invite
  creation, resend and revoke; a chief gets 403 on everything invitation-related
  but 200 on the import template; an invitation link shows nothing but the
  program and the invited address, and an unissued or revoked token renders the
  same neutral message as an expired one.
- **The health check and the schema gate** (`tests/unit/health.test.ts`,
  29 tests; `tests/integration/health.test.ts`, 10 tests). The unit tests cover
  the comparison — missing, changed, unexpected, and every combination — the
  scrubbers, the request id's alphabet and header validation, and that
  `checkAuth` is failed in production and degraded only where the test door is
  open. The integration tests do it against a real database and end by rendering
  the **copyable report**, because that string is the deliverable: the three
  states the goal named — healthy, a migration missing, a database that cannot
  be reached — each produce the right verdict in the payload *and* in the text,
  the outage is never reported as drift, the connection string never appears,
  the verdict recovers the moment the migration is applied without a redeploy,
  and the drift is reported once per verdict rather than once per refused
  request.
- **Honest behaviour on a bad network** (`tests/unit/offline.test.ts`,
  14 tests). The three delivery states and their wording: a mutation refused
  before anything is sent says so with certainty, a connection that drops
  mid-flight refuses to claim it failed, a server that answers is certain either
  way, the request id is taken from the header when the body has none, a crash
  report's route keeps its shape and loses its ids, and a cached page's age is
  labelled in minutes, hours or a weekday — and says nothing at all rather than
  guessing when the stamp is unreadable.
- **The service worker's own rules** (`tests/unit/service-worker.test.ts`,
  10 tests). It only registers in a production build and the browser runs it in
  a scope no end-to-end test can drive, so it is loaded as source into a fake
  worker global and actually executed: a `POST`, `PATCH` or `DELETE` is never
  intercepted online *or* off; `/api/` is never cached; a resident's page is
  fetched network-first and stored stamped with the moment it was captured;
  that stamp survives to the offline read; the admin area is not stored at all;
  a foreign origin is left alone; the activate handler drops the previous
  version's caches; and the file registers no `sync` handler, which is how an
  offline queue would arrive by accident.
- **What a resident and an operator see when it goes wrong**
  (`tests/e2e/resilience.spec.ts`, 10 tests, in a real browser with the network
  severed and throttled rather than simulated): `/api/health` answers without a
  session and says nothing about any person; every response carries an id a
  resident can read out, and a refusal carries the same id in the body where the
  app can show it; a mutation with the network severed says it does not know
  rather than that it failed; a slow network shows progress and then resolves,
  never an endless spinner; an administrator can read a plain-language verdict
  and copy a report; a resident and a chief are both refused the diagnostics
  page; and a client crash report reaches the server naming no one. Refusing a
  mutation while *already* offline is covered in `mobile-ux.spec.ts`, where it
  has been since the resident-experience session.
- **The demo seeder** (`tests/integration/demo-data.test.ts`, 24 tests): the
  interlock refuses production, a remote database without explicit opt-in, a
  production-looking database name and a production-looking `APP_URL`; the
  seeded program has the documented shape, uses only `.invalid` addresses, gives
  nobody a sign-in identity, stores overnight shifts as 12 hours and call as 24,
  puts weekday sessions on weekdays, and does not violate its own rules; all
  four trade scenarios behave as documented; seeding twice from nothing produces
  byte-identical data; and a reset after a completed switch removes everything.
  The CLI was also run for real: seed, seed again, status, reset, and refusals
  with a non-zero exit for `NODE_ENV=production` and a remote database.
- **Manual schedule management** (`tests/integration/schedule-admin.test.ts`,
  14 tests): moving a shift in date and time together, moving only the date,
  turning a day shift into an overnight one without splitting it, refusing an
  end before the start, the DST gap and the repeated hour, invalidating live
  offers with a notification, reassigning and unassigning, and the schedule
  source seam.
- **The live invitation path, against production, on 31 July 2026.** A real
  invitation row was seeded in the live program and every check was made against
  the production server: the public page renders the program name, institution,
  invited address and inviter; it offers only "Continue with Google"; the
  handoff carries the token; `/api/auth/google/start?invite=…` returns 307 to
  `accounts.google.com` with a PKCE `code_challenge`, and the token travels in
  an HttpOnly cookie rather than the redirect URL. Revoking killed the link
  immediately and the page stopped offering sign-in. The invitation was then
  deleted — production has zero invitations and is exactly as it was.
- **The live sign-in page carries no non-Google wording** — fetched from
  production and checked for "hospital log-in", "institutional", "single
  sign-on" and "password". Only "Continue with Google" and "the Google account
  your program has on file" are present.
- **The mobile production bundle builds against the real host**
  (`https://shiftswitch.vercel.app`): no test-login path, no source maps, no
  local URL, and the production host present in the bundle.
- **`npm run check:release` against the real host, the real database and the
  real OAuth credentials now passes with no blocking problems** — one warning
  only, that no FCM credentials are configured, so push is skipped rather than
  claimed. (An earlier run reported the OAuth credentials missing; they have
  since been set.)

The native end-to-end suite is the one that matters most: it serves the compiled
client from its own origin, exactly as the Capacitor webview does, and drives it
against a real server and database, so every request crosses CORS with a bearer
token. It has already caught three real defects.

## Where things are

| | |
|---|---|
| Release process, every human step | `docs/MOBILE_RELEASE.md` |
| Pre-submission checklist | `release/RELEASE_CHECKLIST.md` |
| Store listing copy | `release/METADATA.md` |
| Reviewer notes and demo accounts | `release/REVIEWER_NOTES.md` |
| Apple privacy answers | `APPLE_APP_PRIVACY_DECLARATION.md` |
| Play data safety answers | `GOOGLE_PLAY_DATA_SAFETY.md` |
| What was and was not verified | `VERIFICATION_REPORT.md` |
| Why Capacitor | `docs/MOBILE_ARCHITECTURE.md` |
| Server deployment | `docs/DEPLOYMENT.md` |
| Inviting residents and importing a schedule | `docs/ONBOARDING.md` |
| The synthetic demo program and its scenarios | `docs/DEMO_DATA.md` |
| Roles and the permission matrix | `docs/ROLES.md` |
| Standing rules for every session | `/CLAUDE.md` |
| The rules engine and how failures are worded | `docs/RULES.md` |
| The constraint model and the schedule validator | `docs/CONSTRAINTS.md` |
| The draft schedule generator, and what determinism does and does not hold | `docs/GENERATOR.md` |
| Approving, publishing, correcting; availability and locks | `docs/SCHEDULE_OPERATIONS.md` |
| When something is wrong, for the person who does not troubleshoot | `docs/RUNBOOK.md` |
| Every way this can fail, and what happens then | `docs/FAILURE_PATHS.md` |
| What each suite covers | `docs/TESTING.md` |

## Rules for this project

The standing rules live in **`/CLAUDE.md`**, which every session reads
automatically: no questions during a goal, no waiting for data that does not
exist, no touching the production database, no role literals, commit per
sub-objective, and `npm run verify` as the definition of done.

These are the release-specific ones it does not cover:

- Three states, never confused: **ready for submission** → **submitted** →
  **published**. Only say "published" after seeing it live in the developer
  console.
- Never claim something works without having run it. This document quotes
  numbers from an actual run, and labels anything it cannot re-check.
- Never commit a signing key, a keystore password, a service-account file or a
  production env file.
- Never point a store build at a development database or a local URL.
- Never give a reviewer access to a real resident, schedule, email address or
  leave record — `scripts/seed-demo.ts` builds the isolated reviewer program.
