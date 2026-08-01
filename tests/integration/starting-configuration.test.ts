import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import type { ProgramRow } from "@/server/db/types";
import { commitImport } from "@/server/domain/import";
import {
  INTERNAL_MEDICINE,
  applyStartingConfiguration,
  confirmDefault,
  listUnconfirmedDefaults,
  mondayOnOrAfter,
} from "@/server/domain/starting-configuration";
import {
  applyExceptions,
  createPatternException,
  deletePatternException,
  listAllExceptions,
  listExceptions,
  listRotationPatterns,
  stateOn,
  statesOver,
  winterHolidayRange,
} from "@/server/domain/rotation-cycles";
import {
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  resetDatabase,
} from "./helpers";

/**
 * A guessed default may not become a month of somebody's life.
 *
 * The starting configuration ships with two kinds of claim in it: what a
 * programme's own document says, and what was inferred because a position needs
 * *some* hours to be useful. The second kind is inert until a person looks at
 * it — and these are the tests that say so, because the failure it prevents is
 * silent and looks exactly like success.
 */

let program: ProgramRow;
let admin: Awaited<ReturnType<typeof createStaff>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  const created = await createProgram({ name: "Configuring Residency" });
  program = created.program;
  admin = await createStaff(program, {
    email: "coordinator@hospital.org",
    role: "admin",
    name: "Priya Nair",
  });
});

describe("what ships", () => {
  it("marks every part as stated or assumed, with a reason a person can read", () => {
    const claims = [...INTERNAL_MEDICINE.positions, ...INTERNAL_MEDICINE.cycles];
    expect(claims.length).toBeGreaterThan(10);
    for (const claim of claims) {
      expect(["stated", "assumed"], claim.name).toContain(claim.provenance);
      // Not a label but a sentence: whoever reads it next has to be able to
      // check the claim against the document it came from.
      expect(claim.source.length, claim.name).toBeGreaterThan(20);
    }
  });

  it("gives no default at all to the position whose hours genuinely vary", () => {
    /* One emergency-department code appears in a single week as 10a–6p, 3p–11p,
       7p–7a and 7a–7p. Any default is a lie about three of them, so it ships
       with none — and that absence is *stated*, not assumed. */
    const ed = INTERNAL_MEDICINE.positions.find((entry) =>
      entry.name.startsWith("Emergency"),
    )!;
    expect(ed.defaultStart).toBeNull();
    expect(ed.provenance).toBe("stated");
  });

  it("has both kinds, or the distinction is decorative", () => {
    const claims = [...INTERNAL_MEDICINE.positions, ...INTERNAL_MEDICINE.cycles];
    expect(claims.some((claim) => claim.provenance === "stated")).toBe(true);
    expect(claims.some((claim) => claim.provenance === "assumed")).toBe(true);
  });
});

describe("applying it", () => {
  it("anchors every cycle to a Monday so a day off lands on the day it names", async () => {
    /* A seven-day cycle whose sixth position is `off` means Saturday. Anchored
       to an arbitrary day it would mean Tuesday — wrong in a way that looks
       right in the database and wrong on somebody's phone. */
    expect(mondayOnOrAfter("2026-07-01")).toBe("2026-07-06"); // a Wednesday
    expect(mondayOnOrAfter("2026-07-06")).toBe("2026-07-06"); // already Monday

    await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2026,
    });

    const patterns = await listRotationPatterns(program.id);
    const micu = patterns.find((entry) => entry.name === "MICU, Saturday off")!;
    expect(micu).toBeDefined();
    expect(stateOn(micu, "2026-07-11")).toBe("off"); // the Saturday
    expect(stateOn(micu, "2026-07-10")).toBe("on"); // the Friday before
    expect(stateOn(micu, "2026-07-18")).toBe("off"); // and the next Saturday
  });

  it("expresses the rotating day off that no weekly table can hold", async () => {
    await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2026,
    });
    const patterns = await listRotationPatterns(program.id);
    const va = patterns.find((entry) => entry.name.startsWith("VA general medicine"))!;
    expect(va.cycle_days).toBe(14);
    expect(stateOn(va, "2026-07-08")).toBe("off"); // Wednesday of week one
    expect(stateOn(va, "2026-07-18")).toBe("off"); // Saturday of week two
    expect(stateOn(va, "2026-07-15")).toBe("on"); // not the Wednesday after
  });

  it("takes the academic year rather than assuming one", async () => {
    const later = await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2027,
    });
    expect(later.cycles).toBeGreaterThan(0);
    const patterns = await listRotationPatterns(program.id);
    for (const pattern of patterns) {
      expect(pattern.anchor_date.toISOString().slice(0, 4)).toBe("2027");
    }
  });

  it("can be applied twice without duplicating anything", async () => {
    const first = await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2026,
    });
    const second = await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2026,
    });
    expect(first.positions).toBeGreaterThan(0);
    expect(second.positions).toBe(0);
    expect(second.cycles).toBe(0);
  });

  it("does not overwrite a default somebody has already confirmed", async () => {
    await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2026,
    });
    const cicu = (await queryOne<{ id: string }>(
      "SELECT id FROM positions WHERE program_id = $1 AND name = 'CICU day'",
      [program.id],
    ))!;
    await confirmDefault(admin.context, "position", cicu.id, {
      defaultStart: "06:30",
      defaultMinutes: 720,
    });

    await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2026,
    });

    const after = (await queryOne<{ provenance: string; start: string }>(
      "SELECT provenance, to_char(default_start, 'HH24:MI') AS start FROM positions WHERE id = $1",
      [cicu.id],
    ))!;
    expect(after.provenance).toBe("confirmed");
    expect(after.start).toBe("06:30");
  });

  it("refuses a role that does not decide what a service is", async () => {
    const chief = await createResident(program, {
      email: "chief@hospital.org",
      role: "chief",
    });
    await expect(
      applyStartingConfiguration(chief.context, {
        id: "internal-medicine",
        academicYear: 2026,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("an assumed default generates nothing until somebody confirms it", () => {
  beforeEach(async () => {
    await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2026,
    });
  });

  it("lists every guess nobody has looked at", async () => {
    const waiting = await listUnconfirmedDefaults(program.id);
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.some((entry) => entry.name === "CICU day")).toBe(true);
    // The stated ones are not in the list; they need nobody's permission.
    expect(waiting.some((entry) => entry.name === "VA MICU call")).toBe(false);
  });

  it("refuses to fill an import's blank hours from a guess, and says why", async () => {
    /* The mechanism, exercised through the importer rather than asserted about
       it: a row with no Start, for a service whose position is assumed. */
    await query(
      `UPDATE positions SET default_start = '07:00', default_minutes = 720
        WHERE program_id = $1 AND name = 'CICU day'`,
      [program.id],
    );

    await expect(
      commitImport(admin.context, [
        {
          residentName: "Somebody",
          date: "2026-09-01",
          startTime: "",
          endTime: "",
          service: "CICU day",
        },
      ]),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("fills them once somebody has confirmed it", async () => {
    const cicu = (await queryOne<{ id: string }>(
      "SELECT id FROM positions WHERE program_id = $1 AND name = 'CICU day'",
      [program.id],
    ))!;
    await confirmDefault(admin.context, "position", cicu.id, {
      defaultStart: "07:00",
      defaultMinutes: 720,
    });

    const result = await commitImport(admin.context, [
      {
        residentName: "Somebody",
        date: "2026-09-01",
        startTime: "",
        endTime: "",
        service: "CICU day",
      },
    ]);
    /* Held rather than created, because Somebody has not joined — but it got
       past validation, which is the thing being tested. The hours came from a
       default a person vouched for. */
    expect(result.heldRows).toBe(1);

    const held = (await queryOne<{ start: string; end: string }>(
      `SELECT to_char(start_datetime AT TIME ZONE $2, 'HH24:MI') AS start,
              to_char(end_datetime AT TIME ZONE $2, 'HH24:MI') AS end
         FROM held_shift_rows WHERE program_id = $1`,
      [program.id, program.timezone],
    ))!;
    expect(held.start).toBe("07:00");
    expect(held.end).toBe("19:00");
  });

  it("will not let somebody confirm hours that do not exist", async () => {
    /* A position with no hours, ticked, would be usable and still have nothing
       to give — which is the same defect wearing a confirmation. */
    const ward = (await queryOne<{ id: string }>(
      "SELECT id FROM positions WHERE program_id = $1 AND name = 'Ward day'",
      [program.id],
    ))!;
    await expect(
      confirmDefault(admin.context, "position", ward.id),
    ).rejects.toMatchObject({ code: "validation_failed" });

    const after = (await queryOne<{ provenance: string }>(
      "SELECT provenance FROM positions WHERE id = $1",
      [ward.id],
    ))!;
    expect(after.provenance).toBe("assumed");
  });

  it("records who vouched for it, which is asked in October", async () => {
    const clinic = (await queryOne<{ id: string }>(
      "SELECT id FROM rotation_patterns WHERE program_id = $1 AND name = 'Clinic, weekdays'",
      [program.id],
    ))!;
    await confirmDefault(admin.context, "cycle", clinic.id);

    const after = (await queryOne<{ provenance: string; confirmed_by: string }>(
      "SELECT provenance, confirmed_by FROM rotation_patterns WHERE id = $1",
      [clinic.id],
    ))!;
    expect(after.provenance).toBe("confirmed");
    expect(after.confirmed_by).toBe(admin.user.id);
  });
});

describe("suspending a cycle over a range", () => {
  beforeEach(async () => {
    await applyStartingConfiguration(admin.context, {
      id: "internal-medicine",
      academicYear: 2026,
    });
  });

  it("replaces the pattern for the range and leaves it intact outside", async () => {
    const micu = (
      await listRotationPatterns(program.id)
    ).find((entry) => entry.name === "MICU, Saturday off")!;

    const holiday = winterHolidayRange(2026);
    await createPatternException(
      {
        programId: program.id,
        patternId: micu.id,
        startsOn: holiday.startsOn,
        endsOn: holiday.endsOn,
        replacementStates: null,
        reason: holiday.reason,
      },
      admin.user.id,
    );

    const days = statesOver(micu, "2026-12-20", "2027-01-05");
    const applied = applyExceptions(
      days,
      await listExceptions(program.id, "2026-12-20", "2027-01-05"),
    );

    /* Inside the fortnight nothing applies — which is not the same as everybody
       being off, and is the distinction the whole table exists for. */
    const inside = applied.find((day) => day.date === "2026-12-25")!;
    expect(inside.state).toBeNull();
    expect(inside.exception).toMatch(/holiday/i);

    // Before it and after it, the cycle runs exactly as it did.
    expect(applied.find((day) => day.date === "2026-12-21")!.state).toBe(
      stateOn(micu, "2026-12-21"),
    );
    expect(applied.find((day) => day.date === "2027-01-05")!.state).toBe(
      stateOn(micu, "2027-01-05"),
    );
  });

  it("refuses an override that does not say why", async () => {
    const micu = (await listRotationPatterns(program.id))[0]!;
    await expect(
      createPatternException(
        {
          programId: program.id,
          patternId: micu.id,
          startsOn: "2026-12-24",
          endsOn: "2027-01-01",
          reason: "  ",
        },
        admin.user.id,
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a range that ends before it starts, and one that applies to nothing", async () => {
    const micu = (await listRotationPatterns(program.id))[0]!;
    await expect(
      createPatternException(
        {
          programId: program.id,
          patternId: micu.id,
          startsOn: "2027-01-01",
          endsOn: "2026-12-24",
          reason: "Backwards",
        },
        admin.user.id,
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });

    await expect(
      createPatternException(
        {
          programId: program.id,
          startsOn: "2026-12-24",
          endsOn: "2027-01-01",
          reason: "Applies to nothing at all",
        },
        admin.user.id,
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("puts the cycle back when the override is removed", async () => {
    const micu = (await listRotationPatterns(program.id))[0]!;
    const created = await createPatternException(
      {
        programId: program.id,
        patternId: micu.id,
        startsOn: "2026-12-24",
        endsOn: "2027-01-01",
        reason: "Winter holiday block",
      },
      admin.user.id,
    );
    expect(await listAllExceptions(program.id)).toHaveLength(1);

    expect(await deletePatternException(program.id, created.id)).toBe(true);
    expect(await listAllExceptions(program.id)).toHaveLength(0);
    // And removing it twice is not an error the caller has to handle twice.
    expect(await deletePatternException(program.id, created.id)).toBe(false);
  });
});
