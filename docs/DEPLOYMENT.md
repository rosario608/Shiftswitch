# Deployment

ShiftSwitch is a standard Next.js application with a PostgreSQL database. It
runs anywhere Node.js 20+ runs.

---

## 1. Provision the database

Any managed PostgreSQL works (Supabase, Neon, RDS, Cloud SQL, self-hosted).

Requirements:

- PostgreSQL 14 or newer;
- the `pgcrypto` extension is created by the first migration;
- TLS enabled (`DATABASE_SSL=true`).

### Connection pooling

A **transaction-pooled** connection string is fine, and is what you should use
on a serverless platform. The trade finaliser holds `SELECT … FOR UPDATE` row
locks across several statements, but always *within one transaction*, and a
transaction pooler pins a transaction to a single backend for its whole
lifetime. What transaction pooling breaks is session state that outlives a
transaction — named prepared statements, `SET`, `LISTEN`/`NOTIFY`, session-level
advisory locks — and this application uses none of them.

Verified against Neon's pooled endpoint on 31 July 2026:

- a second transaction requesting the same row waited 1535 ms for a lock held
  1501 ms, so it genuinely blocked rather than reading through the lock;
- ten concurrent read-modify-write transactions produced exactly ten
  increments, so no update was lost.

If you are unsure about a particular provider, run that check against it rather
than guessing — a lost update here means two residents both think they are off.

Apply migrations before the new build serves traffic:

```bash
DATABASE_URL=… npm run db:migrate
```

Migrations are forward-only, idempotent to re-run, and recorded with checksums.
Never edit an applied migration; add a new file instead. Do not modify the
production schema from application code.

---

## 2. Configure Google OAuth for the production domain

In the Google Cloud console, add to the same OAuth client:

- Authorized JavaScript origin: `https://your-domain.example`
- Authorized redirect URI: `https://your-domain.example/api/auth/google/callback`

Then set `APP_URL=https://your-domain.example`. The redirect URI is derived from
it, and `APP_URL` starting with `https://` is also what makes the session cookie
`Secure`.

If your program uses Google Workspace, set `GOOGLE_HOSTED_DOMAIN` as well, and
configure **Approved email domains** on the program in the admin UI.

---

## 3. Environment

Required in production:

```
DATABASE_URL=postgres://…            # session-mode connection string
DATABASE_SSL=true
APP_URL=https://your-domain.example
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
AUTH_SECRET=…                        # openssl rand -base64 48
NEXT_PUBLIC_APP_NAME=ShiftSwitch
```

Must **not** be set in production:

```
ALLOW_TEST_LOGIN                     # ignored when NODE_ENV=production, but leave it unset
BOOTSTRAP_ADMIN_EMAILS               # clear it once the first administrator exists
```

Secrets belong in your platform's secret store. Nothing sensitive is ever
exposed to the browser: only `NEXT_PUBLIC_*` variables reach client code, and
the only one used is the app name.

---

## 4. Build and run

```bash
npm ci
npm run build
npm start                # or: node .next/standalone/server.js on platforms that use it
```

On Vercel, the defaults work: build command `npm run build`, and the App Router
handles the rest. Run `npm run db:migrate` as a release step.

Behind a reverse proxy, forward `X-Forwarded-For` and `X-Forwarded-Proto`, and
terminate TLS in front of the app.

---

## 5. First administrator

1. Deploy with `BOOTSTRAP_ADMIN_EMAILS=you@hospital.org`.
2. Create the program row (the admin UI needs one to exist; the seed script
   creates one, or insert it directly).
3. Sign in with that Google account — you become an administrator of the first
   program.
4. Remove `BOOTSTRAP_ADMIN_EMAILS` and redeploy.
5. Configure the program under **Admin → Program**, add contacts, rules, and
   import the schedule under **Admin → Import**.

---

## 6. Scheduled housekeeping

`POST /api/admin/maintenance` (chief or administrator) expires stale trade posts
and offers and marks shifts whose end time has passed as completed. It is
idempotent and safe to run repeatedly. Run it from your platform's scheduler
(for example hourly) with a session belonging to a chief account, or invoke
`runMaintenance()` from a small script on a cron.

There is also a **Run housekeeping** button under **Admin → Overview** for
manual use.

---

## 7. Operational notes

- **Logs.** Structured JSON on stdout with a redaction list. Watch for
  `event: "api.unhandled"` (server faults) and `event: "trade.completed"`.
- **Backups.** The audit log and completed trades are the record of who worked
  what. Back the database up accordingly; both tables are append-only.
- **Scaling.** All state is in PostgreSQL, so the app scales horizontally.
  Size `DATABASE_POOL_MAX` to your database's connection limit divided by the
  number of instances.
- **Rollback.** Application rollback is safe at any time. Because migrations are
  forward-only, roll back the app first and write a compensating migration if
  the schema must change back.
