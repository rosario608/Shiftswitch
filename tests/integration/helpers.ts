import { execFileSync } from "node:child_process";
import { DateTime } from "luxon";
import { getPool, query, queryOne } from "@/server/db/pool";
import type {
  ProgramRow,
  ResidentRow,
  ServiceRow,
  ShiftDetail,
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
    role?: "resident" | "chief" | "admin";
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
  options: { email: string; role: "chief" | "admin"; name?: string },
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

export async function notificationsFor(userId: string) {
  return query<{ type: string; title: string; body: string }>(
    "SELECT type, title, body FROM notifications WHERE recipient_user_id = $1 ORDER BY created_at",
    [userId],
  );
}
