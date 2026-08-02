import { formatShiftDate, overlaps, restHoursBetween } from "@/server/domain/time";
import {
  APPROVAL_TRIGGERING_TYPES,
  evaluateRules,
} from "@/server/domain/rules/handlers";
import {
  RULE_CATEGORY,
  type ShiftInfo,
  type TradeContext,
  type TradeLegContext,
  type TradeValidationResult,
  type ValidationCheck,
} from "@/server/domain/rules/types";

/**
 * The authoritative trade validation service.
 *
 * `validateTrade` is pure: it takes a fully-materialised context and returns a
 * structured result. It is called when an offer is created, again when the
 * offer is accepted, and once more inside the finalisation transaction — so a
 * schedule that changed underneath a pending trade can never slip through.
 */

/**
 * "Mon, Aug 10 MICU". Mirrors the helper in `rules/handlers.ts` — every message
 * a resident reads names a day the way the rest of the product does, never as
 * the ISO string the comparison happens to use.
 */
function shiftName(shift: ShiftInfo, timezone: string): string {
  return `${formatShiftDate(shift.start, timezone)} ${shift.serviceName}`;
}

const STATUS_WEIGHT: Record<ValidationCheck["status"], number> = {
  fail: 0,
  warn: 1,
  pass: 2,
};

function systemCheck(
  key: string,
  category: ValidationCheck["category"],
  label: string,
  status: ValidationCheck["status"],
  message: string,
  extra: Partial<ValidationCheck> = {},
): ValidationCheck {
  return {
    key: `system:${key}`,
    ruleId: null,
    ruleType: `system.${key}`,
    category,
    label,
    status,
    message,
    overridable: false,
    ...extra,
  };
}

/** Structural checks that are always enforced, independent of program rules. */
function evaluateSystemChecks(context: TradeContext): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const legs = context.legs;

  // Distinct residents.
  const residentIds = new Set(legs.map((leg) => leg.resident.id));
  if (residentIds.size !== legs.length) {
    checks.push(
      systemCheck(
        "distinct_residents",
        RULE_CATEGORY.program,
        "Distinct residents",
        "fail",
        "A shift cannot be traded with yourself.",
      ),
    );
  } else {
    checks.push(
      systemCheck(
        "distinct_residents",
        RULE_CATEGORY.program,
        "Distinct residents",
        "pass",
        "Both residents are eligible participants.",
      ),
    );
  }

  for (const leg of legs) {
    const scope = { residentId: leg.resident.id, residentName: leg.resident.name };

    if (!leg.resident.active) {
      checks.push(
        systemCheck(
          `resident_active:${leg.resident.id}`,
          RULE_CATEGORY.safety,
          "Resident eligibility",
          "fail",
          `${leg.resident.name} is no longer an active resident in this program.`,
          scope,
        ),
      );
    } else {
      checks.push(
        systemCheck(
          `resident_active:${leg.resident.id}`,
          RULE_CATEGORY.safety,
          "Resident eligibility",
          "pass",
          `${leg.resident.name} is an active resident.`,
          scope,
        ),
      );
    }

    /* Nobody in two places at once.
     *
     * This was only ever a *configured* rule — `no_overlapping_shifts` — which
     * meant a programme that had not set it up had no overlap protection at
     * all. That is every programme on its first day, and every programme
     * onboarded through the marketplace-first path, which deliberately starts
     * with no services and no rules so that a resident can post a shift before
     * anybody configures anything.
     *
     * The integration suite caught it as an intermittent failure, because
     * whether a swap happens to double-book somebody depends on the generated
     * schedule: one resident ended up holding two different services from
     * 11:00 to 23:00 on the same day. Intermittent, but not a flake — the
     * product genuinely permitted it, and the only reason it did not happen
     * every run is that most pairs of shifts do not overlap.
     *
     * So it is a system check now: always evaluated, never overridable, and
     * not something a programme can forget to turn on. The configured rule
     * stays, because it can be scoped to a service or rotation and can carry a
     * programme's own wording; this is the floor beneath it. A chief override
     * cannot lift it either — an override is for policy, and being in two
     * places at once is not policy. */
    const clash = leg.proposedSchedule.find(
      (shift) =>
        shift.id !== leg.receives.id &&
        overlaps(shift.start, shift.end, leg.receives.start, leg.receives.end),
    );
    if (clash) {
      checks.push(
        systemCheck(
          /* The key carries the resident so two clashing legs produce two
             checks rather than one overwriting the other; `ruleType` stays
             stable so the check can still be found by kind. */
          `no_overlap:${leg.resident.id}`,
          RULE_CATEGORY.safety,
          "No overlapping shifts",
          "fail",
          /* No name prefix: both screens print the resident already, and the
             engine's messages are asserted not to stutter. */
          `Already on ${shiftName(clash, context.program.timezone)}, which overlaps ${shiftName(
            leg.receives,
            context.program.timezone,
          )}.`,
          { ...scope, ruleType: "system.no_overlap" },
        ),
      );
    }

    /* A leg with no `gives` is a resident taking a shift and giving nothing
       back, so there is one shift to check rather than two. Filtering here
       rather than guarding inside the loop keeps every check below written
       once, about "the shift in hand", whichever side it came from. */
    const sides: Array<readonly ["gives" | "receives", ShiftInfo]> = leg.gives
      ? [
          ["gives", leg.gives],
          ["receives", leg.receives],
        ]
      : [["receives", leg.receives]];

    for (const [role, shift] of sides) {
      if (shift.programId !== context.program.id) {
        checks.push(
          systemCheck(
            `same_program:${shift.id}`,
            RULE_CATEGORY.program,
            "Program match",
            "fail",
            leg.gives
              ? "Both shifts must belong to the same residency program."
              : "That shift belongs to a different residency program.",
            scope,
          ),
        );
      }
      if (shift.status === "cancelled" || shift.status === "completed") {
        checks.push(
          systemCheck(
            `shift_active:${shift.id}`,
            RULE_CATEGORY.safety,
            "Shift availability",
            "fail",
            `${shiftName(shift, context.program.timezone)} is no longer available (${shift.status}).`,
            scope,
          ),
        );
      }
      if (!shift.tradeable) {
        checks.push(
          systemCheck(
            `tradeable:${shift.id}`,
            RULE_CATEGORY.shift,
            "Shift is tradeable",
            "fail",
            `${shiftName(shift, context.program.timezone)} is marked non-tradeable by the program.`,
            scope,
          ),
        );
      }
      if (shift.tradeDeadline && shift.tradeDeadline.getTime() <= context.now.getTime()) {
        checks.push(
          systemCheck(
            `deadline:${shift.id}`,
            RULE_CATEGORY.shift,
            "Trade deadline",
            "fail",
            `The trade deadline for ${shiftName(shift, context.program.timezone)} has passed.`,
            scope,
          ),
        );
      }
      if (role === "receives" && restHoursBetween(context.now, shift.start) < 0) {
        checks.push(
          systemCheck(
            `in_past:${shift.id}`,
            RULE_CATEGORY.safety,
            "Shift is upcoming",
            "fail",
            `${shiftName(shift, context.program.timezone)} has already started.`,
            scope,
          ),
        );
      }
    }
  }

  const everyShiftTradeable = legs.every(
    (leg) => (leg.gives?.tradeable ?? true) && leg.receives.tradeable,
  );
  const oneWay = legs.every((leg) => leg.gives === null);
  if (everyShiftTradeable) {
    checks.push(
      systemCheck(
        "tradeable",
        RULE_CATEGORY.shift,
        "Shift is tradeable",
        "pass",
        /* "Both shifts are tradeable" is false rather than merely clumsy when
           there is one shift, and this string is shown to a resident. */
        oneWay ? "This shift can be given away." : "Both shifts are tradeable.",
      ),
    );
  }

  return checks;
}

export function sortChecks(checks: ValidationCheck[]): ValidationCheck[] {
  return [...checks].sort((a, b) => {
    if (STATUS_WEIGHT[a.status] !== STATUS_WEIGHT[b.status]) {
      return STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
    }
    if (a.category !== b.category) return a.category - b.category;
    return a.label.localeCompare(b.label);
  });
}

export function validateTrade(context: TradeContext): TradeValidationResult {
  const checks = sortChecks([
    ...evaluateSystemChecks(context),
    ...evaluateRules(context),
    /* Coverage comes from the constraint model, evaluated by whoever built the
       context — the same catalogue the generator is graded against and the
       scheduler's grid is coloured from. It arrives already decided so that
       this function stays pure. */
    ...(context.coverageChecks ?? []),
  ]);

  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");

  const approvalReasons: string[] = [];
  if (context.program.defaultTradeApprovalRequired) {
    approvalReasons.push("This program requires chief approval for every trade.");
  }
  for (const leg of context.legs) {
    for (const shift of leg.gives ? [leg.gives, leg.receives] : [leg.receives]) {
      if (shift.approvalRequired) {
        const reason = `${shiftName(shift, context.program.timezone)} requires chief approval.`;
        if (!approvalReasons.includes(reason)) approvalReasons.push(reason);
      }
    }
  }
  for (const warning of warnings) {
    if (APPROVAL_TRIGGERING_TYPES.has(warning.ruleType)) {
      if (!approvalReasons.includes(warning.message)) approvalReasons.push(warning.message);
    }
  }

  return {
    valid: failures.length === 0,
    requiresApproval: approvalReasons.length > 0,
    approvalReasons,
    checks,
    failures,
    warnings,
    ruleIds: Array.from(
      new Set(checks.map((check) => check.ruleId).filter((id): id is string => Boolean(id))),
    ),
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Builds the "after the trade" schedule for one leg: the resident's current
 * assignments, minus the shift they give away, plus the shift they receive.
 *
 * With no `gives`, nothing is removed — the resident keeps everything they had
 * and gains one more. That subtraction is the whole difference between the two
 * shapes, and it is why the safety rules matter so much more here: a switch
 * hands the rest and workload checks a schedule of unchanged size, and a
 * giveaway hands them a longer one.
 */
export function buildProposedSchedule(
  leg: Omit<TradeLegContext, "proposedSchedule">,
): TradeLegContext {
  const givenAway = leg.gives?.id;
  const proposed = leg.currentSchedule
    .filter((shift) => shift.id !== givenAway)
    .concat(leg.receives)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return { ...leg, proposedSchedule: proposed };
}

/** One-line summary for notifications and audit records. */
export function summariseValidation(result: TradeValidationResult): string {
  if (result.valid) {
    return result.requiresApproval
      ? "Valid — chief approval required"
      : "Valid — all checks passed";
  }
  return `Invalid — ${result.failures[0]?.message ?? "one or more checks failed"}`;
}
