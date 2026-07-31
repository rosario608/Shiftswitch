import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";

/**
 * Cohorts: groups within a PGY class that move through the year together.
 *
 * In a 4+4 programme each class splits into paired cohorts that alternate —
 * while A is on wards, B is in clinic — so that the ambulatory clinic is always
 * staffed and the wards always covered. The pairing is what makes the pattern
 * work, and it is the thing a scheduler most needs to see.
 *
 * Pairing is a **self-reference**, `paired_cohort_id`, kept reciprocal by this
 * module. Two cohorts that alternate point at each other. A programme that does
 * not pair leaves it null. A programme rotating three groups chains them
 * A→B→C→A. None of that is a schema change, and none of it assumes two.
 *
 * Membership is a table, not a column on `residents`, because it carries dates.
 * A resident who changes cohort in January — parental leave, remediation, an
 * off-cycle start — has memberships in two cohorts, and September's schedule
 * must still be able to say which one they were in *then*.
 */

export interface Cohort {
  id: string;
  program_id: string;
  label: string;
  pgy_level: number;
  start_date: Date | null;
  end_date: Date | null;
  paired_cohort_id: string | null;
  paired_cohort_label: string | null;
  notes: string;
  active: boolean;
  member_count: number;
  created_at: Date;
}

export interface CohortMember {
  id: string;
  cohort_id: string;
  resident_id: string;
  resident_name: string;
  pgy_level: number;
  start_date: Date | null;
  end_date: Date | null;
  notes: string;
}

const SELECT = `
  SELECT c.*, p.label AS paired_cohort_label,
         (SELECT count(*) FROM cohort_members m WHERE m.cohort_id = c.id)::int
           AS member_count
    FROM cohorts c
    LEFT JOIN cohorts p ON p.id = c.paired_cohort_id`;

export async function listCohorts(
  programId: string,
  options: { includeInactive?: boolean } = {},
): Promise<Cohort[]> {
  const where = options.includeInactive
    ? "c.program_id = $1"
    : "c.program_id = $1 AND c.active = true";
  return query<Cohort>(
    `${SELECT} WHERE ${where} ORDER BY c.pgy_level, lower(c.label)`,
    [programId],
  );
}

export async function listCohortMembers(
  programId: string,
  cohortId: string,
): Promise<CohortMember[]> {
  return query<CohortMember>(
    `SELECT m.*, u.full_name AS resident_name, r.pgy_level
       FROM cohort_members m
       JOIN cohorts c ON c.id = m.cohort_id
       JOIN residents r ON r.id = m.resident_id
       JOIN users u ON u.id = r.user_id
      WHERE m.cohort_id = $1 AND c.program_id = $2
      ORDER BY u.full_name`,
    [cohortId, programId],
  );
}

export interface CohortInput {
  label: string;
  pgyLevel: number;
  startDate?: string | null;
  endDate?: string | null;
  pairedCohortId?: string | null;
  notes?: string;
  active?: boolean;
}

export async function createCohort(
  context: AuthedContext,
  input: CohortInput,
): Promise<Cohort> {
  const label = input.label.trim().replace(/\s+/g, " ");
  if (!label) throw validationFailed("Give the cohort a label.");
  if (!Number.isInteger(input.pgyLevel) || input.pgyLevel < 1 || input.pgyLevel > 10) {
    throw validationFailed("Choose a PGY level between 1 and 10.");
  }
  assertDateOrder(input.startDate, input.endDate);

  return withTransaction(async (client) => {
    await query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`cohort:${context.program.id}:${label.toLowerCase()}`],
      client,
    );

    const clash = await queryOne<{ label: string }>(
      "SELECT label FROM cohorts WHERE program_id = $1 AND lower(label) = lower($2)",
      [context.program.id, label],
      client,
    );
    if (clash) {
      throw conflict(`Your program already has a cohort called "${clash.label}".`);
    }

    const created = (await queryOne<{ id: string }>(
      `INSERT INTO cohorts (program_id, label, pgy_level, start_date, end_date, notes, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        context.program.id,
        label,
        input.pgyLevel,
        input.startDate ?? null,
        input.endDate ?? null,
        input.notes ?? "",
        input.active ?? true,
      ],
      client,
    ))!;

    if (input.pairedCohortId) {
      await pairInTransaction(client, context.program.id, created.id, input.pairedCohortId);
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "cohort.created",
        entityType: "cohort",
        entityId: created.id,
        newState: { label, pgyLevel: input.pgyLevel },
      },
      client,
    );

    return (await queryOne<Cohort>(`${SELECT} WHERE c.id = $1`, [created.id], client))!;
  });
}

export async function updateCohort(
  context: AuthedContext,
  id: string,
  input: Partial<CohortInput>,
): Promise<Cohort> {
  return withTransaction(async (client) => {
    const existing = await queryOne<Cohort>(
      "SELECT * FROM cohorts WHERE id = $1 AND program_id = $2 FOR UPDATE",
      [id, context.program.id],
      client,
    );
    if (!existing) throw notFound("That cohort no longer exists.");

    const label =
      input.label === undefined
        ? existing.label
        : input.label.trim().replace(/\s+/g, " ");
    if (!label) throw validationFailed("Give the cohort a label.");

    const startDate = input.startDate === undefined ? existing.start_date : input.startDate;
    const endDate = input.endDate === undefined ? existing.end_date : input.endDate;
    assertDateOrder(startDate, endDate);

    if (label.toLowerCase() !== existing.label.toLowerCase()) {
      const clash = await queryOne<{ label: string }>(
        "SELECT label FROM cohorts WHERE program_id = $1 AND lower(label) = lower($2) AND id <> $3",
        [context.program.id, label, id],
        client,
      );
      if (clash) {
        throw conflict(`Your program already has a cohort called "${clash.label}".`);
      }
    }

    await query(
      `UPDATE cohorts
          SET label = $2, pgy_level = COALESCE($3, pgy_level),
              start_date = $4, end_date = $5,
              notes = COALESCE($6, notes), active = COALESCE($7, active)
        WHERE id = $1`,
      [
        id,
        label,
        input.pgyLevel ?? null,
        startDate,
        endDate,
        input.notes ?? null,
        input.active ?? null,
      ],
      client,
    );

    if (input.pairedCohortId !== undefined) {
      await pairInTransaction(client, context.program.id, id, input.pairedCohortId);
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "cohort.updated",
        entityType: "cohort",
        entityId: id,
        previousState: { label: existing.label, active: existing.active },
        newState: { label, ...input },
      },
      client,
    );

    return (await queryOne<Cohort>(`${SELECT} WHERE c.id = $1`, [id], client))!;
  });
}

/**
 * Pairing is reciprocal, and that is maintained here rather than trusted.
 *
 * A one-sided pairing is the bug this prevents: A points at B, B points at
 * nothing, and the schedule shows A alternating with a cohort that does not
 * know it is alternating. Setting a pair therefore writes both directions and
 * clears whatever either side previously pointed at, so no cohort is left
 * paired to a partner that has moved on.
 */
async function pairInTransaction(
  client: Parameters<typeof query>[2],
  programId: string,
  cohortId: string,
  partnerId: string | null,
): Promise<void> {
  const current = await queryOne<{ paired_cohort_id: string | null }>(
    "SELECT paired_cohort_id FROM cohorts WHERE id = $1",
    [cohortId],
    client,
  );

  // Release the previous partner, whoever it was.
  if (current?.paired_cohort_id && current.paired_cohort_id !== partnerId) {
    await query(
      "UPDATE cohorts SET paired_cohort_id = NULL WHERE id = $1",
      [current.paired_cohort_id],
      client,
    );
  }

  if (!partnerId) {
    await query("UPDATE cohorts SET paired_cohort_id = NULL WHERE id = $1", [cohortId], client);
    return;
  }

  if (partnerId === cohortId) {
    throw validationFailed("A cohort cannot be paired with itself.");
  }

  const partner = await queryOne<{ id: string; label: string; paired_cohort_id: string | null }>(
    "SELECT id, label, paired_cohort_id FROM cohorts WHERE id = $1 AND program_id = $2 FOR UPDATE",
    [partnerId, programId],
    client,
  );
  if (!partner) throw notFound("That cohort no longer exists.");

  if (partner.paired_cohort_id && partner.paired_cohort_id !== cohortId) {
    throw conflict(
      `"${partner.label}" is already paired with another cohort. Unpair it first.`,
    );
  }

  await query("UPDATE cohorts SET paired_cohort_id = $2 WHERE id = $1", [cohortId, partnerId], client);
  await query("UPDATE cohorts SET paired_cohort_id = $2 WHERE id = $1", [partnerId, cohortId], client);
}

export async function addCohortMember(
  context: AuthedContext,
  cohortId: string,
  residentId: string,
  options: { startDate?: string | null; endDate?: string | null; notes?: string } = {},
): Promise<void> {
  await withTransaction(async (client) => {
    const cohort = await queryOne<{ id: string; label: string; pgy_level: number }>(
      "SELECT id, label, pgy_level FROM cohorts WHERE id = $1 AND program_id = $2",
      [cohortId, context.program.id],
      client,
    );
    if (!cohort) throw notFound("That cohort no longer exists.");

    const resident = await queryOne<{ id: string; pgy_level: number; name: string }>(
      `SELECT r.id, r.pgy_level, u.full_name AS name
         FROM residents r JOIN users u ON u.id = r.user_id
        WHERE r.id = $1 AND r.program_id = $2`,
      [residentId, context.program.id],
      client,
    );
    if (!resident) throw notFound("That resident is not in your program.");

    /* A warning worth refusing on. Putting a PGY-1 into a PGY-2 cohort is
       occasionally deliberate — an off-cycle resident catching up — but far more
       often it is the wrong row in a long list, and the consequence is a whole
       block of shifts assigned to somebody not eligible for them. */
    if (resident.pgy_level !== cohort.pgy_level) {
      throw validationFailed(
        `${resident.name} is PGY-${resident.pgy_level} and "${cohort.label}" is a ` +
          `PGY-${cohort.pgy_level} cohort. Change the resident's PGY level first if this is intended.`,
      );
    }

    const existing = await queryOne<{ label: string }>(
      `SELECT c.label FROM cohort_members m JOIN cohorts c ON c.id = m.cohort_id
        WHERE m.resident_id = $1 AND c.program_id = $2 AND c.active = true
          AND m.cohort_id <> $3`,
      [residentId, context.program.id, cohortId],
      client,
    );
    if (existing) {
      throw conflict(
        `${resident.name} is already in "${existing.label}". Remove them from it first — ` +
          "a resident in two cohorts would be assigned two blocks at once.",
      );
    }

    await query(
      `INSERT INTO cohort_members (cohort_id, resident_id, start_date, end_date, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cohort_id, resident_id) DO UPDATE
         SET start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
             notes = EXCLUDED.notes`,
      [cohortId, residentId, options.startDate ?? null, options.endDate ?? null, options.notes ?? ""],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "cohort.member_added",
        entityType: "cohort",
        entityId: cohortId,
        newState: { resident: resident.name, cohort: cohort.label },
      },
      client,
    );
  });
}

export async function removeCohortMember(
  context: AuthedContext,
  cohortId: string,
  residentId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const removed = await query<{ id: string }>(
      `DELETE FROM cohort_members m
        USING cohorts c
        WHERE m.cohort_id = c.id AND c.program_id = $1
          AND m.cohort_id = $2 AND m.resident_id = $3
        RETURNING m.id`,
      [context.program.id, cohortId, residentId],
      client,
    );
    if (removed.length === 0) throw notFound("That resident is not in this cohort.");

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "cohort.member_removed",
        entityType: "cohort",
        entityId: cohortId,
        previousState: { residentId },
      },
      client,
    );
  });
}

export async function deleteCohort(context: AuthedContext, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await queryOne<{ id: string; label: string }>(
      "SELECT id, label FROM cohorts WHERE id = $1 AND program_id = $2 FOR UPDATE",
      [id, context.program.id],
      client,
    );
    if (!existing) throw notFound("That cohort no longer exists.");

    const assignments = await queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM cohort_block_assignments WHERE cohort_id = $1",
      [id],
      client,
    );
    if (Number(assignments?.count ?? 0) > 0) {
      throw conflict(
        `"${existing.label}" is assigned to ${assignments!.count} block(s). ` +
          "Deactivate it instead, or clear its block assignments first.",
      );
    }

    await query("DELETE FROM cohorts WHERE id = $1", [id], client);
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "cohort.deleted",
        entityType: "cohort",
        entityId: id,
        previousState: { label: existing.label },
      },
      client,
    );
  });
}

// ---------------------------------------------------------------------------
// Block assignments
// ---------------------------------------------------------------------------

export interface CohortBlockAssignment {
  id: string;
  cohort_id: string;
  cohort_label: string;
  block_id: string;
  block_label: string;
  block_sequence: number;
  start_date: Date;
  end_date: Date;
  service_id: string | null;
  service_name: string | null;
  rotation_id: string | null;
  label: string;
  notes: string;
}

export async function listBlockAssignments(
  programId: string,
  structureId: string,
): Promise<CohortBlockAssignment[]> {
  return query<CohortBlockAssignment>(
    `SELECT a.*, c.label AS cohort_label, b.label AS block_label,
            b.sequence AS block_sequence, b.start_date, b.end_date,
            s.name AS service_name
       FROM cohort_block_assignments a
       JOIN cohorts c ON c.id = a.cohort_id
       JOIN blocks b ON b.id = a.block_id
       LEFT JOIN services s ON s.id = a.service_id
      WHERE c.program_id = $1 AND b.block_structure_id = $2
      ORDER BY b.sequence, c.pgy_level, lower(c.label)`,
    [programId, structureId],
  );
}

export async function assignCohortToBlock(
  context: AuthedContext,
  input: {
    cohortId: string;
    blockId: string;
    serviceId?: string | null;
    rotationId?: string | null;
    label?: string;
    notes?: string;
  },
): Promise<void> {
  await withTransaction(async (client) => {
    const cohort = await queryOne<{ id: string; label: string }>(
      "SELECT id, label FROM cohorts WHERE id = $1 AND program_id = $2",
      [input.cohortId, context.program.id],
      client,
    );
    if (!cohort) throw notFound("That cohort no longer exists.");

    const block = await queryOne<{ id: string; label: string }>(
      `SELECT b.id, b.label FROM blocks b
         JOIN block_structures bs ON bs.id = b.block_structure_id
        WHERE b.id = $1 AND bs.program_id = $2`,
      [input.blockId, context.program.id],
      client,
    );
    if (!block) throw notFound("That block no longer exists.");

    if (input.serviceId) {
      const service = await queryOne<{ id: string }>(
        "SELECT id FROM services WHERE id = $1 AND program_id = $2 AND active = true",
        [input.serviceId, context.program.id],
        client,
      );
      if (!service) throw notFound("That service no longer exists or is inactive.");
    }

    await query(
      `INSERT INTO cohort_block_assignments
         (cohort_id, block_id, service_id, rotation_id, label, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cohort_id, block_id) DO UPDATE
         SET service_id = EXCLUDED.service_id, rotation_id = EXCLUDED.rotation_id,
             label = EXCLUDED.label, notes = EXCLUDED.notes`,
      [
        input.cohortId,
        input.blockId,
        input.serviceId ?? null,
        input.rotationId ?? null,
        input.label ?? "",
        input.notes ?? "",
      ],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "cohort.block_assigned",
        entityType: "cohort",
        entityId: input.cohortId,
        newState: { block: block.label, serviceId: input.serviceId ?? null },
      },
      client,
    );
  });
}

export async function clearBlockAssignment(
  context: AuthedContext,
  cohortId: string,
  blockId: string,
): Promise<void> {
  await query(
    `DELETE FROM cohort_block_assignments a
      USING cohorts c
      WHERE a.cohort_id = c.id AND c.program_id = $1
        AND a.cohort_id = $2 AND a.block_id = $3`,
    [context.program.id, cohortId, blockId],
  );
}

/**
 * One resident doing something different from their cohort for one block.
 *
 * Every programme has these, and they are normally tracked in somebody's head
 * or a spreadsheet column called NOTES. Making them a row is the difference
 * between a scheduler that survives contact with reality and one that is
 * abandoned in October.
 */
export async function setResidentOverride(
  context: AuthedContext,
  input: {
    residentId: string;
    blockId: string;
    serviceId?: string | null;
    rotationId?: string | null;
    label?: string;
    reason: string;
  },
): Promise<void> {
  if (!input.reason.trim()) {
    throw validationFailed(
      "Give a reason. An override without one is indistinguishable from a mistake six months later.",
    );
  }

  await withTransaction(async (client) => {
    const resident = await queryOne<{ id: string; name: string }>(
      `SELECT r.id, u.full_name AS name FROM residents r
         JOIN users u ON u.id = r.user_id
        WHERE r.id = $1 AND r.program_id = $2`,
      [input.residentId, context.program.id],
      client,
    );
    if (!resident) throw notFound("That resident is not in your program.");

    const block = await queryOne<{ id: string; label: string }>(
      `SELECT b.id, b.label FROM blocks b
         JOIN block_structures bs ON bs.id = b.block_structure_id
        WHERE b.id = $1 AND bs.program_id = $2`,
      [input.blockId, context.program.id],
      client,
    );
    if (!block) throw notFound("That block no longer exists.");

    await query(
      `INSERT INTO resident_block_overrides
         (resident_id, block_id, service_id, rotation_id, label, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (resident_id, block_id) DO UPDATE
         SET service_id = EXCLUDED.service_id, rotation_id = EXCLUDED.rotation_id,
             label = EXCLUDED.label, reason = EXCLUDED.reason,
             created_by = EXCLUDED.created_by`,
      [
        input.residentId,
        input.blockId,
        input.serviceId ?? null,
        input.rotationId ?? null,
        input.label ?? "",
        input.reason.trim(),
        context.user.id,
      ],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "cohort.resident_override",
        entityType: "resident",
        entityId: input.residentId,
        newState: { block: block.label, serviceId: input.serviceId ?? null },
        reason: input.reason,
      },
      client,
    );
  });
}

export async function listResidentOverrides(
  programId: string,
  structureId: string,
): Promise<
  Array<{
    id: string;
    resident_id: string;
    resident_name: string;
    block_id: string;
    block_label: string;
    service_name: string | null;
    label: string;
    reason: string;
  }>
> {
  return query(
    `SELECT o.id, o.resident_id, u.full_name AS resident_name, o.block_id,
            b.label AS block_label, s.name AS service_name, o.label, o.reason
       FROM resident_block_overrides o
       JOIN residents r ON r.id = o.resident_id
       JOIN users u ON u.id = r.user_id
       JOIN blocks b ON b.id = o.block_id
       LEFT JOIN services s ON s.id = o.service_id
      WHERE r.program_id = $1 AND b.block_structure_id = $2
      ORDER BY b.sequence, u.full_name`,
    [programId, structureId],
  );
}

function assertDateOrder(start?: string | Date | null, end?: string | Date | null): void {
  if (!start || !end) return;
  const from = typeof start === "string" ? start : start.toISOString().slice(0, 10);
  const to = typeof end === "string" ? end : end.toISOString().slice(0, 10);
  if (to < from) throw validationFailed("The end date is before the start date.");
}
