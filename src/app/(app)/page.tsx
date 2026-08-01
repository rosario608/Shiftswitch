import Link from "next/link";
import { ArrowRight, CalendarPlus, ChevronRight, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, SectionHeading } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ShiftCard } from "@/components/app/shift-card";
import { PostShiftButton } from "@/components/app/post-shift-sheet";
import { requirePageUser } from "@/server/auth/page-guards";
import { getResidentDashboard } from "@/server/domain/dashboard";
import { listOfferableForPosting } from "@/server/domain/schedule-actions";
import { toShiftView } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const context = await requirePageUser();
  const timezone = context.program.timezone;
  const dashboard = await getResidentDashboard(context);
  const postable = context.resident
    ? await listOfferableForPosting(context.resident.id)
    : [];

  const firstName = (context.user.fullName || context.user.email).split(" ")[0];

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Hello, {firstName}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {dashboard.nextShift
            ? "Here's what's next and anything waiting on you."
            : "You have no upcoming shifts on the schedule."}
        </p>
      </div>

      {dashboard.pendingActions.length > 0 ? (
        <section aria-labelledby="pending-heading">
          <SectionHeading id="pending-heading" title="Needs your attention" />
          <ul className="space-y-2">
            {dashboard.pendingActions.map((action) => (
              <li key={action.id}>
                <Card className="border-caution/40">
                  <Link
                    href={action.href}
                    className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface-muted"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-ink">
                        {action.title}
                      </span>
                      <span className="mt-0.5 block text-sm text-ink-muted">
                        {action.detail}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-ink">
                      {action.cta}
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="next-shift-heading">
        <SectionHeading id="next-shift-heading" title="Next shift" />
        {dashboard.nextShift ? (
          <ShiftCard
            shift={toShiftView(dashboard.nextShift, timezone)}
            emphasis
            action={
              context.resident ? (
                <PostShiftButton
                  shifts={postable.map((shift) => toShiftView(shift, timezone))}
                  preselectedShiftId={dashboard.nextShift.id}
                  label="Post this shift"
                  disabledReason={
                    dashboard.nextShift.status !== "scheduled"
                      ? "This shift is already part of a switch."
                      : !dashboard.nextShift.tradeable
                        ? "Your program does not allow this shift to be switched."
                        : null
                  }
                />
              ) : null
            }
          />
        ) : (
          <EmptyState
            title="No upcoming shifts"
            description="When your program publishes the schedule, your shifts will appear here."
          />
        )}
      </section>

      {dashboard.upcoming.length > 0 ? (
        <section aria-labelledby="upcoming-heading">
          <SectionHeading
            id="upcoming-heading"
            title="Upcoming"
            action={
              <Link
                href="/schedule"
                className="flex items-center gap-1 text-sm font-semibold text-brand-ink"
              >
                Full schedule
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            }
          />
          <ul className="space-y-2">
            {dashboard.upcoming.map((shift) => (
              <li key={shift.id}>
                <ShiftCard shift={toShiftView(shift, timezone)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="available-heading">
        <SectionHeading
          id="available-heading"
          title="Shifts you can take"
          action={
            <Link
              href="/switches"
              className="flex items-center gap-1 text-sm font-semibold text-brand-ink"
            >
              See all
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          }
        />
        {dashboard.availableTrades.length === 0 ? (
          <EmptyState
            title="Nobody has posted a shift"
            description="There are currently no compatible shifts available. Try again later, or post one of your own shifts."
          />
        ) : (
          <ul className="space-y-2">
            {dashboard.availableTrades.slice(0, 3).map((trade) => {
              const view = toShiftView(trade.shift, timezone);
              return (
                <li key={trade.id}>
                  <Card>
                    <Link
                      href={`/switches/${trade.id}`}
                      className="block px-4 py-3.5 hover:bg-surface-muted"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink">
                            {view.dayLabel} · {view.serviceName}
                          </p>
                          <p className="mt-0.5 text-sm text-ink-muted">
                            {view.timeRange} · {trade.initiator_name} (PGY-
                            {trade.initiator_pgy})
                          </p>
                        </div>
                        {trade.my_offer_id ? (
                          <Badge tone="brand">You offered</Badge>
                        ) : (
                          <ChevronRight
                            className="mt-1 h-5 w-5 shrink-0 text-ink-subtle"
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    </Link>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="quick-heading">
        <SectionHeading id="quick-heading" title="Quick actions" />
        <Card>
          <CardBody className="grid gap-2 sm:grid-cols-3">
            {context.resident ? (
              <PostShiftButton
                shifts={postable.map((shift) => toShiftView(shift, timezone))}
                label="Post a shift"
                variant="secondary"
                icon={<CalendarPlus className="h-4 w-4" aria-hidden="true" />}
              />
            ) : null}
            <Link
              href="/switches"
              className="flex min-h-[2.75rem] items-center justify-center gap-2 rounded-xl border border-border-strong px-4 text-base font-semibold text-ink hover:bg-surface-muted"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              Find a trade
            </Link>
            <Link
              href="/schedule"
              className="flex min-h-[2.75rem] items-center justify-center gap-2 rounded-xl border border-border-strong px-4 text-base font-semibold text-ink hover:bg-surface-muted"
            >
              My schedule
            </Link>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
