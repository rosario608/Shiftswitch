import { describe, expect, it } from "vitest";
import { CONSTRAINTS } from "@/server/domain/constraints/catalog";
import { validateSchedule } from "@/server/domain/constraints/validator";
import type { ScheduleSnapshot } from "@/server/domain/constraints/types";
import {
  IDS,
  at,
  baseSnapshot,
  coverage,
  night,
  resident,
  rule,
  service,
  shift,
  withBlock,
} from "./constraint-fixture";

/**
 * Every constraint, violated on purpose.
 *
 * Each case builds a schedule that breaks one thing and asserts the *exact* set
 * of constraints reported — not "includes", which would let a constraint that
 * fires on everything pass every test in the file. Where breaking one thing
 * genuinely breaks another (taking somebody off a mandatory shift leaves it
 * unstaffed *and* leaves the service short), the case says so, because that is
 * the truth about the schedule and pretending otherwise would mean weakening
 * the assertion until it caught nothing.
 *
 * The last test in the file is the one that keeps this honest: a constraint
 * added to the catalogue with no case here fails the suite.
 */

interface Case {
  /** The constraint this case exists to prove. */
  id: string;
  name: string;
  build: () => ScheduleSnapshot;
  /** Everything expected, this constraint included. Order does not matter. */
  expect: string[];
  /** Optional exact count of violations, when the number is the point. */
  count?: number;
}

const CASES: Case[] = [
  // -------------------------------------------------------------------------
  // Coverage
  // -------------------------------------------------------------------------
  {
    id: "coverage-minimum",
    name: "a day with nobody rostered on a service that needs somebody",
    build: () => {
      const snapshot = baseSnapshot();
      // The shift is gone entirely, so this is a gap rather than an empty slot.
      snapshot.assignments = snapshot.assignments.filter(
        (a) => a.start.getTime() !== at("2026-08-03", "07:00").getTime(),
      );
      return snapshot;
    },
    expect: ["coverage-minimum"],
    count: 1,
  },
  {
    id: "coverage-maximum",
    name: "more people on a service than its cap allows",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.coverage = [coverage({ max_staff: 1 })];
      // Given to the PGY-2 with one shift, so nobody's balance moves.
      snapshot.assignments.push(shift("2026-08-03", IDS.wards, IDS.dev));
      return snapshot;
    },
    expect: ["coverage-maximum"],
    count: 1,
  },
  {
    id: "coverage-pgy-mix",
    name: "a requirement asking for a senior that no senior covers",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.coverage = [
        coverage({
          pgy_mix: [{ pgy: 3, min: 1, max: null }],
          days_of_week: [1], // Mondays only, so this is one day not seven.
        }),
      ];
      return snapshot;
    },
    expect: ["coverage-pgy-mix"],
    count: 1,
  },
  {
    id: "shift-unstaffed",
    name: "a shift on a mandatory service with nobody on it",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.assignments[0].residentId = null;
      return snapshot;
    },
    // The service is now short as well, and it genuinely is.
    expect: ["shift-unstaffed", "coverage-minimum"],
    count: 2,
  },

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------
  {
    id: "resident-availability",
    name: "somebody on leave is scheduled anyway",
    build: () => {
      const snapshot = baseSnapshot();
      const alice = snapshot.residents.find((r) => r.id === IDS.alice)!;
      alice.schedulable = false;
      alice.schedulingNotes = "On parental leave until October";
      return snapshot;
    },
    expect: ["resident-availability"],
    count: 2, // Alice holds two shifts.
  },
  {
    id: "personal-unavailability",
    name: "a date somebody recorded as unavailable",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.residents.find((r) => r.id === IDS.alice)!.constraints = {
        unavailableDates: ["2026-08-03"],
      };
      return snapshot;
    },
    expect: ["personal-unavailability"],
    count: 1,
  },
  {
    id: "personal-unavailability",
    name: "a structured absence covering a day somebody is scheduled",
    build: () => {
      const snapshot = baseSnapshot();
      /* The same violation as the jsonb list above, on purpose. Structured
         availability is a better way to *enter* the fact, not a second kind of
         fact, and a schedule that ignores it must be wrong in exactly one way
         however it was recorded. */
      snapshot.residents.find((r) => r.id === IDS.alice)!.absences = [
        {
          id: "absence-1",
          kind: "vacation",
          label: "Vacation",
          startDate: "2026-08-01",
          endDate: "2026-08-05",
          hard: true,
        },
      ];
      return snapshot;
    },
    expect: ["personal-unavailability"],
    count: 2, // Alice works Monday the 3rd and Wednesday the 5th.
  },
  {
    /* Filed under the constraint it actually reports. That it is *not*
       `personal-unavailability` is the assertion: an unconfirmed absence must
       not be able to make a schedule invalid. */
    id: "stated-preferences",
    name: "an unconfirmed absence does not invalidate the schedule",
    build: () => {
      const snapshot = baseSnapshot();
      /* Soft, so it is scored and never enforced — a resident recording a
         request must not be able to make the programme's schedule invalid.
         It surfaces as `stated-preferences` instead, which is the soft
         objective that already carries requested days off. */
      snapshot.residents.find((r) => r.id === IDS.alice)!.absences = [
        {
          id: "absence-2",
          kind: "conference",
          label: "Conference",
          startDate: "2026-08-03",
          endDate: "2026-08-03",
          hard: false,
        },
      ];
      return snapshot;
    },
    expect: ["stated-preferences"],
    count: 1,
  },
  {
    id: "personal-unavailability",
    name: "a weekday somebody cannot work",
    build: () => {
      const snapshot = baseSnapshot();
      // Friday, which Carmen works.
      snapshot.residents.find((r) => r.id === IDS.carmen)!.constraints = {
        unavailableWeekdays: [5],
      };
      return snapshot;
    },
    expect: ["personal-unavailability"],
    count: 1,
  },

  // -------------------------------------------------------------------------
  // Eligibility
  // -------------------------------------------------------------------------
  {
    id: "service-pgy-eligibility",
    name: "an intern on a service configured for seniors",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.services = [
        service(IDS.wards, "Wards", { coverageMandatory: true, pgyMin: 2 }),
        service(IDS.clinic, "Clinic"),
      ];
      return snapshot;
    },
    expect: ["service-pgy-eligibility"],
    count: 4, // Alice and Ben, two shifts each.
  },
  {
    id: "shift-pgy-eligibility",
    name: "a shift whose own PGY range excludes the person on it",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.rules = [rule("pgy_requirement", {})];
      snapshot.assignments[0].requiredPgyMin = 3;
      snapshot.assignments[0].requiredPgyMax = 3;
      return snapshot;
    },
    expect: ["shift-pgy-eligibility"],
    count: 1,
  },
  {
    id: "service-eligibility",
    name: "a service rule restricting who may cover it",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.rules = [
        rule(
          "service_requirement",
          { allowedPgy: [2] },
          { scope: "service", scope_id: IDS.wards },
        ),
      ];
      return snapshot;
    },
    expect: ["service-eligibility"],
    count: 4,
  },
  {
    id: "credential-eligibility",
    name: "a credential nobody on the service holds",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.rules = [
        rule(
          "credential_requirement",
          { credentials: ["ACLS"] },
          { scope: "service", scope_id: IDS.wards },
        ),
      ];
      return snapshot;
    },
    expect: ["credential-eligibility"],
    count: 7,
  },
  {
    id: "site-eligibility",
    name: "somebody scheduled at a site they are not credentialed for",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.residents.find((r) => r.id === IDS.alice)!.siteEligibility = {
        [IDS.site]: false,
      };
      return snapshot;
    },
    expect: ["site-eligibility"],
    count: 2,
  },
  {
    id: "service-exclusion",
    name: "a service somebody is recorded as unable to work",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.residents.find((r) => r.id === IDS.ben)!.constraints = {
        excludedServiceIds: [IDS.wards],
      };
      return snapshot;
    },
    expect: ["service-exclusion"],
    count: 2,
  },

  // -------------------------------------------------------------------------
  // Structure
  // -------------------------------------------------------------------------
  {
    id: "block-structure",
    name: "a cohort assigned to one service, working another",
    build: () => {
      const snapshot = withBlock(baseSnapshot());
      const alice = snapshot.residents.find((r) => r.id === IDS.alice)!;
      alice.cohortId = IDS.cohortA;
      alice.cohortLabel = "PGY-1 Cohort A";
      snapshot.blockAssignments = [
        {
          cohortId: IDS.cohortA,
          blockId: IDS.block1,
          serviceId: IDS.clinic,
          label: "",
        },
      ];
      return snapshot;
    },
    expect: ["block-structure"],
    count: 1, // One person, one block, one wrong service — said once.
  },
  {
    id: "block-override",
    name: "a recorded exception the schedule ignores",
    build: () => {
      const snapshot = withBlock(baseSnapshot());
      snapshot.overrides = [
        {
          residentId: IDS.alice,
          blockId: IDS.block1,
          serviceId: IDS.clinic,
          label: "",
          reason: "Make-up ambulatory block",
        },
      ];
      return snapshot;
    },
    expect: ["block-override"],
    count: 1,
  },
  {
    id: "blackout-dates",
    name: "somebody scheduled on a protected date",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.rules = [rule("blackout_dates", { dates: ["2026-08-05"] })];
      return snapshot;
    },
    expect: ["blackout-dates"],
    count: 1,
  },

  // -------------------------------------------------------------------------
  // Safety and workload, delegated to the rules engine
  // -------------------------------------------------------------------------
  {
    id: "overlapping-assignments",
    name: "one person in two places at once",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.rules = [rule("no_overlapping_shifts", {})];
      snapshot.assignments.push(shift("2026-08-03", IDS.clinic, IDS.dana));
      snapshot.assignments.push(
        shift("2026-08-03", IDS.clinic, IDS.dana, {
          start: at("2026-08-03", "12:00"),
          end: at("2026-08-03", "22:00"),
        }),
      );
      return snapshot;
    },
    expect: ["overlapping-assignments"],
    count: 2, // Each of the two shifts is in the wrong, and both are named.
  },
  {
    id: "rest-hours",
    name: "too few hours between two shifts",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.rules = [rule("min_rest_hours", { hours: 10 })];
      snapshot.assignments.push(shift("2026-08-03", IDS.clinic, IDS.dana));
      snapshot.assignments.push(
        shift("2026-08-04", IDS.clinic, IDS.dana, {
          start: at("2026-08-04", "01:00"),
          end: at("2026-08-04", "09:00"),
        }),
      );
      return snapshot;
    },
    expect: ["rest-hours"],
    count: 2,
  },
  {
    id: "consecutive-days",
    name: "more days in a row than the programme allows",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.rules = [rule("max_consecutive_shifts", { days: 2 })];
      for (const date of ["2026-08-03", "2026-08-04", "2026-08-05"]) {
        snapshot.assignments.push(shift(date, IDS.clinic, IDS.dana));
      }
      return snapshot;
    },
    expect: ["consecutive-days"],
    count: 1, // One sentence about the run, not one per day of it.
  },
  {
    id: "consecutive-nights",
    name: "more nights in a row than the programme allows",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.rules = [rule("max_consecutive_nights", { nights: 1 })];
      snapshot.assignments.push(night("2026-08-03", IDS.clinic, IDS.dana));
      snapshot.assignments.push(night("2026-08-04", IDS.clinic, IDS.dana));
      return snapshot;
    },
    expect: ["consecutive-nights"],
    count: 1,
  },
  {
    id: "workload-window",
    name: "more shifts in a rolling window than the cap",
    build: () => {
      const snapshot = baseSnapshot();
      /* The cap is two, which everybody in the base is at or under, so only
         Dana's third shift breaks it. A cap of one would have been broken by
         four people at once — correctly, and uselessly for this case. */
      snapshot.rules = [
        rule("max_shifts_in_period", { maxShifts: 2, windowDays: 7 }),
      ];
      for (const date of ["2026-08-03", "2026-08-05", "2026-08-06"]) {
        snapshot.assignments.push(shift(date, IDS.clinic, IDS.dana));
      }
      return snapshot;
    },
    expect: ["workload-window"],
    count: 1,
  },
  {
    id: "weekend-window",
    name: "more weekend shifts than the cap",
    build: () => {
      const snapshot = baseSnapshot();
      /* One weekend shift is what Carmen and Dev each already have, so the cap
         is one and only Dana's second breaks it. */
      snapshot.rules = [
        rule("weekend_limit", { maxWeekendShifts: 1, windowDays: 7 }),
      ];
      snapshot.assignments.push(shift("2026-08-08", IDS.clinic, IDS.dana));
      snapshot.assignments.push(shift("2026-08-09", IDS.clinic, IDS.dana));
      return snapshot;
    },
    expect: ["weekend-window"],
    count: 1,
  },

  // -------------------------------------------------------------------------
  // Soft: fairness, preference, continuity, change
  // -------------------------------------------------------------------------
  {
    id: "workload-fairness",
    name: "one person at a level working far more than another",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.residents.push(resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3));
      for (const date of ["2026-08-03", "2026-08-05", "2026-08-07"]) {
        snapshot.assignments.push(shift(date, IDS.clinic, IDS.dana));
      }
      return snapshot;
    },
    expect: ["workload-fairness"],
    count: 1,
  },
  {
    id: "night-balance",
    name: "one person taking every night at their level",
    build: () => {
      const snapshot = baseSnapshot();
      const ella = resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3);
      snapshot.residents.push(ella);
      snapshot.assignments.push(night("2026-08-03", IDS.clinic, IDS.dana));
      snapshot.assignments.push(night("2026-08-05", IDS.clinic, IDS.dana));
      // Ella works the same number of shifts, so only the *nights* are uneven.
      snapshot.assignments.push(shift("2026-08-04", IDS.clinic, ella.id));
      snapshot.assignments.push(shift("2026-08-06", IDS.clinic, ella.id));
      return snapshot;
    },
    // Nights are also unpopular shifts, and the totals say so.
    expect: ["night-balance", "undesirable-balance"],
  },
  {
    id: "weekend-balance",
    name: "one person taking every weekend at their level",
    build: () => {
      const snapshot = baseSnapshot();
      const ella = resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3);
      snapshot.residents.push(ella);
      snapshot.assignments.push(shift("2026-08-08", IDS.clinic, IDS.dana));
      snapshot.assignments.push(shift("2026-08-09", IDS.clinic, IDS.dana));
      snapshot.assignments.push(shift("2026-08-04", IDS.clinic, ella.id));
      snapshot.assignments.push(shift("2026-08-06", IDS.clinic, ella.id));
      return snapshot;
    },
    expect: ["weekend-balance", "undesirable-balance"],
  },
  {
    id: "undesirable-balance",
    name: "one person carrying the holidays",
    build: () => {
      const snapshot = baseSnapshot();
      const ella = resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3);
      snapshot.residents.push(ella);
      /* The holiday is outside the fixture week so that no PGY-1 or PGY-2 is
         working it — otherwise their level goes uneven too, correctly, and the
         case stops being about one thing. Fairness counts every shift a person
         holds; coverage only looks inside the period. */
      snapshot.rules = [
        rule("holiday_restriction", { dates: ["2026-08-10"], mode: "approval" }),
      ];
      // Same count, same nights, same weekends — only the holiday differs.
      snapshot.assignments.push(shift("2026-08-10", IDS.clinic, IDS.dana));
      snapshot.assignments.push(shift("2026-08-11", IDS.clinic, ella.id));
      return snapshot;
    },
    expect: ["undesirable-balance"],
    count: 1,
  },
  {
    id: "stated-preferences",
    name: "a day somebody asked to have off",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.residents.find((r) => r.id === IDS.alice)!.preferences = {
        requestedDaysOff: ["2026-08-03"],
      };
      return snapshot;
    },
    expect: ["stated-preferences"],
    count: 1,
  },
  {
    id: "continuity",
    name: "somebody moved between three services inside one block",
    build: () => {
      const snapshot = withBlock(baseSnapshot());
      const third = service("55555555-5555-4555-8555-000000000005", "Nights");
      snapshot.services.push(third);
      snapshot.assignments.push(shift("2026-08-03", IDS.wards, IDS.dana));
      snapshot.assignments.push(shift("2026-08-04", IDS.clinic, IDS.dana));
      snapshot.assignments.push(
        shift("2026-08-05", IDS.clinic, IDS.dana, { serviceId: third.id }),
      );
      return snapshot;
    },
    expect: ["continuity"],
    count: 1,
  },
  {
    id: "cohort-consistency",
    name: "a cohort split across services in a block nobody assigned it",
    build: () => {
      const snapshot = withBlock(baseSnapshot());
      for (const id of [IDS.alice, IDS.ben]) {
        const person = snapshot.residents.find((r) => r.id === id)!;
        person.cohortId = IDS.cohortA;
        person.cohortLabel = "PGY-1 Cohort A";
      }
      // Ben moves to Clinic; nothing says the cohort should be split.
      for (const assignment of snapshot.assignments) {
        if (assignment.residentId === IDS.ben) {
          assignment.serviceId = IDS.clinic;
          assignment.serviceName = "Clinic";
        }
      }
      return snapshot;
    },
    // Wards is now short on the two days Ben was covering it.
    expect: ["cohort-consistency", "coverage-minimum"],
  },
  {
    id: "service-distribution",
    name: "one person carrying most of a service",
    build: () => {
      const snapshot = baseSnapshot();
      const dates = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
      for (const date of dates) {
        snapshot.assignments.push(shift(date, IDS.clinic, IDS.dana));
      }
      // Three other people take one Clinic shift each: five of nine is skewed.
      snapshot.assignments.push(shift("2026-08-08", IDS.clinic, IDS.alice));
      snapshot.assignments.push(shift("2026-08-08", IDS.clinic, IDS.ben));
      snapshot.assignments.push(shift("2026-08-09", IDS.clinic, IDS.carmen));
      snapshot.assignments.push(shift("2026-08-09", IDS.clinic, IDS.dev));
      return snapshot;
    },
    expect: ["service-distribution"],
    count: 1,
  },
  {
    id: "minimise-change",
    name: "a draft that moves shifts the published schedule already had",
    build: () => {
      const snapshot = baseSnapshot();
      snapshot.baseline = snapshot.assignments.map((a) => ({ ...a }));
      // Two shifts change hands between people at the same level.
      snapshot.assignments[0].residentId = IDS.ben;
      snapshot.assignments[1].residentId = IDS.alice;
      return snapshot;
    },
    expect: ["minimise-change"],
    count: 1,
  },
];

describe("the base schedule is valid and quiet", () => {
  it("reports nothing at all", () => {
    const result = validateSchedule(baseSnapshot());
    expect(result.violations).toEqual([]);
    expect(result.summary.valid).toBe(true);
    expect(result.score.score).toBe(100);
  });

  it("still reports which constraints it checked", () => {
    /* "No problems" and "we did not look" must not be the same answer on a
       screen. The checked list is what makes them different. */
    const result = validateSchedule(baseSnapshot());
    expect(result.checked).toHaveLength(CONSTRAINTS.length);
    expect(result.checked.every((c) => c.description.length > 0)).toBe(true);
  });
});

describe("each constraint, violated on purpose", () => {
  for (const testCase of CASES) {
    it(`${testCase.id}: ${testCase.name}`, () => {
      const result = validateSchedule(testCase.build());
      const reported = [...new Set(result.violations.map((v) => v.constraintId))].sort();

      expect(reported).toEqual([...testCase.expect].sort());
      expect(reported).toContain(testCase.id);
      if (testCase.count !== undefined) {
        expect(result.violations).toHaveLength(testCase.count);
      }
    });
  }
});

describe("violations in combination", () => {
  it("reports every one of four independent problems at once", () => {
    const snapshot = baseSnapshot();
    // 1. somebody on leave
    snapshot.residents.find((r) => r.id === IDS.alice)!.schedulable = false;
    // 2. a shift with nobody on it, which also leaves the service short
    snapshot.assignments[1].residentId = null;
    // 3. a blackout date
    snapshot.rules = [rule("blackout_dates", { dates: ["2026-08-07"] })];
    // 4. a day somebody asked off
    snapshot.residents.find((r) => r.id === IDS.carmen)!.preferences = {
      requestedDaysOff: ["2026-08-09"],
    };

    const result = validateSchedule(snapshot);
    const reported = [...new Set(result.violations.map((v) => v.constraintId))].sort();
    expect(reported).toEqual(
      [
        "blackout-dates",
        "coverage-minimum",
        "resident-availability",
        "shift-unstaffed",
        "stated-preferences",
      ].sort(),
    );
    expect(result.summary.valid).toBe(false);
  });

  it("finding one problem does not hide another on the same shift", () => {
    /* One shift, three things wrong with it. A validator that returned the
       first would send a chief round the loop three times. */
    const snapshot = baseSnapshot();
    const alice = snapshot.residents.find((r) => r.id === IDS.alice)!;
    alice.schedulable = false;
    alice.constraints = { unavailableDates: ["2026-08-03"], excludedServiceIds: [IDS.wards] };
    alice.siteEligibility = { [IDS.site]: false };

    const result = validateSchedule(snapshot);
    const onMonday = result.violations.filter((v) => v.dates.includes("2026-08-03"));
    expect([...new Set(onMonday.map((v) => v.constraintId))].sort()).toEqual([
      "personal-unavailability",
      "resident-availability",
      "service-exclusion",
      "site-eligibility",
    ]);
  });
});

describe("coverage counts people, not rows", () => {
  it("does not let one person fill two places on the same service", () => {
    /* Found by the generator, which satisfied a two-person minimum with one
       person twice over on a programme that had configured no overlap rule.
       Counting rows made the ward look staffed while one of its two places was
       empty — the exact failure this product exists to prevent. */
    const snapshot = baseSnapshot();
    snapshot.coverage = [coverage({ min_staff: 2, days_of_week: [1] })];
    snapshot.assignments = [
      shift("2026-08-03", IDS.wards, IDS.alice),
      shift("2026-08-03", IDS.wards, IDS.alice),
    ];

    const result = validateSchedule(snapshot);
    const short = result.violations.filter((v) => v.constraintId === "coverage-minimum");
    expect(short).toHaveLength(1);
    expect(short[0].message).toContain("has 1 person");
  });

  it("counts two different people as two", () => {
    const snapshot = baseSnapshot();
    snapshot.coverage = [coverage({ min_staff: 2, days_of_week: [1] })];
    snapshot.assignments = [
      shift("2026-08-03", IDS.wards, IDS.alice),
      shift("2026-08-03", IDS.wards, IDS.ben),
    ];
    expect(
      validateSchedule(snapshot).violations.filter(
        (v) => v.constraintId === "coverage-minimum",
      ),
    ).toEqual([]);
  });

  it("applies the same counting to the cap and to the mix", () => {
    const snapshot = baseSnapshot();
    snapshot.coverage = [
      coverage({
        min_staff: 1,
        max_staff: 1,
        days_of_week: [1],
        pgy_mix: [{ pgy: 1, min: 2, max: null }],
      }),
    ];
    snapshot.assignments = [
      shift("2026-08-03", IDS.wards, IDS.alice),
      shift("2026-08-03", IDS.wards, IDS.alice),
    ];
    const reported = validateSchedule(snapshot).violations.map((v) => v.constraintId);
    // One person twice is neither over the cap of one nor two PGY-1s.
    expect(reported).not.toContain("coverage-maximum");
    expect(reported).toContain("coverage-pgy-mix");
  });
});

describe("the catalogue cannot outgrow its tests", () => {
  it("has a case for every constraint", () => {
    const tested = new Set(CASES.map((c) => c.id));
    const untested = CONSTRAINTS.filter((c) => !tested.has(c.id)).map((c) => c.id);
    expect(untested).toEqual([]);
  });

  it("has no case for a constraint that does not exist", () => {
    const known = new Set(CONSTRAINTS.map((c) => c.id));
    const orphans = [...new Set(CASES.map((c) => c.id))].filter((id) => !known.has(id));
    expect(orphans).toEqual([]);
  });

  it("declares every constraint hard or soft, with a description", () => {
    for (const constraint of CONSTRAINTS) {
      expect(["hard", "soft"], constraint.id).toContain(constraint.kind);
      expect(constraint.description.length, constraint.id).toBeGreaterThan(20);
      expect(constraint.label.length, constraint.id).toBeGreaterThan(0);
    }
  });
});

describe("determinism", () => {
  it("produces the same report, in the same order, on every run", () => {
    const build = () => {
      const snapshot = baseSnapshot();
      snapshot.residents.find((r) => r.id === IDS.alice)!.schedulable = false;
      snapshot.assignments[2].residentId = null;
      snapshot.rules = [rule("blackout_dates", { dates: ["2026-08-07"] })];
      return snapshot;
    };
    const first = validateSchedule(build());
    const second = validateSchedule(build());
    expect(second.violations.map((v) => v.message)).toEqual(
      first.violations.map((v) => v.message),
    );
    expect(second.score).toEqual(first.score);
  });

  it("orders hard violations before soft ones", () => {
    const snapshot = baseSnapshot();
    snapshot.residents.find((r) => r.id === IDS.alice)!.schedulable = false;
    snapshot.residents.find((r) => r.id === IDS.carmen)!.preferences = {
      requestedDaysOff: ["2026-08-07"],
    };
    const kinds = validateSchedule(snapshot).violations.map((v) => v.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => (a === b ? 0 : a === "hard" ? -1 : 1)));
  });
});
