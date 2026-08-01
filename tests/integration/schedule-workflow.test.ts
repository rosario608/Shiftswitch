import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query, queryOne } from "@/server/db/pool";
import { createCoverage } from "@/server/domain/coverage";
import { generateDraftSchedule } from "@/server/domain/generator/run";
import {
  addLock,
  listLocks,
  locksForGeneration,
  removeLock,
} from "@/server/domain/schedule-locks";
import {
  approveScheduleVersion,
  createScheduleVersion,
  getScheduleVersion,
  publishScheduleVersion,
  withdrawApproval,
} from "@/server/domain/schedule-versions";
import {
  NY,
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  notificationsFor,
  resetDatabase,
  type TestProgram,
  type TestResident,
} from "./helpers";

/**
 * The workflow around a schedule, rather than the schedule itself: lock,
 * regenerate the remainder, approve, publish, notify.
 *
 * Every one of these is a step somebody takes deliberately, and every one of
 * them used to be either impossible or a single unguarded button.
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
  fixture = await createProgram({ name: "Workflow" });
  chief = await createStaff(fixture.program, {
    email: "chief@hospital.org",
    role: "chief",
    name: "Casey Chief",
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
  /* One person on wards, every day. Small enough to generate in well under the
     time budget and big enough that locking one placement is meaningful. */
  await createCoverage(chief.context, {
    serviceId: fixture.services.MICU.id,
    scope: "weekday",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    minStaff: 1,
    label: "MICU cover",
    startTime: "07:00",
    endTime: "19:00",
  });
});

async function generate(versionId?: string, seed = 1) {
  return generateDraftSchedule(chief.context, {
    name: "Block draft",
    periodStart: inDays(7),
    periodEnd: inDays(13),
    seed,
    timeBudgetMs: 200,
    versionId: versionId ?? null,
  });
}

describe("locks", () => {
  it("keeps a locked resident's placements across a regeneration", async () => {
    const first = await generate();
    expect(first.feasible).toBe(true);

    const before = await query<{ id: string; resident_id: string; date: string }>(
      `SELECT s.id, a.resident_id, s.date::text AS date
         FROM shifts s JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1 ORDER BY s.date`,
      [first.versionId],
    );
    const pinned = before[0];

    await addLock(chief.context, first.versionId!, {
      kind: "resident",
      targetId: pinned.resident_id,
      reason: "Agreed with them last week.",
    });

    /* A different seed, so the generator would otherwise produce a different
       arrangement. That is the whole test: locks have to survive a run that
       genuinely wanted to move things. */
    const second = await generate(first.versionId!, 99);
    expect(second.feasible).toBe(true);

    const after = await query<{ id: string; resident_id: string; date: string }>(
      `SELECT s.id, a.resident_id, s.date::text AS date
         FROM shifts s JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1 ORDER BY s.date`,
      [first.versionId],
    );

    const keptDates = before
      .filter((row) => row.resident_id === pinned.resident_id)
      .map((row) => row.date);
    for (const date of keptDates) {
      const stillTheirs = after.some(
        (row) => row.date === date && row.resident_id === pinned.resident_id,
      );
      expect(stillTheirs, `${date} should still be theirs`).toBe(true);
    }

    /* And the identifiers survive too, so a lock on a placement does not
       quietly become a different row with the same person on it. */
    const keptIds = before
      .filter((row) => row.resident_id === pinned.resident_id)
      .map((row) => row.id);
    for (const id of keptIds) {
      expect(after.some((row) => row.id === id)).toBe(true);
    }
  });

  it("resolves an assignment lock through the person and the day, not the shift id", async () => {
    const first = await generate();
    const shift = (await queryOne<{ resident_id: string; date: string }>(
      `SELECT a.resident_id, s.date::text AS date
         FROM shifts s JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1 ORDER BY s.date LIMIT 1`,
      [first.versionId],
    ))!;

    await addLock(chief.context, first.versionId!, {
      kind: "assignment",
      targetId: shift.resident_id,
      targetDate: shift.date,
    });

    /* Regeneration deletes and recreates unlocked shifts, so a lock keyed by
       shift id would point at a row that no longer exists. Keyed by person and
       day it still resolves. */
    const locks = await locksForGeneration(fixture.program.id, first.versionId!);
    expect(locks).toHaveLength(1);
    expect(locks[0].kind).toBe("assignment");
  });

  it("treats locking the same thing twice as a no-op", async () => {
    const first = await generate();
    const input = {
      kind: "service" as const,
      targetId: fixture.services.MICU.id,
      reason: "Settled.",
    };
    const a = await addLock(chief.context, first.versionId!, input);
    const b = await addLock(chief.context, first.versionId!, input);
    expect(b.id).toBe(a.id);
    expect(await listLocks(fixture.program.id, first.versionId!)).toHaveLength(1);
  });

  it("reports a lock whose target no longer exists rather than hiding it", async () => {
    const first = await generate();
    const gone = residents[5];
    await addLock(chief.context, first.versionId!, {
      kind: "resident",
      targetId: gone.resident.id,
    });
    /* The resident row survives; the lock resolves. Then remove the name and
       the lock is still listed, with nothing to show for its target — which is
       the honest answer, and the one that gets it noticed. */
    await query("UPDATE users SET full_name = '' WHERE id = $1", [gone.user.id]);
    const locks = await listLocks(fixture.program.id, first.versionId!);
    expect(locks).toHaveLength(1);
    expect(locks[0].target_label).toBe("");
  });

  it("removes a lock", async () => {
    const first = await generate();
    const lock = await addLock(chief.context, first.versionId!, {
      kind: "date",
      targetDate: inDays(8),
    });
    await removeLock(chief.context, first.versionId!, lock.id);
    expect(await listLocks(fixture.program.id, first.versionId!)).toHaveLength(0);
  });
});

describe("approval", () => {
  async function draft() {
    return createScheduleVersion(chief.context, {
      name: "Next block",
      periodStart: inDays(7),
      periodEnd: inDays(13),
    });
  }

  it("refuses to publish a draft nobody has approved", async () => {
    const version = await draft();
    await expect(publishScheduleVersion(chief.context, version.id)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("has not been approved"),
    });
  });

  it("records who approved it, when, and what they were shown", async () => {
    const version = await draft();
    await approveScheduleVersion(chief.context, version.id, {
      notes: "Two gaps accepted, covered by the float.",
      report: {
        score: 84.2,
        hard: 2,
        soft: 5,
        shifts: 40,
        accepted: ["MICU needs 2 people on Mon, Aug 10 and has 1."],
      },
    });

    const after = (await getScheduleVersion(fixture.program.id, version.id))!;
    expect(after.approved_at).not.toBeNull();
    expect(after.approved_by_name).toBe("Casey Chief");
    expect(after.approval_notes).toContain("covered by the float");
    /* The violations that were knowingly accepted are stored with the
       approval. Recomputing them later answers a different question, because
       the roster and the rules will have moved. */
    expect(after.approval_report?.accepted).toHaveLength(1);
    expect(after.approval_report?.score).toBeCloseTo(84.2);
  });

  it("lets an approval be withdrawn, and publishing is refused again", async () => {
    const version = await draft();
    await approveScheduleVersion(chief.context, version.id, {
      report: { score: 90, hard: 0, soft: 1, shifts: 10, accepted: [] },
    });
    const withdrawn = await withdrawApproval(chief.context, version.id);
    expect(withdrawn.approved_at).toBeNull();
    await expect(publishScheduleVersion(chief.context, version.id)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("refuses to approve a schedule that is already live", async () => {
    const version = await draft();
    await approveScheduleVersion(chief.context, version.id, {
      report: { score: 90, hard: 0, soft: 0, shifts: 0, accepted: [] },
    });
    await publishScheduleVersion(chief.context, version.id);
    await expect(
      approveScheduleVersion(chief.context, version.id, {
        report: { score: 90, hard: 0, soft: 0, shifts: 0, accepted: [] },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("publishing", () => {
  it("tells everybody who has a shift in the window, with a route", async () => {
    const generated = await generate();
    expect(generated.feasible).toBe(true);

    await approveScheduleVersion(chief.context, generated.versionId!, {
      report: { score: 100, hard: 0, soft: 0, shifts: 7, accepted: [] },
    });
    const result = await publishScheduleVersion(chief.context, generated.versionId!);

    expect(result.published).toBeGreaterThan(0);
    expect(result.notified).toBeGreaterThan(0);

    const holders = await query<{ user_id: string }>(
      `SELECT DISTINCT u.id AS user_id
         FROM shifts s
         JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
         JOIN residents r ON r.id = a.resident_id
         JOIN users u ON u.id = r.user_id
        WHERE s.published_version_id = $1`,
      [generated.versionId],
    );
    expect(holders.length).toBe(result.notified);

    for (const holder of holders) {
      const told = await notificationsFor(holder.user_id, "schedule.published");
      expect(told).toHaveLength(1);
      /* Stored, not derived at render time. A push that opens the app and
         lands nowhere made somebody pick up their phone for nothing. */
      expect(told[0].route).toBe("/schedule");
      expect(told[0].title).toContain("Block draft");
    }
  });

  it("stamps every published shift with the version it came from", async () => {
    const generated = await generate();
    await approveScheduleVersion(chief.context, generated.versionId!, {
      report: { score: 100, hard: 0, soft: 0, shifts: 7, accepted: [] },
    });
    await publishScheduleVersion(chief.context, generated.versionId!);

    const shifts = await query<{ schedule_version_id: string | null; published_version_id: string }>(
      `SELECT schedule_version_id, published_version_id FROM shifts
        WHERE program_id = $1`,
      [fixture.program.id],
    );
    expect(shifts.length).toBeGreaterThan(0);
    for (const shift of shifts) {
      /* Null still means published — that is load-bearing everywhere — and the
         second column is what makes "what did we publish" answerable. */
      expect(shift.schedule_version_id).toBeNull();
      expect(shift.published_version_id).toBe(generated.versionId);
    }
  });
});
