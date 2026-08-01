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

## B′. Getting into a program

The paths a person meets before they have an account, where there is no session
to attribute anything to and no screen they can be sent back to.

| # | Path | Designed outcome |
|---|---|---|
| G1 | An enrollment link that is expired, revoked, used up, or simply wrong | One neutral message on `/join/<token>`: *"This link isn't working… ask your chief for a new one."* The four causes are deliberately **not** distinguished on a public page — telling an unauthenticated visitor which of them applies only helps somebody guessing tokens. The distinction is kept in `enrollment_events` where the administrator can read it. |
| G2 | Somebody working through addresses against one link | Rate limited per **link**, not per address: the attacker uses a new address each time, so counting per address would count the wrong thing. Thirty attempts in ten minutes and the link stops answering; the refusals are recorded. |
| G3 | A link opened by somebody already in a different program | Refused, and told to sign out first — rather than silently moving their account and their schedule to somebody else's programme. |
| G4 | Somebody joining with an address the program has not listed | **Not** refused. They join *pending*: their own schedule, nothing else, until somebody confirms them. Refusing would send a real resident away at the one moment they were willing to sign up. |
| G5 | Two enrollments racing — the same person on a phone and a laptop | One transaction each, `FOR UPDATE` on the link and on the user row, and held rows claimed with `FOR UPDATE SKIP LOCKED`. One of them creates the account; neither produces a duplicate shift. |
| G6 | An import naming somebody who never signs in | Their rows stay held, visible under **Admin → Getting people in** with the name the file used, indefinitely. An administrator who recognises them as nobody discards them, and the discard is audited with the name and the count. |
| G7 | An import naming two residents whose names normalise the same | Neither is matchable by name; both stay held under the names the file used. Matching one of them would put a resident's call on somebody else's phone, which is worse than either row waiting. |
| G8 | A resident correcting a shift that is posted for a switch | Refused, naming the reason: whoever offered on it did so against what it said at the time. Take the post down, then correct it. |
| G9 | A guessed default that nobody ever confirms | Nothing is generated from it, ever. The importer reports the blank row and names the hours it would have used; `/admin/setup` lists it until somebody acts. Silence here is safe by construction rather than by anybody remembering. |

## B″. Reading a file a model had to interpret

The feature with the most room to do quiet damage, so every path here is
written down. The rule underneath all of them: **the model proposes, and
`commitImport` is still the only thing that writes.**

| # | Path | Designed outcome |
|---|---|---|
| H1 | No `ANTHROPIC_API_KEY` on the deployment | The card says so in a sentence naming the CSV template, which is untouched and needs nothing. Nothing fails at the point of use. |
| H2 | A file type nothing here can open | Refused by name before a byte is read — *"cannot read a .docx file"* — and, for a file with no extension at all, a different sentence saying so rather than inventing a type from the filename. |
| H3 | A file larger than the limit, or a PDF with more pages than the limit | Refused before the request is made, naming the actual size or page count and the limit. Bounds are configuration (`ASSISTED_IMPORT_MAX_BYTES`, `_MAX_PAGES`, `_TIMEOUT_MS`, `_MAX_COST_MICROS`). |
| H4 | A file whose reading would cost more than the ceiling | Refused **before calling**, from an estimate that assumes the maximum output — a ceiling that assumes the cheap case is not a ceiling. Asserted by a test that also checks nothing was sent. |
| H5 | The model says it cannot read the file | Recorded as an `unreadable` extraction with its reason, and the reason is shown. Nothing is imported, and the attempt is not invisible. |
| H6 | The model answers in prose, or with malformed JSON | One message saying the extraction did not come back usable and that nothing was imported. The object is *located* in the text rather than assumed to be all of it, so a stray markdown fence is survived. |
| H7 | The model returns a confidence outside 0–1, or a row that names nobody and no day | Clamped, and dropped respectively. A row of empty strings for somebody to puzzle over is worse than a row that is not there, and `notes` is where the file-level observation goes. |
| H8 | A row the model was unsure about | Flagged, sorted to the top with the least confident first, shown as a form with its origin beside it. **It cannot be committed until somebody opens it** — the gate reads `needs_review` and `reviewed_at` from the database, never from the request. |
| H9 | A row the model was *confident* about but which is missing a date, hours, a service or a person | Flagged just the same. High confidence in an incomplete row is still an incomplete row, and a threshold alone would let it through. |
| H10 | A client that tries to commit anyway | There is no field to set. The commit request carries no rows at all; the server reads what it stored and refuses while anything flagged is unread, naming how many. |
| H11 | A reviewer's correction | Written to `corrected`; `proposed` is never overwritten. Both survive the import, so where the model was wrong stays answerable. Accepting a row unchanged is also recorded, and is a different fact from fixing one. |
| H12 | The same upload committed twice | Refused: the extraction is marked `committed`. Re-importing the same *file* is still safe — `placeShift` deduplicates on (program, service, start, resident) — so a coordinator who re-uploads after a half-finished attempt loses nothing. |
| H13 | An extraction id from another programme | Not found. Every read is scoped by `program_id`; a test attacks this with a second programme. |
| H14 | An overnight shift read as 19:00–07:00 | Carried through as `endsNextDay`, and inferred from the hours when the extraction did not say. This is where a real defect lived: `commitImport` used to assert "not overnight" for a row that simply had not said, turning every night shift into one ending twelve hours before it began. |

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
