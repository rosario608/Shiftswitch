import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import { postShiftForTrade } from "@/server/domain/trades";
import {
  listWarningAcknowledgements,
  previewTake,
  takeShift,
} from "@/server/domain/giveaway";
import { listNotifications } from "@/server/domain/notifications";
import { setPreference } from "@/server/domain/notification-preferences";
import {
  addRule,
  assertDatabaseConsistent,
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
 * A shift changing hands one way.
 *
 * The property under test throughout is that **nothing is ever unheld**: the
 * poster keeps the shift until the moment somebody takes it, and the two
 * happen in one transaction. A live shift with nobody on it is a ward with
 * nobody on it.
 */

let fixture: TestProgram;
let poster: TestResident;
let taker: TestResident;
let tired: TestResident;
let chief: { context: Awaited<ReturnType<typeof createStaff>>["context"]; user: { id: string } };

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram();
  poster = await createResident(fixture.program, {
    email: "poster@hospital.org",
    name: "Priya Nair",
  });
  taker = await createResident(fixture.program, {
    email: "taker@hospital.org",
    name: "Tomas Ruiz",
  });
  tired = await createResident(fixture.program, {
    email: "tired@hospital.org",
    name: "Tess Ademola",
  });
  chief = await createStaff(fixture.program, {
    email: "chief@hospital.org",
    role: "chief",
    name: "Chief Okonkwo",
  });
});

async function postGiveaway(day = 10) {
  const shift = await createShift(fixture.program, {
    inDays: day,
    service: fixture.services.MICU,
    residentId: poster.resident.id,
  });
  const request = await postShiftForTrade(poster.context, {
    shiftId: shift.id,
    kind: "giveaway",
  });
  return { shift, request };
}

async function holderOf(shiftId: string) {
  const row = await queryOne<{ resident_id: string }>(
    `SELECT resident_id FROM shift_assignments
      WHERE shift_id = $1 AND assignment_status = 'active'`,
    [shiftId],
  );
  return row?.resident_id ?? null;
}

describe("giving a shift away", () => {
  it("moves the shift one way, with one leg and nobody giving anything back", async () => {
    const { shift, request } = await postGiveaway();

    /* The poster still holds it. This is the property that distinguishes a
       giveaway from "unassign, then hope": at no point is the shift live and
       unheld. */
    expect(await holderOf(shift.id)).toBe(poster.resident.id);

    const outcome = await takeShift(taker.context, request.id, {
      acknowledgedWarnings: [],
    });
    expect(outcome.status).toBe("completed");
    expect(await holderOf(shift.id)).toBe(taker.resident.id);

    const completed = await queryOne<{
      kind: string;
      destination_shift_id: string | null;
      resident_b: string | null;
    }>("SELECT kind::text AS kind, destination_shift_id, resident_b FROM completed_trades");
    expect(completed!.kind).toBe("giveaway");
    expect(completed!.destination_shift_id).toBeNull();
    expect(completed!.resident_b).toBeNull();

    const legs = await query<{ from_resident_id: string; to_resident_id: string }>(
      "SELECT from_resident_id, to_resident_id FROM trade_legs",
    );
    expect(legs).toHaveLength(1);
    expect(legs[0].from_resident_id).toBe(poster.resident.id);
    expect(legs[0].to_resident_id).toBe(taker.resident.id);

    await assertDatabaseConsistent();
  });

  it("tells both people, in their own words", async () => {
    const { request } = await postGiveaway();
    await takeShift(taker.context, request.id, { acknowledgedWarnings: [] });

    const toPoster = await listNotifications(poster.user.id);
    const toTaker = await listNotifications(taker.user.id);
    expect(toPoster.some((n) => n.type === "giveaway.taken")).toBe(true);
    expect(toTaker.some((n) => n.type === "giveaway.taken")).toBe(true);
    /* The poster's question is "am I off it"; the taker's is "what did I just
       agree to work". Neither is served by the other's sentence. */
    expect(toPoster.find((n) => n.type === "giveaway.taken")!.body).toContain(
      "no longer on it",
    );
    expect(toTaker.find((n) => n.type === "giveaway.taken")!.body).toContain("You now work");
  });

  it("counts the shift once for coverage, before and after", async () => {
    const { shift, request } = await postGiveaway();
    const before = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM shift_assignments
        WHERE shift_id = $1 AND assignment_status = 'active'`,
      [shift.id],
    );
    expect(before[0].count).toBe("1");

    await takeShift(taker.context, request.id, { acknowledgedWarnings: [] });

    const after = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM shift_assignments
        WHERE shift_id = $1 AND assignment_status = 'active'`,
      [shift.id],
    );
    /* One holder before, one holder after. A giveaway does not create or
       destroy a shift, and the ward is neither short nor double-staffed. */
    expect(after[0].count).toBe("1");
  });

  it("refuses your own shift rather than letting you take it from yourself", async () => {
    const { request } = await postGiveaway();
    await expect(
      takeShift(poster.context, request.id, { acknowledgedWarnings: [] }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a second taker once it is gone, and says why", async () => {
    const { request } = await postGiveaway();
    await takeShift(taker.context, request.id, { acknowledgedWarnings: [] });
    await expect(
      takeShift(tired.context, request.id, { acknowledgedWarnings: [] }),
    ).rejects.toMatchObject({ message: expect.stringContaining("already taken") });
  });

  it("will not let a switch posting be taken as a giveaway", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 12,
      service: fixture.services.MICU,
      residentId: poster.resident.id,
    });
    const request = await postShiftForTrade(poster.context, { shiftId: shift.id });
    await expect(
      takeShift(taker.context, request.id, { acknowledgedWarnings: [] }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("needs one of your shifts in return"),
    });
  });
});

describe("a resident who takes on too much", () => {
  /**
   * Rest limits exist for exactly this. A switch leaves the taker working the
   * same number of hours; a giveaway leaves them working more, which is why
   * the warning has to be deliberate rather than a banner.
   */
  async function tiringSetup() {
    await addRule(fixture.program, "min_rest_hours", { hours: 24 });
    /* Tess already works the day before, so picking this up leaves her with
       less rest than the programme asks for. */
    await createShift(fixture.program, {
      inDays: 9,
      service: fixture.services.Floor,
      residentId: tired.resident.id,
    });
    return postGiveaway(10);
  }

  it("warns rather than refusing, and names the rule and the numbers", async () => {
    const { request } = await tiringSetup();
    const preview = await previewTake(tired.context, request.id);

    expect(preview.blockers).toHaveLength(0);
    expect(preview.warnings.length).toBeGreaterThan(0);
    const rest = preview.warnings.find((w) => w.ruleType === "min_rest_hours");
    expect(rest).toBeDefined();
    /* The numbers are in the sentence, not only in a structured field the
       screen does not render. */
    expect(rest!.message).toMatch(/\d/);
    expect(rest!.message).toContain("24");
  });

  it("refuses a take that has not acknowledged the warnings", async () => {
    const { request } = await tiringSetup();
    await expect(
      takeShift(tired.context, request.id, { acknowledgedWarnings: [] }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("read and accept the warnings"),
    });
  });

  it("goes ahead when the resident accepts them, and records what they accepted", async () => {
    const { shift, request } = await tiringSetup();
    const preview = await previewTake(tired.context, request.id);

    const outcome = await takeShift(tired.context, request.id, {
      acknowledgedWarnings: preview.warnings.map((w) => w.key),
    });
    expect(outcome.status === "completed" || outcome.status === "pending_approval").toBe(
      true,
    );
    expect(outcome.warningsAcknowledged).toBe(preview.warnings.length);

    const records = await listWarningAcknowledgements(fixture.program.id);
    expect(records).toHaveLength(1);
    expect(records[0].residentName).toBe("Tess Ademola");
    /* The sentences themselves, not the rule ids: a programme can edit a
       rule's numbers, and a chief reading this later needs what the resident
       actually saw. */
    expect(records[0].warnings.map((w) => w.message)).toEqual(
      preview.warnings.map((w) => w.message),
    );

    const audit = await query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'giveaway.warning_acknowledged'",
    );
    expect(audit).toHaveLength(1);

    if (outcome.status === "completed") {
      expect(await holderOf(shift.id)).toBe(tired.resident.id);
    }
    await assertDatabaseConsistent();
  });

  it("shows it to whoever oversees coverage", async () => {
    const { request } = await tiringSetup();
    const preview = await previewTake(tired.context, request.id);
    await takeShift(tired.context, request.id, {
      acknowledgedWarnings: preview.warnings.map((w) => w.key),
    });

    const toChief = await listNotifications(chief.user.id);
    const warned = toChief.find((n) => n.type === "giveaway.warned");
    expect(warned).toBeDefined();
    expect(warned!.body).toContain("Tess Ademola");
  });

  /* A stale screen must not be able to accept warnings that no longer
     describe the resident's schedule. */
  it("refuses keys that do not match the warnings as they are now", async () => {
    const { request } = await tiringSetup();
    await expect(
      takeShift(tired.context, request.id, {
        acknowledgedWarnings: ["system:something-that-is-not-current"],
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("read and accept the warnings"),
    });
  });

  /* Warning is not the same as permitting anything. Physics still refuses. */
  it("still refuses a shift the taker is already working", async () => {
    const { shift, request } = await postGiveaway(10);
    await createShift(fixture.program, {
      inDays: 10,
      service: fixture.services.Floor,
      residentId: taker.resident.id,
    });
    const preview = await previewTake(taker.context, request.id);
    expect(preview.blockers.length).toBeGreaterThan(0);
    await expect(
      takeShift(taker.context, request.id, {
        acknowledgedWarnings: preview.warnings.map((w) => w.key),
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await holderOf(shift.id)).toBe(poster.resident.id);
  });
});

describe("each resident hears about it their own way", () => {
  it("sends to the one who wants it and nothing at all to the one who does not", async () => {
    /* The taker has turned off "your shift was picked up" entirely. The
       poster has not. One notification exists afterwards, not two hidden. */
    await setPreference(taker.user.id, "giveaway.taken", {
      push: false,
      inApp: false,
    });

    const { request } = await postGiveaway();
    await takeShift(taker.context, request.id, { acknowledgedWarnings: [] });

    const toPoster = await listNotifications(poster.user.id);
    const toTaker = await listNotifications(taker.user.id);
    expect(toPoster.some((n) => n.type === "giveaway.taken")).toBe(true);
    expect(toTaker.some((n) => n.type === "giveaway.taken")).toBe(false);
  });
});
