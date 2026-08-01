import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { PoolClient } from "pg";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { addLocalDays, localDayDiff } from "./time";

/**
 * Moving more than one shift at a time.
 *
 * Building a month by hand is not thirty decisions, it is four: *this cohort
 * swaps with that one*, *this week repeats*, *give me back what I just did*.
 * A screen that only reassigns one shift at a time turns each of those into
 * twenty clicks, and twenty clicks is how a scheduler ends up back in a
 * spreadsheet.
 *
 * ## Everything here is draft-only
 *
 * Deliberately. These verbs skip the confirmation, the trade revalidation and
 * the notifications that a live edit goes through, and they can do that only
 * because nobody can see a draft and nothing in it can be traded. The same
 * verbs on a published schedule would be a way to silently rewrite people's
 * weeks in bulk; the published path is `correctPublishedShift`, which is
 * deliberately one shift at a time and demands a reason.
 *
 * ## Undo
 *
 * Every operation returns what it replaced, as an ordinary reassignment. So
 * undo is not machinery — it is the inverse operation, sent back. That is why
 * it is safe here and why there is no undo for publication: replacing a live
 * schedule is not invertible by re-running an assignment, because residents
 * have already been told.
 */

export interface BulkChange {
  shiftId: string;
  residentId: string | null;
}

export interface BulkResult {
  changed: number;
  /** Send this back to `bulkAssign` to put things exactly as they were. */
  undo: BulkChange[];
  /** Named where something could not be done, rather than silently skipped. */
  skipped: Array<{ shiftId: string; reason: string }>;
}

async function requireDraft(
  client: PoolClient,
  context: AuthedContext,
  versionId: string,
): Promise<void> {
  const version = await queryOne<{ status: string }>(
    `SELECT status::text AS status FROM schedule_versions
      WHERE id = $1 AND program_id = $2 FOR UPDATE`,
    [versionId, context.program.id],
    client,
  );
  if (!version) throw notFound("That draft schedule no longer exists.");
  if (version.status !== "draft") {
    throw conflict(
      "This schedule has been published. Changing it now is a correction, one shift at a time, with a reason.",
    );
  }
}

/**
 * Puts a set of draft shifts on one person, or on nobody.
 *
 * `null` is a real destination: clearing a run of shifts is how a scheduler
 * makes room, and the unfilled queue exists precisely to hold what that leaves
 * behind.
 */
export async function bulkAssign(
  context: AuthedContext,
  versionId: string,
  changes: BulkChange[],
): Promise<BulkResult> {
  if (changes.length === 0) return { changed: 0, undo: [], skipped: [] };
  if (changes.length > 500) {
    /* Bounded because this is one transaction and a scheduler selecting a whole
       year by accident should be told, not made to wait. */
    throw validationFailed(
      `That is ${changes.length} shifts at once. Narrow the selection to 500 or fewer.`,
    );
  }

  return withTransaction(async (client) => {
    await requireDraft(client, context, versionId);

    const shiftIds = changes.map((change) => change.shiftId);
    const rows = await query<{ id: string; resident_id: string | null }>(
      `SELECT s.id, a.resident_id
         FROM shifts s
         LEFT JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.id = ANY($1::uuid[]) AND s.schedule_version_id = $2
        FOR UPDATE OF s`,
      [shiftIds, versionId],
      client,
    );
    const present = new Map(rows.map((row) => [row.id, row.resident_id]));

    /* Every resident named, checked once. Doing it per shift would be one
       query per row, and the answer cannot differ between rows. */
    const residentIds = [
      ...new Set(changes.map((c) => c.residentId).filter((id): id is string => !!id)),
    ];
    const residents = residentIds.length
      ? await query<{ id: string; name: string; schedulable: boolean }>(
          `SELECT r.id, u.full_name AS name, r.schedulable
             FROM residents r JOIN users u ON u.id = r.user_id
            WHERE r.id = ANY($1::uuid[]) AND r.program_id = $2 AND r.active = true`,
          [residentIds, context.program.id],
          client,
        )
      : [];
    const residentById = new Map(residents.map((row) => [row.id, row]));

    const undo: BulkChange[] = [];
    const skipped: BulkResult["skipped"] = [];
    let changed = 0;

    for (const change of changes) {
      if (!present.has(change.shiftId)) {
        /* Not found rather than forbidden, and the same answer for a published
           shift: this is not a back door into the live schedule. */
        skipped.push({
          shiftId: change.shiftId,
          reason: "That shift is not part of this draft.",
        });
        continue;
      }
      if (change.residentId) {
        const resident = residentById.get(change.residentId);
        if (!resident) {
          skipped.push({
            shiftId: change.shiftId,
            reason: "That resident is not in your program.",
          });
          continue;
        }
        if (!resident.schedulable) {
          skipped.push({
            shiftId: change.shiftId,
            reason: `${resident.name} is marked as not available to schedule.`,
          });
          continue;
        }
      }

      const before = present.get(change.shiftId) ?? null;
      if (before === change.residentId) continue; // Nothing to do, nothing to undo.

      await query(
        `UPDATE shift_assignments SET assignment_status = 'ended', ended_at = now()
          WHERE shift_id = $1 AND assignment_status = 'active'`,
        [change.shiftId],
        client,
      );
      if (change.residentId) {
        await query(
          "INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)",
          [change.shiftId, change.residentId],
          client,
        );
      }
      undo.push({ shiftId: change.shiftId, residentId: before });
      changed += 1;
    }

    if (changed > 0) {
      await recordAudit(
        {
          programId: context.program.id,
          actorUserId: context.user.id,
          actorLabel: context.user.email,
          action: "shift.reassigned",
          entityType: "schedule_version",
          entityId: versionId,
          newState: { shifts: changed, bulk: true },
        },
        client,
      );
    }

    return { changed, undo, skipped };
  });
}

export interface RepeatWeekInput {
  /** ISO date of the first day of the week being copied. */
  sourceStart: string;
  /** ISO date of the first day of the week being written over. */
  targetStart: string;
  /** How many days the pattern covers. Seven unless somebody says otherwise. */
  days?: number;
}

/**
 * Copies who was on what, from one stretch of days onto another.
 *
 * The pattern a programme actually repeats is *this person on this service on
 * this weekday*, and copying it is the single most common thing a scheduler
 * does by hand. What makes it safe is what it refuses to do: it matches shifts
 * by **service and time of day**, and only writes where the target already has
 * a shift to write on. It never creates a shift, never deletes one, and never
 * touches a day outside the target range.
 *
 * That restraint is the whole design. A copy that created shifts would let one
 * mistyped date duplicate a fortnight, and a copy that deleted them would let
 * it erase one.
 */
export async function repeatWeek(
  context: AuthedContext,
  versionId: string,
  input: RepeatWeekInput,
): Promise<BulkResult> {
  const days = input.days ?? 7;
  if (days < 1 || days > 31) {
    throw validationFailed("A pattern can cover between 1 and 31 days.");
  }
  if (input.sourceStart === input.targetStart) {
    throw validationFailed("The pattern and its destination are the same days.");
  }

  const sourceEnd = addLocalDays(input.sourceStart, days - 1);
  const targetEnd = addLocalDays(input.targetStart, days - 1);
  /* Overlapping ranges would have the copy reading rows it has already
     written, which produces a result nobody intended and nobody can predict. */
  if (input.sourceStart <= targetEnd && input.targetStart <= sourceEnd) {
    throw validationFailed(
      "Those two stretches overlap. Copy onto days outside the pattern itself.",
    );
  }

  /* The shift between the two stretches, in days. Computed here rather than in
     SQL so the join reads as "the same day, `offset` later" instead of as date
     arithmetic nobody can check by eye. */
  const offset = localDayDiff(input.sourceStart, input.targetStart);
  const rows = await query<{
    target_shift_id: string;
    resident_id: string | null;
  }>(
    /* Paired by service, time of day, and position within the day — the same
       one-to-one numbering the draft copy uses, and for the same reason: three
       people on wards at 07:00 are three identical rows, and joining on the
       columns alone is a cross join. */
    `WITH src AS (
       SELECT s.id, s.service_id, s.date, s.start_datetime::time AS tod,
              a.resident_id,
              row_number() OVER (
                PARTITION BY s.service_id, s.date, s.start_datetime::time ORDER BY s.id
              ) AS slot
         FROM shifts s
         LEFT JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1
          AND s.date >= $2::date AND s.date <= $3::date
     ),
     dst AS (
       SELECT s.id, s.service_id, s.date, s.start_datetime::time AS tod,
              row_number() OVER (
                PARTITION BY s.service_id, s.date, s.start_datetime::time ORDER BY s.id
              ) AS slot
         FROM shifts s
        WHERE s.schedule_version_id = $1
          AND s.date >= $4::date AND s.date <= $5::date
     )
     SELECT dst.id AS target_shift_id, src.resident_id
       FROM dst
       JOIN src
         ON src.service_id = dst.service_id
        AND src.tod = dst.tod
        AND src.slot = dst.slot
        AND dst.date = src.date + $6::int`,
    [versionId, input.sourceStart, sourceEnd, input.targetStart, targetEnd, offset],
  );

  if (rows.length === 0) {
    throw validationFailed(
      "Nothing lines up between those two stretches — the destination has no shifts on the same services at the same times.",
    );
  }

  return bulkAssign(
    context,
    versionId,
    rows.map((row) => ({ shiftId: row.target_shift_id, residentId: row.resident_id })),
  );
}
