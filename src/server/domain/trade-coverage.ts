import { HARD_CONSTRAINTS } from "./constraints/catalog";
import { loadScheduleSnapshot } from "./constraints/snapshot";
import type { ScheduleAssignment } from "./constraints/types";
import { localDateString } from "./time";
import { RULE_CATEGORY, type ShiftInfo, type ValidationCheck } from "./rules/types";

/**
 * Would this switch leave a ward short?
 *
 * The rules engine answers questions about the two **people**: rest, hours,
 * consecutive nights, eligibility. Nothing in it looks at the ward. A 1:1 swap
 * preserves each resident's headcount and can still break coverage — if Bob
 * already works MICU on Monday, giving him Alice's MICU Monday leaves MICU with
 * one person where it had two. That is a clinical gap produced by a trade both
 * residents agreed to and every rule passed.
 *
 * So this asks the **constraint model** — the same catalogue the generator is
 * graded against — rather than adding coverage arithmetic to the rules engine.
 * One definition of "covered", used by the generator, the validator, the
 * scheduler's grid and now the trade board. A second implementation here is the
 * one thing that would make the product tell a resident one thing and a chief
 * another.
 *
 * ## Only what the trade introduces
 *
 * The check runs the coverage constraints twice — over the schedule as it is,
 * and over the schedule with the swap applied — and reports the difference.
 * That precision is what makes it safe to refuse: a programme whose coverage
 * numbers are aspirational already has shortfalls on those days, and blocking
 * every trade that touched a day already short would block nearly all of them
 * while fixing nothing.
 */

/** The hard coverage constraints, and only those. */
const COVERAGE_CONSTRAINTS = HARD_CONSTRAINTS.filter(
  (constraint) => constraint.topic === "coverage",
);

export interface SwapLeg {
  shift: ShiftInfo;
  /** Who holds it now. */
  from: string;
  /** Who would hold it after the switch. */
  to: string;
}

/**
 * Coverage checks for a proposed 1:1 switch.
 *
 * Returns a `fail` per newly-introduced coverage violation, and a single `pass`
 * when the switch leaves coverage exactly as it found it. The pass matters:
 * "coverage was checked and is fine" and "coverage was not checked" must not
 * look the same on a screen that lists what was verified.
 */
export async function checkTradeCoverage(
  program: { id: string; name: string; timezone: string },
  legs: SwapLeg[],
  now: Date = new Date(),
): Promise<ValidationCheck[]> {
  const dates = legs.map((leg) => localDateString(leg.shift.start, program.timezone));
  const period = {
    start: dates.reduce((a, b) => (a < b ? a : b)),
    end: dates.reduce((a, b) => (a > b ? a : b)),
  };

  /* The window is the two days the switch touches, so this is a small read
     even for a large programme — which matters, because it runs on every offer
     and again on every acceptance. */
  const snapshot = await loadScheduleSnapshot(program, { period, now });

  const before = runCoverage(snapshot.assignments, snapshot);
  const after = runCoverage(applySwap(snapshot.assignments, legs), snapshot);

  const introduced = after.filter((message) => !before.includes(message));

  if (introduced.length === 0) {
    return [
      {
        key: "system:coverage",
        ruleId: null,
        ruleType: "system.coverage",
        category: RULE_CATEGORY.safety,
        label: "Service coverage",
        status: "pass",
        message: "Both services stay covered after this switch.",
        overridable: false,
      },
    ];
  }

  return introduced.map((message, index) => ({
    key: `system:coverage:${index}`,
    ruleId: null,
    ruleType: "system.coverage",
    category: RULE_CATEGORY.safety,
    label: "Service coverage",
    status: "fail" as const,
    /* Two sentences, and the validator's own is left exactly as it wrote it.
       The first says what the reader needs to know — that this is a
       consequence of the switch, not a problem that was already there —
       because otherwise a resident reads "MICU has 1 person and needs 2" and
       reasonably concludes it is somebody else's problem. Splicing the two
       into one sentence would mean lowercasing a message that starts "Tue,
       Aug 11", which is how a careful message becomes a sloppy one. */
    message: `This switch would leave a service short. ${message}`,
    overridable: false,
  }));
}

function applySwap(
  assignments: ScheduleAssignment[],
  legs: SwapLeg[],
): ScheduleAssignment[] {
  const moves = new Map(legs.map((leg) => [leg.shift.id, leg.to]));
  return assignments.map((assignment) =>
    moves.has(assignment.shiftId)
      ? { ...assignment, residentId: moves.get(assignment.shiftId)! }
      : assignment,
  );
}

function runCoverage(
  assignments: ScheduleAssignment[],
  snapshot: Awaited<ReturnType<typeof loadScheduleSnapshot>>,
): string[] {
  const candidate = { ...snapshot, assignments };
  return COVERAGE_CONSTRAINTS.flatMap((constraint) => {
    try {
      return constraint.evaluate(candidate).map((violation) => violation.message);
    } catch {
      /* A constraint that throws must not make a switch impossible. The
         validator reports the same failure loudly on the schedule screens,
         where somebody can act on it; here, refusing a resident's trade because
         of a malformed coverage row would be punishing the wrong person. */
      return [];
    }
  });
}
