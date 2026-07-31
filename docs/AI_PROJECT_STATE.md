# Project state

Authoritative checkpoint for any new session. **Read this first**, inspect only
what the current task needs, verify with targeted commands, and continue.

Last updated: 31 July 2026, after the first production deployment.

---

## Current phase

`AWAITING_GOOGLE_OAUTH_CLIENT`

## Current status

The application is **deployed and publicly reachable** at
`https://shiftswitch.vercel.app`, with the database schema live behind it. No
environment variables are set yet, so nothing that touches the database works
and nobody can sign in. Nothing is submitted or published.

## Current blocker

**No environment variables on Vercel, and no Google OAuth client.** Sign-in is
the gate: until a Google OAuth client exists and the variables are set, the app
serves only its public pages.

## User action required

1. **Create a Google OAuth client** (free, needs the user's Google account).
   In the Google Cloud console: a project, then *APIs & Services → Credentials →
   OAuth client ID → Web application*, with authorised redirect URI exactly
   `https://shiftswitch.vercel.app/api/auth/google/callback`. Send the client ID
   and secret.
2. **Either** create a Vercel API token so the agent can set the environment
   variables, redeploy and verify — one action, and it covers every future
   change — **or** paste the variables into the Vercel dashboard by hand.
3. **A Google Play developer account.** One-off $25 plus identity verification,
   which can take a few days. Worth starting now; it is the long pole.
4. **An Apple Developer account.** $99/year plus identity verification. Only
   needed for the iOS app.

Also, eventually: **a Mac** for the iOS build, and **12 real testers for 14
days** if Google Play requires closed testing for this account type.

Do not ask the user for passwords or verification codes at any point.

## Next action

Set the environment variables on Vercel, redeploy, then confirm sign-in works
end to end against the real host. Required now:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon **pooled** connection string |
| `DATABASE_SSL` | `true` |
| `AUTH_SECRET` | `openssl rand -base64 48` — generate, never reuse |
| `APP_URL` | `https://shiftswitch.vercel.app` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from the OAuth client |
| `NEXT_PUBLIC_APP_NAME` | `ShiftSwitch` |
| `BOOTSTRAP_ADMIN_EMAILS` | the first administrator's Google address; clear it after the first sign-in |

Needed later, for the mobile apps: `ANDROID_PACKAGE_NAME`,
`ANDROID_CERT_FINGERPRINTS` (from the real upload key), `APPLE_TEAM_ID`,
`IOS_BUNDLE_ID`, and the FCM credentials.

Then create the first program:

```bash
APP_URL=https://<host> DATABASE_URL=<neon url> AUTH_SECRET=<generated> \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
PROGRAM_NAME="…" PROGRAM_INSTITUTION="…" PROGRAM_TIMEZONE="…" \
BOOTSTRAP_ADMIN_EMAILS=<their Google address> \
npm run setup:production
```

Safe to re-run; it skips what is already done. From a network that blocks
outbound TCP 5432, add `DATABASE_DRIVER=neon-ws`.

Then, in order: verify sign-in works against the real host → point
`mobile/.env.production` at it → rebuild and re-verify the mobile bundle →
create the reviewer accounts (`scripts/seed-demo.ts`) → Play internal testing.

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
| Vercel project | `shiftswitch`, team `rosario608-2488s-projects`, builds from `main`, root directory. Preview deployments are SSO-protected; production is not |
| Database | Neon, PostgreSQL 17.10, region us-east-1. Schema live: 25 tables, migrations 0001–0003 applied, 0 rows |
| Connection pooling | The **pooled** Neon endpoint is safe — verified empirically, see docs/DEPLOYMENT.md |

Secrets are never in the repository. `.env.production`, `key.properties`,
`*.jks`, `*.p8`, `*.p12` and `google-services.json` are all git-ignored.

## Known issues

- **iOS has never been compiled.** Building it needs Xcode, so macOS. The
  project, entitlements, privacy manifest and icons are complete and committed,
  but nothing about the iOS binary has been observed.
- **Push delivery is untested.** Without FCM/APNs credentials the no-op
  transport records every attempt as *skipped*; it never claims delivery.
- **The Capacitor plugins are untested on a device** — secure storage, push
  registration, the OS back button, haptics. They have no browser
  implementation, so the end-to-end suite cannot reach them.
- **App Links / Universal Links are unverified.** The route-parsing logic is
  unit-tested, including that it refuses foreign origins, but verification needs
  a real host and a real device.

## Tested

| Suite | Command | Result |
|---|---|---|
| Server unit + integration | `npx vitest run` | 205 passed |
| Native client unit | `npm --prefix mobile run test` | 34 passed |
| Web end-to-end | `npx playwright test` | 50 passed |
| Native client end-to-end | `npx playwright test --config playwright.mobile.config.ts` | 7 passed |
| Screenshots | `… --config playwright.mobile.config.ts screenshots` | 9 passed, 10 images |

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
- **The mobile production bundle builds against the real host**
  (`https://shiftswitch.vercel.app`): no test-login path, no source maps, no
  local URL, and the production host present in the bundle.
- **`npm run check:release -- --mobile` against the real host and database now
  reports exactly one blocking problem: the missing Google OAuth credentials.**
  Everything else — host, database, session secret, mobile environment,
  Capacitor config — passes. That single error is the whole distance between
  here and a shippable store build.

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

## Rules for this project

- Three states, never confused: **ready for submission** → **submitted** →
  **published**. Only say "published" after seeing it live in the developer
  console.
- Never claim something works without having run it.
- Never commit a signing key, a keystore password, a service-account file or a
  production env file.
- Never point a store build at a development database or a local URL.
- Never give a reviewer access to a real resident, schedule, email address or
  leave record — use `scripts/seed-demo.ts`.
