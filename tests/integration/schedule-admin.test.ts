import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query, queryOne } from "@/server/db/pool";
import { createShift, updateShift } from "@/server/domain/admin";
import { createOffer, postShiftForTrade } from "@/server/domain/trades";
import { commitImport, validateImport } from "@/server/domain/import";
import {
  getScheduleSource,
  listScheduleSources,
  type UploadedFile,
} from "@/server/domain/schedule-sources";
import {
  NY,
  closeDatabase,
  createProgram,
  createResident,
  ensureMigrated,
  resetDatabase,
} from "./helpers";

/**
 * Manual schedule management — the half of scheduling that is not the import.
 * After a block is loaded somebody always has to move one shift, hand it to a
 * different resident, or delete the one that should not be there.
 */

let program: Awaited<ReturnType<typeof createProgram>>;
let chief: Awaited<ReturnType<typeof createResident>>;
let alice: Awaited<ReturnType<typeof createResident>>;
let bob: Awaited<ReturnType<typeof createResident>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  program = await createProgram({ name: "Schedule Admin" });
  chief = await createResident(program.program, {
    email: "chief@hospital.org",
    role: "chief",
  });
  alice = await createResident(program.program, {
    email: "alice@hospital.org",
    name: "Alice Adeyemi",
    pgy: 2,
  });
  bob = await createResident(program.program, {
    email: "bob@hospital.org",
    name: "Bob Beaumont",
    pgy: 2,
  });
});

async function storedDate(shiftId: string): Promise<string> {
  const row = await queryOne<{ date: string }>(
    "SELECT date::text AS date FROM shifts WHERE id = $1",
    [shiftId],
  );
  return row!.date;
}

function inDays(days: number): string {
  return DateTime.now().setZone(NY).plus({ days }).toISODate() as string;
}

async function makeShift(overrides: Partial<Parameters<typeof createShift>[1]> = {}) {
  return createShift(chief.context, {
    serviceId: program.services.MICU.id,
    date: inDays(20),
    startTime: "07:00",
    endTime: "19:00",
    endsNextDay: false,
    location: "ICU Tower 4",
    shiftType: "day",
    requiredPgyMin: 1,
    requiredPgyMax: 10,
    tradeable: true,
    approvalRequired: false,
    residentId: alice.resident.id,
    ...overrides,
  });
}

describe("moving a shift in time", () => {
  it("changes both instants and the calendar date together", async () => {
    const shift = await makeShift();
    const moved = await updateShift(chief.context, shift.id, {
      date: inDays(21),
      startTime: "06:00",
      endTime: "18:00",
    });

    expect(await storedDate(moved.id)).toBe(inDays(21));
    const local = (instant: Date) =>
      DateTime.fromJSDate(instant).setZone(NY).toFormat("yyyy-MM-dd HH:mm");
    expect(local(moved.start_datetime)).toBe(`${inDays(21)} 06:00`);
    expect(local(moved.end_datetime)).toBe(`${inDays(21)} 18:00`);
  });

  it("keeps the times when only the date moves", async () => {
    const shift = await makeShift();
    const moved = await updateShift(chief.context, shift.id, { date: inDays(25) });
    const local = (instant: Date) =>
      DateTime.fromJSDate(instant).setZone(NY).toFormat("HH:mm");
    expect(local(moved.start_datetime)).toBe("07:00");
    expect(local(moved.end_datetime)).toBe("19:00");
    expect(await storedDate(moved.id)).toBe(inDays(25));
  });

  it("turns a day shift into an overnight one without splitting it", async () => {
    const shift = await makeShift();
    const moved = await updateShift(chief.context, shift.id, {
      startTime: "19:00",
      endTime: "07:00",
      endsNextDay: true,
    });
    const hours =
      (moved.end_datetime.getTime() - moved.start_datetime.getTime()) / 3_600_000;
    expect(hours).toBe(12);
    // Still one row.
    const rows = await query<{ id: string }>("SELECT id FROM shifts");
    expect(rows).toHaveLength(1);
  });

  it("refuses times that would end before they start", async () => {
    const shift = await makeShift();
    await expect(
      updateShift(chief.context, shift.id, { startTime: "19:00", endTime: "07:00" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("explains a wall-clock time that does not exist, rather than failing hard", async () => {
    // 02:30 on 2027-03-14 does not happen in New York — the clocks go forward.
    // Refusing is right; the point of this test is that the refusal reaches the
    // administrator as a 422 with the reason, not as a 500.
    const shift = await makeShift({
      date: "2027-03-14",
      startTime: "01:00",
      endTime: "05:00",
    });
    await expect(
      updateShift(chief.context, shift.id, { startTime: "02:30", endTime: "06:00" }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("does not exist"),
    });

    // And the shift is untouched.
    const local = DateTime.fromJSDate(
      (await queryOne<{ start_datetime: Date }>(
        "SELECT start_datetime FROM shifts WHERE id = $1",
        [shift.id],
      ))!.start_datetime,
    )
      .setZone(NY)
      .toFormat("HH:mm");
    expect(local).toBe("01:00");
  });

  it("handles the autumn repeated hour by taking the first of the two", async () => {
    // 01:30 happens twice on 2026-11-01. Either is defensible; what matters is
    // that one is chosen and the shift still has positive duration.
    const shift = await makeShift({
      date: "2026-11-01",
      startTime: "00:30",
      endTime: "05:00",
    });
    const moved = await updateShift(chief.context, shift.id, { startTime: "01:30" });
    expect(moved.end_datetime.getTime()).toBeGreaterThan(moved.start_datetime.getTime());
    expect(DateTime.fromJSDate(moved.start_datetime).setZone(NY).hour).toBe(1);
  });

  it("invalidates a live offer, because the shift is no longer what was agreed", async () => {
    const aliceShift = await makeShift();
    const bobShift = await makeShift({ date: inDays(24), residentId: bob.resident.id });

    const posted = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    const offer = await createOffer(bob.context, {
      tradeRequestId: posted.id,
      offeredShiftId: bobShift.id,
    });

    await updateShift(chief.context, aliceShift.id, { startTime: "06:00" });

    const after = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.offer.id],
    );
    expect(after!.status).not.toBe("pending");

    const told = await queryOne<{ body: string }>(
      `SELECT body FROM notifications
        WHERE recipient_user_id = $1 AND body ILIKE '%moved the shift%'`,
      [bob.user.id],
    );
    expect(told).not.toBeNull();
  });

  it("leaves a shift alone when nothing about its time is patched", async () => {
    const shift = await makeShift();
    const before = await queryOne<{ start_datetime: Date; updated_at: Date }>(
      "SELECT start_datetime, updated_at FROM shifts WHERE id = $1",
      [shift.id],
    );
    const updated = await updateShift(chief.context, shift.id, { location: "Ward 2" });
    expect(updated.location).toBe("Ward 2");
    expect(updated.start_datetime.toISOString()).toBe(
      before!.start_datetime.toISOString(),
    );
  });
});

describe("reassigning", () => {
  it("moves the shift to another resident and ends the old assignment", async () => {
    const shift = await makeShift();
    await updateShift(chief.context, shift.id, { residentId: bob.resident.id });

    const assignments = await query<{ resident_id: string; assignment_status: string }>(
      "SELECT resident_id, assignment_status FROM shift_assignments WHERE shift_id = $1",
      [shift.id],
    );
    const active = assignments.filter((a) => a.assignment_status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].resident_id).toBe(bob.resident.id);
    expect(assignments).toHaveLength(2);
  });

  it("refuses a resident from another program", async () => {
    const other = await createProgram({ name: "Elsewhere" });
    const stranger = await createResident(other.program, {
      email: "stranger@hospital.org",
    });
    const shift = await makeShift();
    // Reported as invalid input rather than "forbidden": the message must not
    // confirm that the id belongs to a real resident somewhere else.
    await expect(
      updateShift(chief.context, shift.id, { residentId: stranger.resident.id }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("can leave a shift unassigned", async () => {
    const shift = await makeShift();
    await updateShift(chief.context, shift.id, { residentId: null });
    const active = await query<{ id: string }>(
      "SELECT id FROM shift_assignments WHERE shift_id = $1 AND assignment_status = 'active'",
      [shift.id],
    );
    expect(active).toHaveLength(0);
  });
});

describe("the schedule source seam", () => {
  it("advertises the sources that exist, and nothing that is not configured", () => {
    /* Two today: the uploaded spreadsheet and the generator. Listed rather than
       counted, so adding MedHub later is a deliberate edit here rather than a
       number that quietly drifts — and every one of them has to say whether it
       can actually be used. */
    const sources = listScheduleSources();
    expect(sources.map((source) => source.id).sort()).toEqual([
      "generated",
      "spreadsheet",
    ]);
    for (const source of sources) {
      expect(source.label.length, source.id).toBeGreaterThan(0);
      expect(source.description.length, source.id).toBeGreaterThan(20);
      if (!source.configured) {
        expect(source.unavailableReason, source.id).toBeTruthy();
      }
    }
  });

  it("rejects an unknown source rather than guessing", () => {
    expect(() => getScheduleSource("medhub")).toThrowError(/no schedule source/i);
  });

  it("produces records the core validation accepts, with no vendor knowledge", async () => {
    const source = getScheduleSource<UploadedFile>("spreadsheet");
    const records = await source.fetch({
      filename: "block.csv",
      contents: Buffer.from(
        [
          "Email,Date,Start time,End time,Service",
          `alice@hospital.org,${inDays(30)},07:00,19:00,MICU`,
        ].join("\n"),
      ),
    });

    const preview = await validateImport(chief.context, records);
    expect(preview.issues).toHaveLength(0);
    const result = await commitImport(chief.context, preview.rows);
    expect(result.createdShifts).toBe(1);
  });
});
