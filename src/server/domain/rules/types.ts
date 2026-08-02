import type { RuleRow } from "@/server/db/types";

/**
 * Rule precedence (documented in docs/RULES.md).
 *
 *   1  safety      – rest, consecutive work, workload caps, overlaps
 *   2  program     – program-wide policy: notice, blackouts, trade caps
 *   3  service     – rotation/service requirements and credentials
 *   4  shift       – per-shift flags: tradeable, PGY range, deadline
 *   5  preference  – soft matching preferences (warnings only)
 *
 * A failure in a lower-numbered tier always outranks (and is displayed above)
 * a failure in a higher-numbered tier.
 */
export const RULE_CATEGORY = {
  safety: 1,
  program: 2,
  service: 3,
  shift: 4,
  preference: 5,
} as const;

export type RuleCategory = (typeof RULE_CATEGORY)[keyof typeof RULE_CATEGORY];

export interface ShiftInfo {
  id: string;
  programId: string;
  serviceId: string;
  serviceName: string;
  rotationId: string | null;
  rotationName: string | null;
  shiftType: string;
  date: string;
  start: Date;
  end: Date;
  location: string;
  requiredPgyMin: number;
  requiredPgyMax: number;
  tradeable: boolean;
  approvalRequired: boolean;
  tradeDeadline: Date | null;
  status: string;
}

export interface ResidentInfo {
  id: string;
  userId: string;
  name: string;
  email: string;
  pgyLevel: number;
  credentials: string[];
  active: boolean;
}

/**
 * One side of a trade: a resident giving up `gives` and receiving `receives`.
 * Modelling the trade as a list of legs keeps the engine ready for future
 * A -> B -> C -> A rotations without any redesign.
 *
 * ## Why `gives` can be null
 *
 * A resident taking a shift without giving one away gives nothing. That is the
 * whole point of a giveaway, and it is the case the safety rules exist for:
 * every other exchange in this product leaves both people working the same
 * number of hours, and this one does not.
 *
 * Null rather than "the same shift twice" or an optional field, because the
 * type is what forces each of the seven handlers that read `gives` to say what
 * it means when there is nothing there. Two of them turn out to mean "check
 * the incoming shift only"; one — the rule about switching between different
 * services — turns out not to apply to a one-way transfer at all, which is
 * worth knowing rather than discovering from a null dereference in production.
 */
export interface TradeLegContext {
  resident: ResidentInfo;
  /** Null when this resident is taking a shift and giving nothing back. */
  gives: ShiftInfo | null;
  receives: ShiftInfo;
  currentSchedule: ShiftInfo[];
  proposedSchedule: ShiftInfo[];
  completedTradesThisMonth: number;
  openOffers: number;
}

export interface TradeContext {
  program: {
    id: string;
    name: string;
    timezone: string;
    defaultTradeApprovalRequired: boolean;
  };
  now: Date;
  legs: TradeLegContext[];
  rules: RuleRow[];
  /**
   * What the switch would do to service coverage, already evaluated.
   *
   * Carried on the context rather than computed inside `validateTrade` because
   * answering it needs the whole programme's schedule for the days involved,
   * and `validateTrade` is pure and synchronous — a property worth keeping, as
   * it is what lets the rules engine be tested without a database.
   *
   * Absent means nobody asked. That is not the same as "coverage is fine", and
   * the screens say so.
   */
  coverageChecks?: ValidationCheck[];
}

export type CheckStatus = "pass" | "fail" | "warn";

export interface ValidationCheck {
  key: string;
  ruleId: string | null;
  ruleType: string;
  category: RuleCategory;
  label: string;
  status: CheckStatus;
  message: string;
  residentId?: string;
  residentName?: string;
  detail?: { required?: string; available?: string };
  overridable: boolean;
}

export interface TradeValidationResult {
  valid: boolean;
  requiresApproval: boolean;
  approvalReasons: string[];
  checks: ValidationCheck[];
  failures: ValidationCheck[];
  warnings: ValidationCheck[];
  ruleIds: string[];
  evaluatedAt: string;
}

export interface RuleHandler {
  type: string;
  label: string;
  description: string;
  category: RuleCategory;
  /** Human-readable summary of the configured parameters, for admin screens. */
  summarise: (params: Record<string, unknown>) => string;
  evaluate: (rule: RuleRow, context: TradeContext) => ValidationCheck[];
}
