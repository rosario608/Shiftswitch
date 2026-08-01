import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";

/**
 * Coverage requirements: how many people a service needs, and when.
 *
 * The question the scheduler exists to answer. A requirement is a statement
 * about a span of time — a set of weekdays, a date range, or one named day —
 * carrying a staffing floor, an optional ceiling, and an optional PGY mix.
 *
 * ## Precedence
 *
 * Most specific wins, and only one requirement applies to a given service on a
 * given day and time band:
 *
 *   1. `date`     — a named day. Christmas.
 *   2. `period`   — a date range. The winter holiday block.
 *   3. `weekday`  — the default shape of an ordinary week.
 *
 * This is resolved in `requirementFor` rather than by the caller, because the
 * whole value of the ordering is that nobody has to remember it. A scheduler
 * asking "what does this service need on the 25th" gets one answer.
 *
 * ## Why "weekend" is not a scope
 *
 * Programmes disagree about whether Friday night is the weekend, whether Sunday
 * day is, and whether a holiday Monday counts. `days_of_week` says exactly which
 * days, so "weekend" is a preset in the interface — `{0, 6}` — and never a thing
 * the schema has an opinion about.
 */

/** PostgreSQL's `EXTRACT(DOW)` convention: 0 is Sunday. */
export const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const WEEKDAY_PRESET = [1, 2, 3, 4, 5];
export const WEEKEND_PRESET = [0, 6];
export const EVERY_DAY_PRESET = [0, 1, 2, 3, 4, 5, 6];

export type CoverageScope = "weekday" | "period" | "date";

/** One entry of a required PGY mix: "at least one PGY-2, at most two". */
export interface PgyMixEntry {
  pgy: number;
  min: number;
  max: number | null;
}

export interface CoverageRequirement {
  id: string;
  program_id: string;
  service_id: string;
  scope: CoverageScope;
  label: string;
  days_of_week: number[];
  specific_date: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  start_time: string | null;
  end_time: string | null;
  min_staff: number;
  max_staff: number | null;
  pgy_mix: PgyMixEntry[];
  notes: string;
  active: boolean;
  created_at: Date;
}

export interface CoverageInput {
  serviceId: string;
  scope: CoverageScope;
  label?: string;
  daysOfWeek?: number[];
  specificDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  minStaff: number;
  maxStaff?: number | null;
  pgyMix?: PgyMixEntry[];
  notes?: string;
  active?: boolean;
}

/**
 * Validates the parts a CHECK constraint cannot explain.
 *
 * The database enforces the same invariants, which is right — it is the last
 * line and it does not depend on anybody calling this. But a constraint
 * violation reads `coverage_scope_fields`, and somebody configuring a service
 * needs to be told that a Tuesday rule cannot also name a date.
 */
export function validateCoverage(input: CoverageInput): void {
  if (input.minStaff < 0) {
    throw validationFailed("The minimum number of people cannot be negative.");
  }
  if (input.maxStaff != null && input.maxStaff < input.minStaff) {
    throw validationFailed(
      `The maximum (${input.maxStaff}) is below the minimum (${input.minStaff}). ` +
        "Leave the maximum empty if there is no cap.",
    );
  }

  switch (input.scope) {
    case "weekday": {
      const days = input.daysOfWeek ?? [];
      if (days.length === 0) {
        throw validationFailed("Choose at least one day of the week.");
      }
      for (const day of days) {
        if (!Number.isInteger(day) || day < 0 || day > 6) {
          throw validationFailed(`"${day}" is not a day of the week.`);
        }
      }
      if (new Set(days).size !== days.length) {
        throw validationFailed("The same day is listed more than once.");
      }
      break;
    }
    case "date":
      if (!input.specificDate) {
        throw validationFailed("Choose the date this applies to.");
      }
      break;
    case "period":
      if (!input.periodStart || !input.periodEnd) {
        throw validationFailed("A period needs both a start and an end date.");
      }
      if (input.periodEnd < input.periodStart) {
        throw validationFailed("The period ends before it starts.");
      }
      break;
  }

  validatePgyMix(input.pgyMix ?? [], input.minStaff, input.maxStaff ?? null);
}

/**
 * The PGY mix has to be *satisfiable*, not merely well-formed.
 *
 * Requiring two PGY-1s and two PGY-2s on a service capped at three people is
 * not a typo the scheduler will notice later — it is a requirement no schedule
 * can meet, and it will be discovered as a mysterious inability to fill the
 * service. Checking it here means it is discovered while it is still being
 * typed.
 */
export function validatePgyMix(
  mix: PgyMixEntry[],
  minStaff: number,
  maxStaff: number | null,
): void {
  const seen = new Set<number>();
  let requiredTotal = 0;

  for (const entry of mix) {
    if (!Number.isInteger(entry.pgy) || entry.pgy < 1 || entry.pgy > 10) {
      throw validationFailed(`PGY-${entry.pgy} is not a training level.`);
    }
    if (seen.has(entry.pgy)) {
      throw validationFailed(`PGY-${entry.pgy} is listed twice.`);
    }
    seen.add(entry.pgy);

    if (!Number.isInteger(entry.min) || entry.min < 0) {
      throw validationFailed(`The PGY-${entry.pgy} minimum must be zero or more.`);
    }
    if (entry.max != null) {
      if (!Number.isInteger(entry.max) || entry.max < 0) {
        throw validationFailed(`The PGY-${entry.pgy} maximum must be zero or more.`);
      }
      if (entry.max < entry.min) {
        throw validationFailed(
          `PGY-${entry.pgy} asks for at least ${entry.min} but at most ${entry.max}.`,
        );
      }
    }
    requiredTotal += entry.min;
  }

  if (maxStaff != null && requiredTotal > maxStaff) {
    throw validationFailed(
      `The PGY mix requires ${requiredTotal} people but the service is capped at ${maxStaff}. ` +
        "No schedule could satisfy both.",
    );
  }
  if (requiredTotal > 0 && requiredTotal > Math.max(minStaff, maxStaff ?? requiredTotal)) {
    // Not an error: asking for more by level than the floor simply raises the
    // floor, and saying so is more useful than refusing.
    return;
  }
}

/** The effective floor: the mix can demand more people than `min_staff` says. */
export function effectiveMinimum(requirement: {
  min_staff: number;
  pgy_mix: PgyMixEntry[];
}): number {
  const fromMix = requirement.pgy_mix.reduce((total, entry) => total + entry.min, 0);
  return Math.max(requirement.min_staff, fromMix);
}

const SELECT = `SELECT id, program_id, service_id, scope::text AS scope, label,
                       days_of_week, specific_date, period_start, period_end,
                       start_time::text AS start_time, end_time::text AS end_time,
                       min_staff, max_staff, pgy_mix, notes, active, created_at
                  FROM coverage_requirements`;

export async function listCoverage(
  programId: string,
  options: { serviceId?: string; includeInactive?: boolean } = {},
): Promise<CoverageRequirement[]> {
  const values: unknown[] = [programId];
  let where = "program_id = $1";
  if (options.serviceId) {
    values.push(options.serviceId);
    where += ` AND service_id = $${values.length}`;
  }
  if (!options.includeInactive) where += " AND active = true";
  /* Ordered by specificity, so a caller that simply takes the first match for a
     date gets the right answer without knowing the precedence rule. */
  return query<CoverageRequirement>(
    `${SELECT} WHERE ${where}
      ORDER BY CASE scope WHEN 'date' THEN 0 WHEN 'period' THEN 1 ELSE 2 END,
               specific_date NULLS LAST, period_start NULLS LAST, start_time NULLS FIRST`,
    values,
  );
}

/**
 * What a service needs on one date, with precedence already applied.
 *
 * Returns every requirement that applies — a service can want different numbers
 * at different times of day, and those coexist — but only from the most
 * specific scope that matched. A named date's requirements replace the
 * weekday's rather than adding to them, because "Christmas needs one person"
 * means one, not one plus the usual four.
 */
export function requirementsFor(
  requirements: CoverageRequirement[],
  date: Date,
  timezone: string,
): CoverageRequirement[] {
  const iso = isoDateIn(date, timezone);
  const dow = dayOfWeekIn(date, timezone);

  const onDate = requirements.filter(
    (r) => r.scope === "date" && r.specific_date && isoDate(r.specific_date) === iso,
  );
  if (onDate.length > 0) return onDate;

  const inPeriod = requirements.filter(
    (r) =>
      r.scope === "period" &&
      r.period_start &&
      r.period_end &&
      isoDate(r.period_start) <= iso &&
      iso <= isoDate(r.period_end),
  );
  if (inPeriod.length > 0) return inPeriod;

  return requirements.filter(
    (r) => r.scope === "weekday" && r.days_of_week.includes(dow),
  );
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isoDateIn(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function dayOfWeekIn(value: Date, timezone: string): number {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(value);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
}

async function assertServiceInProgram(programId: string, serviceId: string) {
  const service = await queryOne<{ id: string; name: string }>(
    "SELECT id, name FROM services WHERE id = $1 AND program_id = $2",
    [serviceId, programId],
  );
  // Scoped by program in the same statement: a wrong-program id is "not found",
  // which is also what it should look like from outside.
  if (!service) throw notFound("That service no longer exists.");
  return service;
}

export async function createCoverage(
  context: AuthedContext,
  input: CoverageInput,
): Promise<CoverageRequirement> {
  validateCoverage(input);
  const service = await assertServiceInProgram(context.program.id, input.serviceId);

  return withTransaction(async (client) => {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO coverage_requirements
         (program_id, service_id, scope, label, days_of_week, specific_date,
          period_start, period_end, start_time, end_time, min_staff, max_staff,
          pgy_mix, notes, active)
       VALUES ($1, $2, $3::coverage_scope, $4, $5::smallint[], $6, $7, $8, $9, $10,
               $11, $12, $13::jsonb, $14, $15)
       RETURNING id`,
      [
        context.program.id,
        input.serviceId,
        input.scope,
        input.label ?? "",
        input.scope === "weekday" ? (input.daysOfWeek ?? []) : [],
        input.scope === "date" ? input.specificDate : null,
        input.scope === "period" ? input.periodStart : null,
        input.scope === "period" ? input.periodEnd : null,
        input.startTime ?? null,
        input.endTime ?? null,
        input.minStaff,
        input.maxStaff ?? null,
        JSON.stringify(input.pgyMix ?? []),
        input.notes ?? "",
        input.active ?? true,
      ],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "coverage.created",
        entityType: "coverage_requirement",
        entityId: created!.id,
        newState: { service: service.name, scope: input.scope, minStaff: input.minStaff },
      },
      client,
    );

    return (await queryOne<CoverageRequirement>(`${SELECT} WHERE id = $1`, [created!.id], client))!;
  });
}

export async function updateCoverage(
  context: AuthedContext,
  id: string,
  input: CoverageInput,
): Promise<CoverageRequirement> {
  validateCoverage(input);
  await assertServiceInProgram(context.program.id, input.serviceId);

  return withTransaction(async (client) => {
    const existing = await queryOne<CoverageRequirement>(
      `${SELECT} WHERE id = $1 AND program_id = $2 FOR UPDATE`,
      [id, context.program.id],
      client,
    );
    if (!existing) throw notFound("That coverage requirement no longer exists.");

    await query(
      `UPDATE coverage_requirements
          SET service_id = $2, scope = $3::coverage_scope, label = $4,
              days_of_week = $5::smallint[], specific_date = $6,
              period_start = $7, period_end = $8, start_time = $9, end_time = $10,
              min_staff = $11, max_staff = $12, pgy_mix = $13::jsonb,
              notes = $14, active = $15
        WHERE id = $1`,
      [
        id,
        input.serviceId,
        input.scope,
        input.label ?? "",
        input.scope === "weekday" ? (input.daysOfWeek ?? []) : [],
        input.scope === "date" ? input.specificDate : null,
        input.scope === "period" ? input.periodStart : null,
        input.scope === "period" ? input.periodEnd : null,
        input.startTime ?? null,
        input.endTime ?? null,
        input.minStaff,
        input.maxStaff ?? null,
        JSON.stringify(input.pgyMix ?? []),
        input.notes ?? "",
        input.active ?? true,
      ],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "coverage.updated",
        entityType: "coverage_requirement",
        entityId: id,
        previousState: { minStaff: existing.min_staff, scope: existing.scope },
        newState: { minStaff: input.minStaff, scope: input.scope },
      },
      client,
    );

    return (await queryOne<CoverageRequirement>(`${SELECT} WHERE id = $1`, [id], client))!;
  });
}

/**
 * Coverage requirements are deleted rather than deactivated.
 *
 * Unlike a service, nothing references one: no shift, no trade, no history. A
 * requirement that no longer applies is not a record worth keeping — it is a
 * mistake somebody is trying to remove — and leaving deactivated rows on the
 * screen would make the one thing this table is for, "what does this service
 * need", harder to read.
 */
export async function deleteCoverage(context: AuthedContext, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await queryOne<CoverageRequirement>(
      `${SELECT} WHERE id = $1 AND program_id = $2 FOR UPDATE`,
      [id, context.program.id],
      client,
    );
    if (!existing) throw notFound("That coverage requirement no longer exists.");

    await query("DELETE FROM coverage_requirements WHERE id = $1", [id], client);
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "coverage.deleted",
        entityType: "coverage_requirement",
        entityId: id,
        previousState: {
          serviceId: existing.service_id,
          scope: existing.scope,
          minStaff: existing.min_staff,
        },
      },
      client,
    );
  });
}

/**
 * Requirements that can never be met, across a whole programme.
 *
 * Not "is today short-staffed" — that is a scheduling outcome. This is the
 * configuration being self-contradictory: a mix demanding more people than the
 * cap allows, or a mandatory service with a floor of zero. Surfaced on the
 * scheduler dashboard, because a programme discovers these in October
 * otherwise.
 */
export async function listCoverageProblems(programId: string): Promise<
  Array<{ serviceId: string; serviceName: string; requirementId: string; problem: string }>
> {
  const rows = await query<{
    id: string;
    service_id: string;
    service_name: string;
    min_staff: number;
    max_staff: number | null;
    pgy_mix: PgyMixEntry[];
    coverage_mandatory: boolean;
    label: string;
  }>(
    `SELECT c.id, c.service_id, s.name AS service_name, c.min_staff, c.max_staff,
            c.pgy_mix, s.coverage_mandatory, c.label
       FROM coverage_requirements c
       JOIN services s ON s.id = c.service_id
      WHERE c.program_id = $1 AND c.active = true AND s.active = true`,
    [programId],
  );

  const problems: Array<{
    serviceId: string;
    serviceName: string;
    requirementId: string;
    problem: string;
  }> = [];

  for (const row of rows) {
    const required = row.pgy_mix.reduce((total, entry) => total + entry.min, 0);
    if (row.max_staff != null && required > row.max_staff) {
      problems.push({
        serviceId: row.service_id,
        serviceName: row.service_name,
        requirementId: row.id,
        problem: `The PGY mix needs ${required} people but the cap is ${row.max_staff}.`,
      });
    }
    if (row.coverage_mandatory && effectiveMinimum(row) === 0) {
      problems.push({
        serviceId: row.service_id,
        serviceName: row.service_name,
        requirementId: row.id,
        problem: "Coverage is mandatory but this requirement asks for nobody.",
      });
    }
  }
  return problems;
}
