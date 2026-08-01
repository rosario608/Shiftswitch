import { query } from "@/server/db/pool";
import type { RuleRow } from "@/server/db/types";
import { listBlockStructures, listBlocks } from "@/server/domain/blocks";
import { listBlockAssignments, listResidentOverrides } from "@/server/domain/cohorts";
import { listCoverage } from "@/server/domain/coverage";
import { localDateString } from "@/server/domain/time";
import type {
  ScheduleAssignment,
  ScheduleResident,
  ScheduleService,
  ScheduleSnapshot,
} from "./types";

/**
 * The only impure file in this directory.
 *
 * Everything the validator needs, read once and handed over as plain data. The
 * split exists so that the constraint model can be tested without a database
 * and reasoned about without a schema in front of you — and so a failing
 * constraint test names a constraint rather than a fixture.
 *
 * It also means the same validator runs over a schedule that is not in the
 * database at all: an uploaded file being previewed, a proposal held in
 * memory, a draft two screens from being saved. Nothing here is required for
 * any of those; they build a snapshot and call `validateSchedule` directly.
 */

interface AssignmentRow {
  shift_id: string;
  resident_id: string | null;
  service_id: string;
  service_name: string;
  site_id: string | null;
  site_name: string | null;
  rotation_id: string | null;
  rotation_name: string | null;
  shift_type: string;
  start_datetime: Date;
  end_datetime: Date;
  location: string;
  required_pgy_min: number;
  required_pgy_max: number;
  status: string;
}

interface ResidentRow {
  id: string;
  name: string;
  pgy_level: number;
  credentials: string[];
  active: boolean;
  schedulable: boolean;
  scheduling_notes: string;
  cohort_id: string | null;
  cohort_label: string | null;
  preferences: Record<string, unknown>;
  constraints: Record<string, unknown>;
}

interface ServiceRow {
  id: string;
  name: string;
  site_id: string | null;
  pgy_min: number | null;
  pgy_max: number | null;
  coverage_mandatory: boolean;
  active: boolean;
}

export interface SnapshotOptions {
  /** Inclusive ISO dates in the program's timezone. */
  period: { start: string; end: string };
  /**
   * A draft to validate instead of the published schedule. Omitted means the
   * live schedule.
   */
  versionId?: string | null;
  /**
   * Compare against the published schedule for the same window, which is what
   * makes `minimise-change` meaningful. Only sensible for a draft.
   */
  withBaseline?: boolean;
  /** Overridden only by tests that need a fixed clock. */
  now?: Date;
}

async function loadAssignments(
  programId: string,
  period: { start: string; end: string },
  versionId: string | null,
): Promise<AssignmentRow[]> {
  return query<AssignmentRow>(
    `SELECT s.id AS shift_id, a.resident_id, s.service_id, sv.name AS service_name,
            sv.site_id, si.name AS site_name, s.rotation_id, r.name AS rotation_name,
            s.shift_type, s.start_datetime, s.end_datetime, s.location,
            s.required_pgy_min, s.required_pgy_max, s.status::text AS status
       FROM shifts s
       JOIN services sv ON sv.id = s.service_id
       LEFT JOIN sites si ON si.id = sv.site_id
       LEFT JOIN rotations r ON r.id = s.rotation_id
       LEFT JOIN shift_assignments a
         ON a.shift_id = s.id AND a.assignment_status = 'active'
      WHERE s.program_id = $1
        AND s.date >= $2::date AND s.date <= $3::date
        AND s.schedule_version_id IS NOT DISTINCT FROM $4::uuid
      ORDER BY s.start_datetime, sv.name`,
    [programId, period.start, period.end, versionId],
  );
}

function toAssignment(row: AssignmentRow): ScheduleAssignment {
  return {
    shiftId: row.shift_id,
    residentId: row.resident_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    siteId: row.site_id,
    siteName: row.site_name,
    rotationId: row.rotation_id,
    rotationName: row.rotation_name,
    shiftType: row.shift_type,
    start: row.start_datetime,
    end: row.end_datetime,
    location: row.location,
    requiredPgyMin: row.required_pgy_min,
    requiredPgyMax: row.required_pgy_max,
    status: row.status,
  };
}

export async function loadScheduleSnapshot(
  program: { id: string; name: string; timezone: string },
  options: SnapshotOptions,
): Promise<ScheduleSnapshot> {
  const versionId = options.versionId ?? null;

  const [
    assignments,
    residents,
    services,
    coverage,
    rules,
    structures,
    eligibility,
  ] = await Promise.all([
    loadAssignments(program.id, options.period, versionId),
    query<ResidentRow>(
      `SELECT r.id, u.full_name AS name, r.pgy_level, r.credentials, r.active,
              r.schedulable, r.scheduling_notes, c.id AS cohort_id,
              c.label AS cohort_label, r.preferences, r.constraints
         FROM residents r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN cohort_members m ON m.resident_id = r.id
         LEFT JOIN cohorts c ON c.id = m.cohort_id AND c.active = true
        WHERE r.program_id = $1
        ORDER BY r.pgy_level, u.full_name`,
      [program.id],
    ),
    query<ServiceRow>(
      `SELECT id, name, site_id, pgy_min, pgy_max, coverage_mandatory, active
         FROM services WHERE program_id = $1 ORDER BY name`,
      [program.id],
    ),
    listCoverage(program.id),
    query<RuleRow>(
      "SELECT * FROM rules WHERE program_id = $1 AND active = true",
      [program.id],
    ),
    listBlockStructures(program.id),
    query<{ resident_id: string; site_id: string; eligible: boolean }>(
      `SELECT e.resident_id, e.site_id, e.eligible
         FROM resident_site_eligibility e
         JOIN residents r ON r.id = e.resident_id
        WHERE r.program_id = $1`,
      [program.id],
    ),
  ]);

  /* The current structure only. A programme mid-way through building next
     year's blocks has two, and validating this August against next August's
     structure would report the whole month as being on the wrong service. */
  const structure = structures.find((s) => s.active) ?? structures[0] ?? null;
  const [blocks, blockAssignments, overrides] = structure
    ? await Promise.all([
        listBlocks(program.id, structure.id),
        listBlockAssignments(program.id, structure.id),
        listResidentOverrides(program.id, structure.id),
      ])
    : [[], [], []];

  const eligibilityByResident = new Map<string, Record<string, boolean>>();
  for (const row of eligibility) {
    const forResident = eligibilityByResident.get(row.resident_id) ?? {};
    forResident[row.site_id] = row.eligible;
    eligibilityByResident.set(row.resident_id, forResident);
  }

  const baseline =
    options.withBaseline && versionId
      ? (await loadAssignments(program.id, options.period, null)).map(toAssignment)
      : undefined;

  return {
    program,
    now: options.now ?? new Date(),
    period: options.period,
    assignments: assignments.map(toAssignment),
    residents: residents.map(
      (row): ScheduleResident => ({
        id: row.id,
        name: row.name,
        pgyLevel: row.pgy_level,
        credentials: row.credentials ?? [],
        active: row.active,
        schedulable: row.schedulable,
        schedulingNotes: row.scheduling_notes,
        cohortId: row.cohort_id,
        cohortLabel: row.cohort_label,
        siteEligibility: eligibilityByResident.get(row.id) ?? {},
        constraints: row.constraints ?? {},
        preferences: row.preferences ?? {},
      }),
    ),
    services: services.map(
      (row): ScheduleService => ({
        id: row.id,
        name: row.name,
        siteId: row.site_id,
        pgyMin: row.pgy_min,
        pgyMax: row.pgy_max,
        coverageMandatory: row.coverage_mandatory,
        active: row.active,
      }),
    ),
    coverage,
    blocks: blocks.map((block) => ({
      id: block.id,
      sequence: block.sequence,
      label: block.label,
      kind: block.kind,
      startDate: localDateString(block.start_date, "UTC"),
      endDate: localDateString(block.end_date, "UTC"),
    })),
    blockAssignments: blockAssignments.map((assignment) => ({
      cohortId: assignment.cohort_id,
      blockId: assignment.block_id,
      serviceId: assignment.service_id,
      label: assignment.label,
    })),
    overrides: overrides.map((override) => ({
      residentId: override.resident_id,
      blockId: override.block_id,
      serviceId: override.service_id,
      label: override.label,
      reason: override.reason,
    })),
    rules,
    baseline,
  };
}

/**
 * The window a schedule should be judged over, when nobody named one.
 *
 * Everything from today to the end of the last shift already scheduled.
 * Validating the past would report gaps in months that have been worked, which
 * is true, useless, and the fastest way to make a chief stop reading the
 * report.
 */
export async function defaultPeriod(
  programId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<{ start: string; end: string }> {
  const start = localDateString(now, timezone);
  const last = await query<{ date: string }>(
    `SELECT max(date)::text AS date FROM shifts
      WHERE program_id = $1 AND schedule_version_id IS NULL AND date >= $2::date`,
    [programId, start],
  );
  return { start, end: last[0]?.date ?? start };
}
