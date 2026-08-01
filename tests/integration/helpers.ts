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
             trade_offers, trade_requests, schedule_corrections, resident_absences,
             schedule_version_locks, shift_assignments, shifts, schedule_versions,
             rules, program_contacts, residents, sessions, invitations, users,
             services, rotations, programs
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
    /**
     * The services to create. Pass `[]` for a programme where genuinely
     * nothing has been set up — which is what the first resident to open this
     * product actually has, and what `marketplace-first.test.ts` needs in
     * order to be testing anything.
     */
    services: string[];
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
  for (const name of overrides.services ?? ["MICU", "Floor", "Clinic"]) {
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
      enrollmentStatus: "confirmed" as const,
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

  /* 1. No **published** shift has two people on it.

        Scoped to published shifts for the "nobody" half below; two holders is
        checked here and in 1b because it is never acceptable anywhere. */
  const assignments = await query<{ shift_id: string; holders: string }>(
    `SELECT s.id AS shift_id,
            (SELECT count(*)::text FROM shift_assignments a
              WHERE a.shift_id = s.id AND a.assignment_status = 'active') AS holders
       FROM shifts s
      WHERE s.status <> 'cancelled' AND s.schedule_version_id IS NULL`,
  );
  for (const row of assignments) {
    if (Number(row.holders) > 1) {
      problems.push(`shift ${row.shift_id} has ${row.holders} active assignments`);
    }
  }

  /* 1a. A live shift with nobody on it must be *explicable*.

        "Every live shift has exactly one holder" was true before drafts
        existed and is not true now: a draft may legitimately be published with
        an unfilled slot, because approval is deliberately not a validity check
        — a chief who publishes a schedule with a hole in it, because the
        alternative is no schedule at all, is making a real decision and the
        product's job is to record it. A gap is what the coverage report and the
        unfilled queue are *for*.

        What is still never acceptable is a shift somebody *was* on, in a
        schedule people are working, that now has nobody — with no record of the
        change. That is a torn switch, and it is the thing the original
        invariant was written to catch.

        So the distinction is drawn structurally rather than by time: an
        **`ended` assignment row only ever means a live change**. Clearing a
        draft cell deletes the row instead of ending it — nobody has worked a
        draft shift, so there is no history to keep — which leaves a shift
        published with an empty cell holding no assignment rows at all, exactly
        like one that was never filled.

        Timestamps cannot draw this line, and trying was wrong: `now()` is
        transaction-*start* time in PostgreSQL, so a draft edit that begins
        after a publication begins and commits before it carries an `ended_at`
        later than the version's `published_at` despite genuinely happening
        while the shift was a draft. Comparing them made this check fail about
        one run in three, which is the shape of a "flaky test" that is really a
        wrong assertion.

        A completed switch is deliberately *not* an excuse. Finalisation ends
        one assignment and inserts the replacement in the same transaction, so a
        switch that worked leaves an active row and never reaches this query at
        all; one that reached here is a switch that tore, which is precisely
        what this was written to catch. */
  const emptied = await query<{ shift_id: string; ended: string }>(
    `SELECT s.id AS shift_id, max(a.ended_at)::text AS ended
       FROM shifts s
       JOIN shift_assignments a ON a.shift_id = s.id
      WHERE s.status <> 'cancelled'
        AND s.schedule_version_id IS NULL
        AND a.assignment_status = 'ended'
        AND NOT EXISTS (
          SELECT 1 FROM shift_assignments b
           WHERE b.shift_id = s.id AND b.assignment_status = 'active')
        AND NOT EXISTS (
          SELECT 1 FROM schedule_corrections c WHERE c.shift_id = s.id)
      GROUP BY s.id`,
  );
  for (const row of emptied) {
    problems.push(
      `shift ${row.shift_id} was emptied at ${row.ended} with nobody put on it, ` +
        "and no correction or completed switch accounts for it",
    );
  }

  /* 1b. A draft shift may still not have *two* holders. "Nobody yet" is a
         legitimate intermediate state; "two people at once" never is,
         whichever schedule it is in. */
  const draftHolders = await query<{ shift_id: string; holders: string }>(
    `SELECT s.id AS shift_id,
            (SELECT count(*)::text FROM shift_assignments a
              WHERE a.shift_id = s.id AND a.assignment_status = 'active') AS holders
       FROM shifts s
      WHERE s.status <> 'cancelled' AND s.schedule_version_id IS NOT NULL`,
  );
  for (const row of draftHolders) {
    if (Number(row.holders) > 1) {
      problems.push(
        `draft shift ${row.shift_id} has ${row.holders} active assignments`,
      );
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

  /* 6. Nobody is in two places at once.

        Asked of the assignment history rather than of current holders, for the
        same reason invariant 3 is: the question is whether the *state at each
        moment* was ever impossible, and reading current rows answers a
        different one. Two shifts that overlapped last month and have since been
        legitimately reassigned to different people are not a defect; two
        assignments that were both active while their shifts overlapped are.

        `tstzrange` with the assignment's own live window intersected against
        the shift's — `assigned_at` to `ended_at`, open-ended while active — so
        an administrator who moved somebody off one of two overlapping shifts is
        not reported as having created the overlap they resolved. */
  const collisions = await query<{
    resident_id: string;
    first_shift: string;
    second_shift: string;
  }>(
    `SELECT a.resident_id, a.shift_id AS first_shift, b.shift_id AS second_shift
       FROM shift_assignments a
       JOIN shifts sa ON sa.id = a.shift_id AND sa.status <> 'cancelled'
       JOIN shift_assignments b
         ON b.resident_id = a.resident_id AND b.shift_id > a.shift_id
       JOIN shifts sb ON sb.id = b.shift_id AND sb.status <> 'cancelled'
      WHERE sa.schedule_version_id IS NULL AND sb.schedule_version_id IS NULL
        AND tstzrange(sa.start_datetime, sa.end_datetime, '[)')
            && tstzrange(sb.start_datetime, sb.end_datetime, '[)')
        AND tstzrange(a.assigned_at, a.ended_at, '[)')
            && tstzrange(b.assigned_at, b.ended_at, '[)')`,
  );
  for (const row of collisions) {
    problems.push(
      `resident ${row.resident_id} held overlapping shifts ${row.first_shift} and ${row.second_shift} at the same time`,
    );
  }

  /* 7. No published shift is orphaned between a schedule version and a trade.

        Three ways that can happen, and all three are silent:
          - a shift still points at a draft that no longer exists;
          - a shift claims to have come from a publication that was never
            published;
          - a trade references a shift that is inside a draft, which the
            database trigger is meant to make impossible. */
  const orphanedVersions = await query<{ id: string; reason: string }>(
    `SELECT s.id, 'points at a draft that no longer exists' AS reason
       FROM shifts s
      WHERE s.schedule_version_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM schedule_versions v WHERE v.id = s.schedule_version_id)
     UNION ALL
     SELECT s.id, 'claims a publication that was never published' AS reason
       FROM shifts s
       JOIN schedule_versions v ON v.id = s.published_version_id
      WHERE v.status <> 'published'
     UNION ALL
     SELECT s.id, 'is in a draft and referenced by a trade' AS reason
       FROM shifts s
      WHERE s.schedule_version_id IS NOT NULL
        AND (
          EXISTS (SELECT 1 FROM trade_requests r WHERE r.source_shift_id = s.id)
          OR EXISTS (SELECT 1 FROM trade_offers o WHERE o.offered_shift_id = s.id)
        )`,
  );
  for (const row of orphanedVersions) {
    problems.push(`shift ${row.id} ${row.reason}`);
  }

  /* 8. Every correction records what it replaced.

        A correction row whose shift no longer exists, or which claims a
        previous holder who never held it at that moment, is a record somebody
        will one day rely on to answer "who agreed to this". */
  const brokenCorrections = await query<{ id: string; reason: string }>(
    `SELECT c.id, 'refers to a shift that no longer exists' AS reason
       FROM schedule_corrections c
      WHERE NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = c.shift_id)
     UNION ALL
     SELECT c.id, 'names a previous holder who never held that shift' AS reason
       FROM schedule_corrections c
      WHERE c.previous_resident_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM shift_assignments a
           WHERE a.shift_id = c.shift_id AND a.resident_id = c.previous_resident_id
        )`,
  );
  for (const row of brokenCorrections) {
    problems.push(`correction ${row.id} ${row.reason}`);
  }

  if (problems.length > 0) {
    throw new Error(`Database is inconsistent:\n  - ${problems.join("\n  - ")}`);
  }
}
