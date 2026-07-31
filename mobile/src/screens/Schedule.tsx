import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import type { ShiftDetail } from "@/api/types";
import { Screen } from "@/components/Screen";
import { ShiftCard } from "@/components/ShiftCard";
import { EmptyState, ErrorState, Skeleton, cx } from "@/components/ui";
import { formatLongDate } from "@/lib/format";
import { useResource } from "@/lib/useResource";

interface ScheduleResponse {
  shifts: ShiftDetail[];
  timezone: string;
}

/**
 * The resident's own schedule, grouped by day.
 *
 * Past shifts are behind a toggle rather than shown by default: the reason to
 * open this screen is almost always "what am I working next", and a year of
 * history above that answer is noise.
 */
export function ScheduleScreen() {
  const navigate = useNavigate();
  const [includePast, setIncludePast] = useState(false);

  const resource = useResource<ScheduleResponse>(
    (signal) =>
      api.get<ScheduleResponse>(
        `/api/schedule?limit=100${includePast ? "&includePast=true" : ""}`,
        { signal },
      ),
    [includePast],
  );

  const grouped = useMemo(() => {
    if (!resource.data) return [];
    const groups = new Map<string, ShiftDetail[]>();
    for (const shift of resource.data.shifts) {
      const key = formatLongDate(shift.start_datetime, resource.data.timezone);
      const existing = groups.get(key);
      if (existing) existing.push(shift);
      else groups.set(key, [shift]);
    }
    return [...groups.entries()];
  }, [resource.data]);

  return (
    <Screen
      title="Your schedule"
      onRefresh={resource.reload}
      refreshing={resource.refreshing}
    >
      <div
        role="group"
        aria-label="Which shifts to show"
        className="mb-4 flex rounded-xl bg-surface-muted p-1"
      >
        {[
          { label: "Upcoming", value: false },
          { label: "All shifts", value: true },
        ].map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={includePast === option.value}
            onClick={() => setIncludePast(option.value)}
            className={cx(
              "tap flex-1 rounded-lg py-2 text-sm font-semibold",
              includePast === option.value
                ? "bg-surface text-ink shadow-sm"
                : "text-ink-muted",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {resource.loading && (
        <div className="space-y-3">
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

      {resource.data && resource.data.shifts.length === 0 && (
        <EmptyState
          title={includePast ? "No shifts on record" : "No upcoming shifts"}
          detail="Your program publishes the schedule; it will appear here as soon as it does."
        />
      )}

      <div className="space-y-6">
        {grouped.map(([day, shifts]) => (
          <section key={day}>
            <h2 className="mb-2 text-sm font-semibold text-ink-muted">{day}</h2>
            <ul className="space-y-2">
              {shifts.map((shift) => (
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
        ))}
      </div>
    </Screen>
  );
}
