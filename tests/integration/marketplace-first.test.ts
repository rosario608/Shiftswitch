import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import type { ShiftDetail } from "@/server/db/types";
import { postAdHocShift } from "@/server/domain/ad-hoc";
import { acceptOffer, createOffer } from "@/server/domain/trades";
import { getResidentDashboard } from "@/server/domain/dashboard";
import { addOwnShifts } from "@/server/domain/self-report";
import { listResidentSchedule } from "@/server/domain/schedule";
import { extractSchedule } from "@/server/domain/assisted-import/extract";
import {
  effectiveRow,
  loadExtraction,
  reviewRow,
  rowsForCommit,
  markCommitted,
  saveExtraction,
} from "@/server/domain/assisted-import/store";
import { commitImport } from "@/server/domain/import";
import { listUnmatched } from "@/server/domain/held-rows";
import {
  MERGED_WEEK,
  ReplayTransport,
} from "../fixtures/assisted-import/responses";
import {
  assertDatabaseConsistent,
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
 * The marketplace, standing on its own.
 *
 * Two paths, both driven end to end, and both against a programme with
 * **nothing configured** — no services, no block year, no cohorts, no coverage
 * requirements, no published schedule. That emptiness is the point: everything
 * else in this codebase is tested against a programme somebody has already set
 * up, and the first resident to open this product will not have one.
 *
 * 1. A resident names a shift they work, posts it, and a colleague takes it.
 * 2. An administrator uploads a messy file, corrects the row the extraction was
 *    least sure about, and commits it.
 *
 * Both end in `assertDatabaseConsistent()`, which asserts the *state* rather
 * than the return values — one holder per shift, two legs per completed switch,
 * no offer stranded on a finished request.
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "assisted-import");

let program: TestProgram;
let alice: TestResident;
let ben: TestResident;

beforeAll(async () => {
  await ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  program = await createProgram({ name: "Brand New Residency", services: [] });
  alice = await createResident(program.program, { email: "alice@example.invalid", pgy: 2 });
  ben = await createResident(program.program, { email: "ben@example.invalid", pgy: 2 });
});

/** Nothing has been configured. Asserted rather than assumed, because the
 *  whole point of these tests is what happens without it. */
async function assertProgrammeIsEmpty(): Promise<void> {
  for (const table of ["services", "rotations", "schedule_versions", "block_structures"]) {
    const count = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE program_id = $1`,
      [program.program.id],
    );
    expect(count!.n, `${table} should be empty`).toBe("0");
  }
}

function tomorrow(): string {
  const at = new Date();
  at.setDate(at.getDate() + 3);
  return at.toISOString().slice(0, 10);
}

describe("a shift needs nothing behind it", () => {
  it("names a shift, posts it, and a colleague takes it", async () => {
    await assertProgrammeIsEmpty();

    /* One call, because from where the resident is standing it is one act. */
    const posted = await postAdHocShift(alice.context, {
      date: tomorrow(),
      startTime: "07:00",
      endTime: "19:00",
      service: "MICU",
      notes: "Family thing — happy to take a night back.",
    });

    expect(posted.alreadyHadIt).toBe(false);
    expect(posted.shift.provenance).toBe("self_reported");
    expect(posted.shift.status).toBe("posted");

    /* The service was created from what she typed, by the same function the
       importer uses — so a file naming "MICU" later finds this one rather than
       making a second. */
    const services = await query<{ name: string }>(
      "SELECT name FROM services WHERE program_id = $1",
      [program.program.id],
    );
    expect(services.map((service) => service.name)).toEqual(["MICU"]);

    /* Ben needs something of his own to offer, and he is in the same empty
       programme. He enters it rather than posting it — he is not trying to
       give it away, he is trying to take hers — which is the other half of the
       marketplace working with nothing behind it. */
    await addOwnShifts(ben.context, {
      dates: [tomorrow()],
      startTime: "07:00",
      endTime: "19:00",
      service: "Wards",
    });
    const bensShift = (await listResidentSchedule(ben.resident.id, { limit: 1 }))[0];
    expect(bensShift.provenance).toBe("self_reported");

    const offer = await createOffer(ben.context, {
      tradeRequestId: posted.tradeRequest.id,
      offeredShiftId: bensShift.id,
    });
    expect(offer.offer.status).toBe("pending");

    const accepted = await acceptOffer(alice.context, offer.offer.id);
    expect(accepted.status).toBe("completed");

    /* The switch actually moved both assignments. */
    const aliceNow = await query<ShiftDetail>(
      `SELECT s.id, sa.resident_id FROM shifts s
         JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
        WHERE sa.resident_id = $1`,
      [alice.resident.id],
    );
    expect(aliceNow.map((row) => row.id)).toEqual([bensShift.id]);

    await assertDatabaseConsistent();
  });

  it("posts the shift they already had rather than refusing them", async () => {
    const first = await postAdHocShift(alice.context, {
      date: tomorrow(),
      startTime: "07:00",
      endTime: "19:00",
      service: "MICU",
    });
    /* Taking the post down and naming the same shift again is somebody
       correcting a note, not an error. */
    await query("UPDATE trade_requests SET status = 'cancelled' WHERE id = $1", [
      first.tradeRequest.id,
    ]);
    await query("UPDATE shifts SET status = 'scheduled' WHERE id = $1", [first.shift.id]);

    const again = await postAdHocShift(alice.context, {
      date: tomorrow(),
      startTime: "07:00",
      endTime: "19:00",
      service: "MICU",
    });
    expect(again.alreadyHadIt).toBe(true);
    expect(again.shift.id).toBe(first.shift.id);

    const shifts = await queryOne<{ n: string }>(
      "SELECT count(*)::text AS n FROM shifts WHERE program_id = $1",
      [program.program.id],
    );
    expect(shifts!.n).toBe("1");
    await assertDatabaseConsistent();
  });

  it("refuses a second shift in the same hours, naming the one they have", async () => {
    await postAdHocShift(alice.context, {
      date: tomorrow(),
      startTime: "07:00",
      endTime: "19:00",
      service: "MICU",
    });
    await expect(
      postAdHocShift(alice.context, {
        date: tomorrow(),
        startTime: "08:00",
        endTime: "20:00",
        service: "Wards",
      }),
    ).rejects.toThrowError(/You already have MICU on/);
  });

  it("leaves nothing behind when the post half-fails", async () => {
    /* A shift that has already started cannot be posted. The shift must not
       survive that refusal — a shift on her schedule she believes she gave
       away is the worst outcome this path has. */
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await expect(
      postAdHocShift(alice.context, {
        date: yesterday.toISOString().slice(0, 10),
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
      }),
    ).rejects.toThrowError(/already started/);

    const shifts = await queryOne<{ n: string }>(
      "SELECT count(*)::text AS n FROM shifts WHERE program_id = $1",
      [program.program.id],
    );
    expect(shifts!.n).toBe("0");
    const services = await queryOne<{ n: string }>(
      "SELECT count(*)::text AS n FROM services WHERE program_id = $1",
      [program.program.id],
    );
    expect(services!.n).toBe("0");
  });

  it("shows the posted shift on the resident's own dashboard", async () => {
    const posted = await postAdHocShift(alice.context, {
      date: tomorrow(),
      startTime: "07:00",
      endTime: "19:00",
      service: "MICU",
    });
    const dashboard = await getResidentDashboard(alice.context);
    expect(dashboard.nextShift?.id).toBe(posted.shift.id);
  });
});

describe("import accepts what programmes actually send", () => {
  let chief: Awaited<ReturnType<typeof createStaff>>;

  beforeEach(async () => {
    chief = await createStaff(program.program, { email: "chief@example.invalid", role: "chief" });
  });

  async function extractMergedWeek() {
    const contents = readFileSync(path.join(FIXTURES, "merged-week.xlsx"));
    const extraction = await extractSchedule("merged-week.xlsx", contents, {
      transport: new ReplayTransport(MERGED_WEEK),
    });
    const id = await saveExtraction(
      chief.context,
      { filename: "merged-week.xlsx", byteSize: contents.byteLength },
      extraction,
    );
    return { id, extraction };
  }

  it("stores a proposal and writes no schedule", async () => {
    const { id } = await extractMergedWeek();

    const shifts = await queryOne<{ n: string }>(
      "SELECT count(*)::text AS n FROM shifts WHERE program_id = $1",
      [program.program.id],
    );
    expect(shifts!.n, "extraction must write no shifts").toBe("0");

    const stored = await loadExtraction(program.program.id, id);
    expect(stored!.status).toBe("proposed");
    expect(stored!.rows).toHaveLength(8);
    /* The merged Monday-to-Friday cell became five rows, not one. */
    expect(stored!.rows.filter((row) => row.proposed.residentName === "Alice Nguyen")).toHaveLength(
      5,
    );
  });

  it("sorts what it was least sure about to the top, and flags it", async () => {
    const { id } = await extractMergedWeek();
    const stored = await loadExtraction(program.program.id, id);

    const flagged = stored!.rows.filter((row) => row.needsReview);
    expect(flagged.length).toBeGreaterThan(0);
    /* Least confident first, so the reviewer's attention lands where it is
       worth most. */
    expect(stored!.rows[0].needsReview).toBe(true);
    expect(stored!.rows[0].confidence).toBeLessThan(
      stored!.rows[stored!.rows.length - 1].confidence,
    );
    expect(stored!.rows[0].proposed.uncertainty).toMatch(/shift code/);
  });

  it("keeps the origin of every row, so a reviewer can check it against the file", async () => {
    const { id } = await extractMergedWeek();
    const stored = await loadExtraction(program.program.id, id);
    for (const row of stored!.rows) {
      expect(row.origin.sheet).toBe("Block 3");
      expect(row.origin.cell).toMatch(/^[A-Z]+\d+$/);
    }
  });

  it("refuses to commit while a flagged row is unread, and names how many", async () => {
    const { id } = await extractMergedWeek();
    await expect(rowsForCommit(program.program.id, id)).rejects.toThrowError(
      /3 rows still need checking against the file/,
    );

    const shifts = await queryOne<{ n: string }>(
      "SELECT count(*)::text AS n FROM shifts WHERE program_id = $1",
      [program.program.id],
    );
    expect(shifts!.n).toBe("0");
  });

  /* The gate reads the database, not the request. There is no field a client
     can set that gets past it — which is the whole reason the proposal is
     stored server-side. */
  it("cannot be talked out of the gate by the caller", async () => {
    const { id } = await extractMergedWeek();
    const stored = await loadExtraction(program.program.id, id);
    const flagged = stored!.rows.filter((row) => row.needsReview);

    /* Reviewing all but one is still not all of them. */
    for (const row of flagged.slice(1)) {
      await reviewRow(chief.context, id, row.id, null);
    }
    await expect(rowsForCommit(program.program.id, id)).rejects.toThrowError(
      /1 row still needs checking/,
    );
  });

  it("takes the reviewer's correction, keeps the original, and imports the fix", async () => {
    const { id } = await extractMergedWeek();
    const stored = await loadExtraction(program.program.id, id);
    const flagged = stored!.rows.filter((row) => row.needsReview);

    /* The extraction read "NF 7p-7a" as a night shift on the right days but
       called the service "NF". The reviewer knows it is Night Float. */
    const [first, ...rest] = flagged;
    await reviewRow(chief.context, id, first.id, { service: "Night Float" });
    for (const row of rest) await reviewRow(chief.context, id, row.id, null);

    const afterReview = await loadExtraction(program.program.id, id);
    const corrected = afterReview!.rows.find((row) => row.id === first.id)!;
    expect(corrected.proposed.service, "the original is never overwritten").toBe("NF");
    expect(corrected.corrected!.service).toBe("Night Float");
    expect(effectiveRow(corrected).service).toBe("Night Float");

    const { rows } = await rowsForCommit(program.program.id, id);
    expect(rows.filter((row) => row.service === "Night Float")).toHaveLength(1);
  });

  it("commits through the one writer, holding rows for people who have not joined", async () => {
    const { id } = await extractMergedWeek();
    const stored = await loadExtraction(program.program.id, id);
    for (const row of stored!.rows.filter((row) => row.needsReview)) {
      await reviewRow(chief.context, id, row.id, null);
    }

    const { rows } = await rowsForCommit(program.program.id, id);
    const result = await commitImport(chief.context, rows);
    await markCommitted(id);

    /* Nobody in this programme is called Alice Nguyen or Ben Okafor, so every
       row is held rather than lost — the same behaviour a hand-typed CSV gets,
       because it is the same code. */
    expect(result.createdShifts).toBe(0);
    expect(result.heldRows).toBe(8);
    const unmatched = await listUnmatched(program.program.id);
    expect(unmatched.map((person) => person.resident_name).sort()).toEqual([
      "Alice Nguyen",
      "Ben Okafor",
    ]);

    const after = await loadExtraction(program.program.id, id);
    expect(after!.status).toBe("committed");
    await assertDatabaseConsistent();
  });

  it("refuses a second commit of the same upload", async () => {
    const { id } = await extractMergedWeek();
    const stored = await loadExtraction(program.program.id, id);
    for (const row of stored!.rows.filter((row) => row.needsReview)) {
      await reviewRow(chief.context, id, row.id, null);
    }
    const { rows } = await rowsForCommit(program.program.id, id);
    await commitImport(chief.context, rows);
    await markCommitted(id);

    await expect(rowsForCommit(program.program.id, id)).rejects.toThrowError(
      /already been imported/,
    );
  });

  it("does not leak an extraction to another program", async () => {
    const { id } = await extractMergedWeek();
    const other = await createProgram({ name: "Somebody Else's Residency", services: [] });
    expect(await loadExtraction(other.program.id, id)).toBeNull();
    await expect(rowsForCommit(other.program.id, id)).rejects.toThrowError(/not in this program/);
  });

  it("records what the model proposed in the audit log, separately from the import", async () => {
    const { id } = await extractMergedWeek();
    const entries = await query<{ action: string; entity_id: string }>(
      "SELECT action, entity_id FROM audit_logs WHERE program_id = $1",
      [program.program.id],
    );
    const proposal = entries.find((entry) => entry.action === "schedule.extraction_proposed");
    expect(proposal?.entity_id).toBe(id);
    expect(entries.some((entry) => entry.action === "schedule.imported")).toBe(false);
  });
});

/**
 * Both paths, in one run, in the order a real programme does them.
 *
 * Each half is covered above. This exists for the property neither half can
 * have on its own: that they *compose*. A programme starts with residents
 * naming their own shifts, and the block file arrives a fortnight later naming
 * the same services and the same people — and the failure that matters is the
 * one that only appears when the second meets the output of the first.
 */
describe("a programme that starts empty and gets its file later", () => {
  it("carries the resident's shift and the imported block in one schedule", async () => {
    await assertProgrammeIsEmpty();
    const chief = await createStaff(program.program, {
      email: "chief@example.invalid",
      role: "chief",
    });

    /* Week one: nothing uploaded. Alice names a shift and posts it; Ben enters
       one of his own and takes hers. */
    const posted = await postAdHocShift(alice.context, {
      date: tomorrow(),
      startTime: "07:00",
      endTime: "19:00",
      service: "MICU",
    });
    await addOwnShifts(ben.context, {
      dates: [tomorrow()],
      startTime: "07:00",
      endTime: "19:00",
      service: "Wards",
    });
    const bensShift = (await listResidentSchedule(ben.resident.id, { limit: 1 }))[0];
    const offer = await createOffer(ben.context, {
      tradeRequestId: posted.tradeRequest.id,
      offeredShiftId: bensShift.id,
    });
    await acceptOffer(alice.context, offer.offer.id);

    /* Week three: the coordinator finally has the block file, and it is a
       merged-cell spreadsheet naming MICU — the service Alice created by
       typing it. */
    const contents = readFileSync(path.join(FIXTURES, "merged-week.xlsx"));
    /* The recorded response with its two people renamed to the two residents
       who are actually in this programme. The shape under test is unchanged —
       the merged week — but the rows now *match*, so shifts are written rather
       than held, which is the case where the file meets what the residents
       already built for themselves. */
    const matching = {
      ...MERGED_WEEK,
      text: MERGED_WEEK.text
        .replace(/"residentName":"Alice Nguyen"/g, '"residentName":"alice@example.invalid"')
        .replace(/"residentName":"Ben Okafor"/g, '"residentName":"ben@example.invalid"'),
    };
    const extraction = await extractSchedule("merged-week.xlsx", contents, {
      transport: new ReplayTransport(matching),
    });
    const extractionId = await saveExtraction(
      chief.context,
      { filename: "merged-week.xlsx", byteSize: contents.byteLength },
      extraction,
    );
    const stored = await loadExtraction(program.program.id, extractionId);
    for (const row of stored!.rows.filter((row) => row.needsReview)) {
      await reviewRow(chief.context, extractionId, row.id, null);
    }
    const { rows } = await rowsForCommit(program.program.id, extractionId);
    await commitImport(chief.context, rows);
    await markCommitted(extractionId);

    /* One MICU, not two: the file found the service the resident created,
       because both went through `resolveServiceId`. This is the whole reason
       the ad-hoc path does not have a service table of its own. */
    const services = await query<{ name: string }>(
      "SELECT name FROM services WHERE program_id = $1 ORDER BY name",
      [program.program.id],
    );
    expect(services.map((service) => service.name)).toEqual(["MICU", "NF", "Wards"]);

    /* And the imported block actually landed on the two residents, rather than
       being held for people the programme has never heard of. */
    const imported = await queryOne<{ n: string }>(
      "SELECT count(*)::text AS n FROM shifts WHERE program_id = $1 AND provenance = 'imported'",
      [program.program.id],
    );
    expect(imported!.n).toBe("8");

    /* The completed switch survived the import untouched, and the shift Alice
       gave away is still Ben's. */
    const legs = await queryOne<{ n: string }>(
      "SELECT count(*)::text AS n FROM trade_legs",
    );
    expect(legs!.n).toBe("2");

    await assertDatabaseConsistent();
  });
});
