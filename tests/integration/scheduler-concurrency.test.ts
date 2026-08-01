import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query, queryOne } from "@/server/db/pool";
import { createCoverage } from "@/server/domain/coverage";
import { generateDraftSchedule } from "@/server/domain/generator/run";
import { bulkAssign } from "@/server/domain/schedule-bulk";
import { addLock, listLocks, removeLock } from "@/server/domain/schedule-locks";
import { correctPublishedShift } from "@/server/domain/schedule-corrections";
import {
  approveScheduleVersion,
  assignDraftShift,
  createScheduleVersion,
  discardScheduleVersion,
  publishScheduleVersion,
  withdrawApproval,
  type ApprovalReport,
} from "@/server/domain/schedule-versions";
import { acceptOffer, createOffer, postShiftForTrade } from "@/server/domain/trades";
import {
  NY,
  activeAssignee,
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
 * The scheduler, raced.
 *
 * `concurrency.test.ts` does this for the trade lifecycle, and it found three
 * defects nothing else did. The scheduling side has the same shape of risk and
 * a worse blast radius: a trade that tears leaves two residents confused about
 * one shift, whereas a publication that tears leaves a month of a programme's
 * schedule wrong, and nobody finds out until somebody does not turn up.
 *
 * The situations here are the ones a real programme produces on a Sunday night:
 * two chiefs in the scheduler at once, a publish going out while a resident
 * taps accept on a switch, a correction landing on a shift somebody is trading,
 * two drafts covering overlapping weeks. None of them is exotic. Every one of
 * them ends in `assertDatabaseConsistent()`, because counting which call
 * succeeded is exactly the check that cannot see a torn write — "one published
 * and one was refused" is compatible with a week that now has two schedules in
 * it.
 */

let fixture: TestProgram;
let chief: Awaited<ReturnType<typeof createStaff>>;
let apd: Awaited<ReturnType<typeof createStaff>>;
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
  fixture = await createProgram({ name: "Race Residency" });
  chief = await createStaff(fixture.program, {
    email: "chief@hospital.org",
    role: "chief",
    name: "Casey Chief",
  });
  apd = await createStaff(fixture.program, {
    email: "apd@hospital.org",
    role: "apd",
    name: "Avery Deputy",
  });
  residents = [];
  for (let index = 0; index < 6; index += 1) {
    residents.push(
      await createResident(fixture.program, {
        email: `r${index}@hospital.org`,
        name: `Resident ${index}`,
        pgy: 2,
      }),
    );
  }
});

/** An approval report with nothing wrong in it — the shape, not the substance. */
const CLEAN_REPORT: ApprovalReport = {
  score: 100,
  hard: 0,
  soft: 0,
  shifts: 0,
  accepted: [],
};

/** A draft with `count` shifts on consecutive days, each already on somebody. */
async function makeDraft(options: {
  name: string;
  from: number;
  to: number;
  serviceId: string;
  holders?: TestResident[];
}) {
  const version = await createScheduleVersion(chief.context, {
    name: options.name,
    periodStart: inDays(options.from),
    periodEnd: inDays(options.to),
  });

  const shifts: string[] = [];
  for (let day = options.from; day <= options.to; day += 1) {
    const holder = options.holders?.[(day - options.from) % options.holders.length];
    const shift = await createShift(fixture.program, {
      inDays: day,
      serviceId: options.serviceId,
      startTime: "07:00",
      endTime: "19:00",
    });
    await query("UPDATE shifts SET schedule_version_id = $2 WHERE id = $1", [
      shift.id,
      version.id,
    ]);
    if (holder) {
      await query("INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)", [
        shift.id,
        holder.resident.id,
      ]);
    }
    shifts.push(shift.id);
  }
  return { version, shifts };
}

/** Live shifts in a day range, one per day, on the given holders in turn. */
async function makeLiveWeek(from: number, to: number, serviceId: string) {
  const shifts: string[] = [];
  for (let day = from; day <= to; day += 1) {
    const shift = await createShift(fixture.program, {
      inDays: day,
      serviceId,
      residentId: residents[(day - from) % residents.length].resident.id,
      startTime: "07:00",
      endTime: "19:00",
    });
    shifts.push(shift.id);
  }
  return shifts;
}

async function liveShiftsBetween(from: number, to: number): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM shifts
      WHERE program_id = $1 AND schedule_version_id IS NULL
        AND date >= $2 AND date <= $3 AND status <> 'cancelled'`,
    [fixture.program.id, inDays(from), inDays(to)],
  );
  return Number(rows[0].count);
}

function rejections(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => String(result.reason?.message ?? result.reason));
}

// ---------------------------------------------------------------------------

describe("two schedulers editing the same draft", () => {
  it("leaves one person on a shift when both assign it at once", async () => {
    const { version, shifts } = await makeDraft({
      name: "Block A",
      from: 7,
      to: 9,
      serviceId: fixture.services.MICU.id,
    });

    const results = await Promise.allSettled([
      assignDraftShift(chief.context, version.id, shifts[0], residents[0].resident.id),
      assignDraftShift(apd.context, version.id, shifts[0], residents[1].resident.id),
    ]);

    /* Both may legitimately succeed — the second scheduler's assignment simply
       wins, which is what "two people editing a draft" means. What may never
       happen is both assignments surviving. */
    const holder = await activeAssignee(shifts[0]);
    expect(holder).not.toBeNull();
    expect([residents[0].resident.id, residents[1].resident.id]).toContain(holder);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThan(0);

    await assertDatabaseConsistent();
  });

  it("keeps one holder when two bulk edits overlap on a shift", async () => {
    const { version, shifts } = await makeDraft({
      name: "Block A",
      from: 7,
      to: 13,
      serviceId: fixture.services.MICU.id,
    });

    /* Two selections that share the middle shift, as two people dragging over
       overlapping ranges of the same grid would produce. */
    const first = shifts.slice(0, 4).map((shiftId) => ({
      shiftId,
      residentId: residents[0].resident.id,
    }));
    const second = shifts.slice(3).map((shiftId) => ({
      shiftId,
      residentId: residents[1].resident.id,
    }));

    await Promise.allSettled([
      bulkAssign(chief.context, version.id, first),
      bulkAssign(apd.context, version.id, second),
    ]);

    for (const shiftId of shifts) {
      const holders = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM shift_assignments
          WHERE shift_id = $1 AND assignment_status = 'active'`,
        [shiftId],
      );
      expect(Number(holders[0].count), `shift ${shiftId} holders`).toBeLessThanOrEqual(1);
    }

    await assertDatabaseConsistent();
  });

  it("refuses to edit a draft that was published out from under the editor", async () => {
    const { version, shifts } = await makeDraft({
      name: "Block A",
      from: 7,
      to: 9,
      serviceId: fixture.services.MICU.id,
      holders: residents,
    });
    await approveScheduleVersion(chief.context, version.id, { report: CLEAN_REPORT });

    const results = await Promise.allSettled([
      publishScheduleVersion(chief.context, version.id),
      bulkAssign(apd.context, version.id, [
        { shiftId: shifts[0], residentId: residents[3].resident.id },
      ]),
    ]);

    /* Whichever order they land in, the edit must not reach a live shift by a
       route that skips the correction record. Either it got in first, while the
       draft was still a draft, or it is refused. */
    const editFailed = results[1].status === "rejected";
    if (editFailed) {
      expect(rejections(results).join(" ")).toMatch(/publish|draft|correction/i);
    }
    await assertDatabaseConsistent();
  });
});

describe("publishing, raced", () => {
  it("publishes a draft exactly once when two people press it together", async () => {
    const { version } = await makeDraft({
      name: "Block A",
      from: 7,
      to: 13,
      serviceId: fixture.services.MICU.id,
      holders: residents,
    });
    await approveScheduleVersion(chief.context, version.id, { report: CLEAN_REPORT });

    const results = await Promise.allSettled([
      publishScheduleVersion(chief.context, version.id),
      publishScheduleVersion(apd.context, version.id),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejections(results)[0]).toMatch(/already been published/i);
    expect(await liveShiftsBetween(7, 13)).toBe(7);

    await assertDatabaseConsistent();
  });

  it("does not leave two schedules live when overlapping drafts publish at once", async () => {
    /* The situation: next block was drafted, then somebody drafted a
       correction week that overlaps its tail, and both are signed off. Each
       publication replaces *its own* window, and the windows intersect.
       Whichever wins, the overlap must end up with one schedule in it — a day
       carrying both drafts' shifts is a day every service is double-staffed
       and at least one resident is in two places. */
    const first = await makeDraft({
      name: "Block A",
      from: 7,
      to: 13,
      serviceId: fixture.services.MICU.id,
      holders: residents,
    });
    const second = await makeDraft({
      name: "Block B",
      from: 11,
      to: 17,
      serviceId: fixture.services.MICU.id,
      holders: residents,
    });
    await approveScheduleVersion(chief.context, first.version.id, { report: CLEAN_REPORT });
    await approveScheduleVersion(chief.context, second.version.id, { report: CLEAN_REPORT });

    await Promise.allSettled([
      publishScheduleVersion(chief.context, first.version.id),
      publishScheduleVersion(apd.context, second.version.id),
    ]);

    /* Days 11–13 are in both. One shift per day per service is what either
       schedule says; two is the tear. */
    const overlap = await query<{ date: string; count: string }>(
      `SELECT date::text AS date, count(*)::text AS count
         FROM shifts
        WHERE program_id = $1 AND schedule_version_id IS NULL
          AND date >= $2 AND date <= $3 AND status <> 'cancelled'
        GROUP BY date ORDER BY date`,
      [fixture.program.id, inDays(11), inDays(13)],
    );
    for (const row of overlap) {
      expect(Number(row.count), `${row.date} has more than one schedule's shifts`).toBe(1);
    }

    await assertDatabaseConsistent();
  });

  it("never publishes over a switch a resident is completing", async () => {
    /* A live week, one shift of which is mid-trade, and a draft that covers the
       same week waiting to go out. The publish deletes the live window; the
       accept moves two live shifts. Either order is fine. Both applying is a
       completed switch whose shifts no longer exist. */
    const live = await makeLiveWeek(7, 12, fixture.services.MICU.id);
    const partner = await createShift(fixture.program, {
      inDays: 20,
      serviceId: fixture.services.Floor.id,
      residentId: residents[3].resident.id,
    });

    const holderId = (await activeAssignee(live[0]))!;
    const poster = residents.find((r) => r.resident.id === holderId)!;
    const request = await postShiftForTrade(poster.context, { shiftId: live[0] });
    const offer = await createOffer(residents[3].context, {
      tradeRequestId: request.id,
      offeredShiftId: partner.id,
    });

    const { version } = await makeDraft({
      name: "Replacement",
      from: 7,
      to: 12,
      serviceId: fixture.services.MICU.id,
      holders: residents,
    });
    await approveScheduleVersion(chief.context, version.id, { report: CLEAN_REPORT });

    const results = await Promise.allSettled([
      publishScheduleVersion(chief.context, version.id),
      acceptOffer(poster.context, offer.offer.id),
    ]);

    /* At least one has to give: the publish refuses an entangled window, and
       the accept refuses a shift that has been replaced. */
    expect(results.some((result) => result.status === "rejected")).toBe(true);

    /* And whatever happened, no completed switch may reference a shift that is
       no longer there. That is the state check the counts cannot make. */
    const dangling = await query<{ id: string }>(
      `SELECT c.id FROM completed_trades c
        WHERE NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = c.source_shift_id)
           OR NOT EXISTS (SELECT 1 FROM shifts s WHERE s.id = c.destination_shift_id)`,
    );
    expect(dangling).toHaveLength(0);

    await assertDatabaseConsistent();
  });

  it("does not publish a draft whose approval is being withdrawn", async () => {
    const { version } = await makeDraft({
      name: "Block A",
      from: 7,
      to: 10,
      serviceId: fixture.services.MICU.id,
      holders: residents,
    });
    await approveScheduleVersion(chief.context, version.id, { report: CLEAN_REPORT });

    const results = await Promise.allSettled([
      publishScheduleVersion(chief.context, version.id),
      withdrawApproval(apd.context, version.id),
    ]);

    /* Either the publish got in and the withdrawal is refused because the
       schedule is no longer a draft, or the withdrawal got in and publishing
       has to be refused for want of an approval. What may not happen is a
       published schedule with no approval on the record — the audit trail is
       the point of the two-step. */
    const version_ = await queryOne<{ status: string; approved_at: Date | null }>(
      "SELECT status::text AS status, approved_at FROM schedule_versions WHERE id = $1",
      [version.id],
    );
    if (version_!.status === "published") {
      expect(version_!.approved_at).not.toBeNull();
    }
    expect(results.length).toBe(2);

    await assertDatabaseConsistent();
  });

  it("does not publish a draft that is being discarded", async () => {
    const { version } = await makeDraft({
      name: "Block A",
      from: 7,
      to: 10,
      serviceId: fixture.services.MICU.id,
      holders: residents,
    });
    await approveScheduleVersion(chief.context, version.id, { report: CLEAN_REPORT });

    await Promise.allSettled([
      publishScheduleVersion(chief.context, version.id),
      discardScheduleVersion(apd.context, version.id),
    ]);

    /* A discarded draft takes its shifts with it. A published one hands them
       over. Both happening means live shifts pointing at a version that is
       gone, or a version marked published with nothing in it. */
    const orphans = await query<{ id: string }>(
      `SELECT s.id FROM shifts s
        WHERE s.published_version_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM schedule_versions v WHERE v.id = s.published_version_id)`,
    );
    expect(orphans).toHaveLength(0);

    await assertDatabaseConsistent();
  });
});

describe("generation, raced", () => {
  it("does not double a draft when two generations run into it at once", async () => {
    for (const service of [fixture.services.MICU, fixture.services.Floor]) {
      await createCoverage(chief.context, {
        serviceId: service.id,
        scope: "weekday",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        minStaff: 1,
        startTime: "07:00",
        endTime: "19:00",
      });
    }

    const seeded = await generateDraftSchedule(chief.context, {
      name: "Block A",
      periodStart: inDays(7),
      periodEnd: inDays(11),
      seed: 3,
      timeBudgetMs: 200,
    });
    expect(seeded.versionId).not.toBeNull();

    /* Two chiefs pressing "generate again" on the same draft. Regeneration
       replaces the unlocked shifts, so running it twice at once must not leave
       two generations' worth of shifts in one draft. */
    const results = await Promise.allSettled([
      generateDraftSchedule(chief.context, {
        name: "Block A",
        periodStart: inDays(7),
        periodEnd: inDays(11),
        seed: 4,
        timeBudgetMs: 200,
        versionId: seeded.versionId,
      }),
      generateDraftSchedule(apd.context, {
        name: "Block A",
        periodStart: inDays(7),
        periodEnd: inDays(11),
        seed: 5,
        timeBudgetMs: 200,
        versionId: seeded.versionId,
      }),
    ]);

    /* Two services, one person each, five days: ten slots. A draft holding
       twenty is two generations stacked on top of each other. */
    const rows = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM shifts WHERE schedule_version_id = $1",
      [seeded.versionId],
    );
    expect(Number(rows[0].count)).toBeLessThanOrEqual(10);

    /* And the one that lost was *told*. Silently discarding a scheduler's run
       is the version of this bug that survives a shift count: they watched it
       finish, and the draft is not what they built. */
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejections(results)[0]).toMatch(/somebody else changed this draft/i);

    await assertDatabaseConsistent();
  });

  it("keeps a locked placement when a lock lands as regeneration starts", async () => {
    for (const service of [fixture.services.MICU]) {
      await createCoverage(chief.context, {
        serviceId: service.id,
        scope: "weekday",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        minStaff: 1,
        startTime: "07:00",
        endTime: "19:00",
      });
    }

    const seeded = await generateDraftSchedule(chief.context, {
      name: "Block A",
      periodStart: inDays(7),
      periodEnd: inDays(11),
      seed: 3,
      timeBudgetMs: 200,
    });
    const versionId = seeded.versionId!;

    const placed = await queryOne<{ shift_id: string; resident_id: string; date: string }>(
      `SELECT s.id AS shift_id, a.resident_id, s.date::text AS date
         FROM shifts s JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1 ORDER BY s.date LIMIT 1`,
      [versionId],
    );
    expect(placed).not.toBeNull();

    /* The lock is added while the regeneration is already reading. Whether it
       is honoured this run is a race the product does not promise to win —
       what it must not do is leave the draft inconsistent, or leave a lock
       pointing at a schedule that no longer has the shift it names. */
    await Promise.allSettled([
      generateDraftSchedule(chief.context, {
        name: "Block A",
        periodStart: inDays(7),
        periodEnd: inDays(11),
        seed: 9,
        timeBudgetMs: 200,
        versionId,
      }),
      addLock(apd.context, versionId, {
        kind: "assignment",
        targetId: placed!.resident_id,
        targetDate: placed!.date,
        reason: "Agreed with the resident",
      }),
    ]);

    await assertDatabaseConsistent();

    // And a lock added after the fact is honoured by the next run, which is the
    // guarantee the feature actually makes.
    const again = await generateDraftSchedule(chief.context, {
      name: "Block A",
      periodStart: inDays(7),
      periodEnd: inDays(11),
      seed: 11,
      timeBudgetMs: 200,
      versionId,
    });
    expect(again.versionId).toBe(versionId);

    const stillThere = await queryOne<{ resident_id: string }>(
      `SELECT a.resident_id FROM shifts s
         JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1 AND s.date = $2
        LIMIT 1`,
      [versionId, placed!.date],
    );
    expect(stillThere?.resident_id).toBe(placed!.resident_id);

    for (const lock of await listLocks(fixture.program.id, versionId)) {
      await removeLock(apd.context, versionId, lock.id);
    }

    await assertDatabaseConsistent();
  });
});

describe("correcting a published shift, raced", () => {
  it("leaves one holder when two corrections land together", async () => {
    const live = await makeLiveWeek(7, 8, fixture.services.MICU.id);
    const holderId = (await activeAssignee(live[0]))!;
    const others = residents.filter((r) => r.resident.id !== holderId);

    const results = await Promise.allSettled([
      correctPublishedShift(chief.context, live[0], {
        residentId: others[0].resident.id,
        reason: "Sick call.",
      }),
      correctPublishedShift(apd.context, live[0], {
        residentId: others[1].resident.id,
        reason: "Covering a conference.",
      }),
    ]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);

    const holders = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM shift_assignments
        WHERE shift_id = $1 AND assignment_status = 'active'`,
      [live[0]],
    );
    expect(Number(holders[0].count)).toBe(1);

    /* Every correction that reported success left a record saying why. A
       correction without one is a schedule change nobody can account for. */
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    const records = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schedule_corrections WHERE shift_id = $1",
      [live[0]],
    );
    expect(Number(records[0].count)).toBe(succeeded);

    await assertDatabaseConsistent();
  });

  it("does not correct a shift out from under a switch being accepted", async () => {
    const live = await makeLiveWeek(7, 8, fixture.services.MICU.id);
    const partner = await createShift(fixture.program, {
      inDays: 20,
      serviceId: fixture.services.Floor.id,
      residentId: residents[4].resident.id,
    });

    const holderId = (await activeAssignee(live[0]))!;
    const poster = residents.find((r) => r.resident.id === holderId)!;
    const request = await postShiftForTrade(poster.context, { shiftId: live[0] });
    const offer = await createOffer(residents[4].context, {
      tradeRequestId: request.id,
      offeredShiftId: partner.id,
    });

    const results = await Promise.allSettled([
      acceptOffer(poster.context, offer.offer.id),
      correctPublishedShift(chief.context, live[0], {
        residentId: residents[5].resident.id,
        reason: "Rota change agreed with the service.",
      }),
    ]);
    expect(results.length).toBe(2);

    /* If the correction won, the trade must be dead rather than pending on a
       shift that has moved: `correctPublishedShift` invalidates the offers on
       the shift it touches, and that is the behaviour being asserted. */
    const stillLive = await query<{ id: string }>(
      `SELECT o.id FROM trade_offers o
         JOIN trade_requests r ON r.id = o.trade_request_id
        WHERE r.source_shift_id = $1 AND o.status = 'pending'`,
      [live[0]],
    );
    expect(stillLive).toHaveLength(0);

    await assertDatabaseConsistent();
  });
});

describe("the consistency check itself", () => {
  /* `assertDatabaseConsistent` is the assertion every case above ends in, so a
     loophole in it makes the whole file worthless. It used to say "every live
     shift has exactly one holder", which is no longer true — a draft may be
     published with an unfilled slot, deliberately, because approval is not a
     validity check. Loosening it is exactly the kind of change that quietly
     stops catching the thing it was written for, so the two halves are asserted
     here directly: a gap is fine, a shift emptied without a record is not. */

  it("accepts a live shift that was published with nobody on it", async () => {
    const { version } = await makeDraft({
      name: "Half filled",
      from: 7,
      to: 9,
      serviceId: fixture.services.MICU.id,
      // No holders: three slots, nobody in them.
    });
    await approveScheduleVersion(chief.context, version.id, { report: CLEAN_REPORT });
    await publishScheduleVersion(chief.context, version.id);

    // Live, empty, and not a defect — this is what the unfilled queue is for.
    expect(await liveShiftsBetween(7, 9)).toBe(3);
    await assertDatabaseConsistent();
  });

  it("leaves no trace of a holder when a draft cell is cleared", async () => {
    /* The property the check above depends on. An `ended` assignment row means
       "somebody was taken off a shift they were working"; clearing a cell while
       building a draft is not that, and recording it as though it were makes
       the two indistinguishable the moment the draft is published. */
    const { version, shifts } = await makeDraft({
      name: "Cleared",
      from: 7,
      to: 8,
      serviceId: fixture.services.MICU.id,
      holders: residents,
    });

    await assignDraftShift(chief.context, version.id, shifts[0], null);
    await bulkAssign(chief.context, version.id, [
      { shiftId: shifts[1], residentId: null },
    ]);

    for (const shiftId of shifts) {
      const rows = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM shift_assignments WHERE shift_id = $1",
        [shiftId],
      );
      expect(Number(rows[0].count), `shift ${shiftId} assignment rows`).toBe(0);
    }

    /* And the clearing is still on the record — in the audit log, which is
       where a draft's history belongs and what the workspace's change panel
       reads. Both verbs, because only the bulk one used to write anything. */
    const audits = await query<{ new_state: { bulk: boolean } }>(
      `SELECT new_state FROM audit_logs
        WHERE entity_id = $1 AND action = 'shift.reassigned'`,
      [version.id],
    );
    expect(audits.map((row) => row.new_state.bulk).sort()).toEqual([false, true]);

    await approveScheduleVersion(chief.context, version.id, { report: CLEAN_REPORT });
    await publishScheduleVersion(chief.context, version.id);
    await assertDatabaseConsistent();
  });

  it("still catches a live shift emptied with nothing to account for it", async () => {
    const live = await makeLiveWeek(7, 7, fixture.services.MICU.id);

    /* A torn switch, simulated at the row level: the holder is taken off and
       nobody is put on, with no correction and no completed trade. Written
       directly because no service call can produce it — which is the point. */
    await query(
      `UPDATE shift_assignments SET assignment_status = 'ended', ended_at = now()
        WHERE shift_id = $1 AND assignment_status = 'active'`,
      [live[0]],
    );

    await expect(assertDatabaseConsistent()).rejects.toThrow(/emptied/i);
  });
});

describe("an uncoordinated scheduling storm", () => {
  it("survives everything happening to one schedule at once", async () => {
    const live = await makeLiveWeek(7, 12, fixture.services.MICU.id);
    const { version, shifts } = await makeDraft({
      name: "Next block",
      from: 14,
      to: 20,
      serviceId: fixture.services.Floor.id,
      holders: residents,
    });
    await approveScheduleVersion(chief.context, version.id, { report: CLEAN_REPORT });

    const partner = await createShift(fixture.program, {
      inDays: 30,
      serviceId: fixture.services.Clinic.id,
      residentId: residents[2].resident.id,
    });
    const holderId = (await activeAssignee(live[1]))!;
    const poster = residents.find((r) => r.resident.id === holderId)!;
    const request = await postShiftForTrade(poster.context, { shiftId: live[1] });
    const offer = await createOffer(residents[2].context, {
      tradeRequestId: request.id,
      offeredShiftId: partner.id,
    });

    await Promise.allSettled([
      publishScheduleVersion(chief.context, version.id),
      acceptOffer(poster.context, offer.offer.id),
      correctPublishedShift(chief.context, live[3], {
        residentId: residents[5].resident.id,
        reason: "Sick call.",
      }),
      bulkAssign(apd.context, version.id, [
        { shiftId: shifts[0], residentId: residents[1].resident.id },
      ]),
      assignDraftShift(chief.context, version.id, shifts[1], null),
      addLock(apd.context, version.id, {
        kind: "date",
        targetDate: inDays(15),
        reason: "Holiday cover agreed",
      }),
      withdrawApproval(apd.context, version.id),
    ]);

    await assertDatabaseConsistent();
  });
});
