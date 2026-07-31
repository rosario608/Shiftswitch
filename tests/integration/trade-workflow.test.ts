import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "@/server/db/pool";
import { AppError } from "@/server/http/errors";
import {
  acceptOffer,
  approveTrade,
  cancelTradeRequest,
  createOffer,
  getCompletedTrade,
  postShiftForTrade,
  rejectOffer,
  rejectTrade,
  requestTradeChanges,
  runMaintenance,
  withdrawOffer,
} from "@/server/domain/trades";
import { updateShift } from "@/server/domain/admin";
import { getOfferCandidates } from "@/server/domain/candidates";
import {
  activeAssignee,
  addRule,
  auditActions,
  closeDatabase,
  countActiveAssignments,
  createProgram,
  createResident,
  createShift,
  createStaff,
  ensureMigrated,
  notificationsFor,
  resetDatabase,
  type TestProgram,
  type TestResident,
} from "./helpers";

let fixture: TestProgram;
let alice: TestResident;
let bob: TestResident;
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
  alice = await createResident(fixture.program, {
    email: "alice@hospital.org",
    name: "Alice Adeyemi",
    pgy: 2,
    credentials: ["BLS", "ACLS", "Critical Care"],
  });
  bob = await createResident(fixture.program, {
    email: "bob@hospital.org",
    name: "Bob Brennan",
    pgy: 2,
    credentials: ["BLS", "ACLS", "Critical Care"],
  });
  chief = await createStaff(fixture.program, {
    email: "chief@hospital.org",
    role: "chief",
    name: "Casey Chief",
  });
});

async function setupTrade(options: { approvalRequired?: boolean } = {}) {
  const aliceShift = await createShift(fixture.program, {
    inDays: 10,
    residentId: alice.resident.id,
    approvalRequired: options.approvalRequired,
  });
  const bobShift = await createShift(fixture.program, {
    inDays: 17,
    residentId: bob.resident.id,
  });
  const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
  const { offer, validation } = await createOffer(bob.context, {
    tradeRequestId: request.id,
    offeredShiftId: bobShift.id,
  });
  return { aliceShift, bobShift, request, offer, validation };
}

describe("posting a shift", () => {
  it("posts a shift and marks it as posted", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const request = await postShiftForTrade(alice.context, {
      shiftId: shift.id,
      notes: "Family event",
      preferences: { preferredShiftTypes: ["night"] },
    });
    expect(request.status).toBe("open");
    const updated = await queryOne<{ status: string }>(
      "SELECT status FROM shifts WHERE id = $1",
      [shift.id],
    );
    expect(updated?.status).toBe("posted");
    expect(await auditActions()).toContain("trade.posted");
  });

  it("refuses to post a shift that belongs to someone else", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: bob.resident.id,
    });
    await expect(
      postShiftForTrade(alice.context, { shiftId: shift.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses to post a non-tradeable shift", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
      tradeable: false,
    });
    await expect(
      postShiftForTrade(alice.context, { shiftId: shift.id }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses to post the same shift twice", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    await postShiftForTrade(alice.context, { shiftId: shift.id });
    await expect(
      postShiftForTrade(alice.context, { shiftId: shift.id }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses to post a shift whose trade deadline has passed", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
      tradeDeadline: new Date(Date.now() - 3_600_000),
    });
    await expect(
      postShiftForTrade(alice.context, { shiftId: shift.id }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("offers", () => {
  it("creates an offer, notifies the poster and stores the validation snapshot", async () => {
    const { request, offer, validation } = await setupTrade();
    expect(offer.status).toBe("pending");
    expect(validation.valid).toBe(true);
    const notifications = await notificationsFor(alice.user.id);
    expect(notifications.map((n) => n.type)).toContain("offer.created");
    const stored = await queryOne<{ validation_snapshot: { valid: boolean } }>(
      "SELECT validation_snapshot FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(stored?.validation_snapshot.valid).toBe(true);
    const updatedRequest = await queryOne<{ status: string }>(
      "SELECT status FROM trade_requests WHERE id = $1",
      [request.id],
    );
    expect(updatedRequest?.status).toBe("offer_pending");
  });

  it("rejects an offer that breaks a rest rule, with an explanation", async () => {
    await addRule(fixture.program, "min_rest_hours", { hours: 10 });
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    // Bob's shift starts the morning after a night Alice already works.
    await createShift(fixture.program, {
      inDays: 16,
      residentId: alice.resident.id,
      startTime: "19:00",
      endTime: "07:00",
      overnight: true,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
      startTime: "07:00",
      endTime: "19:00",
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    await expect(
      createOffer(bob.context, {
        tradeRequestId: request.id,
        offeredShiftId: bobShift.id,
      }),
    ).rejects.toMatchObject({ code: "rule_violation" });
  });

  it("refuses an offer on your own post", async () => {
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const otherAliceShift = await createShift(fixture.program, {
      inDays: 20,
      residentId: alice.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    await expect(
      createOffer(alice.context, {
        tradeRequestId: request.id,
        offeredShiftId: otherAliceShift.id,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses to offer a shift assigned to someone else", async () => {
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const carolShift = await createShift(fixture.program, { inDays: 20 });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    await expect(
      createOffer(bob.context, {
        tradeRequestId: request.id,
        offeredShiftId: carolShift.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("declines an offer and reopens the post", async () => {
    const { request, offer } = await setupTrade();
    await rejectOffer(alice.context, offer.id, "Need a day shift");
    const updated = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(updated?.status).toBe("rejected");
    const reopened = await queryOne<{ status: string }>(
      "SELECT status FROM trade_requests WHERE id = $1",
      [request.id],
    );
    expect(reopened?.status).toBe("open");
    const notifications = await notificationsFor(bob.user.id);
    expect(notifications.some((n) => n.body.includes("Need a day shift"))).toBe(true);
  });

  it("lets the offering resident withdraw", async () => {
    const { offer } = await setupTrade();
    await withdrawOffer(bob.context, offer.id);
    const updated = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(updated?.status).toBe("withdrawn");
  });

  it("only lets the poster decline an offer", async () => {
    const { offer } = await setupTrade();
    await expect(rejectOffer(bob.context, offer.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("atomic finalisation", () => {
  it("swaps both assignments in a single transaction", async () => {
    const { aliceShift, bobShift, offer } = await setupTrade();
    const outcome = await acceptOffer(alice.context, offer.id);
    expect(outcome.status).toBe("completed");

    expect(await activeAssignee(aliceShift.id)).toBe(bob.resident.id);
    expect(await activeAssignee(bobShift.id)).toBe(alice.resident.id);
    expect(await countActiveAssignments(aliceShift.id)).toBe(1);
    expect(await countActiveAssignments(bobShift.id)).toBe(1);

    const ended = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM shift_assignments WHERE assignment_status = 'ended'",
    );
    expect(Number(ended[0].count)).toBe(2);
  });

  it("records a completed trade with both legs and the previous assignments", async () => {
    const { aliceShift, bobShift, offer } = await setupTrade();
    const outcome = await acceptOffer(alice.context, offer.id);
    if (outcome.status !== "completed") throw new Error("expected completion");

    const trade = await getCompletedTrade(outcome.completedTradeId, fixture.program.id);
    expect(trade?.source_shift_id).toBe(aliceShift.id);
    expect(trade?.destination_shift_id).toBe(bobShift.id);
    expect(trade?.previous_assignments).toMatchObject({
      [aliceShift.id]: alice.resident.id,
      [bobShift.id]: bob.resident.id,
    });
    expect(trade?.resulting_assignments).toMatchObject({
      [aliceShift.id]: bob.resident.id,
      [bobShift.id]: alice.resident.id,
    });

    const legs = await query<{ leg_index: number; shift_id: string }>(
      "SELECT leg_index, shift_id FROM trade_legs WHERE completed_trade_id = $1 ORDER BY leg_index",
      [outcome.completedTradeId],
    );
    expect(legs).toHaveLength(2);
  });

  it("writes audit records and notifies both residents", async () => {
    const { offer } = await setupTrade();
    await acceptOffer(alice.context, offer.id);
    const actions = await auditActions();
    expect(actions).toContain("offer.accepted");
    expect(actions).toContain("trade.completed");
    expect(actions.filter((action) => action === "shift.reassigned")).toHaveLength(2);
    for (const user of [alice.user.id, bob.user.id]) {
      const notifications = await notificationsFor(user);
      expect(notifications.some((n) => n.type === "switch.completed")).toBe(true);
    }
  });

  it("returns the shifts to scheduled status after the switch", async () => {
    const { aliceShift, bobShift, offer } = await setupTrade();
    await acceptOffer(alice.context, offer.id);
    const statuses = await query<{ status: string }>(
      "SELECT status FROM shifts WHERE id = ANY($1::uuid[])",
      [[aliceShift.id, bobShift.id]],
    );
    expect(statuses.every((row) => row.status === "scheduled")).toBe(true);
  });

  it("invalidates competing offers and tells those residents why", async () => {
    const carol = await createResident(fixture.program, {
      email: "carol@hospital.org",
      name: "Carol Costa",
      pgy: 2,
    });
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const carolShift = await createShift(fixture.program, {
      inDays: 21,
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

    await acceptOffer(alice.context, bobOffer.offer.id);

    const carolStatus = await queryOne<{ status: string; invalidation_reason: string }>(
      "SELECT status, invalidation_reason FROM trade_offers WHERE id = $1",
      [carolOffer.offer.id],
    );
    expect(carolStatus?.status).toBe("invalidated");
    expect(carolStatus?.invalidation_reason).toContain("another completed trade");
    const carolNotifications = await notificationsFor(carol.user.id);
    expect(carolNotifications.some((n) => n.type === "offer.invalidated")).toBe(true);
  });

  it("rejects a second accept of the same offer (double submission)", async () => {
    const { offer } = await setupTrade();
    await acceptOffer(alice.context, offer.id);
    await expect(acceptOffer(alice.context, offer.id)).rejects.toMatchObject({
      code: "conflict",
    });
    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    expect(completed).toHaveLength(1);
  });

  it("only lets the poster accept", async () => {
    const { offer } = await setupTrade();
    await expect(acceptOffer(bob.context, offer.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("rejects an expired offer", async () => {
    const { offer } = await setupTrade();
    await query("UPDATE trade_offers SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      offer.id,
    ]);
    await expect(acceptOffer(alice.context, offer.id)).rejects.toMatchObject({
      code: "expired",
    });
    const status = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(status?.status).toBe("expired");
  });

  it("revalidates at acceptance: a rule added after the offer blocks the switch", async () => {
    const { offer } = await setupTrade();
    // The program bans trading this service after the offer was made.
    const shift = await queryOne<{ service_id: string }>(
      "SELECT service_id FROM shifts WHERE id = $1",
      [offer.offered_shift_id],
    );
    await addRule(fixture.program, "non_tradeable_service", {
      serviceIds: [shift!.service_id],
    });
    await expect(acceptOffer(alice.context, offer.id)).rejects.toMatchObject({
      code: "rule_violation",
    });
    const updated = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(updated?.status).toBe("invalidated");
  });

  it("refuses to finalise when an administrator reassigned a shift underneath", async () => {
    const carol = await createResident(fixture.program, {
      email: "carol2@hospital.org",
      pgy: 2,
    });
    const { aliceShift, offer } = await setupTrade();
    await query(
      "UPDATE shift_assignments SET assignment_status = 'ended', ended_at = now() WHERE shift_id = $1",
      [aliceShift.id],
    );
    await query("INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)", [
      aliceShift.id,
      carol.resident.id,
    ]);
    await expect(acceptOffer(alice.context, offer.id)).rejects.toMatchObject({
      code: "conflict",
    });
    // Nothing changed: Carol still holds the shift.
    expect(await activeAssignee(aliceShift.id)).toBe(carol.resident.id);
  });
});

describe("approval workflow", () => {
  it("routes an approval-required switch to the chief instead of completing", async () => {
    const { offer, aliceShift, bobShift } = await setupTrade({ approvalRequired: true });
    const outcome = await acceptOffer(alice.context, offer.id);
    expect(outcome.status).toBe("pending_approval");

    // Nothing has moved yet.
    expect(await activeAssignee(aliceShift.id)).toBe(alice.resident.id);
    expect(await activeAssignee(bobShift.id)).toBe(bob.resident.id);

    const chiefNotifications = await notificationsFor(chief.user.id);
    expect(chiefNotifications.some((n) => n.type === "approval.required")).toBe(true);
  });

  it("completes the switch when the chief approves", async () => {
    const { offer, aliceShift, bobShift, request } = await setupTrade({
      approvalRequired: true,
    });
    await acceptOffer(alice.context, offer.id);
    const result = await approveTrade(chief.context, request.id, { notes: "Fine" });

    expect(await activeAssignee(aliceShift.id)).toBe(bob.resident.id);
    expect(await activeAssignee(bobShift.id)).toBe(alice.resident.id);

    const trade = await getCompletedTrade(result.completedTradeId, fixture.program.id);
    expect(trade?.approval_required).toBe(true);
    expect(trade?.approved_by).toBe(chief.user.id);
    expect(trade?.approval_notes).toBe("Fine");
    expect(await auditActions()).toContain("trade.approved");
  });

  it("rejects with a reason and restores both shifts", async () => {
    const { offer, aliceShift, request } = await setupTrade({ approvalRequired: true });
    await acceptOffer(alice.context, offer.id);
    await rejectTrade(chief.context, request.id, "Coverage risk on MICU");

    expect(await activeAssignee(aliceShift.id)).toBe(alice.resident.id);
    const requestStatus = await queryOne<{ status: string }>(
      "SELECT status FROM trade_requests WHERE id = $1",
      [request.id],
    );
    expect(requestStatus?.status).toBe("cancelled");
    const aliceNotifications = await notificationsFor(alice.user.id);
    expect(
      aliceNotifications.some((n) => n.body.includes("Coverage risk on MICU")),
    ).toBe(true);
  });

  it("sends a trade back to the residents with a note", async () => {
    const { offer, request, aliceShift } = await setupTrade({ approvalRequired: true });
    await acceptOffer(alice.context, offer.id);
    await requestTradeChanges(chief.context, request.id, "Swap with someone on nights instead.");

    const updated = await queryOne<{ status: string }>(
      "SELECT status FROM trade_requests WHERE id = $1",
      [request.id],
    );
    expect(updated?.status).toBe("open");
    const offerStatus = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(offerStatus?.status).toBe("rejected");
    const shiftStatus = await queryOne<{ status: string }>(
      "SELECT status FROM shifts WHERE id = $1",
      [aliceShift.id],
    );
    expect(shiftStatus?.status).toBe("posted");
    expect(await activeAssignee(aliceShift.id)).toBe(alice.resident.id);

    for (const user of [alice.user.id, bob.user.id]) {
      const notifications = await notificationsFor(user);
      expect(
        notifications.some((n) => n.body.includes("Swap with someone on nights instead.")),
      ).toBe(true);
    }
    expect(await auditActions()).toContain("trade.changes_requested");
  });

  it("requires a note when requesting changes", async () => {
    const { offer, request } = await setupTrade({ approvalRequired: true });
    await acceptOffer(alice.context, offer.id);
    await expect(
      requestTradeChanges(chief.context, request.id, "   "),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("only a chief or administrator may request changes", async () => {
    const { offer, request } = await setupTrade({ approvalRequired: true });
    await acceptOffer(alice.context, offer.id);
    await expect(
      requestTradeChanges(alice.context, request.id, "Please redo"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires a reason to reject", async () => {
    const { offer, request } = await setupTrade({ approvalRequired: true });
    await acceptOffer(alice.context, offer.id);
    await expect(rejectTrade(chief.context, request.id, "  ")).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("refuses approval from a resident", async () => {
    const { offer, request } = await setupTrade({ approvalRequired: true });
    await acceptOffer(alice.context, offer.id);
    await expect(approveTrade(alice.context, request.id)).rejects.toBeInstanceOf(AppError);
  });

  it("records an administrative override with its reason", async () => {
    const { offer, request } = await setupTrade({ approvalRequired: true });
    await acceptOffer(alice.context, offer.id);
    // A rule that now fails, added after acceptance.
    await addRule(fixture.program, "max_trades_per_month", { maxTrades: 0 });

    await expect(approveTrade(chief.context, request.id)).rejects.toMatchObject({
      code: "rule_violation",
    });

    const result = await approveTrade(chief.context, request.id, {
      override: { reason: "Chief covered the gap personally" },
    });
    const trade = await getCompletedTrade(result.completedTradeId, fixture.program.id);
    expect(trade?.override_applied).toBe(true);

    const override = await queryOne<{ reason: string; new_state: unknown }>(
      "SELECT reason, new_state FROM audit_logs WHERE action = 'trade.override'",
    );
    expect(override?.reason).toBe("Chief covered the gap personally");
  });

  it("will not override a rule marked as non-overridable", async () => {
    const { offer, request } = await setupTrade({ approvalRequired: true });
    await acceptOffer(alice.context, offer.id);
    await addRule(
      fixture.program,
      "max_trades_per_month",
      { maxTrades: 0 },
      { overridable: false },
    );
    await expect(
      approveTrade(chief.context, request.id, { override: { reason: "Because" } }),
    ).rejects.toMatchObject({ code: "rule_violation" });
  });
});

describe("cancellation, expiry and schedule changes", () => {
  it("cancels a post and invalidates its offers", async () => {
    const { request, offer, aliceShift } = await setupTrade();
    await cancelTradeRequest(alice.context, request.id, "Changed my mind");

    const offerStatus = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(offerStatus?.status).toBe("invalidated");
    const shiftStatus = await queryOne<{ status: string }>(
      "SELECT status FROM shifts WHERE id = $1",
      [aliceShift.id],
    );
    expect(shiftStatus?.status).toBe("scheduled");
    expect(await activeAssignee(aliceShift.id)).toBe(alice.resident.id);
  });

  it("expires stale posts and offers during maintenance", async () => {
    const { request, offer } = await setupTrade();
    await query("UPDATE trade_offers SET expires_at = now() - interval '1 day'", []);
    await query("UPDATE trade_requests SET expires_at = now() - interval '1 day'", []);
    const result = await runMaintenance(fixture.program.id);
    expect(result.expiredOffers).toBe(1);
    expect(result.expiredRequests).toBe(1);

    const offerStatus = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(offerStatus?.status).toBe("expired");
    const requestStatus = await queryOne<{ status: string }>(
      "SELECT status FROM trade_requests WHERE id = $1",
      [request.id],
    );
    expect(requestStatus?.status).toBe("expired");
  });

  it("marks shifts that have been worked as completed", async () => {
    const shift = await createShift(fixture.program, {
      inDays: 5,
      residentId: alice.resident.id,
    });
    await query(
      "UPDATE shifts SET start_datetime = now() - interval '2 days', end_datetime = now() - interval '1 day' WHERE id = $1",
      [shift.id],
    );
    const result = await runMaintenance(fixture.program.id);
    expect(result.completedShifts).toBe(1);
  });

  it("invalidates live trades when an administrator cancels the shift", async () => {
    const { request, offer, aliceShift } = await setupTrade();
    await updateShift(chief.context, aliceShift.id, {
      status: "cancelled",
      reason: "Service closed",
    });

    const offerStatus = await queryOne<{ status: string; invalidation_reason: string }>(
      "SELECT status, invalidation_reason FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(offerStatus?.status).toBe("invalidated");
    expect(offerStatus?.invalidation_reason).toContain("cancelled");

    const requestStatus = await queryOne<{ status: string }>(
      "SELECT status FROM trade_requests WHERE id = $1",
      [request.id],
    );
    expect(requestStatus?.status).toBe("cancelled");
  });

  it("invalidates live trades when an administrator reassigns the shift", async () => {
    const carol = await createResident(fixture.program, {
      email: "carol3@hospital.org",
      pgy: 2,
    });
    const { offer, aliceShift } = await setupTrade();
    await updateShift(chief.context, aliceShift.id, {
      residentId: carol.resident.id,
      reason: "Coverage change",
    });
    const offerStatus = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(offerStatus?.status).toBe("invalidated");
    expect(await activeAssignee(aliceShift.id)).toBe(carol.resident.id);
    expect(await countActiveAssignments(aliceShift.id)).toBe(1);
  });
});

describe("residents leaving the program", () => {
  it("a deactivated resident's pending trade cannot be finalised", async () => {
    const { offer } = await setupTrade();
    // An administrator deactivates the offering resident (records are never
    // hard-deleted — foreign keys forbid it, which is what keeps history intact).
    await query("UPDATE residents SET active = false WHERE id = $1", [bob.resident.id]);

    await expect(acceptOffer(alice.context, offer.id)).rejects.toMatchObject({
      code: "rule_violation",
    });
    const completed = await query<{ id: string }>("SELECT id FROM completed_trades");
    expect(completed).toHaveLength(0);
    const offerStatus = await queryOne<{ status: string }>(
      "SELECT status FROM trade_offers WHERE id = $1",
      [offer.id],
    );
    expect(offerStatus?.status).toBe("invalidated");
  });

  it("a resident with history cannot be deleted outright", async () => {
    const { offer } = await setupTrade();
    await acceptOffer(alice.context, offer.id);
    await expect(
      query("DELETE FROM residents WHERE id = $1", [bob.resident.id]),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("offer candidates", () => {
  it("ranks eligible shifts and explains ineligible ones", async () => {
    await addRule(fixture.program, "min_rest_hours", { hours: 10 });
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
      service: fixture.services.MICU,
    });
    // An eligible shift a week later.
    await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
      service: fixture.services.MICU,
    });
    // An ineligible shift: Bob would then work two overlapping shifts.
    await createShift(fixture.program, {
      inDays: 10,
      residentId: bob.resident.id,
      service: fixture.services.Floor,
    });
    await addRule(fixture.program, "no_overlapping_shifts", {});

    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    const { candidates } = await getOfferCandidates(bob.context, request.id);

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0].eligible).toBe(true);
    expect(candidates[0].match.score).toBeGreaterThan(50);
    const blocked = candidates.find((candidate) => !candidate.eligible);
    expect(blocked?.blockingReason).toBeTruthy();
  });

  it("never offers a shift that is already posted or offered", async () => {
    const aliceShift = await createShift(fixture.program, {
      inDays: 10,
      residentId: alice.resident.id,
    });
    const bobShift = await createShift(fixture.program, {
      inDays: 17,
      residentId: bob.resident.id,
    });
    const request = await postShiftForTrade(alice.context, { shiftId: aliceShift.id });
    await createOffer(bob.context, {
      tradeRequestId: request.id,
      offeredShiftId: bobShift.id,
    });

    const secondPost = await createShift(fixture.program, {
      inDays: 12,
      residentId: alice.resident.id,
    });
    const secondRequest = await postShiftForTrade(alice.context, {
      shiftId: secondPost.id,
    });
    const { candidates } = await getOfferCandidates(bob.context, secondRequest.id);
    expect(candidates.map((candidate) => candidate.shift.id)).not.toContain(bobShift.id);
  });
});
