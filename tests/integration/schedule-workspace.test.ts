import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query } from "@/server/db/pool";
import { createAbsence } from "@/server/domain/availability";
import { createCoverage } from "@/server/domain/coverage";
import { bulkAssign, repeatWeek } from "@/server/domain/schedule-bulk";
import { addLock } from "@/server/domain/schedule-locks";
import {
  approveScheduleVersion,
  createScheduleVersion,
  publishScheduleVersion,
} from "@/server/domain/schedule-versions";
import { loadWorkspace } from "@/server/domain/schedule-workspace";
import {
  NY,
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

/**
 * The working surface: the heat map, the queue, the report, and moving more
 * than one shift at a time.
 *
 * The assertions that matter most are the ones about *agreement*. A grid that
 * tinted a cell green while the check below it called that cell short would be
 * worse than no grid, because a scheduler would believe the colour — so the
 * cells are the validator's own, and the tests say so.
 */

let fixture: TestProgram;
let chief: Awaited<ReturnType<typeof createStaff>>;
let alice: TestResident;
let bob: TestResident;
let version: Awaited<ReturnType<typeof createScheduleVersion>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

function inDays(days: number): string {
  return DateTime.now().setZone(NY).plus({ days }).toISODate() as string;
}

async function draftShift(day: number, residentId: string | null, serviceId?: string) {
  const shift = await createShift(fixture.program, {
    inDays: day,
    residentId: residentId ?? undefined,
    serviceId: serviceId ?? fixture.services.MICU.id,
  });
  await query("UPDATE shifts SET schedule_version_id = $2 WHERE id = $1", [
    shift.id,
    version.id,
  ]);
  return shift;
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram({ name: "Workspace" });
  chief = await createStaff(fixture.program, {
    email: "chief@hospital.org",
    role: "chief",
  });
  alice = await createResident(fixture.program, {
    email: "alice@hospital.org",
    name: "Alice Adeyemi",
    pgy: 2,
  });
  bob = await createResident(fixture.program, {
    email: "bob@hospital.org",
    name: "Bob Beaumont",
    pgy: 3,
  });
  version = await createScheduleVersion(chief.context, {
    name: "Draft",
    periodStart: inDays(0),
    periodEnd: inDays(28),
  });
});

describe("the heat map", () => {
  it("agrees with the validator about what is short", async () => {
    /* Two people needed every day; one person on. The cell must be "under",
       and the validator must report a coverage-minimum violation for the same
       day — computed from the same generator, so a disagreement here means the
       export was undone rather than that the numbers drifted. */
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 2,
      label: "MICU",
    });
    await draftShift(3, alice.resident.id);

    const workspace = await loadWorkspace(chief.context, { versionId: version.id });
    const cell = workspace.cells.find((entry) => entry.date === inDays(3));
    expect(cell).toBeDefined();
    expect(cell!.required).toBe(2);
    expect(cell!.present).toBe(1);
    expect(cell!.state).toBe("under");

    const shortfall = workspace.validation.violations.filter(
      (violation) =>
        violation.constraintId === "coverage-minimum" &&
        violation.dates.includes(inDays(3)),
    );
    expect(shortfall).toHaveLength(1);
  });

  it("counts people rather than rows", async () => {
    /* One resident holding two of the three places a service needs is one
       person on that service. Counting rows would report a ward as staffed
       with two of its three places empty. */
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 2,
      label: "MICU",
    });
    await draftShift(4, alice.resident.id);
    await draftShift(4, alice.resident.id);

    const workspace = await loadWorkspace(chief.context, { versionId: version.id });
    const cell = workspace.cells.find((entry) => entry.date === inDays(4));
    expect(cell!.present).toBe(1);
    expect(cell!.state).toBe("under");
  });

  it("puts the biggest gap at the top of the queue", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "date",
      specificDate: inDays(5),
      minStaff: 4,
      label: "Big day",
    });
    await createCoverage(chief.context, {
      serviceId: fixture.services.Floor.id,
      scope: "date",
      specificDate: inDays(6),
      minStaff: 2,
      label: "Small day",
    });
    await draftShift(6, alice.resident.id, fixture.services.Floor.id);

    const workspace = await loadWorkspace(chief.context, { versionId: version.id });
    /* Four missing beats one missing, whatever order the dates come in. A queue
       sorted by date buries the day the hospital has nobody. */
    expect(workspace.unfilled[0].serviceName).toBe("MICU");
    expect(workspace.unfilled[0].required - workspace.unfilled[0].present).toBe(4);
  });
});

describe("the report", () => {
  it("groups the validator's findings rather than restating them", async () => {
    await createAbsence(chief.context, {
      residentId: alice.resident.id,
      kind: "vacation",
      startDate: inDays(7),
      endDate: inDays(7),
    });
    await draftShift(7, alice.resident.id);

    const workspace = await loadWorkspace(chief.context, { versionId: version.id });
    expect(workspace.report.problematicAssignments).toHaveLength(1);
    expect(workspace.report.problematicAssignments[0].message).toContain(
      "Alice Adeyemi is on vacation",
    );
    /* Every message in the report is a message the validator produced. The two
       screens cannot disagree because there is only one source. */
    const messages = workspace.validation.violations.map((v) => v.message);
    expect(messages).toContain(workspace.report.problematicAssignments[0].message);
  });

  it("marks a shift with what is wrong with it, so the grid can show it", async () => {
    await createAbsence(chief.context, {
      residentId: bob.resident.id,
      kind: "leave",
      startDate: inDays(9),
      endDate: inDays(9),
    });
    const shift = await draftShift(9, bob.resident.id);

    const workspace = await loadWorkspace(chief.context, { versionId: version.id });
    const entry = workspace.shifts.find((row) => row.id === shift.id)!;
    expect(entry.problems.some((problem) => problem.kind === "hard")).toBe(true);
  });
});

describe("lock indicators", () => {
  it("marks every shift a lock protects, whichever kind of lock it is", async () => {
    const mine = await draftShift(10, alice.resident.id);
    const theirs = await draftShift(10, bob.resident.id);
    await addLock(chief.context, version.id, {
      kind: "resident",
      targetId: alice.resident.id,
      reason: "Settled with her.",
    });

    const workspace = await loadWorkspace(chief.context, { versionId: version.id });
    const locked = workspace.shifts.find((row) => row.id === mine.id)!;
    const open = workspace.shifts.find((row) => row.id === theirs.id)!;
    expect(locked.locked).toBe(true);
    expect(locked.lockReason).toBe("Settled with her.");
    expect(open.locked).toBe(false);
  });
});

describe("bulk operations", () => {
  it("moves a set of shifts and reports what it replaced", async () => {
    const first = await draftShift(11, alice.resident.id);
    const second = await draftShift(12, alice.resident.id);

    const result = await bulkAssign(chief.context, version.id, [
      { shiftId: first.id, residentId: bob.resident.id },
      { shiftId: second.id, residentId: bob.resident.id },
    ]);
    expect(result.changed).toBe(2);
    expect(result.undo).toEqual([
      { shiftId: first.id, residentId: alice.resident.id },
      { shiftId: second.id, residentId: alice.resident.id },
    ]);

    /* Undo is not machinery — it is the inverse operation, sent back. */
    const undone = await bulkAssign(chief.context, version.id, result.undo);
    expect(undone.changed).toBe(2);
    const holders = await query<{ resident_id: string }>(
      `SELECT a.resident_id FROM shift_assignments a
        WHERE a.shift_id = ANY($1::uuid[]) AND a.assignment_status = 'active'`,
      [[first.id, second.id]],
    );
    expect(holders.every((row) => row.resident_id === alice.resident.id)).toBe(true);
  });

  it("clears shifts, because nobody is a destination a scheduler chooses", async () => {
    const shift = await draftShift(13, alice.resident.id);
    const result = await bulkAssign(chief.context, version.id, [
      { shiftId: shift.id, residentId: null },
    ]);
    expect(result.changed).toBe(1);
    const holders = await query(
      "SELECT id FROM shift_assignments WHERE shift_id = $1 AND assignment_status = 'active'",
      [shift.id],
    );
    expect(holders).toHaveLength(0);
  });

  it("names what it could not do rather than silently skipping it", async () => {
    const shift = await draftShift(14, alice.resident.id);
    await query("UPDATE residents SET schedulable = false WHERE id = $1", [
      bob.resident.id,
    ]);

    const result = await bulkAssign(chief.context, version.id, [
      { shiftId: shift.id, residentId: bob.resident.id },
    ]);
    expect(result.changed).toBe(0);
    expect(result.skipped[0].reason).toContain("not available to schedule");
  });

  it("refuses to touch a published schedule", async () => {
    const shift = await draftShift(15, alice.resident.id);
    await approveScheduleVersion(chief.context, version.id, {
      report: { score: 100, hard: 0, soft: 0, shifts: 1, accepted: [] },
    });
    await publishScheduleVersion(chief.context, version.id);

    await expect(
      bulkAssign(chief.context, version.id, [
        { shiftId: shift.id, residentId: bob.resident.id },
      ]),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("repeating a pattern", () => {
  it("copies who was on what onto a later stretch of days", async () => {
    /* Day 7 and day 14 are the same weekday, one week apart. */
    await draftShift(7, alice.resident.id);
    const target = await draftShift(14, null);

    const result = await repeatWeek(chief.context, version.id, {
      sourceStart: inDays(7),
      targetStart: inDays(14),
    });
    expect(result.changed).toBe(1);

    const holder = await query<{ resident_id: string }>(
      `SELECT resident_id FROM shift_assignments
        WHERE shift_id = $1 AND assignment_status = 'active'`,
      [target.id],
    );
    expect(holder[0].resident_id).toBe(alice.resident.id);
  });

  it("never creates a shift where the destination has none", async () => {
    await draftShift(7, alice.resident.id);
    await draftShift(8, bob.resident.id);
    /* Only day 14 exists in the destination — day 15 does not. The copy must
       write one row and invent nothing: a copy that created shifts would let
       one mistyped date duplicate a fortnight. */
    const target = await draftShift(14, null);

    const before = await query("SELECT id FROM shifts WHERE schedule_version_id = $1", [
      version.id,
    ]);
    const result = await repeatWeek(chief.context, version.id, {
      sourceStart: inDays(7),
      targetStart: inDays(14),
    });
    const after = await query("SELECT id FROM shifts WHERE schedule_version_id = $1", [
      version.id,
    ]);

    expect(after.length).toBe(before.length);
    expect(result.changed).toBe(1);
    expect(target.id).toBeTruthy();
  });

  it("refuses two stretches that overlap", async () => {
    await draftShift(7, alice.resident.id);
    await expect(
      repeatWeek(chief.context, version.id, {
        sourceStart: inDays(7),
        targetStart: inDays(10),
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("says so when nothing lines up", async () => {
    await draftShift(7, alice.resident.id);
    await expect(
      repeatWeek(chief.context, version.id, {
        sourceStart: inDays(7),
        targetStart: inDays(21),
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("Nothing lines up"),
    });
  });
});
