import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/server/db/pool";
import { acceptOffer, createOffer, postShiftForTrade } from "@/server/domain/trades";
import {
  activeAssignee,
  closeDatabase,
  countActiveAssignments,
  createProgram,
  createResident,
  createShift,
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
