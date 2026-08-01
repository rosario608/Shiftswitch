# The draft schedule generator

`src/server/domain/generator/`

Given a programme — its people, cohorts, services, coverage requirements, block
year, availability, eligibility and configured rules — produce a month somebody
could work, as a **draft**, and say what it managed and what it could not.

It does not decide whether its own output is legal. Every run ends by handing
the schedule to `validateSchedule` (`docs/CONSTRAINTS.md`), and a run whose
schedule has hard violations is a **failed run**: it reports infeasibility and
emits nothing. That is why the validator was built first.

---

## What comes out

| | |
|---|---|
| **A draft** | Always. There is no parameter that publishes, and there should not be |
| **Or nothing** | An infeasible run writes nothing at all — not the shifts, not the version row. A failed attempt cannot leave a half-built draft for somebody to publish |
| **A report** | Coverage met, requirements unmet, conflicts, fairness per training level, what needs a human, and why anything could not be satisfied |

## How it works

**Slots.** Coverage requirements are the demand; a slot is one of those people
on one of those days. A requirement asking for three people on weekdays becomes
three slots each weekday. A PGY mix pins some of those slots to a level, so the
mix is satisfied *by construction* rather than discovered to be wrong at the
end.

**Construction.** Slots are ranked once by how many people are statically
eligible — hardest first — and filled greedily, never placing somebody a hard
constraint forbids.

Ranking once rather than after every placement is deliberate: re-ranking is
more accurate and quadratic, and on the demo programme's 200 slots it turned a
one-second run into fifty, all of it taken from the budget the improvement
phase never got to spend. What single-pass ranking costs is the occasional
trap — the last night of a stretch has nobody left who has not just worked six
days — and that is repaired directly.

**Repair.** When a slot cannot be filled, look for somebody who *could* take it
if one of their existing shifts moved to somebody else, and make that one move.
One level deep, bounded, every step still checked. On the demo programme this
closes four slots out of two hundred.

**Improvement.** Swap pairs of residents between slots, keep the swap if the
validator's score improves and every hard constraint still holds. Runs until the
time budget expires, then returns the best found — labelled as best-found, not
as best.

## Determinism

Same inputs, same seed, byte-identical output — **provided the run finishes its
search**. Every iteration order is explicit, every tie is broken by a stable key
(resident id, content-addressed slot id), and the only randomness is a seeded
Mulberry32 whose seed is recorded in the report.

The proviso is load-bearing and used to be missing. The improvement phase was
bounded by wall-clock time, so a fast machine performed more swaps than a loaded
one and the same seed produced two different schedules. The unit tests did not
catch it because they run with a budget of `0`, which skips the search
altogether; what caught it was `schedule-lifecycle` failing under load and
passing alone — the shape of a "flaky test" that is really a wrong claim.

The search is now bounded by **iterations first, time second**:

| | |
|---|---|
| Iterations | 8 per movable slot, capped at 5,000 |
| Budget | A safety valve, not the bound |

`tests/unit/generator.test.ts` asserts it three ways: two runs compared
directly, a run over a roster in reverse order producing the same assignments,
and — the one that would have caught this — the same seed under a generous and a
tight budget producing identical output.

### What is not yet reproducible, and why

Each iteration re-scores the whole schedule, which costs a few milliseconds at a
fortnight's scale and grows with the schedule. A **large** programme therefore
still hits the budget before finishing its iterations, and such a run is *not*
reproducible.

That is reported rather than hidden. `stoppedOnBudget` means exactly "the search
was cut short, so this result depends on how busy the server was"; the scheduler
sees it as *"stopped at the time limit, so this is the best it found rather than
the best there is"*, and raising the budget both improves the schedule and makes
it repeatable.

The real fix is **incremental scoring** — recomputing only the objectives the two
swapped residents affect, instead of the whole schedule — which would make
iterations cheap enough that any programme finishes its search. It is not done.

## The time budget

A run has one, and returns the best schedule found within it. Scheduling is
NP-hard; a search that runs until it is satisfied never returns.

| | |
|---|---|
| Default | 2 seconds (`DEFAULT_TIME_BUDGET_MS`) |
| Ceiling | 60 seconds, so one request cannot pin a worker |
| In tests | Usually `0` — construction is deterministic and needs no search to be correct |

Construction is not counted against the budget: it is not optional, and a
schedule with a hole in it is not a schedule.

## When it cannot be done

"No valid schedule exists" is true and useless. The report names the smallest
set of constraints whose relaxation would admit a solution, and how many places
each would recover:

> Relaxing Days in a row would let all 4 of them be filled.

The search is honest rather than complete: singles first, then pairs of the ones
that helped most, then the best partial answers. A relaxation says how many
slots it recovers, not that it is the only answer.

**Two things are never proposed.** Somebody's leave, and somebody's
accommodation. `resident-availability`, `personal-unavailability`,
`service-exclusion` and `block-override` are facts about individuals; they are
named as blockers when they are one, and never offered as something to give up.

When the roster is simply too small — everybody eligible is already standing in
one of the other places — it says that instead, because no rule change fixes it.

## Locks

A lock protects an assignment, a resident, a cohort, a service or a date.
Locked assignments are facts: the generator works around them, the slots they
fill are consumed one for one, and regeneration keeps the same rows with the
same identifiers.

```ts
locks: [
  { kind: "assignment", shiftId },   // this shift stays exactly as it is
  { kind: "resident", residentId },  // everything this person holds
  { kind: "cohort", cohortId },
  { kind: "service", serviceId },
  { kind: "date", date: "2026-09-07" },
]
```

## After a manual edit

`assessEdit` validates before and after and reports the **difference**. A chief
moving one person off a Tuesday does not want a fresh list of everything wrong
with the month — most of which was wrong before they touched it. They want the
answer to one question, and they get it in a sentence.

Violations are compared by what they are *about* — constraint, people, shifts,
dates — not by their text, because a message that names a count changes when the
count changes and would report the same gap as both resolved and introduced.

## Inside the ScheduleSource seam

`generatedSource` sits in `src/server/domain/schedule-sources/` alongside the
uploaded spreadsheet. It produces the same flat records, which go through the
same validation and the same commit path. The generator gets no private route
into the schedule model — the second route into a model is always the one that
misses the rule the first one grew last month.

## The fast checker, and why it is not the authority

`feasibility.ts` restates the hard constraints so the search can ask two hundred
thousand questions in the time the validator answers ten. It is kept honest by
two things:

1. **It reads the programme's own numbers** — rest hours, consecutive-day
   limits, rolling windows — straight off the same `rules` rows the engine
   reads. There is one place a programme says "ten hours".
2. **It never has the last word.** If it ever disagreed with the validator, the
   consequence is a generator that *fails loudly* — never one that quietly
   produces an illegal month.

A rule the programme configured as a *warning* is skipped by the checker
entirely: the programme has said a schedule may break it, and the generator is
not entitled to refuse schedules the validator would pass.

## One thing it does not leave to configuration

Nobody can hold two of the places at the same service at the same time. That is
arithmetic about people, not policy, so it is enforced structurally rather than
via `no_overlapping_shifts`, which a programme might never have created.

Without it the generator satisfied "three people on the MICU" with one person
three times over — which it did, the first time this was run, and which the
validator agreed with, because coverage counted *rows*. Both were fixed:
coverage now counts distinct people, and there is a regression test for each.

## Tests

| | |
|---|---|
| `tests/unit/generator.test.ts` | 38 cases: filling, determinism, infeasibility, locks, blocks and cohorts, DST in both directions, one-day periods, overnight bands, duplicate requirements, sparse rosters, regeneration over locks |
| `tests/integration/generator.test.ts` | Against a real database at twelve residents: lands in a draft, never touches the live schedule, writes nothing when infeasible, keeps locks across regeneration, refuses a published version, diffs two drafts, and explains a manual edit |

Every assertion about a generated schedule goes through `validateSchedule`. The
suite has one invariant, `emitsNothingOrValidatesClean`, and there is no third
outcome:

- `feasible` is true **and** the validator finds no hard violation, or
- `feasible` is false **and** nothing was emitted.

## On the demo programme

Twenty residents, six coverage requirements, a four-week window:

```
feasible=true  slots=200  filled=200  score=77.6  2.4s  61 search iterations
validator: valid=true  hard=0  soft=32
Demo MICU 24/24 · Demo Night Float 80/80 · Demo Wards 96/96
PGY-1: 10–11 shifts each · PGY-2: 10–11 · PGY-3: 9–11
```
