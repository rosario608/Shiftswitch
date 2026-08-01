import { CohortsManager } from "@/components/app/cohorts-manager";
import { requirePageCapability } from "@/server/auth/page-guards";
import { listBlockStructures, listBlocks } from "@/server/domain/blocks";
import {
  listBlockAssignments,
  listCohorts,
  listResidentOverrides,
} from "@/server/domain/cohorts";
import { listRoster } from "@/server/domain/roster";
import { listServices } from "@/server/domain/services";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cohorts and blocks" };

/**
 * Cohorts and the year they move through.
 *
 * One screen rather than two, because the question a scheduler asks is never
 * "what cohorts exist" — it is "who is on what, when", and that needs both.
 */
export default async function CohortsPage() {
  const context = await requirePageCapability("scheduling.plan");
  const [cohorts, structures, roster, services] = await Promise.all([
    listCohorts(context.program.id, { includeInactive: true }),
    listBlockStructures(context.program.id),
    listRoster(context),
    listServices(context.program.id, "service"),
  ]);

  const current = structures.find((structure) => structure.active) ?? structures[0] ?? null;
  const [blocks, assignments, overrides] = current
    ? await Promise.all([
        listBlocks(context.program.id, current.id),
        listBlockAssignments(context.program.id, current.id),
        listResidentOverrides(context.program.id, current.id),
      ])
    : [[], [], []];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Cohorts and blocks</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Cohorts are groups within a PGY class that move through the year
          together. Blocks are the year itself. Assigning a cohort to a block
          says what that group is doing for those weeks.
        </p>
      </header>

      <CohortsManager
        cohorts={cohorts.map((cohort) => ({
          id: cohort.id,
          label: cohort.label,
          pgyLevel: cohort.pgy_level,
          pairedCohortId: cohort.paired_cohort_id,
          pairedCohortLabel: cohort.paired_cohort_label,
          memberCount: cohort.member_count,
          active: cohort.active,
          notes: cohort.notes,
          startDate: cohort.start_date
            ? cohort.start_date.toISOString().slice(0, 10)
            : null,
          endDate: cohort.end_date ? cohort.end_date.toISOString().slice(0, 10) : null,
        }))}
        structures={structures.map((structure) => ({
          id: structure.id,
          name: structure.name,
          academicYear: structure.academic_year,
          blockCount: structure.block_count,
        }))}
        currentStructureId={current?.id ?? null}
        blocks={blocks.map((block) => ({
          id: block.id,
          sequence: block.sequence,
          label: block.label,
          kind: block.kind,
          startDate: block.start_date.toISOString().slice(0, 10),
          endDate: block.end_date.toISOString().slice(0, 10),
        }))}
        assignments={assignments.map((assignment) => ({
          cohortId: assignment.cohort_id,
          blockId: assignment.block_id,
          serviceId: assignment.service_id,
          serviceName: assignment.service_name,
          label: assignment.label,
        }))}
        overrides={overrides.map((override) => ({
          residentId: override.resident_id,
          residentName: override.resident_name,
          blockId: override.block_id,
          blockLabel: override.block_label,
          serviceName: override.service_name,
          label: override.label,
          reason: override.reason,
        }))}
        residents={roster.map((resident) => ({
          id: resident.id,
          name: resident.name,
          pgyLevel: resident.pgy_level,
          cohortId: resident.cohort_id,
          schedulable: resident.schedulable,
        }))}
        services={services
          .filter((service) => service.active)
          .map((service) => ({ id: service.id, name: service.name }))}
      />
    </div>
  );
}
