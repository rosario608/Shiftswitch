# The schedule as an operation

`docs/GENERATOR.md` ends with a draft. `docs/CONSTRAINTS.md` says whether that
draft is legal. This document is about everything between those two and a
resident's phone: how a draft becomes the live schedule, what happens when it is
wrong afterwards, and where the person doing all of it actually works.

---

## The path

```
configure → generate → check → build → lock → regenerate → approve → publish → notify
                                  ↑_________________|
                                                              ↓
                                                          correct
```

Each arrow is a verb somebody chooses. None of them happens as a side effect of
another, and the two that change what residents are working — **publish** and
**correct** — are deliberately the slowest.

### Configure

Sites, services, coverage requirements, cohorts, the block year. `0008`, and
`docs/CONSTRAINTS.md` covers what the configuration can express.

### Generate

`generateDraftSchedule`. Always into a draft, never into the live schedule; an
infeasible run writes nothing at all. `docs/GENERATOR.md`.

### Check

`validateSchedule` over the draft. Hard violations must be fixed or knowingly
accepted; soft ones are scored. The same function the generator is graded by.

### Build

`/admin/scheduler/[id]/build` — the grid. Services down the side, days across
the top, every cell tinted by whether it is short, met or over.

Three views (grid, calendar, list), filters by PGY, cohort, service, site and
resident, free-text search, and selection-based bulk reassignment. Everything
the screen shows about coverage comes from `coverageCells`, which is the
**validator's own generator**, exported rather than copied. A grid that tinted a
cell green while the check below it called that cell short would be worse than
no grid, because a scheduler would believe the colour.

Undo is not machinery. Every bulk operation returns what it replaced, so undo is
the inverse operation sent back — which is exactly why it exists for a draft
edit and nowhere near publish.

### Lock

`schedule_version_locks`. Five kinds: an assignment, a resident, a cohort, a
service, a date.

A lock is **not** a flag on the shift. Three of the five kinds do not name a
shift at all, and regeneration deletes and recreates the unlocked shifts — a
per-shift flag would go with them. An assignment lock is stored as a *person and
a day* for the same reason, and resolved to a shift id at generation time.

A lock whose target has been deleted is **listed with nothing to show for it**
rather than silently dropped. A lock that quietly stopped applying is how a
scheduler loses the placement they were most careful about.

### Regenerate

Generation into an existing draft reads that draft's locks unless the caller
passes some explicitly. That default is what makes "regenerate the remainder" a
thing somebody can do: lock the six placements you care about, run it again with
a different seed, keep the six — with the same row identifiers, not merely the
same people.

### Approve

`schedule.publish` — a capability of its own, so a programme can hand
draft-building to a senior resident without handing them the authority to make a
schedule live.

Approval stores what the approver was shown: the score, the counts, and every
hard violation knowingly accepted, **in the words it was shown in**. Stored
rather than recomputed, because rerunning the validator next month against next
month's roster answers a different question. It is computed server-side at the
moment of approval, not taken from the browser.

Approval is deliberately *not* a validity check. A chief who approves a schedule
with two hard violations because the alternative is no schedule at all is making
a real decision; the product's job is to record it, not refuse it. What it must
never do is let that happen invisibly.

### Publish

`publishScheduleVersion`, in one transaction:

1. refuses an unapproved draft;
2. refuses to delete a live shift entangled in a switch, naming who is involved,
   unless overridden — and the override is audited with a reason;
3. deletes the live shifts **inside the draft's window only**;
4. sets `schedule_version_id = NULL` on the draft's shifts (null *is* what
   published means) and stamps `published_version_id` with the version, which is
   the provenance that makes "what did we publish" answerable;
5. audits;
6. notifies everybody with a shift in the window, with a stored route.

There is no combined "approve and publish". The pause is the feature.

### Correct

`correctPublishedShift`. The most expensive verb in the product, on purpose:

- **one shift at a time.** There is no bulk correction.
- **a reason is required** and stored. "Why am I not on Tuesday any more" is the
  first question anybody asks.
- **both residents are told**, with a route to their own schedule.
- **live switches against the shift are cancelled** — not blocking, because a
  correction usually *is* the response to whatever made the switch impossible,
  and everybody involved is notified by `invalidateTradesForShift`.
- **the schedule is revalidated**, before and after, and the difference is
  stored on the correction. Computed after the change is committed: a number
  worked out from the pre-change state and labelled as the result would be a lie
  a chief would act on.

`listCorrections` is the visible difference between what was published and what
is true now. Not a diff of two versions — the published version's rows *became*
the live ones, so there is no second copy — but the list of deliberate
departures from it, each with who made it and why. A diff could not have said
why, and why is the question.

---

## Availability

`resident_absences`: a range, a kind, and a hardness.

| Kind | Default | Means |
|---|---|---|
| `vacation` | hard | Annual leave, once approved |
| `leave` | hard | Parental, sick, bereavement |
| `conference` | soft | Away at a meeting, hoped for until agreed |
| `elective` | hard | On an away rotation |
| `unavailable` | hard | Cannot work, reason nobody else's business |
| `restriction` | hard | An accommodation, or a duty limit |

**Hard versus soft is a column, not a kind**, because the same kind is genuinely
both depending on the programme: approved annual leave binds a schedule, a
conference somebody hopes to attend does not until the programme agrees.

A resident may record their own and **may not mark it confirmed**. Otherwise
anybody could invalidate the programme's schedule unilaterally, and the first
time that was used to get out of a night float nobody would trust it again.

### How it reaches the constraint model

It does not get its own constraint. `hardConstraintsOf` and `preferencesOf` fold
absences into exactly the lists they already returned — `unavailableDates` and
`requestedDaysOff` — so every constraint, every generator check and every test
that already read those picked up structured availability without changing a
line.

A second constraint would have meant a schedule scheduling over somebody's leave
was wrong in a *different* way depending on which screen recorded it, and a
chief would have had to learn two names for one problem. The jsonb keys still
work; a programme with both gets the union.

---

## Trading against the published schedule

The published schedule is the authoritative source: a live shift is one with no
`schedule_version_id`, a database trigger refuses a trade request against a
versioned shift, and `PUBLISHED_ONLY` keeps draft shifts out of every
resident-facing query.

**Coverage is checked by the constraint model, not by the rules engine.** Every
rule the engine evaluates is about one of the two *people* — rest, hours,
consecutive nights, eligibility. Coverage is about the *ward*, and a 1:1 swap
preserves each resident's headcount while breaking it: if Bob already works MICU
on Monday, giving him Alice's MICU Monday leaves MICU with one person where it
had two. Every rule passes; the ward is short.

So `checkTradeCoverage` runs the hard coverage constraints twice — over the
schedule as it is, and with the swap applied — and reports **only what the swap
introduces**. That precision is what makes it safe to refuse: a programme whose
coverage numbers are aspirational already has shortfalls, and blocking every
switch that touched a day already short would block nearly all of them while
fixing nothing.

It runs at offer creation, at acceptance, and again inside the finalisation
transaction, because it is carried on `TradeContext` and `validateTrade` — which
stays pure and synchronous — folds it in with everything else. A switch that
leaves coverage exactly as it found it gets an explicit **pass**, because
"coverage was checked and is fine" and "coverage was not checked" must not look
the same.

---

## Who sees what

Every screen is reached through `requirePageCapability`, every route through
`requireCapability`, and every "which roles" question through `rolesWith`. There
is no role literal anywhere in this feature.

| | Chief | APD | PD | Admin |
|---|---|---|---|---|
| Build and lock a draft (`scheduling.plan`) | ● | ● | ● | ● |
| Approve and publish (`schedule.publish`) | ● | ● | ● | ● |
| Correct a published shift (`schedule.manage`) | ● | ● | ● | ● |
| Phone numbers (`residents.contact_info`) | ● | ● | ● | ● |
| Services, rules, people (`services.manage`, …) | | ● | ● | ● |
| Programme identity (`program.manage`) | | | ● | ● |
| Housekeeping (`maintenance.run`) | | | | ● |

`/admin` is one page that answers a different first question depending on which
of those the reader holds — coverage and what is waiting for a chief, the same
numbers plus what has changed since publication for an APD or PD, configuration
and housekeeping for an administrator. The difference is expressed entirely
through the matrix.

---

## Invariants

`assertDatabaseConsistent()` in `tests/integration/helpers.ts` gained four
scheduling invariants, expressed the way the trade ones already are: **about the
state at the moment of the transaction, reconstructed from history**, not about
current holders.

1. **One holder per published shift.** Scoped to published shifts — a draft
   shift with nobody on it is a schedule being built, not a torn write. A draft
   shift with *two* holders is still a defect.
2. **Nobody in two places at once.** Two shifts overlap *and* their two
   assignments were live at the same time. Comparing current holders would
   report an administrator who resolved an overlap as having caused one.
3. **No shift orphaned between a version and a trade.** A shift pointing at a
   draft that no longer exists; a shift claiming a publication that was never
   published; a trade referencing a shift inside a draft.
4. **Every correction records what it replaced.** A correction whose shift is
   gone, or which names a previous holder who never held it.

`tests/integration/schedule-lifecycle.test.ts` walks one programme through the
whole path — configure, generate, approve, publish, trade, correct — and asserts
consistency at every step. Everything in it is covered in detail elsewhere; what
it watches is the *joins*, which is where two features that each work alone
disagree about what a shift is.

---

## Where the code is

| | |
|---|---|
| Availability | `src/server/domain/availability.ts` |
| Locks | `src/server/domain/schedule-locks.ts` |
| Approval, publication, the diff | `src/server/domain/schedule-versions.ts` |
| Bulk edits and pattern reuse | `src/server/domain/schedule-bulk.ts` |
| The grid's payload | `src/server/domain/schedule-workspace.ts` |
| Corrections | `src/server/domain/schedule-corrections.ts` |
| Coverage for a trade | `src/server/domain/trade-coverage.ts` |
| The grid | `src/components/app/schedule-workspace.tsx` |
