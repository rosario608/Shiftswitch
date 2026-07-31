#!/usr/bin/env tsx
/**
 * Provisions the review demo program, on the production database, without
 * touching anything that already exists.
 *
 *   REVIEW_RESIDENT_EMAIL=... REVIEW_CHIEF_EMAIL=... npx tsx scripts/seed-demo.ts
 *
 * Why this exists
 * ---------------
 * App Review and Play review both need working credentials. Sign-in is Google
 * only, so a reviewer needs a real Google account — and that account must never
 * be able to see a real resident, a real schedule, a real email address or real
 * leave information.
 *
 * So this creates a *separate program*, "Demo Residency (App Review)", with
 * invented residents and an invented schedule, and attaches the reviewer
 * accounts to that program only. Authorisation is per-program and enforced
 * server-side, so a reviewer signed into the demo program cannot read another
 * program's data even by changing an id — `tests/e2e/security.spec.ts` covers
 * exactly that.
 *
 * The two reviewer email addresses must be Google accounts your institution
 * controls. Create them, run this, then put the credentials in App Store
 * Connect and the Play Console review notes.
 *
 * Re-running is safe: it removes and rebuilds only the demo program.
 */
import { DateTime } from "luxon";
import { loadEnv } from "./load-env";

loadEnv();

const PROGRAM_NAME = "Demo Residency (App Review)";
const INSTITUTION = "Demo Teaching Hospital";
const TZ = "America/New_York";

async function main() {
  const residentEmail = process.env.REVIEW_RESIDENT_EMAIL;
  const chiefEmail = process.env.REVIEW_CHIEF_EMAIL;
  if (!residentEmail || !chiefEmail) {
    console.error(
      "Set REVIEW_RESIDENT_EMAIL and REVIEW_CHIEF_EMAIL to the Google accounts\n" +
        "you created for App Review and Play review, then run again.",
    );
    process.exit(1);
  }
  if (residentEmail === chiefEmail) {
    console.error("The two reviewer accounts must be different addresses.");
    process.exit(1);
  }

  const { closePool, query, queryOne } = await import("@/server/db/pool");
  const { zonedWallTimeToInstant } = await import("@/server/domain/time");
  type ProgramRow = import("@/server/db/types").ProgramRow;

  // Remove any previous demo program. Scoped by name so a real program is
  // never in scope, and cascading deletes take its residents and shifts.
  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM programs WHERE name = $1",
    [PROGRAM_NAME],
  );
  if (existing) {
    console.log("[demo] removing the previous demo program");
    await query("DELETE FROM users WHERE program_id = $1", [existing.id]);
    await query("DELETE FROM programs WHERE id = $1", [existing.id]);
  }

  const program = (await queryOne<ProgramRow>(
    `INSERT INTO programs (name, institution, timezone, approved_email_domains, default_trade_approval_required)
     VALUES ($1, $2, $3, '{}', false) RETURNING *`,
    [PROGRAM_NAME, INSTITUTION, TZ],
  ))!;

  const services: Record<string, string> = {};
  for (const name of ["Demo MICU", "Demo Wards", "Demo Night Float"]) {
    const row = (await queryOne<{ id: string }>(
      "INSERT INTO services (program_id, name, tradeable, active) VALUES ($1, $2, true, true) RETURNING id",
      [program.id, name],
    ))!;
    services[name] = row.id;
  }

  // A representative rule set, so a reviewer sees the rule engine do something
  // rather than an empty checklist.
  const rules: Array<[string, Record<string, unknown>]> = [
    ["max_consecutive_days", { maxDays: 6 }],
    ["min_rest_between_shifts", { minHours: 10 }],
    ["pgy_level_match", { allowHigher: true }],
    ["max_hours_per_week", { maxHours: 80, windowDays: 7 }],
  ];
  for (const [ruleType, params] of rules) {
    await query(
      "INSERT INTO rules (program_id, rule_type, name, params) VALUES ($1, $2, $2, $3::jsonb)",
      [program.id, ruleType, JSON.stringify(params)],
    );
  }

  await query(
    `INSERT INTO program_contacts (program_id, name, email, contact_type, notify_role, active)
     VALUES ($1, 'Demo Coordinator', 'coordinator@demo.invalid', 'program_coordinator', 'to', true)`,
    [program.id],
  );

  async function createResident(
    email: string,
    name: string,
    pgy: number,
    role: "resident" | "chief",
  ) {
    const user = (await queryOne<{ id: string }>(
      `INSERT INTO users (email, full_name, role, program_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, name, role, program.id],
    ))!;
    const resident = (await queryOne<{ id: string }>(
      `INSERT INTO residents (user_id, program_id, pgy_level, graduation_year, credentials)
       VALUES ($1, $2, $3, 2029, '{BLS,ACLS}') RETURNING id`,
      [user.id, program.id, pgy],
    ))!;
    return { userId: user.id, residentId: resident.id };
  }

  // The two accounts the reviewer signs into.
  const reviewer = await createResident(
    residentEmail,
    "Sam Reviewer",
    2,
    "resident",
  );
  const chief = await createResident(chiefEmail, "Alex Chief", 3, "chief");

  // Invented colleagues, so the switch board is not empty. These accounts have
  // no sign-in identity and nobody can log in as them.
  const dana = await createResident(
    "dana.demo@demo.invalid",
    "Dana Demo",
    2,
    "resident",
  );
  const jordan = await createResident(
    "jordan.demo@demo.invalid",
    "Jordan Demo",
    2,
    "resident",
  );

  async function createShift(
    residentId: string,
    serviceName: string,
    dayOffset: number,
    startHour: number,
    hours: number,
    location: string,
  ) {
    const day = DateTime.now().setZone(TZ).plus({ days: dayOffset }).startOf("day");
    const start = zonedWallTimeToInstant(
      day.toISODate()!,
      `${String(startHour).padStart(2, "0")}:00`,
      TZ,
    );
    const end = new Date(start.getTime() + hours * 3_600_000);
    const shift = (await queryOne<{ id: string }>(
      `INSERT INTO shifts (program_id, service_id, date, start_datetime, end_datetime,
                           location, shift_type, required_pgy_min, required_pgy_max,
                           tradeable, approval_required, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 5, true, false, 'scheduled')
       RETURNING id`,
      [
        program.id,
        services[serviceName],
        day.toISODate(),
        start,
        end,
        location,
        startHour >= 19 ? "night" : "day",
      ],
    ))!;
    await query(
      `INSERT INTO shift_assignments (shift_id, resident_id, assignment_status)
       VALUES ($1, $2, 'active')`,
      [shift.id, residentId],
    );
    return shift.id;
  }

  // A month of invented schedule for each of the four.
  const plan: Array<[string, string, number, number, number, string]> = [
    // resident, service, dayOffset, startHour, hours, location
    ["reviewer", "Demo MICU", 3, 7, 12, "Demo ICU 4"],
    ["reviewer", "Demo Wards", 9, 7, 12, "Demo Ward 6"],
    ["reviewer", "Demo Night Float", 16, 19, 12, "Demo ICU 4"],
    ["reviewer", "Demo Wards", 23, 7, 12, "Demo Ward 6"],
    ["dana", "Demo MICU", 5, 7, 12, "Demo ICU 4"],
    ["dana", "Demo Wards", 12, 7, 12, "Demo Ward 6"],
    ["dana", "Demo MICU", 19, 7, 12, "Demo ICU 4"],
    ["jordan", "Demo Wards", 6, 7, 12, "Demo Ward 6"],
    ["jordan", "Demo Night Float", 13, 19, 12, "Demo ICU 4"],
    ["jordan", "Demo MICU", 21, 7, 12, "Demo ICU 4"],
    ["chief", "Demo Wards", 8, 7, 12, "Demo Ward 6"],
  ];
  const residents: Record<string, string> = {
    reviewer: reviewer.residentId,
    chief: chief.residentId,
    dana: dana.residentId,
    jordan: jordan.residentId,
  };
  for (const [who, service, day, hour, hours, location] of plan) {
    await createShift(residents[who], service, day, hour, hours, location);
  }

  // Two shifts already posted, so the reviewer sees a populated switch board
  // on first launch without having to create one.
  const { postShiftForTrade } = await import("@/server/domain/trades");
  const danaShift = await queryOne<{ id: string }>(
    `SELECT s.id FROM shifts s
       JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
      WHERE sa.resident_id = $1 ORDER BY s.start_datetime LIMIT 1`,
    [dana.residentId],
  );
  if (danaShift) {
    await postShiftForTrade(
      {
        user: {
          id: dana.userId,
          email: "dana.demo@demo.invalid",
          fullName: "Dana Demo",
          role: "resident",
          programId: program.id,
        },
        program,
        resident: { id: dana.residentId },
        sessionId: "seed",
      } as never,
      {
        shiftId: danaShift.id,
        notes: "Conference that week — happy to take any weekday in return.",
      },
    );
  }

  console.log(`
[demo] Demo program ready.

  Program        ${PROGRAM_NAME}
  Institution    ${INSTITUTION}
  Resident login ${residentEmail}   (Sam Reviewer, PGY-2)
  Chief login    ${chiefEmail}   (Alex Chief, PGY-3, approves switches)

  Everything in it is invented. No real resident, schedule, email address or
  leave information is reachable from these accounts.

  Next: put these two addresses and their passwords in the App Store Connect
  review notes and the Play Console testing instructions. See
  release/REVIEWER_NOTES.md.
`);

  await closePool();
}

main().catch((error) => {
  console.error("[demo] failed:", error);
  process.exit(1);
});
