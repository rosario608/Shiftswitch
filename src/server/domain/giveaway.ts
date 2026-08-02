import type { PoolClient } from "pg";
import { withTransaction, query, queryOne } from "@/server/db/pool";
import type {
  ProgramRow,
  ShiftDetail,
  TradeOfferRow,
  TradeRequestRow,
} from "@/server/db/types";
import type { AuthedContext } from "@/server/auth/guards";
import { conflict, forbidden, notFound, validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";

import { getShiftDetailForUpdate } from "./schedule";
import { buildGiveawayContext, getProgram } from "./trade-context";
import { asOneWayTransfer, validateTrade } from "./validation";
import { formatShiftDate } from "./time";
import { notify, listProgramApprovers } from "./notifications";
import type { ValidationCheck } from "./rules/types";
import { logger } from "@/server/observability/logger";

/**
 * Taking a shift somebody is giving away.
 *
 * ## The shape of the thing
 *
 * A switch is symmetrical and self-limiting: both people end up working the
 * same number of hours they were already working, so the safety rules are
 * mostly confirming that the pieces still fit. A giveaway is not. The taker
 * ends up working **more**, and rest limits, consecutive-day limits and
 * workload caps are the entire reason those rules exist.
 *
 * ## Warn, never refuse
 *
 * A resident who wants to pick up a colleague's Saturday is allowed to, even
 * when it is their sixth day running. That is a decision about their own life
 * and the product does not have standing to overrule it. What it must not do
 * is let them make it without knowing: the warning names the rule, the real
 * numbers, and the total they will reach, and it has to be acknowledged
 * deliberately rather than dismissed by scrolling past.
 *
 * The acknowledgement is recorded — who, what, over which sentences — and
 * shown to whoever oversees coverage. A resident decides; the programme gets
 * to see what was decided. Neither half works without the other: recording it
 * without showing it is a log nobody reads, and showing it without recording
 * the exact sentences means a chief in March cannot tell what the resident was
 * actually told in January, because the rule's numbers may have been edited
 * since.
 *
 * **Failures are still failures.** Nothing here downgrades a `fail` to a
 * warning: a shift that has already started, a resident who is not eligible,
 * or somebody already booked into that hour is refused exactly as a switch
 * would be. "Never refuse it" is about workload, not about physics.
 */

/** A warning the taker has to acknowledge, in the words they will read. */
export interface TakeWarning {
  key: string;
  ruleType: string;
  label: string;
  message: string;
}

export interface TakePreview {
  requestId: string;
  shift: {
    id: string;
    label: string;
    serviceName: string;
    start: Date;
    end: Date;
  };
  warnings: TakeWarning[];
  /** Present when the shift genuinely cannot be taken. */
  blockers: TakeWarning[];
  requiresApproval: boolean;
}

function toWarning(check: ValidationCheck): TakeWarning {
  return {
    key: check.key,
    ruleType: check.ruleType,
    label: check.label,
    message: check.message,
  };
}

async function loadOpenGiveaway(
  client: PoolClient,
  requestId: string,
  programId: string,
): Promise<{ request: TradeRequestRow; shift: ShiftDetail }> {
  const request = await queryOne<TradeRequestRow>(
    "SELECT * FROM trade_requests WHERE id = $1 FOR UPDATE",
    [requestId],
    client,
  );
  if (!request) throw notFound("That shift is no longer being given away. Ask whoever posted it to put it up again.");
  if (request.program_id !== programId) throw forbidden();
  if (request.kind !== "giveaway") {
    throw conflict(
      "That shift was posted for a switch, so it needs one of your shifts in return.",
    );
  }
  if (request.status !== "open" && request.status !== "offer_pending") {
    throw conflict("Somebody else got there first. There may be other shifts going — have a look at what is available.");
  }
  if (request.expires_at.getTime() <= Date.now()) {
    throw conflict("This shift is past its deadline, so nobody can pick it up now. Ask whoever posted it to put it up again.");
  }

  const shift = await getShiftDetailForUpdate(request.source_shift_id, client);
  if (!shift) throw notFound("That shift no longer exists. It may have been cancelled — check with your chief.");
  /* The poster holds it until this transaction moves it. If they do not, the
     posting is stale — an administrator reassigned the shift underneath it. */
  if (shift.resident_id !== request.initiating_resident_id) {
    throw conflict("This shift has been given to somebody else already, so it is no longer going spare.");
  }
  return { request, shift };
}

async function assess(
  client: PoolClient,
  program: ProgramRow,
  shift: ShiftDetail,
  takerResidentId: string,
) {
  const context = await buildGiveawayContext({
    program,
    shift,
    takerResidentId,
    executor: client,
  });
  /* Read as a one-way transfer: an overridable rule failure becomes something
     the resident is warned about and may accept, rather than a refusal. The
     system checks — overlap, eligibility, a shift already started — are not
     overridable and stay refusals. */
  const validation = asOneWayTransfer(validateTrade(context));
  return {
    validation,
    warnings: validation.warnings.map(toWarning),
    blockers: validation.failures.map(toWarning),
  };
}

/**
 * What this resident would be taking on, before they commit to it.
 *
 * Read-only, and deliberately a separate call: the warnings have to be on
 * screen *before* the button that accepts them, and computing them inside the
 * take would mean either showing them after the fact or asking the client to
 * remember what it was told.
 */
export async function previewTake(
  context: AuthedContext & { resident: { id: string } },
  requestId: string,
): Promise<TakePreview> {
  return withTransaction(async (client) => {
    const { request, shift } = await loadOpenGiveaway(
      client,
      requestId,
      context.program.id,
    );
    if (request.initiating_resident_id === context.resident.id) {
      throw validationFailed("This is your own shift — you are already on it.");
    }
    const program = await getProgram(context.program.id, client);
    const { validation, warnings, blockers } = await assess(
      client,
      program,
      shift,
      context.resident.id,
    );
    return {
      requestId: request.id,
      shift: {
        id: shift.id,
        label: `${formatShiftDate(shift.start_datetime, program.timezone)} ${shift.service_name}`,
        serviceName: shift.service_name,
        start: shift.start_datetime,
        end: shift.end_datetime,
      },
      warnings,
      blockers,
      requiresApproval: validation.requiresApproval,
    };
  });
}

export type TakeOutcome =
  | { status: "completed"; completedTradeId: string; warningsAcknowledged: number }
  | { status: "pending_approval"; tradeRequestId: string; warningsAcknowledged: number };

export interface TakeInput {
  /**
   * The `key` of every warning the resident was shown and accepted.
   *
   * Required to match what the server computes. A take that arrives without
   * acknowledging a live warning is refused rather than completed silently —
   * the acknowledgement is the whole safeguard, and one the client can skip is
   * not a safeguard. The client cannot invent them either: the keys are
   * checked against the warnings this transaction just produced, so a stale
   * list from a screen loaded an hour ago fails and the resident is shown the
   * current warnings instead.
   */
  acknowledgedWarnings: string[];
}

export async function takeShift(
  context: AuthedContext & { resident: { id: string } },
  requestId: string,
  input: TakeInput,
): Promise<TakeOutcome> {
  const { finaliseGiveaway, serialiseTrade } = await import("./trades");

  return withTransaction(async (client) => {
    /* Before any row lock — see `serialiseTrade`. A take and a switch accept
       on the same shift used to be able to deadlock against each other. */
    await serialiseTrade(client, { requestId });
    const { request, shift } = await loadOpenGiveaway(
      client,
      requestId,
      context.program.id,
    );
    if (request.initiating_resident_id === context.resident.id) {
      throw validationFailed("You are already on this shift, so there is nothing to pick up. Withdraw it instead if you no longer want to give it away.");
    }

    const program = await getProgram(context.program.id, client);
    const { validation, warnings, blockers } = await assess(
      client,
      program,
      shift,
      context.resident.id,
    );

    if (blockers.length > 0) {
      throw validationFailed(blockers[0].message, { validation });
    }

    /* Every live warning must have been acknowledged. Compared by key against
       what this transaction computed, so a screen that was loaded before the
       resident picked up two other shifts cannot acknowledge a warning list
       that no longer describes their schedule. */
    const acknowledged = new Set(input.acknowledgedWarnings);
    const unacknowledged = warnings.filter((warning) => !acknowledged.has(warning.key));
    if (unacknowledged.length > 0) {
      throw validationFailed(
        "Please read and accept the warnings before picking this shift up.",
        { warnings, validation },
      );
    }

    /* One live hand up per resident per posting — the partial unique index in
       0014 is the real guard; this is the readable error. */
    const offer = await queryOne<TradeOfferRow>(
      `INSERT INTO trade_offers
         (trade_request_id, offered_shift_id, offering_resident_id, status, expires_at, validation_snapshot)
       VALUES ($1, NULL, $2, 'accepted', $3, $4::jsonb)
       RETURNING *`,
      [request.id, context.resident.id, request.expires_at, JSON.stringify(validation)],
      client,
    );

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "giveaway.taken",
        entityType: "trade_request",
        entityId: request.id,
        newState: {
          shiftId: shift.id,
          takerResidentId: context.resident.id,
          warnings: warnings.map((warning) => warning.message),
        },
      },
      client,
    );

    /* The acknowledgement is recorded whether or not a chief has to approve,
       and before either branch: it is a fact about what the resident was told,
       not about how the request ended. */
    if (warnings.length > 0) {
      await recordAcknowledgement(client, {
        programId: context.program.id,
        requestId: request.id,
        offerId: offer!.id,
        residentId: context.resident.id,
        userId: context.user.id,
        warnings,
      });
      await recordAudit(
        {
          programId: context.program.id,
          actorUserId: context.user.id,
          actorLabel: context.user.email,
          action: "giveaway.warning_acknowledged",
          entityType: "trade_request",
          entityId: request.id,
          newState: { warnings: warnings.map((warning) => warning.message) },
        },
        client,
      );
      await notifyOversight(client, {
        programId: context.program.id,
        requestId: request.id,
        takerName: context.user.fullName,
        shiftLabel: `${formatShiftDate(shift.start_datetime, program.timezone)} ${shift.service_name}`,
        warnings,
      });
    }

    if (validation.requiresApproval) {
      await query(
        "UPDATE trade_requests SET status = 'pending_approval' WHERE id = $1",
        [request.id],
        client,
      );
      await query("UPDATE shifts SET status = 'pending_approval' WHERE id = $1", [
        shift.id,
      ], client);

      const approverIds = await listProgramApprovers(context.program.id, client);
      await notify(
        approverIds.map((userId) => ({
          recipientUserId: userId,
          type: "approval.required" as const,
          title: "A picked-up shift needs approval",
          body: `${context.user.fullName} picked up ${formatShiftDate(shift.start_datetime, program.timezone)} ${shift.service_name}.`,
          relatedEntityType: "trade_request",
          relatedEntityId: request.id,
        })),
        client,
      );
      return {
        status: "pending_approval" as const,
        tradeRequestId: request.id,
        warningsAcknowledged: warnings.length,
      };
    }

    const completed = await finaliseGiveaway(client, {
      program,
      request,
      offer: offer!,
      sourceShift: shift,
      takingResidentId: context.resident.id,
      validation,
      actorUserId: context.user.id,
      actorLabel: context.user.email,
    });

    if (warnings.length > 0) {
      await query(
        "UPDATE trade_warning_acknowledgements SET completed_trade_id = $2 WHERE trade_offer_id = $1",
        [offer!.id, completed.id],
        client,
      );
    }

    logger.info("giveaway.completed", {
      completedTradeId: completed.id,
      programId: context.program.id,
      warnings: warnings.length,
    });

    return {
      status: "completed" as const,
      completedTradeId: completed.id,
      warningsAcknowledged: warnings.length,
    };
  });
}

async function recordAcknowledgement(
  client: PoolClient,
  input: {
    programId: string;
    requestId: string;
    offerId: string;
    residentId: string;
    userId: string;
    warnings: TakeWarning[];
  },
): Promise<void> {
  await query(
    `INSERT INTO trade_warning_acknowledgements
       (program_id, trade_request_id, trade_offer_id, resident_id, acknowledged_by, warnings)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.programId,
      input.requestId,
      input.offerId,
      input.residentId,
      input.userId,
      JSON.stringify(input.warnings),
    ],
    client,
  );
}

async function notifyOversight(
  client: PoolClient,
  input: {
    programId: string;
    requestId: string;
    takerName: string;
    shiftLabel: string;
    warnings: TakeWarning[];
  },
): Promise<void> {
  const approverIds = await listProgramApprovers(input.programId, client);
  await notify(
    approverIds.map((userId) => ({
      recipientUserId: userId,
      type: "giveaway.warned" as const,
      title: "A shift was picked up over a warning",
      /* The first warning in full, because it is the one the engine ranked
         most serious, and a count rather than a wall of text. A chief who
         wants the rest opens the record. */
      body: `${input.takerName} picked up ${input.shiftLabel}. ${input.warnings[0].message}${
        input.warnings.length > 1 ? ` (+${input.warnings.length - 1} more)` : ""
      }`,
      relatedEntityType: "trade_request",
      relatedEntityId: input.requestId,
    })),
    client,
  );
}

export interface AcknowledgementRecord {
  id: string;
  residentName: string;
  shiftLabel: string;
  warnings: TakeWarning[];
  acknowledgedAt: Date;
  completedTradeId: string | null;
}

/**
 * Every shift picked up over a warning, most recent first.
 *
 * This is the half that makes the trade-off honest. Without a screen, "the
 * programme gets to see it" is a row in a table nobody queries.
 */
export async function listWarningAcknowledgements(
  programId: string,
  options: { limit?: number } = {},
): Promise<AcknowledgementRecord[]> {
  const rows = await query<{
    id: string;
    resident_name: string;
    service_name: string;
    start_datetime: Date;
    warnings: TakeWarning[];
    acknowledged_at: Date;
    completed_trade_id: string | null;
    timezone: string;
  }>(
    `SELECT a.id,
            u.full_name AS resident_name,
            sv.name     AS service_name,
            s.start_datetime,
            a.warnings,
            a.acknowledged_at,
            a.completed_trade_id,
            p.timezone
       FROM trade_warning_acknowledgements a
       JOIN residents r    ON r.id = a.resident_id
       JOIN users u        ON u.id = r.user_id
       JOIN trade_requests tr ON tr.id = a.trade_request_id
       JOIN shifts s       ON s.id = tr.source_shift_id
       JOIN services sv    ON sv.id = s.service_id
       JOIN programs p     ON p.id = a.program_id
      WHERE a.program_id = $1
      ORDER BY a.acknowledged_at DESC
      LIMIT $2`,
    [programId, Math.min(options.limit ?? 100, 500)],
  );
  return rows.map((row) => ({
    id: row.id,
    residentName: row.resident_name,
    shiftLabel: `${formatShiftDate(row.start_datetime, row.timezone)} ${row.service_name}`,
    warnings: row.warnings,
    acknowledgedAt: row.acknowledged_at,
    completedTradeId: row.completed_trade_id,
  }));
}
