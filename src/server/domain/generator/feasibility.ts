import type { RuleRow } from "@/server/db/types";
import { hardConstraintsOf } from "@/server/domain/constraints/person";
import { blockContaining, weekdayOfIso } from "@/server/domain/constraints/shared";
import type {
  ScheduleAssignment,
  ScheduleResident,
  ScheduleSnapshot,
} from "@/server/domain/constraints/types";
import {
  coveredLocalDates,
  isNightShift,
  isWeekendLocal,
  localDateString,
  longestConsecutiveRun,
  maxCountInRollingWindow,
  overlaps,
  restHoursBetween,
} from "@/server/domain/time";
import type { Slot } from "./types";

/**
 * Can this person take this slot, given everything they already hold?
 *
 * ## Why this exists when the validator already answers it
 *
 * The validator is the authority, and it is far too slow to ask two hundred
 * thousand times. Filling a month means considering every resident for every
 * slot, and each of those questions has to be answered in microseconds. So this
 * is a fast, incremental re-statement of the hard constraints, kept honest by
 * two things:
 *
 *   1. **It reads the programme's own numbers** — the rest hours, the
 *      consecutive-day limit, the rolling window — straight off the same `rules`
 *      rows the engine reads. There is one place a programme says "ten hours",
 *      and this is not a second one.
 *
 *   2. **It never has the last word.** Every generated schedule is handed to
 *      `validateSchedule` before it is emitted, and a run whose output has hard
 *      violations reports infeasibility and emits *nothing*. If this checker
 *      ever disagreed with the validator, the consequence would be a generator
 *      that fails loudly — never one that quietly produces an illegal month.
 *
 * `tests/unit/generator.test.ts` asserts the agreement directly: every schedule
 * the generator emits validates clean.
 */

export interface Limits {
  restHours: number | null;
  maxConsecutiveDays: number | null;
  maxConsecutiveNights: number | null;
  maxShifts: { count: number; windowDays: number } | null;
  maxWeekend: { count: number; windowDays: number } | null;
  noOverlap: boolean;
  blackoutDates: Set<string>;
  /** Service id -> the PGY levels a `service_requirement` rule allows. */
  servicePgy: Map<string, number[]>;
  /** Service id -> credentials a `credential_requirement` rule demands. */
  serviceCredentials: Map<string, string[]>;
  programCredentials: string[];
  /** Whether a `pgy_requirement` rule is configured at all. */
  enforceShiftPgy: boolean;
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strings(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The programme's configured numbers, read once.
 *
 * Only rules the programme actually created apply. A limit nobody configured is
 * `null` and is not enforced — inventing a default here would mean the
 * generator refusing schedules the validator would happily pass.
 */
export function readLimits(rules: RuleRow[]): Limits {
  const limits: Limits = {
    restHours: null,
    maxConsecutiveDays: null,
    maxConsecutiveNights: null,
    maxShifts: null,
    maxWeekend: null,
    noOverlap: false,
    blackoutDates: new Set(),
    servicePgy: new Map(),
    serviceCredentials: new Map(),
    programCredentials: [],
    enforceShiftPgy: false,
  };

  for (const rule of rules) {
    if (!rule.active) continue;
    /* A rule the programme configured as a warning is one it has said a
       schedule may break. The generator honours that: it is not entitled to
       refuse a schedule the validator would call valid. */
    if (rule.severity === "warning") continue;

    switch (rule.rule_type) {
      case "min_rest_hours":
        limits.restHours = num(rule.params, "hours", 10);
        break;
      case "max_consecutive_shifts":
        limits.maxConsecutiveDays = num(rule.params, "days", 6);
        break;
      case "max_consecutive_nights":
        limits.maxConsecutiveNights = num(rule.params, "nights", 4);
        break;
      case "max_shifts_in_period":
        limits.maxShifts = {
          count: num(rule.params, "maxShifts", 24),
          windowDays: num(rule.params, "windowDays", 28),
        };
        break;
      case "weekend_limit":
        limits.maxWeekend = {
          count: num(rule.params, "maxWeekendShifts", 4),
          windowDays: num(rule.params, "windowDays", 28),
        };
        break;
      case "no_overlapping_shifts":
        limits.noOverlap = true;
        break;
      case "blackout_dates":
        for (const date of strings(rule.params, "dates")) {
          limits.blackoutDates.add(date);
        }
        break;
      case "service_requirement": {
        const allowed = Array.isArray(rule.params.allowedPgy)
          ? (rule.params.allowedPgy as number[])
          : [];
        if (rule.scope_id && allowed.length > 0) {
          limits.servicePgy.set(rule.scope_id, allowed);
        }
        break;
      }
      case "credential_requirement": {
        const required = strings(rule.params, "credentials");
        if (required.length === 0) break;
        if (rule.scope === "service" && rule.scope_id) {
          limits.serviceCredentials.set(rule.scope_id, required);
        } else if (rule.scope === "program") {
          limits.programCredentials = required;
        }
        break;
      }
      case "pgy_requirement":
        limits.enforceShiftPgy = true;
        break;
    }
  }

  return limits;
}

/** What a resident already holds, in the shape the checks need. */
export interface ResidentLoad {
  assignments: ScheduleAssignment[];
  /** Local dates covered, for the consecutive-day run. */
  dates: string[];
  nightDates: string[];
  weekendStarts: Date[];
  /** Services worked, per block id, for block-structure and continuity. */
  servicesByBlock: Map<string, Set<string>>;
}

export function emptyLoad(): ResidentLoad {
  return {
    assignments: [],
    dates: [],
    nightDates: [],
    weekendStarts: [],
    servicesByBlock: new Map(),
  };
}

export function addToLoad(
  load: ResidentLoad,
  assignment: ScheduleAssignment,
  snapshot: ScheduleSnapshot,
): void {
  const zone = snapshot.program.timezone;
  load.assignments.push(assignment);
  load.dates.push(...coveredLocalDates(assignment.start, assignment.end, zone));
  if (isNightShift(assignment.start, assignment.end, zone)) {
    load.nightDates.push(localDateString(assignment.start, zone));
  }
  if (isWeekendLocal(assignment.start, zone)) load.weekendStarts.push(assignment.start);

  const block = blockContaining(snapshot.blocks, localDateString(assignment.start, zone));
  if (block) {
    const services = load.servicesByBlock.get(block.id) ?? new Set<string>();
    services.add(assignment.serviceId);
    load.servicesByBlock.set(block.id, services);
  }
}

/**
 * Facts about a person that no assignment can change.
 *
 * Checked once per (resident, slot) rather than per candidate move: a resident
 * on leave on the 4th is on leave on the 4th however the rest of the month is
 * arranged.
 */
export function staticRejection(
  resident: ScheduleResident,
  slot: Slot,
  snapshot: ScheduleSnapshot,
  limits: Limits,
): { constraintId: string; reason: string } | null {
  if (!resident.active) {
    return {
      constraintId: "resident-availability",
      reason: `${resident.name} has left the programme.`,
    };
  }
  if (!resident.schedulable) {
    const note = resident.schedulingNotes.trim().replace(/[.]+$/, "");
    return {
      constraintId: "resident-availability",
      reason: note
        ? `${resident.name} is not available to schedule — ${note}.`
        : `${resident.name} is marked as not available to schedule.`,
    };
  }

  const personal = hardConstraintsOf(resident);
  if (personal.unavailableDates.includes(slot.date)) {
    return {
      constraintId: "personal-unavailability",
      reason: `${resident.name} is recorded as unavailable that day.`,
    };
  }
  if (personal.unavailableWeekdays.includes(weekdayOfIso(slot.date))) {
    return {
      constraintId: "personal-unavailability",
      reason: `${resident.name} cannot work that weekday.`,
    };
  }
  if (personal.excludedServiceIds.includes(slot.serviceId)) {
    return {
      constraintId: "service-exclusion",
      reason: `${resident.name} cannot be assigned to ${slot.serviceName}.`,
    };
  }
  if (slot.siteId) {
    if (
      resident.siteEligibility[slot.siteId] === false ||
      personal.excludedSiteIds.includes(slot.siteId)
    ) {
      return {
        constraintId: "site-eligibility",
        reason: `${resident.name} is not cleared to work that site.`,
      };
    }
  }

  if (slot.requiredPgy !== null && resident.pgyLevel !== slot.requiredPgy) {
    return {
      constraintId: "coverage-pgy-mix",
      reason: `${slot.serviceName} needs a PGY-${slot.requiredPgy} in this place, and ${resident.name} is a PGY-${resident.pgyLevel}.`,
    };
  }
  if (
    (slot.servicePgyMin != null && resident.pgyLevel < slot.servicePgyMin) ||
    (slot.servicePgyMax != null && resident.pgyLevel > slot.servicePgyMax)
  ) {
    return {
      constraintId: "service-pgy-eligibility",
      reason: `${slot.serviceName} is not open to a PGY-${resident.pgyLevel}.`,
    };
  }

  const allowed = limits.servicePgy.get(slot.serviceId);
  if (allowed && !allowed.includes(resident.pgyLevel)) {
    return {
      constraintId: "service-eligibility",
      reason: `${slot.serviceName} is limited to PGY ${allowed.join(", ")}.`,
    };
  }

  const credentials = [
    ...limits.programCredentials,
    ...(limits.serviceCredentials.get(slot.serviceId) ?? []),
  ];
  const missing = credentials.filter((c) => !resident.credentials.includes(c));
  if (missing.length > 0) {
    return {
      constraintId: "credential-eligibility",
      reason: `${slot.serviceName} requires ${missing.join(" and ")}, which ${resident.name} does not have on file.`,
    };
  }

  if (limits.blackoutDates.has(slot.date)) {
    return {
      constraintId: "blackout-dates",
      reason: "That day is a blackout date — nobody may be scheduled on it.",
    };
  }

  /* The block year: a cohort assigned to Clinic for this block does not staff
     the MICU, and an individual exception replaces the cohort's answer. */
  const block = blockContaining(snapshot.blocks, slot.date);
  if (block) {
    const override = snapshot.overrides.find(
      (o) => o.residentId === resident.id && o.blockId === block.id,
    );
    if (override?.serviceId && override.serviceId !== slot.serviceId) {
      return {
        constraintId: "block-override",
        reason: `${resident.name} is recorded as on another service for ${block.label} — ${override.reason}`,
      };
    }
    if (!override && resident.cohortId) {
      const planned = snapshot.blockAssignments.find(
        (a) => a.cohortId === resident.cohortId && a.blockId === block.id,
      );
      if (planned?.serviceId && planned.serviceId !== slot.serviceId) {
        return {
          constraintId: "block-structure",
          reason: `${resident.cohortLabel ?? "Their cohort"} is on another service for ${block.label}.`,
        };
      }
    }
  }

  return null;
}

/**
 * Facts that depend on what the resident has already been given.
 *
 * Re-checked on every candidate move, so it is deliberately arithmetic over
 * small arrays rather than anything clever.
 */
export function dynamicRejection(
  resident: ScheduleResident,
  slot: Slot,
  load: ResidentLoad,
  snapshot: ScheduleSnapshot,
  limits: Limits,
): { constraintId: string; reason: string } | null {
  const zone = snapshot.program.timezone;

  if (limits.noOverlap) {
    for (const held of load.assignments) {
      if (overlaps(held.start, held.end, slot.start, slot.end)) {
        return {
          constraintId: "overlapping-assignments",
          reason: `${resident.name} already works something that overlaps it.`,
        };
      }
    }
  }

  if (limits.restHours !== null) {
    for (const held of load.assignments) {
      const gap =
        held.end <= slot.start
          ? restHoursBetween(held.end, slot.start)
          : held.start >= slot.end
            ? restHoursBetween(slot.end, held.start)
            : -1;
      if (gap < limits.restHours) {
        return {
          constraintId: "rest-hours",
          reason: `${resident.name} would have under ${limits.restHours} hours off either side of it.`,
        };
      }
    }
  }

  if (limits.maxConsecutiveDays !== null) {
    const dates = [...load.dates, ...coveredLocalDates(slot.start, slot.end, zone)];
    if (longestConsecutiveRun(dates) > limits.maxConsecutiveDays) {
      return {
        constraintId: "consecutive-days",
        reason: `${resident.name} would work more than ${limits.maxConsecutiveDays} days in a row.`,
      };
    }
  }

  if (limits.maxConsecutiveNights !== null && isNightShift(slot.start, slot.end, zone)) {
    const nights = [...load.nightDates, localDateString(slot.start, zone)];
    if (longestConsecutiveRun(nights) > limits.maxConsecutiveNights) {
      return {
        constraintId: "consecutive-nights",
        reason: `${resident.name} would work more than ${limits.maxConsecutiveNights} nights in a row.`,
      };
    }
  }

  if (limits.maxShifts) {
    const starts = [...load.assignments.map((a) => a.start), slot.start];
    if (maxCountInRollingWindow(starts, limits.maxShifts.windowDays) > limits.maxShifts.count) {
      return {
        constraintId: "workload-window",
        reason: `${resident.name} would go over ${limits.maxShifts.count} shifts in ${limits.maxShifts.windowDays} days.`,
      };
    }
  }

  if (limits.maxWeekend && isWeekendLocal(slot.start, zone)) {
    const starts = [...load.weekendStarts, slot.start];
    if (
      maxCountInRollingWindow(starts, limits.maxWeekend.windowDays) > limits.maxWeekend.count
    ) {
      return {
        constraintId: "weekend-window",
        reason: `${resident.name} would go over ${limits.maxWeekend.count} weekend shifts in ${limits.maxWeekend.windowDays} days.`,
      };
    }
  }

  return null;
}
