# Moving ShiftSwitch from Vercel to Cloudflare Workers

What is done, what is not, and the steps that need an authenticated Cloudflare
account. Written to be followed in order by somebody who is not an engineer.

**Nothing here is live.** The code builds for Workers and is on a branch. No
Cloudflare resource exists yet, and Vercel is still serving production.

---

## Before anything: the two things that cost money or time

**Workers Paid, $5/month.** Not optional. The deployable bundle is **3,261 KiB
gzipped** and Cloudflare's free tier stops at 3 MiB. Measured with
`npx wrangler deploy --dry-run`, not estimated. Without the paid plan the very
first deploy is refused.

For comparison, the thing this migration avoids — Vercel Pro — is $20/month. So
the saving is real but it is $15/month, not $20.

**The database does not move.** Neon stays exactly where it is, and
`DATABASE_URL` keeps pointing at the same pooled endpoint. Nothing about the
schedule, the switches or the residents is migrated, copied or at risk during
any of this. If the cutover goes wrong the data is untouched.

---

## Step 1 — Turn on Workers Paid (2 minutes)

1. Open <https://dash.cloudflare.com>.
2. **Workers & Pages** → **Plans**.
3. Choose **Workers Paid**.

## Step 2 — Let me do the rest, or do it yourself

Run `/reload-plugins` in Claude. That loads Cloudflare's own MCP servers, the
first call prompts you to authorise, and after that the Worker, its secrets and
its domain can be created from here rather than by hand.

If you would rather do it yourself, the remaining steps are below.

## Step 3 — Create the Worker and its secrets

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
see step 5.

`NEXT_PUBLIC_APP_NAME` and `DATABASE_SSL` are not secret and can go in
`wrangler.jsonc` under `vars`.

## Step 4 — Check it before pointing anybody at it

The Worker gets a `*.workers.dev` address. Open it and confirm, in this order:

| Check | What it proves |
|---|---|
| `/api/health` — `database`, `migrations`, `auth` all `ok` | it can reach Neon and knows its own configuration |
| Sign in with Google | the OAuth redirect matches |
| Open `/schedule` | server rendering and queries work |
| **Download a schedule PDF** | `pdfkit` survives on Workers — bundled fine, never executed there |
| **Import a small spreadsheet** | `exceljs` survives on Workers — same caveat |

The last two are the genuine unknowns. They bundle, which was the surprise; they
have never actually run on Workers. Do not cut over before trying them.

## Step 5 — Google OAuth

Google refuses any redirect it has not been told about, and this is the step
that silently breaks sign-in for everybody.

1. Google Cloud Console → **APIs & Services** → **Credentials** → the OAuth
   client.
2. Under **Authorised redirect URIs**, *add* — do not replace —
   `{APP_URL}/api/auth/google/callback` for the Cloudflare address.
3. Keep the Vercel one until the cutover is finished and proven. Two entries is
   how you keep a rollback available.

## Step 6 — The custom domain, which is the actual cutover

Until this point nothing residents use has changed. Pointing the domain at the
Worker is the moment it does.

1. Cloudflare dash → the Worker → **Settings** → **Domains & Routes** → **Add
   custom domain**.
2. Wait for the certificate to issue.
3. Re-run every check in step 4 against the real address.

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

## Still not done

- A full `npm run verify` has not been run on the migration branch.
- `pdfkit` and `exceljs` have never executed on Workers — see step 4.
- Cron: nothing currently schedules `runMaintenance` on Cloudflare. On Vercel
  this was not scheduled either, so it is not a regression, but a Cron Trigger
  is the natural home for it and expiring postings depend on it running.
