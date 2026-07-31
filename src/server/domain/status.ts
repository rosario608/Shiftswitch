import type {
  ShiftStatus,
  TradeOfferStatus,
  TradeRequestStatus,
} from "@/server/db/types";
import { conflict } from "@/server/http/errors";

/**
 * Explicit state machines. Status is only ever changed through these
 * transitions on the server; the client can never set a status directly.
 */

export const SHIFT_TRANSITIONS: Record<ShiftStatus, ShiftStatus[]> = {
  scheduled: ["posted", "cancelled", "completed"],
  posted: ["offer_pending", "scheduled", "cancelled"],
  offer_pending: ["pending_approval", "posted", "scheduled", "cancelled"],
  pending_approval: ["scheduled", "posted", "cancelled"],
  completed: [],
  cancelled: [],
};

export const REQUEST_TRANSITIONS: Record<
  TradeRequestStatus,
  TradeRequestStatus[]
> = {
  open: ["offer_pending", "cancelled", "expired"],
  offer_pending: ["accepted", "pending_approval", "open", "cancelled", "expired", "completed"],
  accepted: ["pending_approval", "completed", "cancelled"],
  pending_approval: ["approved", "completed", "offer_pending", "open", "cancelled"],
  approved: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  expired: [],
};

export const OFFER_TRANSITIONS: Record<TradeOfferStatus, TradeOfferStatus[]> = {
  pending: ["accepted", "rejected", "withdrawn", "invalidated", "expired", "completed"],
  accepted: ["completed", "invalidated", "rejected"],
  rejected: [],
  withdrawn: [],
  invalidated: [],
  expired: [],
  completed: [],
};

function assertTransition<S extends string>(
  map: Record<S, S[]>,
  from: S,
  to: S,
  entity: string,
): void {
  if (from === to) return;
  if (!map[from]?.includes(to)) {
    throw conflict(
      `This ${entity} can no longer be updated (it is ${from.replace(/_/g, " ")}).`,
    );
  }
}

export const assertShiftTransition = (from: ShiftStatus, to: ShiftStatus) =>
  assertTransition(SHIFT_TRANSITIONS, from, to, "shift");

export const assertRequestTransition = (
  from: TradeRequestStatus,
  to: TradeRequestStatus,
) => assertTransition(REQUEST_TRANSITIONS, from, to, "trade");

export const assertOfferTransition = (
  from: TradeOfferStatus,
  to: TradeOfferStatus,
) => assertTransition(OFFER_TRANSITIONS, from, to, "offer");

export const SHIFT_STATUS_LABELS: Record<ShiftStatus, string> = {
  scheduled: "Scheduled",
  posted: "Posted for trade",
  offer_pending: "Offer pending",
  pending_approval: "Pending approval",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const REQUEST_STATUS_LABELS: Record<TradeRequestStatus, string> = {
  open: "Open",
  offer_pending: "Offers received",
  accepted: "Accepted",
  pending_approval: "Pending approval",
  approved: "Approved",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const OFFER_STATUS_LABELS: Record<TradeOfferStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Declined",
  withdrawn: "Withdrawn",
  invalidated: "No longer available",
  expired: "Expired",
  completed: "Completed",
};
