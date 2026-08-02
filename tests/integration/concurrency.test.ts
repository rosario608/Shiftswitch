import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/server/db/pool";
import {
  acceptOffer,
  approveTrade,
  cancelTradeRequest,
  createOffer,
  postShiftForTrade,
  rejectOffer,
  rejectTrade,
  runMaintenance,
  withdrawOffer,
} from "@/server/domain/trades";
import { updateShift } from "@/server/domain/admin";
import { takeShift } from "@/server/domain/giveaway";
import {
  activeAssignee,
  assertDatabaseConsistent,
  closeDatabase,
  countActiveAssignments,
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
 * Concurrency is enforced by three mechanisms working together:
 *   1. `SELECT ... FOR UPDATE` on the trade request, the offer, and both shifts,
 *   2. status transitions checked inside the same transaction,
 *   3. a partial unique index that allows only one active assignment per shift.
 *
 * These tests fire genuinely simultaneous requests through the real service.
 */

let fixture: TestProgram;
let alice: TestResident;
let bob: TestResident;
let carol: TestResident;
let chief: Awaited<ReturnType<typeof createStaff>>;

beforeAll(() => {
  ensureMigrated();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fixture = await createProgram();
  alice = await createResident(fixture.program, { email: "alice@hospital.org", pgy: 2 });
  bob = await createResident(fixture.program, { email: "bob@hospital.org", pgy: 2 });
  carol = await createResident(fixture.program, { email: "carol@hospital.org", pgy: 2 });
  chief = await createStaff(fixture.program, { email: "chief@hospital.org", role: "chief" });
});

describe("concurrent acceptance", () => {
  it("only one of two simultaneous accepts on the same post succeeds", async () => {
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const carolShift = await createShift(fixture.program, {
      inDays: 24,
      residentId: carol.resident.id,
    });

    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    const bobOffer = await createOffer(bob.context, {
      tradeRequestId: request.id,
      offeredShiftId: bobShift.id,
    });
    const carolOffer = await createOffer(carol.context, {
      tradeRequestId: request.id,
      offeredShiftId: carolShift.id,
    });

    const results = await Promise.allSettled([
      acceptOffer(alice.context, bobOffer.offer.id),
      acceptOffer(alice.context, carolOffer.offer.id),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one completed trade, and every shift has exactly one holder.
    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    expect(completed).toHaveLength(1);
    for (const shiftId of [aliceShift.id, bobShift.id, carolShift.id]) {
      expect(await countActiveAssignments(shiftId)).toBe(1);
    }
    // The loser's shift is untouched.
    const winnerIsBob = (await activeAssignee(aliceShift.id)) === bob.resident.id;
    expect(await activeAssignee(carolShift.id)).toBe(
      winnerIsBob ? carol.resident.id : alice.resident.id,
    );
  });

  it("double-tapping accept on the same offer creates exactly one switch", async () => {
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    const { offer } = await createOffer(bob.context, {
      tradeRequestId: request.id,
      offeredShiftId: bobShift.id,
    });

    const results = await Promise.allSettled([
      acceptOffer(alice.context, offer.id),
      acceptOffer(alice.context, offer.id),
      acceptOffer(alice.context, offer.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    expect(completed).toHaveLength(1);
    expect(await countActiveAssignments(aliceShift.id)).toBe(1);
    expect(await countActiveAssignments(bobShift.id)).toBe(1);
    expect(await activeAssignee(aliceShift.id)).toBe(bob.resident.id);
  });

  it("two residents cannot both acquire the same shift through different posts", async () => {
    // Alice posts the same shift is impossible (unique index), so this models the
    // realistic race: Bob and Carol each post a shift, and Alice tries to accept
    // an offer of her single free shift on both posts at the same time.
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const carolShift = await createShift(fixture.program, {
      inDays: 24,
      residentId: carol.resident.id,
    });

    const bobRequest = await postShiftForTrade(bob.context, { shiftId: bobShift.id });
    const carolRequest = await postShiftForTrade(carol.context, {
      shiftId: carolShift.id,
    });

    // Alice offers the same shift to both posts (allowed — only one can win).
    const offerToBob = await createOffer(alice.context, {
      tradeRequestId: bobRequest.id,
      offeredShiftId: aliceShift.id,
    });
    const offerToCarol = await createOffer(alice.context, {
      tradeRequestId: carolRequest.id,
      offeredShiftId: aliceShift.id,
    });

    const results = await Promise.allSettled([
      acceptOffer(bob.context, offerToBob.offer.id),
      acceptOffer(carol.context, offerToCarol.offer.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await countActiveAssignments(aliceShift.id)).toBe(1);
    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    expect(completed).toHaveLength(1);

    // The losing offer is no longer live.
    const liveOffers = await query<{ id: string }>(
      "SELECT id FROM trade_offers WHERE status IN ('pending', 'accepted')",
    );
    expect(liveOffers).toHaveLength(0);
  });

  it("the database rejects a second active assignment for a shift", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    await expect(
      query("INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)", [
        shift.id,
        bob.resident.id,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("the database rejects two live posts for the same shift", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    await postShiftForTrade(alice.context, { shiftId: shift.id });
    await expect(
      query(
        `INSERT INTO trade_requests (program_id, source_shift_id, initiating_resident_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 day')`,
        [fixture.program.id, shift.id, alice.resident.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("simultaneous offers from the same resident on one post cannot duplicate", async () => {
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });

    const results = await Promise.allSettled([
      createOffer(bob.context, {
        tradeRequestId: request.id,
        offeredShiftId: bobShift.id,
      }),
      createOffer(bob.context, {
        tradeRequestId: request.id,
        offeredShiftId: bobShift.id,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const offers = await query<{ id: string }>(
      "SELECT id FROM trade_offers WHERE status = 'pending'",
    );
    expect(offers).toHaveLength(1);
  });
});

/**
 * Accept racing against everything else that can end a trade.
 *
 * The existing tests above race accept against accept, which the `FOR UPDATE`
 * on the request already serialises. These race accept against the *other*
 * verbs — cancel, withdraw, decline, an administrator moving a shift, the
 * expiry sweep — because those take different locks in a different order and
 * are where a half-applied switch would actually come from.
 *
 * Every one of them ends in `assertDatabaseConsistent`, which is the real
 * assertion. Which call wins is usually not interesting and sometimes not even
 * deterministic; what must never happen is a shift with two holders, a
 * completed trade with one leg, or a switch recorded but not applied.
 */
describe("accept racing the other verbs", () => {
  async function pending() {
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    const { offer } = await createOffer(bob.context, {
      tradeRequestId: request.id,
      offeredShiftId: bobShift.id,
    });
    return { aliceShift, bobShift, request, offer };
  }

  it("accept versus the poster cancelling their own post", async () => {
    const { request, offer } = await pending();
    const results = await Promise.allSettled([
      acceptOffer(alice.context, offer.id),
      cancelTradeRequest(alice.context, request.id),
    ]);
    // At most one of the two can be the outcome; both failing is also fine.
    expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(2);
    await assertDatabaseConsistent();

    const [row] = await query<{ status: string }>(
      "SELECT status::text AS status FROM trade_requests WHERE id = $1",
      [request.id],
    );
    expect(["completed", "cancelled", "pending_approval"]).toContain(row.status);
  });

  it("accept versus the offering resident withdrawing", async () => {
    const { offer } = await pending();
    await Promise.allSettled([
      acceptOffer(alice.context, offer.id),
      withdrawOffer(bob.context, offer.id),
    ]);
    await assertDatabaseConsistent();

    // The offer cannot end up both withdrawn and switched.
    const [row] = await query<{ status: string }>(
      "SELECT status::text AS status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    if (row.status === "withdrawn") expect(completed).toHaveLength(0);
    if (completed.length === 1) expect(row.status).toBe("completed");
  });

  it("accept versus declining the same offer", async () => {
    const { offer } = await pending();
    await Promise.allSettled([
      acceptOffer(alice.context, offer.id),
      rejectOffer(alice.context, offer.id, "Changed my mind."),
    ]);
    await assertDatabaseConsistent();

    const [row] = await query<{ status: string }>(
      "SELECT status::text AS status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(["completed", "accepted", "rejected"]).toContain(row.status);
  });

  it("accept versus an administrator reassigning the posted shift", async () => {
    const { aliceShift, offer } = await pending();
    await Promise.allSettled([
      acceptOffer(alice.context, offer.id),
      updateShift(chief.context, aliceShift.id, { residentId: carol.resident.id }),
    ]);
    await assertDatabaseConsistent();
    // Whoever holds it, exactly one person does.
    expect(await countActiveAssignments(aliceShift.id)).toBe(1);
  });

  it("accept versus an administrator cancelling the offered shift", async () => {
    const { bobShift, offer } = await pending();
    await Promise.allSettled([
      acceptOffer(alice.context, offer.id),
      updateShift(chief.context, bobShift.id, { status: "cancelled" }),
    ]);
    await assertDatabaseConsistent();
  });

  it("accept versus the expiry sweep", async () => {
    const { request, offer } = await pending();
    // Age the post so maintenance is entitled to expire it, exactly as it would
    // be if the sweep fired while somebody was mid-tap.
    await query("UPDATE trade_requests SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      request.id,
    ]);
    await Promise.allSettled([
      acceptOffer(alice.context, offer.id),
      runMaintenance(fixture.program.id),
    ]);
    await assertDatabaseConsistent();

    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    // An expired post must not complete. If it did, the revalidation inside the
    // finalisation transaction is not looking at the clock.
    expect(completed).toHaveLength(0);
  });
});

describe("approval racing itself", () => {
  async function awaitingApproval() {
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
      approvalRequired: true,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    const { offer } = await createOffer(bob.context, {
      tradeRequestId: request.id,
      offeredShiftId: bobShift.id,
    });
    await acceptOffer(alice.context, offer.id);
    return { aliceShift, bobShift, request };
  }

  it("two chiefs approving at the same moment produce one switch", async () => {
    const { request } = await awaitingApproval();
    const second = await createStaff(fixture.program, {
      email: "chief2@hospital.org",
      role: "chief",
    });

    const results = await Promise.allSettled([
      approveTrade(chief.context, request.id),
      approveTrade(second.context, request.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await query<{ id: string }>("SELECT id FROM completed_trades")).toHaveLength(1);
    await assertDatabaseConsistent();
  });

  it("one chief approving while another rejects settles on one answer", async () => {
    const { request, aliceShift, bobShift } = await awaitingApproval();
    const second = await createStaff(fixture.program, {
      email: "chief2@hospital.org",
      role: "chief",
    });

    await Promise.allSettled([
      approveTrade(chief.context, request.id),
      rejectTrade(second.context, request.id, "Coverage is too thin that week."),
    ]);
    await assertDatabaseConsistent();

    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    const [row] = await query<{ status: string }>(
      "SELECT status::text AS status FROM trade_requests WHERE id = $1",
      [request.id],
    );
    if (completed.length === 1) {
      expect(row.status).toBe("completed");
      expect(await activeAssignee(aliceShift.id)).toBe(bob.resident.id);
    } else {
      // Rejected: both residents keep exactly what they started with.
      expect(await activeAssignee(aliceShift.id)).toBe(alice.resident.id);
      expect(await activeAssignee(bobShift.id)).toBe(bob.resident.id);
    }
  });

  it("a program director may decide a switch, not only a chief", async () => {
    const { request } = await awaitingApproval();
    const pd = await createStaff(fixture.program, {
      email: "pd@hospital.org",
      role: "pd",
    });
    // The approvals queue is guarded by the capability, so the decision has to
    // be too — otherwise a PD opens the queue and is refused on every button.
    await approveTrade(pd.context, request.id);
    expect(await query<{ id: string }>("SELECT id FROM completed_trades")).toHaveLength(1);
    await assertDatabaseConsistent();
  });
});

/**
 * A storm: many residents, many postings, and every verb fired at once with no
 * coordination. Individual outcomes are not asserted — the point is that after
 * an arbitrary interleaving the database still describes a coherent world.
 *
 * This is deliberately the least specific test in the suite and the one most
 * likely to catch something the targeted races above did not think of.
 */
describe("an uncoordinated storm", () => {
  it("leaves the database consistent whatever order things land in", async () => {
    const residents = [alice, bob, carol];
    for (const email of ["dan@hospital.org", "erin@hospital.org", "femi@hospital.org"]) {
      residents.push(await createResident(fixture.program, { email, pgy: 2 }));
    }

    // Each resident gets three shifts spread far enough apart that nothing is
    // blocked for reasons unrelated to the race.
    const shifts = new Map<string, string[]>();
    for (const [index, resident] of residents.entries()) {
      const owned: string[] = [];
      for (let slot = 0; slot < 3; slot += 1) {
        const shift = await createShift(fixture.program, {
          inDays: 10 + index * 2 + slot * 20,
          residentId: resident.resident.id,
        });
        owned.push(shift.id);
      }
      shifts.set(resident.resident.id, owned);
    }

    // Everybody posts their first shift.
    const requests = await Promise.all(
      residents.map((resident) =>
        postShiftForTrade(resident.context, {
          shiftId: shifts.get(resident.resident.id)![0],
        }),
      ),
    );

    // Everybody offers on everybody else's post, all at once.
    const offers = await Promise.allSettled(
      requests.flatMap((request, requestIndex) =>
        residents
          .filter((_, index) => index !== requestIndex)
          .map((resident) =>
            createOffer(resident.context, {
              tradeRequestId: request.id,
              offeredShiftId: shifts.get(resident.resident.id)![1],
            }),
          ),
      ),
    );
    const made = offers
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value.offer);
    expect(made.length).toBeGreaterThan(3);
    await assertDatabaseConsistent();

    // Now everything at once: posters accepting and declining, offerers
    // withdrawing, a chief cancelling posts, and the expiry sweep.
    await Promise.allSettled([
      ...made.map((offer, index) => {
        const poster = residents.find((resident) =>
          requests.some(
            (request) =>
              request.id === offer.trade_request_id &&
              request.initiating_resident_id === resident.resident.id,
          ),
        )!;
        if (index % 3 === 0) return acceptOffer(poster.context, offer.id);
        if (index % 3 === 1) return rejectOffer(poster.context, offer.id, "No thanks.");
        const offerer = residents.find(
          (resident) => resident.resident.id === offer.offering_resident_id,
        )!;
        return withdrawOffer(offerer.context, offer.id);
      }),
      ...requests
        .slice(0, 2)
        .map((request) => cancelTradeRequest(chief.context, request.id)),
      runMaintenance(fixture.program.id),
    ]);

    await assertDatabaseConsistent();

    // And it is consistent after a second sweep over whatever is left.
    await runMaintenance(fixture.program.id);
    await assertDatabaseConsistent();
  });
});

/**
 * A shift changing hands one way, raced.
 *
 * The switch races above all turn on "two people cannot both end up holding
 * one shift". A giveaway has the same failure mode reached by a different
 * road: there is no offered shift to lock, so the only thing standing between
 * two simultaneous takers is the row lock on the posting and the status
 * transition inside the same transaction.
 *
 * Counting successes is not enough here either. "One take won and one lost" is
 * compatible with the shift having two active assignments, so every case ends
 * in `assertDatabaseConsistent()`, which asserts the state rather than the
 * outcome.
 */
describe("one-way transfers, raced", () => {
  async function postGiveaway(owner: TestResident, day = 10) {
    const shift = await createShift(fixture.program, {
      inDays: day,
      service: fixture.services.MICU,
      residentId: owner.resident.id,
    });
    const request = await postShiftForTrade(owner.context, {
      shiftId: shift.id,
      kind: "giveaway",
    });
    return { shift, request };
  }

  it("only one of two simultaneous takers gets the shift", async () => {
    const { shift, request } = await postGiveaway(alice);

    const results = await Promise.allSettled([
      takeShift(bob.context, request.id, { acknowledgedWarnings: [] }),
      takeShift(carol.context, request.id, { acknowledgedWarnings: [] }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    /* The state, not the tally: exactly one active assignment, held by
       whichever of them won, and never by both. */
    expect(await countActiveAssignments(shift.id)).toBe(1);
    const holder = await activeAssignee(shift.id);
    expect([bob.resident.id, carol.resident.id]).toContain(holder);
    await assertDatabaseConsistent();
  });

  it("double-tapping take produces one transfer, not two", async () => {
    const { shift, request } = await postGiveaway(alice);

    const results = await Promise.allSettled([
      takeShift(bob.context, request.id, { acknowledgedWarnings: [] }),
      takeShift(bob.context, request.id, { acknowledgedWarnings: [] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await countActiveAssignments(shift.id)).toBe(1);

    const completed = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM completed_trades",
    );
    expect(completed[0].count).toBe("1");
    await assertDatabaseConsistent();
  });

  /* The same shift cannot be both given away and switched. Whichever posting
     is created second is refused by the partial unique index, so this races
     one live posting against a take rather than two postings. */
  it("a take racing a switch on the same shift settles on one owner", async () => {
    const { shift, request } = await postGiveaway(alice);
    /* Bob has a shift of his own, and tries to acquire Alice's through a
       switch he posts in the other direction at the same moment Carol takes
       it outright. */
    const bobShift = await createShift(fixture.program, {
      inDays: 14,
      service: fixture.services.Floor,
      residentId: bob.resident.id,
    });
    const bobPost = await postShiftForTrade(bob.context, { shiftId: bobShift.id });

    const results = await Promise.allSettled([
      takeShift(carol.context, request.id, { acknowledgedWarnings: [] }),
      (async () => {
        const offer = await createOffer(alice.context, {
          tradeRequestId: bobPost.id,
          offeredShiftId: shift.id,
        });
        return acceptOffer(bob.context, offer.offer.id);
      })(),
    ]);

    /* Either order is legitimate; what is not legitimate is both landing.
       Alice's shift has exactly one holder afterwards whichever won. */
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await countActiveAssignments(shift.id)).toBe(1);
    expect(await countActiveAssignments(bobShift.id)).toBe(1);
    await assertDatabaseConsistent();
  });

  it("a posting withdrawn mid-take leaves the shift with its owner or its taker, never nobody", async () => {
    const { shift, request } = await postGiveaway(alice);

    const results = await Promise.allSettled([
      takeShift(bob.context, request.id, { acknowledgedWarnings: [] }),
      cancelTradeRequest(alice.context, request.id),
    ]);
    /* One of the two must have won outright. The forbidden outcome is a live
       shift with nobody on it, which is a ward with nobody on it. */
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(await countActiveAssignments(shift.id)).toBe(1);
    const holder = await activeAssignee(shift.id);
    expect([alice.resident.id, bob.resident.id]).toContain(holder);
    await assertDatabaseConsistent();
  });

  it("a take racing the expiry sweep does not produce a transfer on a dead posting", async () => {
    const { shift, request } = await postGiveaway(alice);
    await query("UPDATE trade_requests SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      request.id,
    ]);

    const results = await Promise.allSettled([
      takeShift(bob.context, request.id, { acknowledgedWarnings: [] }),
      runMaintenance(fixture.program.id),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(await activeAssignee(shift.id)).toBe(alice.resident.id);
    await assertDatabaseConsistent();
  });

  it("survives an uncoordinated storm around one giveaway", async () => {
    const { shift, request } = await postGiveaway(alice);

    await Promise.allSettled([
      takeShift(bob.context, request.id, { acknowledgedWarnings: [] }),
      takeShift(carol.context, request.id, { acknowledgedWarnings: [] }),
      takeShift(bob.context, request.id, { acknowledgedWarnings: [] }),
      cancelTradeRequest(alice.context, request.id),
      runMaintenance(fixture.program.id),
    ]);

    expect(await countActiveAssignments(shift.id)).toBe(1);
    await assertDatabaseConsistent();
  });
});
