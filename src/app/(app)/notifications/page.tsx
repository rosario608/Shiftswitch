import Link from "next/link";
import { Bell } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { MarkAllReadButton } from "@/components/app/notification-actions";
import { requirePageUser } from "@/server/auth/page-guards";
import { listNotifications } from "@/server/domain/notifications";
import { fmtTimestamp } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

/**
 * Where the row leads.
 *
 * The route is stored on the notification when it is written, by the code that
 * knew what the notification was about. This page does not re-derive it — that
 * is what it used to do, and its own switch statement had no case for an offer,
 * so "your offer was declined" sent the resident to the board of everyone
 * else's postings. The fallback is only for rows written before the column
 * existed.
 */
function hrefFor(item: { route: string; related_entity_id: string | null }): string {
  if (item.route) return item.route;
  return item.related_entity_id ? "/trades?tab=mine" : "/";
}

export default async function NotificationsPage() {
  const context = await requirePageUser();
  const notifications = await listNotifications(context.user.id, { limit: 60 });
  const timezone = context.program.timezone;
  const unread = notifications.filter((item) => !item.read_at).length;

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Notifications</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {unread > 0 ? `${unread} unread` : "You're all caught up."}
          </p>
        </div>
        {unread > 0 ? <MarkAllReadButton /> : null}
      </header>

      {notifications.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-5 w-5" aria-hidden="true" />}
          title="No notifications yet"
          description="You'll be notified when someone offers on your shift, when an offer is accepted, and when a switch completes."
        />
      ) : (
        <ul className="space-y-2">
          {notifications.map((item) => (
            <li key={item.id}>
              <Card className={item.read_at ? "" : "border-brand/40 bg-brand-soft/30"}>
                <Link
                  href={hrefFor(item)}
                  className="block px-4 py-3.5 hover:bg-surface-muted"
                >
                  <div className="flex items-start gap-2">
                    {!item.read_at ? (
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand"
                        aria-hidden="true"
                      />
                    ) : null}
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">
                        {item.title}
                        {!item.read_at ? <span className="sr-only"> (unread)</span> : null}
                      </p>
                      {item.body ? (
                        <p className="mt-0.5 text-sm text-ink-muted">{item.body}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-ink-subtle">
                        {fmtTimestamp(item.created_at, timezone)}
                      </p>
                    </div>
                  </div>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
