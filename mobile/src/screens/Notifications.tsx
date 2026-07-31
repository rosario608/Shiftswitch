import { useNavigate } from "react-router";
import { api } from "@/api/client";
import type { AppNotification } from "@/api/types";
import { Screen } from "@/components/Screen";
import {
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  cx,
} from "@/components/ui";
import { relativeTime } from "@/lib/format";
import { useResource } from "@/lib/useResource";

interface NotificationsResponse {
  notifications: AppNotification[];
  unread: number;
}

/** Where a notification takes you — the same mapping the push payload uses. */
function routeFor(notification: AppNotification): string {
  if (!notification.related_entity_id) return "/notifications";
  switch (notification.related_entity_type) {
    case "trade_request":
      return `/trades/${notification.related_entity_id}`;
    case "completed_trade":
      return `/switches/${notification.related_entity_id}`;
    case "shift":
      return `/schedule/${notification.related_entity_id}`;
    default:
      return "/notifications";
  }
}

export function NotificationsScreen({ onRead }: { onRead: () => void }) {
  const navigate = useNavigate();

  const resource = useResource<NotificationsResponse>(
    (signal) =>
      api.get<NotificationsResponse>("/api/notifications?limit=50", { signal }),
    [],
  );

  async function markAll() {
    await api.post("/api/notifications/read", {}).catch(() => undefined);
    onRead();
    await resource.reload();
  }

  async function open(notification: AppNotification) {
    if (!notification.read_at) {
      await api
        .post("/api/notifications/read", { notificationIds: [notification.id] })
        .catch(() => undefined);
      onRead();
    }
    const route = routeFor(notification);
    if (route !== "/notifications") navigate(route);
    else await resource.reload();
  }

  return (
    <Screen
      title="Alerts"
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
      action={
        (resource.data?.unread ?? 0) > 0 ? (
          <Button variant="ghost" onClick={() => void markAll()}>
            Mark all read
          </Button>
        ) : undefined
      }
    >
      {resource.loading && (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}

      {resource.error && !resource.data && (
        <ErrorState
          message={resource.error.message}
          onRetry={() => void resource.reload()}
          retryable={resource.error.retryable}
        />
      )}

      {resource.data?.notifications.length === 0 && (
        <EmptyState
          title="Nothing yet"
          detail="Offers, approvals and completed switches show up here."
        />
      )}

      <ul className="space-y-2">
        {resource.data?.notifications.map((notification) => (
          <li key={notification.id}>
            <button
              type="button"
              onClick={() => void open(notification)}
              className={cx(
                "tap w-full rounded-card border p-4 text-left active:bg-surface-muted",
                notification.read_at
                  ? "border-border-base bg-surface"
                  : "border-brand/40 bg-brand-soft",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold text-ink">{notification.title}</p>
                {!notification.read_at && (
                  <span
                    aria-label="Unread"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand"
                  />
                )}
              </div>
              {notification.body && (
                <p className="mt-1 text-sm text-ink-muted">
                  {notification.body}
                </p>
              )}
              <p className="mt-2 text-xs text-ink-subtle">
                {relativeTime(notification.created_at)}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
