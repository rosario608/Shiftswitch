import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import { createBlockStructure, generateBlocks, listBlocks } from "@/server/domain/blocks";
import { createRule, listRulesForService } from "@/server/domain/admin";
import {
  addCohortMember,
  assignCohortToBlock,
  clearResidentOverride,
  createCohort,
  deleteCohort,
  listCohorts,
  listResidentOverrides,
  setResidentOverride,
  updateCohort,
} from "@/server/domain/cohorts";
import { createCoverage, listCoverage, listCoverageProblems } from "@/server/domain/coverage";
import {
  createSite,
  listRoster,
  listSiteEligibility,
  setSiteEligibility,
  updateSchedulingData,
} from "@/server/domain/roster";
import {
  assignDraftShift,
  createScheduleVersion,
  diffScheduleVersion,
  discardScheduleVersion,
  listDraftShifts,
  publishScheduleVersion,
  removeDraftShift,
} from "@/server/domain/schedule-versions";
import { applyServiceTemplate } from "@/server/domain/service-templates";
import { loadSchedulerSnapshot } from "@/server/domain/scheduler-dashboard";
import { postShiftForTrade } from "@/server/domain/trades";
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

let fixture: TestProgram;
let alice: TestResident;
let bob: TestResident;
let chief: Awaited<ReturnType<typeof createStaff>>;
let admin: Awaited<ReturnType<typeof createStaff>>;

beforeAll(() => ensureMigrated());
afterAll(async () => closeDatabase());

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram();
  alice = await createResident(fixture.program, { email: "alice@h.org", name: "Alice A", pgy: 2 });
  bob = await createResident(fixture.program, { email: "bob@h.org", name: "Bob B", pgy: 2 });
  chief = await createStaff(fixture.program, { email: "chief@h.org", role: "chief", name: "Casey Chief" });
  admin = await createStaff(fixture.program, { email: "admin@h.org", role: "admin", name: "Ada Admin" });
});

describe("service configuration and coverage", () => {
  it("records coverage that varies by weekday, weekend, date and period", async () => {
    const serviceId = fixture.services.MICU.id;
    for (const input of [
      { scope: "weekday" as const, label: "Weekdays", daysOfWeek: [1, 2, 3, 4, 5], minStaff: 2 },
      { scope: "weekday" as const, label: "Weekend", daysOfWeek: [0, 6], minStaff: 1 },
      {
        scope: "date" as const,
        label: "Christmas",
        specificDate: "2026-12-25",
        minStaff: 1,
      },
      {
        scope: "period" as const,
        label: "Holiday block",
        periodStart: "2026-12-24",
        periodEnd: "2027-01-01",
        minStaff: 1,
      },
    ]) {
      await createCoverage(admin.context, { serviceId, ...input });
    }

    const requirements = await listCoverage(fixture.program.id, { serviceId });
    expect(requirements).toHaveLength(4);
    // Ordered most-specific first, so a caller taking the first match is right.
    expect(requirements[0].scope).toBe("date");
    expect(requirements[1].scope).toBe("period");
  });

  it("refuses a PGY mix no schedule could satisfy", async () => {
    await expect(
      createCoverage(admin.context, {
        serviceId: fixture.services.MICU.id,
        scope: "weekday",
        daysOfWeek: [1],
        minStaff: 1,
        maxStaff: 2,
        pgyMix: [
          { pgy: 1, min: 2, max: null },
          { pgy: 2, min: 2, max: null },
        ],
      }),
    ).rejects.toThrow(/requires 4 people but the service is capped at 2/);
  });

  it("surfaces a mandatory service whose coverage asks for nobody", async () => {
    await query("UPDATE services SET coverage_mandatory = true WHERE id = $1", [
      fixture.services.MICU.id,
    ]);
    await createCoverage(admin.context, {
      serviceId: fixture.services.MICU.id,
      scope: "weekday",
      daysOfWeek: [1],
      minStaff: 0,
    });
    const problems = await listCoverageProblems(fixture.program.id);
    expect(problems.map((p) => p.problem).join(" ")).toMatch(/asks for nobody/);
  });

  it("will not attach coverage to another program's service", async () => {
    const other = await createProgram({ name: "Other Residency" });
    await expect(
      createCoverage(admin.context, {
        serviceId: other.services.MICU.id,
        scope: "weekday",
        daysOfWeek: [1],
        minStaff: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("the service template", () => {
  it("creates sites, services and their coverage in one go", async () => {
    const result = await applyServiceTemplate(admin.context, "duke-internal-medicine");
    expect(result.sitesCreated).toBe(3);
    expect(result.servicesCreated).toBeGreaterThan(10);
    expect(result.coverageCreated).toBeGreaterThan(10);

    const wards = await queryOne<{ id: string; site_id: string; source_template: string }>(
      "SELECT id, site_id, source_template FROM services WHERE program_id = $1 AND name = $2",
      [fixture.program.id, "General Medicine Wards"],
    );
    expect(wards?.site_id).toBeTruthy();
    expect(wards?.source_template).toBe("duke-internal-medicine");
  });

  it("skips what already exists rather than overwriting somebody's work", async () => {
    await query("UPDATE services SET name = 'Cardiology' WHERE id = $1", [
      fixture.services.Floor.id,
    ]);
    const result = await applyServiceTemplate(admin.context, "duke-internal-medicine");
    expect(result.servicesSkipped).toContain("Cardiology");

    // The pre-existing one is untouched: still no template attribution.
    const kept = await queryOne<{ source_template: string }>(
      "SELECT source_template FROM services WHERE id = $1",
      [fixture.services.Floor.id],
    );
    expect(kept?.source_template).toBe("");
  });

  it("is safe to apply twice", async () => {
    await applyServiceTemplate(admin.context, "duke-internal-medicine");
    const second = await applyServiceTemplate(admin.context, "duke-internal-medicine");
    expect(second.servicesCreated).toBe(0);
    expect(second.sitesCreated).toBe(0);
    expect(second.servicesSkipped.length).toBeGreaterThan(10);
  });
});

describe("cohorts and blocks", () => {
  async function year() {
    return createBlockStructure(chief.context, {
      name: "2026–27",
      academicYear: 2026,
      blocks: generateBlocks({
        startDate: "2026-07-01",
        weeks: 4,
        count: 13,
        kinds: ["Inpatient", "Ambulatory"],
      }),
    });
  }

  it("builds a 4+4 year and a two-week year from the same code path", async () => {
    const fourPlusFour = await year();
    expect(fourPlusFour.block_count).toBe(13);

    const fortnightly = await createBlockStructure(chief.context, {
      name: "Two-week programme",
      academicYear: 2026,
      blocks: generateBlocks({ startDate: "2026-07-01", weeks: 2, count: 26 }),
    });
    expect(fortnightly.block_count).toBe(26);
  });

  it("keeps pairing reciprocal in both directions", async () => {
    const a = await createCohort(chief.context, { label: "PGY-2 A", pgyLevel: 2 });
    const b = await createCohort(chief.context, {
      label: "PGY-2 B",
      pgyLevel: 2,
      pairedCohortId: a.id,
    });

    const cohorts = await listCohorts(fixture.program.id);
    const byId = new Map(cohorts.map((cohort) => [cohort.id, cohort]));
    expect(byId.get(a.id)?.paired_cohort_id).toBe(b.id);
    expect(byId.get(b.id)?.paired_cohort_id).toBe(a.id);
  });

  it("releases the old partner when a cohort is re-paired", async () => {
    const a = await createCohort(chief.context, { label: "A", pgyLevel: 2 });
    const b = await createCohort(chief.context, { label: "B", pgyLevel: 2, pairedCohortId: a.id });
    const c = await createCohort(chief.context, { label: "C", pgyLevel: 2 });

    await updateCohort(chief.context, a.id, { pairedCohortId: c.id });

    const byId = new Map(
      (await listCohorts(fixture.program.id)).map((cohort) => [cohort.id, cohort]),
    );
    expect(byId.get(a.id)?.paired_cohort_id).toBe(c.id);
    expect(byId.get(c.id)?.paired_cohort_id).toBe(a.id);
    // B is not left pointing at a partner that has moved on.
    expect(byId.get(b.id)?.paired_cohort_id).toBeNull();
  });

  it("refuses a resident whose PGY does not match the cohort", async () => {
    const pgy1 = await createResident(fixture.program, { email: "intern@h.org", name: "Ivy I", pgy: 1 });
    const cohort = await createCohort(chief.context, { label: "PGY-2 A", pgyLevel: 2 });
    await expect(
      addCohortMember(chief.context, cohort.id, pgy1.resident.id),
    ).rejects.toThrow(/is PGY-1 and "PGY-2 A" is a PGY-2 cohort/);
  });

  it("refuses to put one resident in two cohorts", async () => {
    const a = await createCohort(chief.context, { label: "A", pgyLevel: 2 });
    const b = await createCohort(chief.context, { label: "B", pgyLevel: 2 });
    await addCohortMember(chief.context, a.id, alice.resident.id);
    await expect(addCohortMember(chief.context, b.id, alice.resident.id)).rejects.toThrow(
      /already in "A"/,
    );
  });

  it("refuses to delete a cohort that is assigned to blocks", async () => {
    const structure = await year();
    const blocks = await listBlocks(fixture.program.id, structure.id);
    const cohort = await createCohort(chief.context, { label: "A", pgyLevel: 2 });
    await assignCohortToBlock(chief.context, {
      cohortId: cohort.id,
      blockId: blocks[0].id,
      serviceId: fixture.services.MICU.id,
    });
    await expect(deleteCohort(chief.context, cohort.id)).rejects.toThrow(/assigned to 1 block/);
  });

  it("records an individual override, and insists on a reason", async () => {
    const structure = await year();
    const blocks = await listBlocks(fixture.program.id, structure.id);

    await expect(
      setResidentOverride(chief.context, {
        residentId: alice.resident.id,
        blockId: blocks[0].id,
        serviceId: fixture.services.Floor.id,
        reason: "   ",
      }),
    ).rejects.toThrow(/Give a reason/);

    await setResidentOverride(chief.context, {
      residentId: alice.resident.id,
      blockId: blocks[0].id,
      serviceId: fixture.services.Floor.id,
      reason: "Swapped for a research month.",
    });
    const stored = await queryOne<{ reason: string }>(
      "SELECT reason FROM resident_block_overrides WHERE resident_id = $1",
      [alice.resident.id],
    );
    expect(stored?.reason).toBe("Swapped for a research month.");
  });

  it("lists overrides for the year, and can take one back", async () => {
    const structure = await year();
    const blocks = await listBlocks(fixture.program.id, structure.id);
    await setResidentOverride(chief.context, {
      residentId: alice.resident.id,
      blockId: blocks[0].id,
      serviceId: fixture.services.Floor.id,
      reason: "Make-up block.",
    });

    const listed = await listResidentOverrides(fixture.program.id, structure.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].resident_name).toBe("Alice A");
    expect(listed[0].block_label).toBe(blocks[0].label);

    /* An override that cannot be removed is a trap: the first one entered by
       mistake would sit in the year forever. */
    await clearResidentOverride(chief.context, alice.resident.id, blocks[0].id);
    expect(await listResidentOverrides(fixture.program.id, structure.id)).toHaveLength(0);
    await expect(
      clearResidentOverride(chief.context, alice.resident.id, blocks[0].id),
    ).rejects.toThrow(/no longer exists/);
  });
});

describe("resident scheduling data", () => {
  it("normalises a phone number on the way in", async () => {
    await updateSchedulingData(chief.context, alice.resident.id, {
      phone: "(919) 555-0142",
    });
    const stored = await queryOne<{ phone: string }>(
      "SELECT phone FROM residents WHERE id = $1",
      [alice.resident.id],
    );
    expect(stored?.phone).toBe("+19195550142");
  });

  it("shows the phone to a chief and withholds it from a resident", async () => {
    await updateSchedulingData(chief.context, alice.resident.id, { phone: "9195550142" });

    const asChief = await listRoster(chief.context);
    expect(asChief.find((r) => r.id === alice.resident.id)?.phone).toBe("+19195550142");

    /* The column is not selected at all for a role without the capability, so
       the payload cannot leak it even to a client that inspects the response. */
    const asResident = await listRoster(alice.context);
    expect(asResident.find((r) => r.id === alice.resident.id)?.phone).toBeNull();
  });

  it("separates leaving the program from being unavailable", async () => {
    await updateSchedulingData(chief.context, alice.resident.id, {
      schedulable: false,
      schedulingNotes: "Parental leave until March.",
    });
    const roster = await listRoster(chief.context);
    const record = roster.find((r) => r.id === alice.resident.id)!;
    // Still on the roster, still active — just not schedulable.
    expect(record.active).toBe(true);
    expect(record.schedulable).toBe(false);
  });

  it("refuses a PGY change that would strand somebody in the wrong cohort", async () => {
    const cohort = await createCohort(chief.context, { label: "PGY-2 A", pgyLevel: 2 });
    await addCohortMember(chief.context, cohort.id, alice.resident.id);
    await expect(
      updateSchedulingData(chief.context, alice.resident.id, { pgyLevel: 3 }),
    ).rejects.toThrow(/Remove them from it before changing their training level/);
  });

  it("treats an unrecorded site as eligible rather than forbidden", async () => {
    const site = await createSite(admin.context, { name: "The VA" });
    const before = await listSiteEligibility(fixture.program.id, alice.resident.id);
    expect(before.find((entry) => entry.site_id === site.id)?.eligible).toBe(true);

    await setSiteEligibility(chief.context, alice.resident.id, site.id, false, "No badge yet");
    const after = await listSiteEligibility(fixture.program.id, alice.resident.id);
    expect(after.find((entry) => entry.site_id === site.id)?.eligible).toBe(false);
  });

  it("never writes the phone number into the audit log", async () => {
    await updateSchedulingData(chief.context, alice.resident.id, { phone: "9195550142" });
    const entries = await query<{ new_state: unknown }>(
      "SELECT new_state FROM audit_logs WHERE action = 'resident.scheduling_updated'",
    );
    expect(JSON.stringify(entries)).not.toContain("9195550142");
    expect(JSON.stringify(entries)).toContain("phoneChanged");
  });
});

describe("draft and published schedules", () => {
  async function liveShift(inDays: number, residentId: string) {
    return createShift(fixture.program, { inDays, residentId });
  }

  it("keeps a draft invisible to the live schedule", async () => {
    await liveShift(10, alice.resident.id);
    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });
    expect(draft.shift_count).toBe(1);

    // The live schedule still has exactly one shift; the draft's copy is not it.
    const live = await query<{ id: string }>(
      "SELECT id FROM shifts WHERE program_id = $1 AND schedule_version_id IS NULL",
      [fixture.program.id],
    );
    expect(live).toHaveLength(1);
  });

  it("copies assignments one-to-one when several people work the same slot", async () => {
    /* The bug this guards: matching draft to live by service and time alone
       cross-joins when a service has several people on at once, and every draft
       shift ends up with every assignee. */
    const service = fixture.services.MICU;
    const start = new Date();
    start.setDate(start.getDate() + 10);
    for (const resident of [alice, bob]) {
      await createShift(fixture.program, {
        inDays: 10,
        residentId: resident.resident.id,
        service,
      });
    }

    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });
    expect(draft.shift_count).toBe(2);

    const perShift = await query<{ shift_id: string; count: string }>(
      `SELECT a.shift_id, count(*)::text AS count
         FROM shift_assignments a
         JOIN shifts s ON s.id = a.shift_id
        WHERE s.schedule_version_id = $1
        GROUP BY a.shift_id`,
      [draft.id],
    );
    expect(perShift).toHaveLength(2);
    for (const row of perShift) expect(row.count).toBe("1");
  });

  it("reports no change at all for a verbatim copy", async () => {
    /* The defect this guards, found by opening the demo: pairing draft shifts
       to live ones arbitrarily within a same-time group and comparing assignees
       reported a reassignment whenever the two orderings differed. A fortnight
       copied verbatim came back as 164 phantom reassignments. A diff that cries
       wolf on an unchanged copy is worse than no diff — it is the screen a
       scheduler consults to decide whether publishing is safe. */
    const service = fixture.services.MICU;
    for (const resident of [alice, bob]) {
      await createShift(fixture.program, {
        inDays: 10,
        residentId: resident.resident.id,
        service,
      });
    }
    const third = await createResident(fixture.program, {
      email: "cara@h.org",
      name: "Cara C",
      pgy: 2,
    });
    await createShift(fixture.program, {
      inDays: 10,
      residentId: third.resident.id,
      service,
    });

    const draft = await createScheduleVersion(chief.context, {
      name: "Verbatim",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });

    const diff = await diffScheduleVersion(fixture.program.id, draft.id, "America/New_York");
    expect(diff.reassigned).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(3);
  });

  it("still reports a genuine reassignment within a busy slot", async () => {
    // The same-resident pass must not hide a real change.
    const service = fixture.services.MICU;
    for (const resident of [alice, bob]) {
      await createShift(fixture.program, {
        inDays: 10,
        residentId: resident.resident.id,
        service,
      });
    }
    const draft = await createScheduleVersion(chief.context, {
      name: "One moved",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });
    const carol = await createResident(fixture.program, {
      email: "carol2@h.org",
      name: "Carol D",
      pgy: 2,
    });
    const draftShifts = await query<{ id: string }>(
      "SELECT id FROM shifts WHERE schedule_version_id = $1 ORDER BY id",
      [draft.id],
    );
    await query("UPDATE shift_assignments SET resident_id = $2 WHERE shift_id = $1", [
      draftShifts[0].id,
      carol.resident.id,
    ]);

    const diff = await diffScheduleVersion(fixture.program.id, draft.id, "America/New_York");
    expect(diff.reassigned).toHaveLength(1);
    expect(diff.reassigned[0].to).toBe("Carol D");
    expect(diff.unchanged).toBe(1);
  });

  it("reports what publishing would change", async () => {
    const kept = await liveShift(10, alice.resident.id);
    await liveShift(11, alice.resident.id);

    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });

    // Remove one copied shift and reassign another.
    const draftShifts = await query<{ id: string; start_datetime: Date }>(
      "SELECT id, start_datetime FROM shifts WHERE schedule_version_id = $1 ORDER BY start_datetime",
      [draft.id],
    );
    await query("DELETE FROM shifts WHERE id = $1", [draftShifts[1].id]);
    await query("UPDATE shift_assignments SET resident_id = $2 WHERE shift_id = $1", [
      draftShifts[0].id,
      bob.resident.id,
    ]);
    /* And add one that does not exist live. Moved by id, not by date: the
       shift's `date` is the program's local date, and matching it against a
       UTC date computed here silently selects nothing for the hours either
       side of midnight — which made this test pass or fail depending on the
       time of day it ran. */
    const extra = await createShift(fixture.program, {
      inDays: 12,
      residentId: bob.resident.id,
    });
    await query("UPDATE shifts SET schedule_version_id = $1 WHERE id = $2", [
      draft.id,
      extra.id,
    ]);

    const diff = await diffScheduleVersion(fixture.program.id, draft.id, "America/New_York");
    expect(diff.reassigned).toHaveLength(1);
    expect(diff.reassigned[0].from).toBe("Alice A");
    expect(diff.reassigned[0].to).toBe("Bob B");
    expect(diff.removed).toHaveLength(1);
    expect(diff.added).toHaveLength(1);
    expect(kept.id).toBeTruthy();
  });

  it("publishes only inside its own window", async () => {
    const inside = await liveShift(5, alice.resident.id);
    const outside = await liveShift(60, alice.resident.id);

    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 30);
    const draft = await createScheduleVersion(chief.context, {
      name: "Next month",
      periodStart: from.toISOString().slice(0, 10),
      periodEnd: to.toISOString().slice(0, 10),
    });

    await publishScheduleVersion(chief.context, draft.id);

    // The in-window shift was replaced by an empty draft; the far one survives.
    const survivors = await query<{ id: string }>(
      "SELECT id FROM shifts WHERE program_id = $1 AND schedule_version_id IS NULL",
      [fixture.program.id],
    );
    expect(survivors.map((row) => row.id)).toEqual([outside.id]);
    expect(inside.id).toBeTruthy();
  });

  it("refuses to publish over a live switch, and names who is involved", async () => {
    const shift = await liveShift(10, alice.resident.id);
    await createShift(fixture.program, { inDays: 17, residentId: bob.resident.id });
    await postShiftForTrade(alice.context, { shiftId: shift.id });

    const to = new Date();
    to.setDate(to.getDate() + 30);
    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: new Date().toISOString().slice(0, 10),
      periodEnd: to.toISOString().slice(0, 10),
    });

    await expect(publishScheduleVersion(chief.context, draft.id)).rejects.toThrow(
      /part of a live switch involving Alice A/,
    );

    // The override exists, is deliberate, and is recorded.
    await publishScheduleVersion(chief.context, draft.id, { force: true });
    const audit = await queryOne<{ reason: string }>(
      "SELECT reason FROM audit_logs WHERE action = 'schedule_version.published'",
    );
    expect(audit?.reason).toMatch(/override/i);
  });

  it("will not let a draft shift be posted for trade", async () => {
    /* Enforced by a database trigger rather than a query filter, because a
       filter is something a future query can forget. */
    await liveShift(10, alice.resident.id);
    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });
    const draftShift = await queryOne<{ id: string }>(
      "SELECT id FROM shifts WHERE schedule_version_id = $1",
      [draft.id],
    );

    await expect(
      postShiftForTrade(alice.context, { shiftId: draftShift!.id }),
    ).rejects.toThrow(/unpublished draft/);
  });

  it("refuses to discard a published schedule", async () => {
    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    await publishScheduleVersion(chief.context, draft.id);
    await expect(discardScheduleVersion(chief.context, draft.id)).rejects.toThrow(
      /residents are working it/,
    );
  });

  it("takes the draft's shifts with it when discarded", async () => {
    await liveShift(10, alice.resident.id);
    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });
    await discardScheduleVersion(chief.context, draft.id);

    const orphans = await query<{ id: string }>(
      "SELECT id FROM shifts WHERE schedule_version_id IS NOT NULL",
    );
    expect(orphans).toHaveLength(0);
    // The live schedule is untouched.
    const live = await query<{ id: string }>(
      "SELECT id FROM shifts WHERE program_id = $1 AND schedule_version_id IS NULL",
      [fixture.program.id],
    );
    expect(live).toHaveLength(1);
  });
});

describe("editing a draft", () => {
  async function draftWithOneShift() {
    await createShift(fixture.program, { inDays: 10, residentId: alice.resident.id });
    const draft = await createScheduleVersion(chief.context, {
      name: "Draft",
      periodStart: "2000-01-01",
      periodEnd: "2100-01-01",
      copyFromPublished: true,
    });
    const shifts = await listDraftShifts(fixture.program.id, draft.id);
    return { draft, shift: shifts[0] };
  }

  it("lists the draft's shifts with who is on them", async () => {
    const { shift } = await draftWithOneShift();
    expect(shift.resident_id).toBe(alice.resident.id);
    expect(shift.resident_name).toBe("Alice A");
  });

  it("reassigns a draft shift without touching the live one", async () => {
    const { draft, shift } = await draftWithOneShift();
    await assignDraftShift(chief.context, draft.id, shift.id, bob.resident.id);

    const after = await listDraftShifts(fixture.program.id, draft.id);
    expect(after[0].resident_id).toBe(bob.resident.id);

    // Alice still holds the live shift. Nothing residents can see has moved.
    const live = await query<{ resident_id: string }>(
      `SELECT a.resident_id FROM shift_assignments a
         JOIN shifts s ON s.id = a.shift_id
        WHERE s.schedule_version_id IS NULL AND a.assignment_status = 'active'`,
    );
    expect(live).toHaveLength(1);
    expect(live[0].resident_id).toBe(alice.resident.id);
  });

  it("clears a draft shift, which is a legitimate state to leave it in", async () => {
    const { draft, shift } = await draftWithOneShift();
    await assignDraftShift(chief.context, draft.id, shift.id, null);
    const after = await listDraftShifts(fixture.program.id, draft.id);
    expect(after[0].resident_id).toBeNull();

    // Exactly one assignment row, ended — not deleted, so the history survives.
    const rows = await query<{ assignment_status: string }>(
      "SELECT assignment_status FROM shift_assignments WHERE shift_id = $1",
      [shift.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].assignment_status).toBe("ended");
  });

  it("refuses to assign somebody who is not available to schedule", async () => {
    const { draft, shift } = await draftWithOneShift();
    await updateSchedulingData(chief.context, bob.resident.id, { schedulable: false });
    await expect(
      assignDraftShift(chief.context, draft.id, shift.id, bob.resident.id),
    ).rejects.toThrow(/Bob B is marked as not available to schedule/);
  });

  it("removes a shift from the draft and leaves the live schedule alone", async () => {
    const { draft, shift } = await draftWithOneShift();
    await removeDraftShift(chief.context, draft.id, shift.id);
    expect(await listDraftShifts(fixture.program.id, draft.id)).toHaveLength(0);

    const live = await query<{ id: string }>(
      "SELECT id FROM shifts WHERE program_id = $1 AND schedule_version_id IS NULL",
      [fixture.program.id],
    );
    expect(live).toHaveLength(1);
  });

  it("is not a back door into the live schedule", async () => {
    /* The defect this guards: pointing the draft editor at a published shift
       and having it edit the schedule residents are working. Both verbs must
       refuse, and refuse identically, so the shape of the error cannot be used
       to find out whether a shift exists. */
    const { draft } = await draftWithOneShift();
    const liveShiftId = (await queryOne<{ id: string }>(
      "SELECT id FROM shifts WHERE program_id = $1 AND schedule_version_id IS NULL",
      [fixture.program.id],
    ))!.id;

    await expect(
      assignDraftShift(chief.context, draft.id, liveShiftId, bob.resident.id),
    ).rejects.toThrow(/not part of this draft/);
    await expect(
      removeDraftShift(chief.context, draft.id, liveShiftId),
    ).rejects.toThrow(/not part of this draft/);
  });

  it("stops editing a schedule once it is published", async () => {
    /* Publishing detaches the version's shifts — they become the live
       schedule — so afterwards the draft has none, and both verbs refuse for
       that reason. What matters is that neither of them reaches a shift a
       resident is now working. */
    const { draft, shift } = await draftWithOneShift();
    await publishScheduleVersion(chief.context, draft.id);
    expect(await listDraftShifts(fixture.program.id, draft.id)).toHaveLength(0);

    await expect(
      assignDraftShift(chief.context, draft.id, shift.id, bob.resident.id),
    ).rejects.toThrow(/not part of this draft/);
    await expect(removeDraftShift(chief.context, draft.id, shift.id)).rejects.toThrow(
      /not part of this draft, or the draft has been published/,
    );

    // The published shift still belongs to whoever it was assigned to.
    const live = await queryOne<{ resident_id: string }>(
      `SELECT a.resident_id FROM shift_assignments a
        WHERE a.shift_id = $1 AND a.assignment_status = 'active'`,
      [shift.id],
    );
    expect(live?.resident_id).toBe(alice.resident.id);
  });

  it("refuses a draft belonging to another program", async () => {
    const other = await createProgram({ name: "Elsewhere Residency" });
    const otherChief = await createStaff(other.program, {
      email: "elsewhere@h.org",
      role: "chief",
    });
    const { draft, shift } = await draftWithOneShift();
    await expect(
      assignDraftShift(otherChief.context, draft.id, shift.id, alice.resident.id),
    ).rejects.toThrow(/not part of this draft/);
  });
});

describe("rules that apply to a service", () => {
  it("includes program-wide rules alongside the service's own", async () => {
    const micu = fixture.services.MICU.id;
    await createRule(chief.context, {
      ruleType: "max_consecutive_shifts",
      name: "No more than six in a row",
      description: "",
      params: { days: 6 },
      severity: "error",
      scope: "program",
      scopeId: null,
      overridable: false,
      active: true,
    });
    await createRule(chief.context, {
      ruleType: "approval_required",
      name: "MICU switches need a chief",
      description: "",
      params: {},
      severity: "warning",
      scope: "service",
      scopeId: micu,
      overridable: true,
      active: true,
    });

    const applicable = await listRulesForService(fixture.program.id, micu);
    expect(applicable.map((rule) => rule.name).sort()).toEqual([
      "MICU switches need a chief",
      "No more than six in a row",
    ]);
    // Service-specific first: it is the one that is not obvious from elsewhere.
    expect(applicable[0].scope).toBe("service");
  });

  it("leaves out another service's rules, and inactive ones", async () => {
    const micu = fixture.services.MICU.id;
    await createRule(chief.context, {
      ruleType: "approval_required",
      name: "Floor only",
      description: "",
      params: {},
      severity: "warning",
      scope: "service",
      scopeId: fixture.services.Floor.id,
      overridable: true,
      active: true,
    });
    await createRule(chief.context, {
      ruleType: "approval_required",
      name: "Switched off",
      description: "",
      params: {},
      severity: "warning",
      scope: "service",
      scopeId: micu,
      overridable: true,
      active: false,
    });

    expect(await listRulesForService(fixture.program.id, micu)).toHaveLength(0);
  });
});

describe("who may plan a schedule", () => {
  it("lets a chief plan, and refuses a resident", async () => {
    const cohort = await createCohort(chief.context, { label: "A", pgyLevel: 2 });
    expect(cohort.label).toBe("A");

    /* Authorization lives in `requireCapability` at the route, so the domain is
       exercised directly here; what this asserts is that the *matrix* gives a
       chief scheduling.plan and a resident nothing. */
    const { can } = await import("@/server/auth/roles");
    expect(can("chief", "scheduling.plan")).toBe(true);
    expect(can("resident", "scheduling.plan")).toBe(false);
    expect(can("resident", "residents.contact_info")).toBe(false);
    for (const role of ["chief", "apd", "pd", "admin"] as const) {
      expect(can(role, "scheduling.plan"), role).toBe(true);
      expect(can(role, "residents.contact_info"), role).toBe(true);
    }
  });
});

describe("the scheduler dashboard", () => {
  it("says nothing is configured when nothing is", async () => {
    const empty = await createProgram({ name: "Brand New Residency" });
    const emptyAdmin = await createStaff(empty.program, {
      email: "new@h.org",
      role: "admin",
    });
    const snapshot = await loadSchedulerSnapshot(emptyAdmin.context);
    expect(snapshot.roster.total).toBe(0);
    expect(snapshot.cohorts.total).toBe(0);
    expect(snapshot.blocks.currentStructure).toBeNull();
    expect(snapshot.schedule.drafts).toHaveLength(0);
  });

  it("counts the roster by PGY and notices who is not in a cohort", async () => {
    const cohort = await createCohort(chief.context, { label: "A", pgyLevel: 2 });
    await addCohortMember(chief.context, cohort.id, alice.resident.id);

    const snapshot = await loadSchedulerSnapshot(chief.context);
    expect(snapshot.roster.total).toBe(2);
    expect(snapshot.roster.byPgy).toEqual([{ pgy: 2, count: 2, inCohort: 1 }]);
    expect(snapshot.roster.withoutCohort).toBe(1);
    expect(
      snapshot.problems.some((problem) => problem.title.includes("not in a cohort")),
    ).toBe(true);
  });

  it("flags a mandatory service with no coverage, and links to the fix", async () => {
    await query("UPDATE services SET coverage_mandatory = true WHERE id = $1", [
      fixture.services.MICU.id,
    ]);
    const snapshot = await loadSchedulerSnapshot(chief.context);
    const problem = snapshot.problems.find((entry) =>
      entry.title.includes("no coverage requirement"),
    );
    expect(problem).toBeDefined();
    expect(problem!.severity).toBe("high");
    expect(problem!.href).toBe("/admin/services");
  });

  it("flags upcoming shifts with nobody on them", async () => {
    await createShift(fixture.program, { inDays: 5 });
    const snapshot = await loadSchedulerSnapshot(chief.context);
    expect(snapshot.schedule.unassignedUpcoming).toBe(1);
    expect(
      snapshot.problems.some((problem) => problem.title.includes("nobody on them")),
    ).toBe(true);
  });

  it("orders problems by how much they hurt", async () => {
    await query("UPDATE services SET coverage_mandatory = true WHERE id = $1", [
      fixture.services.MICU.id,
    ]);
    await createCohort(chief.context, { label: "Empty", pgyLevel: 2 });

    const snapshot = await loadSchedulerSnapshot(chief.context);
    const severities = snapshot.problems.map((problem) => problem.severity);
    const order = { high: 0, medium: 1, low: 2 } as const;
    for (let index = 1; index < severities.length; index += 1) {
      expect(order[severities[index]]).toBeGreaterThanOrEqual(order[severities[index - 1]]);
    }
  });

  it("reports drafts in progress", async () => {
    await createScheduleVersion(chief.context, {
      name: "Block 3",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-28",
    });
    const snapshot = await loadSchedulerSnapshot(chief.context);
    expect(snapshot.schedule.drafts).toHaveLength(1);
    expect(snapshot.schedule.drafts[0].name).toBe("Block 3");
    expect(snapshot.schedule.drafts[0].createdByName).toBe("Casey Chief");
  });
});

describe("program isolation", () => {
  it("keeps another program's cohorts and drafts out of view", async () => {
    const other = await createProgram({ name: "Other Residency" });
    const otherChief = await createStaff(other.program, {
      email: "other.chief@h.org",
      role: "chief",
    });
    await createCohort(otherChief.context, { label: "Theirs", pgyLevel: 1 });
    await createCohort(chief.context, { label: "Ours", pgyLevel: 2 });

    const ours = await listCohorts(fixture.program.id);
    expect(ours.map((cohort) => cohort.label)).toEqual(["Ours"]);

    // And a cross-program id is "not found", never "forbidden".
    const theirs = await listCohorts(other.program.id);
    await expect(deleteCohort(chief.context, theirs[0].id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
