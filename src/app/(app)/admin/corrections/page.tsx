import { CorrectionsPanel } from "@/components/app/corrections-panel";
import { requirePageCapability } from "@/server/auth/page-guards";
import { query } from "@/server/db/pool";
import { listCorrections, todayIn } from "@/server/domain/schedule-corrections";
import { listRoster } from "@/server/domain/roster";
import { fmtDate, fmtTimestamp } from "@/lib/format";
import { addLocalDays } from "@/server/domain/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Corrections" };

/** Far enough ahead to cover the block being worked, not the whole year. */
const HORIZON_DAYS = 60;

/**
 * What has changed since the schedule was published, and how to change it again.
 *
 * A separate screen from the scheduler on purpose. Building next block and
 * correcting this one are different acts with different consequences, and a
 * single screen offering both invites doing the expensive one by accident.
 */
export default async function CorrectionsPage() {
  const context = await requirePageCapability("schedule.manage");
  const timezone = context.program.timezone;
  const today = todayIn(timezone);

  const [corrections, roster, shifts] = await Promise.all([
    listCorrections(context.program.id),
    listRoster(context),
    query<{
      id: string;
      date: string;
      service_name: string;
      start_datetime: Date;
      resident_name: string | null;
    }>(
      `SELECT s.id, s.date::text AS date, sv.name AS service_name, s.start_datetime,
              u.full_name AS resident_name
         FROM shifts s
         JOIN services sv ON sv.id = s.service_id
         LEFT JOIN shift_assignments a
           ON a.shift_id = s.id AND a.assignment_status = 'active'
         LEFT JOIN residents r ON r.id = a.resident_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE s.program_id = $1 AND s.schedule_version_id IS NULL
          AND s.status <> 'cancelled'
          AND s.date >= $2::date AND s.date <= $3::date
        ORDER BY s.start_datetime
        LIMIT 400`,
      [context.program.id, today, addLocalDays(today, HORIZON_DAYS)],
    ),
  ]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Corrections</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Changes made to the published schedule after residents started working
          it — what changed, who made it, and why.
        </p>
      </header>

      <CorrectionsPanel
        corrections={corrections.map((correction) => ({
          id: correction.id,
          shiftId: correction.shift_id,
          date: fmtDate(correction.start_datetime, timezone),
          serviceName: correction.service_name,
          previousResidentName: correction.previous_resident_name,
          newResidentName: correction.new_resident_name,
          reason: correction.reason,
          summary: correction.impact?.summary ?? null,
          safe: correction.impact?.safe ?? null,
          correctedByName: correction.corrected_by_name,
          at: fmtTimestamp(correction.created_at, timezone),
        }))}
        shifts={shifts.map((shift) => ({
          id: shift.id,
          label: `${fmtDate(shift.start_datetime, timezone)} · ${shift.service_name} · ${
            shift.resident_name ?? "nobody"
          }`,
          residentName: shift.resident_name,
        }))}
        residents={roster
          .filter((resident) => resident.active && resident.schedulable)
          .map((resident) => ({
            id: resident.id,
            name: resident.name,
            pgyLevel: resident.pgy_level,
          }))}
      />
    </div>
  );
}
