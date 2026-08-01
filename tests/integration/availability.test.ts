import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query } from "@/server/db/pool";
import {
  createAbsence,
  deleteAbsence,
  listAbsences,
  updateAbsence,
} from "@/server/domain/availability";
import { loadScheduleSnapshot } from "@/server/domain/constraints/snapshot";
import { validateSchedule } from "@/server/domain/constraints/validator";
import {
  hardConstraintsOf,
  preferencesOf,
} from "@/server/domain/constraints/person";
import {
  NY,
  closeDatabase,
  createProgram,
  createResident,
  createShift,
  createStaff,
  ensureMigrated,
  resetDatabase,
} from "./helpers";

/**
 * Structured availability, and the one thing that makes it worth having: it
 * reaches the constraint model without anything translating it.
 *
 * The tests below are deliberately about the *validator's* answer rather than
 * about rows in `resident_absences`. A table nobody reads is not a feature, and
 * asserting the row exists would pass just as happily if the snapshot never
 * loaded it — which is exactly the defect worth catching.
 */

let program: Awaited<ReturnType<typeof createProgram>>;
let chief: Awaited<ReturnType<typeof createStaff>>;
let alice: Awaited<ReturnType<typeof createResident>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  program = await createProgram({ name: "Availability" });
  chief = await createStaff(program.program, {
    email: "chief@hospital.org",
    role: "chief",
  });
  alice = await createResident(program.program, {
    email: "alice@hospital.org",
    name: "Alice Adeyemi",
  });
});

function inDays(days: number): string {
  return DateTime.now().setZone(NY).plus({ days }).toISODate() as string;
}

async function snapshotOver(from: string, to: string) {
  return loadScheduleSnapshot(
    {
      id: program.program.id,
      name: program.program.name,
      timezone: program.program.timezone,
    },
    { period: { start: from, end: to } },
  );
}

describe("recording an absence", () => {
  it("reaches the validator as unavailability, and names the reason", async () => {
    const shift = await createShift(program.program, {
      inDays: 10,
      residentId: alice.resident.id,
      service: program.services.MICU,
    });
    expect(shift.id).toBeTruthy();

    await createAbsence(chief.context, {
      residentId: alice.resident.id,
      kind: "vacation",
      startDate: inDays(8),
      endDate: inDays(12),
    });

    const snapshot = await snapshotOver(inDays(0), inDays(20));
    const result = validateSchedule(snapshot);
    const unavailable = result.violations.filter(
      (violation) => violation.constraintId === "personal-unavailability",
    );

    expect(unavailable).toHaveLength(1);
    /* The sentence says why. "…is recorded as unavailable" makes a chief go
       and look it up; "…is on vacation" is actionable on its own. */
    expect(unavailable[0].message).toContain("Alice Adeyemi is on vacation");
    expect(unavailable[0].message).toContain("MICU");
    expect(unavailable[0].residentIds).toEqual([alice.resident.id]);
  });

  it("expands a range into every day it covers", async () => {
    await createAbsence(chief.context, {
      residentId: alice.resident.id,
      kind: "leave",
      startDate: inDays(3),
      endDate: inDays(6),
    });

    const snapshot = await snapshotOver(inDays(0), inDays(10));
    const resident = snapshot.residents.find((r) => r.id === alice.resident.id)!;
    const dates = hardConstraintsOf(resident).unavailableDates;

    expect(dates).toEqual([inDays(3), inDays(4), inDays(5), inDays(6)]);
  });

  it("loads an absence that started before the window and runs into it", async () => {
    await createAbsence(chief.context, {
      residentId: alice.resident.id,
      kind: "leave",
      startDate: inDays(-5),
      endDate: inDays(2),
    });

    /* Overlap rather than containment. A query that asked for absences
       *starting* in the window would miss exactly the long ones that matter. */
    const snapshot = await snapshotOver(inDays(0), inDays(10));
    const resident = snapshot.residents.find((r) => r.id === alice.resident.id)!;
    expect(hardConstraintsOf(resident).unavailableDates).toContain(inDays(1));
  });

  it("keeps an unconfirmed absence out of the hard list and in the soft one", async () => {
    await createAbsence(chief.context, {
      residentId: alice.resident.id,
      kind: "conference",
      startDate: inDays(4),
      endDate: inDays(4),
      hard: false,
    });

    const snapshot = await snapshotOver(inDays(0), inDays(10));
    const resident = snapshot.residents.find((r) => r.id === alice.resident.id)!;
    expect(hardConstraintsOf(resident).unavailableDates).not.toContain(inDays(4));
    expect(preferencesOf(resident).requestedDaysOff).toContain(inDays(4));
  });

  it("merges with the jsonb list rather than replacing it", async () => {
    /* An import writes the jsonb keys and always has. Both mean the same thing
       to a schedule, so a programme with both gets the union — not whichever
       the loader happened to read last. */
    await query("UPDATE residents SET constraints = $2::jsonb WHERE id = $1", [
      alice.resident.id,
      JSON.stringify({ unavailableDates: [inDays(1)] }),
    ]);
    await createAbsence(chief.context, {
      residentId: alice.resident.id,
      kind: "vacation",
      startDate: inDays(5),
      endDate: inDays(5),
    });

    const snapshot = await snapshotOver(inDays(0), inDays(10));
    const resident = snapshot.residents.find((r) => r.id === alice.resident.id)!;
    const dates = hardConstraintsOf(resident).unavailableDates;
    expect(dates).toContain(inDays(1));
    expect(dates).toContain(inDays(5));
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(
      createAbsence(chief.context, {
        residentId: alice.resident.id,
        kind: "vacation",
        startDate: inDays(9),
        endDate: inDays(4),
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("who may record what", () => {
  it("lets a resident record their own, but not as confirmed", async () => {
    const absence = await createAbsence(alice.context, {
      residentId: alice.resident.id,
      kind: "conference",
      startDate: inDays(3),
      endDate: inDays(4),
      /* Asked for; refused. A resident who could confirm their own absence
         could invalidate the programme's schedule unilaterally. */
      hard: true,
    });
    expect(absence.hard).toBe(false);
  });

  it("refuses a resident recording somebody else's", async () => {
    const bob = await createResident(program.program, { email: "bob@hospital.org" });
    await expect(
      createAbsence(alice.context, {
        residentId: bob.resident.id,
        kind: "vacation",
        startDate: inDays(3),
        endDate: inDays(3),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets a scheduler confirm a request, which then binds the schedule", async () => {
    const requested = await createAbsence(alice.context, {
      residentId: alice.resident.id,
      kind: "conference",
      startDate: inDays(6),
      endDate: inDays(6),
    });
    expect(requested.hard).toBe(false);

    const confirmed = await updateAbsence(chief.context, requested.id, { hard: true });
    expect(confirmed.hard).toBe(true);

    const snapshot = await snapshotOver(inDays(0), inDays(10));
    const resident = snapshot.residents.find((r) => r.id === alice.resident.id)!;
    expect(hardConstraintsOf(resident).unavailableDates).toContain(inDays(6));
  });

  it("lets a resident withdraw their own request but not a confirmed absence", async () => {
    const own = await createAbsence(alice.context, {
      residentId: alice.resident.id,
      kind: "conference",
      startDate: inDays(3),
      endDate: inDays(3),
    });
    await deleteAbsence(alice.context, own.id);
    expect(await listAbsences(program.program.id)).toHaveLength(0);

    const confirmed = await createAbsence(chief.context, {
      residentId: alice.resident.id,
      kind: "leave",
      startDate: inDays(3),
      endDate: inDays(3),
    });
    await expect(deleteAbsence(alice.context, confirmed.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("records who said so", async () => {
    await createAbsence(chief.context, {
      residentId: alice.resident.id,
      kind: "leave",
      startDate: inDays(3),
      endDate: inDays(3),
    });
    const actions = await query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'absence.created'",
    );
    expect(actions).toHaveLength(1);
  });
});
