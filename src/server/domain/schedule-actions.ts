import { getPool, query, type Queryable } from "@/server/db/pool";
import type { ServiceRow, ShiftDetail } from "@/server/db/types";
import { SHIFT_DETAIL_SELECT } from "./schedule";

/**
 * The caller's own upcoming shifts that are actually postable right now:
 * assigned to them, tradeable, in the future, past no deadline, and not already
 * caught up in another trade. The "Post this shift" screen only ever offers
 * these, so a resident cannot start a flow that the server would reject.
 */
export async function listOfferableForPosting(
  residentId: string,
  executor: Queryable = getPool(),
): Promise<ShiftDetail[]> {
  return query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT}
      WHERE sa.resident_id = $1
        AND sa.assignment_status = 'active'
        AND s.status = 'scheduled'
        AND s.tradeable = true
        AND s.start_datetime > now()
        AND (s.trade_deadline IS NULL OR s.trade_deadline > now())
      ORDER BY s.start_datetime ASC
      LIMIT 100`,
    [residentId],
    executor,
  );
}

/**
 * Why a shift cannot be posted for trade right now, or null when it can be.
 * Lives here rather than in a component so that "now" is read outside render.
 */
export function describePostingBlock(
  shift: Pick<ShiftDetail, "tradeable" | "status" | "start_datetime" | "trade_deadline">,
  now: Date = new Date(),
): string | null {
  if (!shift.tradeable) return "Your program does not allow this shift to be switched.";
  if (shift.status === "cancelled") return "This shift has been cancelled.";
  if (shift.status === "completed") return "This shift has already been worked.";
  if (shift.start_datetime.getTime() <= now.getTime()) {
    return "This shift has already started.";
  }
  if (shift.trade_deadline && shift.trade_deadline.getTime() <= now.getTime()) {
    return "The deadline for switching this shift has passed.";
  }
  return null;
}

export async function listServices(
  programId: string,
  executor: Queryable = getPool(),
): Promise<ServiceRow[]> {
  return query<ServiceRow>(
    "SELECT * FROM services WHERE program_id = $1 AND active = true ORDER BY name",
    [programId],
    executor,
  );
}

export async function listRotations(programId: string) {
  return query<{ id: string; name: string }>(
    "SELECT id, name FROM rotations WHERE program_id = $1 AND active = true ORDER BY name",
    [programId],
  );
}

export async function listProgramResidents(programId: string) {
  return query<{
    id: string;
    full_name: string;
    email: string;
    pgy_level: number;
    active: boolean;
  }>(
    `SELECT r.id, u.full_name, u.email, r.pgy_level, r.active
       FROM residents r
       JOIN users u ON u.id = r.user_id
      WHERE r.program_id = $1
      ORDER BY r.pgy_level, u.full_name`,
    [programId],
  );
}
