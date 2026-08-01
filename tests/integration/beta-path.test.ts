import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { ProgramRow, ResidentRow, UserRow } from "@/server/db/types";
import type { AuthedContext } from "@/server/auth/guards";
import { allowsWhilePending } from "@/server/auth/guards";
import { commitImport } from "@/server/domain/import";
import { listUnmatched } from "@/server/domain/held-rows";
import {
  addEmailDomain,
  createEnrollmentLink,
  enrollWithLink,
  listEnrollmentEvents,
  listPendingMembers,
  admitMember,
} from "@/server/domain/enrollment";
import {
  createRotationPattern,
  q3CallCycle,
  setPatternMember,
  statesOver,
} from "@/server/domain/rotation-cycles";
import { correctOwnShift } from "@/server/domain/self-report";
import { zonedWallTimeToInstant } from "@/server/domain/time";
import { listResidentSchedule } from "@/server/domain/schedule";
import { getResidentDashboard } from "@/server/domain/dashboard";
import { acceptOffer, createOffer, postShiftForTrade } from "@/server/domain/trades";
import {
  assertDatabaseConsistent,
  closeDatabase,
  createProgram,
  createResident,
  createStaff,
  ensureMigrated,
  resetDatabase,
} from "./helpers";

/**
 * The whole beta, in one test.
 *
 * Everything in this file has a test of its own somewhere — the importer's held
 * rows, the cycle arithmetic, the enrollment refusals, the switch lifecycle. So
 * this one exists for the property none of those can have: that they *compose*.
 * A programme onboarding for the first time does all of it in sequence, in an
 * afternoon, and the failure that matters is the one that only appears when the
 * fifth step meets the output of the first.
 *
 * The sequence is the real one, and every step is the function the product's
 * own button calls:
 *
 *   1. an administrator configures a service with a q3 call cycle
 *   2. imports a block naming people who have not joined
 *   3. issues one enrollment link
 *   4. a stranger opens it and joins
 *   5. and finds a schedule already waiting for them
 *   6. corrects a shift whose hours the file got wrong
 *   7. posts it
 *   8. a second resident accepts it, and both schedules move
 *
 * The one thing substituted is Google, exactly as in onboarding.test.ts: the
 * verified identity the OAuth callback would hand to `enrollWithLink` is handed
 * to it directly. Signature verification is covered in oidc.test.ts.
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
  const created = await createProgram({ name: "Beta Residency" });
  program = created.program;
  admin = await createStaff(program, {
    email: "coordinator@betahospital.org",
    role: "admin",
    name: "Priya Nair",
  });
});

/** A context built from what is actually in the database, enrollment status and all. */
async function contextFor(userId: string): Promise<AuthedContext & { resident: ResidentRow }> {
  const user = (await queryOne<UserRow>("SELECT * FROM users WHERE id = $1", [userId]))!;
  const resident = await queryOne<ResidentRow>(
    "SELECT * FROM residents WHERE user_id = $1",
    [userId],
  );
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      pictureUrl: null,
      role: user.role!,
      programId: program.id,
      active: user.active,
      enrollmentStatus: user.enrollment_status,
    },
    program,
    resident,
    sessionId: "test-session",
  } as AuthedContext & { resident: ResidentRow };
}

const day = (offset: number) =>
  DateTime.now().setZone(program.timezone).plus({ days: offset }).toISODate() as string;

describe("a program onboarding for the first time", () => {
  it("configures a cycle, imports a block, and hands out one link", async () => {
    /* ---------------------------------------------------------------- 1 */
    /* The service and its coverage pattern. VA MICU is annotated q3
       twenty-four-hour call in the programme's own document, which is three
       days and not a weekday table. */
    const service = (await queryOne<{ id: string }>(
      "SELECT id FROM services WHERE program_id = $1 AND name = 'MICU'",
      [program.id],
    ))!;

    const pattern = await createRotationPattern({
      programId: program.id,
      serviceId: service.id,
      name: "MICU q3 call",
      states: q3CallCycle(),
      anchorDate: day(0),
      provenance: "stated",
      notes: "From the program's own block document",
    });
    expect(pattern.cycle_days).toBe(3);

    const week = statesOver(pattern, day(0), day(6));
    expect(week).toHaveLength(7);
    // A q3 resident works every day; the cycle says which kind of day it is.
    expect(week.every((entry) => entry.state !== "off")).toBe(true);

    /* ---------------------------------------------------------------- 2 */
    /* The block, naming three people. None of them have accounts: this is the
       case that used to refuse the entire file. */
    const imported = await commitImport(admin.context, [
      {
        residentName: "Nadia Osei",
        pgy: 2,
        date: day(10),
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
        location: "ICU Tower 4",
        status: "confirmed",
      },
      {
        residentName: "Osei, Nadia",
        pgy: 2,
        date: day(12),
        startTime: "19:00",
        endTime: "07:00",
        endsNextDay: true,
        service: "MICU",
        location: "ICU Tower 4",
      },
      {
        residentName: "Tom Reyes",
        pgy: 3,
        date: day(11),
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
        location: "ICU Tower 4",
      },
    ]);

    expect(imported.createdShifts).toBe(0);
    expect(imported.heldRows).toBe(3);
    // Two spellings of one name are one person, and Tom is the other.
    expect(imported.heldPeople).toBe(2);

    const waiting = await listUnmatched(program.id);
    expect(waiting.map((person) => person.shifts).sort()).toEqual([1, 2]);

    /* ---------------------------------------------------------------- 3 */
    const link = await createEnrollmentLink(admin.context, {
      label: "PGY-2s and 3s, July block",
      expiresInDays: 30,
    });
    expect(link.url).toContain("/join/");
    expect(link.token.length).toBeGreaterThan(30);
  });

  it("lets a stranger join, find their schedule, correct it, and switch it", async () => {
    const service = (await queryOne<{ id: string }>(
      "SELECT id FROM services WHERE program_id = $1 AND name = 'MICU'",
      [program.id],
    ))!;
    await createRotationPattern({
      programId: program.id,
      serviceId: service.id,
      name: "MICU q3 call",
      states: q3CallCycle(),
      anchorDate: day(0),
      provenance: "stated",
    });

    /* The programme says what its own addresses look like, so its own people
       are admitted without an extra step. */
    await addEmailDomain(admin.context, "betahospital.org");

    await commitImport(admin.context, [
      {
        residentName: "Nadia Osei",
        pgy: 2,
        date: day(10),
        // The file says 07:00 and the block actually starts at 06:00 — the
        // single most common thing wrong with a schedule out of a spreadsheet.
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
        location: "ICU Tower 4",
      },
      {
        residentName: "Tom Reyes",
        pgy: 3,
        date: day(11),
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
        location: "ICU Tower 4",
      },
    ]);

    const link = await createEnrollmentLink(admin.context, { label: "July block" });

    /* ---------------------------------------------------------------- 4 */
    const joined = await enrollWithLink(link.token, {
      subject: "google-sub-nadia",
      email: "nadia.osei@betahospital.org",
      name: "Nadia Osei",
      picture: null,
    });
    expect(joined.outcome).toBe("enrolled");
    if (joined.outcome !== "enrolled") throw new Error("unreachable");
    // Her address is inside the program's own domain, so she is in outright.
    expect(joined.status).toBe("confirmed");

    /* ---------------------------------------------------------------- 5 */
    /* The whole reason held rows exist: she lands on her schedule, not on an
       empty screen, on her very first sign-in. */
    expect(joined.schedule.createdShifts).toBe(1);

    const nadia = await contextFor(joined.user.id);
    const herSchedule = await listResidentSchedule(nadia.resident.id, { limit: 20 });
    expect(herSchedule).toHaveLength(1);
    expect(herSchedule[0].service_name).toBe("MICU");
    expect(herSchedule[0].provenance).toBe("imported");

    // And nothing of hers is still waiting for somebody.
    const stillWaiting = await listUnmatched(program.id);
    expect(stillWaiting.map((person) => person.resident_name)).toEqual(["Tom Reyes"]);

    /* ---------------------------------------------------------------- 6 */
    const corrected = await correctOwnShift(nadia, herSchedule[0].id, {
      startTime: "06:00",
      endTime: "19:00",
    });
    expect(corrected.provenance).toBe("self_reported");
    expect(
      DateTime.fromJSDate(corrected.start_datetime)
        .setZone(program.timezone)
        .toFormat("HH:mm"),
    ).toBe("06:00");
    // Thirteen hours now, not twelve, and still one shift.
    expect(
      (corrected.end_datetime.getTime() - corrected.start_datetime.getTime()) / 3_600_000,
    ).toBe(13);

    /* ---------------------------------------------------------------- 7 */
    const posted = await postShiftForTrade(nadia, {
      shiftId: corrected.id,
      notes: "Family thing, happy to take anything back",
    });
    expect(posted.status).toBe("open");

    /* ---------------------------------------------------------------- 8 */
    /* Somebody else, with a shift of their own to offer. */
    const tom = await createResident(program, {
      email: "tom.reyes@betahospital.org",
      name: "Tom Reyes",
      pgy: 3,
    });
    const hisDate = day(20);
    const hisShift = (await queryOne<{ id: string }>(
      `INSERT INTO shifts
         (program_id, service_id, date, start_datetime, end_datetime, location,
          shift_type, provenance)
       VALUES ($1, $2, $3, $4, $5, 'ICU Tower 4', 'day', 'imported')
       RETURNING id`,
      [
        program.id,
        service.id,
        hisDate,
        zonedWallTimeToInstant(hisDate, "07:00", program.timezone),
        zonedWallTimeToInstant(hisDate, "19:00", program.timezone),
      ],
    ))!;
    await query("INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)", [
      hisShift.id,
      tom.resident.id,
    ]);

    const offer = await createOffer(tom.context, {
      tradeRequestId: posted.id,
      offeredShiftId: hisShift.id,
    });

    const accepted = await acceptOffer(nadia, offer.offer.id);
    expect(accepted.status).toBe("completed");

    /* Both schedules moved, in one transaction, and the database says so. */
    const hers = await listResidentSchedule(nadia.resident.id, { limit: 20 });
    const his = await listResidentSchedule(tom.resident.id, { limit: 20 });
    expect(hers.map((shift) => shift.id)).toEqual([hisShift.id]);
    expect(his.map((shift) => shift.id)).toEqual([corrected.id]);

    /* The shift Tom now holds still says the resident entered those hours.
       Changing hands does not make somebody else's word the program's. */
    expect(his[0].provenance).toBe("self_reported");

    await assertDatabaseConsistent();
  });

  it("lets somebody with an outside address in, but only as far as their own schedule", async () => {
    /* No domains listed for this program at all, which is the honest "we do not
       know what your addresses look like" case. */
    await commitImport(admin.context, [
      {
        residentName: "Sam Okafor",
        pgy: 1,
        date: day(9),
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
      },
    ]);
    const link = await createEnrollmentLink(admin.context, {});

    const joined = await enrollWithLink(
      link.token,
      {
        subject: "google-sub-sam",
        email: "sam.okafor@gmail.invalid",
        name: "Sam Okafor",
        picture: null,
      },
      { ip: "203.0.113.9" },
    );
    expect(joined.outcome).toBe("enrolled");
    if (joined.outcome !== "enrolled") throw new Error("unreachable");
    expect(joined.status).toBe("pending");

    /* They still land on their schedule — refusing them outright would send a
       real resident away at the one moment they were willing to sign up. */
    expect(joined.schedule.createdShifts).toBe(1);
    const sam = await contextFor(joined.user.id);
    expect(await listResidentSchedule(sam.resident.id, { limit: 5 })).toHaveLength(1);

    /* …and they can fix their own hours, and nothing else. */
    expect(allowsWhilePending(sam.user.enrollmentStatus, "shifts.self_report")).toBe(true);
    expect(allowsWhilePending(sam.user.enrollmentStatus, "trade.participate")).toBe(false);

    /* The administrator sees them waiting, with enough to recognise them. */
    const waiting = await listPendingMembers(program.id);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].email).toBe("sam.okafor@gmail.invalid");
    expect(waiting[0].shifts).toBe(1);

    /* The board is the largest "anybody else" in the product, and the screen
       that shows a slice of it is `requirePageUser` rather than a capability —
       so the capability guard cannot reach it and the rule has to be applied
       where the data is fetched. Asserted here because a hole in it would be
       silent: the screen would simply work.

       Something has to be *on* the board for the assertion to mean anything, so
       a confirmed colleague posts a shift first. Without that, "sees nothing"
       and "there is nothing" are the same observation. */
    const other = await createResident(program, {
      email: "confirmed@betahospital.org",
      name: "Confirmed Person",
    });
    const posterDate = day(30);
    const posterShift = (await queryOne<{ id: string }>(
      `INSERT INTO shifts (program_id, service_id, date, start_datetime, end_datetime,
                           shift_type, provenance)
       VALUES ($1, (SELECT id FROM services WHERE program_id = $1 AND name = 'MICU'),
               $2, $3, $4, 'day', 'imported')
       RETURNING id`,
      [
        program.id,
        posterDate,
        zonedWallTimeToInstant(posterDate, "07:00", program.timezone),
        zonedWallTimeToInstant(posterDate, "19:00", program.timezone),
      ],
    ))!;
    await query("INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)", [
      posterShift.id,
      other.resident.id,
    ]);
    await postShiftForTrade(other.context, { shiftId: posterShift.id });

    /* A third person, because the board never shows you your own posting: with
       only the poster to compare against, "sees nothing" would be true of
       everybody and prove nothing. */
    const bystander = await createResident(program, {
      email: "bystander@betahospital.org",
      name: "Bystander Person",
    });
    expect((await getResidentDashboard(bystander.context)).availableTrades).toHaveLength(1);
    expect((await getResidentDashboard(sam)).availableTrades).toHaveLength(0);

    /* Admitted, and the same call now answers differently — which is what makes
       the restriction a restriction rather than an accident of this fixture. */
    await admitMember(admin.context, joined.user.id);
    const after = await contextFor(joined.user.id);
    expect(after.user.enrollmentStatus).toBe("confirmed");
    expect(allowsWhilePending(after.user.enrollmentStatus, "trade.participate")).toBe(true);
    expect((await getResidentDashboard(after)).availableTrades).toHaveLength(1);

    /* Every enrollment is recorded, including why it landed the way it did. */
    const events = await listEnrollmentEvents(program.id);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("pending");
    expect(events[0].detail).toMatch(/domain not recognised/);
  });

  it("refuses a revoked link without telling the holder anything useful", async () => {
    const link = await createEnrollmentLink(admin.context, {});
    await query("UPDATE enrollment_links SET revoked_at = now() WHERE id = $1", [
      link.link.id,
    ]);

    const refused = await enrollWithLink(link.token, {
      subject: "google-sub-stranger",
      email: "stranger@elsewhere.invalid",
      name: "A Stranger",
      picture: null,
    });
    expect(refused.outcome).toBe("refused");
    if (refused.outcome !== "refused") throw new Error("unreachable");
    expect(refused.reason).toBe("revoked");

    // Nothing was created, and the attempt is on the record.
    expect(await query("SELECT id FROM users WHERE email = 'stranger@elsewhere.invalid'"))
      .toHaveLength(0);
    const events = await listEnrollmentEvents(program.id);
    expect(events[0].outcome).toBe("refused");
  });

  it("does not hand a claimed schedule to the next person with a similar name", async () => {
    /* The failure this whole matching scheme has to not have. "Nadia Osei" and
       "Nadia Okafor" are two residents, and one of them getting the other's
       call is the worst outcome available here. */
    await commitImport(admin.context, [
      {
        residentName: "Nadia Osei",
        date: day(10),
        startTime: "07:00",
        endTime: "19:00",
        service: "MICU",
      },
    ]);
    const link = await createEnrollmentLink(admin.context, {});

    const other = await enrollWithLink(link.token, {
      subject: "google-sub-okafor",
      email: "nadia.okafor@betahospital.org",
      name: "Nadia Okafor",
      picture: null,
    });
    expect(other.outcome).toBe("enrolled");
    if (other.outcome !== "enrolled") throw new Error("unreachable");
    expect(other.schedule.claimedRows).toBe(0);

    // Still waiting for the person it actually names.
    expect(await listUnmatched(program.id)).toHaveLength(1);
  });

  it("attaches a rotation cycle to the people on it without a pattern each", async () => {
    /* Two residents on one q3 service are two days apart. That is the whole
       content of an offset, and it is what stops a programme needing one
       pattern per person. */
    const service = (await queryOne<{ id: string }>(
      "SELECT id FROM services WHERE program_id = $1 AND name = 'MICU'",
      [program.id],
    ))!;
    const pattern = await createRotationPattern({
      programId: program.id,
      serviceId: service.id,
      name: "MICU q3 call",
      states: q3CallCycle(),
      anchorDate: day(0),
      provenance: "stated",
    });

    const one = await createResident(program, { email: "one@betahospital.org", pgy: 2 });
    const two = await createResident(program, { email: "two@betahospital.org", pgy: 2 });
    await withTransaction(async (client) => {
      await setPatternMember(pattern.id, one.resident.id, 0, null, client);
      await setPatternMember(pattern.id, two.resident.id, 1, null, client);
    });

    const members = await query<{ offset_days: number }>(
      "SELECT offset_days FROM rotation_pattern_members WHERE pattern_id = $1 ORDER BY offset_days",
      [pattern.id],
    );
    expect(members.map((row) => row.offset_days)).toEqual([0, 1]);

    // On the day the first is on call, the second is post-call.
    expect(statesOver(pattern, day(0), day(0), 0)[0].state).toBe("on");
    expect(statesOver(pattern, day(0), day(0), 1)[0].state).toBe("post");
  });
});
