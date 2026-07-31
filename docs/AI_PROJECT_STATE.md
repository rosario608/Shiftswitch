# Project state

Authoritative checkpoint for any new session. **Read this first**, inspect only
what the current task needs, verify with targeted commands, and continue.

Last updated: 31 July 2026, after the five-role permission model, service
management, the rebuilt invite field and the development invitation sandbox.

---

## Current phase

`AWAITING_PROGRAM_ROSTER`

## Current status

Live and in use at `https://shiftswitch.vercel.app`, with one administrator and
the program named **Internal Medicine / DUH / America/New_York**. Still no
residents, services or shifts in production.

Since the last checkpoint the product gained the five-role model, a Services
screen, a conventional multi-address invite field, and a development-only
invitation sandbox so one person can test the whole onboarding flow alone.
**Migration 0005 has not yet been applied to production** — see Next action.

## Current blocker

The program has no people and no schedule. Neither can be invented: they are the
institution's real roster and real block schedule.

## User action required

1. **The residents' email addresses**, for **Admin → Users & roles → Invite
   people**. Paste them in any format — commas, semicolons, one per line, or a
   spreadsheet column.
2. **The block schedule**, as CSV or XLSX, for **Admin → Import**. Download the
   template there first.
3. **A Google Play developer account.** $25 plus identity verification; the long
   pole for Android.
4. **An Apple Developer account.** $99/year plus identity verification.
5. **A bundle id on a domain the institution controls**, replacing
   `org.shiftswitch.app`. It can never be changed after the first store upload.

Also eventually: a Mac for the iOS build, and 12 real testers for 14 days if
Play requires closed testing.

Do not ask the user for passwords or verification codes at any point.

## Next action

**Apply migration 0005 to the production Neon database** before or with the next
deploy — it adds the `apd` and `pd` enum values, the service/rotation
abbreviation column, and case-insensitive uniqueness. Nothing in the running app
uses them until it is applied, and the deploy will fail closed rather than
corrupt anything, but it must not be forgotten:

```bash
DATABASE_DRIVER=neon-ws DATABASE_URL=<pooled neon url> npx tsx scripts/migrate.ts
```

Then the program setup sequence: **Admin → Program settings** → **Admin →
Services** → **Admin → Users & roles → Invite people** → **Admin → Import**.
See `docs/ONBOARDING.md`.

For the mobile apps, `mobile/.env.production` already points at the live host.
Still needed later: `ANDROID_PACKAGE_NAME`, `ANDROID_CERT_FINGERPRINTS`,
`APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, and FCM credentials.

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
  PR #3, merged.
- **Roles, services and the invitation sandbox** — the five-role model
  (Resident, Chief, APD, PD, Administrator) as an explicit capability matrix
  replacing the old three-tier rank; a Services screen; a conventional
  multi-address invite field; role management with assignment rules; and a
  development-only invitation sandbox. Migration `0005_roles_and_services.sql`,
  applied locally, **not yet applied to production**.
- **Demo program and schedule architecture** — `ShiftSwitch Demo Residency`
  (21 people, ~370 shifts over four weeks, four posted switches, three
  invitations in three states) with idempotent, deterministic seed/reset
  commands and a three-gate production interlock; the `ScheduleSource` seam so
  MedHub can become a source later without touching the scheduling model; and
  shift editing extended to move a shift in time.

## Demo data

`npm run demo:seed` · `npm run demo:reset` · `npm run demo:status`

Builds **ShiftSwitch Demo Residency**: 18 residents, 2 chiefs, 1 administrator,
six services, four weeks of shifts including overnights and 24-hour weekend
call, four posted switches, and invitations in pending, expired and revoked
states. Everything is invented and every address is under `.invalid`, which can
never be delivered to.

Refuses to run unless `NODE_ENV` is not production, the database is local (or
`ALLOW_REMOTE_DEMO_DATA=true` is set deliberately), and neither the database
name nor `APP_URL` looks like production. Every destructive statement is scoped
to the demo program's name.

Deterministic: the same anchor Monday always produces byte-identical data.
Idempotent: a seed removes and rebuilds rather than merging.

Accounts, the four trade scenarios and the three invitation scenarios are
documented in `docs/DEMO_DATA.md` and asserted in
`tests/integration/demo-data.test.ts`.

**Multi-person swaps are not supported** — every switch is between exactly two
residents. `trade_legs.leg_index` would accommodate more; the domain does not.

## Roles

Five, in seniority order: **Resident → Chief resident → APD → PD →
Administrator**. Permissions are an explicit capability matrix, not a rank —
`src/server/auth/roles.ts` is the source of truth and `docs/ROLES.md` describes
it.

Guards name a capability (`requireCapability("services.manage")`), the admin
navigation is generated from the same matrix, and a role may only ever be
assigned to somebody strictly junior to the assigner. Nobody may change their
own role.

## Environment safety

`src/server/config/environment.ts` answers two separate questions, and they are
deliberately not the same one:

- **Can email reach a real person from here?** Only in a production build *and*
  with `RESEND_API_KEY` set. A staging deployment holding production's
  credentials still sends nothing.
- **Is the invitation sandbox available?** Only outside production *and* with
  `ALLOW_TEST_LOGIN=true`. Two independent locks; a production build cannot
  reach it whatever the flag says.

Every administrative screen shows a badge naming the environment whenever it is
not production-with-email.

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
| Vercel env vars | Set on **production** only: `APP_URL`, `NEXT_PUBLIC_APP_NAME`, `DATABASE_SSL`, `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. `DATABASE_URL` is managed by the Neon integration and must not be overridden |
| `BOOTSTRAP_ADMIN_EMAILS` | **Removed**, and production redeployed to drop it, now that an administrator exists. It was already inert — the bootstrap only fires while the instance has no administrator at all — but leaving it set would make it live again if that account were ever deleted |
| Invitation email | **Not configured.** `RESEND_API_KEY` is the single credential that would enable automatic delivery. Without it invitations are created normally and the administrator sends the link — nothing reports a delivery that did not happen |
| First program | **Internal Medicine / DUH / America/New_York** — corrected from the placeholders by the administrator. The timezone governs every shift time, so it is worth a second look before the first import |
| Administrator | One, the repository owner's Google account: role `admin`, identity linked, first sign-in 31 July 2026 17:29 UTC |
| Vercel project | `shiftswitch`, team `rosario608-2488s-projects`, builds from `main`, root directory. Preview deployments are SSO-protected; production is not |
| Database | Neon, PostgreSQL 17.10, region us-east-1. Migrations 0001–0004 applied in production; **0005 applied locally only**. Contents: 1 program, 1 user, 0 residents, 0 services, 0 shifts |
| Connection pooling | The **pooled** Neon endpoint is safe — verified empirically, see docs/DEPLOYMENT.md |

Secrets are never in the repository. `.env.production`, `key.properties`,
`*.jks`, `*.p8`, `*.p12` and `google-services.json` are all git-ignored.

## Defects found and fixed (roles/services session)

Reported from hands-on use, plus two the new tests surfaced:

1. **The invite field could not be typed in.** Root cause was not the field —
   `Sheet`'s focus effect depended on `onClose`, which every caller passes as an
   inline arrow, so its identity changed on every render. The effect re-ran on
   every keystroke and pulled focus back to the sheet's close button. Every
   sheet in the app was affected: shift editor, offer sheet, service sheet. The
   effect is now keyed on `open` alone, with `onClose` held in a ref.
2. **The invite field was a textarea with parsing rules you had to know.**
   Replaced with a conventional chip input: Enter/comma/semicolon commit,
   pasting a list or a spreadsheet column works, each address is a removable
   chip, invalid ones are flagged red and duplicates amber, individually.
   Separators are detected from the value rather than the keystroke, because
   Android soft keyboards report punctuation as keyCode 229.
3. **There was no way to add a service.** They only existed as a side effect of
   importing. Added **Admin → Services** with create, rename, short name,
   swappable flag, deactivate/reactivate, and case-insensitive duplicate
   prevention.
4. **Accepting a *chief* invitation created no resident record.**
   `acceptInvitation` checked `role === "resident"` literally, so every invited
   chief got an account that could not hold a shift or trade — the exact failure
   the surrounding comment warned about. Now uses the shared
   `expectsResidentRecord` predicate.
5. **Roles were a three-tier rank** (`resident < chief < admin`) with
   permissions expressed as `rank >= n`. Replaced with five roles and an
   explicit capability matrix.

## Defects found and fixed this session

All found by tests that did not exist before, and all fixed:

1. **`scripts/seed-demo.ts` configured four rule types that do not exist**
   (`max_consecutive_days`, `min_rest_between_shifts`, `pgy_level_match`,
   `max_hours_per_week`). `rules.rule_type` is plain text with no foreign key, so
   the rows inserted happily and were then never evaluated — the App Review demo
   program looked governed and was not, which is the one thing that seeder exists
   to avoid. Corrected to the real identifiers, and **both** seeders now refuse
   to insert a rule type with no registered handler.
2. **`scripts/seed-demo.ts` could be run once but not twice.** It deleted users
   before shifts, and `shift_assignments.resident_id` is ON DELETE RESTRICT, so
   the second run failed on a foreign key despite the file claiming re-running
   was safe. Fixed by deleting in dependency order.
3. **Editing a shift into a daylight-saving gap returned a 500.**
   `zonedWallTimeToInstant` correctly refuses a wall-clock time that does not
   exist, but `updateShift` let the error escape untranslated. It is now a 422
   carrying the explanation.
4. **The first version of the demo schedule violated the program's own
   `max_consecutive_shifts` rule** — a Sunday ward shift chained into the
   following Monday, giving seven days in a row before any trade. Every candidate
   in the demo was therefore ineligible for a reason unrelated to the trade being
   demonstrated. Patterns now stop at six days and Sunday is covered by the
   weekend call shift, which is asserted directly.
5. **The import's "unknown resident" message told administrators to add people
   under Users**, which predates invitations. It now says to invite them.

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
- **Multi-person swaps are not implemented.** Every switch is between exactly
  two residents; `finaliseTrade` writes two legs. The schema would carry more.
  Nothing in the product claims otherwise.
- **No invitation has been *accepted* through a real Google account.** The live
  path was verified up to Google's own consent screen (see Tested); the step
  past it needs a second human Google account and cannot be automated. The
  redemption logic itself is tested directly with the identity the callback
  supplies, and the callback's signature verification against a local OpenID
  provider.
- **App Links / Universal Links are unverified.** The route-parsing logic is
  unit-tested, including that it refuses foreign origins, but verification needs
  a real host and a real device.

## Tested

| Suite | Command | Result |
|---|---|---|
| Server unit + integration | `npx vitest run` | 342 passed |
| Native client unit | `npm --prefix mobile run test` | 34 passed |
| Web end-to-end | `npx playwright test` | 100 passed (mobile + desktop projects) |
| Native client end-to-end | `npx playwright test --config playwright.mobile.config.ts` | 16 passed (including the 9 screenshot specs) |
| Screenshots | `… --config playwright.mobile.config.ts screenshots` | 9 passed, 10 images |
| Typecheck / lint | `npx tsc --noEmit`, `npm run lint`, `npm run lint:mobile` | clean |
| Production build | `npm run build` | succeeds |

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
- **The self-test path** (`tests/e2e/roles-and-onboarding.spec.ts`, 13 tests):
  an administrator finds Services in the navigation and creates one, is refused
  a case-insensitive duplicate and a deactivation that would strand upcoming
  shifts; the invite field is driven the way a person drives it (Enter, comma,
  semicolon, an invalid address, a duplicate, Backspace-to-edit, per-chip
  removal); a synthetic resident and a synthetic chief are invited, accepted
  through the sandbox, and land with the right role, program and resident
  record; a resident is refused every administrative route; a chief gets the
  schedule and approvals but not users, services or settings; an APD gets people
  and services but not program settings or maintenance; a PD can rename the
  program but cannot appoint a peer or touch an administrator; nobody can change
  their own role; and a revoked invitation cannot be accepted even in the
  sandbox.
- **The whole lifecycle over real HTTP** (`tests/e2e/lifecycle.spec.ts`, 8
  tests): an administrator signs in, invites, watches a superseded link die and
  the current one work, is refused when inviting an existing member, downloads
  the template, previews an import (writing nothing), commits it, re-imports it
  idempotently, is refused a PDF renamed `.xlsx` and a file with the wrong
  columns, then moves a shift in time, reassigns it, is refused an impossible
  edit, creates one by hand and deletes it — after which a resident posts a
  shift, a colleague sees ranked candidates and offers, the wrong person is
  refused the acceptance, the right one completes it, both schedules move, and
  the same offer cannot be accepted twice.
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
- **The demo seeder** (`tests/integration/demo-data.test.ts`, 24 tests): the
  interlock refuses production, a remote database without explicit opt-in, a
  production-looking database name and a production-looking `APP_URL`; the
  seeded program has the documented shape, uses only `.invalid` addresses, gives
  nobody a sign-in identity, stores overnight shifts as 12 hours and call as 24,
  puts weekday sessions on weekdays, and does not violate its own rules; all
  four trade scenarios behave as documented; seeding twice from nothing produces
  byte-identical data; and a reset after a completed switch removes everything.
  The CLI was also run for real: seed, seed again, status, reset, and refusals
  with a non-zero exit for `NODE_ENV=production` and a remote database.
- **Manual schedule management** (`tests/integration/schedule-admin.test.ts`,
  14 tests): moving a shift in date and time together, moving only the date,
  turning a day shift into an overnight one without splitting it, refusing an
  end before the start, the DST gap and the repeated hour, invalidating live
  offers with a notification, reassigning and unassigning, and the schedule
  source seam.
- **The live invitation path, against production, on 31 July 2026.** A real
  invitation row was seeded in the live program and every check was made against
  the production server: the public page renders the program name, institution,
  invited address and inviter; it offers only "Continue with Google"; the
  handoff carries the token; `/api/auth/google/start?invite=…` returns 307 to
  `accounts.google.com` with a PKCE `code_challenge`, and the token travels in
  an HttpOnly cookie rather than the redirect URL. Revoking killed the link
  immediately and the page stopped offering sign-in. The invitation was then
  deleted — production has zero invitations and is exactly as it was.
- **The live sign-in page carries no non-Google wording** — fetched from
  production and checked for "hospital log-in", "institutional", "single
  sign-on" and "password". Only "Continue with Google" and "the Google account
  your program has on file" are present.
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
| The synthetic demo program and its scenarios | `docs/DEMO_DATA.md` |
| Roles and the permission matrix | `docs/ROLES.md` |

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
