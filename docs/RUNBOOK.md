# When something is wrong

Written for the person who owns ShiftSwitch and does not troubleshoot. Nothing
here needs a terminal except where it says so, and the things that do are one
command each.

---

## Start here

**Open `/admin/diagnostics`** — signed in as an administrator, from the *Review*
group in the admin navigation.

It prints one sentence saying whether residents are affected right now, and
below it a report in a box. **Copy that report.** It is written to be pasted
into a message or into the next goal, and it contains no resident's name,
schedule, or contact details — only versions, filenames, and whether settings
are configured.

If the site will not load at all, the same information is at
`https://shiftswitch.vercel.app/api/health`, which needs no sign-in.

---

## What the verdict means

| It says | What it means | What to do |
| --- | --- | --- |
| **Everything is working** | The database is reachable, its schema matches this version, sign-in is configured. | Nothing. If a resident is still reporting a problem, ask them for the six-character reference from their screen. |
| **One thing needs attention when convenient** | Nobody's schedule is affected. Usually email delivery is not configured, which the product already says out loud wherever it matters. | Read the sentence. It is not urgent by definition — if it were, it would say the third thing. |
| **Something is broken, and residents are affected right now** | Exactly what it says. The sentence names the part. | Copy the report and act on the section below that matches. |

---

## "The database is missing migrations…"

The most likely thing to go wrong, and the reason the check exists: **the code
was deployed and the database was not updated to match.** The message names the
files.

> **What this looks like before the check is deployed**, and what it looked like
> in production on 1 August 2026: no message at all. The administration screen
> simply fails, because `/admin` reads `schedule_versions` for anybody holding
> `scheduling.plan` — which an administrator does, holding every capability —
> and that table arrives with `0008_scheduler_foundation.sql`. Deploying the
> scheduler without applying its migration breaks the admin area for exactly the
> person who would go looking for a diagnosis. Applying the migrations fixes it;
> promoting the previous deployment restores the page in the meantime without
> touching the database.

Residents see a plain sentence saying their administrator has been told, and
scheduling refuses rather than failing halfway through. Nothing is lost and
nothing is corrupted — the product simply declines to run queries against a
schema that cannot answer them.

**Fix:** apply the named migrations to production.

```
DATABASE_URL='<the production connection string>' npm run db:migrate
```

Then press **Check again** on the diagnostics page. It clears its cache, so the
answer is immediate — you do not need to redeploy or wait.

> A session working on this repository will never do this step. Reaching the
> production database is forbidden by `/CLAUDE.md`, deliberately.

## "The database cannot be reached"

Nothing that reads or writes a schedule can work. The report includes the
driver's own message with the connection string removed.

**Check, in order:** is the database provider up (Neon's status page); has the
`DATABASE_URL` environment variable been changed in Vercel; has the database
been paused for inactivity. This is infrastructure, not code — a redeploy will
not help.

## "Sign-in is not configured"

Nobody can get in. The report names the missing variables. They are set in
**Vercel → Settings → Environment Variables**, on the Production environment.
After setting them, redeploy — environment variables are read at boot.

---

## Rolling back a bad deploy

**One action, and there are two of them depending on what you want.**

### The code, without touching the database

**Vercel → Deployments → the last deployment that was fine → ⋯ → Promote to
Production.** One click. It is instant, it does not rebuild, and it does not
touch the database.

This is the right first move almost always: it takes seconds and it is
reversible.

### The commit, so the next deploy does not reintroduce it

```
git revert -m 1 <the merge commit> && git push
```

One command. `-m 1` is what makes it work on a merge commit — it means "keep the
side `main` was on".

**Proven, not asserted:** reverting the scheduler merge (`ce491a2`) was done
once on a throwaway branch to check that it is genuinely one command and leaves
a clean tree. It removed all 150 files of that change and produced no conflicts.
The branch was then deleted; `main` was never touched.

### Before you roll back: is it just the migration window?

**Every merge produces a window — twelve to twenty minutes — during which
production answers `503` on every API call.** This is by design and it is not a
fault, but it looks exactly like one, and rolling back during it would be the
wrong move.

**Do not treat the number as a constant.** Migrations are applied by
`workflow_run`, which fires only when CI *finishes green* on `main`, so the wait
is however long CI takes plus the deploy — and CI grows with the test suite.
Two measurements so far:

| Merge | Window | What set it |
|---|---|---|
| PR #13, 1 August | ~12 min | measured from the deploy |
| PR #16, 2 August | ~18 min | measured from the merge; CI finished at 03:17:52Z, the migration applied at 03:18:26Z |

The second is the one to plan against, because a merge is what a person
actually does and watches. If you need the real answer on the day, open the
`Apply migrations to production` workflow: the window ends when its latest run
goes green.

Measured on 1 August 2026, on the merge of pull request #13:

| | |
|---|---|
| 23:06:11 | the merge lands, Vercel deploys the new code within about a minute |
| 23:06:11 – 23:17:48 | CI runs on `main`. The new code is already serving. |
| ~23:18:0x | CI finishes green, `apply-migrations.yml` fires and applies the migration |

Between the deploy and the migration, the build is ahead of the database and the
schema gate does what it was built to do: `/api/health` reports `failed` and
every API route returns `503 schema_drift` — *"ShiftSwitch has been updated but
the database has not."* Pages still render, because the gate is on the API
wrapper; so a resident sees screens that load and every action failing.

**How to tell this apart from a real outage, in one request:**

```
curl -s https://shiftswitch.vercel.app/api/health | jq '.components[] | select(.name=="migrations")'
```

- `"status":"failed"` naming a migration file, and the merge was under ~15
  minutes ago → **wait.** It will clear itself. Rolling back the code here makes
  it worse, because the *older* build expects fewer migrations and the newer
  database is fine for it, but you will have thrown away the deploy for nothing.
- `"status":"failed"` and the merge was an hour ago → the pipeline did not run
  or failed. Check the **Apply migrations to production** workflow in Actions,
  and see *"The database is missing migrations…"* above.

**Consequence worth planning around: do not send an enrollment link to a class
within about fifteen minutes of a merge.** Forty people opening it in that
window meet a product where nothing works, and they will not all come back to
try again.

### What a rollback does *not* undo

**Migrations are forward-only.** Rolling back the code does not roll back the
schema, and that is deliberate — an automatic down-migration is how a database
loses data at three in the morning. This is safe in the direction that matters:
every migration here is additive, so *older* code runs happily against a *newer*
schema. The diagnostics page will say `degraded` and name the extra migration,
which is exactly what you want it to say while you decide what to do next.

---

## Nothing merges without CI

The `CI` workflow runs typecheck, lint, the unit and integration suites, a
production build, and both end-to-end suites on every pull request.

**This needs to be turned on once, by hand.** Creating it from a session was
attempted on 1 August 2026 and refused: `POST /repos/…/rulesets` returns **403 —
"Write access to this GitHub API path is not permitted through this proxy."**
Nothing was created.

So the ruleset is committed as a file instead, and turning it on is an import
rather than a form:

> **GitHub → the repository → Settings → Rules → Rulesets → New ruleset →
> Import a ruleset**, and choose
> `.github/rulesets/main-pull-request-and-green-ci.json`.

It requires a pull request, requires the four CI checks by their exact names,
and blocks deletion and force-pushes on `main`. `.github/rulesets/README.md`
says why each part is there, including why it asks for **zero** approvals — a
rule that cannot be satisfied on a one-person repository is a rule that gets
switched off, and a rule that is switched off protects nothing.

Until it is on, CI *runs* on every pull request and reports its verdict, and
nothing stops somebody merging past a red one — or pushing straight to `main`,
which now reaches production having passed nothing at all, because
`apply-migrations.yml` applies migrations whenever CI passes there. Row 1 under
**User action required** in `docs/AI_PROJECT_STATE.md`.

---

## Where the detail is

| | |
| --- | --- |
| Every failure path and its designed outcome | `docs/FAILURE_PATHS.md` |
| What counts as an error worth reporting | `docs/AI_PROJECT_STATE.md` → Decisions |
| Deployment and environment variables | `docs/DEPLOYMENT.md` |
| The health check's own logic | `src/server/health/check.ts` |
