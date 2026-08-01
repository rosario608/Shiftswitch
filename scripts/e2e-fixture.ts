#!/usr/bin/env tsx
/**
 * Deterministic fixture for the end-to-end suite.
 *
 * Resets the target database and creates a small, predictable program:
 *   e2e.alice@hospital.org   PGY-2, three upcoming tradeable shifts
 *   e2e.bob@hospital.org     PGY-2, three upcoming tradeable shifts
 *   e2e.carol@hospital.org   PGY-2, one shift that requires chief approval
 *   e2e.chief@hospital.org   chief resident
 *   e2e.pd@hospital.org      program director
 *   e2e.apd@hospital.org     associate program director
 *   e2e.admin@hospital.org   program administrator
 *   e2e.pending@hospital.org authenticated but not configured
 *   e2e.deactivated@hospital.org  configured, then deactivated
 *
 * Plus a second program, "E2E Other Program", with its own administrator,
 * resident and shift, so cross-program access can be attacked for real.
 */
import { DateTime } from "luxon";
import { assertDestructiveAllowed } from "./db-guard";
import { loadEnv } from "./load-env";

loadEnv();

/* The fixture truncates every table before rebuilding. Every end-to-end spec
   calls it in `beforeAll`, so it runs constantly — which makes an unguarded
   TRUNCATE against a mistyped DATABASE_URL a matter of time. */
assertDestructiveAllowed("truncate every table", "ALLOW_REMOTE_E2E_FIXTURE");

const TZ = "America/New_York";

async function main() {
  const { closePool, query, queryOne } = await import("@/server/db/pool");
  const { zonedWallTimeToInstant } = await import("@/server/domain/time");

  await query(`
    TRUNCATE audit_logs, email_records, notifications, trade_legs, completed_trades,
             trade_offers, trade_requests, schedule_corrections, resident_absences,
             schedule_version_locks, shift_assignments, shifts, schedule_versions,
             rules, program_contacts, residents, sessions, invitations, users,
             services, rotations, programs
    RESTART IDENTITY CASCADE
  `);

  const program = (await queryOne<{ id: string }>(
    `INSERT INTO programs (name, institution, timezone, approved_email_domains, default_trade_approval_required)
     VALUES ($2, 'Riverside University Hospital', $1, '{}', false)
     RETURNING id`,
    // The program name is configurable so the store-screenshot run can use a
    // presentable (still entirely fictional) one without the assertions in the
    // functional suites having to change.
    [TZ, process.env.E2E_PROGRAM_NAME ?? "E2E Internal Medicine"],
  ))!;

  const services: Record<string, string> = {};
  for (const name of ["MICU", "Floor", "Night Float"]) {
    const row = (await queryOne<{ id: string }>(
      "INSERT INTO services (program_id, name) VALUES ($1, $2) RETURNING id",
      [program.id, name],
    ))!;
    services[name] = row.id;
  }

  await query(
    `INSERT INTO program_contacts (program_id, name, email, contact_type, notify_role)
     VALUES ($1, 'Rachel Whitmore', 'coordinator@hospital.org', 'program_coordinator', 'to'),
            ($1, 'Jordan Blake', 'chief@hospital.org', 'chief_resident', 'cc')`,
    [program.id],
  );

  for (const [ruleType, params] of [
    ["min_rest_hours", { hours: 8 }],
    ["max_consecutive_shifts", { days: 6 }],
    ["no_overlapping_shifts", {}],
    ["pgy_requirement", { maxPgyDifference: 2 }],
  ] as const) {
    await query(
      `INSERT INTO rules (program_id, rule_type, name, params) VALUES ($1, $2, $2, $3::jsonb)`,
      [program.id, ruleType, JSON.stringify(params)],
    );
  }

  async function createUser(
    email: string,
    name: string,
    role: import("@/server/db/types").UserRole | null,
  ) {
    return (await queryOne<{ id: string }>(
      `INSERT INTO users (auth_user_id, email, full_name, role, program_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`e2e-${email}`, email, name, role, role ? program.id : null],
    ))!;
  }

  /* Phone numbers on everybody who holds a schedule, because the directory is
     a screen whose entire content is contact details and a fixture without
     them can only prove that the page renders. Stored E.164, as
     `normalisePhone` would leave them. */
  let nextPhone = 1000;

  async function createResident(email: string, name: string, pgy: number) {
    const user = await createUser(email, name, "resident");
    nextPhone += 1;
    const resident = (await queryOne<{ id: string }>(
      `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials, phone)
       VALUES ($1, $2, $3, 2029, '{BLS,ACLS,"Critical Care"}', $4) RETURNING id`,
      [user.id, program.id, pgy, `+1919555${nextPhone}`],
    ))!;
    return { userId: user.id, residentId: resident.id };
  }

  const alice = await createResident("e2e.alice@hospital.org", "Alice Adeyemi", 2);
  const bob = await createResident("e2e.bob@hospital.org", "Bob Brennan", 2);
  const carol = await createResident("e2e.carol@hospital.org", "Carol Costa", 2);

  const chiefUser = await createUser("e2e.chief@hospital.org", "Casey Chief", "chief");
  await query(
    `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials, phone)
     VALUES ($1, $2, 3, 2028, '{BLS,ACLS}', '+19195550100')`,
    [chiefUser.id, program.id],
  );
  await createUser("e2e.admin@hospital.org", "Dana Admin", "admin");
  // Program leadership, so the role boundaries can be exercised end to end.
  await createUser("e2e.pd@hospital.org", "Priya Director", "pd");
  await createUser("e2e.apd@hospital.org", "Amir Deputy", "apd");
  await createUser("e2e.pending@hospital.org", "Pat Pending", null);

  async function createShift(options: {
    residentId: string;
    inDays: number;
    service: string;
    overnight?: boolean;
    approvalRequired?: boolean;
    tradeable?: boolean;
  }) {
    const date = DateTime.now()
      .setZone(TZ)
      .plus({ days: options.inDays })
      .toISODate() as string;
    const startTime = options.overnight ? "19:00" : "07:00";
    const endTime = options.overnight ? "07:00" : "19:00";
    const start = zonedWallTimeToInstant(date, startTime, TZ);
    const endDate = options.overnight
      ? (DateTime.fromISO(date).plus({ days: 1 }).toISODate() as string)
      : date;
    const end = zonedWallTimeToInstant(endDate, endTime, TZ);
    const shift = (await queryOne<{ id: string }>(
      `INSERT INTO shifts
         (program_id, service_id, date, start_datetime, end_datetime, location, shift_type,
          required_pgy_min, required_pgy_max, tradeable, approval_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 5, $8, $9) RETURNING id`,
      [
        program.id,
        services[options.service],
        date,
        start,
        end,
        options.service === "MICU" ? "ICU Tower 4" : "Ward 6 East",
        options.overnight ? "night" : "day",
        options.tradeable ?? true,
        options.approvalRequired ?? false,
      ],
    ))!;
    await query("INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)", [
      shift.id,
      options.residentId,
    ]);
    return shift.id;
  }

  // Spread the shifts out so no rest or consecutive-day rule is triggered.
  await createShift({ residentId: alice.residentId, inDays: 6, service: "MICU" });
  await createShift({ residentId: alice.residentId, inDays: 14, service: "Floor" });
  await createShift({ residentId: alice.residentId, inDays: 30, service: "MICU" });

  await createShift({ residentId: bob.residentId, inDays: 10, service: "MICU" });
  await createShift({ residentId: bob.residentId, inDays: 20, service: "Floor" });
  await createShift({
    residentId: bob.residentId,
    inDays: 26,
    service: "Night Float",
    overnight: true,
  });

  await createShift({
    residentId: carol.residentId,
    inDays: 12,
    service: "MICU",
    approvalRequired: true,
  });
  await createShift({ residentId: carol.residentId, inDays: 34, service: "Floor" });

  /*
   * A second program, and a deactivated account.
   *
   * Both exist so the authorization suite can attack the real thing rather than
   * a hypothetical: cross-program access needs a genuine second program with a
   * genuine administrator and a genuine shift, and "a deactivated account is
   * refused" is only meaningful if the account previously worked.
   */
  const otherProgram = (await queryOne<{ id: string }>(
    `INSERT INTO programs (name, institution, timezone, approved_email_domains, default_trade_approval_required)
     VALUES ('E2E Other Program', 'Second Teaching Hospital', $1, '{}', false)
     RETURNING id`,
    [TZ],
  ))!;
  const otherService = (await queryOne<{ id: string }>(
    "INSERT INTO services (program_id, name) VALUES ($1, 'Other MICU') RETURNING id",
    [otherProgram.id],
  ))!;
  const otherAdmin = (await queryOne<{ id: string }>(
    `INSERT INTO users (auth_user_id, email, full_name, role, program_id)
     VALUES ('e2e-other-admin', 'e2e.other.admin@hospital.org', 'Otto Other', 'admin', $1)
     RETURNING id`,
    [otherProgram.id],
  ))!;
  const otherUser = (await queryOne<{ id: string }>(
    `INSERT INTO users (auth_user_id, email, full_name, role, program_id)
     VALUES ('e2e-other-resident', 'e2e.other.resident@hospital.org', 'Olive Other', 'resident', $1)
     RETURNING id`,
    [otherProgram.id],
  ))!;
  const otherResident = (await queryOne<{ id: string }>(
    `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials)
     VALUES ($1, $2, 2, 2029, '{BLS}') RETURNING id`,
    [otherUser.id, otherProgram.id],
  ))!;
  {
    const date = DateTime.now().setZone(TZ).plus({ days: 15 }).toISODate() as string;
    const shift = (await queryOne<{ id: string }>(
      `INSERT INTO shifts
         (program_id, service_id, date, start_datetime, end_datetime, location, shift_type,
          required_pgy_min, required_pgy_max, tradeable, approval_required)
       VALUES ($1, $2, $3, $4, $5, 'Other Ward', 'day', 1, 5, true, false) RETURNING id`,
      [
        otherProgram.id,
        otherService.id,
        date,
        zonedWallTimeToInstant(date, "07:00", TZ),
        zonedWallTimeToInstant(date, "19:00", TZ),
      ],
    ))!;
    await query("INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)", [
      shift.id,
      otherResident.id,
    ]);
  }
  void otherAdmin;

  // Configured, then switched off — the state a resident who has left is in.
  await createUser("e2e.deactivated@hospital.org", "Dee Activated", "resident");
  await query("UPDATE users SET active = false WHERE email = $1", [
    "e2e.deactivated@hospital.org",
  ]);

  console.log("[e2e-fixture] ready");
  await closePool();
}

main().catch((error) => {
  console.error("[e2e-fixture] failed:", error);
  process.exit(1);
});
