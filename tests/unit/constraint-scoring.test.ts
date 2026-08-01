import { describe, expect, it } from "vitest";
import { SOFT_CONSTRAINTS } from "@/server/domain/constraints/catalog";
import { scoreSchedule } from "@/server/domain/constraints/scoring";
import { validateSchedule } from "@/server/domain/constraints/validator";
import { IDS, baseSnapshot, resident, shift } from "./constraint-fixture";

/**
 * The score, and the part that makes it usable: the breakdown.
 *
 * A single number cannot be acted on. These tests hold the score to being
 * deterministic, bounded, and — the property that actually matters — always
 * accompanied by the per-objective rows that say *which* objective cost what.
 */

describe("scoring a schedule", () => {
  it("gives a schedule with nothing wrong full marks", () => {
    expect(validateSchedule(baseSnapshot()).score.score).toBe(100);
  });

  it("lists every soft objective, including the ones that scored perfectly", () => {
    /* "We checked fairness and it is fine" and "we did not check fairness"
       must not look the same on a screen. */
    const score = validateSchedule(baseSnapshot()).score;
    expect(score.objectives.map((o) => o.constraintId).sort()).toEqual(
      SOFT_CONSTRAINTS.map((c) => c.id).sort(),
    );
    expect(score.objectives.every((o) => o.penalty === 0)).toBe(true);
    expect(score.objectives.every((o) => o.pointsLost === 0)).toBe(true);
  });

  it("costs points when an objective is violated, and says how many", () => {
    const snapshot = baseSnapshot();
    snapshot.residents.push(
      resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3),
    );
    for (const date of ["2026-08-03", "2026-08-05", "2026-08-07"]) {
      snapshot.assignments.push(shift(date, IDS.clinic, IDS.dana));
    }

    const score = validateSchedule(snapshot).score;
    expect(score.score).toBeLessThan(100);

    const fairness = score.objectives.find((o) => o.constraintId === "workload-fairness")!;
    expect(fairness.violationCount).toBe(1);
    expect(fairness.penalty).toBeGreaterThan(0);
    expect(fairness.pointsLost).toBeGreaterThan(0);

    // Everything else is untouched, which is the point of a breakdown.
    for (const objective of score.objectives) {
      if (objective.constraintId === "workload-fairness") continue;
      expect(objective.pointsLost, objective.constraintId).toBe(0);
    }
  });

  it("adds up: the points lost across objectives are the points off the total", () => {
    const snapshot = baseSnapshot();
    snapshot.residents.push(
      resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3),
    );
    for (const date of ["2026-08-03", "2026-08-05", "2026-08-07", "2026-08-08"]) {
      snapshot.assignments.push(shift(date, IDS.clinic, IDS.dana));
    }
    const score = validateSchedule(snapshot).score;
    const lost = score.objectives.reduce((total, o) => total + o.pointsLost, 0);
    expect(score.score + lost).toBeCloseTo(100, 0);
  });

  it("scores a worse schedule lower than a better one", () => {
    const build = (extra: string[]) => {
      const snapshot = baseSnapshot();
      snapshot.residents.push(
        resident("aaaaaaaa-0006-4000-8000-000000000006", "Ella Ekwueme", 3),
      );
      for (const date of extra) {
        snapshot.assignments.push(shift(date, IDS.clinic, IDS.dana));
      }
      return validateSchedule(snapshot).score.score;
    };
    const mild = build(["2026-08-03", "2026-08-05"]);
    const severe = build([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]);
    expect(severe).toBeLessThan(mild);
  });

  it("stays between 0 and 100 however bad the schedule is", () => {
    const violations = SOFT_CONSTRAINTS.map((constraint) => ({
      constraintId: constraint.id,
      kind: "soft" as const,
      topic: constraint.topic,
      label: constraint.label,
      message: "Everything is wrong.",
      residentIds: [],
      serviceIds: [],
      shiftIds: [],
      dates: [],
      penalty: 1,
    }));
    const score = scoreSchedule(violations);
    expect(score.score).toBe(0);
    expect(scoreSchedule([]).score).toBe(100);
  });

  it("does not let hard violations touch the score", () => {
    /* The score is about how good a legal schedule is. A schedule with a hard
       violation is not a low-scoring schedule — it is an invalid one, and
       saying "82" about it would invite somebody to publish it anyway. */
    const snapshot = baseSnapshot();
    snapshot.residents.find((r) => r.id === IDS.alice)!.schedulable = false;
    const result = validateSchedule(snapshot);
    expect(result.summary.valid).toBe(false);
    expect(result.summary.hardCount).toBeGreaterThan(0);
    expect(result.score.score).toBe(100);
  });
});
