import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query, queryOne } from "@/server/db/pool";
import { createCoverage } from "@/server/domain/coverage";
import { generateDraftSchedule } from "@/server/domain/generator/run";
import {
  approveScheduleVersion,
  getScheduleVersion,
  publishScheduleVersion,
} from "@/server/domain/schedule-versions";
import {
  correctPublishedShift,
  listCorrections,
} from "@/server/domain/schedule-corrections";
import { acceptOffer, createOffer, postShiftForTrade } from "@/server/domain/trades";
import {
  NY,
  assertDatabaseConsistent,
  closeDatabase,
  createProgram,
  createResident,
  createShift,
  createStaff,
  ensureMigrated,
  notificationsFor,
  resetDatabase,
  type TestProgram,
  type TestResident,
} from "./helpers";

/**
 * The whole path, once, in order: configure a programme, generate a schedule,
 * approve it, publish it, trade a shift out of it, and then correct one.
 *
 * Every step here is covered in detail somewhere else. What this test is for is
 * the joins between them — the places where two features that each work alone
 * disagree about what a shift is. A generated shift becoming a published shift
 * becoming a traded shift becoming a corrected shift crosses four subsystems,
 * and nothing else in the suite watches one row travel the whole way.
 *
 * It ends in `assertDatabaseConsistent`, which is the actual assertion: the
 * counts along the way could all be right with the database still holding a
 * shift two people are on.
 */

let fixture: TestProgram;
let chief: Awaited<ReturnType<typeof createStaff>>;
let residents: TestResident[];

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

function inDays(days: number): string {
  return DateTime.now().setZone(NY).plus({ days }).toISODate() as string;
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram({ name: "Lifecycle Residency" });
  chief = await createStaff(fixture.program, {
    email: "chief@hospital.org",
    role: "chief",
    name: "Casey Chief",
  });
  residents = [];
  for (let index = 0; index < 8; index += 1) {
    residents.push(
      await createResident(fixture.program, {
        email: `resident${index}@hospital.org`,
        name: `Resident ${index}`,
        pgy: 2,
      }),
    );
  }
});

/** A live shift, held by somebody, on a given day. */
async function makeLiveShift(
  day: number,
  serviceId: string,
  holder: TestResident,
  times: { startTime: string; endTime: string } = { startTime: "07:00", endTime: "19:00" },
) {
  return createShift(fixture.program, {
    inDays: day,
    serviceId,
    residentId: holder.resident.id,
    ...times,
  });
}

/** An evening shift, for scenarios that need two people on one service on one
 *  day without putting either of them in two places at once. */
const EVENING = { startTime: "20:00", endTime: "23:00" };

describe("a programme's schedule, from nothing to corrected", () => {
  it("survives the whole path with the database still consistent", async () => {
    // ---------------------------------------------------------------- configure
    /* Two services, each wanting one person a day. Two so that a trade has
       somewhere to go: a swap within one service on one day changes nothing. */
    for (const service of [fixture.services.MICU, fixture.services.Floor]) {
      await createCoverage(chief.context, {
        serviceId: service.id,
        scope: "weekday",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        minStaff: 1,
        label: `${service.name} cover`,
        startTime: "07:00",
        endTime: "19:00",
      });
    }

    // ----------------------------------------------------------------- generate
    const generated = await generateDraftSchedule(chief.context, {
      name: "Block 1",
      periodStart: inDays(7),
      periodEnd: inDays(13),
      seed: 4,
      timeBudgetMs: 300,
    });

    expect(generated.feasible).toBe(true);
    expect(generated.versionId).not.toBeNull();
    /* Fourteen slots — two services, seven days — and the generator does not
       get to decide whether its own output is legal. */
    expect(generated.report.demand.filled).toBe(generated.report.demand.slots);
    expect(generated.report.hardViolations).toHaveLength(0);
    await assertDatabaseConsistent();

    const versionId = generated.versionId!;

    // ------------------------------------------------------------------ approve
    await expect(
      publishScheduleVersion(chief.context, versionId),
    ).rejects.toMatchObject({ code: "conflict" });

    await approveScheduleVersion(chief.context, versionId, {
      notes: "Checked against the roster.",
      report: {
        score: generated.report.score.score,
        hard: 0,
        soft: generated.report.softViolations.length,
        shifts: generated.report.demand.filled,
        accepted: [],
      },
    });

    // ------------------------------------------------------------------ publish
    const published = await publishScheduleVersion(chief.context, versionId);
    expect(published.published).toBe(generated.report.demand.slots);
    expect(published.notified).toBeGreaterThan(0);

    const version = (await getScheduleVersion(fixture.program.id, versionId))!;
    expect(version.status).toBe("published");
    expect(version.approved_by_name).toBe("Casey Chief");

    /* Every shift is live, and every one knows which publication produced it —
       provenance the "null means published" trick had cost us. */
    const live = await query<{
      id: string;
      published_version_id: string;
      schedule_version_id: string | null;
      resident_id: string;
      date: string;
      service_id: string;
    }>(
      `SELECT s.id, s.published_version_id, s.schedule_version_id, a.resident_id,
              s.date::text AS date, s.service_id
         FROM shifts s
         JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.program_id = $1
        ORDER BY s.date, s.service_id`,
      [fixture.program.id],
    );
    expect(live).toHaveLength(generated.report.demand.slots);
    expect(live.every((shift) => shift.schedule_version_id === null)).toBe(true);
    expect(live.every((shift) => shift.published_version_id === versionId)).toBe(true);
    await assertDatabaseConsistent();

    // -------------------------------------------------------------------- trade
    /* Two shifts on different days held by different people, so the swap is a
       real one and the coverage check has something to think about — and
       neither resident already works the other's day.
     *
     * That last condition used to be missing, and the pair was whatever the
     * generator happened to produce. Most runs it was fine; some runs the
     * poster already held a shift at the same hours as the one they were about
     * to receive, and the switch double-booked them. The suite reported it as
     * an intermittent inconsistency rather than as what it was, because
     * nothing refused the swap: overlap was a rule this programme had never
     * configured. It is a system check now, so an unpickable pair is refused
     * outright — which would turn the old selection into an intermittent
     * *failure* instead. Picking a pair the residents can actually take is the
     * honest fix; asserting "completed or refused" would have been the test
     * quietly agreeing to learn nothing. */
    const daysWorkedBy = (residentId: string) =>
      new Set(live.filter((shift) => shift.resident_id === residentId).map((s) => s.date));

    const pair = live
      .flatMap((first) =>
        live
          .filter(
            (other) =>
              other.resident_id !== first.resident_id &&
              other.date !== first.date &&
              !daysWorkedBy(first.resident_id).has(other.date) &&
              !daysWorkedBy(other.resident_id).has(first.date),
          )
          .map((other) => [first, other] as const),
      )
      .at(0);
    expect(pair).toBeDefined();
    const [first, partner] = pair!;

    const poster = residents.find((r) => r.resident.id === first.resident_id)!;
    const offerer = residents.find((r) => r.resident.id === partner.resident_id)!;

    const request = await postShiftForTrade(poster.context, { shiftId: first.id });
    const offer = await createOffer(offerer.context, {
      tradeRequestId: request.id,
      offeredShiftId: partner.id,
    });

    const outcome = await acceptOffer(poster.context, offer.offer.id);
    expect(outcome.status === "completed" || outcome.status === "pending_approval").toBe(
      true,
    );
    await assertDatabaseConsistent();

    if (outcome.status === "completed") {
      /* The shifts changed hands, and the published schedule is still the
         authoritative record of who works what. */
      const afterTrade = await queryOne<{ resident_id: string }>(
        `SELECT resident_id FROM shift_assignments
          WHERE shift_id = $1 AND assignment_status = 'active'`,
        [first.id],
      );
      expect(afterTrade!.resident_id).toBe(offerer.resident.id);
    }

    // ------------------------------------------------------------------- correct
    /* Somebody who is on nothing that day, so the correction does not simply
       recreate the collision it is meant to resolve. */
    /* Read from the database, not from `live`. That snapshot was taken before
       the trade, and the trade is what moved people around — using it meant the
       "spare" could be whoever now holds `partner`, and the correction was
       refused with "That is who is already on it". It failed about one run in
       three, which is not flakiness: it is a test asking a question about a
       schedule that has since changed. */
    const busyOnThatDay = new Set(
      (
        await query<{ resident_id: string }>(
          `SELECT a.resident_id
             FROM shifts s
             JOIN shift_assignments a
               ON a.shift_id = s.id AND a.assignment_status = 'active'
            WHERE s.program_id = $1 AND s.schedule_version_id IS NULL AND s.date = $2`,
          [fixture.program.id, partner.date],
        )
      ).map((row) => row.resident_id),
    );
    const spare = residents.find(
      (resident) => !busyOnThatDay.has(resident.resident.id),
    )!;
    expect(spare, "somebody free on that day to correct the shift to").toBeDefined();

    const correction = await correctPublishedShift(chief.context, partner.id, {
      residentId: spare.resident.id,
      reason: "Rotation changed after the schedule went out.",
    });

    expect(correction.newResidentName).toBe(spare.user.full_name);
    expect(correction.notified).toContain(spare.user.full_name);
    /* The impact is the validator's answer to "did that break anything",
       computed after the change rather than predicted before it. */
    expect(correction.impact).not.toBeNull();
    expect(correction.impact!.summary.length).toBeGreaterThan(0);

    const told = await notificationsFor(spare.user.id, "schedule.corrected");
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("Rotation changed");
    expect(told[0].route).toBe("/schedule");

    /* And it is visible afterwards. The difference between what was published
       and what is true now is a list somebody who was not in the room can
       read. */
    const record = await listCorrections(fixture.program.id);
    expect(record).toHaveLength(1);
    expect(record[0].reason).toContain("Rotation changed");
    expect(record[0].new_resident_name).toBe(spare.user.full_name);
    expect(record[0].version_name).toBe("Block 1");
    expect(record[0].impact?.summary).toBe(correction.impact!.summary);

    const audit = await query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'schedule.corrected'",
    );
    expect(audit).toHaveLength(1);

    await assertDatabaseConsistent();
  });

  it("refuses a switch that would leave a service short", async () => {
    /* MICU needs two people on the day. Alice works the day shift, Bob the
       evening, and Bob also holds a Floor shift the next day. Swapping Alice's
       MICU day shift for Bob's Floor shift leaves MICU with two shifts and
       **one person** — a clinical gap that every rule in the engine passes,
       because every rule is about one of the two residents and this is about
       the ward.

       Bob's MICU shift is deliberately in the evening. When both were 07:00 to
       19:00 this scenario was not a coverage gap at all, it was Bob in two
       places at once — and it only reached the coverage check because nothing
       enforced overlap unless a programme had configured the rule. Now that
       overlap is a system check, an accidental double-booking is refused as
       one, and this test would have been asserting the wrong sentence. The
       evening shift keeps the case it was written for: two distinct slots, two
       distinct people, and a swap that collapses them to one person. */
    const alice = residents[0];
    const bob = residents[1];

    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "date",
      specificDate: inDays(10),
      minStaff: 2,
      label: "MICU day",
    });

    const aliceShift = await makeLiveShift(10, fixture.services.MICU.id, alice);
    await makeLiveShift(10, fixture.services.MICU.id, bob, EVENING);
    const bobShift = await makeLiveShift(11, fixture.services.Floor.id, bob);

    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });

    /* Refused at the offer, before either resident has agreed to anything —
       and the message says it is this switch that would cause it, not that the
       ward was already short. The validator's own sentence is left intact, so
       the numbers a chief would check are the numbers it reports. */
    await expect(
      createOffer(bob.context, {
        tradeRequestId: request.id,
        offeredShiftId: bobShift.id,
      }),
    ).rejects.toMatchObject({
      code: "rule_violation",
      message: expect.stringContaining("This switch would leave a service short"),
    });

    await assertDatabaseConsistent();
  });

  it("allows a switch that leaves coverage exactly as it found it", async () => {
    const alice = residents[0];
    const bob = residents[1];

    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "date",
      specificDate: inDays(10),
      minStaff: 1,
      label: "MICU day",
    });

    const aliceShift = await makeLiveShift(10, fixture.services.MICU.id, alice);
    const bobShift = await makeLiveShift(11, fixture.services.Floor.id, bob);

    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    const offer = await createOffer(bob.context, {
      tradeRequestId: request.id,
      offeredShiftId: bobShift.id,
    });

    /* The pass matters as much as the fail: "coverage was checked and is fine"
       and "coverage was not checked" must not look the same on a screen that
       lists what was verified. */
    const coverage = offer.validation.checks.filter(
      (check) => check.ruleType === "system.coverage",
    );
    expect(coverage).toHaveLength(1);
    expect(coverage[0].status).toBe("pass");
    expect(offer.validation.valid).toBe(true);
  });

  it("refuses a correction with no reason, because somebody has to read it", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 1,
      label: "MICU",
    });
    const generated = await generateDraftSchedule(chief.context, {
      name: "Block",
      periodStart: inDays(7),
      periodEnd: inDays(9),
      seed: 1,
      timeBudgetMs: 200,
    });
    await approveScheduleVersion(chief.context, generated.versionId!, {
      report: { score: 100, hard: 0, soft: 0, shifts: 3, accepted: [] },
    });
    await publishScheduleVersion(chief.context, generated.versionId!);

    const shift = (await queryOne<{ id: string }>(
      "SELECT id FROM shifts WHERE program_id = $1 LIMIT 1",
      [fixture.program.id],
    ))!;

    await expect(
      correctPublishedShift(chief.context, shift.id, {
        residentId: residents[0].resident.id,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("sends a correction on a draft shift to the cheap path instead", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 1,
      label: "MICU",
    });
    const generated = await generateDraftSchedule(chief.context, {
      name: "Block",
      periodStart: inDays(7),
      periodEnd: inDays(9),
      seed: 1,
      timeBudgetMs: 200,
    });
    const draftShift = (await queryOne<{ id: string }>(
      "SELECT id FROM shifts WHERE schedule_version_id = $1 LIMIT 1",
      [generated.versionId],
    ))!;

    /* Nobody is working a draft, so correcting one is the wrong verb — and the
       refusal says which verb is right rather than only that this one is
       wrong. */
    await expect(
      correctPublishedShift(chief.context, draftShift.id, {
        residentId: residents[0].resident.id,
        reason: "Testing.",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("part of a draft"),
    });
  });
});
