import { describe, expect, it } from "vitest";
import { validateSchedule } from "@/server/domain/constraints/validator";
import type { ScheduleSnapshot } from "@/server/domain/constraints/types";
import { generateSchedule } from "@/server/domain/generator/generate";
import { expandSlots } from "@/server/domain/generator/slots";
import type { GenerationOptions } from "@/server/domain/generator/types";
import {
  IDS,
  baseSnapshot,
  coverage,
  resident,
  rule,
  service,
  shift,
  withBlock,
} from "./constraint-fixture";

/**
 * The generator, graded by the validator.
 *
 * Every assertion about a generated schedule goes through `validateSchedule`.
 * Nothing here reads the output and decides for itself whether it looks right —
 * that would be a second, weaker opinion about legality, and the first time the
 * two disagreed the suite would be certifying schedules the product rejects.
 *
 * So the shape of nearly every test is the same: generate, then either
 *
 *   - `feasible` is true **and** the validator finds no hard violation, or
 *   - `feasible` is false **and** nothing was emitted.
 *
 * There is no third outcome, and `emitsNothingOrValidatesClean` asserts exactly
 * that.
 */

const DEFAULTS: Omit<GenerationOptions, "period"> = {
  seed: 1,
  timeBudgetMs: 0,
  locks: [],
  existing: [],
};

function options(
  snapshot: ScheduleSnapshot,
  overrides: Partial<GenerationOptions> = {},
): GenerationOptions {
  return { ...DEFAULTS, period: snapshot.period, ...overrides };
}

/** A snapshot with no shifts: the generator's job is to produce them. */
function empty(): ScheduleSnapshot {
  const snapshot = baseSnapshot();
  snapshot.assignments = [];
  return snapshot;
}

/**
 * The one invariant. A run either emits a schedule the validator passes on
 * every hard constraint, or emits nothing and says why.
 */
function emitsNothingOrValidatesClean(
  snapshot: ScheduleSnapshot,
  result: ReturnType<typeof generateSchedule>,
): void {
  if (!result.feasible) {
    expect(result.assignments, "an infeasible run must emit nothing").toEqual([]);
    expect(
      result.report.relaxations.length + result.report.unfilled.length,
      "an infeasible run must say why",
    ).toBeGreaterThan(0);
    return;
  }

  const validation = validateSchedule({
    ...snapshot,
    assignments: result.assignments,
  });
  const hard = validation.violations.filter((v) => v.kind === "hard");
  expect(
    hard.map((v) => `${v.constraintId}: ${v.message}`),
    "a feasible run must produce a schedule with no hard violations",
  ).toEqual([]);
}

describe("filling a week", () => {
  it("covers a service that needs one person a day", () => {
    const snapshot = empty();
    const result = generateSchedule(snapshot, options(snapshot));

    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.feasible).toBe(true);
    expect(result.assignments).toHaveLength(7);
    expect(result.report.demand).toEqual({ slots: 7, filled: 7, locked: 0 });
    expect(result.assignments.every((a) => a.residentId !== null)).toBe(true);
  });

  it("covers a service that needs three people a day, with a required senior", () => {
    const snapshot = empty();
    snapshot.coverage = [
      coverage({ min_staff: 3, pgy_mix: [{ pgy: 2, min: 1, max: null }] }),
    ];
    const result = generateSchedule(snapshot, options(snapshot));

    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.feasible).toBe(true);
    expect(result.assignments).toHaveLength(21);
  });

  it("respects the rules the programme configured", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 2 })];
    snapshot.rules = [
      rule("min_rest_hours", { hours: 10 }),
      rule("max_consecutive_shifts", { days: 2 }),
      rule("no_overlapping_shifts", {}),
      rule("weekend_limit", { maxWeekendShifts: 1, windowDays: 28 }),
    ];
    const result = generateSchedule(snapshot, options(snapshot));

    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.feasible).toBe(true);
  });

  it("never schedules somebody who is unavailable", () => {
    const snapshot = empty();
    snapshot.residents.find((r) => r.id === IDS.alice)!.schedulable = false;
    snapshot.residents.find((r) => r.id === IDS.ben)!.constraints = {
      unavailableDates: ["2026-08-03", "2026-08-04"],
    };

    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.assignments.some((a) => a.residentId === IDS.alice)).toBe(false);
  });

  it("keeps a service inside its own training levels", () => {
    const snapshot = empty();
    snapshot.services = [
      service(IDS.wards, "Wards", { coverageMandatory: true, pgyMin: 2 }),
      service(IDS.clinic, "Clinic"),
    ];
    const result = generateSchedule(snapshot, options(snapshot));

    emitsNothingOrValidatesClean(snapshot, result);
    const levels = result.assignments.map(
      (a) => snapshot.residents.find((r) => r.id === a.residentId)!.pgyLevel,
    );
    expect(levels.every((level) => level >= 2)).toBe(true);
  });
});

describe("determinism", () => {
  it("produces byte-identical output for the same input and seed", () => {
    const build = () => {
      const snapshot = empty();
      snapshot.coverage = [coverage({ min_staff: 2 })];
      return snapshot;
    };
    const first = generateSchedule(build(), options(build(), { seed: 7 }));
    const second = generateSchedule(build(), options(build(), { seed: 7 }));

    expect(JSON.stringify(second.assignments)).toEqual(
      JSON.stringify(first.assignments),
    );
    expect(second.report.demand).toEqual(first.report.demand);
    expect(second.report.score).toEqual(first.report.score);
  });

  it("produces byte-identical output with the improvement search running too", () => {
    /* The claim in docs/GENERATOR.md is "same inputs, same seed, byte-identical
       output", and the test above only ever exercised construction: the default
       budget in this file is zero, so the search never ran. With a budget it
       used to be false — the loop was bounded by wall-clock time, so a fast
       machine did more swaps than a loaded one and the same seed gave two
       different schedules. It made the schedule-lifecycle integration test fail
       under load and pass alone, which reads like flakiness and is not.

       The search is bounded by iterations now, so this holds. Two different
       budgets deliberately: if the result still depended on time, generous
       versus tight would diverge. */
    const build = () => {
      const snapshot = empty();
      snapshot.coverage = [coverage({ min_staff: 2 })];
      return snapshot;
    };
    const generous = generateSchedule(
      build(),
      options(build(), { seed: 7, timeBudgetMs: 10_000 }),
    );
    const tight = generateSchedule(
      build(),
      options(build(), { seed: 7, timeBudgetMs: 2_000 }),
    );

    expect(generous.report.stoppedOnBudget).toBe(false);
    expect(tight.report.stoppedOnBudget).toBe(false);
    expect(generous.report.iterations).toBeGreaterThan(0);
    expect(tight.report.iterations).toBe(generous.report.iterations);
    expect(JSON.stringify(tight.assignments)).toEqual(
      JSON.stringify(generous.assignments),
    );
    expect(tight.report.score).toEqual(generous.report.score);
  });

  it("says so when the budget cut the search short, because then it is not reproducible", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 2 })];
    /* One millisecond: construction still completes — it is not optional and is
       not counted against the budget — and the search stops immediately. */
    const cut = generateSchedule(snapshot, options(snapshot, { seed: 7, timeBudgetMs: 1 }));
    expect(cut.report.stoppedOnBudget).toBe(true);
  });

  it("records the seed it was given", () => {
    const snapshot = empty();
    expect(generateSchedule(snapshot, options(snapshot, { seed: 42 })).report.seed).toBe(42);
  });

  it("does not depend on the order the roster arrived in", () => {
    /* A generator whose answer changes when the database sorts differently is a
       generator whose output cannot be diffed between two runs. */
    const forward = empty();
    const reversed = empty();
    reversed.residents = [...reversed.residents].reverse();

    const a = generateSchedule(forward, options(forward, { seed: 3 }));
    const b = generateSchedule(reversed, options(reversed, { seed: 3 }));
    expect(b.assignments.map((x) => x.residentId)).toEqual(
      a.assignments.map((x) => x.residentId),
    );
  });
});

describe("when no valid schedule exists", () => {
  it("emits nothing and names what would have to give", () => {
    const snapshot = empty();
    // Four people a day from a roster of five, with a two-day cap on each.
    snapshot.coverage = [coverage({ min_staff: 4 })];
    snapshot.rules = [rule("max_consecutive_shifts", { days: 1 })];

    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.feasible).toBe(false);
    expect(result.report.unfilled.length).toBeGreaterThan(0);
    expect(result.report.relaxations.length).toBeGreaterThan(0);
    expect(
      result.report.relaxations.some((r) =>
        r.constraintIds.includes("consecutive-days"),
      ),
    ).toBe(true);
  });

  it("says so plainly when the roster is simply too small", () => {
    const snapshot = empty();
    snapshot.residents = [resident(IDS.alice, "Alice Adeyemi", 1)];
    snapshot.coverage = [coverage({ min_staff: 3 })];

    const result = generateSchedule(snapshot, options(snapshot));
    expect(result.feasible).toBe(false);
    expect(result.report.relaxations[0].message).toMatch(
      /nobody on the roster|more people|ask for more/i,
    );
  });

  it("never proposes relaxing somebody's leave", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 5 })];
    for (const person of snapshot.residents) {
      person.constraints = { unavailableDates: ["2026-08-03"] };
    }

    const result = generateSchedule(snapshot, options(snapshot));
    expect(result.feasible).toBe(false);
    for (const relaxation of result.report.relaxations) {
      expect(relaxation.constraintIds).not.toContain("personal-unavailability");
      expect(relaxation.constraintIds).not.toContain("resident-availability");
    }
  });

  it("explains a gap in words a chief could act on", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 4 })];
    snapshot.rules = [rule("max_consecutive_shifts", { days: 1 })];

    const result = generateSchedule(snapshot, options(snapshot));
    for (const relaxation of result.report.relaxations) {
      expect(relaxation.message).toMatch(/[.!]$/);
      expect(relaxation.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(relaxation.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(relaxation.message.length).toBeGreaterThan(20);
    }
  });
});

describe("locks", () => {
  it("keeps a locked assignment exactly where it is", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 2 })];
    const pinned = shift("2026-08-03", IDS.wards, IDS.dana);

    const result = generateSchedule(
      snapshot,
      options(snapshot, {
        existing: [pinned],
        locks: [{ kind: "assignment", shiftId: pinned.shiftId }],
      }),
    );

    emitsNothingOrValidatesClean(snapshot, result);
    const kept = result.assignments.find((a) => a.shiftId === pinned.shiftId);
    expect(kept?.residentId).toBe(IDS.dana);
    expect(result.report.demand.locked).toBe(1);
  });

  it("counts a locked assignment against the slot it fills", () => {
    /* Two people needed and one already locked in means one hole, not two —
       otherwise regenerating over locks doubles the service every time. */
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 2 })];
    const pinned = shift("2026-08-03", IDS.wards, IDS.dana);

    const result = generateSchedule(
      snapshot,
      options(snapshot, {
        existing: [pinned],
        locks: [{ kind: "assignment", shiftId: pinned.shiftId }],
      }),
    );
    const onThatDay = result.assignments.filter(
      (a) => a.start.getTime() === pinned.start.getTime(),
    );
    expect(onThatDay).toHaveLength(2);
  });

  it("locks everything belonging to one resident", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 2 })];
    const theirs = [
      shift("2026-08-03", IDS.wards, IDS.dana),
      shift("2026-08-05", IDS.wards, IDS.dana),
    ];

    const result = generateSchedule(
      snapshot,
      options(snapshot, {
        existing: theirs,
        locks: [{ kind: "resident", residentId: IDS.dana }],
      }),
    );
    emitsNothingOrValidatesClean(snapshot, result);
    for (const original of theirs) {
      expect(
        result.assignments.find((a) => a.shiftId === original.shiftId)?.residentId,
      ).toBe(IDS.dana);
    }
  });

  it("locks a whole day", () => {
    const snapshot = empty();
    const pinned = shift("2026-08-04", IDS.wards, IDS.dana);
    const result = generateSchedule(
      snapshot,
      options(snapshot, {
        existing: [pinned],
        locks: [{ kind: "date", date: "2026-08-04" }],
      }),
    );
    emitsNothingOrValidatesClean(snapshot, result);
    expect(
      result.assignments.find((a) => a.shiftId === pinned.shiftId)?.residentId,
    ).toBe(IDS.dana);
  });

  it("ignores an assignment nothing locks", () => {
    const snapshot = empty();
    const loose = shift("2026-08-03", IDS.wards, IDS.dana);
    const result = generateSchedule(
      snapshot,
      options(snapshot, { existing: [loose], locks: [] }),
    );
    expect(result.report.demand.locked).toBe(0);
  });
});

describe("blocks and cohorts", () => {
  it("puts a cohort on the service its block says", () => {
    const snapshot = withBlock(empty());
    for (const id of [IDS.alice, IDS.ben]) {
      const person = snapshot.residents.find((r) => r.id === id)!;
      person.cohortId = IDS.cohortA;
      person.cohortLabel = "PGY-1 Cohort A";
    }
    snapshot.blockAssignments = [
      { cohortId: IDS.cohortA, blockId: IDS.block1, serviceId: IDS.clinic, label: "" },
    ];

    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    // Nobody in Cohort A is on Wards, because their block says Clinic.
    const wrong = result.assignments.filter(
      (a) =>
        a.serviceId === IDS.wards &&
        [IDS.alice, IDS.ben].includes(a.residentId as never),
    );
    expect(wrong).toEqual([]);
  });

  it("honours an individual exception over the cohort's block", () => {
    const snapshot = withBlock(empty());
    const alice = snapshot.residents.find((r) => r.id === IDS.alice)!;
    alice.cohortId = IDS.cohortA;
    alice.cohortLabel = "PGY-1 Cohort A";
    snapshot.blockAssignments = [
      { cohortId: IDS.cohortA, blockId: IDS.block1, serviceId: IDS.wards, label: "" },
    ];
    snapshot.overrides = [
      {
        residentId: IDS.alice,
        blockId: IDS.block1,
        serviceId: IDS.clinic,
        label: "",
        reason: "Research block",
      },
    ];

    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.assignments.some((a) => a.residentId === IDS.alice)).toBe(false);
  });
});

describe("the report", () => {
  it("says what was demanded, what was filled, and by whom", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 2 })];
    const report = generateSchedule(snapshot, options(snapshot)).report;

    expect(report.demand.slots).toBe(14);
    expect(report.coverage[0]).toMatchObject({ serviceName: "Wards", required: 14 });
    expect(report.fairness.length).toBeGreaterThan(0);
    for (const level of report.fairness) {
      expect(level.residents.length).toBeGreaterThan(0);
    }
  });

  it("reports the score with its breakdown, not one number", () => {
    const snapshot = empty();
    const report = generateSchedule(snapshot, options(snapshot)).report;
    expect(report.score.objectives.length).toBeGreaterThan(5);
    expect(report.score.score).toBeGreaterThanOrEqual(0);
    expect(report.score.score).toBeLessThanOrEqual(100);
  });

  it("says when it stopped because the budget ran out", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 2 })];
    const quick = generateSchedule(snapshot, options(snapshot, { timeBudgetMs: 0 }));
    expect(quick.report.stoppedOnBudget).toBe(false);
    expect(quick.report.iterations).toBe(0);
  });
});

describe("expanding coverage into slots", () => {
  it("makes one slot per person per day the requirement applies", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 2, days_of_week: [1, 2, 3, 4, 5] })];
    expect(expandSlots(snapshot, snapshot.period)).toHaveLength(10);
  });

  it("pins the slots a PGY mix demands to that level", () => {
    const snapshot = empty();
    snapshot.coverage = [
      coverage({
        min_staff: 3,
        days_of_week: [1],
        pgy_mix: [{ pgy: 3, min: 1, max: null }],
      }),
    ];
    const slots = expandSlots(snapshot, snapshot.period);
    expect(slots).toHaveLength(3);
    expect(slots.filter((s) => s.requiredPgy === 3)).toHaveLength(1);
    expect(slots.filter((s) => s.requiredPgy === null)).toHaveLength(2);
  });

  it("produces the same slots on every run", () => {
    const snapshot = empty();
    const first = expandSlots(snapshot, snapshot.period).map((s) => s.id);
    const second = expandSlots(snapshot, snapshot.period).map((s) => s.id);
    expect(second).toEqual(first);
  });
});

describe("boundaries and awkward calendars", () => {
  /** The fixture week moved to whichever week the caller names. */
  function weekOf(start: string, end: string): ScheduleSnapshot {
    const snapshot = empty();
    snapshot.period = { start, end };
    return snapshot;
  }

  it("generates across a spring-forward clock change", () => {
    /* 8 March 2026, 02:00 does not exist in New York. A generator that shifted
       a shift by an hour without saying so is how somebody arrives to an empty
       ward, so the only acceptable behaviours are "schedule it correctly" and
       "do not schedule it". */
    const snapshot = weekOf("2026-03-06", "2026-03-10");
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.feasible).toBe(true);
    expect(result.assignments.length).toBe(5);
  });

  it("generates across an autumn clock change, when 01:30 happens twice", () => {
    const snapshot = weekOf("2026-10-31", "2026-11-02");
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.feasible).toBe(true);
  });

  it("handles an overnight requirement that crosses midnight", () => {
    const snapshot = empty();
    snapshot.coverage = [
      coverage({ start_time: "19:00", end_time: "07:00", min_staff: 1 }),
    ];
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.assignments.every((a) => a.end > a.start)).toBe(true);
    expect(result.assignments.every((a) => a.shiftType === "night")).toBe(true);
  });

  it("handles a period of exactly one day", () => {
    const snapshot = weekOf("2026-08-05", "2026-08-05");
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.assignments).toHaveLength(1);
  });

  it("handles a period that demands nothing", () => {
    const snapshot = empty();
    snapshot.coverage = [];
    const result = generateSchedule(snapshot, options(snapshot));
    expect(result.feasible).toBe(true);
    expect(result.assignments).toEqual([]);
    expect(result.report.demand.slots).toBe(0);
  });

  it("handles a weekend-only requirement", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ days_of_week: [0, 6], min_staff: 2 })];
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    expect(result.assignments).toHaveLength(4);
  });

  it("takes the most specific requirement when two apply to a day", () => {
    /* A named date replaces the weekday rule rather than adding to it — the
       precedence the coverage model already defines, honoured by the generator
       rather than re-decided by it. */
    const snapshot = empty();
    snapshot.coverage = [
      coverage({ id: "weekday", min_staff: 3 }),
      coverage({
        id: "christmas",
        scope: "date",
        specific_date: new Date("2026-08-05T00:00:00Z"),
        days_of_week: [],
        min_staff: 1,
        label: "A quiet day",
      }),
    ];
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    const onThatDay = result.assignments.filter(
      (a) => a.start.toISOString().slice(0, 10) === "2026-08-05",
    );
    expect(onThatDay).toHaveLength(1);
  });
});

describe("sparse and over-constrained programmes", () => {
  it("fills what it can when the roster is thin, or says it cannot", () => {
    const snapshot = empty();
    snapshot.residents = snapshot.residents.slice(0, 2);
    snapshot.coverage = [coverage({ min_staff: 1 })];
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
  });

  it("refuses rather than breaking a leave date", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 5 })];
    for (const person of snapshot.residents) {
      person.constraints = { unavailableDates: ["2026-08-05"] };
    }
    const result = generateSchedule(snapshot, options(snapshot));
    expect(result.feasible).toBe(false);
    expect(result.assignments).toEqual([]);
  });

  it("survives two requirements that ask for the same thing twice", () => {
    const snapshot = empty();
    snapshot.coverage = [
      coverage({ id: "one", min_staff: 1 }),
      coverage({ id: "two", min_staff: 1 }),
    ];
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);
    // Two requirements on the same service and day mean two people, not one.
    expect(result.report.demand.slots).toBe(14);
  });

  it("does not put the same person in two places at the same time", () => {
    /* Structural, not rule-dependent: this programme has configured no overlap
       rule at all, and it still must not happen. */
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 3 })];
    snapshot.rules = [];
    const result = generateSchedule(snapshot, options(snapshot));
    emitsNothingOrValidatesClean(snapshot, result);

    const byTime = new Map<string, string[]>();
    for (const assignment of result.assignments) {
      const key = `${assignment.serviceId}|${assignment.start.getTime()}`;
      const list = byTime.get(key) ?? [];
      list.push(assignment.residentId!);
      byTime.set(key, list);
    }
    for (const [, people] of byTime) {
      expect(new Set(people).size).toBe(people.length);
    }
  });
});

describe("regenerating over locks", () => {
  it("keeps the locked half and rebuilds the rest", () => {
    const snapshot = empty();
    snapshot.coverage = [coverage({ min_staff: 1 })];

    const first = generateSchedule(snapshot, options(snapshot, { seed: 1 }));
    expect(first.feasible).toBe(true);

    /* Lock the first three days of what it produced, then regenerate with a
       different seed. The locked three must come back untouched. */
    const locked = first.assignments.slice(0, 3);
    const second = generateSchedule(
      snapshot,
      options(snapshot, {
        seed: 99,
        existing: locked,
        locks: locked.map((a) => ({ kind: "assignment" as const, shiftId: a.shiftId })),
      }),
    );

    emitsNothingOrValidatesClean(snapshot, second);
    expect(second.feasible).toBe(true);
    for (const original of locked) {
      const kept = second.assignments.find((a) => a.shiftId === original.shiftId);
      expect(kept?.residentId).toBe(original.residentId);
    }
    expect(second.assignments).toHaveLength(first.assignments.length);
  });

  it("does not duplicate a locked shift's slot", () => {
    const snapshot = empty();
    const first = generateSchedule(snapshot, options(snapshot));
    const second = generateSchedule(
      snapshot,
      options(snapshot, {
        existing: first.assignments,
        locks: first.assignments.map((a) => ({
          kind: "assignment" as const,
          shiftId: a.shiftId,
        })),
      }),
    );
    expect(second.assignments).toHaveLength(first.assignments.length);
    expect(second.report.demand.locked).toBe(first.assignments.length);
    expect(second.report.demand.filled).toBe(0);
  });
});
