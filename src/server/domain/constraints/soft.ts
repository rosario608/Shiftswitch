import { isNightShift, isWeekendLocal } from "@/server/domain/time";
import { preferencesOf } from "./person";
import { assignmentsByResident } from "./rule-bridge";
import {
  assignmentDate,
  blockContaining,
  day,
  plural,
  staffedAssignments,
  violation,
} from "./shared";
import type {
  Constraint,
  ScheduleAssignment,
  ScheduleResident,
  ScheduleSnapshot,
  Violation,
} from "./types";

/**
 * The soft constraints: what makes a legal schedule a good one.
 *
 * None of these can make a schedule invalid. A programme that publishes a
 * lopsided month has published a real schedule and people will work it; a
 * programme that publishes one with a hard violation has left a ward
 * uncovered. Keeping the two apart is the entire point of the distinction, and
 * it is why a resident's *preference* lives in a different column from a
 * resident's *accommodation*.
 *
 * Each violation carries a `penalty` from 0 to 1 — how bad this instance is,
 * on that constraint's own terms. The score in `scoring.ts` combines them, and
 * shows the breakdown rather than one number, because "0.62" tells a chief
 * nothing and "nights are lopsided, everything else is fine" tells them what to
 * change.
 *
 * ## On thresholds
 *
 * Several of these need a line: how uneven is uneven. The lines chosen here are
 * judgement, and they are stated in the code rather than buried in a formula so
 * a programme that disagrees can see exactly what to argue with. A difference
 * of one shift is not unfairness — it is what happens when an odd number of
 * shifts meets an even number of people — so the fairness constraints stay
 * quiet until the gap is at least two.
 */

const FAIRNESS_TOLERANCE = 2;

/** Counts per person, grouped by the peer set they should be compared against. */
function byPeerGroup(
  snapshot: ScheduleSnapshot,
  count: (assignments: ScheduleAssignment[]) => number,
): Array<{ pgy: number; counts: Array<{ resident: ScheduleResident; value: number }> }> {
  const held = assignmentsByResident(snapshot);
  const groups = new Map<number, Array<{ resident: ScheduleResident; value: number }>>();

  for (const resident of snapshot.residents) {
    /* Only people who could have been scheduled are compared. Including
       somebody on parental leave would make every programme look unfair to
       the person it is protecting. */
    if (!resident.active || !resident.schedulable) continue;
    const value = count(held.get(resident.id) ?? []);
    const list = groups.get(resident.pgyLevel);
    if (list) list.push({ resident, value });
    else groups.set(resident.pgyLevel, [{ resident, value }]);
  }

  return [...groups.entries()]
    .map(([pgy, counts]) => ({ pgy, counts }))
    .sort((a, b) => a.pgy - b.pgy);
}

/**
 * One violation per training level whose spread exceeds the tolerance.
 *
 * Compared within a level rather than across the programme, because a PGY-1
 * and a PGY-3 are not meant to have the same month, and a validator that said
 * so would be flagging a correct schedule.
 */
function spreadViolations(
  snapshot: ScheduleSnapshot,
  options: {
    constraintId: string;
    label: string;
    topic: Constraint["topic"];
    noun: string;
    nounPlural: string;
  },
  count: (assignments: ScheduleAssignment[]) => number,
): Violation[] {
  const violations: Violation[] = [];

  for (const { pgy, counts } of byPeerGroup(snapshot, count)) {
    if (counts.length < 2) continue;
    const values = counts.map((c) => c.value);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const gap = max - min;
    if (gap < FAIRNESS_TOLERANCE) continue;

    /* Sorted by name inside each extreme so the sentence is the same on every
       run: a score that moves when nothing changed is a score nobody trusts. */
    const most = counts
      .filter((c) => c.value === max)
      .sort((a, b) => a.resident.name.localeCompare(b.resident.name));
    const least = counts
      .filter((c) => c.value === min)
      .sort((a, b) => a.resident.name.localeCompare(b.resident.name));

    violations.push(
      violation({
        constraintId: options.constraintId,
        kind: "soft",
        topic: options.topic,
        label: options.label,
        message:
          `Among PGY-${pgy}s, ${most[0].resident.name} has ${plural(max, options.noun, options.nounPlural)} ` +
          `and ${least[0].resident.name} has ${min} — a gap of ${plural(gap, options.noun, options.nounPlural)}.`,
        residentIds: [...most, ...least].map((c) => c.resident.id),
        /* `gap / (max + tolerance)` rather than `gap / max`.

           The obvious formula divides by the busiest person's count, which
           saturates at 1 the moment anybody has none — so "two shifts versus
           none" and "twelve versus none" score identically, and a schedule
           that halved the gap would not move the number at all. That is fatal
           for the thing this score is *for*: it is the oracle a generator is
           graded against, and an objective with no gradient cannot be
           optimised towards. Adding the tolerance to the denominator keeps the
           measure bounded and monotonic in the gap, so improving a schedule
           always improves its score. */
        penalty: Math.min(1, gap / (max + FAIRNESS_TOLERANCE)),
      }),
    );
  }
  return violations;
}

const workloadFairness: Constraint = {
  id: "workload-fairness",
  kind: "soft",
  topic: "fairness",
  label: "Workload fairness",
  description:
    "People at the same training level work a similar number of shifts.",
  weight: 3,
  evaluate: (snapshot) =>
    spreadViolations(
      snapshot,
      {
        constraintId: "workload-fairness",
        label: "Workload fairness",
        topic: "fairness",
        noun: "shift",
        nounPlural: "shifts",
      },
      (assignments) => assignments.length,
    ),
};

const nightBalance: Constraint = {
  id: "night-balance",
  kind: "soft",
  topic: "fairness",
  label: "Night balance",
  description: "Nights are shared out evenly within a training level.",
  weight: 3,
  evaluate: (snapshot) =>
    spreadViolations(
      snapshot,
      {
        constraintId: "night-balance",
        label: "Night balance",
        topic: "fairness",
        noun: "night",
        nounPlural: "nights",
      },
      (assignments) =>
        assignments.filter((a) =>
          isNightShift(a.start, a.end, snapshot.program.timezone),
        ).length,
    ),
};

const weekendBalance: Constraint = {
  id: "weekend-balance",
  kind: "soft",
  topic: "fairness",
  label: "Weekend balance",
  description: "Weekends are shared out evenly within a training level.",
  weight: 3,
  evaluate: (snapshot) =>
    spreadViolations(
      snapshot,
      {
        constraintId: "weekend-balance",
        label: "Weekend balance",
        topic: "fairness",
        noun: "weekend shift",
        nounPlural: "weekend shifts",
      },
      (assignments) =>
        assignments.filter((a) =>
          isWeekendLocal(a.start, snapshot.program.timezone),
        ).length,
    ),
};

/**
 * The shifts nobody wants, counted together.
 *
 * Nights and weekends are already balanced individually, but somebody can be
 * within tolerance on each and still have every bad shift in the month:
 * the weekends they did not get were nights, and vice versa. A programme's
 * fairness argument is about the total, so the total is its own objective.
 * Holidays the programme has named count double, because they do.
 */
const undesirableBalance: Constraint = {
  id: "undesirable-balance",
  kind: "soft",
  topic: "fairness",
  label: "Unpopular shifts",
  description:
    "Nights, weekends and holidays taken together are shared out evenly, not just each on its own.",
  weight: 4,
  evaluate: (snapshot) => {
    const holidays = new Set<string>();
    for (const rule of snapshot.rules) {
      if (rule.rule_type !== "holiday_restriction" || !rule.active) continue;
      const dates = rule.params.dates;
      if (!Array.isArray(dates)) continue;
      for (const date of dates) if (typeof date === "string") holidays.add(date);
    }

    return spreadViolations(
      snapshot,
      {
        constraintId: "undesirable-balance",
        label: "Unpopular shifts",
        topic: "fairness",
        noun: "unpopular shift",
        nounPlural: "unpopular shifts",
      },
      (assignments) =>
        assignments.reduce((total, a) => {
          const night = isNightShift(a.start, a.end, snapshot.program.timezone);
          const weekend = isWeekendLocal(a.start, snapshot.program.timezone);
          const holiday = holidays.has(
            assignmentDate(a, snapshot.program.timezone),
          );
          return total + (night ? 1 : 0) + (weekend ? 1 : 0) + (holiday ? 2 : 0);
        }, 0),
    );
  },
};

const statedPreferences: Constraint = {
  id: "stated-preferences",
  kind: "soft",
  topic: "preference",
  label: "Stated preferences",
  description:
    "What people asked for — days off requested, services they would rather avoid or work — is honoured where it can be.",
  weight: 2,
  evaluate: (snapshot) => {
    const held = assignmentsByResident(snapshot);
    const violations: Violation[] = [];

    for (const resident of snapshot.residents) {
      const assignments = held.get(resident.id) ?? [];
      if (assignments.length === 0) continue;
      const wishes = preferencesOf(resident);

      const onAvoided = assignments.filter((a) =>
        wishes.avoidServiceIds.includes(a.serviceId),
      );
      const onRequestedOff = assignments.filter((a) =>
        wishes.requestedDaysOff.includes(
          assignmentDate(a, snapshot.program.timezone),
        ),
      );
      const wrongShiftType = wishes.preferredShiftType
        ? assignments.filter((a) => {
            const night = isNightShift(a.start, a.end, snapshot.program.timezone);
            return wishes.preferredShiftType === "night" ? !night : night;
          })
        : [];

      const parts: string[] = [];
      if (onRequestedOff.length > 0) {
        parts.push(
          `is scheduled on ${plural(onRequestedOff.length, "day")} they asked to have off ` +
            `(${onRequestedOff
              .map((a) => day(a.start, snapshot.program.timezone))
              .join(", ")})`,
        );
      }
      if (onAvoided.length > 0) {
        parts.push(
          `has ${plural(onAvoided.length, "shift")} on ${[
            ...new Set(onAvoided.map((a) => a.serviceName)),
          ].join(", ")}, which they asked to avoid`,
        );
      }
      if (wrongShiftType.length > 0 && wrongShiftType.length === assignments.length) {
        parts.push(
          `asked for ${wishes.preferredShiftType === "night" ? "nights" : "days"} and has none`,
        );
      }
      if (parts.length === 0) continue;

      const affected = [...onAvoided, ...onRequestedOff];
      violations.push(
        violation({
          constraintId: "stated-preferences",
          kind: "soft",
          topic: "preference",
          label: "Stated preferences",
          message: `${resident.name} ${parts.join(", and ")}.`,
          residentIds: [resident.id],
          serviceIds: [...new Set(affected.map((a) => a.serviceId))],
          shiftIds: affected.map((a) => a.shiftId),
          dates: [
            ...new Set(
              affected.map((a) => assignmentDate(a, snapshot.program.timezone)),
            ),
          ],
          penalty: Math.min(1, affected.length / assignments.length),
        }),
      );
    }
    return violations;
  },
};

/**
 * How often somebody's service changes underneath them inside one block.
 *
 * A block exists so that a resident spends it learning one thing. Two services
 * in a block is ordinary — a rotation plus its call. Three is a week here and a
 * week there, which is the pattern residents describe as being "scattered", and
 * it is invisible in every other view because each individual shift is legal.
 */
const CONTINUITY_TOLERANCE = 2;

const continuity: Constraint = {
  id: "continuity",
  kind: "soft",
  topic: "continuity",
  label: "Continuity within a block",
  description:
    "People stay on one service through a block rather than being moved between several.",
  weight: 2,
  evaluate: (snapshot) => {
    if (snapshot.blocks.length === 0) return [];
    const held = assignmentsByResident(snapshot);
    const violations: Violation[] = [];

    for (const resident of snapshot.residents) {
      const assignments = held.get(resident.id) ?? [];
      const perBlock = new Map<string, Set<string>>();
      const shiftsPerBlock = new Map<string, ScheduleAssignment[]>();

      for (const a of assignments) {
        const block = blockContaining(
          snapshot.blocks,
          assignmentDate(a, snapshot.program.timezone),
        );
        if (!block) continue;
        const services = perBlock.get(block.id) ?? new Set<string>();
        services.add(a.serviceId);
        perBlock.set(block.id, services);
        const list = shiftsPerBlock.get(block.id) ?? [];
        list.push(a);
        shiftsPerBlock.set(block.id, list);
      }

      for (const [blockId, services] of perBlock) {
        if (services.size <= CONTINUITY_TOLERANCE) continue;
        const block = snapshot.blocks.find((b) => b.id === blockId)!;
        const shifts = shiftsPerBlock.get(blockId) ?? [];
        violations.push(
          violation({
            constraintId: "continuity",
            kind: "soft",
            topic: "continuity",
            label: "Continuity within a block",
            message: `${resident.name} is moved between ${plural(services.size, "service")} during ${block.label}.`,
            residentIds: [resident.id],
            serviceIds: [...services],
            shiftIds: shifts.map((a) => a.shiftId),
            dates: [block.startDate],
            penalty: Math.min(1, (services.size - CONTINUITY_TOLERANCE) / 3),
          }),
        );
      }
    }
    return violations;
  },
};

/**
 * A cohort that has been scattered.
 *
 * Only judged for blocks the programme has *not* assigned the cohort to —
 * where it has, `block-structure` is the hard answer and this would say the
 * same thing twice in a weaker voice.
 */
const cohortConsistency: Constraint = {
  id: "cohort-consistency",
  kind: "soft",
  topic: "continuity",
  label: "Cohorts stay together",
  description:
    "Members of a cohort move through the year together, rather than being split across services in a block nobody assigned them to.",
  weight: 1,
  evaluate: (snapshot) => {
    if (snapshot.blocks.length === 0) return [];
    const assigned = new Set(
      snapshot.blockAssignments
        .filter((a) => a.serviceId)
        .map((a) => `${a.cohortId}:${a.blockId}`),
    );
    const overridden = new Set(
      snapshot.overrides.map((o) => `${o.residentId}:${o.blockId}`),
    );
    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));

    /* cohort:block -> service -> the people on it */
    const grid = new Map<string, Map<string, Set<string>>>();
    for (const a of staffedAssignments(snapshot)) {
      const resident = byId.get(a.residentId!);
      if (!resident?.cohortId) continue;
      const block = blockContaining(
        snapshot.blocks,
        assignmentDate(a, snapshot.program.timezone),
      );
      if (!block) continue;
      const key = `${resident.cohortId}:${block.id}`;
      if (assigned.has(key)) continue;
      if (overridden.has(`${resident.id}:${block.id}`)) continue;

      const services = grid.get(key) ?? new Map<string, Set<string>>();
      const people = services.get(a.serviceId) ?? new Set<string>();
      people.add(resident.id);
      services.set(a.serviceId, people);
      grid.set(key, services);
    }

    const violations: Violation[] = [];
    for (const [key, services] of grid) {
      if (services.size < 2) continue;
      const [cohortId, blockId] = key.split(":");
      const block = snapshot.blocks.find((b) => b.id === blockId)!;
      const cohortLabel =
        snapshot.residents.find((r) => r.cohortId === cohortId)?.cohortLabel ??
        "A cohort";
      const names = [...services.keys()]
        .map(
          (serviceId) =>
            snapshot.services.find((s) => s.id === serviceId)?.name ?? "a service",
        )
        .sort();

      violations.push(
        violation({
          constraintId: "cohort-consistency",
          kind: "soft",
          topic: "continuity",
          label: "Cohorts stay together",
          message: `${cohortLabel} is split across ${plural(services.size, "service")} in ${block.label} (${names.join(", ")}), and no cohort assignment says it should be.`,
          residentIds: [...new Set([...services.values()].flatMap((s) => [...s]))],
          serviceIds: [...services.keys()],
          dates: [block.startDate],
          penalty: Math.min(1, (services.size - 1) / 3),
        }),
      );
    }
    return violations;
  },
};

/**
 * One person carrying a service.
 *
 * Distinct from workload fairness: somebody can work an ordinary number of
 * shifts and still be the only person who ever covers nights on the MICU. That
 * is how a programme discovers in June that one resident has done a year of
 * one thing.
 */
const serviceDistribution: Constraint = {
  id: "service-distribution",
  kind: "soft",
  topic: "fairness",
  label: "Service distribution",
  description:
    "No single person carries a disproportionate share of any one service.",
  weight: 2,
  evaluate: (snapshot) => {
    const perService = new Map<string, Map<string, number>>();
    for (const a of staffedAssignments(snapshot)) {
      const counts = perService.get(a.serviceId) ?? new Map<string, number>();
      counts.set(a.residentId!, (counts.get(a.residentId!) ?? 0) + 1);
      perService.set(a.serviceId, counts);
    }

    const violations: Violation[] = [];
    for (const [serviceId, counts] of perService) {
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      /* Below this a service is simply small, and one person doing most of
         four shifts is not a finding. */
      if (total < 6 || counts.size < 2) continue;

      const [topResidentId, topCount] = [...counts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0];
      const share = topCount / total;
      const fairShare = 1 / counts.size;
      // Twice a fair share, and more than half the service, before it is worth saying.
      if (share <= Math.max(2 * fairShare, 0.5)) continue;

      const service = snapshot.services.find((s) => s.id === serviceId);
      const resident = snapshot.residents.find((r) => r.id === topResidentId);
      violations.push(
        violation({
          constraintId: "service-distribution",
          kind: "soft",
          topic: "fairness",
          label: "Service distribution",
          message: `${resident?.name ?? "One person"} covers ${topCount} of the ${total} ${service?.name ?? "service"} shifts in this schedule, shared with ${plural(counts.size - 1, "other person", "other people")}.`,
          residentIds: [topResidentId],
          serviceIds: [serviceId],
          penalty: Math.min(1, share),
        }),
      );
    }
    return violations;
  },
};

/**
 * How much of the existing schedule this one rewrites.
 *
 * Only evaluated when a baseline was supplied. Every move is somebody who made
 * childcare arrangements around a shift that has now gone, so between two
 * schedules that are equally good on everything else, the one that moves fewer
 * people is better — and a chief comparing two drafts should be able to see
 * that at a glance.
 */
const minimiseChange: Constraint = {
  id: "minimise-change",
  kind: "soft",
  topic: "change",
  label: "Changes to the live schedule",
  description:
    "Fewer people are moved from the schedule this one would replace.",
  weight: 1,
  evaluate: (snapshot) => {
    const baseline = snapshot.baseline;
    if (!baseline || baseline.length === 0) return [];

    /* Matched on what the shift *is* — service, start, end — not on its id.
       A draft copied from the published schedule holds new rows with new ids
       for the same slots, so comparing ids would find no shift in common and
       report that nothing had changed however much had. Same pairing problem
       the publication diff already solves, same answer. */
    const key = (a: ScheduleAssignment) =>
      `${a.serviceId}|${a.start.getTime()}|${a.end.getTime()}`;

    const before = new Map<string, string[]>();
    for (const a of baseline) {
      if (a.status === "cancelled") continue;
      const list = before.get(key(a)) ?? [];
      list.push(a.residentId ?? "");
      before.set(key(a), list);
    }

    const moved: ScheduleAssignment[] = [];
    const people = new Set<string>();
    let comparable = 0;

    /* Grouped, because several people can hold the same slot. Within a group
       the unchanged holders are matched off first, and whoever is left over
       is somebody whose shift moved. */
    const byKey = new Map<string, ScheduleAssignment[]>();
    for (const a of snapshot.assignments) {
      if (a.status === "cancelled") continue;
      const list = byKey.get(key(a)) ?? [];
      list.push(a);
      byKey.set(key(a), list);
    }

    for (const [slot, current] of byKey) {
      const previously = before.get(slot);
      if (!previously) continue; // A slot that did not exist before is an addition.
      comparable += Math.min(current.length, previously.length);

      const remaining = [...previously];
      const unmatched: ScheduleAssignment[] = [];
      for (const assignment of current) {
        const index = remaining.indexOf(assignment.residentId ?? "");
        if (index === -1) unmatched.push(assignment);
        else remaining.splice(index, 1);
      }
      for (const assignment of unmatched) {
        moved.push(assignment);
        if (assignment.residentId) people.add(assignment.residentId);
      }
      for (const previous of remaining) if (previous) people.add(previous);
    }

    if (moved.length === 0 || comparable === 0) return [];

    return [
      violation({
        constraintId: "minimise-change",
        kind: "soft",
        topic: "change",
        label: "Changes to the live schedule",
        message: `${plural(moved.length, "shift")} of the ${comparable} already published in this period would change hands, affecting ${plural(people.size, "person", "people")}.`,
        residentIds: [...people],
        shiftIds: moved.map((a) => a.shiftId),
        dates: [
          ...new Set(
            moved.map((a) => assignmentDate(a, snapshot.program.timezone)),
          ),
        ].sort(),
        penalty: Math.min(1, moved.length / comparable),
      }),
    ];
  },
};

export const SOFT_CONSTRAINTS: Constraint[] = [
  workloadFairness,
  nightBalance,
  weekendBalance,
  undesirableBalance,
  statedPreferences,
  continuity,
  cohortConsistency,
  serviceDistribution,
  minimiseChange,
];
