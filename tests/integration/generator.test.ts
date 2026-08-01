import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import { loadScheduleSnapshot } from "@/server/domain/constraints/snapshot";
import { validateSchedule } from "@/server/domain/constraints/validator";
import { createCoverage } from "@/server/domain/coverage";
import { assessEdit } from "@/server/domain/generator/edit-check";
import { generateDraftSchedule } from "@/server/domain/generator/run";
import { updateSchedulingData } from "@/server/domain/roster";
import { diffScheduleVersion } from "@/server/domain/schedule-versions";
import {
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  resetDatabase,
  type TestProgram,
  type TestResident,
} from "./helpers";

/**
 * The generator against a real database, and against a realistic programme.
 *
 * The unit suite proves the algorithm; this proves the half that writes. Two
 * claims matter here and nowhere else:
 *
 *   - a generated schedule lands in a **draft** and never in the live schedule;
 *   - an infeasible run writes **nothing at all**, so a failed attempt cannot
 *     leave a half-built draft for somebody to find and publish.
 *
 * Every assertion about correctness still goes through `validateSchedule`.
 */

let fixture: TestProgram;
let chief: Awaited<ReturnType<typeof createStaff>>;
const residents: TestResident[] = [];

beforeAll(() => ensureMigrated());
afterAll(async () => closeDatabase());

/** Monday of a week comfortably clear of any clock change. */
const PERIOD = { start: "2026-09-07", end: "2026-09-13" };

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram();
  residents.length = 0;
  /* Twelve people across three training years: enough that fairness and the
     rolling limits have something to say, small enough to stay quick. */
  for (let index = 0; index < 12; index += 1) {
    residents.push(
      await createResident(fixture.program, {
        email: `r${index}@h.org`,
        name: `Resident ${String(index).padStart(2, "0")}`,
        pgy: (index % 3) + 1,
      }),
    );
  }
  chief = await createStaff(fixture.program, {
    email: "chief@h.org",
    role: "chief",
    name: "Casey Chief",
  });
});

function program() {
  return {
    id: fixture.program.id,
    name: fixture.program.name,
    timezone: fixture.program.timezone,
  };
}

async function validateDraft(versionId: string) {
  return validateSchedule(
    await loadScheduleSnapshot(program(), { period: PERIOD, versionId }),
  );
}

describe("generating a draft", () => {
  beforeEach(async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "07:00",
      endTime: "19:00",
      minStaff: 2,
    });
    await createCoverage(chief.context, {
      serviceId: fixture.services.Floor.id,
      scope: "weekday",
      daysOfWeek: [1, 2, 3, 4, 5],
      startTime: "07:00",
      endTime: "19:00",
      minStaff: 2,
    });
  });

  it("produces a draft the validator passes", async () => {
    const result = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });

    expect(result.feasible).toBe(true);
    expect(result.versionId).toBeTruthy();

    const validation = await validateDraft(result.versionId!);
    expect(
      validation.violations
        .filter((v) => v.kind === "hard")
        .map((v) => v.message),
    ).toEqual([]);
    expect(validation.summary.valid).toBe(true);
  });

  it("never touches the live schedule", async () => {
    const before = await query("SELECT id FROM shifts WHERE schedule_version_id IS NULL");
    const result = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });
    expect(result.feasible).toBe(true);

    const after = await query("SELECT id FROM shifts WHERE schedule_version_id IS NULL");
    expect(after).toHaveLength(before.length);

    const drafted = await query<{ id: string }>(
      "SELECT id FROM shifts WHERE schedule_version_id = $1",
      [result.versionId],
    );
    expect(drafted.length).toBeGreaterThan(0);
  });

  it("lands as a draft, not as something published", async () => {
    const result = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });
    const version = await queryOne<{ status: string }>(
      "SELECT status::text AS status FROM schedule_versions WHERE id = $1",
      [result.versionId],
    );
    expect(version?.status).toBe("draft");
  });

  it("gives every shift somebody, and nobody two places at once", async () => {
    const result = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });

    const rows = await query<{ start_datetime: Date; resident_id: string; service_id: string }>(
      `SELECT s.start_datetime, s.service_id, a.resident_id
         FROM shifts s
         JOIN shift_assignments a ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1`,
      [result.versionId],
    );
    expect(rows.length).toBe(result.report.demand.slots);

    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.resident_id}|${row.start_datetime.toISOString()}`;
      expect(seen.has(key), "somebody was scheduled twice at the same time").toBe(false);
      seen.add(key);
    }
  });

  it("reports coverage, fairness and the score", async () => {
    const result = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });
    const report = result.report;

    expect(report.coverage.length).toBe(2);
    for (const row of report.coverage) {
      expect(row.filled).toBe(row.required);
    }
    expect(report.fairness.length).toBe(3); // three training years
    expect(report.score.objectives.length).toBeGreaterThan(5);
    expect(report.demand.filled).toBe(report.demand.slots);
  });

  it("is deterministic across two runs against the same database", async () => {
    const first = await generateDraftSchedule(chief.context, {
      name: "One",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      seed: 5,
      timeBudgetMs: 0,
    });
    const second = await generateDraftSchedule(chief.context, {
      name: "Two",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      seed: 5,
      timeBudgetMs: 0,
    });

    const shape = (result: typeof first) =>
      result.assignments
        .map((a) => `${a.serviceId}|${a.start.toISOString()}|${a.residentId}`)
        .sort();
    expect(shape(second)).toEqual(shape(first));
  });

  it("improves the score when given a budget", async () => {
    /* Not "produces a better schedule than any other" — only that the search
       does something and that what it does is still legal. */
    const quick = await generateDraftSchedule(chief.context, {
      name: "Quick",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      seed: 3,
      timeBudgetMs: 0,
    });
    const searched = await generateDraftSchedule(chief.context, {
      name: "Searched",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      seed: 3,
      timeBudgetMs: 300,
    });

    expect(searched.report.score.score).toBeGreaterThanOrEqual(
      quick.report.score.score,
    );
    const validation = await validateDraft(searched.versionId!);
    expect(validation.summary.valid).toBe(true);
    expect(searched.report.iterations).toBeGreaterThan(0);
  });
});

describe("when it cannot be done", () => {
  it("writes nothing at all — not even the draft", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 20, // more people than the programme has
    });

    const versionsBefore = await query("SELECT id FROM schedule_versions");
    const result = await generateDraftSchedule(chief.context, {
      name: "Impossible",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });

    expect(result.feasible).toBe(false);
    expect(result.versionId).toBeNull();
    expect(result.assignments).toEqual([]);
    expect(result.report.relaxations.length).toBeGreaterThan(0);

    const versionsAfter = await query("SELECT id FROM schedule_versions");
    expect(versionsAfter).toHaveLength(versionsBefore.length);
    const orphans = await query("SELECT id FROM shifts WHERE schedule_version_id IS NOT NULL");
    expect(orphans).toEqual([]);
  });

  it("names what would have to give, in a sentence", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 6,
    });
    await query(
      `INSERT INTO rules (program_id, rule_type, name, params)
       VALUES ($1, 'max_consecutive_shifts', 'max_consecutive_shifts', '{"days":1}'::jsonb)`,
      [fixture.program.id],
    );
    // Everybody is a PGY-1 short of the mix, so the roster genuinely cannot do it.
    for (const resident of residents.slice(0, 9)) {
      await updateSchedulingData(chief.context, resident.resident.id, {
        schedulable: false,
      });
    }

    const result = await generateDraftSchedule(chief.context, {
      name: "Impossible",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });
    expect(result.feasible).toBe(false);
    for (const relaxation of result.report.relaxations) {
      expect(relaxation.message).toMatch(/[.!]$/);
      expect(relaxation.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });
});

describe("regenerating over locks", () => {
  beforeEach(async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 2,
    });
  });

  it("keeps locked shifts and rebuilds the rest into the same draft", async () => {
    const first = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      seed: 1,
      timeBudgetMs: 0,
    });
    expect(first.feasible).toBe(true);

    const rows = await query<{ id: string; resident_id: string }>(
      `SELECT s.id, a.resident_id FROM shifts s
         JOIN shift_assignments a ON a.shift_id = s.id AND a.assignment_status = 'active'
        WHERE s.schedule_version_id = $1
        ORDER BY s.start_datetime LIMIT 3`,
      [first.versionId],
    );
    expect(rows).toHaveLength(3);

    const second = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      seed: 77,
      timeBudgetMs: 0,
      versionId: first.versionId,
      locks: rows.map((row) => ({ kind: "assignment" as const, shiftId: row.id })),
    });

    expect(second.feasible).toBe(true);
    expect(second.versionId).toBe(first.versionId);

    // The locked rows are the same rows, with the same people on them.
    for (const row of rows) {
      const after = await queryOne<{ resident_id: string }>(
        `SELECT a.resident_id FROM shift_assignments a
          WHERE a.shift_id = $1 AND a.assignment_status = 'active'`,
        [row.id],
      );
      expect(after?.resident_id).toBe(row.resident_id);
    }

    const validation = await validateDraft(second.versionId!);
    expect(validation.summary.valid).toBe(true);
  });

  it("refuses to regenerate a schedule that has been published", async () => {
    const first = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });
    /* Published by hand rather than through `publishScheduleVersion`, which
       would also move the shifts. A CHECK constraint insists a published
       version records who published it and when, which is the schema saying
       the same thing this test is about. */
    await query(
      `UPDATE schedule_versions
          SET status = 'published', published_by = $2, published_at = now()
        WHERE id = $1`,
      [first.versionId, chief.context.user.id],
    );

    await expect(
      generateDraftSchedule(chief.context, {
        name: "September",
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        timeBudgetMs: 0,
        versionId: first.versionId,
      }),
    ).rejects.toThrow(/published/);
  });
});

describe("after a manual edit", () => {
  it("says what the edit broke, and nothing that was already broken", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 2,
    });
    const generated = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });

    const before = await loadScheduleSnapshot(program(), {
      period: PERIOD,
      versionId: generated.versionId,
    });

    // Take somebody off a shift by hand: the service is now short by one.
    const after = {
      ...before,
      assignments: before.assignments.map((assignment, index) =>
        index === 0 ? { ...assignment, residentId: null } : assignment,
      ),
    };

    const impact = assessEdit(before, after);
    expect(impact.safe).toBe(false);
    expect(impact.introduced.some((v) => v.constraintId === "coverage-minimum")).toBe(true);
    expect(impact.summary).toMatch(/created a problem|created \d+ problems/);
    // The month was valid before, so nothing is reported as pre-existing.
    expect(impact.resolved).toEqual([]);
  });

  it("says plainly when an edit broke nothing", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 2,
    });
    const generated = await generateDraftSchedule(chief.context, {
      name: "September",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      timeBudgetMs: 0,
    });
    const snapshot = await loadScheduleSnapshot(program(), {
      period: PERIOD,
      versionId: generated.versionId,
    });

    const impact = assessEdit(snapshot, snapshot);
    expect(impact.safe).toBe(true);
    expect(impact.introduced).toEqual([]);
    expect(impact.summary).toMatch(/broke nothing/);
  });
});

describe("comparing two drafts", () => {
  it("diffs one generated draft against another", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 2,
    });

    const a = await generateDraftSchedule(chief.context, {
      name: "Seed 1",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      seed: 1,
      timeBudgetMs: 200,
    });
    const b = await generateDraftSchedule(chief.context, {
      name: "Seed 2",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      seed: 2,
      timeBudgetMs: 200,
    });

    const diff = await diffScheduleVersion(
      fixture.program.id,
      b.versionId!,
      fixture.program.timezone,
      { againstVersionId: a.versionId },
    );

    /* The two drafts cover the same slots, so nothing is added or removed —
       only, possibly, held by different people. */
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged + diff.reassigned.length).toBe(
      a.report.demand.slots,
    );
  });
});
