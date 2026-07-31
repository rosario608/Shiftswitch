# Project state

Authoritative checkpoint for any new session. **Read this first**, inspect only
what the current task needs, verify with targeted commands, and continue.

Last updated: 31 July 2026, after PR #2 merged.

---

## Current phase

`AWAITING_PRODUCTION_HOSTING`

## Current status

The application and both mobile apps are built, tested and store-ready. Nothing
is deployed. Nothing is submitted. Nothing is published.

## Current blocker

**There is no production deployment.** The app has never run anywhere but a
development machine, and there is no public URL.

Everything remaining depends on this one thing, because a live https host is
what the following all need to be configured *against*:

- the Google OAuth redirect URI,
- the mobile apps' compiled-in API address,
- the deep-link association files (`assetlinks.json`, `apple-app-site-association`),
- the privacy-policy and terms URLs both stores require,
- the reviewer demo accounts.

## User action required

Four things need accounts, payment or identity verification, so only the user
can do them. In priority order — the first one unblocks everything:

1. **A hosting account and a PostgreSQL database.** Any provider works. Vercel
   (free tier) with Neon Postgres is the fewest moving parts for this stack and
   needs no server administration.
2. **A Google Cloud project with an OAuth client**, so residents can sign in.
   Free.
3. **A Google Play developer account.** One-off $25 plus identity verification,
   which can take a few days.
4. **An Apple Developer account.** $99/year plus identity verification. Only
   needed for the iOS app.

Also, eventually: **a Mac** for the iOS build, and **12 real testers for 14
days** if Google Play requires closed testing for this account type.

Do not ask the user for passwords or verification codes at any point.

## Next action

When the user has a hosting account and a database URL:

```bash
APP_URL=https://<host> DATABASE_URL=<url> AUTH_SECRET=$(openssl rand -base64 48) \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
PROGRAM_NAME="…" PROGRAM_INSTITUTION="…" PROGRAM_TIMEZONE="…" \
BOOTSTRAP_ADMIN_EMAILS=<their Google address> \
npm run setup:production
```

That one command checks the configuration, applies migrations, creates the first
program, and prints exactly what is left. It refuses to touch anything if the
configuration is not production, and is safe to re-run.

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
