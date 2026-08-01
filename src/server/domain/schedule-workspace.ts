import { query } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { loadScheduleSnapshot } from "./constraints/snapshot";
import { coverageCells } from "./constraints/hard";
import { validateSchedule } from "./constraints/validator";
import type { ScheduleValidation } from "./constraints/validator";
import { assignmentDate, dayFromIso } from "./constraints/shared";
import { effectiveMinimum } from "./coverage";
import { listLocks, type ScheduleLock } from "./schedule-locks";
import { addLocalDays, localDateString, localDayDiff } from "./time";

/**
 * The scheduler's working surface: one payload, everything the screen needs.
 *
 * A scheduler builds a month by looking at a grid — services down the side,
 * days across the top — and asking three questions over and over: *is this day
 * covered*, *is anything wrong with this cell*, and *who else could do it*. The
 * dashboard answers none of those, and the draft editor answers only the third.
 *
 * ## Why one payload rather than five endpoints
 *
 * The heat map, the conflict highlighting, the unfilled queue and the coverage
 * report are four presentations of **two** computations: the coverage cells and
 * the validator's violations. Computing them once and slicing them four ways is
 * not an optimisation — it is what stops the grid saying a cell is fine while
 * the report below it says the same cell is short. Four endpoints computing the
 * same thing is four chances to disagree.
 *
 * ## Nothing here is a second implementation
 *
 * `coverageCells` is the validator's own generator, exported rather than
 * copied, and every problem in the report is a `Violation` the validator
 * produced. If the report and the check ever disagreed, a chief would believe
 * whichever they read second.
 */

export type CellState = "under" | "met" | "over" | "empty";

export interface CoverageCell {
  serviceId: string;
  serviceName: string;
  /** ISO date in the program's timezone. */
  date: string;
  requirementLabel: string;
  required: number;
  /** Distinct people, not rows — one person cannot cover two places at once. */
  present: number;
  cap: number | null;
  state: CellState;
}

export interface WorkspaceShift {
  id: string;
  serviceId: string;
  serviceName: string;
  siteId: string | null;
  siteName: string | null;
  date: string;
  start: string;
  end: string;
  shiftType: string;
  residentId: string | null;
  residentName: string | null;
  pgyLevel: number | null;
  cohortId: string | null;
  cohortLabel: string | null;
  locked: boolean;
  lockReason: string;
  /** Every violation touching this shift, already worded for a reader. */
  problems: Array<{ kind: "hard" | "soft"; message: string }>;
}

/**
 * Coverage management, grouped the way somebody fixing a month thinks about it.
 *
 * Each list is a slice of the validator's output. The grouping is the value:
 * "seventeen coverage-minimum violations" is a number, and "MICU is short on
 * these four days, and these two people are over their limit" is a morning's
 * work with an order to it.
 */
export interface CoverageReport {
  underCovered: CoverageCell[];
  overCovered: CoverageCell[];
  /** Dates inside the period with nobody on anything at all. */
  uncoveredDates: string[];
  missingPgy: Array<{ message: string; dates: string[]; serviceIds: string[] }>;
  excessiveWorkload: Array<{ message: string; residentIds: string[] }>;
  problematicAssignments: Array<{
    message: string;
    shiftIds: string[];
    residentIds: string[];
  }>;
  score: number;
  hardCount: number;
  softCount: number;
}

export interface WorkspaceHistoryEntry {
  at: Date;
  actor: string;
  action: string;
  detail: string;
}

export interface Workspace {
  /** Null when the live schedule is being looked at rather than a draft. */
  versionId: string | null;
  editable: boolean;
  period: { start: string; end: string };
  dates: string[];
  shifts: WorkspaceShift[];
  cells: CoverageCell[];
  services: Array<{ id: string; name: string; siteId: string | null; siteName: string | null }>;
  residents: Array<{
    id: string;
    name: string;
    pgyLevel: number;
    cohortId: string | null;
    cohortLabel: string | null;
    schedulable: boolean;
    shifts: number;
  }>;
  sites: Array<{ id: string; name: string }>;
  cohorts: Array<{ id: string; label: string }>;
  locks: ScheduleLock[];
  /** Coverage cells that are short, worst first — the queue to work through. */
  unfilled: CoverageCell[];
  report: CoverageReport;
  history: WorkspaceHistoryEntry[];
  validation: ScheduleValidation;
}

/**
 * Which constraints belong in which section of the coverage report.
 *
 * A map rather than a chain of string tests, and by **topic** rather than by
 * constraint id wherever the topic says the right thing — so a constraint added
 * to the catalogue tomorrow lands in a section rather than disappearing from
 * the report. The two ids named explicitly are the ones whose topic is
 * "coverage" but whose meaning is a PGY mix rather than a headcount.
 */
const PGY_CONSTRAINTS = new Set(["coverage-pgy-mix", "service-pgy-eligibility"]);

/**
 * The longest window this screen will build.
 *
 * A quarter and a bit: long enough for any block a programme actually
 * schedules, short enough that the grid stays a grid rather than a thousand
 * columns nobody can scroll.
 */
const MAX_WORKSPACE_DAYS = 120;

export interface WorkspaceOptions {
  versionId?: string | null;
  period?: { start: string; end: string };
  now?: Date;
}

export async function loadWorkspace(
  context: AuthedContext,
  options: WorkspaceOptions = {},
): Promise<Workspace> {
  const versionId = options.versionId ?? null;
  const program = {
    id: context.program.id,
    name: context.program.name,
    timezone: context.program.timezone,
  };

  const period = options.period ?? (await periodFor(context, versionId));

  const snapshot = await loadScheduleSnapshot(program, {
    period,
    versionId,
    withBaseline: Boolean(versionId),
    now: options.now,
  });
  const validation = validateSchedule(snapshot);

  const [locks, history, editable] = await Promise.all([
    versionId ? listLocks(context.program.id, versionId) : Promise.resolve([]),
    loadHistory(context.program.id, versionId),
    isEditable(context.program.id, versionId),
  ]);

  /* Locked *things*, flattened to the set of shifts a lock protects. The screen
     needs a padlock per cell; which of the five kinds put it there is the
     lock's own row, shown when somebody asks. */
  const lockedShiftIds = new Set<string>();
  const lockedResidents = new Set(
    locks.filter((l) => l.kind === "resident").map((l) => l.target_id),
  );
  const lockedCohorts = new Set(
    locks.filter((l) => l.kind === "cohort").map((l) => l.target_id),
  );
  const lockedServices = new Set(
    locks.filter((l) => l.kind === "service").map((l) => l.target_id),
  );
  const lockedDates = new Set(
    locks.filter((l) => l.kind === "date").map((l) => l.target_date),
  );
  const lockedAssignments = new Set(
    locks
      .filter((l) => l.kind === "assignment")
      .map((l) => `${l.target_id}|${l.target_date}`),
  );

  const residentById = new Map(snapshot.residents.map((r) => [r.id, r]));

  /* Violations indexed by shift, so a cell can be tinted without the screen
     scanning the whole list per cell. */
  const problemsByShift = new Map<string, Array<{ kind: "hard" | "soft"; message: string }>>();
  for (const violation of validation.violations) {
    for (const shiftId of violation.shiftIds) {
      const list = problemsByShift.get(shiftId) ?? [];
      list.push({ kind: violation.kind, message: violation.message });
      problemsByShift.set(shiftId, list);
    }
  }

  const shifts: WorkspaceShift[] = snapshot.assignments.map((assignment) => {
    const date = assignmentDate(assignment, program.timezone);
    const resident = assignment.residentId
      ? residentById.get(assignment.residentId)
      : undefined;
    const locked =
      lockedShiftIds.has(assignment.shiftId) ||
      lockedDates.has(date) ||
      lockedServices.has(assignment.serviceId) ||
      (resident ? lockedResidents.has(resident.id) : false) ||
      (resident?.cohortId ? lockedCohorts.has(resident.cohortId) : false) ||
      (resident ? lockedAssignments.has(`${resident.id}|${date}`) : false);

    return {
      id: assignment.shiftId,
      serviceId: assignment.serviceId,
      serviceName: assignment.serviceName,
      siteId: assignment.siteId,
      siteName: assignment.siteName,
      date,
      start: assignment.start.toISOString(),
      end: assignment.end.toISOString(),
      shiftType: assignment.shiftType,
      residentId: assignment.residentId,
      residentName: resident?.name ?? null,
      pgyLevel: resident?.pgyLevel ?? null,
      cohortId: resident?.cohortId ?? null,
      cohortLabel: resident?.cohortLabel ?? null,
      locked,
      lockReason: locked ? lockReasonFor(locks, assignment.serviceId, date, resident?.id, resident?.cohortId) : "",
      problems: problemsByShift.get(assignment.shiftId) ?? [],
    };
  });

  const cells: CoverageCell[] = [];
  for (const cell of coverageCells(snapshot)) {
    const required = effectiveMinimum(cell.requirement);
    const cap = cell.requirement.max_staff;
    cells.push({
      serviceId: cell.service.id,
      serviceName: cell.service.name,
      date: cell.iso,
      requirementLabel: cell.requirement.label,
      required,
      present: cell.distinct,
      cap,
      state:
        cell.distinct === 0 && required > 0
          ? "empty"
          : cell.distinct < required
            ? "under"
            : cap != null && cell.distinct > cap
              ? "over"
              : "met",
    });
  }

  const shiftsPerResident = new Map<string, number>();
  for (const shift of shifts) {
    if (!shift.residentId) continue;
    shiftsPerResident.set(
      shift.residentId,
      (shiftsPerResident.get(shift.residentId) ?? 0) + 1,
    );
  }

  const siteById = new Map<string, string>();
  for (const assignment of snapshot.assignments) {
    if (assignment.siteId && assignment.siteName) {
      siteById.set(assignment.siteId, assignment.siteName);
    }
  }

  const cohortById = new Map<string, string>();
  for (const resident of snapshot.residents) {
    if (resident.cohortId && resident.cohortLabel) {
      cohortById.set(resident.cohortId, resident.cohortLabel);
    }
  }

  return {
    versionId,
    editable,
    period,
    dates: [...new Set(cells.map((cell) => cell.date))].sort(),
    shifts,
    cells,
    services: snapshot.services
      .filter((service) => service.active)
      .map((service) => ({
        id: service.id,
        name: service.name,
        siteId: service.siteId,
        siteName: service.siteId ? (siteById.get(service.siteId) ?? null) : null,
      })),
    residents: snapshot.residents
      .filter((resident) => resident.active)
      .map((resident) => ({
        id: resident.id,
        name: resident.name,
        pgyLevel: resident.pgyLevel,
        cohortId: resident.cohortId,
        cohortLabel: resident.cohortLabel,
        schedulable: resident.schedulable,
        shifts: shiftsPerResident.get(resident.id) ?? 0,
      })),
    sites: [...siteById.entries()].map(([id, name]) => ({ id, name })),
    cohorts: [...cohortById.entries()].map(([id, label]) => ({ id, label })),
    locks,
    /* Worst first: the emptiest cell is the one that leaves a ward with nobody
       on it, and a queue sorted by date would bury it behind eleven cells that
       are one person short. */
    unfilled: cells
      .filter((cell) => cell.state === "under" || cell.state === "empty")
      .sort((a, b) => b.required - b.present - (a.required - a.present) || a.date.localeCompare(b.date)),
    report: buildReport(cells, validation),
    history,
    validation,
  };
}

function lockReasonFor(
  locks: ScheduleLock[],
  serviceId: string,
  date: string,
  residentId: string | undefined,
  cohortId: string | null | undefined,
): string {
  const match = locks.find(
    (lock) =>
      (lock.kind === "service" && lock.target_id === serviceId) ||
      (lock.kind === "date" && lock.target_date === date) ||
      (lock.kind === "resident" && lock.target_id === residentId) ||
      (lock.kind === "cohort" && lock.target_id === cohortId) ||
      (lock.kind === "assignment" &&
        lock.target_id === residentId &&
        lock.target_date === date),
  );
  if (!match) return "";
  return match.reason || `Locked (${match.kind}).`;
}

function buildReport(
  cells: CoverageCell[],
  validation: ScheduleValidation,
): CoverageReport {
  const hard = validation.violations.filter((v) => v.kind === "hard");

  /* A date is uncovered when every requirement on it is empty. Distinct from
     "under-covered": a day with nobody on anything is a day the hospital has
     nobody, and it belongs at the top of any list it appears in. */
  const byDate = new Map<string, CoverageCell[]>();
  for (const cell of cells) {
    const list = byDate.get(cell.date) ?? [];
    list.push(cell);
    byDate.set(cell.date, list);
  }
  const uncoveredDates = [...byDate.entries()]
    .filter(
      ([, list]) =>
        list.length > 0 && list.every((cell) => cell.present === 0 && cell.required > 0),
    )
    .map(([date]) => date)
    .sort();

  const inTopic = (topics: string[]) =>
    validation.violations.filter(
      (violation) =>
        topics.includes(violation.topic) && !PGY_CONSTRAINTS.has(violation.constraintId),
    );

  return {
    underCovered: cells.filter((cell) => cell.state === "under" || cell.state === "empty"),
    overCovered: cells.filter((cell) => cell.state === "over"),
    uncoveredDates,
    missingPgy: validation.violations
      .filter((violation) => PGY_CONSTRAINTS.has(violation.constraintId))
      .map((violation) => ({
        message: violation.message,
        dates: violation.dates,
        serviceIds: violation.serviceIds,
      })),
    excessiveWorkload: inTopic(["workload", "safety"]).map((violation) => ({
      message: violation.message,
      residentIds: violation.residentIds,
    })),
    /* Somebody scheduled who should not be: unavailable, ineligible, on leave,
       in two places. Deliberately hard-only — a soft eligibility preference is
       not a "problematic assignment", it is a wish that was not honoured. */
    problematicAssignments: hard
      .filter((violation) =>
        ["availability", "eligibility", "structure"].includes(violation.topic),
      )
      .map((violation) => ({
        message: violation.message,
        shiftIds: violation.shiftIds,
        residentIds: violation.residentIds,
      })),
    score: validation.score.score,
    hardCount: validation.summary.hardCount,
    softCount: validation.summary.softCount,
  };
}

async function periodFor(
  context: AuthedContext,
  versionId: string | null,
): Promise<{ start: string; end: string }> {
  if (versionId) {
    const rows = await query<{ start: string; end: string }>(
      `SELECT period_start::text AS start, period_end::text AS end
         FROM schedule_versions WHERE id = $1 AND program_id = $2`,
      [versionId, context.program.id],
    );
    if (rows[0]) {
      /* The draft's **declared** period, not the span of the shifts in it.
         The difference is the whole point of this screen: a Tuesday with no
         shifts at all is a Tuesday nobody is covering, and clamping to where
         shifts happen to exist would hide exactly the gap somebody came here
         to find.

         The cap is the safety valve. A draft declared over "everything, ever"
         is a legitimate way to copy the whole schedule, and validating 1,900
         days of nothing on every keystroke is how this screen's predecessor
         started resetting the connection. Past the cap the window falls back to
         where the shifts actually are, which for that draft is the only useful
         answer anyway. */
      const declaredDays = localDayDiff(rows[0].start, rows[0].end) + 1;
      if (declaredDays <= MAX_WORKSPACE_DAYS) {
        return { start: rows[0].start, end: rows[0].end };
      }

      const span = await query<{ start: string | null; end: string | null }>(
        `SELECT min(date)::text AS start, max(date)::text AS end
           FROM shifts WHERE schedule_version_id = $1`,
        [versionId],
      );
      const start = span[0]?.start ?? rows[0].start;
      const end = span[0]?.end ?? rows[0].end;
      const clampedEnd = addLocalDays(start, MAX_WORKSPACE_DAYS - 1);
      return { start, end: end < clampedEnd ? end : clampedEnd };
    }
  }

  const today = localDateString(new Date(), context.program.timezone);
  const rows = await query<{ end: string | null }>(
    `SELECT max(date)::text AS end FROM shifts
      WHERE program_id = $1 AND schedule_version_id IS NULL AND date >= $2::date`,
    [context.program.id, today],
  );
  const last = rows[0]?.end ?? today;
  const cap = addLocalDays(today, MAX_WORKSPACE_DAYS - 1);
  return { start: today, end: last < cap ? last : cap };
}

async function isEditable(programId: string, versionId: string | null): Promise<boolean> {
  if (!versionId) return false;
  const rows = await query<{ status: string }>(
    `SELECT status::text AS status FROM schedule_versions
      WHERE id = $1 AND program_id = $2`,
    [versionId, programId],
  );
  return rows[0]?.status === "draft";
}

/**
 * What has been done to this schedule, and by whom.
 *
 * Read from the audit log rather than kept separately, because the audit log is
 * already the record and a second one would be a second thing to keep in step.
 * Scoped to the version so the panel is about *this* schedule; for the live
 * schedule it is every correction made to it.
 */
async function loadHistory(
  programId: string,
  versionId: string | null,
): Promise<WorkspaceHistoryEntry[]> {
  const rows = await query<{
    created_at: Date;
    actor_label: string | null;
    action: string;
    reason: string | null;
    new_state: Record<string, unknown> | null;
  }>(
    versionId
      ? `SELECT created_at, actor_label, action, reason, new_state
           FROM audit_logs
          WHERE program_id = $1 AND entity_id = $2
          ORDER BY created_at DESC LIMIT 100`
      : `SELECT created_at, actor_label, action, reason, new_state
           FROM audit_logs
          WHERE program_id = $1 AND action IN ('schedule.corrected', 'shift.reassigned',
                                               'shift.updated', 'schedule_version.published')
          ORDER BY created_at DESC LIMIT 100`,
    versionId ? [programId, versionId] : [programId],
  );

  return rows.map((row) => ({
    at: row.created_at,
    actor: row.actor_label ?? "somebody",
    action: row.action,
    detail: row.reason ?? describeState(row.new_state),
  }));
}

function describeState(state: Record<string, unknown> | null): string {
  if (!state) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.slice(0, 4).join(" · ");
}

/** "Mon, Aug 10", for a screen that has an ISO date and needs a day. */
export { dayFromIso as workspaceDayLabel };
