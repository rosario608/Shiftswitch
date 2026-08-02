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
import { buildCalendar } from "@/server/domain/calendar";
import { listReleasedShifts, listResidentSchedule } from "@/server/domain/schedule";
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
      /* Says what happened and where to go next, rather than only refusing —
         a resident who wanted a shift is still looking for one. */
    ).rejects.toMatchObject({
      message: expect.stringContaining("Somebody else got there first"),
    });
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

/**
 * The whole thing, once, as three people would actually live it.
 *
 * Everything below is asserted somewhere above in isolation. This exists
 * because the isolated tests each hold one part still while they examine
 * another, and the joins are where two features that both work alone disagree
 * about what happened. In particular: preferences are read at the moment of
 * sending, warnings are recorded against the take that produced them, and the
 * chief's copy is a different notification from the taker's — three things
 * that pass separately and could still contradict each other in one story.
 */
describe("one shift given away, one taken over a warning, three people told what they asked to be told", () => {
  it("runs the whole path", async () => {
    await addRule(fixture.program, "min_rest_hours", { hours: 24 });

    /* Tomas wants to hear about shifts going spare — it is ambient, so it is
       off until he says otherwise. Tess never asks, and must hear nothing. */
    await setPreference(taker.user.id, "giveaway.posted", { push: true, inApp: true });

    // ---------------------------------------------------------------- posting
    const shift = await createShift(fixture.program, {
      inDays: 10,
      service: fixture.services.MICU,
      residentId: poster.resident.id,
    });
    const request = await postShiftForTrade(poster.context, {
      shiftId: shift.id,
      kind: "giveaway",
    });

    /* The poster still holds it. There is no moment where a live shift has
       nobody on it, and that is the property this whole feature turns on. */
    expect(await holderOf(shift.id)).toBe(poster.resident.id);

    const tomasHeard = await listNotifications(taker.user.id);
    expect(tomasHeard.some((n) => n.type === "giveaway.posted")).toBe(true);

    const tessHeard = await listNotifications(tired.user.id);
    expect(tessHeard.some((n) => n.type === "giveaway.posted")).toBe(false);

    // ----------------------------------------------------------------- taking
    const clean = await previewTake(taker.context, request.id);
    expect(clean.warnings).toHaveLength(0);
    expect(clean.blockers).toHaveLength(0);

    const taken = await takeShift(taker.context, request.id, {
      acknowledgedWarnings: [],
    });
    expect(taken.status).toBe("completed");

    /* One way: Tomas holds it, Priya does not, and nothing came back to her. */
    expect(await holderOf(shift.id)).toBe(taker.resident.id);
    const legs = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM trade_legs l
         JOIN completed_trades c ON c.id = l.completed_trade_id
        WHERE c.kind = 'giveaway'`,
    );
    expect(legs[0].count).toBe("1");

    const priyaHeard = await listNotifications(poster.user.id);
    expect(priyaHeard.some((n) => n.type === "giveaway.taken")).toBe(true);

    await assertDatabaseConsistent();

    // ------------------------------------------------- taking over a warning
    /* Tess works the day before, so the second shift costs her rest. */
    await createShift(fixture.program, {
      inDays: 19,
      service: fixture.services.Floor,
      residentId: tired.resident.id,
    });
    const second = await createShift(fixture.program, {
      inDays: 20,
      service: fixture.services.MICU,
      residentId: poster.resident.id,
    });
    const secondRequest = await postShiftForTrade(poster.context, {
      shiftId: second.id,
      kind: "giveaway",
    });

    const warned = await previewTake(tired.context, secondRequest.id);
    expect(warned.blockers).toHaveLength(0);
    const rest = warned.warnings.find((w) => w.ruleType === "min_rest_hours");
    expect(rest).toBeDefined();
    /* The numbers are in the sentence a resident reads, not only in a
       structured field no screen renders. */
    expect(rest!.message).toContain("24");

    /* Refused until she has actually said yes to them. */
    await expect(
      takeShift(tired.context, secondRequest.id, { acknowledgedWarnings: [] }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("read and accept the warnings"),
    });

    const accepted = await takeShift(tired.context, secondRequest.id, {
      acknowledgedWarnings: warned.warnings.map((w) => w.key),
    });
    expect(accepted.warningsAcknowledged).toBe(warned.warnings.length);
    expect(await holderOf(second.id)).toBe(tired.resident.id);

    // ------------------------------------------- recorded, audited, and seen
    const records = await listWarningAcknowledgements(fixture.program.id);
    expect(records).toHaveLength(1);
    expect(records[0].residentName).toBe("Tess Ademola");
    expect(records[0].warnings.map((w) => w.message)).toEqual(
      warned.warnings.map((w) => w.message),
    );

    const audit = await query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'giveaway.warning_acknowledged'",
    );
    expect(audit).toHaveLength(1);

    const chiefHeard = await listNotifications(chief.user.id);
    const oversight = chiefHeard.find((n) => n.type === "giveaway.warned");
    expect(oversight).toBeDefined();
    expect(oversight!.body).toContain("Tess Ademola");

    /* And the chief hearing about it is not the same as Tomas hearing about
       it: the oversight copy goes to whoever oversees coverage, and to nobody
       else. A resident being told which of their colleagues is tired is the
       kind of leak that is obvious only once it has happened. */
    const tomasAfter = await listNotifications(taker.user.id);
    expect(tomasAfter.some((n) => n.type === "giveaway.warned")).toBe(false);

    await assertDatabaseConsistent();
  });
});

describe("what the calendar feed says afterwards", () => {
  /**
   * The feed is the one surface that is synchronised rather than re-read, so
   * it is the one surface where a shift changing hands can leave a resident
   * looking at something false. Every other screen queries afresh; a phone
   * holds a copy until told otherwise.
   */

  it("stops listing a shift the poster gave away, and publishes it cancelled", async () => {
    const { shift, request } = await postGiveaway();
    const from = new Date(Date.now() - 60 * 86_400_000);

    // Before: it is theirs, and there is nothing to retract.
    expect(
      (await listResidentSchedule(poster.resident.id, { from })).map((s) => s.id),
    ).toContain(shift.id);
    expect(await listReleasedShifts(poster.resident.id, { from })).toHaveLength(0);

    await takeShift(taker.context, request.id, { acknowledgedWarnings: [] });

    // After: gone from the live list, and named in the retractions.
    expect(
      (await listResidentSchedule(poster.resident.id, { from })).map((s) => s.id),
    ).not.toContain(shift.id);
    expect((await listReleasedShifts(poster.resident.id, { from })).map((s) => s.id)).toEqual([
      shift.id,
    ]);

    /* The document a subscribed calendar actually receives. This is the
       assertion that matters: dropping the event is not an instruction to
       delete it, and Google Calendar in particular will go on showing a shift
       that simply disappeared from the feed. */
    const ics = buildCalendar(await listResidentSchedule(poster.resident.id, { from }), {
      programName: fixture.program.name,
      residentName: "Priya Nair",
      timezone: fixture.program.timezone,
      appUrl: "https://shiftswitch.example",
      reminderMinutes: 60,
      released: await listReleasedShifts(poster.resident.id, { from }),
    });
    expect(ics).toContain(`UID:shift-${shift.id}@shiftswitch`);
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).not.toContain("STATUS:CONFIRMED");
  });

  it("gives the shift to the taker's feed as a shift they work", async () => {
    const { shift, request } = await postGiveaway();
    await takeShift(taker.context, request.id, { acknowledgedWarnings: [] });
    const from = new Date(Date.now() - 60 * 86_400_000);

    expect(
      (await listResidentSchedule(taker.resident.id, { from })).map((s) => s.id),
    ).toContain(shift.id);
    // Nothing was taken away from them, so nothing is retracted from them.
    expect(await listReleasedShifts(taker.resident.id, { from })).toHaveLength(0);
  });

  it("retracts nothing from a resident who was never involved", async () => {
    const { request } = await postGiveaway();
    await takeShift(taker.context, request.id, { acknowledgedWarnings: [] });
    expect(
      await listReleasedShifts(tired.resident.id, {
        from: new Date(Date.now() - 60 * 86_400_000),
      }),
    ).toHaveLength(0);
  });
});
