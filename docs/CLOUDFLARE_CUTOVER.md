# Moving ShiftSwitch from Vercel to Cloudflare Workers

What is done, what is not, and the steps that need an authenticated Cloudflare
account. Written to be followed in order by somebody who is not an engineer.

**Nothing here is live.** The code builds for Workers and is on the default
branch, and every check in `verify` covers it. No Cloudflare resource exists
yet, and Vercel is still serving production. Nothing below has happened.

---

## Before anything: what this costs, and the one feature it cost

**Nothing per month.** The Workers free plan is enough, but only just, and only
because PDF export was removed to make it fit.

Cloudflare refuses to upload a Worker script over **3,072 KiB gzipped** on the
free plan. This one was **3,256.90 KiB** — 185 KiB over, so the first deploy
would have been rejected outright. `pdfkit`, which existed to lay out the
schedule export, was **256.39 KiB** of that. Removing it brings the bundle to
**~2,999.9 KiB**, which fits with **~72 KiB to spare**.

Every number above came from `npx wrangler deploy --dry-run`, which reports the
same figure the upload is judged against. None of it is estimated. The tildes
are there because the bundle is not byte-identical between builds — two builds
of the same tree measured 2,999.96 and 2,999.90 KiB — so the last decimal would
be precision the number does not have. The distance to the ceiling is ~72 KiB
either way, and that is the part that matters.

**72 KiB is not much**, so it is now a check rather than a hope:
`npm run check:worker-size` runs in `verify` and in CI, fails if the bundle goes
over the free limit, and warns below 150 KiB of headroom. A dependency that
would break the deploy breaks the pull request instead.

**What was actually lost.** The **Download my schedule** button on the profile
screen now gives a spreadsheet instead of a PDF. Old `?format=pdf` links still
work — they return the spreadsheet rather than an error, so a bookmark or a
download-history entry is not a dead end. Nothing else changes: CSV and XLSX
export are untouched, and *reading* an uploaded PDF during assisted import is a
different mechanism entirely and is unaffected.

For a resident on a phone, the calendar subscription on the same screen is the
better answer anyway — it puts the shifts in the calendar app they already
open, and it stays current. A PDF was neither live nor editable.

**If the PDF is wanted back**, Workers Paid is $5/month and raises the ceiling
to 10 MiB. That is the trade, stated plainly: $5/month for a laid-out PDF. For
comparison, the thing this migration avoids — Vercel Pro — is $20/month.

**The database does not move.** Neon stays exactly where it is, and
`DATABASE_URL` keeps pointing at the same pooled endpoint. Nothing about the
schedule, the switches or the residents is migrated, copied or at risk during
any of this. If the cutover goes wrong the data is untouched.

---

## Step 1 — Let me do the rest, or do it yourself

Run `/reload-plugins` in Claude. That loads Cloudflare's own MCP servers, the
first call prompts you to authorise, and after that the Worker, its secrets and
its domain can be created from here rather than by hand.

If you would rather do it yourself, the remaining steps are below.

## Step 2 — Create the Worker and its secrets

From the repository root:

```bash
npx wrangler login
npm run deploy:worker
```

The first deploy creates the Worker named `shiftswitch`. Then set each secret —
these are prompted for and never written to a file:

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put APP_URL
```

Take each value from the Vercel project's environment variables. `APP_URL` must
be the address residents will actually use, and it must match Google exactly —
see step 4.

`NEXT_PUBLIC_APP_NAME` and `DATABASE_SSL` are not secret and can go in
`wrangler.jsonc` under `vars`.

## Step 3 — Check it before pointing anybody at it

The Worker gets a `*.workers.dev` address. Open it and confirm, in this order:

| Check | What it proves |
|---|---|
| `/api/health` — `database`, `migrations`, `auth` all `ok` | it can reach Neon and knows its own configuration |
| Sign in with Google | the OAuth redirect matches |
| Open `/schedule` | server rendering and queries work |
| **Download my schedule** from the profile screen | `exceljs` survives on Workers — it bundles, which was the surprise; it has never actually *run* there |
| **Import a small spreadsheet** | the same library on the reading path |

Those last two rows are the same unknown approached from both ends — writing a
spreadsheet and reading one. `exceljs` reaches for Node APIs that workerd
implements only partly, and no test in this repository exercises it inside a
Worker. Do not cut over before trying both.

## Step 4 — Google OAuth

Google refuses any redirect it has not been told about, and this is the step
that silently breaks sign-in for everybody.

1. Google Cloud Console → **APIs & Services** → **Credentials** → the OAuth
   client.
2. Under **Authorised redirect URIs**, *add* — do not replace —
   `{APP_URL}/api/auth/google/callback` for the Cloudflare address.
3. Keep the Vercel one until the cutover is finished and proven. Two entries is
   how you keep a rollback available.

## Step 5 — The custom domain, which is the actual cutover

Until this point nothing residents use has changed. Pointing the domain at the
Worker is the moment it does.

1. Cloudflare dash → the Worker → **Settings** → **Domains & Routes** → **Add
   custom domain**.
2. Wait for the certificate to issue.
3. Re-run every check in step 3 against the real address.

**Rollback:** remove the custom domain from the Worker and point DNS back at
Vercel. The Vercel project is untouched throughout, so this is a DNS change and
nothing else — no data moves, no migration reverses.

---

## What CI does now

`npm run verify` and the CI workflow both build the Worker
(`npm run build:worker`). That step exists because three of the four things
that broke this migration were invisible to `next build` and appeared only in
the Worker bundle: a Node.js proxy the adapter refuses, an optional `pg`
dependency that file tracing never copied, and lint walking the generated
output. Without it, each would have been found by a failed deploy — which for
this product means found by a resident.

Both also run `npm run check:worker-size` immediately afterwards, which asks
wrangler how large the built script is and fails if it exceeds the free plan's
3 MiB. That is the same class of protection for the same reason: the bundle is
at 97.7% of the limit, so the next dependency anybody adds decides whether the
app can be deployed at all, and that answer should arrive on the pull request.

Deploying is **not** automated. `.github/workflows/apply-migrations.yml` still
applies migrations after CI passes on the default branch, and that is unchanged
and unaffected: it talks to Neon, not to whoever is serving the app.

## What changed in the code, and why you would care

**`src/proxy.ts` is gone.** Next 16 renamed middleware to Proxy and pinned it to
the Node.js runtime; the Cloudflare adapter refuses a Node.js proxy and exits.
Its only job was CORS for the native app, which now lives in `apiHandler` — so
it applies in local development, in the test suite and on Workers identically,
rather than only in production.

**Ninety-one API routes gained an `OPTIONS` export.** A browser sends a
preflight before anything carrying an `Authorization` header, and Next's default
answer carries no CORS headers. Seven routes deliberately do not have one,
because the native client never calls them.

**On Workers the database pool is 1 connection instead of 10.** A Worker cannot
hold a pool between requests and there are many isolates; Neon's own pooler does
the pooling. Cloudflare Hyperdrive would lower latency and is the upgrade path,
but it is a resource to provision for a problem already solved.

**PDF export is gone.** `pdfkit` was 256 KiB of a bundle that had to lose 185
KiB, and it was the only dependency whose removal cost a feature rather than a
refactor. `src/server/domain/export.ts` says so at the top, so the next person
to wonder where `toPdf` went does not have to find this file.

## Still not done

- `exceljs` has never executed on Workers — see step 3.
- Cron: nothing currently schedules `runMaintenance` on Cloudflare. On Vercel
  this was not scheduled either, so it is not a regression, but a Cron Trigger
  is the natural home for it and expiring postings depend on it running.
