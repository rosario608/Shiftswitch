import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { loadScheduleSnapshot } from "./constraints/snapshot";
import { assessEdit, type EditImpact } from "./generator/edit-check";
import { notify } from "./notifications";
import { invalidateTradesForShift } from "./trades";
import { addLocalDays, formatShiftDate, formatShiftRange, localDateString } from "./time";

/**
 * Changing a schedule people are already working.
 *
 * A published schedule is wrong sometimes. Somebody resigns, a rotation moves,
 * a service closes for a week. The change is not a trade — nobody offered
 * anything and nobody agreed — and it is not a draft edit either, because the
 * person losing the shift found out from this software that they had it.
 *
 * So a correction is deliberately the most expensive verb in the product:
 *
 *   - **one shift at a time.** There is no bulk correction. Rewriting forty
 *     people's weeks in one gesture is exactly the thing that should be slow.
 *   - **a reason is required**, and it is stored. "Why am I not on Tuesday any
 *     more" is the first question anybody asks, and "the database changed" is
 *     not an answer.
 *   - **both residents are told**, with a route to their own schedule.
 *   - **the schedule is revalidated**, and what the correction broke is
 *     reported rather than discovered in three weeks.
 *   - **it is visible afterwards.** `listCorrections` is what makes the
 *     difference between what was published and what is true now readable by
 *     somebody who was not in the room.
 *
 * Live trades against the shift are cancelled rather than blocking the
 * correction, and this is the one place that is right: a correction usually
 * *is* the response to the thing that made the trade impossible, and refusing
 * would leave a resident holding a shift the programme has already decided
 * they are not working. Everybody involved is notified by
 * `invalidateTradesForShift`, which is why cancelling here is not silent.
 */

export interface CorrectionInput {
  residentId: string | null;
  reason: string;
}

export interface CorrectionResult {
  shiftId: string;
  previousResidentName: string | null;
  newResidentName: string | null;
  /** What the correction broke or fixed, from the validator. */
  impact: EditImpact | null;
  /** Everybody told, by name. */
  notified: string[];
  cancelledTrades: number;
}

/** How wide a window the revalidation looks at, either side of the shift. */
const IMPACT_WINDOW_DAYS = 14;

export async function correctPublishedShift(
  context: AuthedContext,
  shiftId: string,
  input: CorrectionInput,
): Promise<CorrectionResult> {
  const reason = input.reason.trim();
  if (!reason) {
    throw validationFailed(
      "Say why this is changing. Whoever loses the shift will be told, and the reason is what they see.",
    );
  }

  const shift = await queryOne<{
    id: string;
    date: string;
    published_version_id: string | null;
    service_name: string;
    start_datetime: Date;
    end_datetime: Date;
    resident_id: string | null;
    resident_user_id: string | null;
    resident_name: string | null;
    schedule_version_id: string | null;
  }>(
    `SELECT s.id, s.date::text AS date, s.published_version_id, sv.name AS service_name,
            s.start_datetime, s.end_datetime, s.schedule_version_id,
            a.resident_id, r.user_id AS resident_user_id, u.full_name AS resident_name
       FROM shifts s
       JOIN services sv ON sv.id = s.service_id
       LEFT JOIN shift_assignments a
         ON a.shift_id = s.id AND a.assignment_status = 'active'
       LEFT JOIN residents r ON r.id = a.resident_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE s.id = $1 AND s.program_id = $2`,
    [shiftId, context.program.id],
  );
  if (!shift) throw notFound("That shift no longer exists.");
  if (shift.schedule_version_id) {
    /* A draft shift is not a correction — nobody is working it. Sent to the
       cheap path rather than silently doing the expensive one. */
    throw conflict(
      "That shift is part of a draft. Edit it there — a correction is for a schedule people are already working.",
    );
  }
  if (shift.resident_id === input.residentId) {
    throw validationFailed("That is who is already on it.");
  }

  const incoming = input.residentId
    ? await queryOne<{ id: string; user_id: string; name: string; schedulable: boolean }>(
        `SELECT r.id, r.user_id, u.full_name AS name, r.schedulable
           FROM residents r JOIN users u ON u.id = r.user_id
          WHERE r.id = $1 AND r.program_id = $2 AND r.active = true`,
        [input.residentId, context.program.id],
      )
    : null;
  if (input.residentId && !incoming) {
    throw notFound("That resident is not in your program.");
  }
  if (incoming && !incoming.schedulable) {
    throw validationFailed(
      `${incoming.name} is marked as not available to schedule. Change that on the roster first if they are back.`,
    );
  }

  /* Validated before the change and again after, so the report is about what
     *this* correction did rather than about everything already wrong with the
     month. Loaded outside the transaction because the "before" snapshot has to
     be the committed state, which is exactly what it is. */
  const period = {
    start: addLocalDays(shift.date, -IMPACT_WINDOW_DAYS),
    end: addLocalDays(shift.date, IMPACT_WINDOW_DAYS),
  };
  const program = {
    id: context.program.id,
    name: context.program.name,
    timezone: context.program.timezone,
  };
  const before = await loadScheduleSnapshot(program, { period });

  const cancelledTrades = await withTransaction(async (client) => {
    const locked = await queryOne<{ id: string; resident_id: string | null }>(
      `SELECT s.id, a.resident_id
         FROM shifts s
         LEFT JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.id = $1 AND s.program_id = $2 AND s.schedule_version_id IS NULL
        FOR UPDATE OF s`,
      [shiftId, context.program.id],
      client,
    );
    if (!locked) throw notFound("That shift no longer exists.");
    /* Re-read under the lock: the holder may have changed between the read
       above and here, and correcting away somebody who is no longer on it
       would be a change nobody asked for. */
    if (locked.resident_id !== shift.resident_id) {
      throw conflict(
        "Somebody else changed this shift while you were looking at it. Reload and try again.",
      );
    }

    const cancelled = await invalidateTradesForShift(
      client,
      shiftId,
      "A chief corrected this shift after it was published.",
      { userId: context.user.id, programId: context.program.id },
    );

    await query(
      `UPDATE shift_assignments SET assignment_status = 'ended', ended_at = now()
        WHERE shift_id = $1 AND assignment_status = 'active'`,
      [shiftId],
      client,
    );
    if (input.residentId) {
      await query(
        "INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)",
        [shiftId, input.residentId],
        client,
      );
    }

    await query(
      `INSERT INTO schedule_corrections
         (program_id, version_id, shift_id, previous_resident_id, new_resident_id,
          reason, corrected_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        context.program.id,
        shift.published_version_id,
        shiftId,
        shift.resident_id,
        input.residentId,
        reason,
        context.user.id,
      ],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "schedule.corrected",
        entityType: "shift",
        entityId: shiftId,
        previousState: { resident: shift.resident_name },
        newState: { resident: incoming?.name ?? null },
        reason,
      },
      client,
    );

    const when =
      `${formatShiftDate(shift.start_datetime, context.program.timezone)} ` +
      `${formatShiftRange(shift.start_datetime, shift.end_datetime, context.program.timezone)}`;

    const messages = [];
    if (shift.resident_user_id) {
      messages.push({
        recipientUserId: shift.resident_user_id,
        type: "schedule.corrected" as const,
        title: `You are no longer on ${shift.service_name}`,
        body: `${when}. ${reason}`,
        relatedEntityType: "shift",
        relatedEntityId: shiftId,
        route: "/schedule",
      });
    }
    if (incoming) {
      messages.push({
        recipientUserId: incoming.user_id,
        type: "schedule.corrected" as const,
        title: `You are now on ${shift.service_name}`,
        body: `${when}. ${reason}`,
        relatedEntityType: "shift",
        relatedEntityId: shiftId,
        route: "/schedule",
      });
    }
    if (messages.length > 0) await notify(messages, client);

    return cancelled;
  });

  /* The impact is computed after the change is committed, and stored on the
     correction. A number worked out from the pre-change state and labelled as
     the result would be a lie a chief would act on. */
  const after = await loadScheduleSnapshot(program, { period });
  const impact = assessEdit(before, after);

  await query(
    `UPDATE schedule_corrections SET impact = $2::jsonb
      WHERE shift_id = $1 AND created_at = (
        SELECT max(created_at) FROM schedule_corrections WHERE shift_id = $1
      )`,
    [
      shiftId,
      JSON.stringify({
        safe: impact.safe,
        summary: impact.summary,
        introduced: impact.introduced.map((violation) => violation.message),
        resolved: impact.resolved.map((violation) => violation.message),
        scoreBefore: impact.scoreBefore,
        scoreAfter: impact.scoreAfter,
      }),
    ],
  );

  return {
    shiftId,
    previousResidentName: shift.resident_name,
    newResidentName: incoming?.name ?? null,
    impact,
    notified: [shift.resident_name, incoming?.name ?? null].filter(
      (name): name is string => Boolean(name),
    ),
    cancelledTrades,
  };
}

export interface Correction {
  id: string;
  shift_id: string;
  date: string;
  service_name: string;
  start_datetime: Date;
  end_datetime: Date;
  previous_resident_name: string | null;
  new_resident_name: string | null;
  reason: string;
  impact: { safe: boolean; summary: string } | null;
  corrected_by_name: string | null;
  created_at: Date;
  version_name: string | null;
}

/**
 * What has changed since the schedule was published.
 *
 * The visible difference between the original and the corrected schedule. Not
 * a diff of two versions — the original version's rows *became* the live ones,
 * so there is no second copy to compare against — but the list of deliberate
 * departures from it, each with who made it and why. That is the question
 * somebody actually asks, and it is the one a diff of two snapshots could not
 * answer anyway, because it could not say why.
 */
export async function listCorrections(
  programId: string,
  options: { versionId?: string | null; from?: string; limit?: number } = {},
): Promise<Correction[]> {
  const values: unknown[] = [programId];
  let where = "c.program_id = $1";
  if (options.versionId) {
    values.push(options.versionId);
    where += ` AND c.version_id = $${values.length}`;
  }
  if (options.from) {
    values.push(options.from);
    where += ` AND s.date >= $${values.length}::date`;
  }
  values.push(Math.min(options.limit ?? 100, 500));

  return query<Correction>(
    `SELECT c.id, c.shift_id, s.date::text AS date, sv.name AS service_name,
            s.start_datetime, s.end_datetime,
            pu.full_name AS previous_resident_name,
            nu.full_name AS new_resident_name,
            c.reason, c.impact, cu.full_name AS corrected_by_name, c.created_at,
            v.name AS version_name
       FROM schedule_corrections c
       JOIN shifts s ON s.id = c.shift_id
       JOIN services sv ON sv.id = s.service_id
       LEFT JOIN residents pr ON pr.id = c.previous_resident_id
       LEFT JOIN users pu ON pu.id = pr.user_id
       LEFT JOIN residents nr ON nr.id = c.new_resident_id
       LEFT JOIN users nu ON nu.id = nr.user_id
       LEFT JOIN users cu ON cu.id = c.corrected_by
       LEFT JOIN schedule_versions v ON v.id = c.version_id
      WHERE ${where}
      ORDER BY c.created_at DESC
      LIMIT $${values.length}`,
    values,
  );
}

/** Whether a live shift has been corrected since publication, for a screen badge. */
export async function correctedShiftIds(
  programId: string,
  period: { start: string; end: string },
): Promise<Set<string>> {
  const rows = await query<{ shift_id: string }>(
    `SELECT DISTINCT c.shift_id
       FROM schedule_corrections c
       JOIN shifts s ON s.id = c.shift_id
      WHERE c.program_id = $1 AND s.date >= $2::date AND s.date <= $3::date`,
    [programId, period.start, period.end],
  );
  return new Set(rows.map((row) => row.shift_id));
}

/** The program's timezone-local today, for callers that want a default window. */
export function todayIn(timezone: string): string {
  return localDateString(new Date(), timezone);
}
