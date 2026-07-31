# Mobile architecture: audit and decision

## 1. Audit of the existing application

Taken from the repository as it stands before any mobile work.

| Area | What is there today |
| --- | --- |
| Framework | Next.js 16.2.12 (App Router), React 19.2.4, TypeScript 5.9, Tailwind CSS 4 |
| Rendering | Server Components for every authenticated page (`export const dynamic = "force-dynamic"`); client components only for interaction |
| Backend | Same Next.js process. 38 route handlers under `src/app/api`, all mutations included |
| Business logic | `src/server/domain` — trades, validation, rules engine, matching, email, import/export, admin, audit, notifications. UI contains no business rules |
| Database | PostgreSQL via `pg` with hand-written SQL and forward-only migrations (`db/migrations`). Partial unique indexes enforce one active assignment per shift and one live post per shift |
| Authentication | Google OpenID Connect implemented directly (authorization code + PKCE, state, nonce, JWKS verification) in `src/server/auth/oidc.ts`. Opaque session tokens stored as SHA-256 hashes in `sessions`; delivered as an `httpOnly` cookie |
| Authorization | `requireUser` / `requireRole` / `requireResident` guards read role and program from the database session; domain services re-assert privileged operations |
| PWA | `app/manifest.ts`, maskable icons, `public/sw.js` caching the shell but never API traffic, an offline route and an offline banner |
| Notifications | In-app only: `notifications` table + `/api/notifications`. No transport to a device |
| Calendar | None |
| Environment config | `.env.local` / `.env.test`; `DATABASE_URL`, `APP_URL`, Google client credentials, `AUTH_SECRET`, `ALLOW_TEST_LOGIN` |
| Deployment | Node server (`next start`) plus PostgreSQL. CI runs typecheck, lint, 174 unit/integration tests, build and 50 Playwright tests |
| Mobile-specific code | Responsive mobile-first layout, bottom navigation, bottom sheets, safe-area padding, offline detection. Nothing native |

Nothing in this list needs to be rewritten. The database, domain layer, rules
engine and API are all reusable as-is; the mobile work is additive.

## 2. Options considered

### A. Capacitor loading the production website (`server.url`)

Fastest path, zero UI work. Rejected: the binary would contain no application —
every screen would be a remote web page. That is the case Apple's guideline 4.2
("Minimum Functionality") is written for, and the brief explicitly rules it out.
It also makes push routing, offline behaviour and session handling awkward,
because the app has no state of its own.

### B. React Native / Expo rewrite

Best native fidelity, but it throws away the entire existing UI layer and
introduces a second component system, a second styling system and a second set
of tests, for an application whose value is in its server-side rules engine and
transaction model rather than in bespoke native rendering. It would also
duplicate the design system. Rejected on maintainability grounds.

### C. Capacitor with a client application bundled in the binary — **chosen**

The mobile app ships its own compiled UI (a Vite + React single-page app in
`mobile/`) that talks to the existing Next.js API over HTTPS. The web app is
untouched and keeps working exactly as before.

| Criterion | How option C scores |
| --- | --- |
| Code reuse | The entire backend, database, rules engine and API are shared. The design tokens and component idioms are shared by copy, not by import, so the two UIs can diverge where the platforms differ |
| Native functionality | Push notifications, deep links, secure storage, share sheet, calendar subscription, haptics, app lifecycle refresh, hardware back — all first-class Capacitor plugins |
| Authentication | Native OAuth in the system browser (`SFSafariViewController` / Custom Tabs) with a custom-scheme handoff, then a bearer token in the platform keychain/keystore |
| Push notifications | FCM on Android, APNs (via FCM) on iOS, with the token registry and dispatch implemented server-side |
| Deep linking | Custom scheme plus universal/app links, routed to the exact trade, shift, switch or approval |
| Secure storage | Keychain / EncryptedSharedPreferences via `@capacitor/preferences` backed by the platform secure store |
| Performance | The UI is local; only data crosses the network. No first-paint round trip |
| App Review | The binary contains a real application, not a browser pointed at a website |
| Maintainability | One backend, one set of business rules, two thin presentation layers |

## 3. Consequences of the decision

1. **The API becomes the contract.** It already is for the web client's
   mutations; the mobile client uses the same endpoints for reads too.
2. **Bearer tokens alongside cookies.** A WebView on a custom scheme cannot rely
   on the `Lax` session cookie, so `sessions` gains a second presentation:
   `Authorization: Bearer <token>`. It is the same row, the same hash, the same
   expiry and the same revocation path — no second auth system.
3. **Scope of the mobile app.** Resident and chief workflows: schedule, posting,
   offering, accepting, approvals, completed switches and the program email,
   notifications, profile and settings. Program administration (users, rules,
   contacts, import/export, analytics) stays in the web app and is linked out.
   That is a deliberate product decision, not an omission: administrators work
   at a desk, residents work on a phone.
4. **The web app and the PWA remain fully functional and unchanged.**

## 4. What the native app adds that the web app cannot

- Push notifications that reach a resident who does not have the app open —
  the difference between "an offer expired" and "an offer was accepted".
- Notification and link routing straight into the relevant trade, shift,
  approval or completed switch.
- A subscribable calendar feed the phone's own calendar keeps in sync.
- Tokens in the platform secure store rather than a browser cookie jar.
- Hardware back, pull-to-refresh, haptics, native share for the program email,
  and refresh-on-foreground.
