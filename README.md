# ShiftSwitch

*Find coverage.*

A mobile-first web application for residency shift trading. A resident opens the
app on their phone, posts a shift, and a colleague swaps into it — with the
program's own rules checked on the server, both schedules updated in a single
atomic transaction, and the coordinator email written for them.

---

## The workflow this product exists for

```
Google sign-in → Home → Schedule → Select shift → Post for trade
      → Colleague finds it → Offers one of their shifts → Server validates
      → Poster accepts → (chief approves, if required)
      → Both assignments swap atomically → Audit + notifications
      → "Notify program" → coordinator email pre-filled → sent from the
        resident's own mail app
```

Everything else in the app supports that path.

---

## What is real here

- **Real database.** PostgreSQL with foreign keys, check constraints, partial
  unique indexes, and forward-only SQL migrations.
- **Real authentication.** Google OpenID Connect (authorization code flow with
  PKCE, `state`, `nonce`, and `id_token` signature verification against Google's
  JWKS). Sessions are opaque tokens stored as SHA-256 hashes.
- **Real authorization.** Every role and program membership is read from the
  database session. No client-supplied role is ever trusted.
- **Real rules.** A configurable rules engine evaluates rest, consecutive work,
  workload caps, PGY and credential requirements, service restrictions, notice
  periods, blackout and holiday dates, and approval policy — returning
  structured, human-readable checks rather than a boolean.
- **Real atomicity.** A completed switch ends two assignments, creates two new
  ones, invalidates competing offers, writes the completed-trade record, the
  notifications and the audit entries — all in one transaction, behind row
  locks. Concurrency is covered by tests that fire simultaneous requests.
- **Real email.** The program-notification email is generated from the completed
  trade record and handed to the resident's own mail client via an encoded
  `mailto:` link. The app tracks *generated → opened → marked sent* and never
  claims delivery it cannot observe.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env.local        # then edit DATABASE_URL, AUTH_SECRET, Google keys

# 3. Create the schema and demo data
npm run db:setup                  # migrate (from scratch) + seed

# 4. Run
npm run dev                       # http://localhost:3000
```

Full instructions — including PostgreSQL, Supabase and Google OAuth setup — are
in [docs/SETUP.md](docs/SETUP.md).

### Demo accounts

`npm run db:seed` creates a program with 32 residents, ~470 shifts across ten
weeks, program rules, contacts, open trade posts, a pending offer, a completed
switch with its generated email, and a switch waiting for approval.

| Account                   | Role                                 |
| ------------------------- | ------------------------------------ |
| `resident01@hospital.org` | Resident (PGY-1)                     |
| `resident02@hospital.org` | Resident (PGY-2)                     |
| `chief@hospital.org`      | Chief resident                       |
| `admin@hospital.org`      | Program administrator                |
| `new.intern@hospital.org` | Authenticated but not yet configured |

In development (`ALLOW_TEST_LOGIN=true`) the sign-in screen offers a development
sign-in panel for these accounts, so you can click through the product without
Google credentials. It is refused outright when `NODE_ENV=production`.

---

## Scripts

| Command                    | What it does                                               |
| -------------------------- | ---------------------------------------------------------- |
| `npm run dev`              | Development server on port 3000                             |
| `npm run build`            | Production build                                            |
| `npm start`                | Serve the production build                                  |
| `npm run db:migrate`       | Apply pending migrations                                    |
| `npm run db:reset`         | Drop and recreate the schema, then migrate                  |
| `npm run db:seed`          | Load demo data (destructive)                                |
| `npm run db:setup`         | `db:reset` + `db:seed`                                      |
| `npm run e2e:fixture`      | Load the deterministic fixture used by the E2E suite        |
| `npm run demo:seed`        | Build the synthetic demo program (dev/staging only)         |
| `npm run demo:reset`       | Remove it                                                   |
| `npm run demo:status`      | Report what is seeded                                       |
| `npm run test`             | Unit + integration tests (Vitest, against a real database)  |
| `npm run test:unit`        | Unit tests only                                             |
| `npm run test:integration` | Integration tests only                                      |
| `npm run test:e2e`         | End-to-end tests (Playwright, mobile + desktop)             |
| `npm run typecheck`        | `tsc --noEmit`                                              |
| `npm run lint`             | ESLint                                                      |
| `npm run verify`           | typecheck + lint + tests + production build                 |

---

## Architecture

```
src/
  app/                     Next.js App Router
    (app)/                 authenticated shell: home, schedule, trades,
                           switches, notifications, profile, admin
    login/  pending/       unauthenticated and unconfigured states
    api/                   route handlers (all mutations, plus client reads)
  components/
    ui/                    design-system primitives (button, card, sheet, …)
    app/                   product components (shift card, offer sheet, …)
  lib/                     shared, client-safe helpers (formatting, fetch, zod)
  server/
    auth/                  OIDC, sessions, provisioning, guards
    db/                    pool, transactions, row types
    domain/                business logic
      rules/               rule handlers and precedence
      validation.ts        the authoritative trade validation service
      trades.ts            posting, offers, acceptance, atomic finalisation
      matching.ts          deterministic match scoring
      email.ts             program-notification email generation
      import.ts export.ts  schedule import/export
      admin.ts             user, rule, contact, shift and program management
    http/                  error taxonomy and route-handler plumbing
    observability/         structured, redacting logger
db/migrations/             forward-only SQL migrations
tests/                     unit, integration and end-to-end suites
```

**Layering rule:** UI components never contain business rules. Route handlers
authenticate, authorise, validate input with Zod, and delegate to
`src/server/domain`. The domain layer owns transactions and is the only place
that writes to the database.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/ONBOARDING.md](docs/ONBOARDING.md) · [docs/ROLES.md](docs/ROLES.md) ·
[docs/DEMO_DATA.md](docs/DEMO_DATA.md) · [docs/RULES.md](docs/RULES.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## Time handling

Every shift boundary is stored as an absolute instant (`timestamptz`). Every
"which day is this?" question is answered in the program's IANA timezone.
Durations, rest windows and overlaps are computed on instants, so they are
correct across daylight-saving transitions by construction: a 19:00–07:00 shift
is one shift, and it is 13 real hours on the night the clocks go back. A wall
time that does not exist (inside a spring-forward gap) is rejected rather than
silently moved. See `src/server/domain/time.ts` and `tests/unit/time.test.ts`.

---

## Security posture

- Google-verified identity only; the browser never supplies its own email, role
  or program.
- Session cookies are `httpOnly`, `sameSite=lax`, `secure` when the app URL is
  HTTPS, and are stored server-side as hashes.
- Authorization is enforced in route handlers **and** in the domain services.
- Cross-program access is refused even with a valid id.
- Postgres errors are translated into resident-friendly messages; stack traces
  and driver codes never reach the client.
- Structured server logs redact tokens, codes and credentials.

`tests/e2e/security.spec.ts` proves these from the outside.

---

## Progressive web app

A web manifest, maskable icons and a deliberately conservative service worker
make the app installable. The service worker caches the app shell and static
assets only — **never** API traffic or schedule data — so a stale cache can
never masquerade as the authoritative schedule. When the device is offline the
app says so and refuses to submit changes rather than pretending they worked.
