import { RosterManager } from "@/components/app/roster-manager";
import { requirePageCapability } from "@/server/auth/page-guards";
import { can } from "@/server/auth/roles";
import { listCohorts } from "@/server/domain/cohorts";
import { formatPhone, listRoster, listSites } from "@/server/domain/roster";

export const dynamic = "force-dynamic";
export const metadata = { title: "Roster" };

/**
 * Who can work, and who cannot.
 *
 * Leads with availability rather than with a directory, because the question
 * that brings somebody here is almost never "show me a list of residents" — it
 * is "who is free" or "how do I reach this person", usually because somebody
 * has called in sick. A directory answers neither without being read.
 */
export default async function RosterPage() {
  const context = await requirePageCapability("scheduling.plan");
  const [roster, sites, cohorts] = await Promise.all([
    listRoster(context),
    listSites(context.program.id),
    listCohorts(context.program.id),
  ]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Roster</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Everybody who works a schedule, and what the scheduler needs to know
          about them.
        </p>
      </header>

      <RosterManager
        residents={roster.map((resident) => ({
          id: resident.id,
          name: resident.name,
          email: resident.email,
          pgyLevel: resident.pgy_level,
          active: resident.active,
          schedulable: resident.schedulable,
          schedulingNotes: resident.scheduling_notes,
          cohortLabel: resident.cohort_label,
          upcomingShifts: resident.upcoming_shifts,
          // Null unless the caller holds `residents.contact_info`; the column is
          // not selected at all otherwise, so this cannot leak.
          phone: resident.phone,
          phoneDisplay: resident.phone ? formatPhone(resident.phone) : null,
        }))}
        sites={sites
          .filter((site) => site.active)
          .map((site) => ({ id: site.id, name: site.name }))}
        cohortCount={cohorts.length}
        mayReadPhone={can(context.user.role, "residents.contact_info")}
      />
    </div>
  );
}
