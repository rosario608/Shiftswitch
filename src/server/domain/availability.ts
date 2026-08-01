import { query, queryOne } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { forbidden, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";

/**
 * When somebody cannot work, said properly.
 *
 * Before this, unavailability was ISO dates in two jsonb columns:
 * `constraints.unavailableDates` for the hard kind and
 * `preferences.requestedDaysOff` for the soft kind. Correct, and unusable — a
 * fortnight of annual leave was fourteen strings, with nowhere to say it was
 * leave rather than a conference rather than an accommodation, and nothing to
 * stop the two lists disagreeing about the same day.
 *
 * A row here is a **range with a kind and a hardness**. It is entered once, it
 * says why, and it reaches the constraint model without anything having to
 * translate it — `expandAbsences` merges it into exactly the lists the model
 * already read, so no constraint and no generator code learned a new concept.
 *
 * The jsonb keys still work. An import that writes them keeps working, and a
 * programme that has both gets the union.
 *
 * ## Hard versus soft
 *
 * The distinction is the same one that runs through the whole constraint model,
 * and it is about consequence rather than importance. Hard means a schedule
 * that ignores it is **wrong** — approved leave, a religious observance, an
 * accommodation. Soft means it is disappointing — a conference somebody hopes
 * to attend, a day they would rather not work. A wish must never be able to
 * invalidate a schedule, and an accommodation must never be silently traded
 * away as a wish, which is why hardness is recorded rather than inferred.
 */

export const ABSENCE_KINDS = [
  "vacation",
  "leave",
  "conference",
  "elective",
  "unavailable",
  "restriction",
] as const;

export type AbsenceKind = (typeof ABSENCE_KINDS)[number];

/**
 * How each kind is named to a reader, and what it defaults to.
 *
 * The defaults are what a programme means by the word nine times in ten;
 * every one of them is overridable per row, because the tenth programme is
 * real. Annual leave that has been approved is hard. A conference somebody is
 * hoping to attend is not, until it is.
 */
export const ABSENCE_KIND_LABEL: Record<AbsenceKind, string> = {
  vacation: "Vacation",
  leave: "Leave",
  conference: "Conference",
  elective: "Elective",
  unavailable: "Unavailable",
  restriction: "Restriction",
};

export const ABSENCE_KIND_DESCRIPTION: Record<AbsenceKind, string> = {
  vacation: "Annual leave. Hard once it has been approved.",
  leave: "Parental, sick, bereavement or other leave.",
  conference: "Away at a meeting or course.",
  elective: "On an elective or away rotation, so unavailable to the roster.",
  unavailable: "Cannot work these dates, for a reason that is nobody else's business.",
  restriction: "A standing restriction — an accommodation, or a duty limit.",
};

export const ABSENCE_KIND_DEFAULT_HARD: Record<AbsenceKind, boolean> = {
  vacation: true,
  leave: true,
  conference: false,
  elective: true,
  unavailable: true,
  restriction: true,
};

export interface Absence {
  id: string;
  resident_id: string;
  resident_name: string;
  pgy_level: number;
  kind: AbsenceKind;
  /** Inclusive ISO dates in the program's timezone. */
  start_date: string;
  end_date: string;
  hard: boolean;
  notes: string;
  created_by_name: string | null;
  created_at: Date;
}

const SELECT = `
  SELECT a.id, a.resident_id, u.full_name AS resident_name, r.pgy_level,
         a.kind::text AS kind, a.start_date::text AS start_date,
         a.end_date::text AS end_date, a.hard, a.notes,
         cu.full_name AS created_by_name, a.created_at
    FROM resident_absences a
    JOIN residents r ON r.id = a.resident_id
    JOIN users u ON u.id = r.user_id
    LEFT JOIN users cu ON cu.id = a.created_by`;

export async function listAbsences(
  programId: string,
  options: { residentId?: string; from?: string; to?: string } = {},
): Promise<Absence[]> {
  const values: unknown[] = [programId];
  let where = "a.program_id = $1";
  if (options.residentId) {
    values.push(options.residentId);
    where += ` AND a.resident_id = $${values.length}`;
  }
  /* Overlap, not containment. An absence that started last month and runs
     through this one is unavailability for this month, and a query that asked
     for absences *starting* in the window would miss exactly the long ones that
     matter most. */
  if (options.to) {
    values.push(options.to);
    where += ` AND a.start_date <= $${values.length}::date`;
  }
  if (options.from) {
    values.push(options.from);
    where += ` AND a.end_date >= $${values.length}::date`;
  }
  return query<Absence>(
    `${SELECT} WHERE ${where} ORDER BY a.start_date, u.full_name`,
    values,
  );
}

export interface AbsenceInput {
  residentId: string;
  kind: AbsenceKind;
  startDate: string;
  endDate: string;
  /** Omitted takes the kind's default. */
  hard?: boolean;
  notes?: string;
}

/**
 * Records an absence.
 *
 * A resident may record their own; recording somebody else's needs
 * `scheduling.plan`. Both paths are audited, because "who said I was on leave"
 * is a question that gets asked when a schedule goes wrong, and the answer
 * "the database, at some point" ends the conversation badly.
 *
 * A resident recording their own may not mark it **hard**. Hard unavailability
 * is the programme agreeing somebody cannot work; a resident who could set it
 * themselves would have a way to make a schedule invalid unilaterally, and the
 * first time it was used to get out of a night float everybody would stop
 * trusting it. They record the request; the scheduler confirms it.
 */
export async function createAbsence(
  context: AuthedContext,
  input: AbsenceInput,
): Promise<Absence> {
  const manages = can(context.user.role, "scheduling.plan");
  const own = context.resident?.id === input.residentId;
  if (!manages && !own) {
    throw forbidden("You can only record your own availability.");
  }

  if (input.endDate < input.startDate) {
    throw validationFailed("That period ends before it starts.");
  }

  const resident = await queryOne<{ id: string; name: string }>(
    `SELECT r.id, u.full_name AS name FROM residents r
       JOIN users u ON u.id = r.user_id
      WHERE r.id = $1 AND r.program_id = $2`,
    [input.residentId, context.program.id],
  );
  if (!resident) throw notFound("That resident is not in your program.");

  const hard = manages
    ? (input.hard ?? ABSENCE_KIND_DEFAULT_HARD[input.kind])
    : false;

  const created = (await queryOne<{ id: string }>(
    `INSERT INTO resident_absences
       (program_id, resident_id, kind, start_date, end_date, hard, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      context.program.id,
      input.residentId,
      input.kind,
      input.startDate,
      input.endDate,
      hard,
      (input.notes ?? "").trim(),
      context.user.id,
    ],
  ))!;

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "absence.created",
    entityType: "resident_absence",
    entityId: created.id,
    newState: {
      resident: resident.name,
      kind: input.kind,
      from: input.startDate,
      to: input.endDate,
      hard,
    },
  });

  return (await queryOne<Absence>(`${SELECT} WHERE a.id = $1`, [created.id]))!;
}

/**
 * Confirms, softens or otherwise amends an absence. Scheduler only — this is
 * the verb that turns a request into an agreed fact.
 */
export async function updateAbsence(
  context: AuthedContext,
  id: string,
  patch: { hard?: boolean; notes?: string; startDate?: string; endDate?: string },
): Promise<Absence> {
  const existing = await queryOne<Absence>(`${SELECT} WHERE a.id = $1 AND a.program_id = $2`, [
    id,
    context.program.id,
  ]);
  if (!existing) throw notFound("That absence no longer exists.");

  const startDate = patch.startDate ?? existing.start_date;
  const endDate = patch.endDate ?? existing.end_date;
  if (endDate < startDate) throw validationFailed("That period ends before it starts.");

  await query(
    `UPDATE resident_absences
        SET hard = $2, notes = $3, start_date = $4, end_date = $5
      WHERE id = $1`,
    [id, patch.hard ?? existing.hard, patch.notes ?? existing.notes, startDate, endDate],
  );

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "absence.updated",
    entityType: "resident_absence",
    entityId: id,
    previousState: {
      hard: existing.hard,
      from: existing.start_date,
      to: existing.end_date,
    },
    newState: { hard: patch.hard ?? existing.hard, from: startDate, to: endDate },
  });

  return (await queryOne<Absence>(`${SELECT} WHERE a.id = $1`, [id]))!;
}

export async function deleteAbsence(context: AuthedContext, id: string): Promise<void> {
  const existing = await queryOne<Absence>(`${SELECT} WHERE a.id = $1 AND a.program_id = $2`, [
    id,
    context.program.id,
  ]);
  if (!existing) throw notFound("That absence no longer exists.");

  const manages = can(context.user.role, "scheduling.plan");
  const own = context.resident?.id === existing.resident_id;
  if (!manages && !own) throw forbidden("You can only change your own availability.");
  /* A resident may withdraw their own request; they may not delete the
     programme's record that they are on agreed leave. Same reasoning as
     refusing them `hard` on creation. */
  if (!manages && existing.hard) {
    throw forbidden(
      "This was confirmed by your program. Ask a chief to change it.",
    );
  }

  await query("DELETE FROM resident_absences WHERE id = $1", [id]);
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "absence.deleted",
    entityType: "resident_absence",
    entityId: id,
    previousState: {
      resident: existing.resident_name,
      kind: existing.kind,
      from: existing.start_date,
      to: existing.end_date,
      hard: existing.hard,
    },
  });
}
