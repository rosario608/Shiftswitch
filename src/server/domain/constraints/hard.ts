import { effectiveMinimum, requirementsFor } from "@/server/domain/coverage";
import { zonedWallTimeToInstant } from "@/server/domain/time";
import { hardConstraintsOf } from "./person";
import { runRuleType, type RuleVerdict } from "./rule-bridge";
import {
  assignmentDate,
  blockContaining,
  datesInPeriod,
  day,
  dayFromIso,
  hours,
  plural,
  shiftLabel,
  staffedAssignments,
  violation,
  weekdayOfIso,
} from "./shared";
import type {
  Constraint,
  ConstraintTopic,
  ScheduleAssignment,
  ScheduleSnapshot,
  Violation,
} from "./types";

/**
 * The hard constraints: a schedule that violates one of these is wrong.
 *
 * Not "worse". Wrong — somebody is scheduled who cannot work, or a service
 * that must be covered is not, or a person is in two places at once. Publishing
 * a schedule with a hard violation in it puts a clinical gap on a ward, so the
 * validator's job is to name every one of them before anybody presses publish.
 */

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Which assignments count towards a requirement on a date.
 *
 * A shift counts on the day it *starts*. An overnight shift beginning Monday
 * 19:00 covers part of Tuesday, but every programme that writes it down calls
 * it Monday's night shift, and counting it towards both days would make a
 * service look staffed on a morning nobody is there.
 *
 * When a requirement names a time band, the shift's start has to fall inside
 * it — that is how one service asks for two people by day and one at night.
 */
function countsToward(
  assignment: ScheduleAssignment,
  requirement: { start_time: string | null; end_time: string | null },
  iso: string,
  timezone: string,
): boolean {
  if (assignmentDate(assignment, timezone) !== iso) return false;
  if (!requirement.start_time || !requirement.end_time) return true;

  const startsAt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(assignment.start);
  const from = requirement.start_time.slice(0, 5);
  const to = requirement.end_time.slice(0, 5);
  /* A band that wraps midnight — 19:00 to 07:00 — is one band, not two. */
  return from <= to
    ? startsAt >= from && startsAt < to
    : startsAt >= from || startsAt < to;
}

function bandLabel(requirement: {
  start_time: string | null;
  end_time: string | null;
  label: string;
}): string {
  if (requirement.label) return ` (${requirement.label})`;
  if (requirement.start_time && requirement.end_time) {
    return ` (${requirement.start_time.slice(0, 5)}–${requirement.end_time.slice(0, 5)})`;
  }
  return "";
}

/** Every (date, requirement) pair in the window, with what is actually on it. */
function* coverageCells(snapshot: ScheduleSnapshot) {
  const services = new Map(snapshot.services.map((s) => [s.id, s]));
  const active = snapshot.coverage.filter((r) => r.active);

  /* Bucketed by service and day once, rather than filtering every assignment
     for every (date, requirement) pair. A month barely notices the
     difference; a year of a large programme is 365 days × twenty requirements
     × several thousand assignments, and the naive scan turns a validation
     into a visible wait on a screen with a spinner. */
  const byServiceDay = new Map<string, ScheduleAssignment[]>();
  for (const assignment of staffedAssignments(snapshot)) {
    const key = `${assignment.serviceId}|${assignmentDate(assignment, snapshot.program.timezone)}`;
    const list = byServiceDay.get(key);
    if (list) list.push(assignment);
    else byServiceDay.set(key, [assignment]);
  }

  for (const iso of datesInPeriod(snapshot.period)) {
    /* `requirementsFor` takes an instant so it can resolve the programme's
       local weekday. Local noon is the one time of day that is the same
       calendar date in every timezone. */
    let instant: Date;
    try {
      instant = zonedWallTimeToInstant(iso, "12:00", snapshot.program.timezone);
    } catch {
      continue; // A date that does not exist locally has nothing to cover.
    }

    for (const requirement of requirementsFor(
      active,
      instant,
      snapshot.program.timezone,
    )) {
      const service = services.get(requirement.service_id);
      if (!service || !service.active) continue;
      /* Only the requirement's own time band still needs testing per cell —
         the day and the service came from the bucket key. */
      const present = (
        byServiceDay.get(`${requirement.service_id}|${iso}`) ?? []
      ).filter((a) => countsToward(a, requirement, iso, snapshot.program.timezone));
      /* Counted as *people*, not as rows. One resident holding two of the
         three places a service needs is one person on that service, and a
         requirement that counted them twice would report a ward as staffed
         when two of its three places are empty. Found by the generator, which
         happily satisfied a three-person minimum with one person three times
         over on a programme that had configured no overlap rule. */
      const people = new Set(present.map((a) => a.residentId));
      yield { iso, requirement, service, present, distinct: people.size };
    }
  }
}

const coverageMinimum: Constraint = {
  id: "coverage-minimum",
  kind: "hard",
  topic: "coverage",
  label: "Coverage minimum",
  description:
    "Every service has at least the number of people its coverage requirement asks for, on every day the requirement applies.",
  evaluate: (snapshot) => {
    const violations: Violation[] = [];
    for (const { iso, requirement, service, present, distinct } of coverageCells(snapshot)) {
      const needed = effectiveMinimum(requirement);
      if (needed === 0 || distinct >= needed) continue;
      violations.push(
        violation({
          constraintId: "coverage-minimum",
          kind: "hard",
          topic: "coverage",
          label: "Coverage minimum",
          message:
            `${dayFromIso(iso)}: ${service.name}` +
            `${bandLabel(requirement)} has ${plural(distinct, "person", "people")} ` +
            `and needs ${needed}.`,
          serviceIds: [service.id],
          shiftIds: present.map((a) => a.shiftId),
          residentIds: present.flatMap((a) => (a.residentId ? [a.residentId] : [])),
          dates: [iso],
        }),
      );
    }
    return violations;
  },
};

const coverageMaximum: Constraint = {
  id: "coverage-maximum",
  kind: "hard",
  topic: "coverage",
  label: "Coverage maximum",
  description:
    "No service is staffed above the cap its coverage requirement sets, so people are not spent where they are not needed.",
  evaluate: (snapshot) => {
    const violations: Violation[] = [];
    for (const { iso, requirement, service, present, distinct } of coverageCells(snapshot)) {
      const cap = requirement.max_staff;
      if (cap == null || distinct <= cap) continue;
      violations.push(
        violation({
          constraintId: "coverage-maximum",
          kind: "hard",
          topic: "coverage",
          label: "Coverage maximum",
          message:
            `${dayFromIso(iso)}: ${service.name}` +
            `${bandLabel(requirement)} has ${plural(distinct, "person", "people")} ` +
            `and is capped at ${cap}.`,
          serviceIds: [service.id],
          shiftIds: present.map((a) => a.shiftId),
          residentIds: present.flatMap((a) => (a.residentId ? [a.residentId] : [])),
          dates: [iso],
        }),
      );
    }
    return violations;
  },
};

const coveragePgyMix: Constraint = {
  id: "coverage-pgy-mix",
  kind: "hard",
  topic: "coverage",
  label: "PGY mix",
  description:
    "Where a requirement asks for particular training levels — a senior on overnight, say — the people on the service actually include them.",
  evaluate: (snapshot) => {
    const violations: Violation[] = [];
    const pgyOf = new Map(snapshot.residents.map((r) => [r.id, r.pgyLevel]));

    for (const { iso, requirement, service, present } of coverageCells(snapshot)) {
      for (const entry of requirement.pgy_mix) {
        const atLevel = present.filter(
          (a) => a.residentId && pgyOf.get(a.residentId) === entry.pgy,
        );
        const atLevelPeople = new Set(atLevel.map((a) => a.residentId)).size;
        const problem =
          atLevelPeople < entry.min
            ? `has ${plural(atLevelPeople, `PGY-${entry.pgy}`)} and needs at least ${entry.min}`
            : entry.max != null && atLevelPeople > entry.max
              ? `has ${plural(atLevelPeople, `PGY-${entry.pgy}`)} and allows at most ${entry.max}`
              : null;
        if (!problem) continue;

        violations.push(
          violation({
            constraintId: "coverage-pgy-mix",
            kind: "hard",
            topic: "coverage",
            label: "PGY mix",
            message:
              `${dayFromIso(iso)}: ${service.name}` +
              `${bandLabel(requirement)} ${problem}.`,
            serviceIds: [service.id],
            shiftIds: present.map((a) => a.shiftId),
            residentIds: atLevel.flatMap((a) => (a.residentId ? [a.residentId] : [])),
            dates: [iso],
          }),
        );
      }
    }
    return violations;
  },
};

const shiftUnstaffed: Constraint = {
  id: "shift-unstaffed",
  kind: "hard",
  topic: "coverage",
  label: "Nobody on the shift",
  description:
    "Every shift on a service that must be covered has somebody on it. A shift with nobody is the gap this product exists to prevent.",
  evaluate: (snapshot) => {
    const mandatory = new Set(
      snapshot.services.filter((s) => s.coverageMandatory).map((s) => s.id),
    );
    return snapshot.assignments
      .filter(
        (a) =>
          a.residentId === null &&
          a.status !== "cancelled" &&
          mandatory.has(a.serviceId),
      )
      .map((a) =>
        violation({
          constraintId: "shift-unstaffed",
          kind: "hard",
          topic: "coverage",
          label: "Nobody on the shift",
          message: `${shiftLabel(a, snapshot.program.timezone)} has nobody on it, and ${a.serviceName} has to be covered.`,
          serviceIds: [a.serviceId],
          shiftIds: [a.shiftId],
          dates: [assignmentDate(a, snapshot.program.timezone)],
        }),
      );
  },
};

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const residentAvailability: Constraint = {
  id: "resident-availability",
  kind: "hard",
  topic: "availability",
  label: "Available to schedule",
  description:
    "Nobody is scheduled who has left the programme or is marked as not available — on leave, on research, or not yet started.",
  evaluate: (snapshot) => {
    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));
    return staffedAssignments(snapshot).flatMap((a) => {
      const resident = byId.get(a.residentId!);
      if (!resident) return [];
      if (resident.active && resident.schedulable) return [];
      /* The note is free text somebody typed, and about half of them end in a
         full stop. Trimmed, because the sentence supplies its own and
         "on parental leave.." is the kind of detail that makes a report look
         machine-generated. */
      const note = resident.schedulingNotes.trim().replace(/[.。]+$/, "");
      const reason = !resident.active
        ? "has left the programme"
        : note
          ? `is not available to schedule — ${note}`
          : "is marked as not available to schedule";
      return [
        violation({
          constraintId: "resident-availability",
          kind: "hard",
          topic: "availability",
          label: "Available to schedule",
          message: `${shiftLabel(a, snapshot.program.timezone)} is assigned to ${resident.name}, who ${reason}.`,
          residentIds: [resident.id],
          serviceIds: [a.serviceId],
          shiftIds: [a.shiftId],
          dates: [assignmentDate(a, snapshot.program.timezone)],
        }),
      ];
    });
  },
};

const personalUnavailability: Constraint = {
  id: "personal-unavailability",
  kind: "hard",
  topic: "availability",
  label: "Recorded unavailability",
  description:
    "Days somebody cannot work — agreed leave, or a standing commitment like a weekday of religious observance — are respected.",
  evaluate: (snapshot) => {
    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));
    return staffedAssignments(snapshot).flatMap((a) => {
      const resident = byId.get(a.residentId!);
      if (!resident) return [];
      const personal = hardConstraintsOf(resident);
      const date = assignmentDate(a, snapshot.program.timezone);

      if (personal.unavailableDates.includes(date)) {
        return [
          violation({
            constraintId: "personal-unavailability",
            kind: "hard",
            topic: "availability",
            label: "Recorded unavailability",
            message: `${resident.name} is recorded as unavailable on ${day(a.start, snapshot.program.timezone)} and is scheduled for ${a.serviceName}.`,
            residentIds: [resident.id],
            serviceIds: [a.serviceId],
            shiftIds: [a.shiftId],
            dates: [date],
          }),
        ];
      }

      const weekday = weekdayOfIso(date);
      if (personal.unavailableWeekdays.includes(weekday)) {
        return [
          violation({
            constraintId: "personal-unavailability",
            kind: "hard",
            topic: "availability",
            label: "Recorded unavailability",
            message: `${resident.name} cannot work ${WEEKDAY_NAMES[weekday]}s and is scheduled for ${a.serviceName} on ${day(a.start, snapshot.program.timezone)}.`,
            residentIds: [resident.id],
            serviceIds: [a.serviceId],
            shiftIds: [a.shiftId],
            dates: [date],
          }),
        ];
      }
      return [];
    });
  },
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

const serviceLevelEligibility: Constraint = {
  id: "service-pgy-eligibility",
  kind: "hard",
  topic: "eligibility",
  label: "Service training level",
  description:
    "Nobody covers a service outside the training levels it is configured for.",
  evaluate: (snapshot) => {
    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));
    const services = new Map(snapshot.services.map((s) => [s.id, s]));

    return staffedAssignments(snapshot).flatMap((a) => {
      const resident = byId.get(a.residentId!);
      const service = services.get(a.serviceId);
      if (!resident || !service) return [];
      const min = service.pgyMin;
      const max = service.pgyMax;
      const belowFloor = min != null && resident.pgyLevel < min;
      const aboveCeiling = max != null && resident.pgyLevel > max;
      if (!belowFloor && !aboveCeiling) return [];

      const range =
        min != null && max != null
          ? min === max
            ? `PGY-${min}`
            : `PGY-${min} to PGY-${max}`
          : min != null
            ? `PGY-${min} and above`
            : `PGY-${max} and below`;

      return [
        violation({
          constraintId: "service-pgy-eligibility",
          kind: "hard",
          topic: "eligibility",
          label: "Service training level",
          message: `${shiftLabel(a, snapshot.program.timezone)} is assigned to ${resident.name}, a PGY-${resident.pgyLevel}. ${service.name} is for ${range}.`,
          residentIds: [resident.id],
          serviceIds: [service.id],
          shiftIds: [a.shiftId],
          dates: [assignmentDate(a, snapshot.program.timezone)],
        }),
      ];
    });
  },
};

const siteEligibility: Constraint = {
  id: "site-eligibility",
  kind: "hard",
  topic: "eligibility",
  label: "Site eligibility",
  description:
    "Nobody is scheduled at a site they are not credentialed for. A site with nothing recorded is unrestricted.",
  evaluate: (snapshot) => {
    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));
    return staffedAssignments(snapshot).flatMap((a) => {
      const resident = byId.get(a.residentId!);
      if (!resident || !a.siteId) return [];
      const personal = hardConstraintsOf(resident);
      const recorded = resident.siteEligibility[a.siteId];
      const blocked = recorded === false || personal.excludedSiteIds.includes(a.siteId);
      if (!blocked) return [];

      return [
        violation({
          constraintId: "site-eligibility",
          kind: "hard",
          topic: "eligibility",
          label: "Site eligibility",
          message: `${resident.name} is not cleared to work at ${a.siteName ?? "that site"} and is scheduled for ${shiftLabel(a, snapshot.program.timezone)} there.`,
          residentIds: [resident.id],
          serviceIds: [a.serviceId],
          shiftIds: [a.shiftId],
          dates: [assignmentDate(a, snapshot.program.timezone)],
        }),
      ];
    });
  },
};

const excludedService: Constraint = {
  id: "service-exclusion",
  kind: "hard",
  topic: "eligibility",
  label: "Service exclusion",
  description:
    "Services somebody cannot be assigned to at all — an accommodation, or a rotation they have already been excused from.",
  evaluate: (snapshot) => {
    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));
    return staffedAssignments(snapshot).flatMap((a) => {
      const resident = byId.get(a.residentId!);
      if (!resident) return [];
      if (!hardConstraintsOf(resident).excludedServiceIds.includes(a.serviceId)) {
        return [];
      }
      return [
        violation({
          constraintId: "service-exclusion",
          kind: "hard",
          topic: "eligibility",
          label: "Service exclusion",
          message: `${resident.name} is recorded as not able to work ${a.serviceName}, and is on it ${day(a.start, snapshot.program.timezone)}.`,
          residentIds: [resident.id],
          serviceIds: [a.serviceId],
          shiftIds: [a.shiftId],
          dates: [assignmentDate(a, snapshot.program.timezone)],
        }),
      ];
    });
  },
};

// ---------------------------------------------------------------------------
// Structure: what the block year says people should be doing
// ---------------------------------------------------------------------------

const blockStructure: Constraint = {
  id: "block-structure",
  kind: "hard",
  topic: "structure",
  label: "Block assignment",
  description:
    "People work the service their cohort is assigned to for that block. This is how a programme expresses which rotations somebody has to do.",
  evaluate: (snapshot) => {
    if (snapshot.blocks.length === 0 || snapshot.blockAssignments.length === 0) {
      return [];
    }
    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));
    const overrideKey = new Set(
      snapshot.overrides.map((o) => `${o.residentId}:${o.blockId}`),
    );
    const expected = new Map(
      snapshot.blockAssignments.map((a) => [`${a.cohortId}:${a.blockId}`, a]),
    );

    /* One violation per resident per block, not per shift: a resident on the
       wrong service for a four-week block is one mistake, and reporting it
       twenty times would bury everything else. */
    const seen = new Set<string>();
    const violations: Violation[] = [];

    for (const a of staffedAssignments(snapshot)) {
      const resident = byId.get(a.residentId!);
      if (!resident || !resident.cohortId) continue;
      const date = assignmentDate(a, snapshot.program.timezone);
      const block = blockContaining(snapshot.blocks, date);
      if (!block) continue;

      // An individual override replaces the cohort's answer for that block.
      if (overrideKey.has(`${resident.id}:${block.id}`)) continue;

      const planned = expected.get(`${resident.cohortId}:${block.id}`);
      if (!planned || !planned.serviceId) continue;
      if (planned.serviceId === a.serviceId) continue;

      const key = `${resident.id}:${block.id}:${a.serviceId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const plannedName =
        snapshot.services.find((s) => s.id === planned.serviceId)?.name ??
        "another service";
      violations.push(
        violation({
          constraintId: "block-structure",
          kind: "hard",
          topic: "structure",
          label: "Block assignment",
          message: `In ${block.label}, ${resident.cohortLabel ?? "their cohort"} is on ${plannedName}, but ${resident.name} is scheduled for ${a.serviceName} — first on ${day(a.start, snapshot.program.timezone)}.`,
          residentIds: [resident.id],
          serviceIds: [a.serviceId, planned.serviceId],
          shiftIds: [a.shiftId],
          dates: [date],
        }),
      );
    }
    return violations;
  },
};

const blockOverrideHonoured: Constraint = {
  id: "block-override",
  kind: "hard",
  topic: "structure",
  label: "Recorded exception",
  description:
    "Where somebody has been given a different block from their cohort — a make-up block, research, an away elective — the schedule actually reflects it.",
  evaluate: (snapshot) => {
    if (snapshot.blocks.length === 0) return [];
    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));
    const blocks = new Map(snapshot.blocks.map((b) => [b.id, b]));
    const violations: Violation[] = [];

    for (const override of snapshot.overrides) {
      if (!override.serviceId) continue; // A label-only exception says nothing checkable.
      const block = blocks.get(override.blockId);
      const resident = byId.get(override.residentId);
      if (!block || !resident) continue;

      /* Only judged when the block is inside the window under test. A draft
         covering August cannot be wrong about November. */
      if (block.endDate < snapshot.period.start || block.startDate > snapshot.period.end) {
        continue;
      }

      const worked = staffedAssignments(snapshot).filter((a) => {
        if (a.residentId !== override.residentId) return false;
        const date = assignmentDate(a, snapshot.program.timezone);
        return date >= block.startDate && date <= block.endDate;
      });
      if (worked.length === 0) continue; // Nothing scheduled yet is not yet wrong.
      if (worked.some((a) => a.serviceId === override.serviceId)) continue;

      const expectedName =
        snapshot.services.find((s) => s.id === override.serviceId)?.name ??
        "the service recorded";
      violations.push(
        violation({
          constraintId: "block-override",
          kind: "hard",
          topic: "structure",
          label: "Recorded exception",
          message: `${resident.name} is recorded as on ${expectedName} for ${block.label} — ${override.reason} — but is not scheduled for it in that block.`,
          residentIds: [resident.id],
          serviceIds: [override.serviceId],
          shiftIds: worked.map((a) => a.shiftId),
          dates: [block.startDate],
        }),
      );
    }
    return violations;
  },
};

// ---------------------------------------------------------------------------
// Blackout dates
// ---------------------------------------------------------------------------

/**
 * The one constraint that reads a rule's parameters without calling its
 * handler.
 *
 * `blackout_dates` configures *which dates* are protected, and that is exactly
 * the configuration a schedule has to respect. But the handler's sentence says
 * shifts on that day "cannot be traded", which is a claim about trading and
 * would be misleading on a validation report. The dates are the programme's;
 * the sentence is this constraint's.
 */
const blackoutDates: Constraint = {
  id: "blackout-dates",
  kind: "hard",
  topic: "structure",
  label: "Blackout dates",
  description:
    "Nobody is scheduled on a date the programme has protected.",
  evaluate: (snapshot) => {
    const blocked = new Set<string>();
    for (const rule of snapshot.rules) {
      if (rule.rule_type !== "blackout_dates" || !rule.active) continue;
      const dates = rule.params.dates;
      if (!Array.isArray(dates)) continue;
      for (const date of dates) if (typeof date === "string") blocked.add(date);
    }
    if (blocked.size === 0) return [];

    const byId = new Map(snapshot.residents.map((r) => [r.id, r]));
    return staffedAssignments(snapshot).flatMap((a) => {
      const date = assignmentDate(a, snapshot.program.timezone);
      if (!blocked.has(date)) return [];
      const resident = byId.get(a.residentId!);
      return [
        violation({
          constraintId: "blackout-dates",
          kind: "hard",
          topic: "structure",
          label: "Blackout dates",
          message: `${day(a.start, snapshot.program.timezone)} is a blackout date at ${snapshot.program.name}, and ${resident?.name ?? "somebody"} is scheduled for ${a.serviceName}.`,
          residentIds: resident ? [resident.id] : [],
          serviceIds: [a.serviceId],
          shiftIds: [a.shiftId],
          dates: [date],
        }),
      ];
    });
  },
};

// ---------------------------------------------------------------------------
// The rules engine's constraints, asked about a schedule
// ---------------------------------------------------------------------------

/**
 * Builds a constraint that delegates to a configured rule.
 *
 * The rule decides *whether* — with the programme's own numbers, evaluated by
 * the code that already evaluates it for trades. This decides how to say it,
 * because the rule's sentence is written for somebody about to make a switch
 * and this reader is looking at a schedule that already exists.
 *
 * A rule the programme configured as a warning produces a **soft** violation:
 * the programme has said a schedule breaking it is still publishable, and the
 * validator is not entitled to overrule that. It is still reported.
 */
function fromRule(options: {
  id: string;
  ruleType: string;
  scope: "per-assignment" | "per-resident";
  topic: ConstraintTopic;
  label: string;
  description: string;
  say: (verdict: RuleVerdict, snapshot: ScheduleSnapshot) => string;
}): Constraint {
  return {
    id: options.id,
    kind: "hard",
    topic: options.topic,
    label: options.label,
    description: options.description,
    weight: 1,
    evaluate: (snapshot) =>
      runRuleType(snapshot, options.ruleType, options.scope).map((verdict) =>
        violation({
          constraintId: options.id,
          kind: verdict.status === "warn" ? "soft" : "hard",
          topic: options.topic,
          label: options.label,
          message: options.say(verdict, snapshot),
          ruleId: verdict.rule.id,
          residentIds: [verdict.resident.id],
          serviceIds: verdict.assignment ? [verdict.assignment.serviceId] : [],
          shiftIds: verdict.assignment ? [verdict.assignment.shiftId] : [],
          dates: verdict.assignment
            ? [assignmentDate(verdict.assignment, snapshot.program.timezone)]
            : [],
          penalty: verdict.status === "warn" ? 1 : undefined,
        }),
      ),
  };
}

/** "6 hours" out of the rule's own detail, or a fallback that says nothing false. */
function detailValue(verdict: RuleVerdict, key: "required" | "available"): string {
  return verdict.detail?.[key] ?? "the configured limit";
}

const restHours = fromRule({
  id: "rest-hours",
  ruleType: "min_rest_hours",
  scope: "per-assignment",
  topic: "safety",
  label: "Rest between shifts",
  description:
    "Everybody gets the hours off between shifts the programme requires. Evaluated by the same rule that governs trades.",
  say: (verdict, snapshot) =>
    `${verdict.resident.name} has ${detailValue(verdict, "available")} between ` +
    `${verdict.assignment ? shiftLabel(verdict.assignment, snapshot.program.timezone) : "two shifts"} ` +
    `and the shift beside it. The programme requires ${detailValue(verdict, "required")}.`,
});

const consecutiveDays = fromRule({
  id: "consecutive-days",
  ruleType: "max_consecutive_shifts",
  scope: "per-resident",
  topic: "workload",
  label: "Days in a row",
  description:
    "Nobody works more consecutive days than the programme allows.",
  say: (verdict) =>
    `${verdict.resident.name} works ${detailValue(verdict, "available")} in this schedule. ` +
    `The programme's limit is ${detailValue(verdict, "required")}.`,
});

const consecutiveNights = fromRule({
  id: "consecutive-nights",
  ruleType: "max_consecutive_nights",
  scope: "per-resident",
  topic: "workload",
  label: "Nights in a row",
  description: "Nobody works more consecutive nights than the programme allows.",
  say: (verdict) =>
    `${verdict.resident.name} works ${detailValue(verdict, "available")} in this schedule. ` +
    `The programme's limit is ${detailValue(verdict, "required")}.`,
});

const workloadWindow = fromRule({
  id: "workload-window",
  ruleType: "max_shifts_in_period",
  scope: "per-resident",
  topic: "workload",
  label: "Shifts in a window",
  description:
    "Nobody exceeds the programme's cap on shifts within a rolling window of days.",
  say: (verdict) =>
    `${verdict.resident.name} has ${detailValue(verdict, "available")} in one rolling window. ` +
    `The programme's cap is ${detailValue(verdict, "required")}.`,
});

const weekendWindow = fromRule({
  id: "weekend-window",
  ruleType: "weekend_limit",
  scope: "per-resident",
  topic: "workload",
  label: "Weekends in a window",
  description:
    "Nobody exceeds the programme's cap on weekend shifts within a rolling window.",
  say: (verdict) =>
    `${verdict.resident.name} has ${detailValue(verdict, "available")} in one rolling window. ` +
    `The programme's cap is ${detailValue(verdict, "required")}.`,
});

const overlappingAssignments = fromRule({
  id: "overlapping-assignments",
  ruleType: "no_overlapping_shifts",
  scope: "per-assignment",
  topic: "safety",
  label: "Overlapping shifts",
  description: "Nobody is in two places at once.",
  say: (verdict, snapshot) =>
    `${verdict.resident.name} is on ` +
    `${verdict.assignment ? shiftLabel(verdict.assignment, snapshot.program.timezone) : "a shift"} ` +
    `and another shift that overlaps it.`,
});

const shiftPgyEligibility = fromRule({
  id: "shift-pgy-eligibility",
  ruleType: "pgy_requirement",
  scope: "per-assignment",
  topic: "eligibility",
  label: "Shift training level",
  description:
    "Every shift is held by somebody within the training range that shift is for.",
  say: (verdict, snapshot) =>
    `${verdict.assignment ? shiftLabel(verdict.assignment, snapshot.program.timezone) : "A shift"} ` +
    `is for ${detailValue(verdict, "required")} and is assigned to ${verdict.resident.name}, ` +
    `a ${detailValue(verdict, "available")}.`,
});

const serviceEligibility = fromRule({
  id: "service-eligibility",
  ruleType: "service_requirement",
  scope: "per-assignment",
  topic: "eligibility",
  label: "Service eligibility",
  description:
    "Services restricted to particular training levels are covered only by them.",
  say: (verdict, snapshot) =>
    `${verdict.assignment?.serviceName ?? "That service"} is limited to ` +
    `${detailValue(verdict, "required")}, and ${verdict.resident.name} ` +
    `(${detailValue(verdict, "available")}) is on it ` +
    `${verdict.assignment ? day(verdict.assignment.start, snapshot.program.timezone) : ""}`.trim() +
    ".",
});

const credentialEligibility = fromRule({
  id: "credential-eligibility",
  ruleType: "credential_requirement",
  scope: "per-assignment",
  topic: "eligibility",
  label: "Credentials",
  description:
    "Services requiring a credential are covered only by people who hold it.",
  say: (verdict, snapshot) =>
    `${verdict.assignment?.serviceName ?? "That service"} requires ` +
    `${detailValue(verdict, "required")}, and ${verdict.resident.name} has ` +
    `${detailValue(verdict, "available")} on file — scheduled ` +
    `${verdict.assignment ? day(verdict.assignment.start, snapshot.program.timezone) : ""}`.trim() +
    ".",
});

export const HARD_CONSTRAINTS: Constraint[] = [
  coverageMinimum,
  coverageMaximum,
  coveragePgyMix,
  shiftUnstaffed,
  residentAvailability,
  personalUnavailability,
  serviceLevelEligibility,
  shiftPgyEligibility,
  serviceEligibility,
  credentialEligibility,
  siteEligibility,
  excludedService,
  blockStructure,
  blockOverrideHonoured,
  blackoutDates,
  overlappingAssignments,
  restHours,
  consecutiveDays,
  consecutiveNights,
  workloadWindow,
  weekendWindow,
];

/** Exported for the message-property tests, which need `hours`/`plural` too. */
export const __testing = { hours, plural };
