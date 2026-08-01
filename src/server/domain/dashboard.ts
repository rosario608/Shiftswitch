import { query } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
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

  const availableTrades = await listAvailableTrades(
    context.program.id,
    residentId,
    { limit: 5 },
  );

  const pendingActions: PendingAction[] = [];

  for (const post of activity.posted) {
    const pendingOffers = post.offers.filter((offer) => offer.status === "pending");
    if (pendingOffers.length > 0) {
      pendingActions.push({
        id: `offers-${post.id}`,
        kind: "offer_received",
        title: `${pendingOffers.length} offer${pendingOffers.length === 1 ? "" : "s"} on your ${post.shift.service_name} shift`,
        detail: "Review what you would receive, then accept or decline.",
        href: `/switches/${post.id}`,
        cta: "Review offers",
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
