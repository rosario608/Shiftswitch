import type { PoolClient } from "pg";
import { getPool, query, queryOne, withTransaction, type Queryable } from "@/server/db/pool";
import type {
  CompletedTradeRow,
  ProgramRow,
  ShiftDetail,
  TradeOfferRow,
  TradePreferences,
  TradeRequestRow,
} from "@/server/db/types";
import type { AuthedContext } from "@/server/auth/guards";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { listProgramApprovers, notify } from "./notifications";
import {
  SHIFT_DETAIL_SELECT,
  getShiftDetail,
  getShiftDetailForUpdate,
  toShiftInfo,
} from "./schedule";
import { assertOfferTransition, assertRequestTransition } from "./status";
import { buildTradeContext, getProgram } from "./trade-context";
import { summariseValidation, validateTrade } from "./validation";
import type { TradeValidationResult } from "./rules/types";
import { formatShiftDate, formatShiftRange } from "./time";
import { logger } from "@/server/observability/logger";

const DEFAULT_REQUEST_TTL_DAYS = 14;

function shiftLabel(shift: ShiftDetail, timezone: string): string {
  return `${formatShiftDate(shift.start_datetime, timezone)} · ${shift.service_name} ${formatShiftRange(
    shift.start_datetime,
    shift.end_datetime,
    timezone,
  )}`;
}

async function userIdForResident(
  residentId: string,
  executor: Queryable = getPool(),
): Promise<string> {
  const row = await queryOne<{ user_id: string }>(
    "SELECT user_id FROM residents WHERE id = $1",
    [residentId],
    executor,
  );
  if (!row) throw notFound("Resident not found.");
  return row.user_id;
}

// ---------------------------------------------------------------------------
// Posting a shift for trade
// ---------------------------------------------------------------------------

export interface PostShiftInput {
  shiftId: string;
  preferences?: TradePreferences;
  notes?: string;
  expiresAt?: Date;
}

export async function postShiftForTrade(
  context: AuthedContext & { resident: { id: string } },
  input: PostShiftInput,
): Promise<TradeRequestRow> {
  return withTransaction(async (client) => {
    const shift = await getShiftDetailForUpdate(input.shiftId, client);
    if (!shift) throw notFound("That shift no longer exists.");
    if (shift.program_id !== context.program.id) {
      throw forbidden("That shift belongs to a different program.");
    }
    if (shift.resident_id !== context.resident.id) {
      throw forbidden("You can only post shifts that are assigned to you.");
    }
    if (shift.status === "cancelled" || shift.status === "completed") {
      throw conflict("That shift is no longer active.");
    }
    if (!shift.tradeable) {
      throw validationFailed(
        "This shift is marked non-tradeable by your program and cannot be posted.",
      );
    }
    if (shift.start_datetime.getTime() <= Date.now()) {
      throw validationFailed("This shift has already started and cannot be traded.");
    }
    if (shift.trade_deadline && shift.trade_deadline.getTime() <= Date.now()) {
      throw validationFailed("The trade deadline for this shift has passed.");
    }
    if (shift.status !== "scheduled") {
      throw conflict("This shift is already involved in a trade.");
    }

    const expiresAt =
      input.expiresAt ??
      new Date(
        Math.min(
          Date.now() + DEFAULT_REQUEST_TTL_DAYS * 86_400_000,
          shift.start_datetime.getTime(),
        ),
      );

    const request = await queryOne<TradeRequestRow>(
      `INSERT INTO trade_requests
         (program_id, source_shift_id, initiating_resident_id, preferences, notes, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING *`,
      [
        context.program.id,
        shift.id,
        context.resident.id,
        JSON.stringify(input.preferences ?? {}),
        input.notes ?? "",
        expiresAt,
      ],
      client,
    );

    await query("UPDATE shifts SET status = 'posted' WHERE id = $1", [shift.id], client);

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "trade.posted",
        entityType: "trade_request",
        entityId: request!.id,
        previousState: { shiftStatus: shift.status },
        newState: {
          shiftId: shift.id,
          shiftStatus: "posted",
          preferences: input.preferences ?? {},
          expiresAt,
        },
      },
      client,
    );

    return request as TradeRequestRow;
  });
}

export async function cancelTradeRequest(
  context: AuthedContext,
  requestId: string,
  reason?: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [requestId],
      client,
    );
    if (!request) throw notFound("That trade post no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    const isOwner = context.resident?.id === request.initiating_resident_id;
    const isElevated = context.user.role === "chief" || context.user.role === "admin";
    if (!isOwner && !isElevated) {
      throw forbidden("You can only cancel your own trade posts.");
    }
    assertRequestTransition(request.status, "cancelled");

    await query(
      "UPDATE trade_requests SET status = 'cancelled' WHERE id = $1",
      [request.id],
      client,
    );
    const affectedOffers = await query<TradeOfferRow>(
      `UPDATE trade_offers
          SET status = 'invalidated',
              invalidation_reason = $2
        WHERE trade_request_id = $1 AND status IN ('pending', 'accepted')
        RETURNING *`,
      [request.id, "The resident cancelled this trade post."],
      client,
    );
    await query(
      `UPDATE shifts SET status = 'scheduled'
        WHERE id = $1 AND status IN ('posted', 'offer_pending', 'pending_approval')`,
      [request.source_shift_id],
      client,
    );

    for (const offer of affectedOffers) {
      const userId = await userIdForResident(offer.offering_resident_id, client);
      await notify(
        {
          recipientUserId: userId,
          type: "trade.cancelled",
          title: "A trade you offered on was cancelled",
          body: "This offer is no longer available because the resident cancelled the trade post.",
          relatedEntityType: "trade_offer",
          relatedEntityId: offer.id,
        },
        client,
      );
      await query(
        `UPDATE shifts SET status = 'scheduled'
          WHERE id = $1 AND status IN ('offer_pending', 'pending_approval')`,
        [offer.offered_shift_id],
        client,
      );
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "trade.cancelled",
        entityType: "trade_request",
        entityId: request.id,
        previousState: { status: request.status },
        newState: { status: "cancelled", invalidatedOffers: affectedOffers.length },
        reason: reason ?? null,
      },
      client,
    );
  });
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export interface OfferResult {
  offer: TradeOfferRow;
  validation: TradeValidationResult;
}

export async function createOffer(
  context: AuthedContext & { resident: { id: string } },
  input: { tradeRequestId: string; offeredShiftId: string },
): Promise<OfferResult> {
  return withTransaction(async (client) => {
    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [input.tradeRequestId],
      client,
    );
    if (!request) throw notFound("That trade post no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    if (request.initiating_resident_id === context.resident.id) {
      throw validationFailed("You cannot offer on your own trade post.");
    }
    if (request.status !== "open" && request.status !== "offer_pending") {
      throw conflict(
        "This trade is no longer accepting offers. Refresh your available trades and try again.",
      );
    }
    if (request.expires_at.getTime() <= Date.now()) {
      throw new AppError("expired", "This trade post has expired.");
    }

    const [sourceShift, offeredShift] = await lockShifts(
      client,
      request.source_shift_id,
      input.offeredShiftId,
    );
    if (!sourceShift || !offeredShift) {
      throw notFound("One of the shifts in this trade no longer exists.");
    }
    if (offeredShift.resident_id !== context.resident.id) {
      throw forbidden("You can only offer shifts that are assigned to you.");
    }
    if (sourceShift.resident_id !== request.initiating_resident_id) {
      throw conflict(
        "This shift was reassigned and is no longer available for trade.",
      );
    }

    const program = await getProgram(context.program.id, client);
    const tradeContext = await buildTradeContext({
      program,
      sourceShift,
      offeredShift,
      executor: client,
    });
    const validation = validateTrade(tradeContext);
    if (!validation.valid) {
      throw new AppError(
        "rule_violation",
        validation.failures[0]?.message ?? "This trade is not permitted.",
        { validation },
      );
    }

    const expiresAt = new Date(
      Math.min(
        request.expires_at.getTime(),
        sourceShift.start_datetime.getTime(),
        offeredShift.start_datetime.getTime(),
      ),
    );

    const offer = await queryOne<TradeOfferRow>(
      `INSERT INTO trade_offers
         (trade_request_id, offered_shift_id, offering_resident_id, validation_snapshot, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [
        request.id,
        offeredShift.id,
        context.resident.id,
        JSON.stringify(validation),
        expiresAt,
      ],
      client,
    );

    if (request.status === "open") {
      await query(
        "UPDATE trade_requests SET status = 'offer_pending' WHERE id = $1",
        [request.id],
        client,
      );
    }
    await query(
      `UPDATE shifts SET status = 'offer_pending'
        WHERE id = ANY($1::uuid[]) AND status IN ('scheduled', 'posted')`,
      [[sourceShift.id, offeredShift.id]],
      client,
    );

    const initiatorUserId = await userIdForResident(
      request.initiating_resident_id,
      client,
    );
    await notify(
      {
        recipientUserId: initiatorUserId,
        type: "offer.created",
        title: "New offer on your posted shift",
        body: `${context.user.fullName} offered ${shiftLabel(offeredShift, program.timezone)} for your ${shiftLabel(sourceShift, program.timezone)}.`,
        relatedEntityType: "trade_offer",
        relatedEntityId: offer!.id,
      },
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "offer.created",
        entityType: "trade_offer",
        entityId: offer!.id,
        newState: {
          tradeRequestId: request.id,
          offeredShiftId: offeredShift.id,
          validation: summariseValidation(validation),
        },
      },
      client,
    );

    return { offer: offer as TradeOfferRow, validation };
  });
}

export async function withdrawOffer(
  context: AuthedContext & { resident: { id: string } },
  offerId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const offer = await queryOne<TradeOfferRow>(
      "SELECT * FROM trade_offers WHERE id = $1 FOR UPDATE",
      [offerId],
      client,
    );
    if (!offer) throw notFound("That offer no longer exists.");
    if (offer.offering_resident_id !== context.resident.id) {
      throw forbidden("You can only withdraw your own offers.");
    }
    assertOfferTransition(offer.status, "withdrawn");
    await query(
      "UPDATE trade_offers SET status = 'withdrawn' WHERE id = $1",
      [offer.id],
      client,
    );
    await releaseShiftIfIdle(client, offer.offered_shift_id);
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "offer.withdrawn",
        entityType: "trade_offer",
        entityId: offer.id,
        previousState: { status: offer.status },
        newState: { status: "withdrawn" },
      },
      client,
    );
  });
}

export async function rejectOffer(
  context: AuthedContext & { resident: { id: string } },
  offerId: string,
  reason?: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const offer = await queryOne<TradeOfferRow>(
      "SELECT * FROM trade_offers WHERE id = $1 FOR UPDATE",
      [offerId],
      client,
    );
    if (!offer) throw notFound("That offer no longer exists.");
    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [offer.trade_request_id],
      client,
    );
    if (!request) throw notFound("That trade post no longer exists.");
    if (request.initiating_resident_id !== context.resident.id) {
      throw forbidden("Only the resident who posted the shift can decline offers.");
    }
    assertOfferTransition(offer.status, "rejected");

    await query(
      "UPDATE trade_offers SET status = 'rejected' WHERE id = $1",
      [offer.id],
      client,
    );
    await releaseShiftIfIdle(client, offer.offered_shift_id);

    const remaining = await queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM trade_offers WHERE trade_request_id = $1 AND status = 'pending'",
      [request.id],
      client,
    );
    if (Number(remaining?.count ?? 0) === 0 && request.status === "offer_pending") {
      await query(
        "UPDATE trade_requests SET status = 'open' WHERE id = $1",
        [request.id],
        client,
      );
      await query(
        "UPDATE shifts SET status = 'posted' WHERE id = $1 AND status = 'offer_pending'",
        [request.source_shift_id],
        client,
      );
    }

    const offeringUserId = await userIdForResident(offer.offering_resident_id, client);
    await notify(
      {
        recipientUserId: offeringUserId,
        type: "offer.rejected",
        title: "Your offer was declined",
        body: reason?.trim()
          ? reason.trim()
          : "The resident declined your offer. The shift may still be available to other residents.",
        relatedEntityType: "trade_offer",
        relatedEntityId: offer.id,
      },
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "offer.rejected",
        entityType: "trade_offer",
        entityId: offer.id,
        previousState: { status: offer.status },
        newState: { status: "rejected" },
        reason: reason ?? null,
      },
      client,
    );
  });
}

/** Returns a shift to `scheduled`/`posted` when nothing live references it. */
async function releaseShiftIfIdle(client: PoolClient, shiftId: string): Promise<void> {
  const live = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM trade_offers o
      WHERE o.offered_shift_id = $1 AND o.status IN ('pending', 'accepted')`,
    [shiftId],
    client,
  );
  if (Number(live?.count ?? 0) > 0) return;
  const posted = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM trade_requests r
      WHERE r.source_shift_id = $1
        AND r.status IN ('open', 'offer_pending', 'accepted', 'pending_approval', 'approved')`,
    [shiftId],
    client,
  );
  await query(
    "UPDATE shifts SET status = $2 WHERE id = $1 AND status IN ('offer_pending', 'pending_approval', 'posted')",
    [shiftId, Number(posted?.count ?? 0) > 0 ? "posted" : "scheduled"],
    client,
  );
}

/** Locks two shifts in a deterministic order so concurrent trades cannot deadlock. */
async function lockShifts(
  client: PoolClient,
  shiftIdA: string,
  shiftIdB: string,
): Promise<[ShiftDetail | null, ShiftDetail | null]> {
  const ordered = [shiftIdA, shiftIdB].sort();
  for (const id of ordered) {
    await client.query("SELECT id FROM shifts WHERE id = $1 FOR UPDATE", [id]);
  }
  const a = await getShiftDetail(shiftIdA, client);
  const b = await getShiftDetail(shiftIdB, client);
  return [a, b];
}

// ---------------------------------------------------------------------------
// Acceptance, approval and atomic finalisation
// ---------------------------------------------------------------------------

export type AcceptOutcome =
  | { status: "completed"; completedTradeId: string; validation: TradeValidationResult }
  | { status: "pending_approval"; tradeRequestId: string; validation: TradeValidationResult };

export async function acceptOffer(
  context: AuthedContext & { resident: { id: string } },
  offerId: string,
): Promise<AcceptOutcome> {
  return withTransaction(async (client) => {
    const offer = await queryOne<TradeOfferRow>(
      "SELECT * FROM trade_offers WHERE id = $1 FOR UPDATE",
      [offerId],
      client,
    );
    if (!offer) throw notFound("That offer no longer exists.");

    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [offer.trade_request_id],
      client,
    );
    if (!request) throw notFound("That trade post no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    if (request.initiating_resident_id !== context.resident.id) {
      throw forbidden("Only the resident who posted the shift can accept an offer.");
    }
    if (offer.status !== "pending") {
      throw conflict(
        offer.status === "completed"
          ? "This switch has already been completed."
          : "This offer is no longer available.",
      );
    }
    if (offer.expires_at.getTime() <= Date.now()) {
      await query(
        "UPDATE trade_offers SET status = 'expired' WHERE id = $1 AND status = 'pending'",
        [offer.id],
        client,
      );
      throw new AppError("expired", "This offer has expired and can no longer be accepted.");
    }
    if (request.status !== "open" && request.status !== "offer_pending") {
      throw conflict("This trade is no longer active.");
    }

    const program = await getProgram(context.program.id, client);
    const { sourceShift, offeredShift, validation } = await revalidate(
      client,
      program,
      request,
      offer,
    );

    if (!validation.valid) {
      await invalidateOffer(
        client,
        offer,
        validation.failures[0]?.message ??
          "This trade is no longer permitted by program rules.",
        context.user.id,
        context.program.id,
      );
      throw new AppError(
        "rule_violation",
        `This switch can no longer be completed: ${validation.failures[0]?.message ?? "program rules are no longer satisfied"}`,
        { validation },
      );
    }

    await query(
      "UPDATE trade_offers SET status = 'accepted' WHERE id = $1",
      [offer.id],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "offer.accepted",
        entityType: "trade_offer",
        entityId: offer.id,
        newState: { validation: summariseValidation(validation) },
      },
      client,
    );

    if (validation.requiresApproval) {
      assertRequestTransition(request.status, "pending_approval");
      await query(
        "UPDATE trade_requests SET status = 'pending_approval' WHERE id = $1",
        [request.id],
        client,
      );
      await query(
        `UPDATE shifts SET status = 'pending_approval' WHERE id = ANY($1::uuid[])`,
        [[sourceShift.id, offeredShift.id]],
        client,
      );

      const approverIds = await listProgramApprovers(context.program.id, client);
      const offeringUserId = await userIdForResident(offer.offering_resident_id, client);
      await notify(
        [
          ...approverIds.map((userId) => ({
            recipientUserId: userId,
            type: "approval.required" as const,
            title: "Shift switch needs approval",
            body: `${context.user.fullName} and their trade partner need approval for a switch on ${formatShiftDate(sourceShift.start_datetime, program.timezone)}.`,
            relatedEntityType: "trade_request",
            relatedEntityId: request.id,
          })),
          {
            recipientUserId: offeringUserId,
            type: "offer.accepted" as const,
            title: "Your offer was accepted — awaiting approval",
            body: "A chief resident needs to approve this switch before schedules change.",
            relatedEntityType: "trade_request",
            relatedEntityId: request.id,
          },
        ],
        client,
      );

      return {
        status: "pending_approval" as const,
        tradeRequestId: request.id,
        validation,
      };
    }

    const completed = await finaliseTrade(client, {
      program,
      request,
      offer,
      sourceShift,
      offeredShift,
      validation,
      actorUserId: context.user.id,
      actorLabel: context.user.email,
      approvalRequired: false,
    });

    return {
      status: "completed" as const,
      completedTradeId: completed.id,
      validation,
    };
  });
}

async function revalidate(
  client: PoolClient,
  program: ProgramRow,
  request: TradeRequestRow,
  offer: TradeOfferRow,
): Promise<{
  sourceShift: ShiftDetail;
  offeredShift: ShiftDetail;
  validation: TradeValidationResult;
}> {
  const [sourceShift, offeredShift] = await lockShifts(
    client,
    request.source_shift_id,
    offer.offered_shift_id,
  );
  if (!sourceShift || !offeredShift) {
    throw notFound("One of the shifts in this trade no longer exists.");
  }
  if (sourceShift.resident_id !== request.initiating_resident_id) {
    throw conflict(
      "This offer is no longer available because the posted shift was reassigned.",
    );
  }
  if (offeredShift.resident_id !== offer.offering_resident_id) {
    throw conflict(
      "This offer is no longer available because the offered shift was reassigned.",
    );
  }
  const tradeContext = await buildTradeContext({
    program,
    sourceShift,
    offeredShift,
    executor: client,
  });
  return { sourceShift, offeredShift, validation: validateTrade(tradeContext) };
}

async function invalidateOffer(
  client: PoolClient,
  offer: TradeOfferRow,
  reason: string,
  actorUserId: string | null,
  programId: string,
): Promise<void> {
  await query(
    `UPDATE trade_offers SET status = 'invalidated', invalidation_reason = $2
      WHERE id = $1 AND status IN ('pending', 'accepted')`,
    [offer.id, reason],
    client,
  );
  const offeringUserId = await userIdForResident(offer.offering_resident_id, client);
  await notify(
    {
      recipientUserId: offeringUserId,
      type: "offer.invalidated",
      title: "An offer is no longer available",
      body: reason,
      relatedEntityType: "trade_offer",
      relatedEntityId: offer.id,
    },
    client,
  );
  await recordAudit(
    {
      programId,
      actorUserId,
      action: "offer.invalidated",
      entityType: "trade_offer",
      entityId: offer.id,
      newState: { status: "invalidated" },
      reason,
    },
    client,
  );
}

interface FinaliseInput {
  program: ProgramRow;
  request: TradeRequestRow;
  offer: TradeOfferRow;
  sourceShift: ShiftDetail;
  offeredShift: ShiftDetail;
  validation: TradeValidationResult;
  actorUserId: string;
  actorLabel: string;
  approvalRequired: boolean;
  approvedBy?: string | null;
  approvalNotes?: string | null;
  overrideApplied?: boolean;
  overrideReason?: string | null;
}

/**
 * The atomic swap.
 *
 * Preconditions: the caller holds row locks on both shifts, the trade request
 * and the offer, and has just re-validated the trade inside this transaction.
 *
 * Everything below happens in one transaction: end both assignments, create
 * both new assignments, invalidate competing offers, write the completed-trade
 * record, notify, and audit. Any failure rolls the entire swap back, so a shift
 * can never end up with two residents or none.
 */
async function finaliseTrade(
  client: PoolClient,
  input: FinaliseInput,
): Promise<CompletedTradeRow> {
  const {
    program,
    request,
    offer,
    sourceShift,
    offeredShift,
    validation,
    actorUserId,
    actorLabel,
  } = input;

  const residentA = request.initiating_resident_id;
  const residentB = offer.offering_resident_id;

  const previousAssignments = {
    [sourceShift.id]: residentA,
    [offeredShift.id]: residentB,
  };
  const resultingAssignments = {
    [sourceShift.id]: residentB,
    [offeredShift.id]: residentA,
  };

  // End the current assignments. The row count guards against a concurrent
  // change that slipped between validation and this write.
  const endedRows = await query<{ id: string }>(
    `UPDATE shift_assignments
        SET assignment_status = 'ended', ended_at = now()
      WHERE assignment_status = 'active'
        AND ((shift_id = $1 AND resident_id = $3) OR (shift_id = $2 AND resident_id = $4))
      RETURNING id`,
    [sourceShift.id, offeredShift.id, residentA, residentB],
    client,
  );
  if (endedRows.length !== 2) {
    throw conflict(
      "These shifts changed while the switch was being completed. Nothing was changed — please try again.",
    );
  }

  await query(
    `INSERT INTO shift_assignments (shift_id, resident_id, assignment_status)
     VALUES ($1, $2, 'active'), ($3, $4, 'active')`,
    [sourceShift.id, residentB, offeredShift.id, residentA],
    client,
  );

  await query(
    `UPDATE shifts SET status = 'scheduled' WHERE id = ANY($1::uuid[])`,
    [[sourceShift.id, offeredShift.id]],
    client,
  );

  // Every other live offer that involves either shift is now impossible.
  const orphanedOffers = await query<TradeOfferRow>(
    `SELECT * FROM trade_offers
      WHERE id <> $1
        AND status IN ('pending', 'accepted')
        AND (offered_shift_id = ANY($2::uuid[]) OR trade_request_id IN (
              SELECT id FROM trade_requests WHERE source_shift_id = ANY($2::uuid[])
            ))`,
    [offer.id, [sourceShift.id, offeredShift.id]],
    client,
  );
  for (const orphan of orphanedOffers) {
    await invalidateOffer(
      client,
      orphan,
      "This offer is no longer available because the shift was assigned through another completed trade.",
      actorUserId,
      program.id,
    );
  }

  // Other open posts for these shifts are closed out too.
  const orphanRequests = await query<TradeRequestRow>(
    `UPDATE trade_requests
        SET status = 'cancelled'
      WHERE id <> $1
        AND source_shift_id = ANY($2::uuid[])
        AND status IN ('open', 'offer_pending', 'accepted', 'pending_approval', 'approved')
      RETURNING *`,
    [request.id, [sourceShift.id, offeredShift.id]],
    client,
  );

  await query(
    "UPDATE trade_offers SET status = 'completed' WHERE id = $1",
    [offer.id],
    client,
  );
  await query(
    "UPDATE trade_requests SET status = 'completed' WHERE id = $1",
    [request.id],
    client,
  );

  const completed = await queryOne<CompletedTradeRow>(
    `INSERT INTO completed_trades
       (program_id, trade_request_id, trade_offer_id, source_shift_id, destination_shift_id,
        resident_a, resident_b, previous_assignments, resulting_assignments,
        approval_required, approved_by, approved_at, approval_notes, override_applied,
        validation_snapshot, completed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16)
     RETURNING *`,
    [
      program.id,
      request.id,
      offer.id,
      sourceShift.id,
      offeredShift.id,
      residentA,
      residentB,
      JSON.stringify(previousAssignments),
      JSON.stringify(resultingAssignments),
      input.approvalRequired,
      input.approvedBy ?? null,
      input.approvedBy ? new Date() : null,
      input.approvalNotes ?? null,
      input.overrideApplied ?? false,
      JSON.stringify(validation),
      actorUserId,
    ],
    client,
  );

  await query(
    `INSERT INTO trade_legs (completed_trade_id, leg_index, shift_id, from_resident_id, to_resident_id)
     VALUES ($1, 0, $2, $3, $4), ($1, 1, $5, $4, $3)`,
    [completed!.id, sourceShift.id, residentA, residentB, offeredShift.id],
    client,
  );

  const userA = await userIdForResident(residentA, client);
  const userB = await userIdForResident(residentB, client);
  await notify(
    [
      {
        recipientUserId: userA,
        type: "switch.completed",
        title: "Shift switch completed",
        body: `You now work ${shiftLabel(offeredShift, program.timezone)}. ${sourceShift.service_name} on ${formatShiftDate(sourceShift.start_datetime, program.timezone)} is covered.`,
        relatedEntityType: "completed_trade",
        relatedEntityId: completed!.id,
      },
      {
        recipientUserId: userB,
        type: "switch.completed",
        title: "Shift switch completed",
        body: `You now work ${shiftLabel(sourceShift, program.timezone)}. ${offeredShift.service_name} on ${formatShiftDate(offeredShift.start_datetime, program.timezone)} is covered.`,
        relatedEntityType: "completed_trade",
        relatedEntityId: completed!.id,
      },
    ],
    client,
  );

  await recordAudit(
    {
      programId: program.id,
      actorUserId,
      actorLabel,
      action: "trade.completed",
      entityType: "completed_trade",
      entityId: completed!.id,
      previousState: previousAssignments,
      newState: resultingAssignments,
      reason: input.overrideReason ?? null,
    },
    client,
  );
  await recordAudit(
    {
      programId: program.id,
      actorUserId,
      actorLabel,
      action: "shift.reassigned",
      entityType: "shift",
      entityId: sourceShift.id,
      previousState: { residentId: residentA },
      newState: { residentId: residentB },
    },
    client,
  );
  await recordAudit(
    {
      programId: program.id,
      actorUserId,
      actorLabel,
      action: "shift.reassigned",
      entityType: "shift",
      entityId: offeredShift.id,
      previousState: { residentId: residentB },
      newState: { residentId: residentA },
    },
    client,
  );

  logger.info("trade.completed", {
    completedTradeId: completed!.id,
    programId: program.id,
    invalidatedOffers: orphanedOffers.length,
    cancelledRequests: orphanRequests.length,
  });

  return completed as CompletedTradeRow;
}

// ---------------------------------------------------------------------------
// Chief approval
// ---------------------------------------------------------------------------

export async function approveTrade(
  context: AuthedContext,
  requestId: string,
  options: { notes?: string; override?: { reason: string } } = {},
): Promise<{ completedTradeId: string; validation: TradeValidationResult }> {
  return withTransaction(async (client) => {
    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [requestId],
      client,
    );
    if (!request) throw notFound("That trade no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    if (request.status !== "pending_approval") {
      throw conflict("This trade is not awaiting approval.");
    }
    const offer = await queryOne<TradeOfferRow>(
      `SELECT * FROM trade_offers
        WHERE trade_request_id = $1 AND status = 'accepted'
        ORDER BY updated_at DESC LIMIT 1
        FOR UPDATE`,
      [request.id],
      client,
    );
    if (!offer) throw notFound("The accepted offer for this trade is no longer available.");

    const program = await getProgram(context.program.id, client);
    const { sourceShift, offeredShift, validation } = await revalidate(
      client,
      program,
      request,
      offer,
    );

    if (!validation.valid && !options.override) {
      throw new AppError(
        "rule_violation",
        `This trade no longer passes validation: ${validation.failures[0]?.message ?? "rules failed"}`,
        { validation },
      );
    }
    if (!validation.valid && options.override) {
      const blocking = validation.failures.filter((check) => !check.overridable);
      if (blocking.length > 0) {
        throw new AppError(
          "rule_violation",
          `This trade cannot be overridden: ${blocking[0].message}`,
          { validation },
        );
      }
      await recordAudit(
        {
          programId: program.id,
          actorUserId: context.user.id,
          actorLabel: context.user.email,
          action: "trade.override",
          entityType: "trade_request",
          entityId: request.id,
          newState: {
            overriddenRules: validation.failures.map((f) => ({
              ruleId: f.ruleId,
              ruleType: f.ruleType,
              message: f.message,
            })),
          },
          reason: options.override.reason,
        },
        client,
      );
    }

    const completed = await finaliseTrade(client, {
      program,
      request,
      offer,
      sourceShift,
      offeredShift,
      validation,
      actorUserId: context.user.id,
      actorLabel: context.user.email,
      approvalRequired: true,
      approvedBy: context.user.id,
      approvalNotes: options.notes ?? null,
      overrideApplied: Boolean(options.override),
      overrideReason: options.override?.reason ?? null,
    });

    const userA = await userIdForResident(request.initiating_resident_id, client);
    const userB = await userIdForResident(offer.offering_resident_id, client);
    await notify(
      [userA, userB].map((userId) => ({
        recipientUserId: userId,
        type: "approval.granted" as const,
        title: "Switch approved",
        body: `${context.user.fullName} approved your shift switch. Both schedules have been updated.`,
        relatedEntityType: "completed_trade",
        relatedEntityId: completed.id,
      })),
      client,
    );
    await recordAudit(
      {
        programId: program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "trade.approved",
        entityType: "trade_request",
        entityId: request.id,
        newState: { completedTradeId: completed.id },
        reason: options.notes ?? null,
      },
      client,
    );

    return { completedTradeId: completed.id, validation };
  });
}

export async function rejectTrade(
  context: AuthedContext,
  requestId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) {
    throw validationFailed("A reason is required when rejecting a trade.");
  }
  await withTransaction(async (client) => {
    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [requestId],
      client,
    );
    if (!request) throw notFound("That trade no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    if (request.status !== "pending_approval") {
      throw conflict("This trade is not awaiting approval.");
    }
    const offers = await query<TradeOfferRow>(
      `UPDATE trade_offers SET status = 'rejected', invalidation_reason = $2
        WHERE trade_request_id = $1 AND status IN ('pending', 'accepted')
      RETURNING *`,
      [request.id, reason],
      client,
    );
    await query(
      "UPDATE trade_requests SET status = 'cancelled' WHERE id = $1",
      [request.id],
      client,
    );
    await query(
      `UPDATE shifts SET status = 'scheduled'
        WHERE id = ANY($1::uuid[]) AND status IN ('posted', 'offer_pending', 'pending_approval')`,
      [[request.source_shift_id, ...offers.map((o) => o.offered_shift_id)]],
      client,
    );

    const recipients = new Set<string>();
    recipients.add(await userIdForResident(request.initiating_resident_id, client));
    for (const offer of offers) {
      recipients.add(await userIdForResident(offer.offering_resident_id, client));
    }
    await notify(
      Array.from(recipients).map((userId) => ({
        recipientUserId: userId,
        type: "approval.rejected" as const,
        title: "Switch not approved",
        body: reason,
        relatedEntityType: "trade_request",
        relatedEntityId: request.id,
      })),
      client,
    );
    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "trade.rejected",
        entityType: "trade_request",
        entityId: request.id,
        newState: { status: "cancelled" },
        reason,
      },
      client,
    );
  });
}

// ---------------------------------------------------------------------------
// Maintenance: expiry and post-shift completion
// ---------------------------------------------------------------------------

export interface MaintenanceResult {
  expiredRequests: number;
  expiredOffers: number;
  completedShifts: number;
}

/**
 * Idempotent housekeeping. Safe to run on a schedule or on demand:
 *  - expires trade posts and offers past their deadline,
 *  - marks shifts whose end time has passed as completed.
 */
export async function runMaintenance(programId?: string): Promise<MaintenanceResult> {
  return withTransaction(async (client) => {
    const params = programId ? [programId] : [];
    const scope = programId ? "AND program_id = $1" : "";

    const expiredOffers = await query<TradeOfferRow>(
      `UPDATE trade_offers o
          SET status = 'expired'
        WHERE o.status = 'pending' AND o.expires_at <= now()
          ${programId ? "AND o.trade_request_id IN (SELECT id FROM trade_requests WHERE program_id = $1)" : ""}
        RETURNING *`,
      params,
      client,
    );
    for (const offer of expiredOffers) {
      const userId = await userIdForResident(offer.offering_resident_id, client);
      await notify(
        {
          recipientUserId: userId,
          type: "trade.expired",
          title: "An offer expired",
          body: "Your offer expired before it was accepted. The shift may still be available.",
          relatedEntityType: "trade_offer",
          relatedEntityId: offer.id,
        },
        client,
      );
      await releaseShiftIfIdle(client, offer.offered_shift_id);
    }

    const expiredRequests = await query<TradeRequestRow>(
      `UPDATE trade_requests
          SET status = 'expired'
        WHERE status IN ('open', 'offer_pending') AND expires_at <= now()
          ${scope}
        RETURNING *`,
      params,
      client,
    );
    for (const request of expiredRequests) {
      const userId = await userIdForResident(request.initiating_resident_id, client);
      await notify(
        {
          recipientUserId: userId,
          type: "trade.expired",
          title: "Your trade post expired",
          body: "Nobody completed a switch before the post expired. You can post it again.",
          relatedEntityType: "trade_request",
          relatedEntityId: request.id,
        },
        client,
      );
      await query(
        `UPDATE shifts SET status = 'scheduled'
          WHERE id = $1 AND status IN ('posted', 'offer_pending')`,
        [request.source_shift_id],
        client,
      );
      await recordAudit(
        {
          programId: request.program_id,
          actorLabel: "system",
          action: "trade.expired",
          entityType: "trade_request",
          entityId: request.id,
          newState: { status: "expired" },
        },
        client,
      );
    }

    const completedShifts = await query<{ id: string }>(
      `UPDATE shifts
          SET status = 'completed'
        WHERE status = 'scheduled' AND end_datetime < now()
          ${scope}
        RETURNING id`,
      params,
      client,
    );

    return {
      expiredRequests: expiredRequests.length,
      expiredOffers: expiredOffers.length,
      completedShifts: completedShifts.length,
    };
  });
}

/**
 * Called when a shift is cancelled or reassigned by an administrator: any live
 * trade activity that depends on it is invalidated and the residents are told
 * why (spec §21 / §46 "schedule changed").
 */
export async function invalidateTradesForShift(
  client: PoolClient,
  shiftId: string,
  reason: string,
  actor: { userId: string | null; programId: string },
): Promise<number> {
  const offers = await query<TradeOfferRow>(
    `SELECT o.* FROM trade_offers o
       JOIN trade_requests r ON r.id = o.trade_request_id
      WHERE o.status IN ('pending', 'accepted')
        AND (o.offered_shift_id = $1 OR r.source_shift_id = $1)`,
    [shiftId],
    client,
  );
  for (const offer of offers) {
    await invalidateOffer(client, offer, reason, actor.userId, actor.programId);
  }

  const requests = await query<TradeRequestRow>(
    `UPDATE trade_requests
        SET status = 'cancelled'
      WHERE source_shift_id = $1
        AND status IN ('open', 'offer_pending', 'accepted', 'pending_approval', 'approved')
      RETURNING *`,
    [shiftId],
    client,
  );
  for (const request of requests) {
    const userId = await userIdForResident(request.initiating_resident_id, client);
    await notify(
      {
        recipientUserId: userId,
        type: "shift.changed",
        title: "Your posted shift changed",
        body: reason,
        relatedEntityType: "trade_request",
        relatedEntityId: request.id,
      },
      client,
    );
  }
  return offers.length + requests.length;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface AvailableTradeRow extends TradeRequestRow {
  shift: ShiftDetail;
  initiator_name: string;
  initiator_pgy: number;
  offer_count: number;
  my_offer_id: string | null;
  my_offer_status: string | null;
}

export async function listAvailableTrades(
  programId: string,
  viewerResidentId: string | null,
  options: { limit?: number; offset?: number } = {},
): Promise<AvailableTradeRow[]> {
  const rows = await query<
    TradeRequestRow & {
      shift_id: string;
      initiator_name: string;
      initiator_pgy: number;
      offer_count: string;
      my_offer_id: string | null;
      my_offer_status: string | null;
    }
  >(
    `SELECT r.*,
            r.source_shift_id AS shift_id,
            u.full_name AS initiator_name,
            res.pgy_level AS initiator_pgy,
            (SELECT count(*) FROM trade_offers o
              WHERE o.trade_request_id = r.id AND o.status = 'pending')::text AS offer_count,
            mo.id AS my_offer_id,
            mo.status::text AS my_offer_status
       FROM trade_requests r
       JOIN residents res ON res.id = r.initiating_resident_id
       JOIN users u ON u.id = res.user_id
       LEFT JOIN LATERAL (
            SELECT o.id, o.status FROM trade_offers o
             WHERE o.trade_request_id = r.id
               AND o.offering_resident_id = $2
               AND o.status IN ('pending', 'accepted')
             LIMIT 1
       ) mo ON true
      WHERE r.program_id = $1
        AND r.status IN ('open', 'offer_pending')
        AND r.expires_at > now()
        AND ($2::uuid IS NULL OR r.initiating_resident_id <> $2::uuid)
      ORDER BY r.created_at DESC
      LIMIT $3 OFFSET $4`,
    [programId, viewerResidentId, Math.min(options.limit ?? 50, 100), options.offset ?? 0],
  );

  const shiftIds = rows.map((row) => row.source_shift_id);
  const shifts = shiftIds.length
    ? await query<ShiftDetail>(
        `${SHIFT_DETAIL_SELECT} WHERE s.id = ANY($1::uuid[])`,
        [shiftIds],
      )
    : [];
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));

  return rows
    .filter((row) => shiftById.has(row.source_shift_id))
    .map((row) => ({
      ...row,
      shift: shiftById.get(row.source_shift_id) as ShiftDetail,
      offer_count: Number(row.offer_count),
    }));
}

export interface TradeRequestDetail extends TradeRequestRow {
  shift: ShiftDetail;
  initiator_name: string;
  initiator_user_id: string;
  offers: Array<
    TradeOfferRow & {
      offered_shift: ShiftDetail;
      offering_resident_name: string;
      offering_resident_pgy: number;
    }
  >;
}

export async function getTradeRequestDetail(
  requestId: string,
  programId: string,
): Promise<TradeRequestDetail | null> {
  const request = await queryOne<
    TradeRequestRow & { initiator_name: string; initiator_user_id: string }
  >(
    `SELECT r.*, u.full_name AS initiator_name, u.id AS initiator_user_id
       FROM trade_requests r
       JOIN residents res ON res.id = r.initiating_resident_id
       JOIN users u ON u.id = res.user_id
      WHERE r.id = $1 AND r.program_id = $2`,
    [requestId, programId],
  );
  if (!request) return null;

  const shift = await getShiftDetail(request.source_shift_id);
  if (!shift) return null;

  const offerRows = await query<
    TradeOfferRow & { offering_resident_name: string; offering_resident_pgy: number }
  >(
    `SELECT o.*, u.full_name AS offering_resident_name, res.pgy_level AS offering_resident_pgy
       FROM trade_offers o
       JOIN residents res ON res.id = o.offering_resident_id
       JOIN users u ON u.id = res.user_id
      WHERE o.trade_request_id = $1
      ORDER BY o.created_at DESC`,
    [requestId],
  );
  const offeredShifts = offerRows.length
    ? await query<ShiftDetail>(
        `${SHIFT_DETAIL_SELECT} WHERE s.id = ANY($1::uuid[])`,
        [offerRows.map((offer) => offer.offered_shift_id)],
      )
    : [];
  const shiftById = new Map(offeredShifts.map((s) => [s.id, s]));

  return {
    ...request,
    shift,
    offers: offerRows
      .filter((offer) => shiftById.has(offer.offered_shift_id))
      .map((offer) => ({
        ...offer,
        offered_shift: shiftById.get(offer.offered_shift_id) as ShiftDetail,
      })),
  };
}

export async function listPendingApprovals(programId: string): Promise<TradeRequestDetail[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM trade_requests
      WHERE program_id = $1 AND status = 'pending_approval'
      ORDER BY updated_at ASC`,
    [programId],
  );
  const details = await Promise.all(
    rows.map((row) => getTradeRequestDetail(row.id, programId)),
  );
  return details.filter((detail): detail is TradeRequestDetail => Boolean(detail));
}

export interface CompletedTradeDetail extends CompletedTradeRow {
  source_shift: ShiftDetail;
  destination_shift: ShiftDetail;
  resident_a_name: string;
  resident_b_name: string;
  resident_a_email: string;
  resident_b_email: string;
  resident_a_user_id: string;
  resident_b_user_id: string;
  email_status: string | null;
  email_record_id: string | null;
}

export async function getCompletedTrade(
  completedTradeId: string,
  programId: string,
): Promise<CompletedTradeDetail | null> {
  const row = await queryOne<
    CompletedTradeRow & {
      resident_a_name: string;
      resident_b_name: string;
      resident_a_email: string;
      resident_b_email: string;
      resident_a_user_id: string;
      resident_b_user_id: string;
      email_status: string | null;
      email_record_id: string | null;
    }
  >(
    `SELECT ct.*,
            ua.full_name AS resident_a_name, ua.email AS resident_a_email, ua.id AS resident_a_user_id,
            ub.full_name AS resident_b_name, ub.email AS resident_b_email, ub.id AS resident_b_user_id,
            er.status::text AS email_status,
            er.id AS email_record_id
       FROM completed_trades ct
       JOIN residents ra ON ra.id = ct.resident_a
       JOIN users ua ON ua.id = ra.user_id
       JOIN residents rb ON rb.id = ct.resident_b
       JOIN users ub ON ub.id = rb.user_id
       LEFT JOIN LATERAL (
            SELECT e.id, e.status FROM email_records e
             WHERE e.completed_trade_id = ct.id
             ORDER BY e.generated_at DESC LIMIT 1
       ) er ON true
      WHERE ct.id = $1 AND ct.program_id = $2`,
    [completedTradeId, programId],
  );
  if (!row) return null;
  const [sourceShift, destinationShift] = await Promise.all([
    getShiftDetail(row.source_shift_id),
    getShiftDetail(row.destination_shift_id),
  ]);
  if (!sourceShift || !destinationShift) return null;
  return { ...row, source_shift: sourceShift, destination_shift: destinationShift };
}

export async function listCompletedTradesForResident(
  residentId: string,
  programId: string,
  limit = 50,
): Promise<CompletedTradeDetail[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM completed_trades
      WHERE program_id = $1 AND (resident_a = $2 OR resident_b = $2)
      ORDER BY completed_at DESC
      LIMIT $3`,
    [programId, residentId, Math.min(limit, 100)],
  );
  const details = await Promise.all(rows.map((row) => getCompletedTrade(row.id, programId)));
  return details.filter((detail): detail is CompletedTradeDetail => Boolean(detail));
}

export async function listMyTradeActivity(
  residentId: string,
  programId: string,
): Promise<{
  posted: TradeRequestDetail[];
  offersMade: Array<TradeOfferRow & { request: TradeRequestDetail }>;
}> {
  const postedRows = await query<{ id: string }>(
    `SELECT id FROM trade_requests
      WHERE program_id = $1 AND initiating_resident_id = $2
        AND status IN ('open', 'offer_pending', 'accepted', 'pending_approval', 'approved')
      ORDER BY created_at DESC`,
    [programId, residentId],
  );
  const posted = (
    await Promise.all(postedRows.map((row) => getTradeRequestDetail(row.id, programId)))
  ).filter((detail): detail is TradeRequestDetail => Boolean(detail));

  const offerRows = await query<TradeOfferRow>(
    `SELECT o.* FROM trade_offers o
       JOIN trade_requests r ON r.id = o.trade_request_id
      WHERE r.program_id = $1 AND o.offering_resident_id = $2
        AND o.status IN ('pending', 'accepted')
      ORDER BY o.created_at DESC`,
    [programId, residentId],
  );
  const offersMade = (
    await Promise.all(
      offerRows.map(async (offer) => {
        const request = await getTradeRequestDetail(offer.trade_request_id, programId);
        return request ? { ...offer, request } : null;
      }),
    )
  ).filter((row): row is TradeOfferRow & { request: TradeRequestDetail } => Boolean(row));

  return { posted, offersMade };
}

export function toShiftSummary(shift: ShiftDetail) {
  return toShiftInfo(shift);
}
