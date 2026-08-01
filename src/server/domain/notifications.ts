import { afterCommit, getPool, query, type Queryable } from "@/server/db/pool";
import type { NotificationRow } from "@/server/db/types";
import { rolesWith } from "@/server/auth/roles";
import { sendPush } from "./push";

export type NotificationType =
  | "offer.created"
  | "offer.accepted"
  | "offer.rejected"
  | "offer.invalidated"
  | "approval.required"
  | "approval.granted"
  | "approval.rejected"
  | "shift.changed"
  | "trade.expired"
  | "trade.cancelled"
  | "switch.completed"
  | "schedule.published"
  | "schedule.corrected"
  | "email.generated";

export interface NotificationInput {
  recipientUserId: string;
  type: NotificationType;
  title: string;
  body?: string;
  relatedEntityType?: string;
  relatedEntityId?: string | null;
  /**
   * Where tapping the notification should land in the app. When absent it is
   * derived from the related entity.
   */
  route?: string;
}

/** Deep-link target for a notification, so a tap opens the right screen. */
export function routeFor(input: NotificationInput): string {
  if (input.route) return input.route;
  if (!input.relatedEntityId) return "/notifications";
  switch (input.relatedEntityType) {
    case "trade_request":
      return `/trades/${input.relatedEntityId}`;
    case "completed_trade":
      return `/switches/${input.relatedEntityId}`;
    case "shift":
      return `/schedule/${input.relatedEntityId}`;
    case "schedule_version":
      /* A publication addresses no screen of its own — what a resident wants
         from "the schedule changed" is their own schedule, not the version
         row that changed it. */
      return "/schedule";
    case "trade_offer":
      /* An offer id addresses no screen of its own — an offer is always seen in
         the context of the posting it was made on, and only the caller knows
         which that is. Callers that have the request in hand pass an explicit
         `route`; this is the fallback for any that do not, and it lands on the
         resident's own offers rather than the board of everyone else's
         postings, which is where the old derivation sent them. */
      return "/trades?tab=mine";
    default:
      return "/notifications";
  }
}

export async function notify(
  input: NotificationInput | NotificationInput[],
  executor: Queryable = getPool(),
): Promise<void> {
  const items = Array.isArray(input) ? input : [input];
  if (items.length === 0) return;
  const values: unknown[] = [];
  const tuples = items.map((item, index) => {
    const base = index * 7;
    values.push(
      item.recipientUserId,
      item.type,
      item.title,
      item.body ?? "",
      item.relatedEntityType ?? null,
      item.relatedEntityId ?? null,
      // Stored, not recomputed on read. The in-app list and the push payload
      // are then the same string by construction; when they were derived
      // separately they disagreed on every `trade_offer` notification.
      routeFor(item),
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  const inserted = await query<{ id: string; recipient_user_id: string }>(
    `INSERT INTO notifications
       (recipient_user_id, type, title, body, related_entity_type, related_entity_id, route)
     VALUES ${tuples.join(", ")}
     RETURNING id, recipient_user_id`,
    values,
    executor,
  );

  // Push only once the surrounding transaction has committed: a rolled-back
  // trade must never produce "your switch is complete" on someone's phone.
  inserted.forEach((row, index) => {
    const item = items[index];
    afterCommit(async () => {
      await sendPush({
        userId: item.recipientUserId,
        type: item.type,
        title: item.title,
        body: item.body ?? "",
        route: routeFor(item),
        notificationId: row.id,
      });
    });
  });
}

export async function listNotifications(
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const values: unknown[] = [userId];
  let where = "recipient_user_id = $1";
  if (options.unreadOnly) where += " AND read_at IS NULL";
  values.push(Math.min(options.limit ?? 50, 200));
  return query<NotificationRow>(
    `SELECT * FROM notifications
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
    values,
  );
}

export async function countUnread(userId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL",
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function markRead(
  userId: string,
  notificationIds?: string[],
): Promise<number> {
  const rows = notificationIds?.length
    ? await query<{ id: string }>(
        `UPDATE notifications SET read_at = now()
          WHERE recipient_user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL
        RETURNING id`,
        [userId, notificationIds],
      )
    : await query<{ id: string }>(
        `UPDATE notifications SET read_at = now()
          WHERE recipient_user_id = $1 AND read_at IS NULL
        RETURNING id`,
        [userId],
      );
  return rows.length;
}

/**
 * User ids of everybody who can act on the approvals queue.
 *
 * Derived from the capability matrix rather than a literal role list. The
 * literal list said `('chief', 'admin')` and was correct until APD and PD were
 * added — after which a program whose approver was a PD raised approval
 * requests that notified nobody at all, and the switches simply waited.
 */
export async function listProgramApprovers(
  programId: string,
  executor: Queryable = getPool(),
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE program_id = $1 AND active = true AND role = ANY($2::user_role[])`,
    [programId, rolesWith("approvals.decide")],
    executor,
  );
  return rows.map((row) => row.id);
}
