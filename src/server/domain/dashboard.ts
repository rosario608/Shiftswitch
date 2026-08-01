import { query } from "@/server/db/pool";
import { isPending, type AuthedContext } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import type { ShiftDetail } from "@/server/db/types";
import { listResidentSchedule } from "./schedule";
import {
  listAvailableTrades,
  listMyTradeActivity,
  type AvailableTradeRow,
  type TradeRequestDetail,
} from "./trades";

export interface PendingAction {
  id: string;
  kind:
    | "offer_received"
    | "offer_accepted_pending_approval"
    | "approval_required"
    | "email_pending";
  title: string;
  detail: string;
  href: string;
  cta: string;
  /**
   * The decision itself, when there is exactly one of it.
   *
   * One offer is a *decision* — yes or no — and it can be made on the home
   * screen without opening anything, which takes accepting from three taps to
   * two. Several offers are a *comparison*, and comparing them is what the
   * switch screen is for, so those still link out. The confirmation before
   * anything is written stays either way: accepting hands somebody else your
   * call shift.
   */
  decide?: {
    requestId: string;
    sourceShift: ShiftDetail;
    offer: TradeRequestDetail["offers"][number];
    requiresApproval: boolean;
  };
}

export interface ResidentDashboard {
  nextShift: ShiftDetail | null;
  upcoming: ShiftDetail[];
  pendingActions: PendingAction[];
  availableTrades: AvailableTradeRow[];
  myPosts: TradeRequestDetail[];
  stats: { upcomingCount: number; postedCount: number; openOffersCount: number };
}

export async function getResidentDashboard(
  context: AuthedContext,
): Promise<ResidentDashboard> {
  const residentId = context.resident?.id ?? null;

  const upcoming = residentId
    ? await listResidentSchedule(residentId, { limit: 8 })
    : [];

  const activity = residentId
    ? await listMyTradeActivity(residentId, context.program.id)
    : { posted: [], offersMade: [] };

  /* An account waiting to be confirmed sees nothing about anybody else, and
     the board is the largest "anybody else" in the product. The capability
     guards cannot reach here — the home screen is `requirePageUser`, not a
     capability — so the rule is applied where the data is fetched rather than
     where the screen is entered. */
  const availableTrades = isPending(context)
    ? []
    : await listAvailableTrades(context.program.id, residentId, { limit: 5 });

  const pendingActions: PendingAction[] = [];

  for (const post of activity.posted) {
    const pendingOffers = post.offers.filter((offer) => offer.status === "pending");
    if (pendingOffers.length > 0) {
      const only = pendingOffers.length === 1 ? pendingOffers[0] : null;
      const snapshot = only?.validation_snapshot as
        | { requiresApproval?: boolean }
        | null
        | undefined;
      pendingActions.push({
        id: `offers-${post.id}`,
        kind: "offer_received",
        title: only
          ? `${only.offering_resident_name} offered you a switch`
          : `${pendingOffers.length} offers on your ${post.shift.service_name} shift`,
        detail: only
          ? `Your ${post.shift.service_name} shift for theirs.`
          : "Compare what you would receive, then accept or decline.",
        href: `/switches/${post.id}`,
        cta: only ? "See the details" : "Compare offers",
        decide: only
          ? {
              requestId: post.id,
              sourceShift: post.shift,
              offer: only,
              requiresApproval: Boolean(snapshot?.requiresApproval),
            }
          : undefined,
      });
    }
    if (post.status === "pending_approval") {
      pendingActions.push({
        id: `approval-${post.id}`,
        kind: "offer_accepted_pending_approval",
        title: "Waiting for chief approval",
        detail: `Your ${post.shift.service_name} switch is with the chief residents.`,
        href: `/switches/${post.id}`,
        cta: "View status",
      });
    }
  }

  for (const offer of activity.offersMade) {
    if (offer.status === "accepted") {
      pendingActions.push({
        id: `accepted-${offer.id}`,
        kind: "offer_accepted_pending_approval",
        title: "Your offer was accepted",
        detail: "The switch is waiting for chief approval.",
        href: `/switches/${offer.trade_request_id}`,
        cta: "View status",
      });
    }
  }

  // Completed switches for which nobody has generated the program email yet.
  if (residentId) {
    const pendingEmails = await query<{ id: string; service_name: string }>(
      `SELECT ct.id, sv.name AS service_name
         FROM completed_trades ct
         JOIN shifts s ON s.id = ct.source_shift_id
         JOIN services sv ON sv.id = s.service_id
        WHERE ct.program_id = $1
          AND (ct.resident_a = $2 OR ct.resident_b = $2)
          AND NOT EXISTS (SELECT 1 FROM email_records e WHERE e.completed_trade_id = ct.id)
        ORDER BY ct.completed_at DESC
        LIMIT 3`,
      [context.program.id, residentId],
    );
    for (const row of pendingEmails) {
      pendingActions.push({
        id: `email-${row.id}`,
        kind: "email_pending",
        title: "Notify your program",
        detail: `Send the coordinator the details of your completed ${row.service_name} switch.`,
        href: `/switches/done/${row.id}`,
        cta: "Open email",
      });
    }
  }

  if (can(context.user.role, "approvals.decide")) {
    const approvals = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM trade_requests
        WHERE program_id = $1 AND status = 'pending_approval'`,
      [context.program.id],
    );
    const count = Number(approvals[0]?.count ?? 0);
    if (count > 0) {
      pendingActions.push({
        id: "approvals",
        kind: "approval_required",
        title: `${count} switch${count === 1 ? "" : "es"} awaiting your approval`,
        detail: "Review the validation results and approve or reject.",
        href: "/admin/approvals",
        cta: "Review",
      });
    }
  }

  return {
    nextShift: upcoming[0] ?? null,
    upcoming: upcoming.slice(1, 4),
    pendingActions,
    availableTrades,
    myPosts: activity.posted,
    stats: {
      upcomingCount: upcoming.length,
      postedCount: activity.posted.length,
      openOffersCount: activity.offersMade.length,
    },
  };
}
