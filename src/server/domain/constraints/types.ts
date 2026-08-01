import type { RuleRow } from "@/server/db/types";
import type { CoverageRequirement } from "@/server/domain/coverage";

/**
 * The constraint model: what makes a schedule valid, said once.
 *
 * Every scheduling constraint the configuration can express lives in one
 * catalogue, and each one declares whether it is HARD — a schedule that
 * violates it is wrong and must not be published — or SOFT, a preference that
 * is scored rather than enforced. Nothing else in the product gets to have an
 * opinion about that distinction.
 *
 * ## Why this is pure
 *
 * A constraint evaluates over a `ScheduleSnapshot` handed to it. It opens no
 * connection, issues no query and reads no clock it was not given. Three
 * consequences, all of them the point:
 *
 *   - the whole model runs under `npm run verify:fast`, in milliseconds;
 *   - a failing test names a constraint rather than a fixture;
 *   - the same code validates a draft, a published schedule, an imported file
 *     and a schedule that exists only as a proposal in memory.
 *
 * Loading a snapshot from the database is `snapshot.ts`, and it is the only
 * impure file in this directory.
 *
 * ## Why constraints call the rules engine
 *
 * Rest, consecutive days, consecutive nights, rolling workload, weekend caps,
 * overlaps, PGY ranges, service eligibility and credentials are already
 * modelled by `src/server/domain/rules/`, configured per programme in the
 * `rules` table, and already tested. A second implementation here would be a
 * second set of numbers to keep in step, and the first time they disagreed the
 * product would be telling a resident one thing and a chief another.
 *
 * So those constraints call the handler and translate its verdict. What they do
 * not reuse is the *wording*: a rule speaks to somebody about to make a trade
 * ("this would leave only 6 hours"), and the validator speaks to a chief
 * reading a schedule that already says something ("has 6 hours between…").
 */

export type ConstraintKind = "hard" | "soft";

/**
 * What the constraint is about — used to group violations for a reader, and to
 * keep the score's breakdown legible.
 */
export type ConstraintTopic =
  | "coverage"
  | "availability"
  | "eligibility"
  | "structure"
  | "safety"
  | "workload"
  | "fairness"
  | "preference"
  | "continuity"
  | "change";

// ---------------------------------------------------------------------------
// The data a constraint sees
// ---------------------------------------------------------------------------

/** One shift in the schedule under test, with whoever holds it. */
export interface ScheduleAssignment {
  shiftId: string;
  /** `null` means the shift exists and nobody is on it. */
  residentId: string | null;
  serviceId: string;
  serviceName: string;
  siteId: string | null;
  siteName: string | null;
  rotationId: string | null;
  rotationName: string | null;
  shiftType: string;
  start: Date;
  end: Date;
  location: string;
  requiredPgyMin: number;
  requiredPgyMax: number;
  status: string;
}

/**
 * A recorded absence: a range, a kind, and whether it is binding.
 *
 * Structured availability as the constraint model sees it. `person.ts` merges
 * these into the same lists the jsonb columns feed, so no constraint reads this
 * type directly except to say *why* somebody is unavailable in a message.
 */
export interface ScheduleAbsence {
  id: string;
  kind: string;
  /** How it reads in a sentence: "on vacation", "at a conference". */
  label: string;
  /** Inclusive ISO dates in the program's timezone. */
  startDate: string;
  endDate: string;
  hard: boolean;
}

/**
 * Per-person facts a schedule has to respect.
 *
 * `constraints` and `preferences` are the two jsonb columns on `residents`.
 * Their shape is documented in `person.ts` — they are read through accessors
 * rather than inline so an unexpected value is ignored rather than throwing
 * inside a constraint.
 */
export interface ScheduleResident {
  id: string;
  name: string;
  /**
   * Read only by the generator, which has to express its output as the same
   * flat records an imported spreadsheet produces, and those are keyed by
   * address. No constraint reads it, and it never leaves the server.
   */
  email: string;
  pgyLevel: number;
  credentials: string[];
  active: boolean;
  schedulable: boolean;
  schedulingNotes: string;
  cohortId: string | null;
  cohortLabel: string | null;
  /** Site id -> may work there. A site with no entry is unrestricted. */
  siteEligibility: Record<string, boolean>;
  constraints: Record<string, unknown>;
  preferences: Record<string, unknown>;
  /**
   * Absences overlapping the period under test. Optional so that a fixture
   * built by hand — and every test written before structured availability
   * existed — stays valid.
   */
  absences?: ScheduleAbsence[];
}

export interface ScheduleService {
  id: string;
  name: string;
  siteId: string | null;
  pgyMin: number | null;
  pgyMax: number | null;
  coverageMandatory: boolean;
  active: boolean;
  /**
   * How long a shift on this service usually runs. Read by the generator when
   * a coverage requirement names no time band; no constraint reads it, because
   * how long a shift *usually* is says nothing about whether a schedule that
   * exists is legal.
   */
  typicalShiftHours: number | null;
}

export interface ScheduleBlock {
  id: string;
  sequence: number;
  label: string;
  kind: string;
  /** ISO dates in the program's timezone. */
  startDate: string;
  endDate: string;
}

/** What a cohort is meant to be doing in a block. */
export interface ScheduleBlockAssignment {
  cohortId: string;
  blockId: string;
  serviceId: string | null;
  label: string;
}

/** One person doing something other than their cohort, for one block. */
export interface ScheduleOverride {
  residentId: string;
  blockId: string;
  serviceId: string | null;
  label: string;
  reason: string;
}

/**
 * Everything a constraint may look at.
 *
 * `now` is passed in rather than read, because a validator whose answer depends
 * on the wall clock is a validator whose tests are flaky and whose results
 * cannot be compared between two runs.
 */
export interface ScheduleSnapshot {
  program: {
    id: string;
    name: string;
    timezone: string;
  };
  now: Date;
  /** The window under test. Coverage is only checked inside it. */
  period: { start: string; end: string };
  assignments: ScheduleAssignment[];
  residents: ScheduleResident[];
  services: ScheduleService[];
  coverage: CoverageRequirement[];
  blocks: ScheduleBlock[];
  blockAssignments: ScheduleBlockAssignment[];
  overrides: ScheduleOverride[];
  rules: RuleRow[];
  /**
   * The schedule this one would replace, when there is one. Only
   * `minimise-change` reads it; everything else validates the schedule on its
   * own terms, because a schedule is not more or less legal for what came
   * before it.
   */
  baseline?: ScheduleAssignment[];
}

// ---------------------------------------------------------------------------
// What a constraint produces
// ---------------------------------------------------------------------------

/**
 * One thing wrong with the schedule.
 *
 * Carries the people, services and dates involved as ids *and* as a sentence,
 * because the two have different readers: the ids let a screen link to the
 * shift, and the sentence is what a chief actually reads at half past eleven.
 */
export interface Violation {
  constraintId: string;
  kind: ConstraintKind;
  topic: ConstraintTopic;
  /** The constraint's own name, for grouping. */
  label: string;
  message: string;
  residentIds: string[];
  serviceIds: string[];
  shiftIds: string[];
  /** ISO dates in the program's timezone. */
  dates: string[];
  /** Set when the constraint came from a configured rule row. */
  ruleId?: string;
  /**
   * For soft constraints: how badly, from 0 (not at all) to 1 (as bad as this
   * constraint gets). Hard violations do not have degrees.
   */
  penalty?: number;
}

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  topic: ConstraintTopic;
  label: string;
  /** One sentence, shown next to the constraint in the interface. */
  description: string;
  /**
   * Soft constraints only: how much this objective counts in the score
   * relative to the others. Ignored for hard constraints.
   */
  weight?: number;
  evaluate: (snapshot: ScheduleSnapshot) => Violation[];
}
