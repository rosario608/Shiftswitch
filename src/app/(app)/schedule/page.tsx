import { Download } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ShiftCard } from "@/components/app/shift-card";
import { PostShiftButton } from "@/components/app/post-shift-sheet";
import { requirePageUser } from "@/server/auth/page-guards";
import { listResidentSchedule } from "@/server/domain/schedule";
import { listOfferableForPosting } from "@/server/domain/schedule-actions";
import { toShiftView } from "@/lib/views";
import { fmtDateLong } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedule" };

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ past?: string }>;
}) {
  const context = await requirePageUser();
  const params = await searchParams;
  const showPast = params.past === "1";
  const timezone = context.program.timezone;

  if (!context.resident) {
    return (
      <EmptyState
        title="No schedule for this account"
        description="Your account is an administrator account and does not have shifts assigned. Use the admin area to view the program schedule."
      />
    );
  }

  const shifts = await listResidentSchedule(context.resident.id, {
    includePast: showPast,
    limit: 200,
  });
  const postable = await listOfferableForPosting(context.resident.id);

  // Group by local calendar month for a scannable mobile list.
  const groups = new Map<string, typeof shifts>();
  for (const shift of shifts) {
    const key = fmtDateLong(shift.start_datetime, timezone).split(", ").slice(1).join(", ");
    const monthKey = key.replace(/\s\d{1,2},/, "");
    const list = groups.get(monthKey) ?? [];
    list.push(shift);
    groups.set(monthKey, list);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">My schedule</h1>
          <p className="mt-1 text-sm text-ink-muted">
            All times shown in {timezone.replace("_", " ")}.
          </p>
        </div>
        <a
          href="/api/admin/export?format=csv&scope=mine"
          className="flex min-h-[2.75rem] items-center gap-1.5 rounded-xl border border-border-strong px-3 text-sm font-semibold text-ink"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Export
        </a>
      </header>

      <Card>
        <CardBody>
          <PostShiftButton
            shifts={postable.map((shift) => toShiftView(shift, timezone))}
            label="Post a shift for trade"
          />
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <a
          href="/schedule"
          aria-current={!showPast ? "page" : undefined}
          className={`min-h-[2.5rem] flex-1 rounded-xl px-4 py-2 text-center text-sm font-semibold ${
            !showPast ? "bg-brand text-white" : "border border-border-strong text-ink-muted"
          }`}
        >
          Upcoming
        </a>
        <a
          href="/schedule?past=1"
          aria-current={showPast ? "page" : undefined}
          className={`min-h-[2.5rem] flex-1 rounded-xl px-4 py-2 text-center text-sm font-semibold ${
            showPast ? "bg-brand text-white" : "border border-border-strong text-ink-muted"
          }`}
        >
          All shifts
        </a>
      </div>

      {shifts.length === 0 ? (
        <EmptyState
          title={showPast ? "No shifts on record" : "No upcoming shifts"}
          description="When your program publishes the schedule, your shifts appear here."
        />
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([month, monthShifts]) => (
            <section key={month} aria-label={month}>
              <h2 className="mb-2 px-1 text-sm font-semibold tracking-wide text-ink-muted uppercase">
                {month}
              </h2>
              <ul className="space-y-2">
                {monthShifts.map((shift) => (
                  <li key={shift.id}>
                    <ShiftCard
                      shift={toShiftView(shift, timezone)}
                      href={`/schedule/${shift.id}`}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
