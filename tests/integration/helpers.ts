import { execFileSync } from "node:child_process";
import { DateTime } from "luxon";
import { getPool, query, queryOne } from "@/server/db/pool";
import type {
  ProgramRow,
  ResidentRow,
  ServiceRow,
  ShiftDetail,
  UserRole,
  UserRow,
} from "@/server/db/types";
import type { AuthedContext } from "@/server/auth/guards";
import { getShiftDetail } from "@/server/domain/schedule";
import { zonedWallTimeToInstant } from "@/server/domain/time";

export const NY = "America/New_York";

let migrated = false;

/** Applies migrations to the test database exactly once per process. */
export function ensureMigrated(): void {
  if (migrated) return;
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "pipe",
  });
  migrated = true;
}

export async function resetDatabase(): Promise<void> {
  await query(`
    TRUNCATE audit_logs, email_records, notifications, trade_legs, completed_trades,
             trade_offers, trade_requests, shift_assignments, shifts, rules,
             program_contacts, residents, sessions, invitations, users, services,
             rotations, programs
    RESTART IDENTITY CASCADE
  `);
}

export async function closeDatabase(): Promise<void> {
  await getPool().end();
}

export interface TestProgram {
  program: ProgramRow;
  services: Record<string, ServiceRow>;
}

export async function createProgram(
  overrides: Partial<{
    name: string;
    timezone: string;
    approvedEmailDomains: string[];
    defaultTradeApprovalRequired: boolean;
  }> = {},
): Promise<TestProgram> {
  const program = (await queryOne<ProgramRow>(
    `INSERT INTO programs (name, institution, timezone, approved_email_domains, default_trade_approval_required)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      overrides.name ?? "Test Residency",
      "Test Hospital",
      overrides.timezone ?? NY,
      overrides.approvedEmailDomains ?? [],
      overrides.defaultTradeApprovalRequired ?? false,
    ],
  ))!;

  const services: Record<string, ServiceRow> = {};
  for (const name of ["MICU", "Floor", "Clinic"]) {
    services[name] = (await queryOne<ServiceRow>(
      "INSERT INTO services (program_id, name) VALUES ($1, $2) RETURNING *",
      [program.id, name],
    ))!;
  }
  return { program, services };
}

export interface TestResident {
  user: UserRow;
  resident: ResidentRow;
  context: AuthedContext & { resident: ResidentRow };
}

export async function createResident(
  program: ProgramRow,
  options: {
    email: string;
    name?: string;
    pgy?: number;
    role?: UserRole;
    credentials?: string[];
    active?: boolean;
  },
): Promise<TestResident> {
  const user = (await queryOne<UserRow>(
    `INSERT INTO users (auth_user_id, email, full_name, role, program_id, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      `sub-${options.email}`,
      options.email,
      options.name ?? options.email,
      options.role ?? "resident",
      program.id,
      options.active ?? true,
    ],
  ))!;
  const resident = (await queryOne<ResidentRow>(
    `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      user.id,
      program.id,
      options.pgy ?? 2,
      2029,
      options.credentials ?? ["BLS", "ACLS"],
      options.active ?? true,
    ],
  ))!;
  return { user, resident, context: makeContext(program, user, resident) };
}

export async function createStaff(
  program: ProgramRow,
  options: { email: string; role: UserRole; name?: string },
): Promise<{ user: UserRow; context: AuthedContext }> {
  const user = (await queryOne<UserRow>(
    `INSERT INTO users (auth_user_id, email, full_name, role, program_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [`sub-${options.email}`, options.email, options.name ?? options.email, options.role, program.id],
  ))!;
  return { user, context: makeContext(program, user, null) };
}

export function makeContext(
  program: ProgramRow,
  user: UserRow,
  resident: ResidentRow | null,
): AuthedContext & { resident: ResidentRow } {
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      pictureUrl: null,
      role: user.role!,
      programId: program.id,
      active: user.active,
    },
    program,
    resident,
    sessionId: "test-session",
  } as AuthedContext & { resident: ResidentRow };
}

export interface CreateShiftOptions {
  /** Days from now (local calendar), e.g. 7 for a week away. */
  inDays: number;
  service?: ServiceRow;
  serviceId?: string;
  startTime?: string;
  endTime?: string;
  overnight?: boolean;
  residentId?: string;
  tradeable?: boolean;
  approvalRequired?: boolean;
  requiredPgyMin?: number;
  requiredPgyMax?: number;
  tradeDeadline?: Date | null;
  location?: string;
  shiftType?: string;
}

export async function createShift(
  program: ProgramRow,
  options: CreateShiftOptions,
): Promise<ShiftDetail> {
  const date = DateTime.now()
    .setZone(program.timezone)
    .plus({ days: options.inDays })
    .toISODate() as string;
  const startTime = options.startTime ?? "07:00";
  const endTime = options.endTime ?? "19:00";
  const start = zonedWallTimeToInstant(date, startTime, program.timezone);
  const endDate = options.overnight
    ? (DateTime.fromISO(date).plus({ days: 1 }).toISODate() as string)
    : date;
  const end = zonedWallTimeToInstant(endDate, endTime, program.timezone);

  const serviceId =
    options.serviceId ??
    options.service?.id ??
    (
      await queryOne<{ id: string }>(
        "SELECT id FROM services WHERE program_id = $1 ORDER BY name LIMIT 1",
        [program.id],
      )
    )!.id;

  const shift = (await queryOne<{ id: string }>(
    `INSERT INTO shifts
       (program_id, service_id, date, start_datetime, end_datetime, location, shift_type,
        required_pgy_min, required_pgy_max, tradeable, approval_required, trade_deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      program.id,
      serviceId,
      date,
      start,
      end,
      options.location ?? "Ward 6 East",
      options.shiftType ?? (options.overnight ? "night" : "day"),
      options.requiredPgyMin ?? 1,
      options.requiredPgyMax ?? 5,
      options.tradeable ?? true,
      options.approvalRequired ?? false,
      options.tradeDeadline ?? null,
    ],
  ))!;

  if (options.residentId) {
    await query("INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)", [
      shift.id,
      options.residentId,
    ]);
  }
  return (await getShiftDetail(shift.id))!;
}

export async function addRule(
  program: ProgramRow,
  ruleType: string,
  params: Record<string, unknown>,
  overrides: Partial<{
    severity: "error" | "warning";
    scope: "program" | "service" | "rotation" | "shift";
    scopeId: string | null;
    overridable: boolean;
  }> = {},
): Promise<{ id: string }> {
  return (await queryOne<{ id: string }>(
    `INSERT INTO rules (program_id, rule_type, name, params, severity, scope, scope_id, overridable)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) RETURNING id`,
    [
      program.id,
      ruleType,
      ruleType,
      JSON.stringify(params),
      overrides.severity ?? "error",
      overrides.scope ?? "program",
      overrides.scopeId ?? null,
      overrides.overridable ?? true,
    ],
  ))!;
}

export async function activeAssignee(shiftId: string): Promise<string | null> {
  const row = await queryOne<{ resident_id: string }>(
    "SELECT resident_id FROM shift_assignments WHERE shift_id = $1 AND assignment_status = 'active'",
    [shiftId],
  );
  return row?.resident_id ?? null;
}

export async function countActiveAssignments(shiftId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT count(*)::text AS count FROM shift_assignments WHERE shift_id = $1 AND assignment_status = 'active'",
    [shiftId],
  );
  return Number(row?.count ?? 0);
}

export async function auditActions(): Promise<string[]> {
  const rows = await query<{ action: string }>(
    "SELECT action FROM audit_logs ORDER BY id",
  );
  return rows.map((row) => row.action);
}

/** A user's notifications, optionally narrowed to one type. */
export async function notificationsFor(userId: string, type?: string) {
  const values: unknown[] = [userId];
  let where = "recipient_user_id = $1";
  if (type) {
    values.push(type);
    where += " AND type = $2";
  }
  return query<{ type: string; title: string; body: string; route: string }>(
    `SELECT type, title, body, route FROM notifications
      WHERE ${where} ORDER BY created_at`,
    values,
  );
}

/**
 * The invariants that must hold after *any* sequence of trade operations,
 * whatever order they interleaved in.
 *
 * Concurrency tests that only count successes miss the failure that matters.
 * "One accept won and one lost" is compatible with a database in which a shift
 * has two holders, or a completed switch has one leg, or a resident's shift was
 * given away without them receiving anything. This asserts the state itself, so
 * a torn switch is caught even when every call returned the expected verdict.
 *
 * Throws with a description of what is wrong rather than returning a boolean —
 * a failing invariant should read like a bug report.
 */
export async function assertDatabaseConsistent(): Promise<void> {
  const problems: string[] = [];

  // 1. No shift has two people on it, and none has been left with nobody.
  const assignments = await query<{ shift_id: string; holders: string }>(
    `SELECT s.id AS shift_id,
            (SELECT count(*)::text FROM shift_assignments a
              WHERE a.shift_id = s.id AND a.assignment_status = 'active') AS holders
       FROM shifts s WHERE s.status <> 'cancelled'`,
  );
  for (const row of assignments) {
    if (row.holders !== "1") {
      problems.push(`shift ${row.shift_id} has ${row.holders} active assignments`);
    }
  }

  // 2. Every completed switch moved exactly two shifts.
  const legs = await query<{ id: string; legs: string }>(
    `SELECT c.id, (SELECT count(*)::text FROM trade_legs l
                    WHERE l.completed_trade_id = c.id) AS legs
       FROM completed_trades c`,
  );
  for (const row of legs) {
    if (row.legs !== "2") {
      problems.push(`completed trade ${row.id} has ${row.legs} legs, not 2`);
    }
  }

  /* 3. A completed switch actually swapped the two residents — the torn-write
        check. Half-applied means one shift moved and the other did not, which
        counting rows above cannot see.

        Asked of the assignment that was active **at the moment the trade
        completed**, reconstructed from `shift_assignments` history, rather than
        of whoever holds the shift now. Those are different questions, and only
        the first one is about atomicity. Comparing current holders says a
        completed switch is torn the moment an administrator legitimately
        reassigns either shift afterwards — which is an ordinary thing to do and
        not a defect. Reading the history also makes the check immune to
        anything that happens after the transaction it is testing.

        The timestamps line up exactly because `now()` is transaction-start time
        in PostgreSQL: within finalisation, the old assignment's `ended_at`, the
        new one's `assigned_at` and `completed_at` are all the same instant. So
        `assigned_at <= completed_at` includes the new row, and
        `ended_at > completed_at` excludes the old one. */
  const swaps = await query<{
    id: string;
    source_holder: string | null;
    destination_holder: string | null;
    resident_a: string;
    resident_b: string;
  }>(
    `SELECT c.id, c.resident_a, c.resident_b,
            (SELECT a.resident_id FROM shift_assignments a
              WHERE a.shift_id = c.source_shift_id
                AND a.assigned_at <= c.completed_at
                AND (a.ended_at IS NULL OR a.ended_at > c.completed_at)
              ORDER BY a.assigned_at DESC LIMIT 1) AS source_holder,
            (SELECT a.resident_id FROM shift_assignments a
              WHERE a.shift_id = c.destination_shift_id
                AND a.assigned_at <= c.completed_at
                AND (a.ended_at IS NULL OR a.ended_at > c.completed_at)
              ORDER BY a.assigned_at DESC LIMIT 1) AS destination_holder
       FROM completed_trades c`,
  );
  for (const row of swaps) {
    const swapped =
      row.source_holder === row.resident_b && row.destination_holder === row.resident_a;
    const reverted =
      row.source_holder === row.resident_a && row.destination_holder === row.resident_b;
    if (!swapped && !reverted) {
      problems.push(
        `completed trade ${row.id} is half applied: source held by ${row.source_holder}, destination by ${row.destination_holder}`,
      );
    }
    if (reverted) {
      problems.push(`completed trade ${row.id} was recorded but never applied`);
    }
  }

  // 4. No offer is left accepted with nothing having happened to it, and no
  //    request claims a live state while its shift is back to normal.
  const stranded = await query<{ id: string; status: string }>(
    `SELECT o.id, o.status::text AS status FROM trade_offers o
       JOIN trade_requests r ON r.id = o.trade_request_id
      WHERE o.status = 'accepted'
        AND r.status IN ('completed', 'cancelled', 'expired')`,
  );
  for (const row of stranded) {
    problems.push(`offer ${row.id} is still 'accepted' on a finished request`);
  }

  // 5. A shift may not be marked as being traded when no trade references it.
  const orphaned = await query<{ id: string; status: string }>(
    `SELECT s.id, s.status::text AS status FROM shifts s
      WHERE s.status IN ('posted', 'offer_pending', 'pending_approval')
        AND NOT EXISTS (
          SELECT 1 FROM trade_requests r
           WHERE r.source_shift_id = s.id
             AND r.status IN ('open', 'offer_pending', 'accepted', 'pending_approval', 'approved')
        )
        AND NOT EXISTS (
          SELECT 1 FROM trade_offers o
           WHERE o.offered_shift_id = s.id AND o.status IN ('pending', 'accepted')
        )`,
  );
  for (const row of orphaned) {
    problems.push(`shift ${row.id} is '${row.status}' but no live trade references it`);
  }

  if (problems.length > 0) {
    throw new Error(`Database is inconsistent:\n  - ${problems.join("\n  - ")}`);
  }
}
