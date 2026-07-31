import { useNavigate } from "react-router";
import { api } from "@/api/client";
import type { DashboardResponse } from "@/api/types";
import { Screen } from "@/components/Screen";
import { ShiftCard } from "@/components/ShiftCard";
import {
  Card,
  EmptyState,
  ErrorState,
  Pill,
  SectionHeading,
  Skeleton,
  toneForStatus,
} from "@/components/ui";
import { formatShiftWindow, relativeTime, statusLabel } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { useAuth } from "@/auth/AuthProvider";
import { PushPrimer } from "./PushPrimer";

/**
 * The home screen answers one question: what needs me right now?
 *
 * Pending actions come first because they are the whole reason a resident
 * opened the app; the next shift is second because that is the fact they most
 * often want to check; browsing available switches is third.
 */
export function HomeScreen() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const resource = useResource<DashboardResponse>(
    (signal) => api.get<DashboardResponse>("/api/dashboard", { signal }),
    [],
  );

  const firstName = session?.user?.fullName?.split(" ")[0] ?? "there";

  return (
    <Screen
      title={`Hello, ${firstName}`}
      subtitle={session?.program?.name}
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
    >
      {resource.loading && (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      )}

      {resource.error && !resource.data && (
        <ErrorState
          message={resource.error.message}
          onRetry={() => void resource.reload()}
          retryable={resource.error.retryable}
        />
      )}

      {resource.data && (
        <div className="space-y-6">
          <PushPrimer />

          {resource.data.dashboard.pendingActions.length > 0 && (
            <section>
              <SectionHeading>Needs you</SectionHeading>
              <ul className="space-y-2">
                {resource.data.dashboard.pendingActions.map((action) => (
                  <li key={action.id}>
                    <button
                      type="button"
                      onClick={() => navigate(normaliseHref(action.href))}
                      className="tap w-full rounded-card border border-caution/40 bg-caution-soft p-4 text-left active:opacity-90"
                    >
                      <p className="font-semibold text-ink">{action.title}</p>
                      <p className="mt-0.5 text-sm text-ink-muted">
                        {action.detail}
                      </p>
                      <p className="mt-2 text-sm font-semibold text-brand-ink">
                        {action.cta} →
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <SectionHeading
              action={
                <button
                  type="button"
                  onClick={() => navigate("/schedule")}
                  className="text-sm font-semibold text-brand-ink"
                >
                  All shifts
                </button>
              }
            >
              Your next shift
            </SectionHeading>
            {resource.data.dashboard.nextShift ? (
              <ShiftCard
                shift={resource.data.dashboard.nextShift}
                timezone={resource.data.timezone}
                highlight
                onClick={() =>
                  navigate(`/schedule/${resource.data!.dashboard.nextShift!.id}`)
                }
                footer={
                  <p className="text-xs text-ink-subtle">
                    Starts{" "}
                    {relativeTime(
                      resource.data.dashboard.nextShift.start_datetime,
                    )}
                  </p>
                }
              />
            ) : (
              <EmptyState
                title="No upcoming shifts"
                detail="When your program publishes your schedule it will appear here."
              />
            )}
          </section>

          {resource.data.dashboard.upcoming.length > 0 && (
            <section>
              <SectionHeading>Then</SectionHeading>
              <ul className="space-y-2">
                {resource.data.dashboard.upcoming.map((shift) => (
                  <li key={shift.id}>
                    <ShiftCard
                      shift={shift}
                      timezone={resource.data!.timezone}
                      onClick={() => navigate(`/schedule/${shift.id}`)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {resource.data.dashboard.myPosts.length > 0 && (
            <section>
              <SectionHeading>Your posts</SectionHeading>
              <ul className="space-y-2">
                {resource.data.dashboard.myPosts.map((post) => (
                  <li key={post.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/trades/${post.id}`)}
                      className="tap w-full rounded-card border border-border-base bg-surface p-4 text-left active:bg-surface-muted"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-ink">
                            {post.shift.service_name}
                          </p>
                          <p className="text-sm text-ink-muted">
                            {formatShiftWindow(
                              post.shift.start_datetime,
                              post.shift.end_datetime,
                              resource.data!.timezone,
                            )}
                          </p>
                        </div>
                        <Pill tone={toneForStatus(post.status)}>
                          {statusLabel(post.status)}
                        </Pill>
                      </div>
                      <p className="mt-2 text-sm text-ink-muted">
                        {post.offers.filter((offer) => offer.status === "pending")
                          .length || "No"}{" "}
                        pending{" "}
                        {post.offers.filter((offer) => offer.status === "pending")
                          .length === 1
                          ? "offer"
                          : "offers"}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <SectionHeading
              action={
                <button
                  type="button"
                  onClick={() => navigate("/trades")}
                  className="text-sm font-semibold text-brand-ink"
                >
                  See all
                </button>
              }
            >
              Available to pick up
            </SectionHeading>
            {resource.data.dashboard.availableTrades.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-muted">
                  Nobody has posted a shift for switching right now.
                </p>
              </Card>
            ) : (
              <ul className="space-y-2">
                {resource.data.dashboard.availableTrades.map((trade) => (
                  <li key={trade.id}>
                    <ShiftCard
                      shift={trade.shift}
                      timezone={resource.data!.timezone}
                      onClick={() => navigate(`/trades/${trade.id}`)}
                      footer={
                        <p className="text-xs text-ink-subtle">
                          {trade.initiator_name} · PGY-{trade.initiator_pgy} ·
                          expires {relativeTime(trade.expires_at)}
                        </p>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Screen>
  );
}

/** The server's hrefs are written for the web app; two paths differ here. */
function normaliseHref(href: string): string {
  return href === "/admin/approvals" ? "/approvals" : href;
}
