# Setup

This guide covers local development, the database, and Google sign-in.

---

## 1. Requirements

- Node.js 20 or newer (developed on 22)
- PostgreSQL 14 or newer — locally, in Docker, or hosted (Supabase, Neon, RDS)
- A Google Cloud project for OAuth credentials

---

## 2. Install

```bash
npm install
cp .env.example .env.local
```

Generate a session secret:

```bash
openssl rand -base64 48        # paste into AUTH_SECRET in .env.local
```

---

## 3. Database

### Option A — local PostgreSQL

```bash
createdb shiftswitch_dev
createdb shiftswitch_test          # used by the integration suite
```

Set in `.env.local`:

```
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/shiftswitch_dev
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/shiftswitch_test
DATABASE_SSL=false
```

### Option B — Supabase (or any hosted PostgreSQL)

1. Create a project at <https://supabase.com/dashboard>.
2. **Project Settings → Database → Connection string → URI.** Copy it into
   `DATABASE_URL` and replace `[YOUR-PASSWORD]` with the database password.
3. Set `DATABASE_SSL=true`.
4. Use the *session* pooler connection string (port 5432) rather than the
   transaction pooler: ShiftSwitch relies on `SELECT … FOR UPDATE` inside
   multi-statement transactions, which transaction pooling breaks.

ShiftSwitch talks to PostgreSQL directly with the `pg` driver and manages its
own schema, so a Supabase project works as a plain managed PostgreSQL database.
Supabase Auth is **not** used — see "Why not Supabase Auth?" below.

### Apply the schema

```bash
npm run db:migrate      # apply pending migrations
npm run db:reset        # drop the public schema and re-apply from scratch
npm run db:seed         # demo data (destructive)
npm run db:setup        # reset + seed in one step
```

Migrations are plain SQL files in `db/migrations`, applied in filename order,
each inside its own transaction, and recorded with a checksum in
`schema_migrations`. Editing a migration that has already been applied is
refused — add a new one instead.

---

## 4. Google sign-in

### 4.1 Create the OAuth client

1. Open <https://console.cloud.google.com/> and create (or select) a project.
2. **APIs & Services → OAuth consent screen**
   - User type: *Internal* if every resident has an account in your Google
     Workspace, otherwise *External*.
   - App name: `ShiftSwitch` (or your program's name).
   - Support email and developer contact: your program coordinator.
   - Scopes: `openid`, `email`, `profile` — nothing else is requested.
   - For *External* apps, add your residents as test users until the app is
     published.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorized JavaScript origins**
     - `http://localhost:3000` (development)
     - `https://your-domain.example` (production)
   - **Authorized redirect URIs**
     - `http://localhost:3000/api/auth/google/callback`
     - `https://your-domain.example/api/auth/google/callback`
4. Copy the client ID and client secret into `.env.local`:

```
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-…
APP_URL=http://localhost:3000
```

The redirect URI is derived from `APP_URL`, so it must match the value
registered with Google exactly (scheme, host, port, no trailing slash).

### 4.2 Restrict who can sign in

Two independent controls:

- `GOOGLE_HOSTED_DOMAIN=hospital.org` — asks Google to show only accounts from
  that Workspace domain, and rejects an `id_token` whose `hd` claim differs.
- **Program → Approved email domains** (in the admin UI) — the server refuses
  sign-in for a configured user whose email domain is not on the program's list.
  Leave it empty to allow any account an administrator has explicitly
  configured.

Neither control grants access on its own: a brand-new Google account always
lands on "your account is not yet configured" until an administrator assigns a
role and a program.

### 4.3 Bootstrapping the first administrator

A fresh database has no administrator, so nobody can configure anyone. Set:

```
BOOTSTRAP_ADMIN_EMAILS=you@hospital.org
```

The first sign-in from that address — and only while the instance has no
administrator at all — creates an administrator attached to the first program in
the database. Clear the variable afterwards.

If you seeded demo data, `admin@hospital.org` already exists and the bootstrap
path is inert.

### Why not Supabase Auth?

The brief suggested Supabase for database *and* authentication. This
implementation uses Supabase (or any PostgreSQL) for the database and implements
Google OIDC directly, because:

- the sign-in flow stays portable across hosts — nothing outside PostgreSQL is
  required to run or test it, including in CI;
- the full authorization-code + PKCE flow is verified end-to-end in this
  repository (`src/server/auth/oidc.ts`, `tests/integration/auth.test.ts`)
  rather than delegated to a hosted service that tests cannot exercise;
- sessions live in the same database and transaction boundary as the rest of the
  domain, so deactivating a user really does end their sessions.

Swapping in Supabase Auth later means replacing `src/server/auth/oidc.ts` and
`session.ts`; nothing in the domain layer depends on how identity was obtained.

---

## 5. Environment variables

| Variable                 | Required | Purpose                                                            |
| ------------------------ | -------- | ------------------------------------------------------------------ |
| `DATABASE_URL`           | yes      | PostgreSQL connection string                                        |
| `TEST_DATABASE_URL`      | tests    | Database used by the integration suite (wiped between tests)        |
| `DATABASE_SSL`           | no       | `true` for hosted databases that require TLS                        |
| `DATABASE_POOL_MAX`      | no       | Connection pool size (default 10)                                   |
| `APP_URL`                | yes      | Public origin; determines the OAuth redirect URI and cookie `secure`|
| `NEXT_PUBLIC_APP_NAME`   | no       | Product name shown in the UI and generated emails                   |
| `GOOGLE_CLIENT_ID`       | yes      | Google OAuth client ID                                              |
| `GOOGLE_CLIENT_SECRET`   | yes      | Google OAuth client secret                                          |
| `GOOGLE_HOSTED_DOMAIN`   | no       | Restrict sign-in to one Google Workspace domain                     |
| `AUTH_SECRET`            | yes      | 32+ byte random string for cookie/state signing                     |
| `SESSION_TTL_DAYS`       | no       | Session lifetime (default 30)                                       |
| `BOOTSTRAP_ADMIN_EMAILS` | no       | Comma-separated emails allowed to self-promote on an empty instance |
| `ALLOW_TEST_LOGIN`       | no       | Enables the test sign-in endpoint; ignored in production            |
| `LOG_LEVEL`              | no       | `debug` \| `info` \| `warn` \| `error`                              |

Never commit `.env.local`. `.env.example` and `.env.test` contain no secrets.

---

## 6. First run checklist

```bash
npm run db:setup
npm run dev
```

1. Open <http://localhost:3000> — you are redirected to the sign-in screen.
2. Click **Continue with Google** (or use the development sign-in panel).
3. A brand-new Google account lands on "your account is not yet configured".
4. Sign in as `admin@hospital.org` (seeded) and open **Admin → Users** to give
   the new account a role, program and PGY level.
5. Sign back in as that account — the schedule is now visible.

---

## 7. Running the test suites

```bash
npm run test           # unit + integration (needs TEST_DATABASE_URL)
npm run test:e2e       # Playwright; starts a dev server automatically
```

See [TESTING.md](TESTING.md).
