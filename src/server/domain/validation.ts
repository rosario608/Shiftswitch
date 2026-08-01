import { formatShiftDate, restHoursBetween } from "@/server/domain/time";
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

    for (const [role, shift] of [
      ["gives", leg.gives],
      ["receives", leg.receives],
    ] as const) {
      if (shift.programId !== context.program.id) {
        checks.push(
          systemCheck(
            `same_program:${shift.id}`,
            RULE_CATEGORY.program,
            "Program match",
            "fail",
            "Both shifts must belong to the same residency program.",
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

  const bothTradeable = legs.every((leg) => leg.gives.tradeable && leg.receives.tradeable);
  if (bothTradeable) {
    checks.push(
      systemCheck(
        "tradeable",
        RULE_CATEGORY.shift,
        "Shift is tradeable",
        "pass",
        "Both shifts are tradeable.",
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
    for (const shift of [leg.gives, leg.receives]) {
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
 */
export function buildProposedSchedule(
  leg: Omit<TradeLegContext, "proposedSchedule">,
): TradeLegContext {
  const proposed = leg.currentSchedule
    .filter((shift) => shift.id !== leg.gives.id)
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
