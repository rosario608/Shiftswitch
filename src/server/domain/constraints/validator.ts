import { CONSTRAINTS } from "./catalog";
import { scoreSchedule, type ScheduleScore } from "./scoring";
import type { ConstraintTopic, ScheduleSnapshot, Violation } from "./types";

/**
 * Is this schedule valid, and if not, exactly what is wrong with it.
 *
 * The oracle. Every later scheduling feature is graded against this — a
 * generator is only as good as the thing that says whether its output is
 * legal — and on its own it is what makes a manual edit safe and an imported
 * schedule checkable the moment it lands.
 *
 * It runs every constraint over the snapshot and returns everything found. Not
 * the first failure: a chief fixing a month wants the list, and a validator
 * that stops at the first problem turns one pass into twenty.
 *
 * ## Order
 *
 * Hard before soft, then by topic in the order a schedule falls apart —
 * coverage gaps first, because an uncovered ward is the thing that hurts
 * somebody, and preferences last. Within a group, by date, so the list reads
 * like a calendar. Entirely deterministic: two runs over the same snapshot
 * produce the same list in the same order.
 */

const TOPIC_ORDER: ConstraintTopic[] = [
  "coverage",
  "availability",
  "eligibility",
  "safety",
  "structure",
  "workload",
  "fairness",
  "continuity",
  "preference",
  "change",
];

export interface ValidationSummary {
  valid: boolean;
  hardCount: number;
  softCount: number;
  /** Violations by constraint, for a screen that groups rather than lists. */
  byConstraint: Array<{
    constraintId: string;
    label: string;
    kind: "hard" | "soft";
    topic: ConstraintTopic;
    count: number;
  }>;
}

export interface ScheduleValidation {
  summary: ValidationSummary;
  violations: Violation[];
  score: ScheduleScore;
  /** Which constraints ran. A screen can say what was checked, not just what failed. */
  checked: Array<{ id: string; label: string; kind: "hard" | "soft"; description: string }>;
  evaluatedAt: string;
}

function sortKey(violation: Violation): string {
  const topic = TOPIC_ORDER.indexOf(violation.topic);
  const date = violation.dates.length > 0 ? [...violation.dates].sort()[0] : "9999-99-99";
  return [
    violation.kind === "hard" ? "0" : "1",
    String(topic === -1 ? TOPIC_ORDER.length : topic).padStart(2, "0"),
    violation.constraintId,
    date,
    violation.message,
  ].join("|");
}

export function validateSchedule(snapshot: ScheduleSnapshot): ScheduleValidation {
  const violations: Violation[] = [];

  for (const constraint of CONSTRAINTS) {
    /* A constraint that throws must not take the whole report down with it.
       The alternative — one malformed row in one programme's configuration
       silently producing "no problems found" — is the single worst failure
       this file could have, because it is indistinguishable from a good
       schedule. It is reported as what it is. */
    try {
      violations.push(...constraint.evaluate(snapshot));
    } catch (error) {
      violations.push({
        constraintId: constraint.id,
        kind: "hard",
        topic: constraint.topic,
        label: constraint.label,
        message:
          `${constraint.label} could not be checked on this schedule ` +
          `(${error instanceof Error ? error.message : "unknown error"}). ` +
          "Treat this schedule as unverified until it is looked at.",
        residentIds: [],
        serviceIds: [],
        shiftIds: [],
        dates: [],
      });
    }
  }

  violations.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const hard = violations.filter((v) => v.kind === "hard");
  const soft = violations.filter((v) => v.kind === "soft");

  const counts = new Map<string, number>();
  for (const violation of violations) {
    counts.set(violation.constraintId, (counts.get(violation.constraintId) ?? 0) + 1);
  }

  return {
    summary: {
      valid: hard.length === 0,
      hardCount: hard.length,
      softCount: soft.length,
      byConstraint: CONSTRAINTS.filter((c) => counts.has(c.id)).map((c) => ({
        constraintId: c.id,
        label: c.label,
        kind: c.kind,
        topic: c.topic,
        count: counts.get(c.id) ?? 0,
      })),
    },
    violations,
    score: scoreSchedule(violations),
    checked: CONSTRAINTS.map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      description: c.description,
    })),
    /* From the snapshot's `now`, not from the clock: the report is a statement
       about a snapshot, and two validations of the same snapshot should be
       identical down to the timestamp. */
    evaluatedAt: snapshot.now.toISOString(),
  };
}
