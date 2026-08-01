import { query } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { listCoverageProblems } from "./coverage";

/**
 * Everything the scheduler dashboard needs, in one round trip.
 *
 * The screen is built for a chief resident who has fifteen minutes between
 * rounds and a schedule to finish. That constraint drives the shape of this
 * module more than anything else: it answers the questions somebody in that
 * position actually asks, in the order they ask them, and it does the counting
 * on the server so the page renders once rather than assembling itself.
 *
 * The questions, in order:
 *
 *   1. Is anything wrong?            — `problems`
 *   2. What am I working on?         — `drafts`
 *   3. Who do I have?                — `roster`
 *   4. What do I have to cover?      — `services`
 *   5. What is the year's shape?     — `blocks`
 *
 * Deliberately *not* a database administration screen. Counts are the unit,
 * links go to the place the work is done, and nothing here asks somebody to
 * understand the schema to use it.
 */

export interface SchedulerSnapshot {
  roster: {
    total: number;
    schedulable: number;
    unschedulable: number;
    byPgy: Array<{ pgy: number; count: number; inCohort: number }>;
    withoutCohort: number;
  };
  cohorts: {
    total: number;
    paired: number;
    unpaired: number;
    empty: number;
  };
  services: {
    total: number;
    active: number;
    withCoverage: number;
    mandatoryWithoutCoverage: Array<{ id: string; name: string }>;
    tradeable: number;
  };
  blocks: {
    structures: number;
    currentStructure: {
      id: string;
      name: string;
      academicYear: number;
      blockCount: number;
      assignedBlocks: number;
      unassignedBlocks: number;
    } | null;
  };
  schedule: {
    publishedShifts: number;
    upcomingShifts: number;
    unassignedUpcoming: number;
    drafts: Array<{
      id: string;
      name: string;
      periodStart: Date;
      periodEnd: Date;
      shiftCount: number;
      createdByName: string | null;
    }>;
  };
  /**
   * Things that are wrong *now* and that somebody has to decide about.
   *
   * Ordered by how much they hurt: a mandatory service nobody can be assigned
   * to is worse than a resident missing a cohort. Each carries the link to
   * where it is fixed, because a problem list that only names problems makes
   * somebody hunt for the screen.
   */
  problems: Array<{
    severity: "high" | "medium" | "low";
    title: string;
    detail: string;
    href: string;
  }>;
}

export async function loadSchedulerSnapshot(
  context: AuthedContext,
): Promise<SchedulerSnapshot> {
  const programId = context.program.id;

  const [
    rosterRows,
    cohortRows,
    serviceRows,
    structureRows,
    shiftCounts,
    draftRows,
    coverageProblems,
  ] = await Promise.all([
    query<{
      pgy_level: number;
      total: string;
      schedulable: string;
      in_cohort: string;
    }>(
      `SELECT r.pgy_level,
              count(*)::text AS total,
              count(*) FILTER (WHERE r.schedulable)::text AS schedulable,
              count(*) FILTER (WHERE m.id IS NOT NULL)::text AS in_cohort
         FROM residents r
         LEFT JOIN cohort_members m ON m.resident_id = r.id
         LEFT JOIN cohorts c ON c.id = m.cohort_id AND c.active = true
        WHERE r.program_id = $1 AND r.active = true
        GROUP BY r.pgy_level
        ORDER BY r.pgy_level`,
      [programId],
    ),
    query<{ total: string; paired: string; empty: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE paired_cohort_id IS NOT NULL)::text AS paired,
              count(*) FILTER (
                WHERE NOT EXISTS (
                  SELECT 1 FROM cohort_members m WHERE m.cohort_id = cohorts.id
                )
              )::text AS empty
         FROM cohorts WHERE program_id = $1 AND active = true`,
      [programId],
    ),
    query<{
      id: string;
      name: string;
      active: boolean;
      tradeable: boolean;
      coverage_mandatory: boolean;
      coverage_count: string;
    }>(
      `SELECT s.id, s.name, s.active, s.tradeable, s.coverage_mandatory,
              (SELECT count(*) FROM coverage_requirements c
                WHERE c.service_id = s.id AND c.active = true)::text AS coverage_count
         FROM services s WHERE s.program_id = $1
         ORDER BY lower(s.name)`,
      [programId],
    ),
    query<{
      id: string;
      name: string;
      academic_year: number;
      block_count: string;
      assigned_blocks: string;
    }>(
      `SELECT bs.id, bs.name, bs.academic_year,
              (SELECT count(*) FROM blocks b WHERE b.block_structure_id = bs.id)::text
                AS block_count,
              (SELECT count(DISTINCT a.block_id) FROM cohort_block_assignments a
                 JOIN blocks b ON b.id = a.block_id
                WHERE b.block_structure_id = bs.id)::text AS assigned_blocks
         FROM block_structures bs
        WHERE bs.program_id = $1 AND bs.active = true
        ORDER BY bs.academic_year DESC
        LIMIT 1`,
      [programId],
    ),
    query<{ published: string; upcoming: string; unassigned: string }>(
      `SELECT count(*)::text AS published,
              count(*) FILTER (WHERE s.end_datetime >= now())::text AS upcoming,
              count(*) FILTER (
                WHERE s.end_datetime >= now()
                  AND NOT EXISTS (
                    SELECT 1 FROM shift_assignments a
                     WHERE a.shift_id = s.id AND a.assignment_status = 'active'
                  )
              )::text AS unassigned
         FROM shifts s
        WHERE s.program_id = $1 AND s.schedule_version_id IS NULL
          AND s.status <> 'cancelled'`,
      [programId],
    ),
    query<{
      id: string;
      name: string;
      period_start: Date;
      period_end: Date;
      shift_count: string;
      created_by_name: string | null;
    }>(
      `SELECT v.id, v.name, v.period_start, v.period_end,
              (SELECT count(*) FROM shifts s WHERE s.schedule_version_id = v.id)::text
                AS shift_count,
              u.full_name AS created_by_name
         FROM schedule_versions v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.program_id = $1 AND v.status = 'draft'
        ORDER BY v.period_start`,
      [programId],
    ),
    listCoverageProblems(programId),
  ]);

  const structureCount = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM block_structures WHERE program_id = $1",
    [programId],
  );

  const byPgy = rosterRows.map((row) => ({
    pgy: row.pgy_level,
    count: Number(row.total),
    inCohort: Number(row.in_cohort),
  }));
  const total = byPgy.reduce((sum, row) => sum + row.count, 0);
  const schedulable = rosterRows.reduce((sum, row) => sum + Number(row.schedulable), 0);
  const withoutCohort = byPgy.reduce((sum, row) => sum + (row.count - row.inCohort), 0);

  const cohorts = cohortRows[0] ?? { total: "0", paired: "0", empty: "0" };
  const activeServices = serviceRows.filter((row) => row.active);
  const mandatoryWithoutCoverage = activeServices
    .filter((row) => row.coverage_mandatory && Number(row.coverage_count) === 0)
    .map((row) => ({ id: row.id, name: row.name }));

  const structure = structureRows[0] ?? null;
  const counts = shiftCounts[0] ?? { published: "0", upcoming: "0", unassigned: "0" };

  const problems: SchedulerSnapshot["problems"] = [];

  for (const service of mandatoryWithoutCoverage) {
    problems.push({
      severity: "high",
      title: `${service.name} has no coverage requirement`,
      detail:
        "It is marked as needing coverage every day it runs, but nothing says how many people. " +
        "Nothing will warn you when it is short.",
      href: "/admin/services",
    });
  }

  for (const problem of coverageProblems) {
    problems.push({
      severity: "high",
      title: `${problem.serviceName}: coverage cannot be met`,
      detail: problem.problem,
      href: "/admin/services",
    });
  }

  if (Number(counts.unassigned) > 0) {
    problems.push({
      severity: "high",
      title: `${counts.unassigned} upcoming shift(s) have nobody on them`,
      detail: "Published and in the future, with no resident assigned.",
      href: "/admin/schedule",
    });
  }

  if (withoutCohort > 0 && Number(cohorts.total) > 0) {
    problems.push({
      severity: "medium",
      title: `${withoutCohort} resident(s) are not in a cohort`,
      detail:
        "They will not pick up block assignments, so they have to be scheduled individually.",
      href: "/admin/cohorts",
    });
  }

  if (Number(cohorts.empty) > 0) {
    problems.push({
      severity: "low",
      title: `${cohorts.empty} cohort(s) have no members`,
      detail: "An empty cohort assigned to a block leaves that block uncovered.",
      href: "/admin/cohorts",
    });
  }

  if (structure && Number(structure.block_count) > Number(structure.assigned_blocks)) {
    const unassigned = Number(structure.block_count) - Number(structure.assigned_blocks);
    problems.push({
      severity: "medium",
      title: `${unassigned} block(s) have no cohort assigned`,
      detail: `In "${structure.name}". Nobody is scheduled for those weeks yet.`,
      href: "/admin/cohorts",
    });
  }

  const severityOrder = { high: 0, medium: 1, low: 2 } as const;
  problems.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    roster: {
      total,
      schedulable,
      unschedulable: total - schedulable,
      byPgy,
      withoutCohort,
    },
    cohorts: {
      total: Number(cohorts.total),
      paired: Number(cohorts.paired),
      unpaired: Number(cohorts.total) - Number(cohorts.paired),
      empty: Number(cohorts.empty),
    },
    services: {
      total: serviceRows.length,
      active: activeServices.length,
      withCoverage: activeServices.filter((row) => Number(row.coverage_count) > 0).length,
      mandatoryWithoutCoverage,
      tradeable: activeServices.filter((row) => row.tradeable).length,
    },
    blocks: {
      structures: Number(structureCount[0]?.count ?? 0),
      currentStructure: structure
        ? {
            id: structure.id,
            name: structure.name,
            academicYear: structure.academic_year,
            blockCount: Number(structure.block_count),
            assignedBlocks: Number(structure.assigned_blocks),
            unassignedBlocks:
              Number(structure.block_count) - Number(structure.assigned_blocks),
          }
        : null,
    },
    schedule: {
      publishedShifts: Number(counts.published),
      upcomingShifts: Number(counts.upcoming),
      unassignedUpcoming: Number(counts.unassigned),
      drafts: draftRows.map((row) => ({
        id: row.id,
        name: row.name,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        shiftCount: Number(row.shift_count),
        createdByName: row.created_by_name,
      })),
    },
    problems,
  };
}
