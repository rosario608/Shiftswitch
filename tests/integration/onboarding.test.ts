import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query, queryOne, withTransaction } from "@/server/db/pool";
import { commitImport, parseScheduleFile, validateImport } from "@/server/domain/import";
import { claimHeldRows, listUnmatched } from "@/server/domain/held-rows";
import { createShift, deleteShift } from "@/server/domain/admin";
import { createOffer, postShiftForTrade } from "@/server/domain/trades";
import { acceptInvitation, createInvitation } from "@/server/domain/invitations";
import { listResidentSchedule } from "@/server/domain/schedule";
import type { ResidentRow, UserRow } from "@/server/db/types";
import {
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  makeContext,
  resetDatabase,
} from "./helpers";

/**
 * The gaps around getting a brand-new program up and running: a file that is
 * not really a spreadsheet, a program with nothing in it yet, and removing a
 * shift that should not have been created.
 *
 * Row-level import validation, overnight shifts, duplicate imports and the
 * daylight-saving case are covered in email-and-admin.test.ts and are not
 * repeated here.
 */

let program: Awaited<ReturnType<typeof createProgram>>;
let admin: Awaited<ReturnType<typeof createResident>>;
let alice: Awaited<ReturnType<typeof createResident>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  program = await createProgram({ name: "Onboarding Program" });
  admin = await createResident(program.program, {
    email: "admin@hospital.org",
    role: "admin",
  });
  alice = await createResident(program.program, {
    email: "alice@hospital.org",
    name: "Alice Adeyemi",
    pgy: 2,
  });
});

describe("reading the uploaded file", () => {
  it("parses a plain CSV", async () => {
    const csv = [
      "Email,Date,Start time,End time,Service",
      "alice@hospital.org,2026-09-01,07:00,19:00,MICU",
    ].join("\n");
    const records = await parseScheduleFile("schedule.csv", Buffer.from(csv));
    expect(records).toHaveLength(1);
    expect(records[0].Email).toBe("alice@hospital.org");
  });

  it("accepts the aliases an export from another system produces", async () => {
    // "Name"/"Start"/"End"/"Overnight"/"Type" instead of the canonical headers.
    const csv = [
      "Resident Email,Date,Start,End,Overnight,Service,Type",
      "alice@hospital.org,09/01/2026,7:00 AM,7:00 PM,no,MICU,day",
    ].join("\n");
    const records = await parseScheduleFile("export.csv", Buffer.from(csv));
    const preview = await validateImport(admin.context, records);
    expect(preview.issues).toHaveLength(0);
    expect(preview.rows[0].date).toBe("2026-09-01");
    expect(preview.rows[0].startTime).toBe("07:00");
    expect(preview.rows[0].endTime).toBe("19:00");
  });

  it("refuses a file that is not a spreadsheet at all", async () => {
    // A PDF renamed to .xlsx is the classic version of this.
    const notASpreadsheet = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\nnonsense");
    await expect(
      parseScheduleFile("schedule.xlsx", notASpreadsheet),
    ).rejects.toBeInstanceOf(Error);
  });

  it("reports a CSV whose columns do not include the required ones", async () => {
    const csv = ["Person,When,Where", "Alice,Tuesday,ICU"].join("\n");
    const records = await parseScheduleFile("wrong.csv", Buffer.from(csv));
    const preview = await validateImport(admin.context, records);
    expect(preview.issues.length).toBeGreaterThan(0);
    expect(preview.rows).toHaveLength(0);
  });

  it("treats an empty file as an empty import rather than crashing", async () => {
    const records = await parseScheduleFile("empty.csv", Buffer.from(""));
    const preview = await validateImport(admin.context, records);
    expect(preview.rows).toHaveLength(0);
    expect(preview.summary.totalRows).toBe(0);
    expect(preview.summary.dateRange).toBeNull();
  });
});

describe("a brand-new program with nothing in it", () => {
  it("creates the services the file mentions, so an empty program is not a blocker", async () => {
    const before = await query<{ id: string }>(
      "SELECT id FROM services WHERE program_id = $1",
      [program.program.id],
    );

    const preview = await validateImport(admin.context, [
      {
        Email: "alice@hospital.org",
        Date: "2026-09-01",
        "Start time": "07:00",
        "End time": "19:00",
        Service: "Brand New Service",
        Rotation: "Brand New Rotation",
      },
    ]);
    expect(preview.issues).toHaveLength(0);

    const result = await commitImport(admin.context, preview.rows);
    expect(result.createdShifts).toBe(1);
    expect(result.createdServices).toBe(1);
    expect(result.createdRotations).toBe(1);

    const after = await query<{ id: string }>(
      "SELECT id FROM services WHERE program_id = $1",
      [program.program.id],
    );
    expect(after.length).toBe(before.length + 1);
  });

  it("writes nothing at all when one row of many is malformed", async () => {
    const shiftsBefore = await query<{ id: string }>("SELECT id FROM shifts");

    await expect(
      commitImport(admin.context, [
        {
          residentEmail: "alice@hospital.org",
          date: "2026-09-01",
          startTime: "07:00",
          endTime: "19:00",
          service: "MICU",
        },
        {
          residentEmail: "alice@hospital.org",
          date: "2026-09-02",
          startTime: "07:00",
          endTime: "19:00",
          service: "", // no service: the row does not describe a shift
        },
      ]),
    ).rejects.toMatchObject({ code: "validation_failed" });

    const shiftsAfter = await query<{ id: string }>("SELECT id FROM shifts");
    expect(shiftsAfter).toHaveLength(shiftsBefore.length);
  });

  it("holds the rows for people who have not joined, and loses nothing", async () => {
    /* The case that made the old refusal wrong: a file naming three people, one
       of whom has an account. The other two are not an error in the file — they
       are two residents who have not signed in yet. */
    const result = await commitImport(admin.context, [
      {
        residentEmail: "alice@hospital.org",
        date: "2026-09-10",
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
      },
      {
        residentName: "Nadia Osei",
        date: "2026-09-10",
        startTime: "19:00",
        endTime: "07:00",
        endsNextDay: true,
        service: "MICU",
      },
      {
        residentName: "Nadia Osei",
        date: "2026-09-11",
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
      },
      {
        residentName: "Reyes, Tom",
        date: "2026-09-11",
        startTime: "19:00",
        endTime: "07:00",
        endsNextDay: true,
        service: "MICU",
      },
    ]);

    expect(result.createdShifts).toBe(1);
    expect(result.heldRows).toBe(3);
    expect(result.heldPeople).toBe(2);

    const waiting = await listUnmatched(program.program.id);
    expect(waiting.map((person) => person.resident_name)).toEqual([
      "Nadia Osei",
      "Reyes, Tom",
    ]);
    expect(waiting.find((p) => p.resident_name === "Nadia Osei")!.shifts).toBe(2);
  });

  it("hands a held schedule to the person the moment they exist", async () => {
    await commitImport(admin.context, [
      {
        residentName: "Osei, Nadia K",
        date: "2026-09-10",
        startTime: "19:00",
        endTime: "07:00",
        endsNextDay: true,
        service: "MICU",
        rotation: "Critical Care",
        location: "ICU Tower 4",
      },
      {
        residentName: "Nadia Osei",
        date: "2026-09-11",
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
      },
    ]);
    /* Two spellings of one name in one file — "Osei, Nadia K" and "Nadia Osei"
       — which is what a real block file looks like when two people typed it. */
    expect(await listUnmatched(program.program.id)).toHaveLength(1);

    const nadia = await createResident(program.program, {
      email: "nadia.osei@hospital.org",
      name: "Nadia Osei",
      pgy: 2,
    });

    const claimed = await withTransaction((client) =>
      claimHeldRows(
        program.program.id,
        { id: nadia.resident.id, name: "Nadia Osei", email: "nadia.osei@hospital.org" },
        client,
      ),
    );
    expect(claimed.claimedRows).toBe(2);
    expect(claimed.createdShifts).toBe(2);

    const schedule = await listResidentSchedule(nadia.resident.id, {
      includePast: true,
      limit: 50,
    });
    expect(schedule).toHaveLength(2);
    // The overnight one is still one shift of twelve hours, not two of six.
    const overnight = schedule.find((shift) => shift.shift_type === "night")!;
    expect(overnight).toBeDefined();
    expect(
      (overnight.end_datetime.getTime() - overnight.start_datetime.getTime()) / 3_600_000,
    ).toBe(12);
    expect(overnight.location).toBe("ICU Tower 4");

    // Nothing is left waiting, and claiming twice does not duplicate.
    expect(await listUnmatched(program.program.id)).toHaveLength(0);
    const again = await withTransaction((client) =>
      claimHeldRows(
        program.program.id,
        { id: nadia.resident.id, name: "Nadia Osei", email: "nadia.osei@hospital.org" },
        client,
      ),
    );
    expect(again.claimedRows).toBe(0);

    /* They came from the programme's file, and that is what they say. A row the
       file called confirmed does not become confirmed by being claimed — the
       person claiming it is the resident, and nobody vouches for themselves. */
    const provenance = await query<{ provenance: string }>(
      `SELECT s.provenance FROM shifts s
         JOIN shift_assignments sa ON sa.shift_id = s.id
        WHERE sa.resident_id = $1`,
      [nadia.resident.id],
    );
    expect(provenance.map((row) => row.provenance)).toEqual(["imported", "imported"]);
  });
});

describe("the whole path from an empty program to a posted shift", () => {
  /**
   * The onboarding sequence an administrator actually performs, end to end,
   * through the same functions the routes call: invite, accept with a Google
   * identity, import the block, then have the residents use it.
   *
   * The one thing substituted is Google itself — `acceptInvitation` is handed
   * the verified identity the OAuth callback would hand it. The signature
   * verification that produces that identity is covered in oidc.test.ts.
   */
  it("onboards two residents who then trade with each other", async () => {
    const fresh = await createProgram({ name: "Brand New Residency" });
    const { context: adminContext } = await createStaff(fresh.program, {
      email: "program.admin@hospital.org",
      role: "admin",
      name: "Priya Nair",
    });

    // Nothing in it yet.
    expect(
      await query("SELECT id FROM residents WHERE program_id = $1", [fresh.program.id]),
    ).toHaveLength(0);

    // 1. Invite.
    const invited = [
      { email: "new.one@hospital.org", name: "Nadia Osei" },
      { email: "new.two@hospital.org", name: "Tom Reyes" },
    ];
    const invitations = [];
    for (const person of invited) {
      invitations.push(
        await createInvitation(adminContext, {
          email: person.email,
          role: "resident",
          pgyLevel: 2,
        }),
      );
    }

    // 2. Accept, each with the Google identity for their own address.
    const accepted: Array<{ user: UserRow; resident: ResidentRow }> = [];
    for (const [index, invitation] of invitations.entries()) {
      const result = await acceptInvitation(invitation.token, {
        subject: `google-sub-${index}`,
        email: invited[index].email,
        name: invited[index].name,
        picture: null,
      });
      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") throw new Error("unreachable");
      const resident = await queryOne<ResidentRow>(
        "SELECT * FROM residents WHERE user_id = $1",
        [result.user.id],
      );
      expect(resident).not.toBeNull();
      expect(resident!.program_id).toBe(fresh.program.id);
      accepted.push({ user: result.user, resident: resident! });
    }

    // 3. Import a block that names them by the same addresses they were
    //    invited at — which is the whole reason invite-then-import is the
    //    documented order.
    const day = (offset: number) =>
      DateTime.now()
        .setZone(fresh.program.timezone)
        .plus({ days: offset })
        .toISODate() as string;

    const csv = [
      "Email,Date,Start time,End time,Ends next day,Service,Shift type",
      `${invited[0].email},${day(20)},07:00,19:00,no,MICU,day`,
      `${invited[1].email},${day(21)},19:00,07:00,yes,MICU,night`,
      `${invited[1].email},${day(24)},07:00,19:00,no,MICU,day`,
    ].join("\n");

    const records = await parseScheduleFile("block.csv", Buffer.from(csv));
    const preview = await validateImport(adminContext, records);
    expect(preview.issues).toHaveLength(0);
    expect(preview.summary.totalRows).toBe(3);

    const committed = await commitImport(adminContext, preview.rows);
    expect(committed.createdShifts).toBe(3);

    // 4. Each resident sees their own shifts, and only their own.
    const oneContext = makeContext(fresh.program, accepted[0].user, accepted[0].resident);
    const twoContext = makeContext(fresh.program, accepted[1].user, accepted[1].resident);

    const oneSchedule = await listResidentSchedule(accepted[0].resident.id);
    const twoSchedule = await listResidentSchedule(accepted[1].resident.id);
    expect(oneSchedule).toHaveLength(1);
    expect(twoSchedule).toHaveLength(2);

    // The overnight row is one shift ending the following morning, not two.
    const overnight = twoSchedule.find((shift) => shift.shift_type === "night")!;
    expect(overnight).toBeDefined();
    const hours =
      (new Date(overnight.end_datetime).getTime() -
        new Date(overnight.start_datetime).getTime()) /
      3_600_000;
    expect(hours).toBe(12);

    // 5. And they can actually use the thing: post a shift, receive an offer.
    const posted = await postShiftForTrade(oneContext, {
      shiftId: oneSchedule[0].id,
    });
    const offer = await createOffer(twoContext, {
      tradeRequestId: posted.id,
      offeredShiftId: twoSchedule[0].id,
    });
    expect(offer.offer.trade_request_id).toBe(posted.id);
  });

  it("does not let a second program's administrator see or touch the invitations", async () => {
    const mine = await createProgram({ name: "Mine" });
    const theirs = await createProgram({ name: "Theirs" });
    const { context: myAdmin } = await createStaff(mine.program, {
      email: "mine.admin@hospital.org",
      role: "admin",
    });
    const { context: theirAdmin } = await createStaff(theirs.program, {
      email: "theirs.admin@hospital.org",
      role: "admin",
    });

    const created = await createInvitation(myAdmin, {
      email: "shared.name@hospital.org",
      role: "resident",
    });

    // Scoped by program on every read and write, not merely on the list view.
    const { listInvitations, revokeInvitation, resendInvitation } = await import(
      "@/server/domain/invitations"
    );
    expect(await listInvitations(theirs.program.id)).toHaveLength(0);
    await expect(
      revokeInvitation(theirAdmin, created.invitation.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      resendInvitation(theirAdmin, created.invitation.id),
    ).rejects.toMatchObject({ code: "not_found" });

    // Still live for the program that issued it.
    expect(await listInvitations(mine.program.id)).toHaveLength(1);
  });
});

describe("removing a shift", () => {
  async function makeShift() {
    return createShift(admin.context, {
      serviceId: program.services.MICU.id,
      date: "2026-09-10",
      startTime: "07:00",
      endTime: "19:00",
      endsNextDay: false,
      location: "ICU Tower 4",
      shiftType: "day",
      requiredPgyMin: 1,
      requiredPgyMax: 10,
      tradeable: true,
      approvalRequired: false,
      residentId: alice.resident.id,
    });
  }

  it("deletes a shift that carries no history", async () => {
    const shift = await makeShift();
    await deleteShift(admin.context, shift.id);

    const found = await queryOne<{ id: string }>("SELECT id FROM shifts WHERE id = $1", [
      shift.id,
    ]);
    expect(found).toBeNull();

    // The assignment goes with it, and the deletion is in the audit log.
    const assignments = await query<{ id: string }>(
      "SELECT id FROM shift_assignments WHERE shift_id = $1",
      [shift.id],
    );
    expect(assignments).toHaveLength(0);

    const audit = await queryOne<{ action: string }>(
      "SELECT action FROM audit_logs WHERE entity_id = $1 AND action = 'shift.deleted'",
      [shift.id],
    );
    expect(audit).not.toBeNull();
  });

  it("refuses while the shift is posted for switching", async () => {
    const shift = await makeShift();
    await postShiftForTrade(alice.context, { shiftId: shift.id });

    await expect(deleteShift(admin.context, shift.id)).rejects.toMatchObject({
      code: "conflict",
    });

    const still = await queryOne<{ id: string }>("SELECT id FROM shifts WHERE id = $1", [
      shift.id,
    ]);
    expect(still).not.toBeNull();
  });

  it("refuses a shift belonging to another program", async () => {
    const other = await createProgram({ name: "Somebody Else" });
    const otherAdmin = await createResident(other.program, {
      email: "other.admin@hospital.org",
      role: "admin",
    });
    const shift = await makeShift();

    await expect(deleteShift(otherAdmin.context, shift.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("reports a shift that is already gone as not found", async () => {
    const shift = await makeShift();
    await deleteShift(admin.context, shift.id);
    await expect(deleteShift(admin.context, shift.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("the first thing a real resident ever does", () => {
  /**
   * Accepting an invitation through Google has never been completed against a
   * real account — it needs a second human Google identity, which no test can
   * produce. What *can* be pinned is the half that fails: every way redemption
   * can go wrong, each with its own diagnosis.
   *
   * These four used to arrive at the resident as one sentence, "that invitation
   * link has expired or been cancelled". Somebody who had simply already signed
   * in was told to check a link that was fine; somebody whose invitation had
   * lapsed was told the same thing as somebody whose program had cancelled it.
   * At the first minute of a resident's first contact with the product, a wrong
   * diagnosis is not a small cost: it does not get retried, it gets reported to
   * a colleague as "the app doesn't work".
   */
  const adminContextFor = async (fresh: Awaited<ReturnType<typeof createProgram>>) => {
    const { context } = await createStaff(fresh.program, {
      email: `admin-${fresh.program.id.slice(0, 8)}@hospital.org`,
      name: "Program Administrator",
      role: "admin",
    });
    return context;
  };

  const identity = (email: string) => ({
    subject: "google-sub-first",
    email,
    name: "First Resident",
    picture: null,
  });

  it("says a token nobody has ever issued is unrecognised", async () => {
    const fresh = await createProgram();
    const admin = await adminContextFor(fresh);
    await createInvitation(admin, { email: "new@hospital.org", role: "resident" });

    const result = await acceptInvitation("not-a-real-token-at-all", identity("new@hospital.org"));
    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") throw new Error("unreachable");
    expect(result.reason).toBe("unknown");
  });

  it("distinguishes an invitation that has run out of time", async () => {
    const fresh = await createProgram();
    const admin = await adminContextFor(fresh);
    const created = await createInvitation(admin, {
      email: "late@hospital.org",
      role: "resident",
    });
    await query("UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1", [
      created.invitation.id,
    ]);

    const result = await acceptInvitation(created.token, identity("late@hospital.org"));
    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") throw new Error("unreachable");
    expect(result.reason).toBe("expired");
  });

  it("distinguishes one that has already been used", async () => {
    /* The commonest of the four in practice: somebody taps the link in the
       email a second time, having already signed in. Telling them it expired
       sends them to their administrator for a replacement they do not need. */
    const fresh = await createProgram();
    const admin = await adminContextFor(fresh);
    const created = await createInvitation(admin, {
      email: "twice@hospital.org",
      role: "resident",
    });

    const first = await acceptInvitation(created.token, identity("twice@hospital.org"));
    expect(first.outcome).toBe("accepted");

    const second = await acceptInvitation(created.token, identity("twice@hospital.org"));
    expect(second.outcome).toBe("invalid");
    if (second.outcome !== "invalid") throw new Error("unreachable");
    expect(second.reason).toBe("already_accepted");
  });

  it("distinguishes one the program took back", async () => {
    const fresh = await createProgram();
    const admin = await adminContextFor(fresh);
    const created = await createInvitation(admin, {
      email: "gone@hospital.org",
      role: "resident",
    });
    const { revokeInvitation } = await import("@/server/domain/invitations");
    await revokeInvitation(admin, created.invitation.id);

    const result = await acceptInvitation(created.token, identity("gone@hospital.org"));
    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") throw new Error("unreachable");
    expect(result.reason).toBe("revoked");
  });

  it("still refuses a forwarded link without consuming it", async () => {
    /* The one failure that is not about the invitation's state: the right link
       in the wrong hands. It must not be spent — the real invitee has to be
       able to use it afterwards. */
    const fresh = await createProgram();
    const admin = await adminContextFor(fresh);
    const created = await createInvitation(admin, {
      email: "real@hospital.org",
      role: "resident",
    });

    const forwarded = await acceptInvitation(created.token, identity("someone.else@hospital.org"));
    expect(forwarded.outcome).toBe("email_mismatch");

    const proper = await acceptInvitation(created.token, identity("real@hospital.org"));
    expect(proper.outcome).toBe("accepted");
  });
});
