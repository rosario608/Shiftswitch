import Link from "next/link";
import { CalendarCheck, Pencil, Clock3 } from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { requirePageUser } from "@/server/auth/page-guards";
import { listResidentSchedule } from "@/server/domain/schedule";
import { fmtDate, fmtRange } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Welcome" };

/**
 * The first screen after joining by an enrollment link.
 *
 * It exists because of the moment it covers: somebody has just signed in for
 * the first time, on a phone, probably between two things, and the question in
 * their head is "did that work". Dropping them on the home screen answers that
 * only if their schedule happens to be there — and answers it wrongly, and
 * permanently, if it is not.
 *
 * So this screen says three things and stops: what is already here, what is
 * missing and how to fix it, and — if their account is waiting to be confirmed
 * — what they can and cannot do meanwhile. It is a landing, not a tour: one
 * link out of it, to the thing they came to look at.
 */
export default async function WelcomePage() {
  const context = await requirePageUser();
  const zone = context.program.timezone;
  const pending = context.user.enrollmentStatus === "pending";

  const schedule = context.resident
    ? await listResidentSchedule(context.resident.id, { limit: 5 })
    : [];

  return (
    <div className="space-y-5">
      <header>
        <p className="text-sm font-medium text-brand-ink">You&rsquo;re in</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink">
          {schedule.length > 0
            ? `${schedule.length === 5 ? "Your next" : "Your"} ${schedule.length} shift${schedule.length === 1 ? "" : "s"} ${schedule.length === 1 ? "is" : "are"} here`
            : "Nothing on your schedule yet"}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {context.program.name} · signed in as {context.user.email}
        </p>
      </header>

      {pending ? (
        <Alert tone="info" title="Your program hasn't confirmed you yet">
          <p className="mt-1">
            You can see and correct your own schedule now. Posting a shift and
            offering on somebody else&rsquo;s opens up once whoever sent you the
            link confirms your account — it takes them a couple of taps.
          </p>
        </Alert>
      ) : null}

      {schedule.length > 0 ? (
        <Card>
          <CardBody className="space-y-3">
            <p className="font-semibold text-ink">
              What your program has for you
            </p>
            <ul className="space-y-2 text-sm">
              {schedule.map((shift) => (
                <li
                  key={shift.id}
                  className="flex items-baseline justify-between gap-3 border-b border-border-base pb-2 last:border-0 last:pb-0"
                >
                  <span className="font-medium text-ink">
                    {fmtDate(shift.start_datetime, zone)} {shift.service_name}
                  </span>
                  <span className="text-ink-muted">
                    {fmtRange(shift.start_datetime, shift.end_datetime, zone)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-ink-muted">
              These came from the file your program uploaded. If the hours are
              wrong, correct them — yours is the version everybody sees.
            </p>
            <Link
              href="/schedule"
              className="flex min-h-[3rem] w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 text-base font-semibold text-white"
            >
              <CalendarCheck className="h-5 w-5" aria-hidden="true" />
              See my schedule
            </Link>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="space-y-3">
            <span
              aria-hidden="true"
              className="flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-muted text-ink-muted"
            >
              <Clock3 className="h-5 w-5" />
            </span>
            <p className="font-semibold text-ink">
              Your program hasn&rsquo;t uploaded your block yet
            </p>
            <p className="text-sm text-ink-muted">
              That is normal in the first week. Two things can happen next: they
              upload the schedule and it appears here on its own, or you add your
              shifts yourself and they stay yours.
            </p>
            <Link
              href="/schedule/add"
              className="flex min-h-[3rem] w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 text-base font-semibold text-white"
            >
              <Pencil className="h-5 w-5" aria-hidden="true" />
              Add my shifts
            </Link>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
