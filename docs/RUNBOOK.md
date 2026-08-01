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

**This needs to be made a required check once, by hand** — it is a repository
setting, not a file, so no session can do it:

> **GitHub → the repository → Settings → Rules → Rulesets → New branch ruleset**
> Target `main`; enable **Require status checks to pass**; add these four by
> name:
>
> - `Typecheck, lint, tests, build`
> - `End-to-end`
> - `Client — typecheck, lint, tests, build`
> - `Native client — end-to-end`
>
> Also enable **Require a pull request before merging**, so nothing reaches
> `main` without going through the checks at all.

Until that is done, CI *runs* on every pull request and reports its verdict —
but nothing stops somebody merging past a red one. Listed under **User action
required** in `docs/AI_PROJECT_STATE.md`.

---

## Where the detail is

| | |
| --- | --- |
| Every failure path and its designed outcome | `docs/FAILURE_PATHS.md` |
| What counts as an error worth reporting | `docs/AI_PROJECT_STATE.md` → Decisions |
| Deployment and environment variables | `docs/DEPLOYMENT.md` |
| The health check's own logic | `src/server/health/check.ts` |
