# Project state

Authoritative checkpoint for any new session. **Read this first**, inspect only
what the current task needs, verify with targeted commands, and continue.

Last updated: 31 July 2026, after the onboarding features (invitations,
schedule ingestion, Google-only sign-in) were built and tested.

---

## Current phase

`AWAITING_FIRST_ADMIN_SIGN_IN`

## Current status

The web application is **live and fully configured** at
`https://shiftswitch.vercel.app`: environment variables set, database reachable,
Google sign-in wired up and verified, and the first program created. Nobody has
signed in yet, so there is no administrator. Nothing is submitted or published.

## Current blocker

**Nobody has signed in.** The first sign-in by the address in
`BOOTSTRAP_ADMIN_EMAILS` promotes that account to administrator; until then
there is no one who can configure services, rotations or residents.

## User action required

1. **Sign in once** at `https://shiftswitch.vercel.app` with the Google account
   in `BOOTSTRAP_ADMIN_EMAILS`, to become the administrator. Nobody else can do
   this — it is their Google account.
2. **Correct the program details** in Settings afterwards. The program was
   created with placeholders (`My Residency Program` / `My Hospital` /
   `America/New_York`) so the bootstrap promotion had something to attach to.
   **The timezone must be right before any schedule is imported** — every shift
   time is interpreted in it.
3. **A Google Play developer account.** One-off $25 plus identity verification,
   which can take a few days. Worth starting now; it is the long pole.
4. **An Apple Developer account.** $99/year plus identity verification. Only
   needed for the iOS app.

Also, eventually: **a Mac** for the iOS build, and **12 real testers for 14
days** if Google Play requires closed testing for this account type.

Do not ask the user for passwords or verification codes at any point.

## Next action

Everything on the server side is done and deployed except the first sign-in.
Once an administrator exists, the onboarding path is: **Admin → Program**
(correct the placeholders, above all the timezone) → **Admin → Users → Invite**
→ **Admin → Import**. See `docs/ONBOARDING.md`.

Then, in order: point `mobile/.env.production` at the live host → rebuild and
re-verify the mobile bundle → create the reviewer accounts
(`scripts/seed-demo.ts`) → Play internal testing.

Needed later, for the mobile apps: `ANDROID_PACKAGE_NAME`,
`ANDROID_CERT_FINGERPRINTS` (from the real upload key), `APPLE_TEAM_ID`,
`IOS_BUNDLE_ID`, and the FCM credentials.

`npm run setup:production` is safe to re-run; it skips what is already done.
From a network that blocks outbound TCP 5432, add `DATABASE_DRIVER=neon-ws`.

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
- **Onboarding** — admin-only invitations (hashed expiring tokens, resend,
  revoke, batch invite, public acceptance page, Google-only acceptance with a
  required email match), the downloadable schedule template and the documented
  column set, manual shift create/edit/delete, and the Google-only sign-in
  wording audit. Migration `0004_invitations.sql`, applied locally **and to the
  production Neon database**.

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
| Vercel env vars | Set on **production** only: `APP_URL`, `NEXT_PUBLIC_APP_NAME`, `DATABASE_SSL`, `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BOOTSTRAP_ADMIN_EMAILS`. `DATABASE_URL` is managed by the Neon integration and must not be overridden |
| Invitation email | **Not configured.** `RESEND_API_KEY` is the single credential that would enable automatic delivery. Without it invitations are created normally and the administrator sends the link — nothing reports a delivery that did not happen |
| First program | `My Residency Program` / `My Hospital` / `America/New_York` — **placeholders, to be corrected in Settings** |
| Vercel project | `shiftswitch`, team `rosario608-2488s-projects`, builds from `main`, root directory. Preview deployments are SSO-protected; production is not |
| Database | Neon, PostgreSQL 17.10, region us-east-1. Schema live: 26 tables, migrations 0001–0004 applied, 0 rows |
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
- **Preview deployments share the production database.** The Neon integration
  set `DATABASE_URL` for all three targets, so a pull-request preview writes to
  production data. Previews are SSO-protected, so this is not urgent, but a
  separate Neon branch for preview should be configured before anyone else
  works on the repository.
- **App Links / Universal Links are unverified.** The route-parsing logic is
  unit-tested, including that it refuses foreign origins, but verification needs
  a real host and a real device.

## Tested

| Suite | Command | Result |
|---|---|---|
| Server unit + integration | `npx vitest run` | 238 passed |
| Native client unit | `npm --prefix mobile run test` | 34 passed |
| Web end-to-end | `npx playwright test` | 56 passed (mobile + desktop projects) |
| Native client end-to-end | `npx playwright test --config playwright.mobile.config.ts` | 16 passed (including the 9 screenshot specs) |
| Screenshots | `… --config playwright.mobile.config.ts screenshots` | 9 passed, 10 images |
| Typecheck / lint | `npx tsc --noEmit`, `npm run lint`, `npm run lint:mobile` | clean |

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
- **Against the fully configured production deployment:** `/calendar/<bad token>`
  returns 404 "Calendar not found", which proves the app reached the database
  and ran the query rather than failing to connect; and
  `/api/auth/google/start` returns a redirect to `accounts.google.com` carrying
  the correct client ID, the production callback as `redirect_uri`, and a PKCE
  `code_challenge`.
- **The Google OAuth client is valid**: Google's authorisation endpoint
  returned 302 to its sign-in page for this client ID and the production
  redirect URI, so the client exists and the URI is registered.
- **The onboarding path end to end** (`tests/integration/onboarding.test.ts`):
  an empty program, two residents invited, both accepting with the Google
  identity the OAuth callback would supply, a CSV block imported, each resident
  seeing only their own shifts with the overnight row stored as one 12-hour
  shift, and a completed post-and-offer between them. Google itself is the only
  substituted piece; the signature verification that produces the identity is
  covered in `tests/integration/oidc.test.ts`.
- **The authorization boundaries around it** (`tests/e2e/security.spec.ts`,
  driven over HTTP against the real server): a resident gets 403 on the import
  template, the import preview, the import commit, the invitation list, invite
  creation, resend and revoke; a chief gets 403 on everything invitation-related
  but 200 on the import template; an invitation link shows nothing but the
  program and the invited address, and an unissued or revoked token renders the
  same neutral message as an expired one.
- **The mobile production bundle builds against the real host**
  (`https://shiftswitch.vercel.app`): no test-login path, no source maps, no
  local URL, and the production host present in the bundle.
- **`npm run check:release` against the real host, the real database and the
  real OAuth credentials now passes with no blocking problems** — one warning
  only, that no FCM credentials are configured, so push is skipped rather than
  claimed. (An earlier run reported the OAuth credentials missing; they have
  since been set.)

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
| Inviting residents and importing a schedule | `docs/ONBOARDING.md` |

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
