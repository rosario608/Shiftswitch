import { useNavigate } from "react-router";
import { api } from "@/api/client";
import type { AvailableTrade } from "@/api/types";
import { Screen } from "@/components/Screen";
import { ShiftCard } from "@/components/ShiftCard";
import { EmptyState, ErrorState, Pill, Skeleton } from "@/components/ui";
import { relativeTime } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { useAuth } from "@/auth/AuthProvider";

interface TradesResponse {
  trades: AvailableTrade[];
}

/**
 * The switch board: every shift a co-resident has posted, newest first.
 *
 * A post the viewer has already made an offer on is labelled as such, so
 * nobody offers twice or wonders whether their first offer went through.
 */
export function TradesScreen() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const timezone = session?.program?.timezone ?? "UTC";

  const resource = useResource<TradesResponse>(
    (signal) => api.get<TradesResponse>("/api/switches?limit=50", { signal }),
    [],
  );

  return (
    <Screen
      title="Switches"
      subtitle="Shifts your colleagues want to switch"
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
    >
      {resource.loading && (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      )}

      {resource.error && !resource.data && (
        <ErrorState
          message={resource.error.message}
          onRetry={() => void resource.reload()}
          retryable={resource.error.retryable}
        />
      )}

      {resource.data?.trades.length === 0 && (
        <EmptyState
          title="Nothing posted right now"
          detail="When a co-resident posts a shift for switching it shows up here. You can post one of yours from your schedule."
        />
      )}

      <ul className="space-y-3">
        {resource.data?.trades.map((trade) => (
          <li key={trade.id}>
            <ShiftCard
              shift={trade.shift}
              timezone={timezone}
              onClick={() => navigate(`/switches/${trade.id}`)}
              footer={
                <div className="space-y-2">
                  {trade.notes && (
                    <p className="text-sm text-ink-muted">
                      &ldquo;{trade.notes}&rdquo;
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink-subtle">
                      {trade.initiator_name} · PGY-{trade.initiator_pgy}
                    </span>
                    <span aria-hidden="true" className="text-ink-subtle">
                      ·
                    </span>
                    <span className="text-xs text-ink-subtle">
                      expires {relativeTime(trade.expires_at)}
                    </span>
                    {trade.my_offer_id && (
                      <Pill tone="brand">You&rsquo;ve offered</Pill>
                    )}
                    {trade.offer_count > 0 && !trade.my_offer_id && (
                      <Pill tone="neutral">
                        {trade.offer_count}{" "}
                        {trade.offer_count === 1 ? "offer" : "offers"}
                      </Pill>
                    )}
                  </div>
                </div>
              }
            />
          </li>
        ))}
      </ul>
    </Screen>
  );
}
