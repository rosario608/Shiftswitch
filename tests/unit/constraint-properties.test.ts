import { describe, expect, it } from "vitest";
import { CONSTRAINTS, SOFT_CONSTRAINTS } from "@/server/domain/constraints/catalog";
import { validateSchedule } from "@/server/domain/constraints/validator";
import type { ScheduleSnapshot } from "@/server/domain/constraints/types";
import { IDS, baseSnapshot, night, resident, rule, shift } from "./constraint-fixture";

/**
 * Properties that must hold for *any* schedule, not just the ones somebody
 * thought to write a case for.
 *
 * The per-constraint tests prove each constraint fires when it should. These
 * prove the things that have to be true of every report the validator can ever
 * produce — that it never throws, never scores outside its own range, never
 * contradicts itself about validity, and never returns two different answers
 * for the same schedule.
 *
 * Schedules are generated from a seeded pseudo-random source rather than a
 * library, so a failure is reproducible from the seed printed with it. The
 * generator is deliberately careless: it produces overlaps, unstaffed shifts,
 * people on leave, impossible coverage and empty programmes, because a property
 * asserted only over well-formed input is a property asserted over the cases
 * that were never going to break.
 */

/** Mulberry32 — small, fast, and identical on every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DATES = [
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
  "2026-08-08",
  "2026-08-09",
];

const RULE_TYPES = [
  "min_rest_hours",
  "max_consecutive_shifts",
  "max_consecutive_nights",
  "max_shifts_in_period",
  "weekend_limit",
  "no_overlapping_shifts",
  "pgy_requirement",
  "blackout_dates",
  "holiday_restriction",
] as const;

function randomSnapshot(seed: number): ScheduleSnapshot {
  const random = seeded(seed);
  const pick = <T,>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];

  const snapshot = baseSnapshot();
  const people: string[] = [IDS.alice, IDS.ben, IDS.carmen, IDS.dev, IDS.dana];

  // A programme with nobody in it is a real state, and has to survive.
  if (random() < 0.1) {
    snapshot.assignments = [];
    snapshot.residents = [];
    return snapshot;
  }

  if (random() < 0.3) {
    snapshot.residents.push(
      resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3),
    );
    people.push("aaaaaaaa-0006-4000-8000-000000000006");
  }

  // Between none and twenty extra shifts, some overnight, some on nobody.
  const extra = Math.floor(random() * 20);
  for (let index = 0; index < extra; index += 1) {
    const date = pick(DATES);
    const serviceId = random() < 0.5 ? IDS.wards : IDS.clinic;
    const holder = random() < 0.15 ? null : pick(people);
    snapshot.assignments.push(
      random() < 0.25
        ? night(date, serviceId, holder)
        : shift(date, serviceId, holder),
    );
  }

  // People who cannot work, and people with things recorded about them.
  for (const person of snapshot.residents) {
    if (random() < 0.15) person.schedulable = false;
    if (random() < 0.1) person.active = false;
    if (random() < 0.15) person.constraints = { unavailableDates: [pick(DATES)] };
    if (random() < 0.15) person.preferences = { requestedDaysOff: [pick(DATES)] };
    if (random() < 0.1) person.siteEligibility = { [IDS.site]: false };
    if (random() < 0.15) {
      person.cohortId = random() < 0.5 ? IDS.cohortA : IDS.cohortB;
      person.cohortLabel = "A cohort";
    }
  }

  // Coverage that may be impossible to satisfy.
  if (random() < 0.5) {
    snapshot.coverage = [
      {
        ...snapshot.coverage[0],
        min_staff: Math.floor(random() * 5),
        max_staff: random() < 0.5 ? Math.floor(random() * 3) : null,
        pgy_mix:
          random() < 0.4
            ? [{ pgy: 1 + Math.floor(random() * 3), min: Math.floor(random() * 3), max: null }]
            : [],
      },
    ];
  }

  // A handful of rules, configured with values that may be absurd.
  const ruleCount = Math.floor(random() * 4);
  for (let index = 0; index < ruleCount; index += 1) {
    const type = pick(RULE_TYPES);
    snapshot.rules.push(
      rule(
        type,
        {
          hours: Math.floor(random() * 48),
          days: Math.floor(random() * 5),
          nights: Math.floor(random() * 3),
          maxShifts: Math.floor(random() * 6),
          windowDays: 1 + Math.floor(random() * 28),
          maxWeekendShifts: Math.floor(random() * 3),
          dates: [pick(DATES)],
          mode: random() < 0.5 ? "block" : "approval",
        },
        {
          id: `rule-${type}-${index}`,
          severity: random() < 0.25 ? "warning" : "error",
        },
      ),
    );
  }

  if (random() < 0.3) {
    snapshot.baseline = snapshot.assignments.map((assignment) => ({
      ...assignment,
      residentId: random() < 0.4 ? pick(people) : assignment.residentId,
    }));
  }

  return snapshot;
}

/* Enough to be worth running, few enough to keep `verify:fast` fast. Each seed
   is validated by eight separate properties, so this is over a thousand
   validations; going higher bought no new failures and cost the inner loop
   half a minute. */
const SEEDS = Array.from({ length: 120 }, (_, index) => index + 1);
const KNOWN = new Set(CONSTRAINTS.map((c) => c.id));

describe("properties that hold for any schedule", () => {
  it("never throws, whatever the schedule and configuration look like", () => {
    for (const seed of SEEDS) {
      expect(() => validateSchedule(randomSnapshot(seed)), `seed ${seed}`).not.toThrow();
    }
  });

  it("is valid exactly when it reports no hard violations", () => {
    for (const seed of SEEDS) {
      const result = validateSchedule(randomSnapshot(seed));
      const hard = result.violations.filter((v) => v.kind === "hard");
      expect(result.summary.valid, `seed ${seed}`).toBe(hard.length === 0);
      expect(result.summary.hardCount, `seed ${seed}`).toBe(hard.length);
    }
  });

  it("scores between 0 and 100, always with the full breakdown", () => {
    for (const seed of SEEDS) {
      const { score } = validateSchedule(randomSnapshot(seed));
      expect(score.score, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(score.score, `seed ${seed}`).toBeLessThanOrEqual(100);
      for (const soft of SOFT_CONSTRAINTS) {
        expect(
          score.objectives.some((o) => o.constraintId === soft.id),
          `seed ${seed} is missing ${soft.id}`,
        ).toBe(true);
      }
    }
  });

  it("gives the same answer twice, down to the order", () => {
    for (const seed of SEEDS) {
      const first = validateSchedule(randomSnapshot(seed));
      const second = validateSchedule(randomSnapshot(seed));
      expect(JSON.stringify(second), `seed ${seed}`).toEqual(JSON.stringify(first));
    }
  });

  it("only ever reports constraints that exist", () => {
    for (const seed of SEEDS) {
      for (const violation of validateSchedule(randomSnapshot(seed)).violations) {
        expect(KNOWN, `seed ${seed}`).toContain(violation.constraintId);
      }
    }
  });

  it("writes a readable sentence every time", () => {
    for (const seed of SEEDS) {
      for (const violation of validateSchedule(randomSnapshot(seed)).violations) {
        const where = `seed ${seed} / ${violation.constraintId}: "${violation.message}"`;
        expect(violation.message, where).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(violation.message, where).toMatch(/[.!]$/);
        expect(violation.message.length, where).toBeGreaterThan(15);
        expect(violation.message, where).not.toMatch(/undefined|NaN|\[object/);
      }
    }
  });

  it("puts every soft violation's penalty inside its range", () => {
    for (const seed of SEEDS) {
      for (const violation of validateSchedule(randomSnapshot(seed)).violations) {
        if (violation.kind !== "soft") continue;
        expect(violation.penalty, `seed ${seed} / ${violation.constraintId}`).toBeDefined();
        expect(violation.penalty!, `seed ${seed}`).toBeGreaterThan(0);
        expect(violation.penalty!, `seed ${seed}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps hard violations ahead of soft ones", () => {
    for (const seed of SEEDS) {
      const kinds = validateSchedule(randomSnapshot(seed)).violations.map((v) => v.kind);
      const firstSoft = kinds.indexOf("soft");
      if (firstSoft === -1) continue;
      expect(kinds.slice(firstSoft).includes("hard"), `seed ${seed}`).toBe(false);
    }
  });

  it("removes every violation when the schedule is emptied", () => {
    /* Nothing scheduled cannot be *wrong*, only incomplete — and incomplete is
       coverage's business, which needs a requirement to have an opinion. */
    for (const seed of SEEDS.slice(0, 40)) {
      const snapshot = randomSnapshot(seed);
      snapshot.assignments = [];
      snapshot.coverage = [];
      snapshot.baseline = undefined;
      expect(validateSchedule(snapshot).violations, `seed ${seed}`).toEqual([]);
    }
  });
});
