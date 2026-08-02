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
import { can } from "@/server/auth/roles";
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

/**
 * Some rejections need a durable side effect: when an offer turns out to be
 * expired or no longer permitted, the offer must be marked as such *and* the
 * caller must still see the error. Because the surrounding transaction rolls
 * back, the write is carried out afterwards, in its own transaction.
 */
class RollbackWithFollowUp extends Error {
  constructor(
    readonly appError: AppError,
    readonly followUp: () => Promise<void>,
  ) {
    super(appError.message);
    this.name = "RollbackWithFollowUp";
  }
}

async function withFollowUp<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RollbackWithFollowUp) {
      try {
        await error.followUp();
      } catch (followUpError) {
        logger.error("trade.follow_up_failed", {
          message:
            followUpError instanceof Error ? followUpError.message : String(followUpError),
        });
      }
      throw error.appError;
    }
    throw error;
  }
}

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
  /**
   * `switch` wants a shift back; `giveaway` does not.
   *
   * Decided when the shift is posted rather than when somebody responds,
   * because it changes what the posting *is* and therefore who should see it
   * and what they are being asked for. A colleague reading the board needs to
   * know whether saying yes costs them a shift or gains them one before they
   * tap, not after.
   */
  kind?: "switch" | "giveaway";
}

export async function postShiftForTrade(
  context: AuthedContext & { resident: { id: string } },
  input: PostShiftInput,
): Promise<TradeRequestRow> {
  return withTransaction((client) => postShiftWithin(context, input, client));
}

/**
 * Posting, inside a transaction somebody else opened.
 *
 * Split out for exactly one caller: a resident naming a shift they work *in
 * order to* post it (`./ad-hoc.ts`). Creating the shift and posting it are one
 * act from where they are standing, and half of it succeeding is the worst
 * outcome available — a shift on their schedule that they believe they have
 * given away. One transaction, or neither.
 */
export async function postShiftWithin(
  context: AuthedContext & { resident: { id: string } },
  input: PostShiftInput,
  client: PoolClient,
): Promise<TradeRequestRow> {
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
      "Your program does not allow this shift to be switched, so it cannot be posted.",
    );
  }
  if (shift.start_datetime.getTime() <= Date.now()) {
    throw validationFailed("This shift has already started, so it cannot be switched.");
  }
  if (shift.trade_deadline && shift.trade_deadline.getTime() <= Date.now()) {
    throw validationFailed("The deadline for switching this shift has passed.");
  }
  if (shift.status !== "scheduled") {
    throw conflict("This shift is already part of a switch.");
  }

  const expiresAt =
    input.expiresAt ??
    new Date(
      Math.min(
        Date.now() + DEFAULT_REQUEST_TTL_DAYS * 86_400_000,
        shift.start_datetime.getTime(),
      ),
    );

  const kind = input.kind ?? "switch";
  const request = await queryOne<TradeRequestRow>(
    `INSERT INTO trade_requests
       (program_id, source_shift_id, initiating_resident_id, preferences, notes, expires_at, kind)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING *`,
    [
      context.program.id,
      shift.id,
      context.resident.id,
      JSON.stringify(input.preferences ?? {}),
      input.notes ?? "",
      expiresAt,
      kind,
    ],
    client,
  );

  await query("UPDATE shifts SET status = 'posted' WHERE id = $1", [shift.id], client);

  await recordAudit(
    {
      programId: context.program.id,
      actorUserId: context.user.id,
      actorLabel: context.user.email,
      action: kind === "giveaway" ? "giveaway.posted" : "trade.posted",
      entityType: "trade_request",
      entityId: request!.id,
      previousState: { shiftStatus: shift.status },
      newState: {
        shiftId: shift.id,
        shiftStatus: "posted",
        kind,
        preferences: input.preferences ?? {},
        expiresAt,
      },
    },
    client,
  );

  /* Tell the people who could take it.
   *
   * A giveaway is the one posting with no specific counterparty: a switch goes
   * on the board and waits for somebody with a shift to trade, but a shift
   * being given away is useful to anybody free that day, and nobody is
   * watching the board at 3am. Without this the event existed in the catalogue
   * and in the audit trail and was never once sent, which is the same as the
   * board being the only way to find out.
   *
   * `giveaway.posted` is *ambient* — it defaults off — so this reaches only
   * residents who asked for it. That is the point of the default: the person
   * who wants extra shifts opts in, and everybody else is not woken up for
   * somebody else's Saturday.
   *
   * The poster is excluded because being told about your own posting is noise,
   * and `notify` filters by preference server-side, so a resident who turned
   * this off has nothing written for them at all rather than something hidden
   * on a screen. */
  if (kind === "giveaway") {
    const program = await getProgram(context.program.id, client);
    const others = await query<{ id: string }>(
      `SELECT u.id FROM users u
         JOIN residents r ON r.user_id = u.id
        WHERE u.program_id = $1 AND u.active = true AND r.id <> $2`,
      [context.program.id, context.resident.id],
      client,
    );
    await notify(
      others.map((row) => ({
        recipientUserId: row.id,
        type: "giveaway.posted" as const,
        title: "A shift you could pick up",
        body: `${context.user.fullName} is giving away ${shiftLabel(shift, program.timezone)}.`,
        relatedEntityType: "trade_request",
        relatedEntityId: request!.id,
      })),
      client,
    );
  }

  return request as TradeRequestRow;
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
    if (!request) throw notFound("That posted shift no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    const isOwner = context.resident?.id === request.initiating_resident_id;
    const isElevated = can(context.user.role, "approvals.decide");
    if (!isOwner && !isElevated) {
      throw forbidden("You can only take down a shift you posted.");
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
      [request.id, "The resident took this shift down."],
      client,
    );
    /* `releaseShiftIfIdle`, not a flat reset to 'scheduled'.
     *
     * A resident may offer the same shift on several postings — that is
     * allowed, and only one can win. A flat reset here handed the shift back as
     * "scheduled" the moment *any* one of those postings was cancelled, while
     * the resident's other offers were still live against it. The shift then
     * looked free while a pending offer could still trade it away. */
    await releaseShiftIfIdle(client, request.source_shift_id);

    for (const offer of affectedOffers) {
      const userId = await userIdForResident(offer.offering_resident_id, client);
      await notify(
        {
          recipientUserId: userId,
          type: "trade.cancelled",
          title: "A shift you offered on was taken down",
          body: "This offer is no longer available because the resident took the shift down.",
          relatedEntityType: "trade_offer",
          relatedEntityId: offer.id,
          route: `/switches/${request.id}`,
        },
        client,
      );
      await releaseShiftIfIdle(client, offer.offered_shift_id);
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
    if (!request) throw notFound("That posted shift no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    if (request.initiating_resident_id === context.resident.id) {
      throw validationFailed("You cannot offer on a shift you posted yourself.");
    }
    if (request.status !== "open" && request.status !== "offer_pending") {
      throw conflict(
        "This shift is no longer taking offers. Refresh the board and try again.",
      );
    }
    if (request.expires_at.getTime() <= Date.now()) {
      throw new AppError("expired", "This posted shift has expired.");
    }

    const [sourceShift, offeredShift] = await lockShifts(
      client,
      request.source_shift_id,
      input.offeredShiftId,
    );
    if (!sourceShift || !offeredShift) {
      throw notFound("One of the shifts in this switch no longer exists.");
    }
    if (offeredShift.resident_id !== context.resident.id) {
      throw forbidden("You can only offer shifts that are assigned to you.");
    }
    if (sourceShift.resident_id !== request.initiating_resident_id) {
      throw conflict(
        "This shift was reassigned, so it is no longer available to switch.",
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
        validation.failures[0]?.message ?? "This switch is not permitted.",
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
        route: `/switches/${request.id}`,
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
    if (!request) throw notFound("That posted shift no longer exists.");
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

    /* The body names the shift. It used to be the decline reason and nothing
       else — so a resident with two offers out read "I need something earlier
       in the week" on their phone with no way to tell which of the two it was
       about. The reason still comes through; it is now attributed. */
    const declinedShift = await getShiftDetail(request.source_shift_id, client);
    const declinedLabel = declinedShift
      ? shiftLabel(declinedShift, context.program.timezone)
      : "a posted shift";
    const offeringUserId = await userIdForResident(offer.offering_resident_id, client);
    await notify(
      {
        recipientUserId: offeringUserId,
        type: "offer.rejected",
        title: "Your offer was declined",
        route: `/switches/${request.id}`,
        body: reason?.trim()
          ? `Your offer for ${declinedLabel} was declined: "${reason.trim()}" The shift may still be available.`
          : `Your offer for ${declinedLabel} was declined. The shift may still be available to other residents.`,
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

/**
 * Returns a shift to `scheduled`/`posted` when nothing live references it.
 *
 * The lock is the whole correctness argument, and it was missing.
 *
 * This is read-modify-write: count what still references the shift, then decide
 * its status. Under READ COMMITTED two transactions closing two different
 * offers on the *same* shift each ran their count before the other committed,
 * so each still saw one live offer and each declined to release. Both were
 * individually right and the shift was left `offer_pending` with nothing
 * referencing it — permanently, because nothing revisits it, and
 * `postShiftForTrade` refuses anything that is not `scheduled`. The resident
 * simply lost the ability to trade that shift, with no error and nothing on any
 * screen to explain it.
 *
 * It needed real concurrency to produce: running the same sequence one call at
 * a time never reaches it. Taking the shift row first serialises the two, and
 * the loser re-counts after the winner has committed and sees the truth.
 */
async function releaseShiftIfIdle(client: PoolClient, shiftId: string): Promise<void> {
  await query("SELECT id FROM shifts WHERE id = $1 FOR UPDATE", [shiftId], client);
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
  return withFollowUp(() =>
    withTransaction(async (client) => {
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
    if (!request) throw notFound("That posted shift no longer exists.");
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
      throw new RollbackWithFollowUp(
        new AppError("expired", "This offer has expired and can no longer be accepted."),
        async () => {
          await query(
            "UPDATE trade_offers SET status = 'expired' WHERE id = $1 AND status = 'pending'",
            [offer.id],
          );
        },
      );
    }
    if (request.status !== "open" && request.status !== "offer_pending") {
      throw conflict("This switch is no longer active.");
    }
    /* The posting's own expiry, not just the offer's.
     *
     * `createOffer` refuses to make an offer on an expired posting, and
     * accepting one is the more consequential half — but only the offer's
     * expiry was checked here. The two are normally the same, because an offer
     * is created with `min(default TTL, request.expires_at)`. They come apart
     * whenever the posting's deadline moves after the offer exists: an
     * administrator pulling the shift's start time earlier shortens the
     * posting, and the offer keeps the deadline it was born with. The expiry
     * sweep would eventually close the posting, but "eventually" is a race —
     * between the sweep and a resident's tap, the tap could still complete a
     * switch on a posting the program considered closed. */
    if (request.expires_at.getTime() <= Date.now()) {
      throw new RollbackWithFollowUp(
        new AppError("expired", "This posted shift expired, so the switch can no longer be completed."),
        async () => {
          /* The same cleanup the sweep does, not just a status flip: whichever
             of the two gets here first must leave the posting fully closed, or
             the other finds nothing to expire and the offered shifts leak. The
             UPDATE is guarded on the previous status, so exactly one of them
             matches a row and does the work. */
          await withTransaction(async (followUpClient) => {
            const expired = await queryOne<TradeRequestRow>(
              `UPDATE trade_requests SET status = 'expired'
                WHERE id = $1 AND status IN ('open', 'offer_pending')
              RETURNING *`,
              [request.id],
              followUpClient,
            );
            if (expired) await closeExpiredRequest(followUpClient, expired);
          });
        },
      );
    }

    const program = await getProgram(context.program.id, client);
    const { sourceShift, offeredShift, validation } = await revalidate(
      client,
      program,
      request,
      offer,
    );

    if (!validation.valid) {
      const reason =
        validation.failures[0]?.message ??
        "This switch is no longer permitted by your program's rules.";
      throw new RollbackWithFollowUp(
        new AppError(
          "rule_violation",
          `This switch can no longer be completed: ${reason}`,
          { validation },
        ),
        () =>
          withTransaction((followUpClient) =>
            invalidateOffer(
              followUpClient,
              offer,
              reason,
              context.user.id,
              context.program.id,
            ),
          ),
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
    }),
  );
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
    throw notFound("One of the shifts in this switch no longer exists.");
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
  /* Hand the shift back.
   *
   * This is the single place an offer stops being live for a reason other than
   * the resident's own choice, and it did not touch the shift's status. The
   * offer went to 'invalidated' and the shift stayed 'offer_pending' — a state
   * `postShiftForTrade` refuses ("This shift is already involved in a trade"),
   * with no trade left to point at. Every caller leaked: an administrator
   * reassigning a shift, a cancelled posting, and the competing offers closed
   * out by a completed switch. */
  await releaseShiftIfIdle(client, offer.offered_shift_id);
  const offeringUserId = await userIdForResident(offer.offering_resident_id, client);
  await notify(
    {
      recipientUserId: offeringUserId,
      type: "offer.invalidated",
      title: "Your offer is no longer available",
      body: reason,
      relatedEntityType: "trade_offer",
      relatedEntityId: offer.id,
      /* The posting, not the offer. This is the notification a resident is
         least able to act on — they did nothing, somebody else's offer was
         accepted first — so it has to land somewhere that explains itself.
         Without an explicit route it fell through to a generic list. */
      route: `/switches/${offer.trade_request_id}`,
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
  /**
   * The shift coming back the other way, or null for a giveaway.
   *
   * Null is what makes this one writer instead of two. The atomic move is the
   * most consequential code in the product — `SELECT … FOR UPDATE`, a guarded
   * row count, offer invalidation, the completion record and the audit trail,
   * all in one transaction — and a second copy of it for one-way transfers
   * would be the place the two shapes quietly drift apart. A partial or
   * inconsistent switch is the worst thing this software can do; two
   * implementations of it is how that happens.
   */
  offeredShift: ShiftDetail | null;
  /** Who is taking the shift, when there is no offered shift to name them by. */
  takingResidentId?: string;
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
  const residentB = offeredShift
    ? offer.offering_resident_id
    : (input.takingResidentId ?? offer.offering_resident_id);
  const oneWay = offeredShift === null;

  /* Every shift this finalisation touches. One for a giveaway, two for a
     switch — written once so the status update, the lock set and the
     invalidation sweep below cannot disagree about which is which. */
  const shiftIds = oneWay ? [sourceShift.id] : [sourceShift.id, offeredShift.id];

  const previousAssignments = oneWay
    ? { [sourceShift.id]: residentA }
    : { [sourceShift.id]: residentA, [offeredShift.id]: residentB };
  const resultingAssignments = oneWay
    ? { [sourceShift.id]: residentB }
    : { [sourceShift.id]: residentB, [offeredShift.id]: residentA };

  /* End the current assignments. The row count guards against a concurrent
     change that slipped between validation and this write.
   *
   * A giveaway ends exactly one: the poster's hold on their own shift. They
   * keep it right up to this statement — there is no window in which the shift
   * is live and unheld, because the end and the reassignment are the same
   * transaction. */
  const endedRows = await query<{ id: string }>(
    /* Parameter lists are built per shape rather than padded with a null:
       an unused `$2` leaves PostgreSQL unable to infer its type and the
       statement is rejected outright. */
    oneWay
      ? `UPDATE shift_assignments
            SET assignment_status = 'ended', ended_at = now()
          WHERE assignment_status = 'active'
            AND shift_id = $1 AND resident_id = $2
          RETURNING id`
      : `UPDATE shift_assignments
            SET assignment_status = 'ended', ended_at = now()
          WHERE assignment_status = 'active'
            AND ((shift_id = $1 AND resident_id = $3) OR (shift_id = $2 AND resident_id = $4))
          RETURNING id`,
    oneWay
      ? [sourceShift.id, residentA]
      : [sourceShift.id, offeredShift.id, residentA, residentB],
    client,
  );
  if (endedRows.length !== shiftIds.length) {
    throw conflict(
      oneWay
        ? "This shift changed while it was being taken. Nothing was changed — please try again."
        : "These shifts changed while the switch was being completed. Nothing was changed — please try again.",
    );
  }

  await query(
    oneWay
      ? `INSERT INTO shift_assignments (shift_id, resident_id, assignment_status)
         VALUES ($1, $2, 'active')`
      : `INSERT INTO shift_assignments (shift_id, resident_id, assignment_status)
         VALUES ($1, $2, 'active'), ($3, $4, 'active')`,
    oneWay
      ? [sourceShift.id, residentB]
      : [sourceShift.id, residentB, offeredShift.id, residentA],
    client,
  );

  await query(
    `UPDATE shifts SET status = 'scheduled' WHERE id = ANY($1::uuid[])`,
    [shiftIds],
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
    [offer.id, shiftIds],
    client,
  );
  for (const orphan of orphanedOffers) {
    await invalidateOffer(
      client,
      orphan,
      "This offer is no longer available because the shift was assigned through another completed switch.",
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
    [request.id, shiftIds],
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
        validation_snapshot, completed_by, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
     RETURNING *`,
    [
      program.id,
      request.id,
      offer.id,
      sourceShift.id,
      /* Null for both, and pinned by a CHECK constraint: a giveaway that named
         a destination shift or a second resident would be a switch wearing the
         wrong label, and the invariant reads `kind` to decide how many legs to
         expect. */
      offeredShift?.id ?? null,
      residentA,
      oneWay ? null : residentB,
      JSON.stringify(previousAssignments),
      JSON.stringify(resultingAssignments),
      input.approvalRequired,
      input.approvedBy ?? null,
      input.approvedBy ? new Date() : null,
      input.approvalNotes ?? null,
      input.overrideApplied ?? false,
      JSON.stringify(validation),
      actorUserId,
      oneWay ? "giveaway" : "switch",
    ],
    client,
  );

  /* One leg for a giveaway, two for a switch. This is the fact the invariant
     checks, and the reason it can tell the shapes apart rather than being
     loosened to "one or two legs is fine" — which would have stopped catching
     the half-applied switch it was written for. */
  await query(
    oneWay
      ? `INSERT INTO trade_legs (completed_trade_id, leg_index, shift_id, from_resident_id, to_resident_id)
         VALUES ($1, 0, $2, $3, $4)`
      : `INSERT INTO trade_legs (completed_trade_id, leg_index, shift_id, from_resident_id, to_resident_id)
         VALUES ($1, 0, $2, $3, $4), ($1, 1, $5, $4, $3)`,
    oneWay
      ? [completed!.id, sourceShift.id, residentA, residentB]
      : [completed!.id, sourceShift.id, residentA, residentB, offeredShift.id],
    client,
  );

  const userA = await userIdForResident(residentA, client);
  const userB = await userIdForResident(residentB, client);
  await notify(
    oneWay
      ? [
          {
            recipientUserId: userA,
            type: "giveaway.taken" as const,
            title: "Somebody took your shift",
            /* Names the shift the way the rest of the product names it, and
               says the thing the poster actually wants to know: they are off
               it. */
            body: `${shiftLabel(sourceShift, program.timezone)} is covered. You are no longer on it.`,
            relatedEntityType: "completed_trade",
            relatedEntityId: completed!.id,
          },
          {
            recipientUserId: userB,
            type: "giveaway.taken" as const,
            title: "You picked up a shift",
            body: `You now work ${shiftLabel(sourceShift, program.timezone)}.`,
            relatedEntityType: "completed_trade",
            relatedEntityId: completed!.id,
          },
        ]
      : [
          {
            recipientUserId: userA,
            type: "switch.completed" as const,
            title: "Shift switch completed",
            body: `You now work ${shiftLabel(offeredShift!, program.timezone)}. ${sourceShift.service_name} on ${formatShiftDate(sourceShift.start_datetime, program.timezone)} is covered.`,
            relatedEntityType: "completed_trade",
            relatedEntityId: completed!.id,
          },
          {
            recipientUserId: userB,
            type: "switch.completed" as const,
            title: "Shift switch completed",
            body: `You now work ${shiftLabel(sourceShift, program.timezone)}. ${offeredShift!.service_name} on ${formatShiftDate(offeredShift!.start_datetime, program.timezone)} is covered.`,
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
  /* Only a switch moves a second shift. A giveaway's single reassignment is
     recorded above; adding a second entry naming a shift that did not move
     would put a fiction in the audit trail. */
  if (!oneWay) {
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
  }

  logger.info("trade.completed", {
    completedTradeId: completed!.id,
    programId: program.id,
    invalidatedOffers: orphanedOffers.length,
    cancelledRequests: orphanRequests.length,
  });

  return completed as CompletedTradeRow;
}

/**
 * Finalising a giveaway: the same writer, one leg.
 *
 * Exported so `./giveaway.ts` can drive it without duplicating the atomic
 * move. Deliberately not a second implementation — `finaliseTrade` holds the
 * guarded row count, the offer invalidation sweep, the completion record and
 * the audit entries, and a shape that had its own copy of all that is a shape
 * whose bugs get fixed once.
 */
export async function finaliseGiveaway(
  client: PoolClient,
  input: Omit<FinaliseInput, "offeredShift" | "approvalRequired"> & {
    takingResidentId: string;
  },
): Promise<CompletedTradeRow> {
  return finaliseTrade(client, {
    ...input,
    offeredShift: null,
    approvalRequired: false,
  });
}

// ---------------------------------------------------------------------------
// Chief approval
// ---------------------------------------------------------------------------

/**
 * Approval is a privileged operation. The route handler already requires the
 * chief role; this is the second, authoritative check so the rule holds no
 * matter which caller reaches the service.
 */
/**
 * Who may decide a switch. The capability, not a literal pair of roles.
 *
 * The literal version — `role !== "chief" && role !== "admin"` — was written
 * before APD and PD existed, and the two halves of the approvals feature then
 * disagreed: the queue is guarded by `requireCapability("approvals.decide")`,
 * so an APD could open it, see the switches waiting, press Approve, and be told
 * they were not allowed. Both halves now read the same matrix.
 */
function assertApprover(context: AuthedContext): void {
  if (!can(context.user.role, "approvals.decide")) {
    throw forbidden("Only chief residents and program leadership can decide on a switch.");
  }
}

export async function approveTrade(
  context: AuthedContext,
  requestId: string,
  options: { notes?: string; override?: { reason: string } } = {},
): Promise<{ completedTradeId: string; validation: TradeValidationResult }> {
  assertApprover(context);
  return withTransaction(async (client) => {
    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [requestId],
      client,
    );
    if (!request) throw notFound("That switch no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    if (request.status !== "pending_approval") {
      throw conflict("This switch is not waiting for approval.");
    }
    const offer = await queryOne<TradeOfferRow>(
      `SELECT * FROM trade_offers
        WHERE trade_request_id = $1 AND status = 'accepted'
        ORDER BY updated_at DESC LIMIT 1
        FOR UPDATE`,
      [request.id],
      client,
    );
    if (!offer) throw notFound("The offer you accepted is no longer available.");

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
  assertApprover(context);
  if (!reason.trim()) {
    throw validationFailed("Say why you are turning this switch down — both residents will read it.");
  }
  await withTransaction(async (client) => {
    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [requestId],
      client,
    );
    if (!request) throw notFound("That switch no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    if (request.status !== "pending_approval") {
      throw conflict("This switch is not waiting for approval.");
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

/**
 * A middle course between approving and rejecting: the chief sends the trade
 * back to the residents with a note. The accepted offer is declined, but the
 * shift stays posted so a different — or corrected — offer can be made.
 */
export async function requestTradeChanges(
  context: AuthedContext,
  requestId: string,
  message: string,
): Promise<void> {
  assertApprover(context);
  if (!message.trim()) {
    throw validationFailed("Say what needs to change.");
  }
  await withTransaction(async (client) => {
    const request = await queryOne<TradeRequestRow>(
      "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
      [requestId],
      client,
    );
    if (!request) throw notFound("That switch no longer exists.");
    if (request.program_id !== context.program.id) throw forbidden();
    if (request.status !== "pending_approval") {
      throw conflict("This switch is not waiting for approval.");
    }

    const offers = await query<TradeOfferRow>(
      `UPDATE trade_offers SET status = 'rejected', invalidation_reason = $2
        WHERE trade_request_id = $1 AND status IN ('pending', 'accepted')
      RETURNING *`,
      [request.id, message],
      client,
    );
    assertRequestTransition(request.status, "open");
    await query(
      "UPDATE trade_requests SET status = 'open' WHERE id = $1",
      [request.id],
      client,
    );
    await query(
      "UPDATE shifts SET status = 'posted' WHERE id = $1 AND status IN ('offer_pending', 'pending_approval')",
      [request.source_shift_id],
      client,
    );
    for (const offer of offers) {
      await releaseShiftIfIdle(client, offer.offered_shift_id);
    }

    const recipients = new Set<string>();
    recipients.add(await userIdForResident(request.initiating_resident_id, client));
    for (const offer of offers) {
      recipients.add(await userIdForResident(offer.offering_resident_id, client));
    }
    await notify(
      Array.from(recipients).map((userId) => ({
        recipientUserId: userId,
        type: "approval.rejected" as const,
        title: "Changes requested before approval",
        body: `${context.user.fullName}: ${message}`,
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
        action: "trade.changes_requested",
        entityType: "trade_request",
        entityId: request.id,
        previousState: { status: request.status },
        newState: { status: "open" },
        reason: message,
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
 * Everything that must happen when a posting expires.
 *
 * Extracted because there are two ways in. The sweep finds postings past their
 * deadline; `acceptOffer` also discovers one the moment a resident taps Accept
 * on a posting that has just lapsed, and closes it there rather than leaving it
 * for the next sweep. When those two paths did different amounts of work, which
 * of them got there first decided whether the cleanup happened at all — and the
 * accept path, which only flipped the status, would leave every shift offered
 * on that posting stuck in `offer_pending` with nothing referencing it.
 *
 * The caller is responsible for having flipped the request to `expired` with an
 * UPDATE guarded on its previous status, which is what makes this safe to race:
 * only the transaction whose UPDATE actually matched a row gets here, so the
 * cleanup runs exactly once.
 */
async function closeExpiredRequest(
  client: PoolClient,
  request: TradeRequestRow,
): Promise<void> {
  const userId = await userIdForResident(request.initiating_resident_id, client);
  await notify(
    {
      recipientUserId: userId,
      type: "trade.expired",
      title: "Your posted shift expired",
      body: "Nobody completed a switch before the post expired. You can post it again.",
      relatedEntityType: "trade_request",
      relatedEntityId: request.id,
      route: `/switches/${request.id}`,
    },
    client,
  );

  /* Close the offers that were sitting on it, and release their shifts.
   *
   * Expiring the posting alone left them `pending` against an `expired`
   * request, and every shift somebody had offered stayed `offer_pending` —
   * permanently, because nothing else ever looks at them. `postShiftForTrade`
   * refuses a shift that is not `scheduled`, so the resident who offered was
   * left holding a shift they could never post again, with no offer, no posting
   * and nothing on any screen to explain it. An offer's own expiry did not save
   * them: an offer inherits the posting's deadline only at the moment it is
   * created, and a posting whose shift was moved earlier expires first. */
  const strandedOffers = await query<TradeOfferRow>(
    `UPDATE trade_offers SET status = 'expired'
      WHERE trade_request_id = $1 AND status IN ('pending', 'accepted')
    RETURNING *`,
    [request.id],
    client,
  );
  for (const offer of strandedOffers) {
    const offeringUserId = await userIdForResident(offer.offering_resident_id, client);
    await notify(
      {
        recipientUserId: offeringUserId,
        type: "trade.expired",
        title: "A posting you offered on expired",
        body: "The posting closed before your offer was decided. You still work your own shift.",
        relatedEntityType: "trade_offer",
        relatedEntityId: offer.id,
        route: `/switches/${request.id}`,
      },
      client,
    );
    await releaseShiftIfIdle(client, offer.offered_shift_id);
  }
  await releaseShiftIfIdle(client, request.source_shift_id);

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
      await closeExpiredRequest(client, request);
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
    // The posted shift goes back to being an ordinary shift. Cancelling the
    // request alone left it 'posted' with nothing posting it.
    await releaseShiftIfIdle(client, request.source_shift_id);
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
  /** Computed on read so pages do not have to consult the clock while rendering. */
  expired: boolean;
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
    expired: request.expires_at.getTime() <= Date.now(),
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

/**
 * How long a finished-but-not-completed trade stays on "Mine".
 *
 * A switch that completed lives in History forever. Everything else — declined,
 * withdrawn, invalidated, expired, cancelled — has no permanent home, and used
 * to have no home at all: the query asked only for live rows, so the moment an
 * offer was declined it disappeared from the resident's screen entirely. They
 * got a notification saying it had happened and then found nothing anywhere in
 * the app that agreed. That is the dead end.
 *
 * Two weeks is long enough to answer "what happened to the offer I made?" and
 * short enough that the screen does not become an archive of dead ends.
 */
const RESOLVED_TRADE_WINDOW_DAYS = 14;

export type ResolvedOutcome =
  | "declined"
  | "withdrawn"
  | "unavailable"
  | "expired"
  | "cancelled";

export async function listMyTradeActivity(
  residentId: string,
  programId: string,
): Promise<{
  posted: TradeRequestDetail[];
  offersMade: Array<TradeOfferRow & { request: TradeRequestDetail }>;
  /** Recently finished postings and offers, so nothing silently vanishes. */
  recentlyClosed: Array<{
    kind: "post" | "offer";
    id: string;
    requestId: string;
    shift: ShiftDetail;
    counterpartName: string;
    outcome: ResolvedOutcome;
    detail: string;
    at: Date;
  }>;
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

  const recentlyClosed = await listRecentlyClosed(residentId, programId);

  return { posted, offersMade, recentlyClosed };
}

/**
 * Offers this resident made that ended without a switch, and postings of theirs
 * that ended without one either. Completed switches are excluded — those are
 * History's job, and showing them twice would make "recently closed" read like
 * something went wrong.
 */
async function listRecentlyClosed(
  residentId: string,
  programId: string,
): Promise<
  Array<{
    kind: "post" | "offer";
    id: string;
    requestId: string;
    shift: ShiftDetail;
    counterpartName: string;
    outcome: ResolvedOutcome;
    detail: string;
    at: Date;
  }>
> {
  const rows = await query<{
    kind: "post" | "offer";
    id: string;
    request_id: string;
    shift_id: string;
    counterpart_name: string;
    status: string;
    invalidation_reason: string | null;
    at: Date;
  }>(
    `SELECT 'offer'::text AS kind, o.id, o.trade_request_id AS request_id,
            r.source_shift_id AS shift_id, u.full_name AS counterpart_name,
            o.status::text AS status, o.invalidation_reason,
            o.updated_at AS at
       FROM trade_offers o
       JOIN trade_requests r ON r.id = o.trade_request_id
       JOIN residents res ON res.id = r.initiating_resident_id
       JOIN users u ON u.id = res.user_id
      WHERE r.program_id = $1
        AND o.offering_resident_id = $2
        AND o.status IN ('rejected', 'withdrawn', 'invalidated', 'expired')
        AND o.updated_at > now() - ($3 || ' days')::interval
      UNION ALL
     SELECT 'post'::text AS kind, r.id, r.id AS request_id,
            r.source_shift_id AS shift_id, ''::text AS counterpart_name,
            r.status::text AS status, NULL AS invalidation_reason,
            r.updated_at AS at
       FROM trade_requests r
      WHERE r.program_id = $1
        AND r.initiating_resident_id = $2
        AND r.status IN ('cancelled', 'expired')
        AND r.updated_at > now() - ($3 || ' days')::interval
      ORDER BY at DESC
      LIMIT 20`,
    [programId, residentId, String(RESOLVED_TRADE_WINDOW_DAYS)],
  );
  if (rows.length === 0) return [];

  const shifts = await query<ShiftDetail>(
    `${SHIFT_DETAIL_SELECT} WHERE s.id = ANY($1::uuid[])`,
    [[...new Set(rows.map((row) => row.shift_id))]],
  );
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));

  return rows
    .filter((row) => shiftById.has(row.shift_id))
    .map((row) => {
      const { outcome, detail } = describeClosure(row);
      return {
        kind: row.kind,
        id: row.id,
        requestId: row.request_id,
        shift: shiftById.get(row.shift_id) as ShiftDetail,
        counterpartName: row.counterpart_name,
        outcome,
        detail,
        at: row.at,
      };
    });
}

/** Plain English for why a trade ended, in the second person. */
function describeClosure(row: {
  kind: "post" | "offer";
  status: string;
  invalidation_reason: string | null;
  counterpart_name: string;
}): { outcome: ResolvedOutcome; detail: string } {
  if (row.kind === "post") {
    return row.status === "cancelled"
      ? { outcome: "cancelled", detail: "You took this posting down." }
      : {
          outcome: "expired",
          detail: "This posting expired before anyone offered. You still work the shift.",
        };
  }
  switch (row.status) {
    case "rejected":
      return {
        outcome: "declined",
        detail: `${row.counterpart_name} declined your offer. You still work your own shift.`,
      };
    case "withdrawn":
      return { outcome: "withdrawn", detail: "You withdrew this offer." };
    case "invalidated":
      /* Its own outcome, not a decline. Nobody turned this resident down — the
         posting was taken by a different offer, or the shift moved underneath
         it. Labelling that "declined" tells them something untrue about a
         colleague. */
      return {
        outcome: "unavailable",
        detail:
          row.invalidation_reason ??
          "This offer stopped being available before it was decided.",
      };
    default:
      return {
        outcome: "expired",
        detail: "The posting expired before your offer was decided.",
      };
  }
}

export function toShiftSummary(shift: ShiftDetail) {
  return toShiftInfo(shift);
}
