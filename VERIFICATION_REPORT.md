# Verification report — store readiness

**Date:** 1 August 2026
**App version:** 1.0.0 (build 1)
**Scope:** taking the working web/PWA application to store-ready iOS and Android
apps.

Everything marked PASS below was executed and observed in this environment.
Everything marked BLOCKED could not be executed here, and says exactly why and
exactly what a human must do. Nothing is marked on the basis that it looks
correct.

---

## Headline

| | |
|---|---|
| **Android** | **Ready for submission.** A signed release bundle was built and verified here. |
| **iOS** | **Ready for submission except for the build itself**, which requires macOS. The Xcode project, entitlements, privacy manifest, icons and version wiring are complete and committed. |
| **Published?** | **No.** Nothing has been uploaded to either store. No App Store Connect or Play Console account was used, because none was available. The app is *ready for submission*, which is not *submitted* and not *published*. |

---

## 1. Tests

| Suite | Command | Result |
|---|---|---|
| Server unit + integration | `npx vitest run` | **PASS** — 205 passed, 10 files |
| Native client unit | `npm --prefix mobile run test` | **PASS** — 34 passed, 5 files |
| Web end-to-end (Playwright, mobile + desktop) | `npx playwright test` | **PASS** — 50 passed |
| Native client end-to-end | `npx playwright test --config playwright.mobile.config.ts` | **PASS** — 7 passed |
| Store screenshots (also an end-to-end run) | `… screenshots` | **PASS** — 9 passed, 10 images produced |
| Server typecheck | `npx tsc --noEmit` | **PASS** |
| Client typecheck | `npm --prefix mobile run typecheck` | **PASS** |
| Server lint | `npm run lint` | **PASS** — no errors, no warnings |
| Client lint | `npm run lint:mobile` | **PASS** |
| Next production build | `npm run build` | **PASS** |
| Version consistency | `node mobile/scripts/set-version.mjs --check` | **PASS** |

The native end-to-end suite is the one that matters most for this phase: it
serves the compiled client from its own origin, exactly as the Capacitor
webview does, and drives it against a real Next.js server and a real
PostgreSQL database. Every request in it crosses a CORS boundary carrying a
bearer token, so it exercises the whole native path rather than the web path.

### Defects found by these tests, and fixed

These are worth listing because each would have reached a reviewer:

1. **The settings screen crashed.** It treated notification preferences as an
   array; the server returns a record keyed by category. With no error
   boundary, the crash unmounted the entire app and left a blank screen with
   no navigation and no way to sign out. Fixed the shape *and* added an
   `ErrorBoundary` keyed on the route, so one bad screen can never take the app
   down again.
2. **An unconfigured account could not delete itself.** The deletion route used
   `requireUser()`, which refuses an account with no program. Both stores
   require in-app deletion for any account that can exist. Deletion now takes a
   looser context, and the "Almost there" screen offers it.
3. **`useResource` updated a ref during render and set state synchronously in
   an effect** — two React violations that produce cascading renders. Rewritten
   to derive its loading flags from which request has settled, which also makes
   a late response from a superseded request impossible to display.

---

## 2. Android

| Check | Result | Evidence |
|---|---|---|
| Debug APK builds | **PASS** | 6.4 MB |
| Release APK builds, R8-minified | **PASS** | 1.64 MB |
| Signed release AAB builds | **PASS** | 2.44 MB |
| Signed with a real key, not the debug key | **PASS** | `CN=ShiftSwitch Development`, 4096-bit RSA, SHA384withRSA. **This is a development key held outside the repository** — see §7 |
| APK signature verifies | **PASS** | `apksigner verify`: v2 scheme, 1 signer |
| Not debuggable | **PASS** | no `application-debuggable` in the release APK |
| `targetSdkVersion` | **PASS** | 36 (Android 16), `minSdk` 24 |
| Permission set is minimal | **PASS** | `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS` declared; `VIBRATE`, `WAKE_LOCK`, `c2dm.RECEIVE` merged in by the push plugin. Nothing else |
| No location, camera, microphone, contacts, storage, calendar or Bluetooth permission | **PASS** | verified with `aapt2 dump badging` |
| Deep links present | **PASS** | App Links for `/trades`, `/switches`, `/schedule`, `/notifications` with `autoVerify`, plus the `shiftswitch://` sign-in scheme |
| Cleartext disabled | **PASS** | `usesCleartextTraffic="false"`; release network config trusts system CAs only, the user-CA exception lives in `src/debug` |
| Backup and device transfer disabled | **PASS** | `allowBackup="false"` and explicit `data_extraction_rules.xml` |
| CI permission gate works | **PASS** | the check in `.github/workflows/mobile.yml` was run against the real APK and passes |

## 3. iOS

| Check | Result | Notes |
|---|---|---|
| Xcode project generated and configured | **PASS** | `mobile/ios/` |
| Entitlements: push + associated domains | **PASS** | `App.entitlements`, registered in the project and wired to `CODE_SIGN_ENTITLEMENTS` |
| Privacy manifest | **PASS** | `PrivacyInfo.xcprivacy`, in the Copy Bundle Resources phase |
| Info.plist: URL scheme, portrait-only, strict ATS, no unused usage descriptions | **PASS** | |
| Version wiring | **PASS** | `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` driven from `version.json` by an idempotent script |
| All plists parse | **PASS** | validated with `plistlib` |
| Capacitor can still read the project after the edits | **PASS** | `cap copy ios` succeeds |
| **Build, sign, archive** | **BLOCKED** | Requires Xcode, which requires macOS. This is a Linux container. Nothing can change that |
| **CocoaPods install** | **BLOCKED** | Same reason; `cap sync ios` runs `pod install` |
| **Run on a device or simulator** | **BLOCKED** | Same reason |

## 4. Store compliance

| Item | Result | Where |
|---|---|---|
| Privacy policy at a public URL | **PASS** | `/legal/privacy`, no sign-in required |
| Terms of use at a public URL | **PASS** | `/legal/terms` |
| Apple privacy declaration worksheet | **PASS** | `APPLE_APP_PRIVACY_DECLARATION.md`, derived from the code |
| Play data safety worksheet | **PASS** | `GOOGLE_PLAY_DATA_SAFETY.md` |
| The two agree with each other, with the privacy policy, and with `PrivacyInfo.xcprivacy` | **PASS** | one audit, four outputs |
| Data retention documented | **PASS** | `docs/DATA_RETENTION.md`; the app shows the same lists before a user confirms deletion |
| In-app account deletion | **PASS** | covered by an end-to-end test, including the blocked case and the completing case |
| SDK audit | **PASS** | 16 runtime dependencies, all Capacitor/React. No advertising, analytics, attribution or crash-reporting SDK |
| Permission minimisation | **PASS** | notifications only, asked after an in-app explanation |
| No patient data | **PASS** | no field exists; stated in the policy, the terms and the review notes |
| Store metadata | **PASS** | `release/METADATA.md` — all copy within character limits |
| Screenshots | **PASS** | 10 images, captured from the running app, entirely fictional data |
| Icons and feature graphic | **PASS** | generated for every Android density, iOS, and both store listings |
| Reviewer demo environment | **PASS** | `scripts/seed-demo.ts` creates an isolated demo program; run and verified here |
| Reviewer guide | **PASS** | `release/REVIEWER_NOTES.md` |
| Release checklist | **PASS** | `release/RELEASE_CHECKLIST.md` |

### Apple Sign In (Guideline 4.8)

Evaluated rather than assumed. The app offers exactly one identity provider:
the institution's own Google Workspace account, which is the account the
employer issues and the only one a program will recognise. 4.8 applies to apps
offering a *third-party* login service as an alternative to their own; an
app that authenticates solely against the operator's own directory is not in
scope. Account linking is implemented (`user_identities`), so if a program adds
a second provider on the same verified work address it resolves to the same
resident rather than creating a duplicate. The reasoning is written out in the
review notes so a reviewer does not have to guess.

### Minimum functionality (Guideline 4.2)

The app bundles its own compiled interface. There is no `server.url` in the
Capacitor config, and `check-release-env.ts` fails the build if one appears.
The architecture decision and the alternatives rejected are in
`docs/MOBILE_ARCHITECTURE.md`.

## 5. Production separation

| Check | Result |
|---|---|
| `check-release-env.ts` refuses a localhost or http API URL | **PASS** — observed failing on the development configuration |
| Refuses a dev/test database name, a weak `AUTH_SECRET`, `ALLOW_TEST_LOGIN=true`, debug logging, missing Google credentials | **PASS** |
| Vite refuses to produce a production build against a non-https or local API URL | **PASS** — observed failing during the end-to-end setup, which is why that run passes `--mode development` |
| Production bundle contains no test-login path | **PASS** — `grep` finds none; it is tree-shaken out |
| Production bundle contains no local URLs | **PASS** — the only `localhost` string is inside react-router's history fallback |
| No source maps in the production bundle | **PASS** |
| No secrets in the repository | **PASS** — the keystore lives outside the working tree; `.env.production`, `key.properties`, `*.jks`, `*.p8`, `*.p12` and `google-services.json` are git-ignored, and the staged file list was checked before each commit |

## 6. CI/CD

| Workflow | Purpose | Status |
|---|---|---|
| `ci.yml` | Server typecheck, lint, tests, build, web end-to-end | Existing, green |
| `mobile.yml` | Client typecheck, lint, unit tests, build, bundle hygiene, native end-to-end, Android debug build, permission-set gate | **New.** YAML validated; the permission gate was executed locally against the real APK |
| `release-mobile.yml` | Manual, confirmation-gated signed bundle | **New.** Produces an artifact only — it has no path to the Play Console and cannot publish |

`mobile.yml` and `release-mobile.yml` have not yet run on GitHub, because they
are introduced by this change.

---

## 7. Blockers — what needs a human, and exactly what to do

Each of these is blocked on a credential or a machine that this environment
does not and should not have.

### 7.1 iOS build and signing — **hard blocker**

Archiving an iOS app requires Xcode, which requires macOS. There is no
workaround.

**What a human does:** `docs/MOBILE_RELEASE.md` §2. Clone on a Mac, `npm ci`,
`cap sync ios`, open in Xcode, select a team, confirm the two capabilities,
archive, upload to TestFlight. The project is otherwise ready.

### 7.2 Production signing key — **credential blocker**

The AAB verified above is signed with a **development-only** key generated for
this verification, held at `~/.shiftswitch-dev-keys/` **outside the
repository**, with a password that is not a secret. It proves the signing
pipeline works. **It must never be used for a store upload.**

**What a human does:** `docs/MOBILE_RELEASE.md` §1.1 — generate an upload key,
back it up, enrol in Play App Signing, and put it in `key.properties` locally or
in the CI secrets.

### 7.3 Firebase / APNs — **credential blocker**

Push cannot be delivered without `google-services.json` (Android), an APNs auth
key (iOS), and the FCM service-account credentials on the server.

**Current behaviour without them:** honest. `getPushTransport()` returns the
no-op transport, which records every attempt as *skipped* in `push_deliveries`.
Nothing anywhere claims a notification was delivered when it was not. The
device registry, the preference screen and the permission flow all work and are
tested; only delivery is absent.

**What a human does:** `docs/MOBILE_RELEASE.md` §1.2.

### 7.4 Store accounts — **credential blocker**

No Apple Developer account and no Google Play developer account were available,
so nothing has been created, uploaded, submitted or published. The bundle
identifier `org.shiftswitch.app` is a placeholder that must be replaced with a
domain the institution controls **before the first upload**, because it can
never be changed afterwards.

### 7.5 Reviewer Google accounts — **credential blocker**

`scripts/seed-demo.ts` is written and was run successfully here against
placeholder addresses. The real run needs two Google accounts the institution
creates for review.

**What a human does:** `release/REVIEWER_NOTES.md`, "Before you submit".

### 7.6 The production host — **configuration blocker**

The app compiles against one host, which must also serve the two deep-link
association files. `mobile/.env.production` and the App Links host must be set
before a store build.

---

## 8. What has *not* been tested, and why

Stated plainly rather than left to be discovered:

| Not tested | Why | Risk |
|---|---|---|
| The Capacitor plugins on a device — push registration, Keychain storage, the OS back button, haptics, splash screen | They have no browser implementation; the end-to-end suite runs in Chromium | Medium. Mitigated by using first-party Capacitor plugins at matching versions, and by §5 of the release checklist, which walks every one of them on a real device |
| Actual push delivery end to end | No FCM credentials (§7.3) | Medium. The dispatch path, preference filtering, dead-token handling and after-commit ordering are covered by integration tests with a recording transport |
| App Links / Universal Links verification | Needs a real host serving the association files, and a real device | Medium. The route-parsing logic is unit-tested, including that it refuses foreign origins |
| The iOS app in any form | §7.1 | High for iOS specifically. Nothing about the iOS binary has been observed |
| Google sign-in against real Google | No OAuth client for a production host | Low. The OIDC implementation is integration-tested against a mock issuer, and the web app's Google flow is unchanged |
| Behaviour on a real cellular network | Not available here | Low |

---

## 9. Statement

The Android artifact was built, signed and inspected in this environment. The
iOS project is configured but has never been compiled, because it cannot be
compiled here.

**The app has not been submitted to either store, and it has not been
published.** No developer console was accessed. Anyone reporting otherwise is
mistaken.
