# Every way this can fail, and what happens then

Written by walking the code, not by imagining what might go wrong. Each row is
a real path a request or a render can take; each has a **designed outcome** —
what the person sees, what they can do next, and what the operator learns.

Two rules run through all of it:

- **Never a success message for something that did not succeed**, and never a
  reassurance that is not known to be true. "Nothing was changed" is a claim,
  not a courtesy.
- **A failure a resident can see must be a failure the operator can find.**
  Every designed outcome below carries a request id, and that id appears in the
  logs, in the error report, and on the screen the resident is looking at.

---

## A. Server rendering (React Server Components)

Every page in `src/app/(app)` is a server component that calls the domain layer
directly. There is no client-side fetch on first paint, so "the page failed to
load" and "the database is down" are the same event to a resident.

| # | Path | Designed outcome |
|---|---|---|
| A1 | Database unreachable — `getSessionContext` cannot query `sessions` | The segment's `error.tsx`: *the schedule service is not reachable*, a retry, and the request id. The shell survives. |
| A2 | Database reachable, **schema behind the code** — a query names a column the deployed schema lacks | Named for what it is — a missing migration — not "something went wrong". `/admin/diagnostics` says which file. |
| A3 | Signed in, no role or program yet (`not_configured`) | Redirect to `/pending`. Already designed. |
| A4 | Signed in, capability refused (`forbidden`) | Redirect to `/?denied=1` with the refusal naming the area and the role. Already designed. |
| A5 | Resource absent or another programme's (`notFound()`) | `not-found.tsx`. Already designed, now per-segment so the shell survives. |
| A6 | Unexpected throw inside one page (bad data, a null nobody expected) | The **segment** boundary, so navigation and the rest of the app keep working. Previously the root boundary replaced the entire shell. |
| A7 | Throw inside the **root layout** — `countUnread` fails, say | `global-error.tsx`. Previously there was none, and Next.js renders its own blank page. This is the only path that can legitimately lose the shell, so it re-renders `<html>` itself. |

## B. API routes

`apiHandler` already funnels everything. What was missing was not handling but
*traceability*.

| # | Path | Designed outcome |
|---|---|---|
| B1 | `AppError` from the domain | Clean JSON, stable code, message written for a resident. Already designed. |
| B2 | Zod rejection | `validation_failed` with per-field issues. Already designed. |
| B3 | PostgreSQL error with a code | `translateDatabaseError` maps it onto the taxonomy. Already designed. |
| B4 | Anything else | Logged with its stack; the client gets a generic message. Already designed. |
| B5 | **Any of the above, from a resident's point of view** | Every response now carries `x-request-id`, echoed in the error body and shown on screen. A resident can read six characters down the phone and the operator can find the exact log line. |
| B6 | A query against a **drifted schema** | Detected before it is attempted: the affected routes refuse with `schema_drift` naming the missing migration, rather than surfacing `column … does not exist` as a 500. |

## C. Mutations from the client

`apiFetch` → `useAction` is the single funnel for every write.

| # | Path | Designed outcome |
|---|---|---|
| C1 | `navigator.onLine === false` before the request | Refused locally: *you're offline, this did not happen*. No request is sent. Already designed. |
| C2 | `fetch` rejects — wifi dropped **mid-flight** | The hard one. The request may or may not have been received. See **The mid-flight problem** below. |
| C3 | 5xx from the server | Generic message plus the request id. |
| C4 | Response is not JSON (a proxy's error page) | Treated as a failure, not as an empty success. Already designed. |
| C5 | Double tap | Single-flight guard in `useAction`. Already designed. |
| C6 | Component unmounts mid-flight | The result is dropped rather than written to a dead component — but the *mutation* still completed, so nothing is lost, and the next render reads the truth from the server. |

### The mid-flight problem

A resident taps **Accept** on hospital wifi and the connection drops before the
response arrives. Three things are true at once: the switch may have completed,
the resident cannot tell, and telling them "that failed" would be a lie half
the time.

The honest outcome is neither "done" nor "failed" but **"we don't know yet"**,
followed by finding out. Mutations that change a schedule carry an idempotency
key: a retry with the same key returns the original result instead of acting
twice, so the client can re-ask without risk. What the resident sees is *"We
lost the connection before we heard back. Checking what happened…"* and then
the real answer.

## D. Reads while offline

The service worker deliberately never cached API traffic, on the grounds that
stale schedule data must not look authoritative. That is right about the
danger and wrong about the remedy: a resident on a ward with no signal gets the
offline page and **nothing at all**, when the shift they are trying to check is
the one they were looking at four minutes ago.

The remedy is to show it **labelled**: the last known schedule, with a banner
saying when it was captured and that the app is offline, and with every control
that would change something disabled. Recorded under **Decisions**.

## E. Native client

| # | Path | Designed outcome |
|---|---|---|
| E1 | A screen throws during render | `ErrorBoundary` — one screen, not the app. Already designed. |
| E2 | The app's root throws | The boundary wraps the router, so this is E1. |
| E3 | Network failure | Same taxonomy as the web, same honest wording. |

## F. What the operator learns

| # | Question | Answer |
|---|---|---|
| F1 | Is it up? | `GET /api/health` — machine-readable: database reachability, migration state, auth configuration. |
| F2 | Is the schema what the code expects? | The same endpoint, and the startup check. |
| F3 | What is broken **right now**? | One dashboard URL, in `docs/DEPLOYMENT.md`. |
| F4 | What do I paste into the next goal? | `/admin/diagnostics` — a plain-language verdict and a copyable report. |
