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
 */
export interface TradeLegContext {
  resident: ResidentInfo;
  gives: ShiftInfo;
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
