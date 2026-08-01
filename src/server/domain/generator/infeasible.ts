import { CONSTRAINTS_BY_ID } from "@/server/domain/constraints/catalog";
import { dayFromIso } from "@/server/domain/constraints/shared";
import type { ScheduleSnapshot } from "@/server/domain/constraints/types";
import {
  dynamicRejection,
  emptyLoad,
  staticRejection,
  type Limits,
  type ResidentLoad,
} from "./feasibility";
import type { Relaxation, UnfilledSlot } from "./types";

/**
 * What would have to give.
 *
 * "No valid schedule exists" is true and useless. A chief holding an
 * unfillable month needs to know *which* rule to argue with, and what arguing
 * with it would buy — "drop the six-day limit to seven and eleven of these
 * fourteen holes close" is a decision somebody can take to a programme
 * director.
 *
 * ## How the smallest set is found
 *
 * The candidates are only the constraints that actually rejected somebody, and
 * in practice that is a handful. So: try each on its own, keep any that closes
 * every hole, and if none does, try pairs of the ones that helped most. Beyond
 * pairs it stops and reports the best partial answers rather than searching a
 * space whose size is exponential in a number nobody has bounded.
 *
 * This is a minimal-hitting-set search done honestly rather than a complete
 * one done slowly, and the difference is stated in the report: a relaxation
 * says how many slots it recovers, not that it is the only answer.
 */

/** Constraints a programme could actually choose to relax. */
const RELAXABLE = new Set([
  "rest-hours",
  "consecutive-days",
  "consecutive-nights",
  "workload-window",
  "weekend-window",
  "coverage-pgy-mix",
  "service-eligibility",
  "service-pgy-eligibility",
  "credential-eligibility",
  "block-structure",
  "site-eligibility",
  "blackout-dates",
]);

/**
 * Constraints that are facts about a person rather than policy.
 *
 * "Relax somebody's parental leave" is not a suggestion any tool should make.
 * These are reported as the blocker when they are one, and never proposed as
 * something to give up.
 */
const NOT_NEGOTIABLE = new Set([
  "resident-availability",
  "personal-unavailability",
  "service-exclusion",
  "block-override",
]);

function relaxedLimits(limits: Limits, relaxed: Set<string>): Limits {
  return {
    ...limits,
    restHours: relaxed.has("rest-hours") ? null : limits.restHours,
    maxConsecutiveDays: relaxed.has("consecutive-days") ? null : limits.maxConsecutiveDays,
    maxConsecutiveNights: relaxed.has("consecutive-nights")
      ? null
      : limits.maxConsecutiveNights,
    maxShifts: relaxed.has("workload-window") ? null : limits.maxShifts,
    maxWeekend: relaxed.has("weekend-window") ? null : limits.maxWeekend,
    blackoutDates: relaxed.has("blackout-dates") ? new Set() : limits.blackoutDates,
    servicePgy: relaxed.has("service-eligibility") ? new Map() : limits.servicePgy,
    serviceCredentials: relaxed.has("credential-eligibility")
      ? new Map()
      : limits.serviceCredentials,
    programCredentials: relaxed.has("credential-eligibility") ? [] : limits.programCredentials,
  };
}

/**
 * How many of the unfilled slots this relaxation would close.
 *
 * Deliberately optimistic: it asks whether *somebody* could take each slot with
 * the relaxation in force, one slot at a time, rather than re-running the whole
 * construction. A real run might still not place all of them, so the number is
 * an upper bound — which is the right direction for a suggestion. Being told
 * "this might close eleven" and finding it closes nine is a much better failure
 * than the reverse.
 */
function slotsRecovered(
  snapshot: ScheduleSnapshot,
  unfilled: UnfilledSlot[],
  limits: Limits,
  relaxed: Set<string>,
): number {
  const relaxedSet = relaxedLimits(limits, relaxed);
  const ignoreStatic = new Set(
    [...relaxed].filter((id) =>
      [
        "coverage-pgy-mix",
        "service-pgy-eligibility",
        "site-eligibility",
        "block-structure",
      ].includes(id),
    ),
  );

  let recovered = 0;
  for (const { slot } of unfilled) {
    const usable = snapshot.residents.some((resident) => {
      const stat = staticRejection(resident, slot, snapshot, relaxedSet);
      if (stat && !ignoreStatic.has(stat.constraintId)) return false;
      /* Judged against an empty load: this is "could anybody ever take it",
         not "is there room in this particular arrangement". */
      const load: ResidentLoad = emptyLoad();
      return !dynamicRejection(resident, slot, load, snapshot, relaxedSet);
    });
    if (usable) recovered += 1;
  }
  return recovered;
}

function label(constraintId: string): string {
  return CONSTRAINTS_BY_ID.get(constraintId)?.label ?? constraintId;
}

function sentence(constraintIds: string[], recovered: number, total: number): string {
  const names = constraintIds.map(label).join(" and ");
  const holes =
    recovered >= total
      ? `all ${total} of them`
      : `${recovered} of the ${total}`;
  return `Relaxing ${names} would let ${holes} be filled.`;
}

export function explainInfeasibility(
  snapshot: ScheduleSnapshot,
  unfilled: UnfilledSlot[],
  limits: Limits,
): Relaxation[] {
  const total = unfilled.length;
  const relaxations: Relaxation[] = [];

  /* Only the constraints that actually stopped somebody. A programme's rest
     rule is not the blocker if nobody was ever rejected for rest. */
  const implicated = new Set<string>();
  for (const entry of unfilled) {
    for (const rejection of entry.rejections) implicated.add(rejection.constraintId);
  }

  const blockedByFacts = [...implicated].filter((id) => NOT_NEGOTIABLE.has(id));
  const candidates = [...implicated].filter((id) => RELAXABLE.has(id)).sort();

  // Nobody at all, for reasons no rule change can fix.
  if (candidates.length === 0) {
    /* Two shapes of "there is nobody": a slot nobody was even considered for,
       and a slot where everybody who could take it is already standing in one
       of its other places. Both mean the programme is short of people rather
       than over-constrained by policy, and both deserve that sentence rather
       than a list of rules to argue with. */
    const slotsWithNobody = unfilled.filter(
      (entry) =>
        entry.rejections.length === 0 ||
        entry.rejections.every((r) => r.constraintId === "roster-capacity"),
    );
    if (slotsWithNobody.length > 0) {
      relaxations.push({
        constraintIds: [],
        message:
          `There is nobody on the roster who could take ${slotsWithNobody.length === total ? "any" : "some"} of these shifts. ` +
          "Either the programme needs more people available in this period, or the coverage requirements ask for more than it has.",
        slotsRecovered: 0,
      });
    }
    if (blockedByFacts.length > 0) {
      relaxations.push({
        /* Empty on purpose: `constraintIds` is "what to relax", and somebody's
           parental leave is not on that list. The blockers are named in the
           sentence instead. */
        constraintIds: [],
        message:
          `The people who could otherwise cover these shifts are unavailable — ${blockedByFacts
            .map(label)
            .join(", ")}. ` +
          "Those are facts about individuals rather than rules to relax; the schedule needs somebody else, or the requirement needs to change.",
        slotsRecovered: 0,
      });
    }
    return relaxations;
  }

  // --- One constraint at a time --------------------------------------------

  const singles = candidates
    .map((id) => ({
      id,
      recovered: slotsRecovered(snapshot, unfilled, limits, new Set([id])),
    }))
    .sort((a, b) => b.recovered - a.recovered || a.id.localeCompare(b.id));

  const complete = singles.filter((entry) => entry.recovered >= total);
  if (complete.length > 0) {
    for (const entry of complete.slice(0, 3)) {
      relaxations.push({
        constraintIds: [entry.id],
        message: sentence([entry.id], entry.recovered, total),
        slotsRecovered: entry.recovered,
      });
    }
    return relaxations;
  }

  // --- Pairs, from the ones that helped most --------------------------------

  const helpful = singles.filter((entry) => entry.recovered > 0).slice(0, 4);
  const pairs: Relaxation[] = [];
  for (let i = 0; i < helpful.length; i += 1) {
    for (let j = i + 1; j < helpful.length; j += 1) {
      const set = new Set([helpful[i].id, helpful[j].id]);
      const recovered = slotsRecovered(snapshot, unfilled, limits, set);
      if (recovered > Math.max(helpful[i].recovered, helpful[j].recovered)) {
        pairs.push({
          constraintIds: [...set].sort(),
          message: sentence([...set].sort(), recovered, total),
          slotsRecovered: recovered,
        });
      }
    }
  }
  pairs.sort(
    (a, b) =>
      b.slotsRecovered - a.slotsRecovered ||
      a.constraintIds.join().localeCompare(b.constraintIds.join()),
  );

  const best = pairs.find((pair) => pair.slotsRecovered >= total);
  if (best) return [best];

  /* Nothing closes every hole. Report the most useful partial answers, and say
     plainly that they are partial — a chief who relaxes a rule and finds four
     holes still open would rightly stop trusting this. */
  for (const entry of singles.slice(0, 2)) {
    if (entry.recovered === 0) continue;
    relaxations.push({
      constraintIds: [entry.id],
      message: sentence([entry.id], entry.recovered, total),
      slotsRecovered: entry.recovered,
    });
  }
  if (pairs.length > 0) relaxations.push(pairs[0]);

  if (relaxations.length === 0) {
    const dates = [...new Set(unfilled.map((entry) => entry.slot.date))].sort();
    relaxations.push({
      constraintIds: candidates,
      message:
        `No single rule change closes these ${total} gaps. The days involved are ` +
        `${dates.slice(0, 4).map(dayFromIso).join(", ")}${dates.length > 4 ? ` and ${dates.length - 4} more` : ""}. ` +
        "The programme needs more people available on those days, or fewer people required on them.",
      slotsRecovered: 0,
    });
  }

  return relaxations;
}
