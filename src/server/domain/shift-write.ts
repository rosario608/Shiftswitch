import { query, queryOne, type Queryable } from "@/server/db/pool";

/**
 * Putting a shift into the schedule.
 *
 * Its own module because three callers need exactly this and must not drift
 * apart: the importer writing a programme's block, `./held-rows.ts` turning the
 * rows that were waiting for somebody into their schedule the moment they
 * enroll, and a resident entering their own week by hand.
 *
 * A resident who joins on the second Tuesday must get exactly the shifts the
 * file gave them, produced by exactly the code that would have produced them on
 * the first — which means one implementation, not two that agree today.
 */

/** The service of that name in this program, creating it if the file is the first to mention it. */
export async function resolveServiceId(
  programId: string,
  name: string,
  client: Queryable,
  cache?: Map<string, string>,
): Promise<{ id: string; created: boolean }> {
  const key = name.toLowerCase();
  const cached = cache?.get(key);
  if (cached) return { id: cached, created: false };

  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM services WHERE program_id = $1 AND lower(name) = $2",
    [programId, key],
    client,
  );
  if (existing) {
    cache?.set(key, existing.id);
    return { id: existing.id, created: false };
  }
  const created = await queryOne<{ id: string }>(
    "INSERT INTO services (program_id, name) VALUES ($1, $2) RETURNING id",
    [programId, name],
    client,
  );
  cache?.set(key, created!.id);
  return { id: created!.id, created: true };
}

export async function resolveRotationId(
  programId: string,
  name: string,
  client: Queryable,
  cache?: Map<string, string>,
): Promise<{ id: string; created: boolean }> {
  const key = name.toLowerCase();
  const cached = cache?.get(key);
  if (cached) return { id: cached, created: false };

  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM rotations WHERE program_id = $1 AND lower(name) = $2",
    [programId, key],
    client,
  );
  if (existing) {
    cache?.set(key, existing.id);
    return { id: existing.id, created: false };
  }
  const created = await queryOne<{ id: string }>(
    "INSERT INTO rotations (program_id, name) VALUES ($1, $2) RETURNING id",
    [programId, name],
    client,
  );
  cache?.set(key, created!.id);
  return { id: created!.id, created: true };
}

export type ShiftProvenance =
  | "provisional"
  | "self_reported"
  | "imported"
  | "confirmed";

export interface PlaceShiftInput {
  programId: string;
  serviceId: string;
  rotationId?: string | null;
  residentId: string;
  date: string;
  start: Date;
  end: Date;
  location?: string;
  shiftType?: string;
  provenance: ShiftProvenance;
  positionId?: string | null;
  confirmedBy?: string | null;
}

/**
 * One shift, assigned to one resident, unless they already have it.
 *
 * The duplicate check is on (program, service, start, resident) rather than on
 * anything about the file, so importing the same block twice is a no-op and a
 * resident who enrolls after a second import does not receive their block
 * twice. Re-running an import is something a coordinator does when the first
 * one only half-worked, and it has to be safe.
 */
export async function placeShift(
  input: PlaceShiftInput,
  client: Queryable,
): Promise<"created" | "duplicate"> {
  const duplicate = await queryOne<{ id: string }>(
    `SELECT s.id FROM shifts s
       JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
      WHERE s.program_id = $1 AND s.service_id = $2 AND s.start_datetime = $3
        AND sa.resident_id = $4`,
    [input.programId, input.serviceId, input.start, input.residentId],
    client,
  );
  if (duplicate) return "duplicate";

  const shift = await queryOne<{ id: string }>(
    `INSERT INTO shifts
       (program_id, service_id, rotation_id, date, start_datetime, end_datetime,
        location, shift_type, provenance, position_id, confirmed_by, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [
      input.programId,
      input.serviceId,
      input.rotationId ?? null,
      input.date,
      input.start,
      input.end,
      input.location ?? "",
      input.shiftType ?? "day",
      input.provenance,
      input.positionId ?? null,
      input.confirmedBy ?? null,
    ],
    client,
  );
  await query(
    "INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)",
    [shift!.id, input.residentId],
    client,
  );
  return "created";
}
