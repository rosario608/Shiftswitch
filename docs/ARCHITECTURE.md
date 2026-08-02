# Architecture

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│ React Server Components (app/(app)/…)                         │
│   read-only views; call the domain layer directly             │
│ Client components (components/app/…)                          │
│   interaction only; every mutation goes through the API       │
├───────────────────────────────────────────────────────────────┤
│ Route handlers (app/api/…)                                    │
│   authenticate → authorise → validate (Zod) → delegate        │
├───────────────────────────────────────────────────────────────┤
│ Domain (server/domain/…)                                      │
│   trades · validation · rules · matching · email · import     │
│   owns transactions; the only writer                          │
├───────────────────────────────────────────────────────────────┤
│ Data (server/db/…)  →  PostgreSQL                             │
└───────────────────────────────────────────────────────────────┘
```

Business rules never live in components. The domain layer never reads cookies.

---

## Data model

| Table                | Purpose |
| -------------------- | ------- |
| `programs`           | Residency program: timezone, approved email domains, approval policy |
| `users`              | Google identity, role, program. First sign-in joins the program as `resident`; `role IS NULL` now means only that there was no program to join |
| `sessions`           | Opaque session tokens, stored as SHA-256 hashes |
| `residents`          | A user's residency record: PGY level, credentials, graduation year |
| `services`, `rotations` | Program structure |
| `shifts`             | A single shift: absolute start/end, PGY range, tradeable, approval, deadline, status |
| `shift_assignments`  | Who holds a shift. **Authoritative** — a partial unique index allows only one `active` row per shift |
| `trade_requests`     | A posted shift, its preferences and expiry |
| `trade_offers`       | An offer of one shift against a post, with the validation snapshot |
| `completed_trades`   | The durable record of a finalised switch |
| `trade_legs`         | One row per shift that changed hands — two for a 1:1 swap |
| `program_contacts`   | Coordinator/chief/PD addresses used for the notification email |
| `notifications`      | In-app notifications |
| `email_records`      | Generated program emails and their status |
| `rules`              | Configurable program rules |
| `audit_logs`         | Append-only record of every meaningful change |

### Scheduling (`0008`, `0009`)

| Table | Purpose |
| ----- | ------- |
| `sites` | Where a service happens. Credentialing is per site |
| `coverage_requirements` | How many people a service needs, by weekday, period or named date |
| `block_structures`, `blocks` | The programme's year. Blocks carry explicit dates, not a length and an offset |
| `cohorts`, `cohort_members`, `cohort_block_assignments` | Who moves through the year together, and what they do in each block |
| `resident_block_overrides` | One person doing something other than their cohort, with a reason |
| `resident_site_eligibility` | Which sites a resident may work |
| `schedule_versions` | A draft, and the record of its approval and publication |
| `schedule_version_locks` | What regeneration must not touch |
| `resident_absences` | Vacation, leave, conferences, electives, restrictions — a range, a kind, a hardness |
| `schedule_corrections` | Deliberate departures from what was published, with the reason and the impact |

Two columns on `shifts` carry the whole draft/published distinction, and they
mean different things. **`schedule_version_id` is null for a live shift** —
null *is* what published means, which is why `0008` needed no backfill and why
every pre-existing query kept its meaning. `published_version_id` is set on
publication and never cleared: it answers "which publication is this shift part
of", which the first column cannot, and without it "what did we publish, and
what has changed since" has no answer.

A database trigger refuses a trade request against a versioned shift. A query
filter is something a future query can forget.

### Why `shift_assignments` rather than a `resident_id` on `shifts`

A shift's holder changes over time and the history matters. Assignments are
append-only rows with `active`/`ended` status, so a completed trade leaves the
previous holder visible, and the partial unique index

```sql
CREATE UNIQUE INDEX shift_assignments_one_active_per_shift
  ON shift_assignments (shift_id) WHERE assignment_status = 'active';
```

makes "two residents hold the same shift" impossible at the database level, not
merely unlikely.

### Why `trade_legs`

A 1:1 swap writes two legs (A→B and B→A). A future A→B→C→A rotation writes
three, with no schema change: `completed_trades` is the transaction header and
the legs describe what moved. The denormalised `source_shift_id` /
`destination_shift_id` columns are convenience fields for today's 1:1 case.

---

## The atomic swap

`acceptOffer` (and `approveTrade`) run one transaction that:

1. locks the offer and the trade request (`SELECT … FOR UPDATE`);
2. checks statuses and expiry;
3. locks both shifts, in a deterministic id order so two concurrent trades
   cannot deadlock;
4. confirms both shifts are still held by the residents the trade was built
   from;
5. re-runs the full rules engine against the current schedule;
6. ends both active assignments and inserts the two new ones (the update's row
   count is checked — anything unexpected aborts);
7. invalidates every other live offer touching either shift, notifying those
   residents with the reason;
8. writes the completed trade, its legs, the notifications and the audit
   entries.

Any failure rolls the whole thing back. There is no window in which one resident
has lost a shift the other has not gained.

Rejections that need a durable side effect — marking an offer expired or
invalidated — are carried out in a **separate** transaction after the main one
rolls back, so the caller still gets the error *and* the offer is recorded as no
longer live.

### Concurrency

Covered by `tests/integration/concurrency.test.ts`, which fires genuinely
simultaneous service calls:

- two accepts on the same post → one succeeds, one fails, one completed trade;
- three accepts of the same offer (double tap) → one switch;
- two posts racing for the same shift → the unique index rejects the second;
- two offers of the same shift on the same post → one survives.

---

## Status model

Shifts: `scheduled → posted → offer_pending → pending_approval → scheduled`,
plus terminal `completed` (the shift has been worked) and `cancelled`.

Trade requests: `open → offer_pending → pending_approval → completed`, plus
`cancelled` and `expired`.

Offers: `pending → accepted → completed`, plus `rejected`, `withdrawn`,
`invalidated` and `expired`.

Transitions are declared in `src/server/domain/status.ts` and asserted on the
server. A client can never set a status directly — there is no API surface that
accepts one.

---

## Error handling

`AppError` carries a machine code (`unauthenticated`, `forbidden`, `not_found`,
`validation_failed`, `conflict`, `expired`, `rule_violation`, `internal`, …), an
HTTP status, and a message written for a resident. `translateDatabaseError` maps
PostgreSQL codes onto that taxonomy — for example a unique violation on the
active-assignment index becomes:

> This shift was just updated by someone else. Refresh and try again.

Anything unrecognised is logged server-side with its stack and returned as a
generic message. Clients never see driver errors.

---

## Observability

`src/server/observability/logger.ts` writes structured JSON with a redaction
list (tokens, authorization codes, cookies, secrets). Logged events include
authentication failures, authorization rejections, validation rejections, trade
completions and unhandled exceptions.
