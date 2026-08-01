# Branch rulesets

GitHub does not read rulesets out of a repository the way it reads workflows.
They live in the repository's *settings*, which is an API a session working on
this codebase cannot reach — the agent proxy answers a write to
`/repos/…/rulesets` with **"Write access to this GitHub API path is not
permitted through this proxy."**

So the ruleset is kept here as the file GitHub's own importer accepts, and
applying it is one import rather than a form with eight fields.

## Applying `main-pull-request-and-green-ci.json`

**Settings → Rules → Rulesets → New ruleset → Import a ruleset**, then choose
the file. Nothing else needs filling in.

Or, from a machine with `gh` authenticated as somebody who administers the
repository:

```bash
gh api --method POST /repos/rosario608/shiftswitch/rulesets \
  --input .github/rulesets/main-pull-request-and-green-ci.json
```

## What it does, and why each part

| Rule | Why |
| --- | --- |
| Pull request required | Nothing reaches `main` without one, which is what makes the CI gate meaningful — a direct push has no checks to be required of it. |
| Four required status checks | `Typecheck, lint, tests, build`, `End-to-end`, `Client — typecheck, lint, tests, build`, `Native client — end-to-end`. These are the four jobs in `ci.yml` and `mobile.yml`, by their exact names. A check named wrongly is a check that never runs and never blocks. |
| Block deletion | `main` is the branch the migration workflow applies from. |
| Block force-push | An applied migration is recorded by its checksum; rewriting the history that introduced it makes the repository and the database disagree about what happened. |

**Zero required approvals** is deliberate rather than an oversight. This is a
one-person repository today; requiring an approval nobody can give would mean
either nothing ever merges or the rule gets turned off, and a rule that gets
turned off protects nothing. The gate that matters here is CI being green.
Raise it to 1 the day a second person can approve.

## Why it matters more now than it did

`apply-migrations.yml` applies migrations to production when CI passes on the
default branch. Without this ruleset, a direct push to `main` reaches production
having passed nothing — the workflow's gate is only as strong as the guarantee
that code arrives through CI in the first place.
