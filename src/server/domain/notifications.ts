import { getPool, query, type Queryable } from "@/server/db/pool";
import type { NotificationRow } from "@/server/db/types";

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
  | "email.generated";

export interface NotificationInput {
  recipientUserId: string;
  type: NotificationType;
  title: string;
  body?: string;
  relatedEntityType?: string;
  relatedEntityId?: string | null;
}

export async function notify(
  input: NotificationInput | NotificationInput[],
  executor: Queryable = getPool(),
): Promise<void> {
  const items = Array.isArray(input) ? input : [input];
  if (items.length === 0) return;
  const values: unknown[] = [];
  const tuples = items.map((item, index) => {
    const base = index * 6;
    values.push(
      item.recipientUserId,
      item.type,
      item.title,
      item.body ?? "",
      item.relatedEntityType ?? null,
      item.relatedEntityId ?? null,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  await query(
    `INSERT INTO notifications
       (recipient_user_id, type, title, body, related_entity_type, related_entity_id)
     VALUES ${tuples.join(", ")}`,
    values,
    executor,
  );
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

/** User ids of chiefs and administrators for a program (approval routing). */
export async function listProgramApprovers(
  programId: string,
  executor: Queryable = getPool(),
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE program_id = $1 AND active = true AND role IN ('chief', 'admin')`,
    [programId],
    executor,
  );
  return rows.map((row) => row.id);
}
