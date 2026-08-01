import type { RuleRow } from "@/server/db/types";
import { RULE_HANDLERS_BY_TYPE } from "@/server/domain/rules/handlers";
import type {
  ShiftInfo,
  TradeContext,
  TradeLegContext,
  ValidationCheck,
} from "@/server/domain/rules/types";
import type { ScheduleAssignment, ScheduleResident, ScheduleSnapshot } from "./types";

/**
 * Asking the rules engine about a schedule instead of a trade.
 *
 * The engine already models rest, consecutive days and nights, rolling
 * workload, weekend caps, overlaps, PGY ranges, service eligibility and
 * credentials — configured per programme in the `rules` table, with the
 * numbers a programme actually chose. Reimplementing any of that here would
 * create two sources of truth, and the first time they drifted the product
 * would refuse a trade for a limit the schedule validator said was fine.
 *
 * So the constraints call the handlers. The only work this file does is
 * translation, and the translation is exact:
 *
 *   a *trade* asks "if this resident took this shift, on top of everything
 *   else they hold, would that be legal?"
 *
 *   a *schedule* asks "this resident holds this shift, on top of everything
 *   else they hold — is that legal?"
 *
 * Same question, different tense. One leg per assignment, `receives` set to
 * that assignment and `proposedSchedule` set to everything the resident holds
 * in the schedule under test, answers it.
 *
 * ## What is deliberately not bridged
 *
 * `min_notice_hours`, `holiday_restriction`, `max_trades_per_month`,
 * `max_open_pickups` and `non_tradeable_service` are rules about *trading* —
 * how close to a shift a switch may be agreed, how many switches somebody may
 * make. They say nothing about whether a schedule is correct, and pressing them
 * into service here would produce violations a chief could not act on. They
 * stay where they belong.
 *
 * `blackout_dates` is the interesting middle case: the dates are configuration
 * the schedule must respect, but the rule's own sentence says shifts on that
 * day "cannot be traded", which is a different claim. The blackout constraint
 * reads the rule's parameters and writes its own sentence — see the catalogue.
 */

/** How many verdicts a handler can produce for one resident. */
export type RuleScope =
  /** The question is about one assignment: rest, overlap, eligibility. */
  | "per-assignment"
  /**
   * The question is about the resident's whole schedule: days in a row,
   * shifts in a window. Evaluating per assignment would report the same
   * violation once per shift the resident works, which for a month is forty
   * copies of one sentence.
   */
  | "per-resident";

export interface RuleVerdict {
  rule: RuleRow;
  resident: ScheduleResident;
  /** The assignment the verdict is about, for `per-assignment` rules. */
  assignment: ScheduleAssignment | null;
  status: "fail" | "warn";
  detail: ValidationCheck["detail"];
  /** The engine's own sentence. Kept for the audit trail, not for display. */
  ruleMessage: string;
}

function toShiftInfo(
  assignment: ScheduleAssignment,
  snapshot: ScheduleSnapshot,
): ShiftInfo {
  return {
    id: assignment.shiftId,
    programId: snapshot.program.id,
    serviceId: assignment.serviceId,
    serviceName: assignment.serviceName,
    rotationId: assignment.rotationId,
    rotationName: assignment.rotationName,
    shiftType: assignment.shiftType,
    date: isoDateIn(assignment.start, snapshot.program.timezone),
    start: assignment.start,
    end: assignment.end,
    location: assignment.location,
    requiredPgyMin: assignment.requiredPgyMin,
    requiredPgyMax: assignment.requiredPgyMax,
    /* Trade-only fields. A schedule question never reaches them, and giving
       them plausible-looking values would invite a future handler to read one
       and quietly mean something. */
    tradeable: true,
    approvalRequired: false,
    tradeDeadline: null,
    status: assignment.status,
  };
}

function isoDateIn(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

/** Everything one resident holds in the schedule under test. */
export function assignmentsByResident(
  snapshot: ScheduleSnapshot,
): Map<string, ScheduleAssignment[]> {
  const byResident = new Map<string, ScheduleAssignment[]>();
  for (const assignment of snapshot.assignments) {
    if (!assignment.residentId) continue;
    if (assignment.status === "cancelled") continue;
    const list = byResident.get(assignment.residentId);
    if (list) list.push(assignment);
    else byResident.set(assignment.residentId, [assignment]);
  }
  for (const list of byResident.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
  }
  return byResident;
}

function scopeMatches(rule: RuleRow, assignment: ScheduleAssignment): boolean {
  switch (rule.scope) {
    case "program":
      return true;
    case "service":
      return assignment.serviceId === rule.scope_id;
    case "rotation":
      return assignment.rotationId === rule.scope_id;
    case "shift":
      return assignment.shiftId === rule.scope_id;
    default:
      return true;
  }
}

/**
 * Runs every active rule of one type over the schedule, returning only the
 * verdicts that found something.
 *
 * Passing rules produce nothing on purpose. The trade engine reports its passes
 * because a resident deciding whether to offer wants to see the checks that
 * cleared; a chief looking at a month wants the list of what is wrong, and a
 * thousand green lines is how that list becomes unreadable.
 */
export function runRuleType(
  snapshot: ScheduleSnapshot,
  ruleType: string,
  scope: RuleScope,
): RuleVerdict[] {
  const handler = RULE_HANDLERS_BY_TYPE.get(ruleType);
  if (!handler) return [];

  const rules = snapshot.rules.filter(
    (rule) => rule.rule_type === ruleType && rule.active,
  );
  if (rules.length === 0) return [];

  const residentsById = new Map(snapshot.residents.map((r) => [r.id, r]));
  const held = assignmentsByResident(snapshot);
  const verdicts: RuleVerdict[] = [];

  for (const rule of rules) {
    for (const [residentId, assignments] of held) {
      const resident = residentsById.get(residentId);
      if (!resident) continue;

      /* `scopeApplies` inside the engine reads the leg's shifts, so a
         service-scoped rule is applied by choosing which assignments become
         legs rather than by filtering afterwards. In `per-resident` mode one
         representative in scope is enough — the handler reads the whole
         proposed schedule regardless. */
      const inScope = assignments.filter((a) => scopeMatches(rule, a));
      if (inScope.length === 0) continue;
      const subjects = scope === "per-resident" ? [inScope[0]] : inScope;

      const proposedSchedule = assignments.map((a) => toShiftInfo(a, snapshot));
      const legs: TradeLegContext[] = subjects.map((assignment) => ({
        resident: {
          id: resident.id,
          userId: resident.id,
          name: resident.name,
          email: "",
          pgyLevel: resident.pgyLevel,
          credentials: resident.credentials,
          active: resident.active,
        },
        gives: toShiftInfo(assignment, snapshot),
        receives: toShiftInfo(assignment, snapshot),
        currentSchedule: proposedSchedule,
        proposedSchedule,
        /* Trade history is not a property of a schedule. Zero is not a guess:
           these two fields only feed the trade-only rules this bridge refuses
           to run. */
        completedTradesThisMonth: 0,
        openOffers: 0,
      }));

      const context: TradeContext = {
        program: {
          id: snapshot.program.id,
          name: snapshot.program.name,
          timezone: snapshot.program.timezone,
          defaultTradeApprovalRequired: false,
        },
        now: snapshot.now,
        legs,
        rules: [rule],
      };

      const checks = handler.evaluate(rule, context);
      checks.forEach((check, index) => {
        if (check.status === "pass") return;
        verdicts.push({
          rule,
          resident,
          assignment: scope === "per-resident" ? null : (subjects[index] ?? null),
          status: check.status,
          detail: check.detail,
          ruleMessage: check.message,
        });
      });
    }
  }

  return verdicts;
}
