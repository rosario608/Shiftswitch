import type { RuleRow } from "@/server/db/types";
import {
  coveredLocalDates,
  formatShiftDate,
  isNightShift,
  isWeekendLocal,
  localDateString,
  longestConsecutiveRun,
  maxCountInRollingWindow,
  overlaps,
  restHoursBetween,
} from "@/server/domain/time";
import {
  RULE_CATEGORY,
  type RuleHandler,
  type ShiftInfo,
  type TradeContext,
  type TradeLegContext,
  type ValidationCheck,
} from "./types";

/**
 * Configurable rule handlers.
 *
 * Adding a new rule type means adding one entry here plus a row in the `rules`
 * table — no change to the trade workflow, the API, or the UI is required.
 */

function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strings(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function bool(params: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

function scopeApplies(rule: RuleRow, leg: TradeLegContext): boolean {
  switch (rule.scope) {
    case "program":
      return true;
    case "service":
      return (
        leg.gives.serviceId === rule.scope_id ||
        leg.receives.serviceId === rule.scope_id
      );
    case "rotation":
      return (
        leg.gives.rotationId === rule.scope_id ||
        leg.receives.rotationId === rule.scope_id
      );
    case "shift":
      return leg.gives.id === rule.scope_id || leg.receives.id === rule.scope_id;
    default:
      return true;
  }
}

function baseCheck(
  rule: RuleRow,
  handler: Pick<RuleHandler, "category" | "label" | "type">,
  leg: TradeLegContext | null,
  status: ValidationCheck["status"],
  message: string,
  detail?: ValidationCheck["detail"],
): ValidationCheck {
  return {
    key: `rule:${rule.id}${leg ? `:${leg.resident.id}` : ""}`,
    ruleId: rule.id,
    ruleType: handler.type,
    category: handler.category,
    label: rule.name || handler.label,
    status,
    message,
    residentId: leg?.resident.id,
    residentName: leg?.resident.name,
    detail,
    overridable: rule.overridable,
  };
}

function hours(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A date a resident can read.
 *
 * `ShiftInfo.date` is an ISO day string — "2026-08-10" — which is the right
 * value to compare against and the wrong one to show anybody. Six rule messages
 * interpolated it directly, so a resident who could not offer on a shift was
 * told "2026-08-10 is a blackout date". Everywhere else in the product the same
 * day reads "Mon, Aug 10", and it should here too.
 */
function shiftDay(shift: ShiftInfo, timezone: string): string {
  return formatShiftDate(shift.start, timezone);
}

/** "Mon, Aug 10 MICU" — how a resident refers to a shift in conversation. */
function shiftName(shift: ShiftInfo, timezone: string): string {
  return `${shiftDay(shift, timezone)} ${shift.serviceName}`;
}

/**
 * A note on the voice of these messages.
 *
 * They do not begin with the resident's name. Both surfaces that render a check
 * — the offer sheet a resident sees and the chief's approvals queue — already
 * print `residentName` in front of the message themselves, so a message that
 * also opened with it produced "Jordan Rivera: Jordan Rivera would work too many
 * consecutive days."
 *
 * They also state the numbers. `detail.required`/`detail.available` are only
 * rendered on the approvals page, so a resident who was blocked read "would
 * work too many consecutive days" and was never told how many, or what the
 * limit was — which is precisely the information needed to decide what to offer
 * instead. The detail fields stay, for the chief's denser view; the sentence no
 * longer depends on them.
 */

// ---------------------------------------------------------------------------
// 1. Safety / coverage
// ---------------------------------------------------------------------------

const minRest: RuleHandler = {
  type: "min_rest_hours",
  label: "Minimum rest between shifts",
  description:
    "Requires a minimum number of hours off between the end of one shift and the start of the next.",
  category: RULE_CATEGORY.safety,
  summarise: (params) => `At least ${num(params, "hours", 10)} hours between shifts`,
  evaluate: (rule, context) => {
    const required = num(rule.params, "hours", 10);
    return context.legs.filter((leg) => scopeApplies(rule, leg)).map((leg) => {
      const incoming = leg.receives;
      let worst = Number.POSITIVE_INFINITY;
      let worstNeighbour: ShiftInfo | null = null;
      for (const shift of leg.proposedSchedule) {
        if (shift.id === incoming.id) continue;
        const gap =
          shift.end <= incoming.start
            ? restHoursBetween(shift.end, incoming.start)
            : shift.start >= incoming.end
              ? restHoursBetween(incoming.end, shift.start)
              : -1;
        if (gap < worst) {
          worst = gap;
          worstNeighbour = shift;
        }
      }
      if (!worstNeighbour || worst === Number.POSITIVE_INFINITY) {
        return baseCheck(rule, minRest, leg, "pass", `Required rest maintained (no adjacent shift).`);
      }
      if (worst < required) {
        return baseCheck(
          rule,
          minRest,
          leg,
          rule.severity === "warning" ? "warn" : "fail",
          `This would leave only ${hours(Math.max(worst, 0))} between this shift and ${shiftName(
            worstNeighbour,
            context.program.timezone,
          )}. The program requires ${hours(required)}.`,
          { required: hours(required), available: hours(Math.max(worst, 0)) },
        );
      }
      return baseCheck(rule, minRest, leg, "pass", `Required rest maintained (${hours(worst)} available).`);
    });
  },
};

const maxConsecutiveShifts: RuleHandler = {
  type: "max_consecutive_shifts",
  label: "Maximum consecutive shifts",
  description: "Limits the number of consecutive calendar days a resident may work.",
  category: RULE_CATEGORY.safety,
  summarise: (params) => `No more than ${num(params, "days", 6)} days in a row`,
  evaluate: (rule, context) => {
    const limit = num(rule.params, "days", 6);
    return context.legs.filter((leg) => scopeApplies(rule, leg)).map((leg) => {
      const dates = leg.proposedSchedule.flatMap((shift) =>
        coveredLocalDates(shift.start, shift.end, context.program.timezone),
      );
      const run = longestConsecutiveRun(dates);
      if (run > limit) {
        return baseCheck(
          rule,
          maxConsecutiveShifts,
          leg,
          rule.severity === "warning" ? "warn" : "fail",
          `This would mean working ${plural(run, "day")} in a row. The program's limit is ${plural(
            limit,
            "day",
          )}.`,
          { required: `${limit} days maximum`, available: `${run} days in a row` },
        );
      }
      return baseCheck(
        rule,
        maxConsecutiveShifts,
        leg,
        "pass",
        `Maximum consecutive shifts maintained (${run} of ${limit}).`,
      );
    });
  },
};

const maxConsecutiveNights: RuleHandler = {
  type: "max_consecutive_nights",
  label: "Maximum consecutive nights",
  description: "Limits the number of consecutive night shifts.",
  category: RULE_CATEGORY.safety,
  summarise: (params) => `No more than ${num(params, "nights", 4)} nights in a row`,
  evaluate: (rule, context) => {
    const limit = num(rule.params, "nights", 4);
    return context.legs.filter((leg) => scopeApplies(rule, leg)).map((leg) => {
      const nightDates = leg.proposedSchedule
        .filter((shift) => isNightShift(shift.start, shift.end, context.program.timezone))
        .map((shift) => localDateString(shift.start, context.program.timezone));
      const run = longestConsecutiveRun(nightDates);
      if (run > limit) {
        return baseCheck(
          rule,
          maxConsecutiveNights,
          leg,
          rule.severity === "warning" ? "warn" : "fail",
          `This would mean working ${plural(run, "night")} in a row. The program's limit is ${plural(
            limit,
            "night",
          )}.`,
          { required: `${limit} nights maximum`, available: `${run} nights in a row` },
        );
      }
      return baseCheck(
        rule,
        maxConsecutiveNights,
        leg,
        "pass",
        `Consecutive night limit maintained (${run} of ${limit}).`,
      );
    });
  },
};

const maxShiftsInPeriod: RuleHandler = {
  type: "max_shifts_in_period",
  label: "Maximum shifts per period",
  description: "Limits the number of shifts within a rolling window of days.",
  category: RULE_CATEGORY.safety,
  summarise: (params) =>
    `No more than ${num(params, "maxShifts", 24)} shifts in any ${num(params, "windowDays", 28)} days`,
  evaluate: (rule, context) => {
    const maxShifts = num(rule.params, "maxShifts", 24);
    const windowDays = num(rule.params, "windowDays", 28);
    return context.legs.filter((leg) => scopeApplies(rule, leg)).map((leg) => {
      const count = maxCountInRollingWindow(
        leg.proposedSchedule.map((shift) => shift.start),
        windowDays,
      );
      if (count > maxShifts) {
        return baseCheck(
          rule,
          maxShiftsInPeriod,
          leg,
          rule.severity === "warning" ? "warn" : "fail",
          `This would mean ${plural(count, "shift")} in a ${windowDays}-day stretch. The program's cap is ${plural(
            maxShifts,
            "shift",
          )}.`,
          { required: `${maxShifts} shifts`, available: `${count} shifts` },
        );
      }
      return baseCheck(
        rule,
        maxShiftsInPeriod,
        leg,
        "pass",
        `Workload cap maintained (${count} of ${maxShifts} per ${windowDays} days).`,
      );
    });
  },
};

const noOverlap: RuleHandler = {
  type: "no_overlapping_shifts",
  label: "No overlapping shifts",
  description: "A resident may not be assigned to two shifts that overlap in time.",
  category: RULE_CATEGORY.safety,
  summarise: () => "A resident cannot hold two overlapping shifts",
  evaluate: (rule, context) =>
    context.legs.filter((leg) => scopeApplies(rule, leg)).map((leg) => {
      const incoming = leg.receives;
      const clash = leg.proposedSchedule.find(
        (shift) =>
          shift.id !== incoming.id &&
          overlaps(shift.start, shift.end, incoming.start, incoming.end),
      );
      if (clash) {
        return baseCheck(
          rule,
          noOverlap,
          leg,
          "fail",
          `Already assigned to ${shiftName(
            clash,
            context.program.timezone,
          )}, which overlaps this shift.`,
        );
      }
      return baseCheck(rule, noOverlap, leg, "pass", "No schedule conflict.");
    }),
};

// ---------------------------------------------------------------------------
// 2. Program-level policy
// ---------------------------------------------------------------------------

const minNotice: RuleHandler = {
  type: "min_notice_hours",
  label: "Minimum notice",
  description: "Shifts starting sooner than this may not be traded.",
  category: RULE_CATEGORY.program,
  summarise: (params) => `Trades must be completed at least ${num(params, "hours", 24)} hours before the shift`,
  evaluate: (rule, context) => {
    const required = num(rule.params, "hours", 24);
    const checks: ValidationCheck[] = [];
    for (const leg of context.legs) {
      if (!scopeApplies(rule, leg)) continue;
      const noticeHours = restHoursBetween(context.now, leg.receives.start);
      if (noticeHours < required) {
        checks.push(
          baseCheck(
            rule,
            minNotice,
            leg,
            rule.severity === "warning" ? "warn" : "fail",
            `${shiftName(leg.receives, context.program.timezone)} starts in ${hours(
              Math.max(noticeHours, 0),
            )}. This program stops trades ${hours(required)} before a shift.`,
            { required: hours(required), available: hours(Math.max(noticeHours, 0)) },
          ),
        );
      } else {
        checks.push(
          baseCheck(rule, minNotice, leg, "pass", `Minimum notice satisfied (${hours(noticeHours)}).`),
        );
      }
    }
    return checks;
  },
};

const blackoutDates: RuleHandler = {
  type: "blackout_dates",
  label: "Blackout dates",
  description: "Shifts on these dates may not be traded.",
  category: RULE_CATEGORY.program,
  summarise: (params) => {
    const dates = strings(params, "dates");
    return dates.length ? `No trades on ${dates.join(", ")}` : "No blackout dates configured";
  },
  evaluate: (rule, context) => {
    const dates = new Set(strings(rule.params, "dates"));
    if (dates.size === 0) return [];
    const checks: ValidationCheck[] = [];
    for (const leg of context.legs) {
      if (!scopeApplies(rule, leg)) continue;
      const blocked = [leg.gives, leg.receives].find((shift) =>
        coveredLocalDates(shift.start, shift.end, context.program.timezone).some((d) =>
          dates.has(d),
        ),
      );
      if (blocked) {
        checks.push(
          baseCheck(
            rule,
            blackoutDates,
            leg,
            rule.severity === "warning" ? "warn" : "fail",
            `${shiftDay(blocked, context.program.timezone)} is a blackout date at ${
              context.program.name
            }, so shifts on that day cannot be traded.`,
          ),
        );
      } else {
        checks.push(baseCheck(rule, blackoutDates, leg, "pass", "No blackout dates involved."));
      }
    }
    return checks;
  },
};

const holidayRestriction: RuleHandler = {
  type: "holiday_restriction",
  label: "Holiday shifts",
  description: "Controls whether holiday shifts can be traded, and whether approval is required.",
  category: RULE_CATEGORY.program,
  summarise: (params) => {
    const mode = (params.mode as string) ?? "approval";
    const dates = strings(params, "dates");
    if (dates.length === 0) return "No holiday dates configured — this rule does nothing";
    return `${plural(dates.length, "holiday date")}, ${
      mode === "block" ? "not tradeable" : "chief approval required"
    }`;
  },
  evaluate: (rule, context) => {
    const dates = new Set(strings(rule.params, "dates"));
    const mode = (rule.params.mode as string) ?? "approval";
    if (dates.size === 0) return [];
    const checks: ValidationCheck[] = [];
    for (const leg of context.legs) {
      if (!scopeApplies(rule, leg)) continue;
      const holiday = [leg.gives, leg.receives].find((shift) =>
        coveredLocalDates(shift.start, shift.end, context.program.timezone).some((d) =>
          dates.has(d),
        ),
      );
      if (holiday) {
        checks.push(
          baseCheck(
            rule,
            holidayRestriction,
            leg,
            mode === "block" ? "fail" : "warn",
            mode === "block"
              ? `${shiftName(holiday, context.program.timezone)} falls on a holiday, and this program does not allow holiday shifts to be traded.`
              : `${shiftName(holiday, context.program.timezone)} falls on a holiday, so a chief resident has to approve this switch.`,
          ),
        );
      } else {
        checks.push(baseCheck(rule, holidayRestriction, leg, "pass", "No holiday shifts involved."));
      }
    }
    return checks;
  },
};

const weekendLimit: RuleHandler = {
  type: "weekend_limit",
  label: "Weekend limit",
  description: "Limits the number of weekend shifts within a rolling window.",
  category: RULE_CATEGORY.program,
  summarise: (params) =>
    `No more than ${num(params, "maxWeekendShifts", 4)} weekend shifts in ${num(params, "windowDays", 28)} days`,
  evaluate: (rule, context) => {
    const maxWeekend = num(rule.params, "maxWeekendShifts", 4);
    const windowDays = num(rule.params, "windowDays", 28);
    return context.legs.filter((leg) => scopeApplies(rule, leg)).map((leg) => {
      const weekendStarts = leg.proposedSchedule
        .filter((shift) => isWeekendLocal(shift.start, context.program.timezone))
        .map((shift) => shift.start);
      const count = maxCountInRollingWindow(weekendStarts, windowDays);
      if (count > maxWeekend) {
        return baseCheck(
          rule,
          weekendLimit,
          leg,
          rule.severity === "warning" ? "warn" : "fail",
          `This would mean ${plural(count, "weekend shift")} in a ${windowDays}-day stretch. The program's limit is ${plural(
            maxWeekend,
            "weekend shift",
          )}.`,
          { required: `${maxWeekend} weekend shifts`, available: `${count} weekend shifts` },
        );
      }
      return baseCheck(
        rule,
        weekendLimit,
        leg,
        "pass",
        `Weekend limit maintained (${count} of ${maxWeekend}).`,
      );
    });
  },
};

const maxTradesPerMonth: RuleHandler = {
  type: "max_trades_per_month",
  label: "Maximum trades per month",
  description: "Limits how many completed trades a resident may have in a calendar month.",
  category: RULE_CATEGORY.program,
  summarise: (params) => `No more than ${num(params, "maxTrades", 6)} completed trades per month`,
  evaluate: (rule, context) => {
    const limit = num(rule.params, "maxTrades", 6);
    return context.legs.filter((leg) => scopeApplies(rule, leg)).map((leg) => {
      if (leg.completedTradesThisMonth >= limit) {
        return baseCheck(
          rule,
          maxTradesPerMonth,
          leg,
          rule.severity === "warning" ? "warn" : "fail",
          `Already completed ${plural(
            leg.completedTradesThisMonth,
            "switch",
            "switches",
          )} this month. The program allows ${plural(limit, "switch", "switches")}.`,
          { required: `${limit} trades`, available: `${leg.completedTradesThisMonth} already completed` },
        );
      }
      return baseCheck(
        rule,
        maxTradesPerMonth,
        leg,
        "pass",
        `Monthly trade limit maintained (${leg.completedTradesThisMonth} of ${limit}).`,
      );
    });
  },
};

const maxOpenPickups: RuleHandler = {
  type: "max_open_pickups",
  label: "Maximum open offers",
  description: "Limits how many pending offers a resident may have outstanding.",
  category: RULE_CATEGORY.program,
  summarise: (params) => `No more than ${num(params, "maxOpenOffers", 5)} pending offers at once`,
  evaluate: (rule, context) => {
    const limit = num(rule.params, "maxOpenOffers", 5);
    return context.legs.filter((leg) => scopeApplies(rule, leg)).map((leg) => {
      if (leg.openOffers > limit) {
        return baseCheck(
          rule,
          maxOpenPickups,
          leg,
          rule.severity === "warning" ? "warn" : "fail",
          `Already has ${plural(
            leg.openOffers,
            "offer",
          )} waiting on a decision, and the program allows ${limit} at a time. Withdraw one before making another.`,
          { required: `${limit} pending offers`, available: `${leg.openOffers} pending` },
        );
      }
      return baseCheck(rule, maxOpenPickups, leg, "pass", "Pending offer limit maintained.");
    });
  },
};

// ---------------------------------------------------------------------------
// 3. Service / rotation
// ---------------------------------------------------------------------------

const nonTradeableService: RuleHandler = {
  type: "non_tradeable_service",
  label: "Non-tradeable services",
  description: "Shifts on these services may never be traded.",
  category: RULE_CATEGORY.service,
  summarise: (params) => {
    const count = strings(params, "serviceIds").length;
    return count === 0
      ? "No services configured — this rule does nothing"
      : `${plural(count, "service")} cannot be traded`;
  },
  evaluate: (rule, context) => {
    const blocked = new Set(strings(rule.params, "serviceIds"));
    if (blocked.size === 0) return [];
    const checks: ValidationCheck[] = [];
    for (const leg of context.legs) {
      const offending = [leg.gives, leg.receives].find((shift) => blocked.has(shift.serviceId));
      if (offending) {
        checks.push(
          baseCheck(
            rule,
            nonTradeableService,
            leg,
            "fail",
            `${offending.serviceName} shifts cannot be traded.`,
          ),
        );
      } else {
        checks.push(
          baseCheck(rule, nonTradeableService, leg, "pass", "Both services allow trading."),
        );
      }
    }
    return checks;
  },
};

const serviceRequirement: RuleHandler = {
  type: "service_requirement",
  label: "Service eligibility",
  description: "Restricts which PGY levels may cover a service.",
  category: RULE_CATEGORY.service,
  summarise: (params) => {
    const allowed = (params.allowedPgy as number[]) ?? [];
    return allowed.length
      ? `Only PGY ${allowed.join(", ")} may cover this service`
      : "No PGY levels configured — this rule does nothing";
  },
  evaluate: (rule, context) => {
    const allowed = Array.isArray(rule.params.allowedPgy)
      ? (rule.params.allowedPgy as number[])
      : [];
    if (allowed.length === 0 || !rule.scope_id) return [];
    const checks: ValidationCheck[] = [];
    for (const leg of context.legs) {
      if (leg.receives.serviceId !== rule.scope_id) continue;
      if (!allowed.includes(leg.resident.pgyLevel)) {
        checks.push(
          baseCheck(
            rule,
            serviceRequirement,
            leg,
            "fail",
            `${leg.receives.serviceName} is limited to PGY ${allowed.join(
              ", ",
            )} at this program, not PGY-${leg.resident.pgyLevel}.`,
            { required: `PGY ${allowed.join(", ")}`, available: `PGY-${leg.resident.pgyLevel}` },
          ),
        );
      } else {
        checks.push(
          baseCheck(
            rule,
            serviceRequirement,
            leg,
            "pass",
            `Service requirements satisfied for ${leg.receives.serviceName}.`,
          ),
        );
      }
    }
    return checks;
  },
};

const credentialRequirement: RuleHandler = {
  type: "credential_requirement",
  label: "Credential requirement",
  description: "Requires specific credentials to cover a service or rotation.",
  category: RULE_CATEGORY.service,
  summarise: (params) => {
    const creds = strings(params, "credentials");
    return creds.length ? `Requires ${creds.join(", ")}` : "No credentials required";
  },
  evaluate: (rule, context) => {
    const required = strings(rule.params, "credentials");
    if (required.length === 0) return [];
    const checks: ValidationCheck[] = [];
    for (const leg of context.legs) {
      const applies =
        rule.scope === "program" ||
        (rule.scope === "service" && leg.receives.serviceId === rule.scope_id) ||
        (rule.scope === "rotation" && leg.receives.rotationId === rule.scope_id) ||
        (rule.scope === "shift" && leg.receives.id === rule.scope_id);
      if (!applies) continue;
      const missing = required.filter((c) => !leg.resident.credentials.includes(c));
      if (missing.length > 0) {
        checks.push(
          baseCheck(
            rule,
            credentialRequirement,
            leg,
            "fail",
            `${leg.receives.serviceName} requires ${required.join(
              ", ",
            )}. Missing ${missing.join(" and ")}.`,
            { required: required.join(", "), available: leg.resident.credentials.join(", ") || "none on file" },
          ),
        );
      } else {
        checks.push(
          baseCheck(rule, credentialRequirement, leg, "pass", "Credential requirements satisfied."),
        );
      }
    }
    return checks;
  },
};

// ---------------------------------------------------------------------------
// 4. Shift-level
// ---------------------------------------------------------------------------

const pgyRequirement: RuleHandler = {
  type: "pgy_requirement",
  label: "PGY requirements",
  description:
    "Enforces each shift's PGY range and, optionally, a maximum PGY difference between the two residents.",
  category: RULE_CATEGORY.shift,
  summarise: (params) => {
    const maxDelta = params.maxPgyDifference;
    return typeof maxDelta === "number"
      ? `Shift PGY range enforced; PGY difference at most ${maxDelta}`
      : "Shift PGY range enforced";
  },
  evaluate: (rule, context) => {
    const checks: ValidationCheck[] = [];
    for (const leg of context.legs) {
      const shift = leg.receives;
      const pgy = leg.resident.pgyLevel;
      if (pgy < shift.requiredPgyMin || pgy > shift.requiredPgyMax) {
        checks.push(
          baseCheck(
            rule,
            pgyRequirement,
            leg,
            "fail",
            `${shiftName(shift, context.program.timezone)} is for PGY-${shift.requiredPgyMin}${
              shift.requiredPgyMax !== shift.requiredPgyMin
                ? ` to PGY-${shift.requiredPgyMax}`
                : ""
            }, not PGY-${pgy}.`,
            {
              required: `PGY-${shift.requiredPgyMin}${
                shift.requiredPgyMax !== shift.requiredPgyMin ? ` to PGY-${shift.requiredPgyMax}` : ""
              }`,
              available: `PGY-${pgy}`,
            },
          ),
        );
      } else {
        checks.push(
          baseCheck(rule, pgyRequirement, leg, "pass", "PGY requirements satisfied."),
        );
      }
    }
    const maxDelta = rule.params.maxPgyDifference;
    if (typeof maxDelta === "number" && context.legs.length === 2) {
      const [a, b] = context.legs;
      const delta = Math.abs(a.resident.pgyLevel - b.resident.pgyLevel);
      checks.push(
        baseCheck(
          rule,
          pgyRequirement,
          null,
          delta > maxDelta ? (rule.severity === "warning" ? "warn" : "fail") : "pass",
          delta > maxDelta
            ? `The PGY difference between residents (PGY-${a.resident.pgyLevel} and PGY-${b.resident.pgyLevel}) is larger than this program allows.`
            : `PGY levels are compatible (difference of ${delta}).`,
          delta > maxDelta
            ? { required: `at most ${maxDelta}`, available: `${delta}` }
            : undefined,
        ),
      );
    }
    return checks;
  },
};

const approvalRequirement: RuleHandler = {
  type: "approval_required",
  label: "Approval policy",
  description: "Determines when a chief resident must approve a trade.",
  category: RULE_CATEGORY.shift,
  summarise: (params) => {
    const parts: string[] = [];
    if (bool(params, "always")) parts.push("always");
    if (bool(params, "whenServiceDiffers")) parts.push("when services differ");
    if (bool(params, "whenPgyDiffers")) parts.push("when PGY levels differ");
    const withinHours = params.whenWithinHours;
    if (typeof withinHours === "number") parts.push(`within ${withinHours}h of the shift`);
    return parts.length ? `Approval required ${parts.join(", ")}` : "No extra approval required";
  },
  evaluate: (rule, context) => {
    const reasons: string[] = [];
    if (bool(rule.params, "always")) reasons.push("this program requires chief approval for all trades");
    if (context.legs.length === 2) {
      const [a, b] = context.legs;
      if (bool(rule.params, "whenServiceDiffers") && a.gives.serviceId !== b.gives.serviceId) {
        reasons.push("the two shifts are on different services");
      }
      if (bool(rule.params, "whenPgyDiffers") && a.resident.pgyLevel !== b.resident.pgyLevel) {
        reasons.push("the residents are at different PGY levels");
      }
    }
    const withinHours = rule.params.whenWithinHours;
    if (typeof withinHours === "number") {
      const soon = context.legs.some(
        (leg) => restHoursBetween(context.now, leg.receives.start) < withinHours,
      );
      if (soon) reasons.push(`a shift starts within ${withinHours} hours`);
    }
    if (reasons.length === 0) {
      return [baseCheck(rule, approvalRequirement, null, "pass", "No additional approval required.")];
    }
    return [
      baseCheck(
        rule,
        approvalRequirement,
        null,
        "warn",
        `Chief approval is required because ${reasons.join(" and ")}.`,
      ),
    ];
  },
};

export const RULE_HANDLERS: RuleHandler[] = [
  minRest,
  maxConsecutiveShifts,
  maxConsecutiveNights,
  maxShiftsInPeriod,
  noOverlap,
  minNotice,
  blackoutDates,
  holidayRestriction,
  weekendLimit,
  maxTradesPerMonth,
  maxOpenPickups,
  nonTradeableService,
  serviceRequirement,
  credentialRequirement,
  pgyRequirement,
  approvalRequirement,
];

export const RULE_HANDLERS_BY_TYPE = new Map(
  RULE_HANDLERS.map((handler) => [handler.type, handler]),
);

export function summariseRule(rule: RuleRow): string {
  const handler = RULE_HANDLERS_BY_TYPE.get(rule.rule_type);
  return handler ? handler.summarise(rule.params) : "Custom rule";
}

/** Rule types that force a trade into the approval queue when they warn. */
export const APPROVAL_TRIGGERING_TYPES = new Set([
  "approval_required",
  "holiday_restriction",
]);

export function evaluateRules(context: TradeContext): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  for (const rule of context.rules) {
    if (!rule.active) continue;
    const handler = RULE_HANDLERS_BY_TYPE.get(rule.rule_type);
    if (!handler) continue;
    try {
      checks.push(...handler.evaluate(rule, context));
    } catch (error) {
      checks.push({
        key: `rule:${rule.id}:error`,
        ruleId: rule.id,
        ruleType: rule.rule_type,
        category: handler.category,
        label: rule.name,
        status: "fail",
        message: `This program rule could not be evaluated (${
          error instanceof Error ? error.message : "unknown error"
        }). A chief resident must review this trade.`,
        overridable: true,
      });
    }
  }
  return checks;
}
