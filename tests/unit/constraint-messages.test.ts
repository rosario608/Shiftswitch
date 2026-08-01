import { describe, expect, it } from "vitest";
import { CONSTRAINTS } from "@/server/domain/constraints/catalog";
import { validateSchedule } from "@/server/domain/constraints/validator";
import type { Violation } from "@/server/domain/constraints/types";
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
 * What a violation reads like, asserted across every message at once.
 *
 * The same three properties the rule engine's messages are held to, for the
 * same reason: pinning exact prose per constraint does not stop the mistake,
 * because a constraint added next year starts clean and then somebody
 * interpolates an ISO date. Asserting the shape of *every* message the
 * validator can produce does.
 *
 *   - a real date, never `2026-08-03`;
 *   - the numbers in the sentence, because the structured fields are for
 *     screens and the sentence has to stand alone;
 *   - no opening with somebody's name, which every surface prints itself.
 *
 * The schedule below is deliberately terrible: one snapshot that trips as much
 * of the catalogue as a single schedule can, so the properties are asserted
 * over real output rather than over a handful of handpicked strings.
 */

function everyViolation(): Violation[] {
  const snapshot = withBlock(baseSnapshot());
  const ella = resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3);
  snapshot.residents.push(ella);

  const alice = snapshot.residents.find((r) => r.id === IDS.alice)!;
  const ben = snapshot.residents.find((r) => r.id === IDS.ben)!;
  const carmen = snapshot.residents.find((r) => r.id === IDS.carmen)!;

  // Availability, personal constraints, site and service exclusions, wishes.
  alice.schedulable = false;
  alice.schedulingNotes = "On parental leave";
  ben.constraints = {
    unavailableDates: ["2026-08-04"],
    unavailableWeekdays: [4],
    excludedServiceIds: [IDS.wards],
    excludedSiteIds: [IDS.site],
  };
  carmen.preferences = {
    requestedDaysOff: ["2026-08-07"],
    avoidServiceIds: [IDS.wards],
    preferredShiftType: "night",
  };
  carmen.siteEligibility = { [IDS.site]: false };

  // Cohorts and blocks, with an exception nobody honoured.
  for (const person of [alice, ben]) {
    person.cohortId = IDS.cohortA;
    person.cohortLabel = "PGY-1 Cohort A";
  }
  snapshot.blockAssignments = [
    { cohortId: IDS.cohortA, blockId: IDS.block1, serviceId: IDS.clinic, label: "" },
  ];
  snapshot.overrides = [
    {
      residentId: IDS.carmen,
      blockId: IDS.block1,
      serviceId: IDS.clinic,
      label: "",
      reason: "Research block",
    },
  ];

  // Services: a training-level floor, and a cap and mix on coverage.
  snapshot.services = [
    service(IDS.wards, "Wards", { coverageMandatory: true, pgyMin: 3 }),
    service(IDS.clinic, "Clinic"),
  ];
  snapshot.coverage = [
    coverage({
      min_staff: 2,
      max_staff: 2,
      pgy_mix: [{ pgy: 3, min: 1, max: 1 }],
      label: "Every day",
    }),
  ];

  // A shift nobody is on, and a third person on one day to break the cap.
  snapshot.assignments[0].residentId = null;
  snapshot.assignments.push(shift("2026-08-05", IDS.wards, IDS.dev));
  snapshot.assignments.push(shift("2026-08-05", IDS.wards, IDS.carmen));

  // Dana: overlaps, too little rest, too many days, too many nights.
  snapshot.assignments.push(shift("2026-08-03", IDS.clinic, IDS.dana));
  snapshot.assignments.push(
    shift("2026-08-03", IDS.clinic, IDS.dana, {
      start: at("2026-08-03", "12:00"),
      end: at("2026-08-03", "22:00"),
    }),
  );
  snapshot.assignments.push(night("2026-08-04", IDS.clinic, IDS.dana));
  snapshot.assignments.push(night("2026-08-05", IDS.clinic, IDS.dana));
  snapshot.assignments.push(shift("2026-08-06", IDS.clinic, IDS.dana));
  snapshot.assignments.push(shift("2026-08-08", IDS.clinic, IDS.dana));
  snapshot.assignments.push(shift("2026-08-09", IDS.clinic, IDS.dana));
  snapshot.assignments.push(shift("2026-08-04", IDS.clinic, ella.id));

  /* Three services inside one block for Dana — Clinic, Night Float and Wards —
     so continuity has something to complain about. Two would be ordinary. */
  const nights = service("55555555-5555-4555-8555-000000000005", "Night Float");
  snapshot.services.push(nights);
  snapshot.assignments.push(
    shift("2026-08-07", IDS.clinic, IDS.dana, { serviceId: nights.id }),
  );
  snapshot.assignments.push(shift("2026-08-04", IDS.wards, IDS.dana));

  snapshot.rules = [
    rule("min_rest_hours", { hours: 12 }),
    rule("max_consecutive_shifts", { days: 2 }),
    rule("max_consecutive_nights", { nights: 1 }),
    rule("max_shifts_in_period", { maxShifts: 3, windowDays: 28 }),
    rule("weekend_limit", { maxWeekendShifts: 1, windowDays: 28 }),
    rule("no_overlapping_shifts", {}),
    rule("pgy_requirement", {}),
    rule("blackout_dates", { dates: ["2026-08-06"] }),
    rule("holiday_restriction", { dates: ["2026-08-08"], mode: "approval" }),
    rule(
      "service_requirement",
      { allowedPgy: [3] },
      { scope: "service", scope_id: IDS.wards },
    ),
    rule(
      "credential_requirement",
      { credentials: ["ACLS"] },
      { scope: "service", scope_id: IDS.wards },
    ),
  ];
  // Every shift's own PGY range excludes an intern, so `pgy_requirement` bites.
  for (const assignment of snapshot.assignments) {
    if (assignment.serviceId === IDS.wards) assignment.requiredPgyMin = 3;
  }

  // A baseline, so the change objective has something to measure against.
  snapshot.baseline = snapshot.assignments.map((a) => ({
    ...a,
    residentId: a.residentId === IDS.carmen ? IDS.dev : a.residentId,
  }));

  return validateSchedule(snapshot).violations;
}

const NAMES = [
  "Alice Adeyemi",
  "Ben Brennan",
  "Carmen Costa",
  "Dev Dhillon",
  "Dana Whitfield",
  "Ella Ekwueme",
];

describe("what a schedule violation reads like", () => {
  it("actually exercises most of the catalogue", () => {
    /* Named explicitly. A fixture that quietly stopped tripping most of the
       constraints would leave every property below asserting almost nothing,
       and would still pass. */
    const fired = new Set(everyViolation().map((v) => v.constraintId));
    for (const id of [
      "coverage-minimum",
      "coverage-maximum",
      "coverage-pgy-mix",
      "shift-unstaffed",
      "resident-availability",
      "personal-unavailability",
      "service-pgy-eligibility",
      "shift-pgy-eligibility",
      "service-eligibility",
      "credential-eligibility",
      "site-eligibility",
      "service-exclusion",
      "block-structure",
      "block-override",
      "blackout-dates",
      "overlapping-assignments",
      "rest-hours",
      "consecutive-days",
      "consecutive-nights",
      "workload-window",
      "weekend-window",
      "stated-preferences",
      "continuity",
      "minimise-change",
    ]) {
      expect(fired, `${id} did not fire`).toContain(id);
    }
    // Two thirds of the catalogue, at least, or the properties mean little.
    expect(fired.size).toBeGreaterThanOrEqual(Math.ceil(CONSTRAINTS.length * 0.66));
  });

  it("never shows a chief an ISO date", () => {
    for (const violation of everyViolation()) {
      expect(
        violation.message,
        `${violation.constraintId}: "${violation.message}"`,
      ).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it("never opens with somebody's name, which every surface prints already", () => {
    for (const violation of everyViolation()) {
      for (const name of NAMES) {
        expect(
          violation.message.startsWith(`${name}:`),
          `${violation.constraintId} stutters: "${name}: ${violation.message}"`,
        ).toBe(false);
      }
    }
  });

  it("puts the numbers in the sentence, not only in the structured fields", () => {
    /* The count, the limit, the gap — whichever the constraint is about. A
       chief reading "MICU is short" has to go and count; reading "has 1 person
       and needs 2" they already know. The three constraints exempted below are
       about a fact rather than a quantity. */
    const qualitative = new Set([
      "resident-availability",
      "personal-unavailability",
      "service-exclusion",
      "site-eligibility",
      "blackout-dates",
      "block-override",
      "block-structure",
      "overlapping-assignments",
    ]);
    for (const violation of everyViolation()) {
      if (qualitative.has(violation.constraintId)) continue;
      expect(
        violation.message,
        `${violation.constraintId}: "${violation.message}"`,
      ).toMatch(/\d/);
    }
  });

  it("writes whole sentences, not fragments or identifiers", () => {
    for (const violation of everyViolation()) {
      const message = violation.message;
      expect(message, violation.constraintId).toMatch(/[.!]$/);
      expect(message[0], `${violation.constraintId}: "${message}"`).toBe(
        message[0].toUpperCase(),
      );
      // No uuids and no snake_case rule types leaking through.
      expect(message, violation.constraintId).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(message, violation.constraintId).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(message.length, violation.constraintId).toBeGreaterThan(15);
    }
  });

  it("names what it is talking about, so a screen can link to it", () => {
    for (const violation of everyViolation()) {
      const named =
        violation.residentIds.length +
        violation.serviceIds.length +
        violation.shiftIds.length +
        violation.dates.length;
      expect(named, `${violation.constraintId} names nothing`).toBeGreaterThan(0);
    }
  });

  it("gives every soft violation a penalty, and no hard one a penalty", () => {
    for (const violation of everyViolation()) {
      if (violation.kind === "soft") {
        expect(violation.penalty, violation.constraintId).toBeGreaterThan(0);
        expect(violation.penalty, violation.constraintId).toBeLessThanOrEqual(1);
      } else {
        expect(violation.penalty, violation.constraintId).toBeUndefined();
      }
    }
  });
});
