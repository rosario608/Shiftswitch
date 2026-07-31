import { query, queryOne, withTransaction } from "@/server/db/pool";
import type {
  ProgramContactRow,
  ProgramRow,
  ResidentRow,
  RuleRow,
  ShiftDetail,
  UserRow,
} from "@/server/db/types";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, forbidden, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { notify } from "./notifications";
import { RULE_HANDLERS, RULE_HANDLERS_BY_TYPE } from "./rules/handlers";
import { SHIFT_DETAIL_SELECT, getShiftDetailForUpdate } from "./schedule";
import { invalidateTradesForShift } from "./trades";
import { isValidTimeZone, zonedWallTimeToInstant } from "./time";
import type {
  ContactInput,
  RuleInput,
  ShiftCreateInput,
} from "@/lib/schemas";

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface ManagedUser extends UserRow {
  resident_id: string | null;
  pgy_level: number | null;
  graduation_year: number | null;
  credentials: string[] | null;
  resident_active: boolean | null;
}

export async function listManagedUsers(
  programId: string,
  options: { includeUnassigned?: boolean; search?: string } = {},
): Promise<ManagedUser[]> {
  const values: unknown[] = [programId];
  const where = [
    options.includeUnassigned
      ? "(u.program_id = $1 OR u.program_id IS NULL)"
      : "u.program_id = $1",
  ];
  if (options.search) {
    values.push(`%${options.search.toLowerCase()}%`);
    where.push(`(lower(u.full_name) LIKE $${values.length} OR lower(u.email) LIKE $${values.length})`);
  }
  return query<ManagedUser>(
    `SELECT u.*, r.id AS resident_id, r.pgy_level, r.graduation_year,
            r.credentials, r.active AS resident_active
       FROM users u
       LEFT JOIN residents r ON r.user_id = u.id AND r.program_id = $1
      WHERE ${where.join(" AND ")}
      ORDER BY (u.role IS NULL) DESC, u.full_name`,
    values,
  );
}

export interface UserPatch {
  role?: "resident" | "chief" | "admin" | null;
  programId?: string | null;
  active?: boolean;
  pgyLevel?: number;
  graduationYear?: number;
  credentials?: string[];
  fullName?: string;
}

export async function updateManagedUser(
  context: AuthedContext,
  userId: string,
  patch: UserPatch,
): Promise<ManagedUser> {
  return withTransaction(async (client) => {
    const existing = await queryOne<UserRow>(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [userId],
      client,
    );
    if (!existing) throw notFound("That user no longer exists.");
    // An administrator may only manage their own program's users, or a user who
    // has not been assigned to any program yet.
    if (existing.program_id && existing.program_id !== context.program.id) {
      throw forbidden("That user belongs to a different program.");
    }
    const targetProgramId =
      patch.programId === undefined ? existing.program_id : patch.programId;
    if (targetProgramId && targetProgramId !== context.program.id) {
      throw forbidden("You can only assign users to your own program.");
    }
    if (existing.id === context.user.id && patch.role && patch.role !== "admin") {
      throw validationFailed("You cannot remove your own administrator role.");
    }
    if (existing.id === context.user.id && patch.active === false) {
      throw validationFailed("You cannot deactivate your own account.");
    }
    const role = patch.role === undefined ? existing.role : patch.role;
    if (role && !targetProgramId) {
      throw validationFailed("Assign the user to a program before giving them a role.");
    }

    const updated = await queryOne<UserRow>(
      `UPDATE users
          SET role = $2,
              program_id = $3,
              active = COALESCE($4, active),
              full_name = COALESCE($5, full_name)
        WHERE id = $1
      RETURNING *`,
      [
        userId,
        role,
        targetProgramId,
        patch.active ?? null,
        patch.fullName ?? null,
      ],
      client,
    );

    // Residents (and chiefs, who also hold a schedule) need a resident record.
    let resident: ResidentRow | null = await queryOne<ResidentRow>(
      "SELECT * FROM residents WHERE user_id = $1 AND program_id = $2",
      [userId, targetProgramId],
      client,
    );
    if ((role === "resident" || role === "chief") && targetProgramId) {
      if (resident) {
        resident = await queryOne<ResidentRow>(
          `UPDATE residents
              SET pgy_level = COALESCE($2, pgy_level),
                  graduation_year = COALESCE($3, graduation_year),
                  credentials = COALESCE($4, credentials),
                  active = COALESCE($5, active)
            WHERE id = $1
          RETURNING *`,
          [
            resident.id,
            patch.pgyLevel ?? null,
            patch.graduationYear ?? null,
            patch.credentials ?? null,
            patch.active ?? null,
          ],
          client,
        );
      } else {
        resident = await queryOne<ResidentRow>(
          `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            userId,
            targetProgramId,
            patch.pgyLevel ?? 1,
            patch.graduationYear ?? new Date().getFullYear() + 3,
            patch.credentials ?? [],
          ],
          client,
        );
      }
    }

    if (patch.active === false) {
      await query("DELETE FROM sessions WHERE user_id = $1", [userId], client);
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: existing.role !== role ? "user.role_changed" : "user.updated",
        entityType: "user",
        entityId: userId,
        previousState: {
          role: existing.role,
          programId: existing.program_id,
          active: existing.active,
        },
        newState: {
          role,
          programId: targetProgramId,
          active: updated?.active,
          pgyLevel: resident?.pgy_level ?? null,
        },
      },
      client,
    );

    if (existing.role === null && role) {
      await notify(
        {
          recipientUserId: userId,
          type: "shift.changed",
          title: "Your account is ready",
          body: `${context.user.fullName} configured your ShiftSwitch account. You can now view your schedule and trade shifts.`,
        },
        client,
      );
    }

    return {
      ...(updated as UserRow),
      resident_id: resident?.id ?? null,
      pgy_level: resident?.pgy_level ?? null,
      graduation_year: resident?.graduation_year ?? null,
      credentials: resident?.credentials ?? null,
      resident_active: resident?.active ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export async function updateProgram(
  context: AuthedContext,
  patch: {
    name?: string;
    institution?: string;
    timezone?: string;
    approvedEmailDomains?: string[];
    defaultTradeApprovalRequired?: boolean;
  },
): Promise<ProgramRow> {
  if (patch.timezone && !isValidTimeZone(patch.timezone)) {
    throw validationFailed(`"${patch.timezone}" is not a recognised timezone.`);
  }
  const domains = patch.approvedEmailDomains?.map((domain) =>
    domain.trim().toLowerCase().replace(/^@/, ""),
  );
  const updated = await queryOne<ProgramRow>(
    `UPDATE programs
        SET name = COALESCE($2, name),
            institution = COALESCE($3, institution),
            timezone = COALESCE($4, timezone),
            approved_email_domains = COALESCE($5, approved_email_domains),
            default_trade_approval_required = COALESCE($6, default_trade_approval_required)
      WHERE id = $1
    RETURNING *`,
    [
      context.program.id,
      patch.name ?? null,
      patch.institution ?? null,
      patch.timezone ?? null,
      domains ?? null,
      patch.defaultTradeApprovalRequired ?? null,
    ],
  );
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "program.updated",
    entityType: "program",
    entityId: context.program.id,
    previousState: {
      name: context.program.name,
      timezone: context.program.timezone,
      approvedEmailDomains: context.program.approved_email_domains,
      defaultTradeApprovalRequired: context.program.default_trade_approval_required,
    },
    newState: {
      name: updated?.name,
      timezone: updated?.timezone,
      approvedEmailDomains: updated?.approved_email_domains,
      defaultTradeApprovalRequired: updated?.default_trade_approval_required,
    },
  });
  return updated as ProgramRow;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function listRuleTypes() {
  return RULE_HANDLERS.map((handler) => ({
    type: handler.type,
    label: handler.label,
    description: handler.description,
    category: handler.category,
  }));
}

export async function listRules(programId: string): Promise<RuleRow[]> {
  return query<RuleRow>(
    "SELECT * FROM rules WHERE program_id = $1 ORDER BY active DESC, rule_type",
    [programId],
  );
}

export async function createRule(
  context: AuthedContext,
  input: RuleInput,
): Promise<RuleRow> {
  if (!RULE_HANDLERS_BY_TYPE.has(input.ruleType)) {
    throw validationFailed(`"${input.ruleType}" is not a known rule type.`);
  }
  if (input.scope !== "program" && !input.scopeId) {
    throw validationFailed("Choose what this rule applies to.");
  }
  const rule = await queryOne<RuleRow>(
    `INSERT INTO rules
       (program_id, rule_type, name, description, params, severity, scope, scope_id, overridable, active)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      context.program.id,
      input.ruleType,
      input.name,
      input.description ?? "",
      JSON.stringify(input.params ?? {}),
      input.severity,
      input.scope,
      input.scope === "program" ? null : input.scopeId,
      input.overridable,
      input.active,
    ],
  );
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "rule.created",
    entityType: "rule",
    entityId: rule!.id,
    newState: rule,
  });
  return rule as RuleRow;
}

export async function updateRule(
  context: AuthedContext,
  ruleId: string,
  patch: Partial<RuleInput>,
): Promise<RuleRow> {
  const existing = await queryOne<RuleRow>(
    "SELECT * FROM rules WHERE id = $1 AND program_id = $2",
    [ruleId, context.program.id],
  );
  if (!existing) throw notFound("That rule no longer exists.");
  const updated = await queryOne<RuleRow>(
    `UPDATE rules
        SET name = COALESCE($2, name),
            description = COALESCE($3, description),
            params = COALESCE($4::jsonb, params),
            severity = COALESCE($5, severity),
            overridable = COALESCE($6, overridable),
            active = COALESCE($7, active)
      WHERE id = $1
    RETURNING *`,
    [
      ruleId,
      patch.name ?? null,
      patch.description ?? null,
      patch.params ? JSON.stringify(patch.params) : null,
      patch.severity ?? null,
      patch.overridable ?? null,
      patch.active ?? null,
    ],
  );
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "rule.updated",
    entityType: "rule",
    entityId: ruleId,
    previousState: existing,
    newState: updated,
  });
  return updated as RuleRow;
}

export async function deleteRule(context: AuthedContext, ruleId: string): Promise<void> {
  const existing = await queryOne<RuleRow>(
    "SELECT * FROM rules WHERE id = $1 AND program_id = $2",
    [ruleId, context.program.id],
  );
  if (!existing) throw notFound("That rule no longer exists.");
  await query("DELETE FROM rules WHERE id = $1", [ruleId]);
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "rule.deleted",
    entityType: "rule",
    entityId: ruleId,
    previousState: existing,
  });
}

// ---------------------------------------------------------------------------
// Program contacts
// ---------------------------------------------------------------------------

export async function createContact(
  context: AuthedContext,
  input: ContactInput,
): Promise<ProgramContactRow> {
  const contact = await queryOne<ProgramContactRow>(
    `INSERT INTO program_contacts (program_id, name, email, contact_type, notify_role, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      context.program.id,
      input.name,
      input.email.toLowerCase(),
      input.contactType,
      input.notifyRole,
      input.active,
    ],
  );
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "program_contact.created",
    entityType: "program_contact",
    entityId: contact!.id,
    newState: contact,
  });
  return contact as ProgramContactRow;
}

export async function updateContact(
  context: AuthedContext,
  contactId: string,
  patch: Partial<ContactInput>,
): Promise<ProgramContactRow> {
  const existing = await queryOne<ProgramContactRow>(
    "SELECT * FROM program_contacts WHERE id = $1 AND program_id = $2",
    [contactId, context.program.id],
  );
  if (!existing) throw notFound("That contact no longer exists.");
  const updated = await queryOne<ProgramContactRow>(
    `UPDATE program_contacts
        SET name = COALESCE($2, name),
            email = COALESCE($3, email),
            contact_type = COALESCE($4, contact_type),
            notify_role = COALESCE($5, notify_role),
            active = COALESCE($6, active)
      WHERE id = $1
    RETURNING *`,
    [
      contactId,
      patch.name ?? null,
      patch.email?.toLowerCase() ?? null,
      patch.contactType ?? null,
      patch.notifyRole ?? null,
      patch.active ?? null,
    ],
  );
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "program_contact.updated",
    entityType: "program_contact",
    entityId: contactId,
    previousState: existing,
    newState: updated,
  });
  return updated as ProgramContactRow;
}

export async function deleteContact(
  context: AuthedContext,
  contactId: string,
): Promise<void> {
  const existing = await queryOne<ProgramContactRow>(
    "SELECT * FROM program_contacts WHERE id = $1 AND program_id = $2",
    [contactId, context.program.id],
  );
  if (!existing) throw notFound("That contact no longer exists.");
  await query("DELETE FROM program_contacts WHERE id = $1", [contactId]);
  await recordAudit({
    programId: context.program.id,
    actorUserId: context.user.id,
    actorLabel: context.user.email,
    action: "program_contact.deleted",
    entityType: "program_contact",
    entityId: contactId,
    previousState: existing,
  });
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export interface ProgramScheduleFilters {
  from?: string;
  to?: string;
  residentId?: string;
  serviceId?: string;
  pgy?: number;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listProgramSchedule(
  programId: string,
  filters: ProgramScheduleFilters = {},
): Promise<ShiftDetail[]> {
  const values: unknown[] = [programId];
  const where = ["s.program_id = $1"];
  if (filters.from) {
    values.push(filters.from);
    where.push(`s.date >= $${values.length}::date`);
  }
  if (filters.to) {
    values.push(filters.to);
    where.push(`s.date <= $${values.length}::date`);
  }
  if (filters.residentId) {
    values.push(filters.residentId);
    where.push(`sa.resident_id = $${values.length}`);
  }
  if (filters.serviceId) {
    values.push(filters.serviceId);
    where.push(`s.service_id = $${values.length}`);
  }
  if (filters.pgy) {
    values.push(filters.pgy);
    where.push(`res.pgy_level = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    where.push(`s.status = $${values.length}::shift_status`);
  }
  if (filters.search) {
    values.push(`%${filters.search.toLowerCase()}%`);
    where.push(
      `(lower(u.full_name) LIKE $${values.length} OR lower(sv.name) LIKE $${values.length} OR lower(s.location) LIKE $${values.length})`,
    );
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
  );
}

export async function createShift(
  context: AuthedContext,
  input: ShiftCreateInput,
): Promise<ShiftDetail> {
  const timezone = context.program.timezone;
  const start = zonedWallTimeToInstant(input.date, input.startTime, timezone);
  const endDate = input.endsNextDay
    ? new Date(new Date(`${input.date}T00:00:00Z`).getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10)
    : input.date;
  const end = zonedWallTimeToInstant(endDate, input.endTime, timezone);
  if (end <= start) {
    throw validationFailed(
      "The shift ends before it starts. Tick “ends next day” for overnight shifts.",
    );
  }
  if (input.requiredPgyMax < input.requiredPgyMin) {
    throw validationFailed("The PGY range is inverted.");
  }

  return withTransaction(async (client) => {
    const service = await queryOne<{ id: string }>(
      "SELECT id FROM services WHERE id = $1 AND program_id = $2",
      [input.serviceId, context.program.id],
      client,
    );
    if (!service) throw validationFailed("Choose a service from your program.");

    const shift = await queryOne<{ id: string }>(
      `INSERT INTO shifts
         (program_id, service_id, rotation_id, date, start_datetime, end_datetime,
          location, shift_type, required_pgy_min, required_pgy_max, tradeable, approval_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        context.program.id,
        input.serviceId,
        input.rotationId ?? null,
        input.date,
        start,
        end,
        input.location,
        input.shiftType,
        input.requiredPgyMin,
        input.requiredPgyMax,
        input.tradeable,
        input.approvalRequired,
      ],
      client,
    );
    if (input.residentId) {
      await assertResidentInProgram(input.residentId, context.program.id, client);
      await query(
        "INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)",
        [shift!.id, input.residentId],
        client,
      );
    }
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "shift.created",
        entityType: "shift",
        entityId: shift!.id,
        newState: { ...input, start, end },
      },
      client,
    );
    const created = await queryOne<ShiftDetail>(
      `${SHIFT_DETAIL_SELECT} WHERE s.id = $1`,
      [shift!.id],
      client,
    );
    return created as ShiftDetail;
  });
}

async function assertResidentInProgram(
  residentId: string,
  programId: string,
  client: Parameters<typeof recordAudit>[1],
) {
  const resident = await queryOne<{ id: string }>(
    "SELECT id FROM residents WHERE id = $1 AND program_id = $2 AND active = true",
    [residentId, programId],
    client,
  );
  if (!resident) throw validationFailed("Choose an active resident from your program.");
}

export interface ShiftPatch {
  location?: string;
  shiftType?: string;
  tradeable?: boolean;
  approvalRequired?: boolean;
  requiredPgyMin?: number;
  requiredPgyMax?: number;
  residentId?: string | null;
  status?: "scheduled" | "cancelled";
  reason?: string;
}

/**
 * Administrative edit of a shift. Any change that undermines a live trade
 * (reassignment, cancellation, or removing tradeability) invalidates the
 * dependent posts and offers and tells the affected residents why.
 */
export async function updateShift(
  context: AuthedContext,
  shiftId: string,
  patch: ShiftPatch,
): Promise<ShiftDetail> {
  return withTransaction(async (client) => {
    const existing = await getShiftDetailForUpdate(shiftId, client);
    if (!existing) throw notFound("That shift no longer exists.");
    if (existing.program_id !== context.program.id) {
      throw forbidden("That shift belongs to a different program.");
    }
    if (existing.status === "completed" && patch.status !== undefined) {
      throw conflict("Completed shifts can no longer be changed.");
    }

    const reassigning =
      patch.residentId !== undefined && patch.residentId !== existing.resident_id;
    const cancelling = patch.status === "cancelled" && existing.status !== "cancelled";
    const removingTradeability = patch.tradeable === false && existing.tradeable;

    if (reassigning) {
      if (patch.residentId) {
        await assertResidentInProgram(patch.residentId, context.program.id, client);
      }
      await query(
        `UPDATE shift_assignments
            SET assignment_status = 'ended', ended_at = now()
          WHERE shift_id = $1 AND assignment_status = 'active'`,
        [shiftId],
        client,
      );
      if (patch.residentId) {
        await query(
          "INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)",
          [shiftId, patch.residentId],
          client,
        );
      }
    }

    const updated = await queryOne<ShiftDetail>(
      `UPDATE shifts
          SET location = COALESCE($2, location),
              shift_type = COALESCE($3, shift_type),
              tradeable = COALESCE($4, tradeable),
              approval_required = COALESCE($5, approval_required),
              required_pgy_min = COALESCE($6, required_pgy_min),
              required_pgy_max = COALESCE($7, required_pgy_max),
              status = COALESCE($8::shift_status, status)
        WHERE id = $1
      RETURNING id`,
      [
        shiftId,
        patch.location ?? null,
        patch.shiftType ?? null,
        patch.tradeable ?? null,
        patch.approvalRequired ?? null,
        patch.requiredPgyMin ?? null,
        patch.requiredPgyMax ?? null,
        patch.status ?? null,
      ],
      client,
    );
    if (!updated) throw notFound("That shift no longer exists.");

    if (reassigning || cancelling || removingTradeability) {
      const reason = cancelling
        ? "This offer is no longer available because the shift was cancelled by your program."
        : reassigning
          ? "This offer is no longer available because the shift was reassigned by your program."
          : "This offer is no longer available because the shift is no longer tradeable.";
      await invalidateTradesForShift(client, shiftId, reason, {
        userId: context.user.id,
        programId: context.program.id,
      });
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: cancelling
          ? "shift.cancelled"
          : reassigning
            ? "shift.reassigned"
            : "shift.updated",
        entityType: "shift",
        entityId: shiftId,
        previousState: {
          residentId: existing.resident_id,
          status: existing.status,
          tradeable: existing.tradeable,
          location: existing.location,
        },
        newState: { ...patch },
        reason: patch.reason ?? null,
      },
      client,
    );

    const detail = await queryOne<ShiftDetail>(
      `${SHIFT_DETAIL_SELECT} WHERE s.id = $1`,
      [shiftId],
      client,
    );
    return detail as ShiftDetail;
  });
}

/**
 * Removes a shift outright.
 *
 * This exists for correcting a mistake — a bad import, a shift entered twice —
 * not for taking a shift out of service. Cancelling (`updateShift` with
 * `status: "cancelled"`) is the right operation for a shift that genuinely
 * happened and then stopped: it keeps the record and notifies whoever was
 * assigned. Deleting erases it.
 *
 * So deletion is refused whenever the shift carries history somebody else
 * depends on. `completed_trades` and `trade_legs` reference shifts with
 * ON DELETE RESTRICT, so the database would refuse anyway — but a foreign key
 * violation surfaces as "something went wrong", and an administrator staring at
 * a schedule deserves to be told which switch is in the way.
 */
export async function deleteShift(
  context: AuthedContext,
  shiftId: string,
): Promise<void> {
  return withTransaction(async (client) => {
    const existing = await getShiftDetailForUpdate(shiftId, client);
    if (!existing) throw notFound("That shift no longer exists.");
    if (existing.program_id !== context.program.id) {
      throw forbidden("That shift belongs to a different program.");
    }

    const completed = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM completed_trades
        WHERE source_shift_id = $1 OR destination_shift_id = $1`,
      [shiftId],
      client,
    );
    if (Number(completed?.count ?? 0) > 0) {
      throw conflict(
        "This shift was part of a completed switch, so it cannot be deleted — the program needs the record of who worked it. Cancel it instead if it is no longer happening.",
      );
    }

    const live = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM trade_requests
        WHERE source_shift_id = $1
          AND status IN ('open', 'offer_pending', 'accepted', 'pending_approval')`,
      [shiftId],
      client,
    );
    if (Number(live?.count ?? 0) > 0) {
      throw conflict(
        "This shift is currently posted for switching. Cancel the post first, then delete the shift.",
      );
    }

    const offered = await queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM trade_offers
        WHERE offered_shift_id = $1 AND status IN ('pending', 'accepted')`,
      [shiftId],
      client,
    );
    if (Number(offered?.count ?? 0) > 0) {
      throw conflict(
        "This shift has been offered in a switch that is still open. Withdraw or resolve that offer first.",
      );
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "shift.deleted",
        entityType: "shift",
        entityId: shiftId,
        previousState: {
          date: existing.date,
          service: existing.service_name,
          start: existing.start_datetime,
          end: existing.end_datetime,
          resident: existing.resident_name,
        },
        reason: "Deleted by an administrator",
      },
      client,
    );

    // Assignments and any dead trade rows cascade; the audit entry above is
    // what survives, so the deletion itself is never invisible.
    await query("DELETE FROM shifts WHERE id = $1", [shiftId], client);
  });
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface ProgramAnalytics {
  totals: {
    shifts: number;
    upcomingShifts: number;
    tradeRequests: number;
    completedTrades: number;
    pendingApprovals: number;
    emailsGenerated: number;
    emailsMarkedSent: number;
  };
  completionRate: number;
  averageApprovalHours: number | null;
  failedValidationReasons: Array<{ reason: string; count: number }>;
  tradesByPgy: Array<{ pgy: number; count: number }>;
  tradesByService: Array<{ service: string; count: number }>;
  tradesOverTime: Array<{ week: string; count: number }>;
}

export async function getProgramAnalytics(programId: string): Promise<ProgramAnalytics> {
  const totals = await queryOne<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM shifts WHERE program_id = $1)::text AS shifts,
       (SELECT count(*) FROM shifts WHERE program_id = $1 AND start_datetime > now())::text AS upcoming_shifts,
       (SELECT count(*) FROM trade_requests WHERE program_id = $1)::text AS trade_requests,
       (SELECT count(*) FROM completed_trades WHERE program_id = $1)::text AS completed_trades,
       (SELECT count(*) FROM trade_requests WHERE program_id = $1 AND status = 'pending_approval')::text AS pending_approvals,
       (SELECT count(*) FROM email_records e JOIN completed_trades c ON c.id = e.completed_trade_id
         WHERE c.program_id = $1)::text AS emails_generated,
       (SELECT count(*) FROM email_records e JOIN completed_trades c ON c.id = e.completed_trade_id
         WHERE c.program_id = $1 AND e.status = 'marked_sent')::text AS emails_marked_sent`,
    [programId],
  );

  const approval = await queryOne<{ avg_hours: string | null }>(
    `SELECT avg(extract(epoch FROM (approved_at - completed_at)) / 3600)::text AS avg_hours
       FROM completed_trades
      WHERE program_id = $1 AND approved_at IS NOT NULL`,
    [programId],
  );

  const failures = await query<{ reason: string; count: string }>(
    `SELECT COALESCE(reason, 'Unspecified') AS reason, count(*)::text AS count
       FROM audit_logs
      WHERE program_id = $1 AND action IN ('offer.invalidated', 'trade.rejected')
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`,
    [programId],
  );

  const byPgy = await query<{ pgy: number; count: string }>(
    `SELECT r.pgy_level AS pgy, count(*)::text AS count
       FROM completed_trades ct
       JOIN residents r ON r.id IN (ct.resident_a, ct.resident_b)
      WHERE ct.program_id = $1
      GROUP BY 1 ORDER BY 1`,
    [programId],
  );

  const byService = await query<{ service: string; count: string }>(
    `SELECT sv.name AS service, count(*)::text AS count
       FROM completed_trades ct
       JOIN shifts s ON s.id = ct.source_shift_id
       JOIN services sv ON sv.id = s.service_id
      WHERE ct.program_id = $1
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 10`,
    [programId],
  );

  const overTime = await query<{ week: string; count: string }>(
    `SELECT to_char(date_trunc('week', completed_at), 'YYYY-MM-DD') AS week,
            count(*)::text AS count
       FROM completed_trades
      WHERE program_id = $1 AND completed_at > now() - interval '12 weeks'
      GROUP BY 1 ORDER BY 1`,
    [programId],
  );

  const tradeRequests = Number(totals?.trade_requests ?? 0);
  const completedTrades = Number(totals?.completed_trades ?? 0);

  return {
    totals: {
      shifts: Number(totals?.shifts ?? 0),
      upcomingShifts: Number(totals?.upcoming_shifts ?? 0),
      tradeRequests,
      completedTrades,
      pendingApprovals: Number(totals?.pending_approvals ?? 0),
      emailsGenerated: Number(totals?.emails_generated ?? 0),
      emailsMarkedSent: Number(totals?.emails_marked_sent ?? 0),
    },
    completionRate: tradeRequests === 0 ? 0 : Math.round((completedTrades / tradeRequests) * 100),
    averageApprovalHours: approval?.avg_hours ? Number(approval.avg_hours) : null,
    failedValidationReasons: failures.map((row) => ({
      reason: row.reason,
      count: Number(row.count),
    })),
    tradesByPgy: byPgy.map((row) => ({ pgy: row.pgy, count: Number(row.count) })),
    tradesByService: byService.map((row) => ({
      service: row.service,
      count: Number(row.count),
    })),
    tradesOverTime: overTime.map((row) => ({ week: row.week, count: Number(row.count) })),
  };
}
