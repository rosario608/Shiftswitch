@AGENTS.md

# Working on ShiftSwitch

ShiftSwitch is a shift-switching app for medical residency programs. A resident
posts a shift they cannot work, colleagues offer one of theirs, a rules engine
checks whether the swap is legal, and an approved switch moves both assignments
in a single transaction.

It is used by real programs to manage real schedules. Two consequences run
through everything below: **a wrong schedule is a clinical problem, not a
cosmetic one**, and **the people using it are exhausted and on their phones**.

This file is read automatically at the start of every session. It is the
standing agreement about how this repository is worked on.

---

## Done means `npm run verify` exits 0

Not "the tests I ran pass". Not "it looks finished". The command is
`scripts/verify.ts` and it runs typecheck, both lints, the unit and integration
suites, the native unit suite, a production build, the Cloudflare Worker build
and a size check against the free plan's 3 MiB ceiling, both end-to-end suites,
and a from-scratch migration followed by the integration suite against the
rebuilt schema. One exit code.

The Worker steps are not decoration. The deployable artefact is a Worker, not
the `next build` output, and it sits at 97.7% of the size limit — over it,
Cloudflare refuses the upload and whatever is already deployed keeps serving.
Both would otherwise be found by a failed deploy, which for this product means
found while somebody is trying to ship a fix.

```
npm run verify        everything — what "done" means (~8 min)
npm run verify:fast   typecheck, lint, unit + integration — the inner loop
```

It needs a local PostgreSQL and nothing else. No credential, no network service,
no prompt. On a fresh checkout, `npm run setup:local` first — it creates both
databases, writes `.env.local` with a generated secret, and migrates. After
that `verify` passes from a clean clone.

**Running verify destroys the local demo program** — every end-to-end spec
rebuilds `scripts/e2e-fixture.ts`, which truncates every table in the
development database. `npm run demo:seed` puts it back.

## Never ask the user a question during a goal

Goals run unattended. A question is a stall, and a stalled goal produces
nothing.

When a decision is genuinely open, choose the option most consistent with the
code that already exists, record it under **Decisions** in
`docs/AI_PROJECT_STATE.md` — what was chosen, why, and what was rejected — and
keep going. A decision written down can be revisited; a question that stopped
the run cannot.

This is not licence to guess about *facts*. Facts are established by inspection:
read the code, query the database, run the command. It applies to choices, where
more than one answer would work.

## Never wait for data that does not exist

There is no real roster, schedule, or resident to develop against, and there
will not be one until a program onboards. Build and test against the demo
program:

```
npm run demo:seed     rebuild "ShiftSwitch Demo Residency"
npm run demo:status   what is currently seeded
npm run demo:reset    remove it
```

It is 21 people, ~330 shifts across four weeks, and a trade in every lifecycle
state — a live offer, one awaiting a chief, one completed, one declined — all
produced by calling the same domain functions a resident's taps call. When a
feature needs data the seed does not yet produce, **extend the seed**. Never
build against a hand-inserted row, and never wait.

Everything in it is fictional and every address ends in `.invalid`, which can
never be delivered to. See `docs/DEMO_DATA.md`.

## Never touch the production database

Not to inspect it, not to migrate it, not to "just check something". No
exception is worth the one time it goes wrong.

**This rule is about data, and only about data.** It says a session does not
open a connection to the live database — does not read a row, does not write
one, does not count them to see whether a migration landed. That is the whole
of it, and it does not move.

It is **not** a rule against setting up the machinery that reaches production.
Those are different acts with different failure modes, and conflating them has
cost this project real time — a session that will not commit a deployment
workflow because the word "production" appears in it has not been careful, it
has left the owner to do by hand the exact thing that keeps going wrong when
done by hand.

So, explicitly:

| Doing this is expected | Doing this is forbidden |
|---|---|
| Writing and changing `.github/workflows/apply-migrations.yml` | Running the migration runner against the production `DATABASE_URL` from a session |
| Writing a script the pipeline executes against production | Executing that script here with a production connection string |
| Creating a branch ruleset, a repository secret, a preview database branch, an environment variable | Reading a value out of any of them, or putting a live credential in a tracked file |
| Reading `/api/health` or `/admin/diagnostics` over HTTPS to learn what production reports about itself | Connecting to the database to find that out directly |
| Saying in a document what production is believed to be, and naming how that is known | Saying it as a verified fact when the evidence is a report |

The distinction is who is holding the connection. **A pipeline reaching
production is the design. A session reaching production is the accident.** The
pipeline is reviewed, merged, logged, gated on CI, and repeatable; a session is
none of those, and its mistakes arrive without a diff.

Provisioning that a session genuinely cannot perform belongs in **User action
required** in `docs/AI_PROJECT_STATE.md` — but only after it has been
*attempted* and refused, with what came back written down. An item put on that
list without an attempt is a guess about somebody else's afternoon.

Migrations are **written**, **applied locally**, and **verified from scratch**:

```
npx tsx scripts/migrate.ts --reset     # drops and rebuilds, local only
```

**A session never reaches production; the pipeline does.** No agent, script or
command run from a session touches the live database — that is what this rule
protects, and it has not changed. What *has* changed is that applying a
migration is no longer a person's job either: `.github/workflows/
apply-migrations.yml` fires when **CI finishes successfully** on the default
branch — `workflow_run`, not `push`, so the tests are a gate rather than a
coincidence — and applies whatever the database is missing. It refuses any
pending migration that would destroy data unless the file says it means to, and
names what it applied in the job summary. `npm run check:migration-pipeline`
proves all of that against a scratch database.

The rule used to say applying was a human step, and that had a consequence
nobody intended: every schema change waited on somebody noticing. The one time
it mattered, the person was on a phone and the administration pages were down
until they got to a computer. A step that must happen after every deploy, always
the same way, should not need a human — leaving it to one is how it gets
forgotten exactly when everything else is going wrong.

Still record the migration in `docs/AI_PROJECT_STATE.md`, naming the file and
what breaks without it. The pipeline applies it; the document is how a reader
knows what changed and why.

Three scripts issue statements that cannot be undone — the migration reset, the
end-to-end fixture, and the demo seeder. All three refuse any target that is not
demonstrably local (`scripts/db-guard.ts`). If a guard refuses, **the guard is
right**; do not set the override to get past it.

Migrations are forward-only and checksummed. An applied migration is never
edited — write a new one.

**A new migration means a new manifest.** The build carries the list of
migrations it needs (`src/server/db/migration-manifest.ts`, generated) and
refuses to run queries against a database that is behind it, naming the file.
After writing a migration, run `npm run migrations:manifest` and commit the
result. Skipping it does not break the product — the gate treats a database
that is *ahead* as merely degraded — but it makes the diagnostic page lie about
what this build needs, and that page is the only thing standing between a
production problem and a resident finding it.

## Permissions come from the capability matrix

`src/server/auth/roles.ts` is the source of truth. Five roles: resident, chief,
APD, PD, administrator.

```ts
const context = await requireCapability("services.manage");   // API routes
const context = await requirePageCapability("users.manage");  // pages
can(role, "approvals.decide")                                 // in domain code
rolesWith("approvals.decide")                                 // when a list is needed
```

**Never write a role literal.** Not `role === "chief"`, not
`role IN ('chief','admin')` in SQL, not a three-branch conditional on role in a
template. Every one of those that has ever been written in this repository
became a bug when APD and PD were added — an approvals queue that notified
nobody, a Program Director refused at a button they could see, an invitation
email telling a PD they were a resident. The matrix is not ceremony; it is the
thing that makes adding a role safe.

Roles are the program's own words: PD is the Program Director, APD the
Associate/Assistant Program Director. See `docs/ROLES.md`.

## Commit at each completed sub-objective

Every commit's tree should pass `npm run verify`, so an interrupted run loses
nothing and any commit can be checked out and worked from.

Develop on the branch named in the session's instructions, never directly on
`main`. Commit messages say what changed and why it mattered — a defect's
symptom, not just its name.

---

## How the product is built

**Stack.** Next.js 16 App Router (the middleware file is `proxy.ts`), React 19,
TypeScript, Tailwind 4, PostgreSQL via `pg` with raw SQL and forward-only
migrations. The native client is Capacitor 8 wrapping a bundled Vite/React SPA
that talks to the same API with bearer tokens. Google OpenID Connect is the only
sign-in — there is no password anywhere, and no wording anywhere should imply
one.

**The trade lifecycle is the product.** Post → discover → offer → validate →
accept → approve if required → atomic switch → invalidate competing offers →
audit → notify. It is guarded by `SELECT … FOR UPDATE`, status transitions
checked inside the same transaction, partial unique indexes, and advisory locks
for read-modify-write. Improve it; do not rebuild it. A partial or inconsistent
switch is the worst thing this software can do.

**Concurrency is tested by racing, not by reasoning.**
`tests/integration/concurrency.test.ts` races accept against every other verb and
ends each case in `assertDatabaseConsistent()`, which asserts the *state* — one
holder per shift, two legs per completed switch, no offer stranded on a finished
request. Counting successes is not enough: "one accept won and one lost" is
compatible with a shift having two holders. Three real defects were found this
way and by nothing else.

**Messages are written for an exhausted resident.** A rule failure says what
happened, names the shift the way the rest of the product names it (`Mon, Aug 10
MICU`, never `2026-08-10`), and includes the numbers in the sentence — the
resident's screen does not render the structured `detail`. No dead ends: if the
app sends a notification about something, there is a screen that shows it. See
`docs/RULES.md`.

**Never claim delivery that did not happen.** Email and push both sit behind
transports whose default implementation reports "not sent" rather than
pretending. A UI that says "invitation sent" when nothing left the building is
worse than one that says "copy this link".

## Where things are

| | |
|---|---|
| Project state, decisions, what is verified | `docs/AI_PROJECT_STATE.md` |
| Roles and the permission matrix | `docs/ROLES.md` |
| The rules engine and how failures are worded | `docs/RULES.md` |
| The constraint model and the schedule validator | `docs/CONSTRAINTS.md` |
| The draft schedule generator | `docs/GENERATOR.md` |
| Approving, publishing, correcting; availability and locks | `docs/SCHEDULE_OPERATIONS.md` |
| The demo program and its scenarios | `docs/DEMO_DATA.md` |
| Onboarding a program: import, enrollment links, self-entry | `docs/ONBOARDING.md` |
| When something is wrong, and what the verdict means | `docs/RUNBOOK.md` |
| Every failure path and its designed outcome | `docs/FAILURE_PATHS.md` |
| What each test suite covers | `docs/TESTING.md` |
| Architecture | `docs/ARCHITECTURE.md` |
| Deployment | `docs/DEPLOYMENT.md` |
| Native release process | `docs/MOBILE_RELEASE.md` |
| First-time local setup | `docs/SETUP.md` |

Read `docs/AI_PROJECT_STATE.md` first in a new session. It is the authoritative
checkpoint: current status, what is genuinely verified, what is not, and every
decision taken without asking.

## Secrets

Never commit a connection string, signing key, keystore password,
service-account file, OAuth client secret, or API token — not in code, not in a
test fixture, not in a comment, not in a commit message. Never point a store
build or a test at production. Never give an App Store reviewer access to a real
resident, schedule, or email address; that is what the demo program is for.
