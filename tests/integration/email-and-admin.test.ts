import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import {
  createContact,
  createRule,
  getProgramAnalytics,
  listManagedUsers,
  updateManagedUser,
  updateProgram,
  updateShift,
} from "@/server/domain/admin";
import { commitImport, validateImport } from "@/server/domain/import";
import { toCsv, toPdf, toXlsx } from "@/server/domain/export";
import {
  generateSwitchEmail,
  setEmailStatus,
  updateEmailRecord,
} from "@/server/domain/email";
import { listAuditLogs } from "@/server/domain/audit";
import { acceptOffer, createOffer, postShiftForTrade } from "@/server/domain/trades";
import { listResidentSchedule } from "@/server/domain/schedule";
import {
  closeDatabase,
  createProgram,
  createResident,
  createShift,
  createStaff,
  ensureMigrated,
  resetDatabase,
  type TestProgram,
  type TestResident,
} from "./helpers";

let fixture: TestProgram;
let alice: TestResident;
let bob: TestResident;
let admin: Awaited<ReturnType<typeof createStaff>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram();
  alice = await createResident(fixture.program, {
    email: "alice@hospital.org",
    name: "Alice Adeyemi",
    pgy: 2,
  });
  bob = await createResident(fixture.program, {
    email: "bob@hospital.org",
    name: "Bob Brennan",
    pgy: 2,
  });
  admin = await createStaff(fixture.program, {
    email: "admin@hospital.org",
    role: "admin",
    name: "Dana Admin",
  });
});

async function completeSwitch() {
  const aliceShift = await createShift(fixture.program, {
    inDays: 10,
    residentId: alice.resident.id,
    service: fixture.services.MICU,
    startTime: "19:00",
    endTime: "07:00",
    overnight: true,
  });
  const bobShift = await createShift(fixture.program, {
    inDays: 17,
    residentId: bob.resident.id,
    service: fixture.services.Floor,
  });
  const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
  const { offer } = await createOffer(bob.context, {
    tradeRequestId: request.id,
    offeredShiftId: bobShift.id,
  });
  const outcome = await acceptOffer(alice.context, offer.id);
  if (outcome.status !== "completed") throw new Error("expected a completed switch");
  return { completedTradeId: outcome.completedTradeId, aliceShift, bobShift };
}

describe("program notification email", () => {
  beforeEach(async () => {
    await createContact(admin.context, {
      name: "Coordinator",
      email: "coordinator@hospital.org",
      contactType: "program_coordinator",
      notifyRole: "to",
      active: true,
    });
    await createContact(admin.context, {
      name: "Chief",
      email: "chief@hospital.org",
      contactType: "chief_resident",
      notifyRole: "cc",
      active: true,
    });
  });

  it("generates an email addressed to the program contacts", async () => {
    const { completedTradeId } = await completeSwitch();
    const email = await generateSwitchEmail(alice.context, completedTradeId);

    expect(email.to).toEqual(["coordinator@hospital.org"]);
    expect(email.cc).toEqual(["chief@hospital.org"]);
    expect(email.subject).toMatch(/^Shift Switch – /);
    expect(email.body).toContain("Alice Adeyemi and Bob Brennan");
    expect(email.body).toContain("MICU");
    expect(email.body).toContain("Floor");
    expect(email.mailtoUrl.startsWith("mailto:coordinator%40hospital.org?")).toBe(true);
    expect(email.status).toBe("generated");
  });

  it("stores the email record and audits it", async () => {
    const { completedTradeId } = await completeSwitch();
    await generateSwitchEmail(alice.context, completedTradeId);
    const record = await queryOne<{ status: string; subject: string }>(
      "SELECT status, subject FROM email_records WHERE completed_trade_id = $1",
      [completedTradeId],
    );
    expect(record?.status).toBe("generated");
    const audit = await listAuditLogs({
      programId: fixture.program.id,
      action: "email.generated",
    });
    expect(audit).toHaveLength(1);
  });

  it("is idempotent per user — regenerating returns the same record", async () => {
    const { completedTradeId } = await completeSwitch();
    const first = await generateSwitchEmail(alice.context, completedTradeId);
    const second = await generateSwitchEmail(alice.context, completedTradeId);
    expect(second.emailRecordId).toBe(first.emailRecordId);
  });

  it("lets a participant edit recipients and body", async () => {
    const { completedTradeId } = await completeSwitch();
    const email = await generateSwitchEmail(alice.context, completedTradeId);
    const updated = await updateEmailRecord(alice.context, email.emailRecordId, {
      to: ["coordinator@hospital.org", "apd@hospital.org"],
      subject: "Shift Switch – updated",
    });
    expect(updated.to).toHaveLength(2);
    expect(updated.subject).toBe("Shift Switch – updated");
    expect(updated.mailtoUrl).toContain("apd%40hospital.org");
  });

  it("tracks generated → opened → marked sent without claiming delivery", async () => {
    const { completedTradeId } = await completeSwitch();
    const email = await generateSwitchEmail(alice.context, completedTradeId);
    const opened = await setEmailStatus(alice.context, email.emailRecordId, "opened");
    expect(opened.status).toBe("opened");
    expect(opened.opened_at).toBeTruthy();
    const sent = await setEmailStatus(alice.context, email.emailRecordId, "marked_sent");
    expect(sent.status).toBe("marked_sent");
    expect(sent.marked_sent_at).toBeTruthy();
    // Re-opening it later must not downgrade the "marked sent" state.
    const reopened = await setEmailStatus(alice.context, email.emailRecordId, "opened");
    expect(reopened.status).toBe("marked_sent");
  });

  it("refuses to generate an email for a switch the caller is not part of", async () => {
    const carol = await createResident(fixture.program, {
      email: "carol@hospital.org",
      pgy: 2,
    });
    const { completedTradeId } = await completeSwitch();
    await expect(
      generateSwitchEmail(carol.context, completedTradeId),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets an administrator generate the email on a resident's behalf", async () => {
    const { completedTradeId } = await completeSwitch();
    const email = await generateSwitchEmail(admin.context, completedTradeId);
    expect(email.to).toEqual(["coordinator@hospital.org"]);
  });
});

describe("user administration", () => {
  it("configures a pending account with a role and PGY level", async () => {
    const pending = (await queryOne<{ id: string }>(
      `INSERT INTO users (auth_user_id, email, full_name) VALUES ('sub-new', 'new@hospital.org', 'New Person')
       RETURNING id`,
    ))!;
    const updated = await updateManagedUser(admin.context, pending.id, {
      role: "resident",
      programId: fixture.program.id,
      pgyLevel: 1,
    });
    expect(updated.role).toBe("resident");
    expect(updated.pgy_level).toBe(1);
    expect(updated.resident_id).toBeTruthy();

    const notified = await query<{ title: string }>(
      "SELECT title FROM notifications WHERE recipient_user_id = $1",
      [pending.id],
    );
    expect(notified[0]?.title).toContain("account is ready");
  });

  it("refuses to give a role without a program", async () => {
    const pending = (await queryOne<{ id: string }>(
      `INSERT INTO users (auth_user_id, email, full_name) VALUES ('sub-new2', 'new2@hospital.org', 'New')
       RETURNING id`,
    ))!;
    await expect(
      updateManagedUser(admin.context, pending.id, { role: "resident" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses to manage a user from another program", async () => {
    const other = await createProgram({ name: "Other Program" });
    const outsider = await createResident(other.program, {
      email: "outsider@other.org",
    });
    await expect(
      updateManagedUser(admin.context, outsider.user.id, { role: "chief" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("stops an administrator removing their own admin role or deactivating themselves", async () => {
    await expect(
      updateManagedUser(admin.context, admin.user.id, { role: "resident" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      updateManagedUser(admin.context, admin.user.id, { active: false }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("ends every session when an account is deactivated", async () => {
    await query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'hash', now() + interval '1 day')",
      [alice.user.id],
    );
    await updateManagedUser(admin.context, alice.user.id, { active: false });
    const sessions = await query<{ id: string }>("SELECT id FROM sessions WHERE user_id = $1", [
      alice.user.id,
    ]);
    expect(sessions).toHaveLength(0);
  });

  it("lists pending accounts first", async () => {
    await query(
      `INSERT INTO users (auth_user_id, email, full_name) VALUES ('sub-p', 'pending@hospital.org', 'Pending Person')`,
    );
    const users = await listManagedUsers(fixture.program.id, { includeUnassigned: true });
    expect(users[0].role).toBeNull();
  });
});

describe("program settings and rules", () => {
  it("updates approved email domains, normalising the @ prefix", async () => {
    const updated = await updateProgram(admin.context, {
      approvedEmailDomains: ["@Hospital.org", "clinic.org"],
    });
    expect(updated.approved_email_domains).toEqual(["hospital.org", "clinic.org"]);
  });

  it("rejects an invalid timezone", async () => {
    await expect(
      updateProgram(admin.context, { timezone: "Mars/Olympus" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects an unknown rule type", async () => {
    await expect(
      createRule(admin.context, {
        ruleType: "make_it_up",
        name: "Nope",
        params: {},
        severity: "error",
        scope: "program",
        overridable: true,
        active: true,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("creates a rule that immediately affects validation", async () => {
    await createRule(admin.context, {
      ruleType: "min_notice_hours",
      name: "Minimum notice",
      params: { hours: 24 * 30 },
      severity: "error",
      scope: "program",
      overridable: true,
      active: true,
    });
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    await expect(
      createOffer(bob.context, {
        tradeRequestId: request.id,
        offeredShiftId: bobShift.id,
      }),
    ).rejects.toMatchObject({ code: "rule_violation" });
  });
});

describe("schedule import", () => {
  const rows = (email: string): Array<Record<string, string>> => [
    {
      Email: email,
      Date: "2026-09-01",
      "Start time": "07:00",
      "End time": "19:00",
      Service: "MICU",
      Rotation: "Critical Care",
      "Shift type": "day",
      Location: "ICU Tower 4",
    },
    {
      Email: email,
      Date: "2026-09-03",
      "Start time": "7:00 PM",
      "End time": "7:00 AM",
      Service: "MICU",
      Rotation: "Critical Care",
      Location: "ICU Tower 4",
    },
  ];

  it("validates a good file and reports what would change", async () => {
    const preview = await validateImport(admin.context, rows("alice@hospital.org"));
    expect(preview.issues).toHaveLength(0);
    expect(preview.rows).toHaveLength(2);
    expect(preview.summary.dateRange).toEqual({ from: "2026-09-01", to: "2026-09-03" });
    // The 7pm–7am row is detected as overnight.
    expect(preview.rows[1].endsNextDay).toBe(true);
    expect(preview.rows[1].shiftType).toBe("night");
  });

  it("reports every error and imports nothing when validation fails", async () => {
    const bad = [
      ...rows("alice@hospital.org"),
      {
        Email: "not-an-email",
        Date: "31/02/2026",
        "Start time": "99:99",
        "End time": "",
        Service: "",
      },
    ];
    const preview = await validateImport(admin.context, bad);
    expect(preview.issues.length).toBeGreaterThanOrEqual(4);
    expect(preview.summary.validRows).toBe(0);

    await expect(commitImport(admin.context, preview.rows)).resolves.toBeTruthy();
    // …but committing the raw bad rows is refused outright.
    await expect(
      commitImport(admin.context, [
        {
          residentEmail: "ghost@hospital.org",
          date: "2026-09-05",
          startTime: "07:00",
          endTime: "19:00",
          service: "MICU",
        },
      ]),
    ).rejects.toMatchObject({ code: "validation_failed" });

    const ghostShifts = await query<{ id: string }>(
      "SELECT id FROM shifts WHERE date = '2026-09-05'",
    );
    expect(ghostShifts).toHaveLength(0);
  });

  it("commits a valid import, creating shifts and assignments", async () => {
    const preview = await validateImport(admin.context, rows("alice@hospital.org"));
    const result = await commitImport(admin.context, preview.rows);
    expect(result.createdShifts).toBe(2);

    const schedule = await listResidentSchedule(alice.resident.id, {
      includePast: true,
      limit: 50,
    });
    const imported = schedule.filter((shift) => shift.location === "ICU Tower 4");
    expect(imported).toHaveLength(2);

    const overnight = imported.find((shift) => shift.shift_type === "night");
    expect(overnight).toBeTruthy();
    const hours =
      (overnight!.end_datetime.getTime() - overnight!.start_datetime.getTime()) /
      3_600_000;
    expect(hours).toBe(12);
  });

  it("skips rows that already exist rather than duplicating them", async () => {
    const preview = await validateImport(admin.context, rows("alice@hospital.org"));
    await commitImport(admin.context, preview.rows);
    const second = await commitImport(admin.context, preview.rows);
    expect(second.createdShifts).toBe(0);
    expect(second.skippedExisting).toBe(2);
  });

  it("refuses an import that references an unknown resident", async () => {
    await expect(
      commitImport(admin.context, [
        {
          residentEmail: "nobody@hospital.org",
          date: "2026-09-01",
          startTime: "07:00",
          endTime: "19:00",
          service: "MICU",
        },
      ]),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects a time that does not exist because of daylight saving", async () => {
    const preview = await validateImport(admin.context, [
      {
        Email: "alice@hospital.org",
        Date: "2027-03-14",
        "Start time": "02:30",
        "End time": "10:30",
        Service: "MICU",
      },
    ]);
    expect(preview.issues.some((issue) => issue.message.includes("does not exist"))).toBe(
      true,
    );
  });
});

describe("export", () => {
  it("exports CSV, XLSX and PDF for the caller's schedule", async () => {
    await createShift(fixture.program, {
      inDays: 3,
      residentId: alice.resident.id,
      service: fixture.services.MICU,
    });
    const shifts = await listResidentSchedule(alice.resident.id, { limit: 50 });
    expect(shifts.length).toBeGreaterThan(0);

    const csv = toCsv(shifts, fixture.program.timezone);
    expect(csv.split("\n")[0]).toContain("Resident,PGY,Date");
    expect(csv).toContain("MICU");

    const xlsx = await toXlsx(shifts, fixture.program.timezone, "Test");
    // XLSX files are ZIP archives — check the magic bytes.
    expect(xlsx.subarray(0, 2).toString("utf8")).toBe("PK");

    const pdf = await toPdf(shifts, fixture.program.timezone, "Test");
    expect(pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
  });

  it("escapes CSV values that contain separators", async () => {
    await createShift(fixture.program, {
      inDays: 3,
      residentId: alice.resident.id,
      location: 'Ward "6", East',
    });
    const shifts = await listResidentSchedule(alice.resident.id, { limit: 50 });
    const csv = toCsv(shifts, fixture.program.timezone);
    expect(csv).toContain('"Ward ""6"", East"');
  });
});

describe("analytics", () => {
  it("summarises trades, approvals and email generation", async () => {
    await createContact(admin.context, {
      name: "Coordinator",
      email: "coordinator@hospital.org",
      contactType: "program_coordinator",
      notifyRole: "to",
      active: true,
    });
    const { completedTradeId } = await completeSwitch();
    await generateSwitchEmail(alice.context, completedTradeId);

    const analytics = await getProgramAnalytics(fixture.program.id);
    expect(analytics.totals.completedTrades).toBe(1);
    expect(analytics.totals.tradeRequests).toBe(1);
    expect(analytics.completionRate).toBe(100);
    expect(analytics.totals.emailsGenerated).toBe(1);
    expect(analytics.tradesByService.length).toBeGreaterThan(0);
  });
});

describe("shift administration", () => {
  it("audits an edit and keeps a single active assignment after reassignment", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 5,
      residentId: alice.resident.id,
    });
    await updateShift(admin.context, shift.id, {
      residentId: bob.resident.id,
      reason: "Coverage change",
      location: "Ward 7",
    });
    const assignments = await query<{ resident_id: string; assignment_status: string }>(
      "SELECT resident_id, assignment_status FROM shift_assignments WHERE shift_id = $1",
      [shift.id],
    );
    expect(assignments.filter((row) => row.assignment_status === "active")).toHaveLength(1);
    const audit = await listAuditLogs({
      programId: fixture.program.id,
      action: "shift.reassigned",
    });
    expect(audit[0].reason).toBe("Coverage change");
  });

  it("refuses to edit a shift in another program", async () => {
    const other = await createProgram({ name: "Other" });
    const otherResident = await createResident(other.program, {
      email: "other@other.org",
    });
    const otherShift = await createShift(other.program, {
      inDays: 5,
      residentId: otherResident.resident.id,
    });
    await expect(
      updateShift(admin.context, otherShift.id, { location: "Nope" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
