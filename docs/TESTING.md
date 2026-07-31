# Testing

Three suites, each with a different job.

| Suite       | Runner     | Talks to               | What it proves |
| ----------- | ---------- | ---------------------- | -------------- |
| Unit        | Vitest     | nothing                | Pure logic: time/DST, rules, validation ordering, scoring, email formatting and encoding |
| Integration | Vitest     | a real PostgreSQL database | The domain services: posting, offers, acceptance, atomic finalisation, approval, overrides, expiry, invalidation, provisioning, sessions, import/export, analytics, concurrency |
| End-to-end  | Playwright | a running app + database   | The product: the full workflow in a browser, authorization from the outside, mobile layout, offline behaviour, edge cases |

---

## Running them

```bash
npm run test              # unit + integration
npm run test:unit
npm run test:integration
npm run test:e2e          # Playwright: mobile (Pixel 7) and desktop projects
npm run verify            # typecheck + lint + unit/integration + production build
```

### Database used by tests

Integration tests connect to `TEST_DATABASE_URL` (falling back to
`DATABASE_URL`), apply migrations once per process, and truncate every table
between tests. They never touch the development database as long as
`TEST_DATABASE_URL` points elsewhere.

```
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/shiftswitch_test
```

`tests/setup.ts` forces `NODE_ENV=test` and loads `.env.test`.

### End-to-end tests

`playwright.config.ts` starts `npm run dev` automatically (or reuses a server
already listening). Each spec calls `resetFixture()`, which runs
`scripts/e2e-fixture.ts` to rebuild a small deterministic program:

| Account                   | Role                                     |
| ------------------------- | ---------------------------------------- |
| `e2e.alice@hospital.org`  | Resident, three tradeable shifts          |
| `e2e.bob@hospital.org`    | Resident, three tradeable shifts          |
| `e2e.carol@hospital.org`  | Resident, one approval-required shift     |
| `e2e.chief@hospital.org`  | Chief resident                            |
| `e2e.admin@hospital.org`  | Program administrator                     |
| `e2e.pending@hospital.org`| Authenticated but not configured          |

Sign-in uses `POST /api/auth/test-login`, which is hard-disabled unless
`NODE_ENV !== "production"` **and** `ALLOW_TEST_LOGIN=true`. It creates the same
database-backed session Google sign-in would create; it never creates users and
never grants a role.

> The E2E fixture rebuilds whichever database the running server is using. Point
> the dev server at a scratch database before running it against anything you
> care about.

---

## Coverage of the mandated edge cases

| Case | Where |
| ---- | ----- |
| Google sign-in: PKCE, state, nonce, signature, audience, issuer, expiry, unverified email, workspace domain | `tests/integration/oidc.test.ts` — driven against a local OpenID provider with a real key pair |
| Concurrent trade — only one succeeds | `tests/integration/concurrency.test.ts` |
| Already-traded / obsolete offer rejected | `tests/integration/trade-workflow.test.ts`, `tests/e2e/edge-cases.spec.ts` |
| Schedule changed under a pending trade | `tests/integration/trade-workflow.test.ts` ("administrator reassigned a shift underneath") |
| Insufficient rest rejected with an explanation | `tests/unit/validation.test.ts`, `tests/integration/trade-workflow.test.ts` |
| Excessive consecutive shifts rejected | `tests/unit/validation.test.ts` |
| Overnight shift handled as one shift | `tests/unit/time.test.ts`, `tests/e2e/mobile-ux.spec.ts` |
| Daylight-saving transitions | `tests/unit/time.test.ts` (both directions, plus the non-existent wall time) |
| Expired trade cannot be accepted | `tests/integration/trade-workflow.test.ts` |
| Deactivated resident handled safely | `tests/unit/validation.test.ts`, `tests/integration/auth.test.ts` |
| Cancelled shift invalidates its offers | `tests/integration/trade-workflow.test.ts`, `tests/e2e/edge-cases.spec.ts` |
| Duplicate submission cannot double-book | `tests/integration/concurrency.test.ts`, `tests/e2e/edge-cases.spec.ts` |
| Resident cannot reach another resident's data | `tests/e2e/security.spec.ts` |
| Resident cannot reach admin routes | `tests/e2e/security.spec.ts` |
| Email recipients, subject and body correct | `tests/unit/email.test.ts`, `tests/integration/email-and-admin.test.ts`, `tests/e2e/workflow.spec.ts` |
| Invitation expiry, revocation, wrong token, single use, resend rotation | `tests/integration/invitations.test.ts` |
| Invitation accepted by the wrong Google account | `tests/integration/invitations.test.ts` (mismatch does not consume the invitation), `tests/e2e/security.spec.ts` |
| Concurrent acceptance of the same invitation | `tests/integration/invitations.test.ts` |
| Invitation delivery reported honestly when no transport is configured | `tests/integration/invitations.test.ts` |
| Malformed schedule file (not a spreadsheet, wrong columns, empty) | `tests/integration/onboarding.test.ts` |
| Duplicate schedule import is idempotent | `tests/integration/email-and-admin.test.ts` |
| Import into an empty/new program | `tests/integration/onboarding.test.ts` |
| Import writes nothing when one row is bad | `tests/integration/onboarding.test.ts` |
| Deleting a shift with trade history is refused | `tests/integration/onboarding.test.ts` |
| Whole onboarding path: invite → accept → import → see shifts → trade | `tests/integration/onboarding.test.ts` |
| Residents and chiefs cannot import or invite | `tests/e2e/security.spec.ts` |
| Invitations are scoped to one program | `tests/integration/onboarding.test.ts` |
| Whole lifecycle over HTTP: admin invites, imports, edits, reassigns, deletes; resident posts, offers, accepts | `tests/e2e/lifecycle.spec.ts` |
| Moving a shift in time, including DST gap and repeated hour | `tests/integration/schedule-admin.test.ts` |
| Moving a shift invalidates live offers | `tests/integration/schedule-admin.test.ts` |
| Reassigning to another resident, to nobody, and across programs | `tests/integration/schedule-admin.test.ts` |
| Schedule source seam produces records the core validation accepts | `tests/integration/schedule-admin.test.ts` |
| Demo seed is deterministic, idempotent and fully removable | `tests/integration/demo-data.test.ts` |
| Demo seed refuses production, remote and production-named targets | `tests/integration/demo-data.test.ts` |
| Seeded schedule does not violate the program's own rules | `tests/integration/demo-data.test.ts` |
| Every seeded rule type has a handler | `tests/integration/demo-data.test.ts` |
| Demo scenarios: valid swap, invalid swap, no match, overlapping schedule | `tests/integration/demo-data.test.ts` |
| The five roles have exactly the documented capabilities | `tests/unit/roles.test.ts` |
| Nobody can assign a role at or above their own, or change their own | `tests/unit/roles.test.ts`, `tests/integration/permissions.test.ts`, `tests/e2e/roles-and-onboarding.spec.ts` |
| A program can never be left without leadership | `tests/integration/permissions.test.ts` |
| Multi-email input: typing, paste, commas, semicolons, newlines, spreadsheet columns | `tests/unit/email-input.test.ts`, `tests/e2e/roles-and-onboarding.spec.ts` |
| Invalid and duplicate addresses are flagged individually | `tests/unit/email-input.test.ts`, `tests/e2e/roles-and-onboarding.spec.ts` |
| Service creation, case-insensitive duplicates, rename, deactivate | `tests/integration/services.test.ts`, `tests/e2e/roles-and-onboarding.spec.ts` |
| A service with upcoming shifts cannot be deactivated | `tests/integration/services.test.ts` |
| Email is never delivered outside a production build | `tests/unit/environment.test.ts` |
| The invitation sandbox is unreachable in production | `tests/unit/environment.test.ts`, `tests/e2e/security.spec.ts` |
| Whole self-test path: service → invite → accept → resident view → switch back → chief | `tests/e2e/roles-and-onboarding.spec.ts` |

---

## Adversarial checks performed manually

Beyond the automated suites, the running app was probed with SQL-injection
payloads in query and path parameters, 2 MB request bodies, wrong content types,
attempts to set statuses directly, path-traversal identifiers, unsupported HTTP
methods, and concurrent duplicate submissions. All were rejected with 4xx
responses and resident-friendly messages; no stack trace, driver code or
internal path appeared in any response body. A malformed UUID in a path
parameter originally produced a 500 — it now returns a clean 404 (see
`requireUuid` in `src/server/http/api.ts`).
