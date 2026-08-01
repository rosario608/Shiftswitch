import { AvailabilityManager } from "@/components/app/availability-manager";
import { requirePageCapability } from "@/server/auth/page-guards";
import {
  ABSENCE_KINDS,
  ABSENCE_KIND_DEFAULT_HARD,
  ABSENCE_KIND_DESCRIPTION,
  ABSENCE_KIND_LABEL,
  listAbsences,
} from "@/server/domain/availability";
import { listRoster } from "@/server/domain/roster";
import { localDateString } from "@/server/domain/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Availability" };

/**
 * Who is away, and when.
 *
 * The window starts today rather than at the beginning of time: leave that has
 * been taken is history, and a screen that opens on last year's vacations is a
 * screen nobody scrolls. Everything here feeds the constraint model directly —
 * a confirmed row is the same thing to the validator as a hard-coded
 * unavailable date, which is why this page and the schedule check never
 * disagree.
 */
export default async function AvailabilityPage() {
  const context = await requirePageCapability("scheduling.plan");
  const from = localDateString(new Date(), context.program.timezone);

  const [absences, roster] = await Promise.all([
    listAbsences(context.program.id, { from }),
    listRoster(context),
  ]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Availability</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Vacation, leave, conferences, electives and restrictions from today
          onwards. Confirmed entries are enforced when a schedule is generated or
          checked; requested ones are honoured where they can be.
        </p>
      </header>

      <AvailabilityManager
        manages
        selfResidentId={context.resident?.id ?? null}
        residents={roster.map((resident) => ({
          id: resident.id,
          name: resident.name,
        }))}
        kinds={ABSENCE_KINDS.map((kind) => ({
          value: kind,
          label: ABSENCE_KIND_LABEL[kind],
          description: ABSENCE_KIND_DESCRIPTION[kind],
          defaultHard: ABSENCE_KIND_DEFAULT_HARD[kind],
        }))}
        absences={absences.map((absence) => ({
          id: absence.id,
          residentId: absence.resident_id,
          residentName: absence.resident_name,
          kind: absence.kind,
          kindLabel: ABSENCE_KIND_LABEL[absence.kind],
          startDate: absence.start_date,
          endDate: absence.end_date,
          hard: absence.hard,
          notes: absence.notes,
          createdByName: absence.created_by_name,
        }))}
      />
    </div>
  );
}
