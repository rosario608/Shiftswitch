# Testing

Three suites, each with a different job.

| Suite       | Runner     | Talks to               | What it proves |
| ----------- | ---------- | ---------------------- | -------------- |
| Unit        | Vitest     | nothing                | Pure logic: time/DST, rules, validation ordering, scoring, email formatting and encoding — plus two suites that read the *source* rather than run it: `route-guards` (every handler's capability) and `action-messages` (what a failed mutation shows) |
| Integration | Vitest     | a real PostgreSQL database | The domain services: posting, offers, acceptance, atomic finalisation, approval, overrides, expiry, invalidation, provisioning, sessions, import/export, analytics, and concurrency for both the trade lifecycle and the scheduler |
| End-to-end  | Playwright | a running app + database   | The product: the full workflow in a browser, authorization from the outside, mobile layout, offline behaviour, edge cases |

---

## Running them

```bash
npm run verify            # everything, one exit code — what "done" means
npm run verify:fast       # typecheck, lint, unit + integration — the inner loop

npm run test              # unit + integration
npm run test:unit
npm run test:integration
npm run test:e2e          # Playwright: mobile (Pixel 7) and desktop projects
npm run test:e2e:mobile   # the native client against its own origin
```

`npm run verify` (`scripts/verify.ts`) is the one that decides whether the
repository is in a good state. It runs, in order and stopping at the first
failure:

| | |
|---|---|
| 1 | `tsc --noEmit` |
| 2 | lint, server + web |
| 3 | lint, native client |
| 4 | unit + integration (`vitest run`) |
| 5 | native client unit suite |
| 6 | production build |
| 7 | end-to-end, web |
| 8 | end-to-end, native |
| 9 | migrations from scratch — drops the **test** schema and applies `0001`… |
| 10 | the integration suite again, against that rebuilt schema |

It needs a local PostgreSQL and nothing else: no credential, no network
service, no prompt. A preflight reports an unreachable database as a single
line, because with PostgreSQL down the integration suite otherwise fails
thirteen times with `ECONNREFUSED` buried in a subprocess.

Two orderings are deliberate. **Build runs before the Playwright suites**,
because both Playwright configs start `next dev` and `next dev` contends with
`next build` over `.next`. **The migration reset runs last**, because it drops
the schema every earlier step depends on.

Step 9 is the one a developer's own database can never demonstrate: an
incrementally-migrated database has been carrying each migration's result since
whenever it landed, so it cannot show that the set still applies to an empty
database in order.

**Running verify destroys the local demo program.** Every end-to-end spec
rebuilds `scripts/e2e-fixture.ts` in `beforeAll`, and that truncates every table
in the development database. `npm run demo:seed` puts it back.

### Database used by tests

Integration tests connect to `TEST_DATABASE_URL` (falling back to
`DATABASE_URL`), apply migrations once per process, and truncate every table
between tests. They never touch the development database as long as
`TEST_DATABASE_URL` points elsewhere.

```
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/shiftswitch_test
```

The **end-to-end** suites are different: they drive a real `next dev`, which
uses `DATABASE_URL` from `.env.local` — the development database. That is why
running them clears the demo program.

Three scripts issue statements that cannot be undone — the migration reset, the
end-to-end fixture, and the demo seeder. All three refuse any target that is not
demonstrably local, before opening a connection, and name the host and every
reason. The detection is shared (`scripts/db-guard.ts`, covered by
`tests/unit/db-guard.test.ts`) so there is one answer to "does this look like
production". Each caller opts in to a remote target under its own variable, so
unlocking one does not unlock the others. **If a guard refuses, it is right.**

`tests/setup.ts` forces `NODE_ENV=test` and loads `.env.test`.

### End-to-end tests

`playwright.config.ts` starts `npm run dev` automatically (or reuses a server
already listening). Each spec calls `resetFixture()`, which runs
`scripts/e2e-fixture.ts` to rebuild a small deterministic program:

| Account                   | Role                                     |
| ------------------------- | ---------------------------------------- |
| `e2e.alice@hospital.org`  | Resident, three tradeable shifts          |
| `e2e.bob@hospital.org`    | Resident, three tradeable shifts          |
| `e2e.carol@hospital.org`  | Resident, one approval-required shift     |
| `e2e.chief@hospital.org`  | Chief resident                            |
| `e2e.admin@hospital.org`  | Program administrator                     |
| `e2e.pending@hospital.org`| Authenticated but not configured          |

Sign-in uses `POST /api/auth/test-login`, which is hard-disabled unless
`NODE_ENV !== "production"` **and** `ALLOW_TEST_LOGIN=true`. It creates the same
database-backed session Google sign-in would create; it never creates users and
never grants a role.

> The E2E fixture rebuilds whichever database the running server is using. Point
> the dev server at a scratch database before running it against anything you
> care about.

---

## Coverage of the mandated edge cases

| Case | Where |
| ---- | ----- |
| Google sign-in: PKCE, state, nonce, signature, audience, issuer, expiry, unverified email, workspace domain | `tests/integration/oidc.test.ts` — driven against a local OpenID provider with a real key pair |
| Concurrent trade — only one succeeds | `tests/integration/concurrency.test.ts` |
| Two schedulers editing one draft; two publications of one draft | `tests/integration/scheduler-concurrency.test.ts` |
| Overlapping drafts published at once — the overlap holds one schedule | `tests/integration/scheduler-concurrency.test.ts` |
| Publication racing an accept; a correction racing an accept | `tests/integration/scheduler-concurrency.test.ts` |
| Two regenerations into one draft — the loser is told, not discarded | `tests/integration/scheduler-concurrency.test.ts` |
| Approval withdrawn as a schedule publishes | `tests/integration/scheduler-concurrency.test.ts` |
| Every route's guard, and page/API capability agreement | `tests/unit/route-guards.test.ts` |
| A failed action shows what it wrote, not "something went wrong" | `tests/unit/action-messages.test.ts` |
| Already-traded / obsolete offer rejected | `tests/integration/trade-workflow.test.ts`, `tests/e2e/edge-cases.spec.ts` |
| Schedule changed under a pending trade | `tests/integration/trade-workflow.test.ts` ("administrator reassigned a shift underneath") |
| Insufficient rest rejected with an explanation | `tests/unit/validation.test.ts`, `tests/integration/trade-workflow.test.ts` |
| Excessive consecutive shifts rejected | `tests/unit/validation.test.ts` |
| Overnight shift handled as one shift | `tests/unit/time.test.ts`, `tests/e2e/mobile-ux.spec.ts` |
| Daylight-saving transitions | `tests/unit/time.test.ts` (both directions, plus the non-existent wall time) |
| Expired trade cannot be accepted | `tests/integration/trade-workflow.test.ts` |
| Deactivated resident handled safely | `tests/unit/validation.test.ts`, `tests/integration/auth.test.ts` |
| Cancelled shift invalidates its offers | `tests/integration/trade-workflow.test.ts`, `tests/e2e/edge-cases.spec.ts` |
| Duplicate submission cannot double-book | `tests/integration/concurrency.test.ts`, `tests/e2e/edge-cases.spec.ts` |
| Resident cannot reach another resident's data | `tests/e2e/security.spec.ts` |
| Resident cannot reach admin routes | `tests/e2e/security.spec.ts` |
| Email recipients, subject and body correct | `tests/unit/email.test.ts`, `tests/integration/email-and-admin.test.ts`, `tests/e2e/workflow.spec.ts` |
| Invitation expiry, revocation, wrong token, single use, resend rotation | `tests/integration/invitations.test.ts` |
| Invitation accepted by the wrong Google account | `tests/integration/invitations.test.ts` (mismatch does not consume the invitation), `tests/e2e/security.spec.ts` |
| Concurrent acceptance of the same invitation | `tests/integration/invitations.test.ts` |
| Invitation delivery reported honestly when no transport is configured | `tests/integration/invitations.test.ts` |
| Malformed schedule file (not a spreadsheet, wrong columns, empty) | `tests/integration/onboarding.test.ts` |
| Duplicate schedule import is idempotent | `tests/integration/email-and-admin.test.ts` |
| Import into an empty/new program | `tests/integration/onboarding.test.ts` |
| Import writes nothing when one row is bad | `tests/integration/onboarding.test.ts` |
| Deleting a shift with trade history is refused | `tests/integration/onboarding.test.ts` |
| Whole onboarding path: invite → accept → import → see shifts → switch | `tests/integration/onboarding.test.ts` |
| **The whole beta path**: configure a q3 cycle → import a block naming strangers → issue a link → a stranger joins → finds a schedule waiting → corrects its hours → posts it → a second resident accepts | `tests/integration/beta-path.test.ts` |
| A row naming somebody without an account is held, not refused | `tests/integration/onboarding.test.ts`, `tests/integration/email-and-admin.test.ts` |
| Held rows attach on enrollment, and only to the right person | `tests/integration/onboarding.test.ts`, `tests/integration/beta-path.test.ts` ("Nadia Okafor" does not receive "Nadia Osei" shifts) |
| Two spellings of one name match; two people do not | `tests/unit/held-rows.test.ts` |
| Enrollment refused: revoked, expired, used up, rate limited | `tests/integration/beta-path.test.ts` |
| Joining with an unrecognised domain lands pending, sees only itself | `tests/integration/beta-path.test.ts`, `tests/unit/roles.test.ts` (`allowsWhilePending`) |
| A guessed default generates nothing until somebody confirms it | `tests/integration/starting-configuration.test.ts` |
| A confirmed default survives re-applying the configuration | `tests/integration/starting-configuration.test.ts` |
| A cycle read back from the database is an array, not its text | `tests/unit/rotation-cycles.test.ts`, and the defect that produced it was found by `tests/integration/beta-path.test.ts` |
| Residents and chiefs cannot import or invite | `tests/e2e/security.spec.ts` |
| Invitations are scoped to one program | `tests/integration/onboarding.test.ts` |
| Whole lifecycle over HTTP: admin invites, imports, edits, reassigns, deletes; resident posts, offers, accepts | `tests/e2e/lifecycle.spec.ts` |
| Moving a shift in time, including DST gap and repeated hour | `tests/integration/schedule-admin.test.ts` |
| Moving a shift invalidates live offers | `tests/integration/schedule-admin.test.ts` |
| Reassigning to another resident, to nobody, and across programs | `tests/integration/schedule-admin.test.ts` |
| Schedule source seam produces records the core validation accepts | `tests/integration/schedule-admin.test.ts` |
| Demo seed is deterministic, idempotent and fully removable | `tests/integration/demo-data.test.ts` |
| Demo seed refuses production, remote and production-named targets | `tests/integration/demo-data.test.ts` |
| Seeded schedule does not violate the program's own rules | `tests/integration/demo-data.test.ts` |
| Every seeded rule type has a handler | `tests/integration/demo-data.test.ts` |
| Demo scenarios: valid swap, invalid swap, no match, overlapping schedule | `tests/integration/demo-data.test.ts` |
| The five roles have exactly the documented capabilities | `tests/unit/roles.test.ts` |
| Nobody can assign a role at or above their own, or change their own | `tests/unit/roles.test.ts`, `tests/integration/permissions.test.ts`, `tests/e2e/roles-and-onboarding.spec.ts` |
| A program can never be left without leadership | `tests/integration/permissions.test.ts` |
| Multi-email input: typing, paste, commas, semicolons, newlines, spreadsheet columns | `tests/unit/email-input.test.ts`, `tests/e2e/roles-and-onboarding.spec.ts` |
| Invalid and duplicate addresses are flagged individually | `tests/unit/email-input.test.ts`, `tests/e2e/roles-and-onboarding.spec.ts` |
| Service creation, case-insensitive duplicates, rename, deactivate | `tests/integration/services.test.ts`, `tests/e2e/roles-and-onboarding.spec.ts` |
| A service with upcoming shifts cannot be deactivated | `tests/integration/services.test.ts` |
| Email is never delivered outside a production build | `tests/unit/environment.test.ts` |
| The invitation sandbox is unreachable in production | `tests/unit/environment.test.ts`, `tests/e2e/security.spec.ts` |
| Whole self-test path: service → invite → accept → resident view → switch back → chief | `tests/e2e/roles-and-onboarding.spec.ts` |
| Program leadership can reach the admin area and is labelled correctly | `tests/e2e/roles-and-onboarding.spec.ts` |
| Deactivating an account kills its live session and deletes it | `tests/e2e/red-team.spec.ts` |
| Another program's administrator cannot read or write this program's data | `tests/e2e/red-team.spec.ts` |
| A payload cannot move a user between programs | `tests/e2e/red-team.spec.ts` |
| A well-formed id from another program is indistinguishable from a nonexistent one | `tests/e2e/red-team.spec.ts` |
| A native bearer token carries the same limits as a cookie | `tests/e2e/red-team.spec.ts` |
| Simultaneous or repeated invitations leave exactly one live invitation | `tests/integration/idempotency.test.ts` |
| Simultaneous service creation produces one service and a readable conflict | `tests/integration/idempotency.test.ts` |
| Audit entries and shift assignments survive deactivating the people in them | `tests/integration/idempotency.test.ts` |
| The native client's role vocabulary matches the server's | `mobile/src/api/roles.test.ts` |
| A draft schedule is invisible to residents and cannot be traded | `tests/integration/scheduler.test.ts`, and the trigger in `0008` |
| A draft shift can be reassigned, cleared and removed without touching the live schedule | `tests/integration/scheduler.test.ts` |
| The draft editor refuses a published shift, another program's draft, and a resident who is not schedulable | `tests/integration/scheduler.test.ts` |
| A chief starts a draft, edits it and sees the diff, all from the interface | `tests/e2e/scheduler.spec.ts` |
| A service's screen lists the program-wide and service-scoped rules that govern it | `tests/integration/scheduler.test.ts`, `tests/e2e/scheduler.spec.ts` |
| A resident block exception is recorded with a reason and can be taken back | `tests/integration/scheduler.test.ts`, `tests/e2e/scheduler.spec.ts` |
| A whole multi-PGY programme configured from the UI alone — services, coverage, blocks, cohorts, assignments | `tests/e2e/scheduler.spec.ts` |
| Every scheduling constraint violated individually, asserting the exact set reported | `tests/unit/constraints.test.ts` |
| A constraint added to the catalogue with no test | `tests/unit/constraints.test.ts` — fails the suite |
| Several independent problems reported at once, and several on one shift | `tests/unit/constraints.test.ts` |
| Validator messages: real dates, the numbers in the sentence, no name prefix, no identifiers | `tests/unit/constraint-messages.test.ts` |
| The score is bounded, deterministic, adds up, and ignores hard violations | `tests/unit/constraint-scoring.test.ts` |
| A snapshot arrives with the availability, coverage, blocks and exceptions the constraints expect | `tests/integration/schedule-validation.test.ts` |
| A draft is validated instead of the live schedule, and compared against what it would replace | `tests/integration/schedule-validation.test.ts` |
| One program's schedule stays out of another's validation report | `tests/integration/schedule-validation.test.ts` |
| A chief checks a schedule and reads why it is or is not valid | `tests/e2e/scheduler.spec.ts` |
| Every generated schedule validates clean on hard constraints, or the run reported infeasibility | `tests/unit/generator.test.ts`, `tests/integration/generator.test.ts` |
| Two generation runs with the same seed are byte-identical | `tests/unit/generator.test.ts` |
| Generation across both daylight-saving transitions, one-day periods, overnight bands and weekend-only requirements | `tests/unit/generator.test.ts` |
| An infeasible run writes nothing — not the shifts, not the version row | `tests/integration/generator.test.ts` |
| Regeneration keeps locked shifts and rebuilds the rest | `tests/unit/generator.test.ts`, `tests/integration/generator.test.ts` |
| A manual edit is revalidated and only the newly-introduced problems are reported | `tests/integration/generator.test.ts` |
| One draft diffed against another | `tests/integration/generator.test.ts` |
| Nobody holds two places on one service at one time, even with no overlap rule configured | `tests/unit/generator.test.ts`, `tests/unit/constraints.test.ts` |
| A recorded absence reaches the validator as unavailability, and the message says why | `tests/unit/constraints.test.ts`, `tests/integration/availability.test.ts` |
| A range expands to every day it covers, including one that started before the window | `tests/integration/availability.test.ts` |
| An unconfirmed absence is scored and never invalidates a schedule | `tests/unit/constraints.test.ts`, `tests/integration/availability.test.ts` |
| A resident may record their own availability and may not confirm it | `tests/integration/availability.test.ts` |
| Absences and the jsonb lists are unioned rather than one replacing the other | `tests/integration/availability.test.ts` |
| Locks survive a regeneration with a different seed, with their row identifiers | `tests/integration/schedule-workflow.test.ts` |
| An assignment lock resolves through the person and the day, not the shift id | `tests/integration/schedule-workflow.test.ts` |
| A lock whose target is gone is reported rather than silently dropped | `tests/integration/schedule-workflow.test.ts` |
| Publishing refuses an unapproved draft, and an approval can be withdrawn | `tests/integration/schedule-workflow.test.ts` |
| Approval records the score and the hard violations knowingly accepted | `tests/integration/schedule-workflow.test.ts` |
| Publishing tells everybody with a shift in the window, with a stored route | `tests/integration/schedule-workflow.test.ts` |
| Every published shift is stamped with the version that produced it | `tests/integration/schedule-workflow.test.ts` |
| The grid's heat map and the validator agree about what is short | `tests/integration/schedule-workspace.test.ts` |
| Coverage counts people rather than rows, and the biggest gap leads the queue | `tests/integration/schedule-workspace.test.ts` |
| The coverage report restates nothing — every message came from the validator | `tests/integration/schedule-workspace.test.ts` |
| Bulk reassignment reports what it replaced, so undo is the inverse operation | `tests/integration/schedule-workspace.test.ts` |
| Bulk operations refuse a published schedule | `tests/integration/schedule-workspace.test.ts` |
| Repeating a pattern never creates or deletes a shift, and refuses overlapping stretches | `tests/integration/schedule-workspace.test.ts` |
| A switch that would leave a service short is refused, naming the switch as the cause | `tests/integration/schedule-lifecycle.test.ts` |
| A switch that leaves coverage unchanged gets an explicit pass, not silence | `tests/integration/schedule-lifecycle.test.ts` |
| A correction demands a reason, tells both residents, and is visible afterwards | `tests/integration/schedule-lifecycle.test.ts` |
| Correcting a draft shift is refused, and the refusal names the right verb | `tests/integration/schedule-lifecycle.test.ts` |
| The whole path — configure, generate, approve, publish, trade, correct — with the database consistent at every step | `tests/integration/schedule-lifecycle.test.ts` |
| Nobody in two places at once, reconstructed from assignment history | `assertDatabaseConsistent` in `tests/integration/helpers.ts` |
| No shift orphaned between a schedule version and a trade | `assertDatabaseConsistent` |
| Every correction records what it replaced | `assertDatabaseConsistent` |
| A live shift published with an unfilled slot is accepted; one *emptied* with nothing to account for it is not | `assertDatabaseConsistent`, asserted both ways in `tests/integration/scheduler-concurrency.test.ts` |
| Clearing a draft cell leaves no assignment row, so an `ended` row means one thing | `tests/integration/scheduler-concurrency.test.ts` |
| The live schedule's editor refuses a draft shift, and the draft editor refuses a published one | `tests/integration/scheduler.test.ts` |
| The same seed gives the same schedule with the improvement search running, not only with it skipped | `tests/unit/generator.test.ts` |
| Regeneration covers the draft's own period, whatever window the caller names | `tests/integration/schedule-workflow.test.ts` |
| A missing migration is detected before any query runs, names the file, and refuses with a message written for a resident | `tests/integration/health.test.ts` |
| A migration whose bytes changed is failed; a migration the build does not know about is only degraded | `tests/unit/health.test.ts`, `tests/integration/health.test.ts` |
| An unreachable database is never reported as schema drift, and its message never contains the connection string | `tests/integration/health.test.ts` |
| The verdict recovers the moment the migration is applied, without a redeploy | `tests/integration/health.test.ts` |
| Drift is reported once per verdict, not once per refused request | `tests/integration/health.test.ts` |
| A mutation refused while offline says nothing was sent; one interrupted mid-flight says it does not know | `tests/unit/offline.test.ts`, `tests/e2e/resilience.spec.ts` |
| A cached page is labelled with its age, and says so honestly when the stamp is unreadable | `tests/unit/offline.test.ts` |
| The service worker never touches a mutation, never caches `/api/`, and stamps every page it stores | `tests/unit/service-worker.test.ts` |
| Every response carries a request id a resident can read out, including a refusal | `tests/e2e/resilience.spec.ts` |
| An error report carries no name, address, phone number or connection string | `tests/unit/health.test.ts`, `tests/e2e/resilience.spec.ts` |
| The diagnostic page is reachable by an administrator and by nobody else, and prints a copyable verdict | `tests/e2e/resilience.spec.ts`, `tests/unit/route-guards.test.ts` |
| The product never says "trade" or "swap" where anybody can read it | `tests/unit/vocabulary.test.ts` |
| Posting, offering and accepting each cost at most two taps from a cold open | `tests/e2e/taps.spec.ts` |
| Nothing scrolls sideways at 320 CSS pixels, the narrowest phone still shipping | `tests/e2e/mobile-ux.spec.ts` |
| Heading, secondary text and the primary button meet 4.5:1, measured from rendered pixels | `tests/e2e/mobile-ux.spec.ts` |
| Every empty state a resident reaches carries a way forward | `tests/e2e/mobile-ux.spec.ts` |

---

## Adversarial checks performed manually

Beyond the automated suites, the running app was probed with SQL-injection
payloads in query and path parameters, 2 MB request bodies, wrong content types,
attempts to set statuses directly, path-traversal identifiers, unsupported HTTP
methods, and concurrent duplicate submissions. All were rejected with 4xx
responses and resident-friendly messages; no stack trace, driver code or
internal path appeared in any response body. A malformed UUID in a path
parameter originally produced a 500 — it now returns a clean 404 (see
`requireUuid` in `src/server/http/api.ts`).
