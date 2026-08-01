import { CONSTRAINTS_BY_ID, SOFT_CONSTRAINTS } from "./catalog";
import type { Violation } from "./types";

/**
 * How good a legal schedule is, and — the part that matters — why.
 *
 * One number is useless to a chief. "0.62" cannot be acted on; "nights are
 * lopsided, everything else is fine" can. So the score always arrives with its
 * breakdown, every objective listed including the ones that scored perfectly,
 * because "we checked fairness and it is fine" is information and an absent row
 * is ambiguous between that and "we did not check".
 *
 * ## The arithmetic
 *
 * Each soft constraint contributes a penalty in 0…1: the mean of its
 * violations' penalties, or 0 when it found nothing. Constraints are weighted
 * relative to one another — an unpopular-shift imbalance counts for more than
 * a broken continuity preference — and the total is
 *
 *     score = 100 × (1 − Σ(weightᵢ × penaltyᵢ) / Σ weightᵢ)
 *
 * so a schedule with no soft violations scores 100 and one that maximally
 * violates every objective scores 0. The mean rather than the sum, so a
 * programme with forty residents is not scored worse than one with four for
 * the same degree of unfairness.
 *
 * ## Determinism
 *
 * The same schedule scores the same on every run, on every machine. Nothing
 * here reads a clock, iterates a `Set` whose order depends on insertion from a
 * query, or rounds differently by locale. This matters more than it sounds: the
 * score is the number a future generator will be graded against, and an oracle
 * that wobbles cannot grade anything.
 */

export interface ObjectiveScore {
  constraintId: string;
  label: string;
  weight: number;
  /** 0 (nothing wrong) to 1 (as bad as this objective gets). */
  penalty: number;
  violationCount: number;
  /** What this objective cost the total, in points out of 100. */
  pointsLost: number;
}

export interface ScheduleScore {
  /** 0–100, higher is better. Rounded to one decimal place. */
  score: number;
  objectives: ObjectiveScore[];
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function scoreSchedule(violations: Violation[]): ScheduleScore {
  const softByConstraint = new Map<string, Violation[]>();
  for (const violation of violations) {
    if (violation.kind !== "soft") continue;
    const list = softByConstraint.get(violation.constraintId);
    if (list) list.push(violation);
    else softByConstraint.set(violation.constraintId, [violation]);
  }

  /* Every soft objective appears, plus any hard constraint that produced a
     soft violation — which happens when a programme configured one of its
     rules as a warning rather than an error, and is the programme saying that
     breaking it is a matter of degree. */
  const ids = [
    ...SOFT_CONSTRAINTS.map((c) => c.id),
    ...[...softByConstraint.keys()].filter(
      (id) => !SOFT_CONSTRAINTS.some((c) => c.id === id),
    ),
  ];

  const rows = ids.map((id) => {
    const constraint = CONSTRAINTS_BY_ID.get(id);
    const found = softByConstraint.get(id) ?? [];
    const weight = constraint?.weight ?? 1;
    const penalty =
      found.length === 0
        ? 0
        : found.reduce((total, v) => total + (v.penalty ?? 1), 0) / found.length;
    return {
      constraintId: id,
      label: constraint?.label ?? id,
      weight,
      penalty,
      violationCount: found.length,
      weighted: weight * penalty,
    };
  });

  const totalWeight = rows.reduce((total, row) => total + row.weight, 0);
  const lost = totalWeight === 0
    ? 0
    : rows.reduce((total, row) => total + row.weighted, 0) / totalWeight;

  return {
    score: round(100 * (1 - lost)),
    objectives: rows.map((row) => ({
      constraintId: row.constraintId,
      label: row.label,
      weight: row.weight,
      penalty: round(row.penalty, 3),
      violationCount: row.violationCount,
      pointsLost: round(totalWeight === 0 ? 0 : (100 * row.weighted) / totalWeight),
    })),
  };
}
