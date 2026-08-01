import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { formatShiftDate, formatShiftRange } from "./time";

/**
 * Draft and published schedules.
 *
 * ## The idea
 *
 * `shifts.schedule_version_id` is null for a live shift and set for a draft
 * one. **Null means published**, which is why nothing needed backfilling and
 * why every existing query kept its meaning: the schedule that existed before
 * this feature is exactly the set of shifts with no version.
 *
 * A draft is therefore a parallel set of shifts over the same dates, invisible
 * to residents, editable without consequence, and — because a database trigger
 * refuses a trade request against a versioned shift — impossible to trade
 * against by accident.
 *
 * ## Publishing
 *
 * Publishing replaces the live schedule **within the draft's window only**.
 * That is what makes it safe to publish one block without disturbing the rest
 * of the year, and it is why `period_start`/`period_end` are required rather
 * than derived from the shifts present: an empty draft over a window means
 * "clear this window", which is a real intention and must not be confused with
 * "this draft does nothing".
 *
 * Live shifts inside the window that are entangled in a trade are the one thing
 * publishing refuses to destroy. A resident who has posted a shift, or offered
 * on one, has a live commitment against a shift the publish would delete; the
 * publish stops and names them rather than silently cancelling somebody's
 * switch.
 */

export type ScheduleVersionStatus = "draft" | "published" | "archived";

export interface ScheduleVersion {
  id: string;
  program_id: string;
  name: string;
  status: ScheduleVersionStatus;
  period_start: Date;
  period_end: Date;
  block_structure_id: string | null;
  notes: string;
  created_by: string | null;
  created_by_name: string | null;
  published_by: string | null;
  published_by_name: string | null;
  published_at: Date | null;
  created_at: Date;
  shift_count: number;
}

const SELECT = `
  SELECT v.*, cu.full_name AS created_by_name, pu.full_name AS published_by_name,
         (SELECT count(*) FROM shifts s WHERE s.schedule_version_id = v.id)::int
           AS shift_count
    FROM schedule_versions v
    LEFT JOIN users cu ON cu.id = v.created_by
    LEFT JOIN users pu ON pu.id = v.published_by`;

export async function listScheduleVersions(
  programId: string,
): Promise<ScheduleVersion[]> {
  return query<ScheduleVersion>(
    `${SELECT} WHERE v.program_id = $1
      ORDER BY CASE v.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
               v.period_start DESC`,
    [programId],
  );
}

export async function getScheduleVersion(
  programId: string,
  id: string,
): Promise<ScheduleVersion | null> {
  return queryOne<ScheduleVersion>(`${SELECT} WHERE v.id = $1 AND v.program_id = $2`, [
    id,
    programId,
  ]);
}

export async function createScheduleVersion(
  context: AuthedContext,
  input: {
    name: string;
    periodStart: string;
    periodEnd: string;
    blockStructureId?: string | null;
    notes?: string;
    /** Start from the live schedule in this window rather than from nothing. */
    copyFromPublished?: boolean;
  },
): Promise<ScheduleVersion> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw validationFailed("Give the draft a name.");
  if (input.periodEnd < input.periodStart) {
    throw validationFailed("The period ends before it starts.");
  }

  return withTransaction(async (client) => {
    const created = (await queryOne<{ id: string }>(
      `INSERT INTO schedule_versions
         (program_id, name, period_start, period_end, block_structure_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        context.program.id,
        name,
        input.periodStart,
        input.periodEnd,
        input.blockStructureId ?? null,
        input.notes ?? "",
        context.user.id,
      ],
      client,
    ))!;

    if (input.copyFromPublished) {
      /* Copies the shifts but not their assignments' history, and deliberately
         not the trade state: a draft is a plan, and a plan does not inherit the
         fact that somebody once offered to swap one of its shifts. */
      await query(
        `INSERT INTO shifts
           (program_id, service_id, rotation_id, date, start_datetime, end_datetime,
            location, shift_type, required_pgy_min, required_pgy_max, tradeable,
            approval_required, trade_deadline, status, schedule_version_id)
         SELECT program_id, service_id, rotation_id, date, start_datetime, end_datetime,
                location, shift_type, required_pgy_min, required_pgy_max, tradeable,
                approval_required, trade_deadline, 'scheduled'::shift_status, $4
           FROM shifts
          WHERE program_id = $1 AND schedule_version_id IS NULL
            AND date >= $2 AND date <= $3 AND status <> 'cancelled'`,
        [context.program.id, input.periodStart, input.periodEnd, created.id],
        client,
      );

      /* Assignments are copied separately, because the draft's shifts have new
         ids and have to be matched back to the ones they came from.
         The matching is one-to-one via `row_number()`, and that is the whole
         difficulty. A service with three residents on at 07:00 produces three
         live shifts and three draft shifts that are identical on
         (service, start, end); joining on those columns alone is a cross join
         that gives every draft shift all three assignees, and the partial unique
         index on active assignments then rejects the insert. Numbering both
         sides in the same deterministic order pairs them off exactly. */
      await query(
        `WITH live AS (
           SELECT s.id, s.service_id, s.start_datetime, s.end_datetime,
                  a.resident_id,
                  row_number() OVER (
                    PARTITION BY s.service_id, s.start_datetime, s.end_datetime
                    ORDER BY s.id
                  ) AS slot
             FROM shifts s
             JOIN shift_assignments a
               ON a.shift_id = s.id AND a.assignment_status = 'active'
            WHERE s.program_id = $1 AND s.schedule_version_id IS NULL
              AND s.date >= $2 AND s.date <= $3 AND s.status <> 'cancelled'
         ),
         draft AS (
           SELECT id, service_id, start_datetime, end_datetime,
                  row_number() OVER (
                    PARTITION BY service_id, start_datetime, end_datetime
                    ORDER BY id
                  ) AS slot
             FROM shifts
            WHERE schedule_version_id = $4
         )
         INSERT INTO shift_assignments (shift_id, resident_id)
         SELECT draft.id, live.resident_id
           FROM draft
           JOIN live
             ON live.service_id = draft.service_id
            AND live.start_datetime = draft.start_datetime
            AND live.end_datetime = draft.end_datetime
            AND live.slot = draft.slot`,
        [context.program.id, input.periodStart, input.periodEnd, created.id],
        client,
      );
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "schedule_version.created",
        entityType: "schedule_version",
        entityId: created.id,
        newState: {
          name,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          copied: Boolean(input.copyFromPublished),
        },
      },
      client,
    );

    return (await getVersionInTransaction(client, context.program.id, created.id))!;
  });
}

async function getVersionInTransaction(
  client: PoolClient,
  programId: string,
  id: string,
): Promise<ScheduleVersion | null> {
  return queryOne<ScheduleVersion>(
    `${SELECT} WHERE v.id = $1 AND v.program_id = $2`,
    [id, programId],
    client,
  );
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export interface ShiftSummary {
  id: string;
  service_name: string;
  start_datetime: Date;
  end_datetime: Date;
  location: string;
  resident_id: string | null;
  resident_name: string | null;
}

export interface ScheduleDiff {
  added: ShiftSummary[];
  removed: ShiftSummary[];
  reassigned: Array<{
    shift: ShiftSummary;
    from: string | null;
    to: string | null;
  }>;
  unchanged: number;
  /** Live shifts in the window that a resident has a live trade against. */
  blockers: Array<{ shift: ShiftSummary; reason: string }>;
}

/**
 * What publishing this draft would change.
 *
 * Shown before publication, because "publish" is otherwise a button that
 * silently rewrites a month of people's lives. A scheduler who can see that
 * three shifts move and one resident changes service will publish confidently;
 * one who cannot will either not publish or publish and find out.
 *
 * Shifts are matched between the draft and the live schedule by **service plus
 * exact start and end instants** rather than by id, because a draft's shifts
 * are copies with new ids. Two shifts on the same service at the same moment
 * are the same shift for this purpose; that they might be two genuinely
 * distinct slots is handled by comparing the *sets* of assignees.
 */
export async function diffScheduleVersion(
  programId: string,
  versionId: string,
  timezone: string,
): Promise<ScheduleDiff> {
  const version = await getScheduleVersion(programId, versionId);
  if (!version) throw notFound("That draft schedule no longer exists.");

  const draft = await loadShifts(programId, { versionId });
  const live = await loadShifts(programId, {
    versionId: null,
    from: version.period_start,
    to: version.period_end,
  });

  const key = (shift: ShiftSummary) =>
    `${shift.service_name}|${shift.start_datetime.toISOString()}|${shift.end_datetime.toISOString()}`;

  const liveByKey = new Map<string, ShiftSummary[]>();
  for (const shift of live) {
    const list = liveByKey.get(key(shift)) ?? [];
    list.push(shift);
    liveByKey.set(key(shift), list);
  }

  const added: ShiftSummary[] = [];
  const reassigned: ScheduleDiff["reassigned"] = [];
  let unchanged = 0;
  const matchedLive = new Set<string>();

  /* Two passes, and the order is the whole correctness of the diff.
   *
   * Within a (service, start, end) group there are often several shifts — three
   * residents on wards at 07:00 is one group of three. Pairing them in
   * arbitrary order and comparing assignees reports a reassignment whenever the
   * two orderings happen to differ, which for a draft copied verbatim from the
   * published schedule meant *every* shift in every multi-person group came
   * back as "reassigned". A diff that cries wolf on an unchanged copy is worse
   * than no diff: it is the screen a scheduler consults precisely to decide
   * whether publishing is safe.
   *
   * So: first match every draft shift to a live shift held by the *same
   * resident*. Those are unchanged by definition, whatever order they came back
   * in. Only what is left over — genuinely different people — is paired
   * positionally and reported as a reassignment.
   */
  const unmatchedDraft: ShiftSummary[] = [];
  for (const shift of draft) {
    const candidates = liveByKey.get(key(shift)) ?? [];
    const sameResident = candidates.find(
      (candidate) =>
        !matchedLive.has(candidate.id) && candidate.resident_id === shift.resident_id,
    );
    if (sameResident) {
      matchedLive.add(sameResident.id);
      unchanged += 1;
    } else {
      unmatchedDraft.push(shift);
    }
  }

  for (const shift of unmatchedDraft) {
    const candidates = liveByKey.get(key(shift)) ?? [];
    const match = candidates.find((candidate) => !matchedLive.has(candidate.id));
    if (!match) {
      added.push(shift);
      continue;
    }
    matchedLive.add(match.id);
    reassigned.push({ shift, from: match.resident_name, to: shift.resident_name });
  }

  const removed = live.filter((shift) => !matchedLive.has(shift.id));

  /* Anything that would be deleted while somebody has a live trade against it.
     Reported rather than merely counted, because the resolution is a
     conversation with a named person, not a number. */
  const blockers: ScheduleDiff["blockers"] = [];
  if (removed.length > 0) {
    const entangled = await query<{ shift_id: string; reason: string }>(
      `SELECT s.id AS shift_id,
              CASE WHEN r.id IS NOT NULL THEN 'posted for trade'
                   ELSE 'offered in a trade' END AS reason
         FROM shifts s
         LEFT JOIN trade_requests r
           ON r.source_shift_id = s.id
          AND r.status IN ('open','offer_pending','accepted','pending_approval','approved')
         LEFT JOIN trade_offers o
           ON o.offered_shift_id = s.id AND o.status IN ('pending','accepted')
        WHERE s.id = ANY($1::uuid[]) AND (r.id IS NOT NULL OR o.id IS NOT NULL)`,
      [removed.map((shift) => shift.id)],
    );
    const byId = new Map(removed.map((shift) => [shift.id, shift]));
    for (const row of entangled) {
      const shift = byId.get(row.shift_id);
      if (shift) {
        blockers.push({
          shift,
          reason: `${shift.resident_name ?? "Somebody"} has this ${row.reason} — ` +
            `${formatShiftDate(shift.start_datetime, timezone)} ` +
            `${formatShiftRange(shift.start_datetime, shift.end_datetime, timezone)}.`,
        });
      }
    }
  }

  return { added, removed, reassigned, unchanged, blockers };
}

async function loadShifts(
  programId: string,
  options: { versionId: string | null; from?: Date; to?: Date },
): Promise<ShiftSummary[]> {
  const values: unknown[] = [programId];
  let where = "s.program_id = $1 AND s.status <> 'cancelled'";
  if (options.versionId === null) {
    where += " AND s.schedule_version_id IS NULL";
  } else {
    values.push(options.versionId);
    where += ` AND s.schedule_version_id = $${values.length}`;
  }
  if (options.from) {
    values.push(options.from);
    where += ` AND s.date >= $${values.length}`;
  }
  if (options.to) {
    values.push(options.to);
    where += ` AND s.date <= $${values.length}`;
  }

  return query<ShiftSummary>(
    `SELECT s.id, sv.name AS service_name, s.start_datetime, s.end_datetime, s.location,
            a.resident_id, u.full_name AS resident_name
       FROM shifts s
       JOIN services sv ON sv.id = s.service_id
       LEFT JOIN shift_assignments a
         ON a.shift_id = s.id AND a.assignment_status = 'active'
       LEFT JOIN residents r ON r.id = a.resident_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE ${where}
      ORDER BY s.start_datetime, sv.name`,
    values,
  );
}

/**
 * Makes the draft the live schedule for its window.
 *
 * One transaction, and it refuses rather than damages: if a live shift in the
 * window is entangled in a trade, publishing stops and names it. The
 * alternative — cancelling those trades as a side effect of publishing — takes
 * a switch two residents have agreed on and destroys it without either of them
 * being asked.
 */
export async function publishScheduleVersion(
  context: AuthedContext,
  versionId: string,
  options: { force?: boolean } = {},
): Promise<{ published: number; replaced: number }> {
  return withTransaction(async (client) => {
    const version = await queryOne<ScheduleVersion>(
      "SELECT * FROM schedule_versions WHERE id = $1 AND program_id = $2 FOR UPDATE",
      [versionId, context.program.id],
      client,
    );
    if (!version) throw notFound("That draft schedule no longer exists.");
    if (version.status !== "draft") {
      throw conflict(
        version.status === "published"
          ? "This schedule has already been published."
          : "This schedule was archived and can no longer be published.",
      );
    }

    const entangled = await query<{ id: string; name: string }>(
      `SELECT DISTINCT s.id, u.full_name AS name
         FROM shifts s
         LEFT JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
         LEFT JOIN residents r ON r.id = a.resident_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE s.program_id = $1 AND s.schedule_version_id IS NULL
          AND s.date >= $2 AND s.date <= $3
          AND (
            EXISTS (SELECT 1 FROM trade_requests tr
                     WHERE tr.source_shift_id = s.id
                       AND tr.status IN ('open','offer_pending','accepted','pending_approval','approved'))
            OR EXISTS (SELECT 1 FROM trade_offers o
                        WHERE o.offered_shift_id = s.id AND o.status IN ('pending','accepted'))
          )`,
      [context.program.id, version.period_start, version.period_end],
      client,
    );

    if (entangled.length > 0 && !options.force) {
      const names = [...new Set(entangled.map((row) => row.name).filter(Boolean))];
      throw conflict(
        `${entangled.length} shift(s) in this period are part of a live switch` +
          (names.length ? ` involving ${names.join(", ")}` : "") +
          ". Publishing would cancel those switches. Resolve them first, or publish with override.",
      );
    }

    // Replace the window: the live shifts go, the draft's shifts become live.
    const replaced = await query<{ id: string }>(
      `DELETE FROM shifts
        WHERE program_id = $1 AND schedule_version_id IS NULL
          AND date >= $2 AND date <= $3
        RETURNING id`,
      [context.program.id, version.period_start, version.period_end],
      client,
    );

    const published = await query<{ id: string }>(
      `UPDATE shifts SET schedule_version_id = NULL
        WHERE schedule_version_id = $1
        RETURNING id`,
      [versionId],
      client,
    );

    await query(
      `UPDATE schedule_versions
          SET status = 'published', published_by = $2, published_at = now()
        WHERE id = $1`,
      [versionId, context.user.id],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "schedule_version.published",
        entityType: "schedule_version",
        entityId: versionId,
        previousState: { status: "draft", replacedShifts: replaced.length },
        newState: { status: "published", publishedShifts: published.length },
        reason: options.force ? "Published with override over live switches." : null,
      },
      client,
    );

    return { published: published.length, replaced: replaced.length };
  });
}

/** Throws the draft away. Its shifts go with it — they were never live. */
export async function discardScheduleVersion(
  context: AuthedContext,
  versionId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const version = await queryOne<ScheduleVersion>(
      "SELECT * FROM schedule_versions WHERE id = $1 AND program_id = $2 FOR UPDATE",
      [versionId, context.program.id],
      client,
    );
    if (!version) throw notFound("That draft schedule no longer exists.");
    if (version.status === "published") {
      throw conflict(
        "A published schedule cannot be discarded — residents are working it. " +
          "Create a new draft to change it.",
      );
    }

    // ON DELETE CASCADE takes the draft's shifts with it.
    await query("DELETE FROM schedule_versions WHERE id = $1", [versionId], client);

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "schedule_version.discarded",
        entityType: "schedule_version",
        entityId: versionId,
        previousState: { name: version.name, status: version.status },
      },
      client,
    );
  });
}

// ---------------------------------------------------------------------------
// Editing a draft
// ---------------------------------------------------------------------------

/**
 * Shifts in a draft, for editing.
 *
 * Separate from the live schedule editor in `admin.ts` on purpose. That one
 * revalidates trades, invalidates offers and notifies people, because changing
 * a live shift changes somebody's week. A draft shift has none of those
 * consequences — nobody can see it, nobody can trade it — so editing one is
 * cheap, and treating it as expensive would make building a schedule feel like
 * defusing a bomb.
 *
 * That asymmetry is the whole value of drafts, and it is why these functions
 * refuse to touch a shift with no version rather than quietly falling through
 * to the live path.
 */
export interface DraftShift {
  id: string;
  service_id: string;
  service_name: string;
  start_datetime: Date;
  end_datetime: Date;
  location: string;
  resident_id: string | null;
  resident_name: string | null;
}

export async function listDraftShifts(
  programId: string,
  versionId: string,
  options: { limit?: number } = {},
): Promise<DraftShift[]> {
  return query<DraftShift>(
    `SELECT s.id, s.service_id, sv.name AS service_name, s.start_datetime,
            s.end_datetime, s.location, a.resident_id, u.full_name AS resident_name
       FROM shifts s
       JOIN services sv ON sv.id = s.service_id
       JOIN schedule_versions v ON v.id = s.schedule_version_id
       LEFT JOIN shift_assignments a
         ON a.shift_id = s.id AND a.assignment_status = 'active'
       LEFT JOIN residents r ON r.id = a.resident_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE s.schedule_version_id = $1 AND v.program_id = $2
      ORDER BY s.start_datetime, sv.name
      LIMIT $3`,
    [versionId, programId, Math.min(options.limit ?? 200, 500)],
  );
}

/**
 * Reassigns a draft shift, or clears it.
 *
 * `residentId: null` means "nobody", which is a legitimate intermediate state
 * while building a schedule and is exactly what the dashboard's "shifts with
 * nobody on them" count is for. Refusing it would force a scheduler to park
 * people on shifts they are not meant to work.
 */
export async function assignDraftShift(
  context: AuthedContext,
  versionId: string,
  shiftId: string,
  residentId: string | null,
): Promise<void> {
  await withTransaction(async (client) => {
    const shift = await queryOne<{ id: string; status: string }>(
      `SELECT s.id, v.status::text AS status
         FROM shifts s
         JOIN schedule_versions v ON v.id = s.schedule_version_id
        WHERE s.id = $1 AND s.schedule_version_id = $2 AND v.program_id = $3
        FOR UPDATE OF s`,
      [shiftId, versionId, context.program.id],
      client,
    );
    /* Not found rather than forbidden, and deliberately also the answer for a
       *published* shift: this endpoint is not a back door into the live
       schedule, and saying "that is published" would invite trying. */
    if (!shift) throw notFound("That shift is not part of this draft.");
    /* Unreachable today — publishing detaches the version's shifts, so a
       published version owns none and the query above already found nothing.
       Kept as an invariant: if that ever changes, this refuses rather than
       quietly editing a schedule residents are working. */
    if (shift.status !== "draft") {
      throw conflict("This schedule has been published and can no longer be edited here.");
    }

    if (residentId) {
      const resident = await queryOne<{ id: string; name: string; schedulable: boolean }>(
        `SELECT r.id, u.full_name AS name, r.schedulable
           FROM residents r JOIN users u ON u.id = r.user_id
          WHERE r.id = $1 AND r.program_id = $2 AND r.active = true`,
        [residentId, context.program.id],
        client,
      );
      if (!resident) throw notFound("That resident is not in your program.");
      /* Refused rather than warned. Assigning somebody on parental leave is
         not a judgement call a scheduler makes deliberately from this screen —
         it is the wrong row in a long list, and the cost is discovering in
         three weeks that a shift has nobody who can actually work it. */
      if (!resident.schedulable) {
        throw validationFailed(
          `${resident.name} is marked as not available to schedule. ` +
            "Change that on the roster first if they are back.",
        );
      }
    }

    await query(
      `UPDATE shift_assignments SET assignment_status = 'ended', ended_at = now()
        WHERE shift_id = $1 AND assignment_status = 'active'`,
      [shiftId],
      client,
    );
    if (residentId) {
      await query(
        "INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)",
        [shiftId, residentId],
        client,
      );
    }
  });
}

/** Removes a shift from a draft. The live schedule is untouched. */
export async function removeDraftShift(
  context: AuthedContext,
  versionId: string,
  shiftId: string,
): Promise<void> {
  const removed = await query<{ id: string }>(
    `DELETE FROM shifts s
      USING schedule_versions v
      WHERE s.schedule_version_id = v.id
        AND s.id = $1 AND s.schedule_version_id = $2
        AND v.program_id = $3 AND v.status = 'draft'
      RETURNING s.id`,
    [shiftId, versionId, context.program.id],
  );
  if (removed.length === 0) {
    throw notFound("That shift is not part of this draft, or the draft has been published.");
  }
}
