import type {
  ScheduleAssignment,
  ScheduleSnapshot,
  Violation,
} from "@/server/domain/constraints/types";
import type { ScheduleScore } from "@/server/domain/constraints/scoring";

/**
 * The draft schedule generator.
 *
 * Given a programme — its people, cohorts, services, coverage requirements,
 * block structure, availability, eligibility and configured rules — produce a
 * month somebody could actually work, as a **draft**, and hand back a report
 * saying what it managed and what it could not.
 *
 * ## It is graded, not trusted
 *
 * The generator does not get to decide whether its own output is legal. Every
 * run ends by handing the schedule to `validateSchedule`, and a run that
 * produced hard violations is a **failed run** — it reports infeasibility and
 * emits nothing. That is the whole reason the validator was built first: a
 * generator marking its own homework is how a scheduling tool quietly puts one
 * resident in two places for a month.
 *
 * ## It is deterministic
 *
 * Same inputs and same seed, byte-identical output. Every iteration order is
 * explicit, every tie is broken by a stable key, and the only randomness is a
 * seeded generator whose seed is recorded in the result. A scheduler who runs
 * it twice and gets two different schedules cannot tell whether their edit
 * caused the difference, and stops trusting it.
 *
 * ## It is bounded
 *
 * A run has a time budget and returns the best schedule found within it,
 * labelled as such. Scheduling is NP-hard and a search that runs until it is
 * satisfied is a search that never returns.
 */

/** What a schedule cannot touch, and why. */
export type Lock =
  | { kind: "assignment"; shiftId: string }
  | { kind: "resident"; residentId: string }
  | { kind: "cohort"; cohortId: string }
  | { kind: "service"; serviceId: string }
  /** An ISO date in the program's timezone. */
  | { kind: "date"; date: string };

/**
 * One person-shaped hole the schedule has to fill.
 *
 * Expanded from coverage requirements: a requirement asking for three people on
 * weekdays becomes three slots on each weekday. Slots are the unit the
 * generator assigns, and they carry the requirement they came from so a failure
 * can name it.
 */
export interface Slot {
  /** Stable, derived from the slot's own content — never a counter. */
  id: string;
  serviceId: string;
  serviceName: string;
  siteId: string | null;
  requirementId: string;
  requirementLabel: string;
  /** ISO date in the program's timezone. */
  date: string;
  start: Date;
  end: Date;
  shiftType: string;
  /** Set when the slot exists to satisfy a PGY mix entry. */
  requiredPgy: number | null;
  /** The service's own eligibility window, for messages. */
  servicePgyMin: number | null;
  servicePgyMax: number | null;
}

export interface GenerationOptions {
  /** Inclusive ISO dates in the program's timezone. */
  period: { start: string; end: string };
  /** Recorded in the result so a run can be reproduced exactly. */
  seed: number;
  /** Wall-clock milliseconds the search may use. Construction is not counted. */
  timeBudgetMs: number;
  locks: Lock[];
  /**
   * Assignments that already exist and are being kept — the locked ones from a
   * previous draft, plus anything a scheduler placed by hand.
   */
  existing: ScheduleAssignment[];
  /** Overridden by tests that need a fixed clock. */
  now?: Date;
}

/** Why one resident could not take one slot. */
export interface Rejection {
  residentId: string;
  residentName: string;
  /** The constraint that ruled them out. */
  constraintId: string;
  reason: string;
}

export interface UnfilledSlot {
  slot: Slot;
  /** Everybody who was considered, and what stopped each of them. */
  rejections: Rejection[];
}

/**
 * What would have to give.
 *
 * Not "the schedule is impossible" — that tells a chief nothing they can do.
 * The smallest set of constraints whose relaxation would admit a solution, in
 * the words they would use to describe it themselves.
 */
export interface Relaxation {
  constraintIds: string[];
  /** One sentence: what to change, and what it would cost. */
  message: string;
  /** How many slots this relaxation would let the generator fill. */
  slotsRecovered: number;
}

export interface GenerationReport {
  /** Slots the period demanded, and how many were filled. */
  demand: { slots: number; filled: number; locked: number };
  /** Per service: what was asked for and what was covered. */
  coverage: Array<{
    serviceId: string;
    serviceName: string;
    required: number;
    filled: number;
  }>;
  unfilled: UnfilledSlot[];
  /** Present only when the run could not fill everything. */
  relaxations: Relaxation[];
  /** Hard violations in the emitted schedule. Always empty on a successful run. */
  hardViolations: Violation[];
  /** Soft violations, which are advice rather than a reason to refuse. */
  softViolations: Violation[];
  score: ScheduleScore;
  fairness: Array<{
    pgyLevel: number;
    residents: Array<{ residentId: string; name: string; shifts: number; nights: number; weekends: number }>;
  }>;
  /** Assignments a human should look at before publishing, and why. */
  needsReview: Array<{ shiftId: string; residentId: string | null; reason: string }>;
  /** True when the search stopped because the budget ran out, not because it finished. */
  stoppedOnBudget: boolean;
  seed: number;
  elapsedMs: number;
  iterations: number;
}

export interface GenerationResult {
  /** `false` means nothing is emitted and `report.relaxations` says what would help. */
  feasible: boolean;
  /**
   * The generated schedule, as assignments. Empty when infeasible — a
   * generator that emits a partial schedule alongside "this did not work" is a
   * generator whose output gets published by somebody in a hurry.
   */
  assignments: ScheduleAssignment[];
  report: GenerationReport;
}

/**
 * Everything the generator reads, which is exactly what the validator reads.
 *
 * Deliberately the same type. The generator and its grader disagreeing about
 * what the programme looks like is the one failure mode neither could detect.
 */
export type GenerationInput = ScheduleSnapshot;
