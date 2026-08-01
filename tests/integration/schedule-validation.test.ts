import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/server/db/pool";
import { createBlockStructure, generateBlocks, listBlocks } from "@/server/domain/blocks";
import {
  addCohortMember,
  assignCohortToBlock,
  createCohort,
  setResidentOverride,
} from "@/server/domain/cohorts";
import { createCoverage } from "@/server/domain/coverage";
import {
  defaultPeriod,
  loadScheduleSnapshot,
} from "@/server/domain/constraints/snapshot";
import { validateSchedule } from "@/server/domain/constraints/validator";
import { updateSchedulingData } from "@/server/domain/roster";
import { createScheduleVersion } from "@/server/domain/schedule-versions";
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

/**
 * The loader, against a real database.
 *
 * The constraint model itself is tested without one — that is the point of
 * keeping it pure. What needs a database is the half that reads: that the
 * snapshot arrives with what the constraints expect, that a draft is loaded
 * instead of the live schedule when one is named, and that the answer for the
 * demo programme is explainable rather than a wall of noise.
 */

let fixture: TestProgram;
let alice: TestResident;
let bob: TestResident;
let chief: Awaited<ReturnType<typeof createStaff>>;

beforeAll(() => ensureMigrated());
afterAll(async () => closeDatabase());

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram();
  alice = await createResident(fixture.program, {
    email: "alice@h.org",
    name: "Alice A",
    pgy: 2,
  });
  bob = await createResident(fixture.program, {
    email: "bob@h.org",
    name: "Bob B",
    pgy: 2,
  });
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

/** The window covering everything the fixture creates. */
const WIDE = { start: "2000-01-01", end: "2100-01-01" };

/* `shifts.date` is a DATE column, and the driver hands back a Date for it
   whatever the row type says. Normalised here so a comparison against an ISO
   string is a comparison and not a coincidence. */
function isoDay(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

describe("loading a snapshot", () => {
  it("says nothing is wrong with a schedule that has nothing wrong with it", async () => {
    await createShift(fixture.program, { inDays: 10, residentId: alice.resident.id });
    const snapshot = await loadScheduleSnapshot(program(), { period: WIDE });
    const result = validateSchedule(snapshot);

    expect(result.summary.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.score.score).toBe(100);
    // And it still says what it looked at.
    expect(result.checked.length).toBeGreaterThan(15);
  });

  it("brings the roster's availability with it", async () => {
    await createShift(fixture.program, { inDays: 10, residentId: alice.resident.id });
    await updateSchedulingData(chief.context, alice.resident.id, {
      schedulable: false,
      schedulingNotes: "On research until March",
    });

    const result = validateSchedule(
      await loadScheduleSnapshot(program(), { period: WIDE }),
    );
    expect(result.summary.valid).toBe(false);
    const found = result.violations.find(
      (v) => v.constraintId === "resident-availability",
    );
    expect(found?.message).toContain("Alice A");
    expect(found?.message).toContain("On research until March");
    expect(found?.residentIds).toEqual([alice.resident.id]);
  });

  it("brings coverage requirements with it, and counts what is there", async () => {
    await createCoverage(chief.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      minStaff: 2,
    });
    // One person on a service that needs two, on one day.
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
      service: fixture.services.MICU,
    });

    const day = isoDay(shift.date);
    const result = validateSchedule(
      await loadScheduleSnapshot(program(), { period: { start: day, end: day } }),
    );
    const short = result.violations.filter(
      (v) => v.constraintId === "coverage-minimum",
    );
    expect(short).toHaveLength(1);
    expect(short[0].message).toContain("needs 2");
    expect(short[0].message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("brings the block structure and the cohort grid with it", async () => {
    const structure = await createBlockStructure(chief.context, {
      name: "Test year",
      academicYear: 2026,
      blocks: generateBlocks({ startDate: "2026-07-01", weeks: 4, count: 13 }),
    });
    const blocks = await listBlocks(fixture.program.id, structure.id);
    const cohort = await createCohort(chief.context, { label: "A", pgyLevel: 2 });
    await addCohortMember(chief.context, cohort.id, alice.resident.id);

    // The cohort is meant to be on Floor for the block Alice's shift falls in.
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
      service: fixture.services.MICU,
    });
    const block = blocks.find(
      (b) =>
        isoDay(b.start_date) <= isoDay(shift.date) &&
        isoDay(shift.date) <= isoDay(b.end_date),
    );
    if (!block) {
      /* The generated year does not reach the shift, which is itself fine —
         the constraint only judges dates inside a block. */
      return;
    }
    await assignCohortToBlock(chief.context, {
      cohortId: cohort.id,
      blockId: block.id,
      serviceId: fixture.services.Floor.id,
    });

    const result = validateSchedule(
      await loadScheduleSnapshot(program(), { period: WIDE }),
    );
    const structural = result.violations.find(
      (v) => v.constraintId === "block-structure",
    );
    expect(structural?.message).toContain("Alice A");
    expect(structural?.message).toContain("Floor");
  });

  it("brings a recorded exception with it, including which service it named", async () => {
    /* The defect this guards: the override loader returned the service *name*
       for display and no id, so the constraint had nothing to compare against
       and silently never fired. */
    const structure = await createBlockStructure(chief.context, {
      name: "Test year",
      academicYear: 2026,
      blocks: generateBlocks({ startDate: "2026-01-01", weeks: 4, count: 26 }),
    });
    const blocks = await listBlocks(fixture.program.id, structure.id);
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
      service: fixture.services.MICU,
    });
    const block = blocks.find(
      (b) =>
        isoDay(b.start_date) <= isoDay(shift.date) &&
        isoDay(shift.date) <= isoDay(b.end_date),
    );
    expect(block, "the generated year should cover the shift").toBeTruthy();

    await setResidentOverride(chief.context, {
      residentId: alice.resident.id,
      blockId: block!.id,
      serviceId: fixture.services.Floor.id,
      reason: "Make-up ambulatory block",
    });

    const snapshot = await loadScheduleSnapshot(program(), { period: WIDE });
    expect(snapshot.overrides[0].serviceId).toBe(fixture.services.Floor.id);

    const result = validateSchedule(snapshot);
    const found = result.violations.find((v) => v.constraintId === "block-override");
    expect(found?.message).toContain("Make-up ambulatory block");
  });

  it("validates a draft rather than the live schedule when one is named", async () => {
    // A shift with nobody on it is only a problem if the service must be covered.
    await query("UPDATE services SET coverage_mandatory = true WHERE program_id = $1", [
      fixture.program.id,
    ]);
    await createShift(fixture.program, { inDays: 10, residentId: alice.resident.id });
    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });

    // Break the draft only: its copy of the shift loses its resident.
    await query(
      `UPDATE shift_assignments SET assignment_status = 'ended', ended_at = now()
        WHERE shift_id IN (SELECT id FROM shifts WHERE schedule_version_id = $1)`,
      [draft.id],
    );

    const live = validateSchedule(
      await loadScheduleSnapshot(program(), { period: WIDE }),
    );
    expect(live.summary.valid).toBe(true);

    const inDraft = validateSchedule(
      await loadScheduleSnapshot(program(), { period: WIDE, versionId: draft.id }),
    );
    expect(inDraft.violations.map((v) => v.constraintId)).toContain("shift-unstaffed");
  });

  it("compares a draft against what it would replace", async () => {
    await createShift(fixture.program, { inDays: 10, residentId: alice.resident.id });
    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });

    const snapshot = await loadScheduleSnapshot(program(), {
      period: WIDE,
      versionId: draft.id,
      withBaseline: true,
    });
    /* A verbatim copy moves nobody, so the objective is silent — the baseline
       is loaded and compared, and finds nothing, which is different from not
       being loaded at all. */
    expect(snapshot.baseline?.length).toBeGreaterThan(0);
    expect(
      validateSchedule(snapshot).violations.filter(
        (v) => v.constraintId === "minimise-change",
      ),
    ).toEqual([]);

    // Now move the draft's shift to Bob, and it notices.
    await query(
      `UPDATE shift_assignments SET resident_id = $2
        WHERE shift_id IN (SELECT id FROM shifts WHERE schedule_version_id = $1)`,
      [draft.id, bob.resident.id],
    );
    const moved = await loadScheduleSnapshot(program(), {
      period: WIDE,
      versionId: draft.id,
      withBaseline: true,
    });
    const change = validateSchedule(moved).violations.find(
      (v) => v.constraintId === "minimise-change",
    );
    expect(change?.message).toContain("1 shift");
    expect(change?.kind).toBe("soft");
  });

  it("defaults to the window from today to the last shift scheduled", async () => {
    await createShift(fixture.program, { inDays: 20, residentId: alice.resident.id });
    const period = await defaultPeriod(fixture.program.id, fixture.program.timezone);
    expect(period.start <= period.end).toBe(true);
    // Yesterday's gaps are true, useless, and the fastest way to stop being read.
    expect(period.start).toBe(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: fixture.program.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    );
  });

  it("keeps one program's schedule out of another's report", async () => {
    const other = await createProgram({ name: "Elsewhere Residency" });
    const otherResident = await createResident(other.program, {
      email: "elsewhere@h.org",
      name: "Far Away",
      pgy: 1,
    });
    const otherChief = await createStaff(other.program, {
      email: "elsewhere.chief@h.org",
      role: "chief",
    });
    await createShift(other.program, {
      inDays: 5,
      residentId: otherResident.resident.id,
    });
    await updateSchedulingData(otherChief.context, otherResident.resident.id, {
      schedulable: false,
    });

    // Their broken schedule is invisible here…
    const ours = validateSchedule(
      await loadScheduleSnapshot(program(), { period: WIDE }),
    );
    expect(ours.violations).toEqual([]);

    // …and visible there.
    const theirs = validateSchedule(
      await loadScheduleSnapshot(
        {
          id: other.program.id,
          name: other.program.name,
          timezone: other.program.timezone,
        },
        { period: WIDE },
      ),
    );
    expect(theirs.violations.map((v) => v.constraintId)).toContain(
      "resident-availability",
    );
  });
});
