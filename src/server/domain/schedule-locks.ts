import { query, queryOne } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import type { Lock } from "./generator/types";

/**
 * What regeneration must not touch.
 *
 * A scheduler generates a month, reads the report, and then does the part no
 * generator can do: puts the right person on the transplant service because of
 * a conversation last week, moves somebody's night float because their partner
 * is due. Then they press generate again — for a better seed, or because a
 * coverage requirement changed — and without locks they lose all of it.
 *
 * The generator already accepted locks as an argument. This is where they live
 * between two runs, which is the difference between a feature and a parameter.
 *
 * ## Why a lock is not a flag on the shift
 *
 * Three of the five kinds do not name a shift at all. Locking a resident, a
 * cohort or a service is locking something that is not a row in `shifts`, and
 * even for the two that are, regeneration **deletes and recreates** the draft's
 * unlocked shifts — a per-shift flag would go with them. Rows keyed by what the
 * scheduler pointed at survive that.
 *
 * ## Why a lock can dangle
 *
 * `target_id` is not a foreign key, because the four kinds point into four
 * tables. So a lock can outlive its target: a service is deleted, a resident
 * leaves. `listLocks` resolves names and reports what no longer resolves rather
 * than silently protecting nothing — a lock that quietly stopped applying is
 * how a scheduler loses the placement they were most careful about.
 */

export type LockKind = Lock["kind"];

export const LOCK_KINDS: LockKind[] = [
  "assignment",
  "resident",
  "cohort",
  "service",
  "date",
];

export interface ScheduleLock {
  id: string;
  kind: LockKind;
  target_id: string | null;
  target_date: string | null;
  reason: string;
  created_by_name: string | null;
  created_at: Date;
  /** Resolved from whichever table the kind points at. Null when it no longer exists. */
  target_label: string | null;
}

/**
 * Locks on a draft, with each target's current name.
 *
 * One query per kind would be four round trips for a list that is nearly always
 * short; one query with four left joins is one round trip and reads as what it
 * is — "whichever of these tables this row points into".
 */
export async function listLocks(
  programId: string,
  versionId: string,
): Promise<ScheduleLock[]> {
  return query<ScheduleLock>(
    `SELECT l.id, l.kind::text AS kind, l.target_id, l.target_date::text AS target_date,
            l.reason, u.full_name AS created_by_name, l.created_at,
            CASE l.kind
              WHEN 'resident'   THEN ru.full_name
              WHEN 'cohort'     THEN c.label
              WHEN 'service'    THEN s.name
              WHEN 'assignment' THEN ru.full_name
              ELSE NULL
            END AS target_label
       FROM schedule_version_locks l
       JOIN schedule_versions v ON v.id = l.version_id
       LEFT JOIN users u ON u.id = l.created_by
       LEFT JOIN residents r ON r.id = l.target_id
       LEFT JOIN users ru ON ru.id = r.user_id
       LEFT JOIN cohorts c ON c.id = l.target_id
       LEFT JOIN services s ON s.id = l.target_id
      WHERE l.version_id = $1 AND v.program_id = $2
      ORDER BY l.kind, l.created_at`,
    [versionId, programId],
  );
}

export interface LockInput {
  kind: LockKind;
  targetId?: string | null;
  targetDate?: string | null;
  reason?: string;
}

export async function addLock(
  context: AuthedContext,
  versionId: string,
  input: LockInput,
): Promise<ScheduleLock> {
  const version = await queryOne<{ id: string; status: string }>(
    `SELECT id, status::text AS status FROM schedule_versions
      WHERE id = $1 AND program_id = $2`,
    [versionId, context.program.id],
  );
  if (!version) throw notFound("That draft schedule no longer exists.");
  if (version.status !== "draft") {
    /* Locks protect a draft from regeneration. A published schedule is not
       regenerated, so a lock on one would be a control that does nothing —
       which is worse than a control that is absent. */
    throw validationFailed("This schedule has been published. There is nothing left to lock.");
  }

  if (input.kind === "date" && !input.targetDate) {
    throw validationFailed("Say which date to lock.");
  }
  if (input.kind !== "date" && !input.targetId) {
    throw validationFailed("Say what to lock.");
  }
  if (input.kind === "assignment" && !input.targetDate) {
    /* An assignment lock is "this person, on this day, stays where they are".
       Keyed by person and day rather than by shift id because regeneration
       destroys shift ids and would take the lock with them. */
    throw validationFailed("Say which day of theirs to lock.");
  }

  const created = await queryOne<{ id: string }>(
    `INSERT INTO schedule_version_locks
       (version_id, kind, target_id, target_date, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      versionId,
      input.kind,
      input.targetId ?? null,
      input.targetDate ?? null,
      (input.reason ?? "").trim(),
      context.user.id,
    ],
  );

  /* Locking the same thing twice is a no-op rather than an error: a scheduler
     tapping a padlock that is already closed meant "keep this locked", and an
     error message would be a correction of something they did not get wrong. */
  const row = created
    ? (await listLocks(context.program.id, versionId)).find((l) => l.id === created.id)!
    : (await listLocks(context.program.id, versionId)).find(
        (l) =>
          l.kind === input.kind &&
          l.target_id === (input.targetId ?? null) &&
          l.target_date === (input.targetDate ?? null),
      )!;

  if (created) {
    await recordAudit({
      programId: context.program.id,
      actorUserId: context.user.id,
      actorLabel: context.user.email,
      action: "schedule_version.locked",
      entityType: "schedule_version",
      entityId: versionId,
      newState: {
        kind: input.kind,
        target: row?.target_label ?? input.targetDate ?? input.targetId,
        reason: input.reason ?? "",
      },
    });
  }

  return row;
}

export async function removeLock(
  context: AuthedContext,
  versionId: string,
  lockId: string,
): Promise<void> {
  const removed = await query<{ id: string }>(
    `DELETE FROM schedule_version_locks l
      USING schedule_versions v
      WHERE l.version_id = v.id AND l.id = $1 AND l.version_id = $2
        AND v.program_id = $3
      RETURNING l.id`,
    [lockId, versionId, context.program.id],
  );
  if (removed.length === 0) throw notFound("That lock no longer exists.");

  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "schedule_version.unlocked",
    entityType: "schedule_version",
    entityId: versionId,
    previousState: { lockId },
  });
}

/**
 * The stored locks, as the generator's own type.
 *
 * An `assignment` lock is stored as a person and a day, and the generator wants
 * a shift id — so this resolves it against the draft as it stands. A lock whose
 * shift no longer exists resolves to nothing and is dropped: the alternative is
 * handing the generator an id it cannot find, which it would either ignore
 * silently or fail on, and neither is better than the lock simply not applying
 * to a shift that is gone.
 */
export async function locksForGeneration(
  programId: string,
  versionId: string,
): Promise<Lock[]> {
  const rows = await listLocks(programId, versionId);
  const assignmentLocks = rows.filter((row) => row.kind === "assignment");

  const shiftByKey = new Map<string, string>();
  if (assignmentLocks.length > 0) {
    const shifts = await query<{ id: string; resident_id: string; date: string }>(
      `SELECT s.id, a.resident_id, s.date::text AS date
         FROM shifts s
         JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1`,
      [versionId],
    );
    for (const shift of shifts) {
      shiftByKey.set(`${shift.resident_id}|${shift.date}`, shift.id);
    }
  }

  const locks: Lock[] = [];
  for (const row of rows) {
    switch (row.kind) {
      case "assignment": {
        const shiftId = shiftByKey.get(`${row.target_id}|${row.target_date}`);
        if (shiftId) locks.push({ kind: "assignment", shiftId });
        break;
      }
      case "resident":
        if (row.target_id) locks.push({ kind: "resident", residentId: row.target_id });
        break;
      case "cohort":
        if (row.target_id) locks.push({ kind: "cohort", cohortId: row.target_id });
        break;
      case "service":
        if (row.target_id) locks.push({ kind: "service", serviceId: row.target_id });
        break;
      case "date":
        if (row.target_date) locks.push({ kind: "date", date: row.target_date });
        break;
    }
  }
  return locks;
}
