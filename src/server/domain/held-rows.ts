import { query, queryOne, type Queryable } from "@/server/db/pool";
import { recordAudit } from "./audit";
import { placeShift, resolveRotationId, resolveServiceId } from "./shift-write";

/**
 * Import rows for people who have not joined yet.
 *
 * ## Why this exists
 *
 * A programme's block file names everybody on the block. On the day it is
 * imported, most of those people have never opened the app. The importer used
 * to refuse the whole file for exactly that reason — "these residents are not
 * in your program yet… invite them under Users first" — which made the correct
 * order invite-everybody-then-import, and made a single unrecognised name stop
 * a schedule that was otherwise fine.
 *
 * That order is the wrong way round for a beta. The administrator has the file
 * now; the residents arrive over the following fortnight. So a row naming
 * somebody who has not joined is *held*: parsed, validated, timezone-resolved
 * and stored, listed to the administrator as unmatched, and turned into real
 * shifts the moment that person enrolls. Nobody has to be invited before their
 * schedule can exist, and nobody lands on an empty screen.
 *
 * ## Matching a person to a row
 *
 * By email when the file has one, because an email address is exact.
 * Otherwise by name, which is not — so `matchKey` does the small amount of
 * normalising that a person does by eye: case, accents, punctuation, "Last,
 * First" against "First Last", a middle initial, a trailing degree.
 *
 * The one thing it deliberately does *not* do is guess. Two people whose keys
 * differ stay separate; a held row nobody claims stays held and stays visible
 * to the administrator, who can see the name the file used and fix the file.
 * A wrong match would attach one resident's call to another, which is the
 * worst outcome available here — far worse than a row that waits.
 */

/** A degree, title or generational suffix, none of which identify anybody. */
const NOISE_TOKENS = new Set([
  "dr",
  "md",
  "do",
  "mbbs",
  "phd",
  "rn",
  "np",
  "pa",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
]);

/**
 * The form two spellings of one name have in common.
 *
 * Tokens are sorted, which is what makes "Osei, Nadia" and "Nadia Osei" the
 * same key without having to know which convention a given file uses. A single
 * letter is dropped as a middle initial: "Nadia K Osei" and "Nadia Osei" are
 * one person in every file this has been pointed at.
 */
export function matchKey(name: string): string {
  const tokens = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining accents
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !NOISE_TOKENS.has(token));
  return [...new Set(tokens)].sort().join(" ");
}

export interface HeldRowInput {
  programId: string;
  residentName: string;
  email?: string;
  pgy?: number | null;
  date: string;
  start: Date;
  end: Date;
  serviceName: string;
  rotationName?: string;
  shiftType?: string;
  location?: string;
  statusHint?: string;
  importBatch: string;
}

export async function holdRow(
  input: HeldRowInput,
  executor?: Queryable,
): Promise<void> {
  await query(
    `INSERT INTO held_shift_rows
       (program_id, resident_name, match_key, email, pgy_level, date,
        start_datetime, end_datetime, service_name, rotation_name, shift_type,
        location, status_hint, import_batch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      input.programId,
      input.residentName,
      matchKey(input.residentName),
      (input.email ?? "").toLowerCase(),
      input.pgy ?? null,
      input.date,
      input.start,
      input.end,
      input.serviceName,
      input.rotationName ?? "",
      input.shiftType ?? "day",
      input.location ?? "",
      input.statusHint ?? "",
      input.importBatch,
    ],
    executor,
  );
}

export interface UnmatchedPerson {
  resident_name: string;
  match_key: string;
  email: string;
  pgy_level: number | null;
  shifts: number;
  first_date: string;
  last_date: string;
}

/**
 * Who the file named that the program does not have, with enough to recognise
 * them: the name as written, how many shifts are waiting, and over what dates.
 */
export async function listUnmatched(
  programId: string,
  executor?: Queryable,
): Promise<UnmatchedPerson[]> {
  return query<UnmatchedPerson>(
    `SELECT min(resident_name) AS resident_name,
            match_key,
            coalesce(max(nullif(email, '')), '') AS email,
            max(pgy_level) AS pgy_level,
            count(*)::int AS shifts,
            to_char(min(date), 'YYYY-MM-DD') AS first_date,
            to_char(max(date), 'YYYY-MM-DD') AS last_date
       FROM held_shift_rows
      WHERE program_id = $1 AND claimed_at IS NULL
      GROUP BY match_key
      ORDER BY min(resident_name)`,
    [programId],
    executor,
  );
}

export async function countUnmatched(
  programId: string,
  executor?: Queryable,
): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM held_shift_rows
      WHERE program_id = $1 AND claimed_at IS NULL`,
    [programId],
    executor,
  );
  return row?.count ?? 0;
}

/** Held rows an administrator recognises as nobody, discarded with a record. */
export async function discardHeldRows(
  programId: string,
  key: string,
  actor: { userId: string; label: string },
  executor?: Queryable,
): Promise<number> {
  const removed = await query<{ id: string }>(
    `DELETE FROM held_shift_rows
      WHERE program_id = $1 AND match_key = $2 AND claimed_at IS NULL
      RETURNING id`,
    [programId, key],
    executor,
  );
  if (removed.length > 0) {
    await recordAudit(
      {
        programId,
        actorUserId: actor.userId,
        actorLabel: actor.label,
        action: "schedule.held_rows_discarded",
        entityType: "held_shift_rows",
        newState: { matchKey: key, discarded: removed.length },
      },
      executor,
    );
  }
  return removed.length;
}

export interface ClaimResult {
  createdShifts: number;
  skippedExisting: number;
  claimedRows: number;
}

/**
 * Everything waiting for this person, turned into their schedule.
 *
 * Called the moment somebody enrolls, inside the same transaction that creates
 * their resident record — so the first screen they ever see already has their
 * block on it. That is the whole point: a resident who signs in to an empty app
 * has no reason to sign in again, and the programme's file has been sitting
 * there naming them the entire time.
 *
 * Rows are matched by email when the file had one for them, and by normalised
 * name otherwise. Both, not either: a file that listed somebody by name only
 * and a second file that listed them by address are the same person's shifts.
 *
 * The instants were resolved at import, in the programme's timezone, on the day
 * the file was read. They are copied through unchanged. Re-deriving them now
 * would interpret an August shift through whatever the clock is doing in
 * November, which is exactly the class of defect this product cannot have.
 */
export async function claimHeldRows(
  programId: string,
  resident: { id: string; name: string; email: string },
  client: Queryable,
): Promise<ClaimResult> {
  const key = matchKey(resident.name);
  const email = resident.email.toLowerCase();

  /* Locked, so two enrollments racing — the same person signing in on a phone
     and a laptop at once — cannot both turn one held row into a shift. */
  const held = await query<{
    id: string;
    date: string;
    start_datetime: Date;
    end_datetime: Date;
    service_name: string;
    rotation_name: string;
    shift_type: string;
    location: string;
    status_hint: string;
  }>(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, start_datetime, end_datetime,
            service_name, rotation_name, shift_type, location, status_hint
       FROM held_shift_rows
      WHERE program_id = $1
        AND claimed_at IS NULL
        AND ((match_key <> '' AND match_key = $2) OR (email <> '' AND email = $3))
      ORDER BY start_datetime
        FOR UPDATE SKIP LOCKED`,
    [programId, key, email],
    client,
  );

  let createdShifts = 0;
  let skippedExisting = 0;
  const serviceCache = new Map<string, string>();
  const rotationCache = new Map<string, string>();

  for (const row of held) {
    const service = await resolveServiceId(programId, row.service_name, client, serviceCache);
    let rotationId: string | null = null;
    if (row.rotation_name) {
      const rotation = await resolveRotationId(
        programId,
        row.rotation_name,
        client,
        rotationCache,
      );
      rotationId = rotation.id;
    }

    const outcome = await placeShift(
      {
        programId,
        serviceId: service.id,
        rotationId,
        residentId: resident.id,
        date: row.date,
        start: row.start_datetime,
        end: row.end_datetime,
        location: row.location,
        shiftType: row.shift_type,
        /* Held rows came from a file the programme supplied, and that is what
           they stay. A row the file called confirmed does not become confirmed
           by being claimed — the person claiming it is the resident, and a
           resident cannot vouch for their own schedule. */
        provenance: row.status_hint === "provisional" ? "provisional" : "imported",
      },
      client,
    );
    if (outcome === "duplicate") skippedExisting += 1;
    else createdShifts += 1;

    await query(
      `UPDATE held_shift_rows
          SET claimed_at = now(), claimed_by_resident = $2
        WHERE id = $1`,
      [row.id, resident.id],
      client,
    );
  }

  if (held.length > 0) {
    await recordAudit(
      {
        programId,
        actorLabel: "system",
        action: "schedule.held_rows_claimed",
        entityType: "resident",
        entityId: resident.id,
        newState: { claimedRows: held.length, createdShifts, skippedExisting },
      },
      client,
    );
  }

  return { createdShifts, skippedExisting, claimedRows: held.length };
}
