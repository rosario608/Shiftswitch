# Project state

Authoritative checkpoint for any new session. **Read this first**, inspect only
what the current task needs, verify with targeted commands, and continue.

Last updated: 31 July 2026, after making the repository runnable unattended:
`/CLAUDE.md`, a single `npm run verify`, guards on every irreversible script,
and this document reconciled against the code by inspection.

Before that, the resident-facing product and the trade lifecycle audit: dead
ends, rule wording, notification routing, five-role gaps, and concurrency.

---

## Current phase

`VERIFIED_BASELINE`

## Current status

Live at `https://shiftswitch.vercel.app` with one administrator and the program
named **Internal Medicine / DUH / America/New_York**. No residents, services or
shifts in production yet.

`npm run verify` exits 0 on this tree, and from a clean clone whose only
preparation was `npm ci && npm run setup:local`. That is the one claim about
this repository that is checked rather than asserted, and it is checked in
full — see **Tested**.

### Migrations

| | |
|---|---|
| In the repository | `0001` – `0007` |
| Applied locally, and proven to apply to an **empty** database in order | `0001` – `0007` |
| Reported applied to production by the session of 31 July 2026 | `0001` – `0006` |
| **Not applied to production** | **`0007_notification_route.sql`** |

**`0007_notification_route.sql` must be applied to production before the code on
`main` is deployed.** `notify()` now inserts a `route` column; against a database
without it, every trade action that produces a notification fails. Nothing
applies migrations automatically — there is no build hook, only
`npm run db:migrate` against the production `DATABASE_URL`. Production has no
residents, shifts or notifications yet, so nothing is broken today. It is listed
under **User action required**.

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
institution's real roster and real block schedule. Nothing technical is blocked.

## User action required

0. **Apply `db/migrations/0007_notification_route.sql` to production**, before
   the code on `main` is deployed. `npm run db:migrate` against the production
   `DATABASE_URL`. Without it, every trade action that produces a notification
   fails, because `notify()` writes a `route` column the production schema does
   not yet have. Sessions do not do this — see `/CLAUDE.md`.

1. **The residents' email addresses**, for **Admin → Users & roles → Invite
   people**. Any format: commas, semicolons, one per line, or a spreadsheet
   column.
2. **The block schedule**, as CSV or XLSX, for **Admin → Import**.
3. **A Google Play developer account.** $25 plus identity verification.
4. **An Apple Developer account.** $99/year plus identity verification.
5. **A bundle id on a domain the institution controls**, replacing
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
work that most recently landed was the resident experience and the trade
lifecycle audit — dead ends, rule wording, notification routing, the five-role
leftovers, and concurrency. What has *not* been done is a deliberate design
pass: every session so far has fixed defects rather than shaping the product,
and the difference shows.

**For onboarding the first real program** (a human sequence, not a session's):
**Admin → Program settings** → **Admin → Services** → **Admin → Users & roles →
Invite people** → **Admin → Import** (`docs/ONBOARDING.md`). To exercise it
without real data, `npm run demo:seed` and the invitation sandbox — see
`docs/DEMO_DATA.md`.

**For the mobile apps.** `mobile/.env.production` already points at the live
host. Still needed: `ANDROID_PACKAGE_NAME`, `ANDROID_CERT_FINGERPRINTS`,
`APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, and FCM credentials.

## Decisions

Choices made without asking, as `/CLAUDE.md` requires. Each says what was
chosen, why, and what was rejected, so any of them can be revisited by someone
who disagrees rather than rediscovered.

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
| Database | Neon, PostgreSQL 17.10, region us-east-1. Migrations `0001`–`0006` reported applied on 31 July 2026, `0007` **not applied** — see Current status. Contents at that time: 1 program, 1 user, 0 residents, 0 services, 0 shifts |
| Connection pooling | The **pooled** Neon endpoint is safe — verified empirically, see docs/DEPLOYMENT.md |

Secrets are never in the repository. `.env.production`, `key.properties`,
`*.jks`, `*.p8`, `*.p12` and `google-services.json` are all git-ignored.

## Defects found and fixed (baseline audit)

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

## Defects found and fixed (roles/services session)

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

## Defects found and fixed (resident experience & trade lifecycle session)

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

## Defects found and fixed (demo data & lifecycle session, earlier)

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

## Concurrency

`tests/integration/concurrency.test.ts` races accept against every other verb —
cancel, withdraw, decline, an administrator reassigning or cancelling a shift,
the expiry sweep — plus two chiefs deciding at once, and an uncoordinated storm
of six residents firing everything in parallel.

The assertion that matters is `assertDatabaseConsistent()` in
`tests/integration/helpers.ts`, run at the end of each. Counting successes is not
enough: "one accept won and one lost" is compatible with a database in which a
shift has two holders or a switch was recorded but never applied. It checks that
every live shift has exactly one holder, every completed switch has two legs and
actually swapped the two residents, no offer is left accepted on a finished
request, and no shift claims to be in a trade that does not exist.

Three of the defects above were found this way and by nothing else.

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
  works on the repository.
- **Multi-person swaps are not implemented.** Every switch is between exactly
  two residents; `finaliseTrade` writes two legs. The schema would carry more.
  Nothing in the product claims otherwise.
- **No invitation has been *accepted* through a real Google account.** The live
  path was verified up to Google's own consent screen (see Tested); the step
  past it needs a second human Google account and cannot be automated. The
  redemption logic itself is tested directly with the identity the callback
  supplies, and the callback's signature verification against a local OpenID
  provider.
- **App Links / Universal Links are unverified.** The route-parsing logic is
  unit-tested, including that it refuses foreign origins, but verification needs
  a real host and a real device.

## Tested

**`npm run verify` exits 0.** That is the whole answer, and the only one worth
quoting — it runs every row below in one command with one exit code. Last full
run: 10 steps, 588 seconds.

| Step | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | clean |
| Lint, server + web | clean |
| Lint, native client | clean |
| Server unit + integration (`vitest run`) | **391 passed**, 21 files |
| Native client unit (`npm --prefix mobile run test`) | **37 passed**, 6 files |
| Production build (`next build`) | succeeds |
| Web end-to-end (`playwright test`) | **122 passed**, mobile + desktop projects |
| Native end-to-end (`--config playwright.mobile.config.ts`) | **16 passed**, including the 9 screenshot specs |
| Migrations from scratch (`migrate.ts --reset`) | **0001–0007 apply to an empty database** |
| Integration suite against the rebuilt schema | **270 passed**, 13 files |

566 distinct tests. The final 270 is the integration subset re-run against the
freshly rebuilt schema, which is why it is not added again.

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
- **Migrations from empty** — `0001`–`0007` applied to a brand-new database, as
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
