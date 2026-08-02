import { DateTime } from "luxon";
import { getPool, query, queryOne, type Queryable } from "@/server/db/pool";
import type { ShiftDetail } from "@/server/db/types";
import type { ResidentInfo, ShiftInfo } from "@/server/domain/rules/types";

/**
 * A shift a resident actually works.
 *
 * `shifts.schedule_version_id` is null for the live schedule and set for a
 * draft, so this one condition is the entire boundary between "the schedule"
 * and "somebody's work in progress". Every query that answers a question *for a
 * resident* — their schedule, what they can offer, what a rule sees — must
 * carry it, or a draft's copies show up as real shifts: duplicated on the
 * calendar, offerable in a trade, and colliding with their originals under the
 * overlap rule.
 *
 * Deliberately a named constant rather than four inline copies. The scheduler's
 * own queries omit it on purpose, and the name is what makes that omission read
 * as a decision instead of an oversight.
 */
export const PUBLISHED_ONLY = "s.schedule_version_id IS NULL";

export const SHIFT_DETAIL_SELECT = `
  SELECT s.*,
         sv.name AS service_name,
         ro.name AS rotation_name,
         sa.resident_id,
         u.full_name AS resident_name,
         res.pgy_level AS resident_pgy,
         p.timezone AS program_timezone
    FROM shifts s
    JOIN services sv ON sv.id = s.service_id
    JOIN programs p  ON p.id = s.program_id
    LEFT JOIN rotations ro ON ro.id = s.rotation_id
    LEFT JOIN shift_assignments sa
           ON sa.shift_id = s.id AND sa.assignment_status = 'active'
    LEFT JOIN residents res ON res.id = sa.resident_id
    LEFT JOIN users u ON u.id = res.user_id
`;

export function toShiftInfo(row: ShiftDetail): ShiftInfo {
  return {
    id: row.id,
    programId: row.program_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    rotationId: row.rotation_id,
    rotationName: row.rotation_name,
    shiftType: row.shift_type,
    date: typeof row.date === "string" ? row.date : DateTime.fromJSDate(row.date as unknown as Date).toISODate()!,
    start: row.start_datetime,
    end: row.end_datetime,
    location: row.location,
    requiredPgyMin: row.required_pgy_min,
    requiredPgyMax: row.required_pgy_max,
    tradeable: row.tradeable,
    approvalRequired: row.approval_required,
    tradeDeadline: row.trade_deadline,
    status: row.status,
  };
}

export async function getShiftDetail(
  shiftId: string,
  executor: Queryable = getPool(),
): Promise<ShiftDetail | null> {
  return queryOne<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT} WHERE s.id = $1`,
    [shiftId],
    executor,
  );
}

export async function getShiftDetailForUpdate(
  shiftId: string,
  executor: Queryable,
): Promise<ShiftDetail | null> {
  // Lock the shift row first, then read the joined projection. `FOR UPDATE`
  // on the base table is what serialises two concurrent finalisations.
  const locked = await queryOne<{ id: string }>(
    "SELECT id FROM shifts WHERE id = $1 FOR UPDATE",
    [shiftId],
    executor,
  );
  if (!locked) return null;
  return getShiftDetail(shiftId, executor);
}

export interface ScheduleFilters {
  from?: Date;
  to?: Date;
  includePast?: boolean;
  limit?: number;
  offset?: number;
}

export async function listResidentSchedule(
  residentId: string,
  filters: ScheduleFilters = {},
  executor: Queryable = getPool(),
): Promise<ShiftDetail[]> {
  const values: unknown[] = [residentId];
  const where = [
    "sa.resident_id = $1",
    "sa.assignment_status = 'active'",
    "s.status <> 'cancelled'",
    PUBLISHED_ONLY,
  ];
  if (filters.from) {
    values.push(filters.from);
    where.push(`s.end_datetime >= $${values.length}`);
  } else if (!filters.includePast) {
    where.push("s.end_datetime >= now()");
  }
  if (filters.to) {
    values.push(filters.to);
    where.push(`s.start_datetime <= $${values.length}`);
  }
  values.push(Math.min(filters.limit ?? 100, 500));
  const limitIndex = values.length;
  values.push(filters.offset ?? 0);
  const offsetIndex = values.length;

  return query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY s.start_datetime ASC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    values,
    executor,
  );
}

/**
 * Shifts that were this resident's and are not any more.
 *
 * ## Why anything cares
 *
 * `listResidentSchedule` answers "what do you work", so a shift that changed
 * hands simply stops appearing — which is right for every screen in the
 * product, because a screen is re-read from scratch each time. It is wrong for
 * the calendar feed, which is not read but *synchronised*: a subscribed client
 * holds a copy, and clients differ on what a vanished `VEVENT` means. Google
 * Calendar in particular is content to keep showing one.
 *
 * The failure that produces is the one this product exists to prevent. A
 * resident gives away a Saturday, the app agrees they are off it, and their
 * phone goes on saying MICU 07:00 until somebody notices. They either turn up
 * to a shift that is not theirs or — far worse — decline something else
 * because their calendar says they are working.
 *
 * So a released shift is published as `STATUS:CANCELLED` rather than dropped,
 * which every client treats as an instruction to remove it. See
 * `buildCalendar`.
 *
 * ## What counts as released
 *
 * Held then not held — the ended assignment with no active one for the same
 * resident, which is exactly what the atomic switch writes — or still held but
 * cancelled outright by a scheduler. Both mean "your calendar is wrong".
 *
 * A resident who gives a shift away and later takes it back has an active
 * assignment again and is excluded, so the shift stays in the live feed and no
 * cancellation is published for it.
 */
export async function listReleasedShifts(
  residentId: string,
  filters: { from: Date; limit?: number },
  executor: Queryable = getPool(),
): Promise<ShiftDetail[]> {
  return query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE ${PUBLISHED_ONLY}
        AND s.end_datetime >= $2
        AND (
          (EXISTS (SELECT 1 FROM shift_assignments ended
                    WHERE ended.shift_id = s.id
                      AND ended.resident_id = $1
                      AND ended.assignment_status = 'ended')
           AND NOT EXISTS (SELECT 1 FROM shift_assignments held
                            WHERE held.shift_id = s.id
                              AND held.resident_id = $1
                              AND held.assignment_status = 'active'))
          OR (s.status = 'cancelled'
              AND EXISTS (SELECT 1 FROM shift_assignments held
                           WHERE held.shift_id = s.id
                             AND held.resident_id = $1
                             AND held.assignment_status = 'active'))
        )
      ORDER BY s.start_datetime ASC
      LIMIT $3`,
    [residentId, filters.from, Math.min(filters.limit ?? 200, 500)],
    executor,
  );
}

/**
 * Shifts used for rule evaluation: everything the resident holds in a window
 * around the trade. 45 days is comfortably wider than any configured rolling
 * window (28 days) plus shift length.
 */
export async function listScheduleWindow(
  residentId: string,
  centre: Date,
  executor: Queryable = getPool(),
  windowDays = 45,
): Promise<ShiftDetail[]> {
  const from = new Date(centre.getTime() - windowDays * 86_400_000);
  const to = new Date(centre.getTime() + windowDays * 86_400_000);
  return query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE sa.resident_id = $1
        AND sa.assignment_status = 'active'
        AND s.status <> 'cancelled'
        AND ${PUBLISHED_ONLY}
        AND s.end_datetime >= $2
        AND s.start_datetime <= $3
      ORDER BY s.start_datetime ASC`,
    [residentId, from, to],
    executor,
  );
}

/** All active assignments for a resident between two instants. */
export async function listScheduleRange(
  residentId: string,
  from: Date,
  to: Date,
  executor: Queryable = getPool(),
): Promise<ShiftDetail[]> {
  return query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE sa.resident_id = $1
        AND sa.assignment_status = 'active'
        AND s.status <> 'cancelled'
        AND ${PUBLISHED_ONLY}
        AND s.end_datetime >= $2
        AND s.start_datetime <= $3
      ORDER BY s.start_datetime ASC`,
    [residentId, from, to],
    executor,
  );
}

export interface ResidentRecord extends ResidentInfo {
  programId: string;
}

export async function getResidentInfo(
  residentId: string,
  executor: Queryable = getPool(),
): Promise<ResidentRecord | null> {
  const row = await queryOne<{
    id: string;
    user_id: string;
    program_id: string;
    pgy_level: number;
    credentials: string[];
    active: boolean;
    full_name: string;
    email: string;
    user_active: boolean;
  }>(
    `SELECT r.id, r.user_id, r.program_id, r.pgy_level, r.credentials, r.active,
            u.full_name, u.email, u.active AS user_active
       FROM residents r
       JOIN users u ON u.id = r.user_id
      WHERE r.id = $1`,
    [residentId],
    executor,
  );
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    programId: row.program_id,
    name: row.full_name,
    email: row.email,
    pgyLevel: row.pgy_level,
    credentials: row.credentials ?? [],
    active: row.active && row.user_active,
  };
}

export async function countCompletedTradesThisMonth(
  residentId: string,
  now: Date,
  timezone: string,
  executor: Queryable = getPool(),
): Promise<number> {
  const monthStart = DateTime.fromJSDate(now, { zone: timezone })
    .startOf("month")
    .toJSDate();
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM completed_trades
      WHERE (resident_a = $1 OR resident_b = $1)
        AND completed_at >= $2`,
    [residentId, monthStart],
    executor,
  );
  return Number(row?.count ?? 0);
}

export async function countOpenOffers(
  residentId: string,
  executor: Queryable = getPool(),
): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM trade_offers
      WHERE offering_resident_id = $1 AND status = 'pending'`,
    [residentId],
    executor,
  );
  return Number(row?.count ?? 0);
}

/**
 * Shifts a resident could offer in exchange for `targetShift`: shifts they
 * currently hold, that are tradeable, upcoming, not already posted or offered,
 * and not the target itself.
 */
/**
 * Every shift the resident could currently offer, without reference to a
 * particular posting.
 *
 * `listOfferableShifts` answers the same question for one target shift, and
 * calling it once per posting is how the trade board came to run a query per
 * row. This returns the set once so the caller can exclude the target in
 * memory — the only difference between the two is that one row.
 */
export async function listAllOfferableShifts(
  residentId: string,
  executor: Queryable = getPool(),
): Promise<ShiftDetail[]> {
  return query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE sa.resident_id = $1
        AND sa.assignment_status = 'active'
        AND ${PUBLISHED_ONLY}
        AND s.tradeable = true
        AND s.status IN ('scheduled', 'posted')
        AND s.start_datetime > now()
        AND (s.trade_deadline IS NULL OR s.trade_deadline > now())
        AND NOT EXISTS (
          SELECT 1 FROM trade_offers o
           WHERE o.offered_shift_id = s.id AND o.status IN ('pending', 'accepted')
        )
      ORDER BY s.start_datetime ASC
      LIMIT 200`,
    [residentId],
    executor,
  );
}

export async function listOfferableShifts(
  residentId: string,
  targetShiftId: string,
  executor: Queryable = getPool(),
): Promise<ShiftDetail[]> {
  return query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE sa.resident_id = $1
        AND sa.assignment_status = 'active'
        AND ${PUBLISHED_ONLY}
        AND s.id <> $2
        AND s.tradeable = true
        AND s.status IN ('scheduled', 'posted')
        AND s.start_datetime > now()
        AND (s.trade_deadline IS NULL OR s.trade_deadline > now())
        AND NOT EXISTS (
          SELECT 1 FROM trade_offers o
           WHERE o.offered_shift_id = s.id AND o.status IN ('pending', 'accepted')
        )
      ORDER BY s.start_datetime ASC
      LIMIT 200`,
    [residentId, targetShiftId],
    executor,
  );
}
