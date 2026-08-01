import Link from "next/link";
import { CalendarPlus, Download } from "lucide-react";
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
        description="This is an administrator account, so it has no shifts of its own. The program's schedule is in the admin area."
        action={
          <Link
            href="/admin/schedule"
            className="inline-flex min-h-[2.75rem] items-center rounded-xl bg-brand px-4 font-semibold text-white"
          >
            Open the program schedule
          </Link>
        }
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
        <CardBody className="space-y-2">
          <PostShiftButton
            shifts={postable.map((shift) => toShiftView(shift, timezone))}
            label="Post a shift"
          />
          <Link
            href="/schedule/add"
            className="flex min-h-[2.75rem] items-center justify-center gap-1.5 rounded-xl border border-border-strong px-4 text-sm font-semibold text-ink"
          >
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            Add shifts myself
          </Link>
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <Link
          href="/schedule"
          aria-current={!showPast ? "page" : undefined}
          className={`min-h-[2.5rem] flex-1 rounded-xl px-4 py-2 text-center text-sm font-semibold ${
            !showPast ? "bg-brand text-white" : "border border-border-strong text-ink-muted"
          }`}
        >
          Upcoming
        </Link>
        <Link
          href="/schedule?past=1"
          aria-current={showPast ? "page" : undefined}
          className={`min-h-[2.5rem] flex-1 rounded-xl px-4 py-2 text-center text-sm font-semibold ${
            showPast ? "bg-brand text-white" : "border border-border-strong text-ink-muted"
          }`}
        >
          All shifts
        </Link>
      </div>

      {shifts.length === 0 ? (
        /* Nobody lands empty. If the program has not uploaded a schedule yet,
           the useful thing is not a tour of somebody else's shifts — it is the
           ability to put in what they are actually working, today. */
        <EmptyState
          title={showPast ? "No shifts on record" : "Nothing scheduled yet"}
          description={
            showPast
              ? "Shifts you have already worked will be listed here."
              : "Your program has not uploaded your block yet. Add what you are working and it is yours straight away — when they do upload it, anything they send lands here too."
          }
          action={
            showPast ? undefined : (
              <Link
                href="/schedule/add"
                className="inline-flex min-h-[2.75rem] items-center rounded-xl bg-brand px-4 font-semibold text-white"
              >
                Add my shifts
              </Link>
            )
          }
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
