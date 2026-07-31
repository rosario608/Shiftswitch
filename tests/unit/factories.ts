import type { RuleRow } from "@/server/db/types";
import type {
  ResidentInfo,
  ShiftInfo,
  TradeContext,
  TradeLegContext,
} from "@/server/domain/rules/types";
import { zonedWallTimeToInstant } from "@/server/domain/time";
import { buildProposedSchedule } from "@/server/domain/validation";

export const NY = "America/New_York";

let counter = 0;
const id = (prefix: string) => `${prefix}-${(counter += 1)}`;

export function makeShift(overrides: Partial<ShiftInfo> & { date: string }): ShiftInfo {
  const startTime = overrides.shiftType === "night" ? "19:00" : "07:00";
  const endTime = overrides.shiftType === "night" ? "07:00" : "19:00";
  const start =
    overrides.start ?? zonedWallTimeToInstant(overrides.date, startTime, NY);
  const end =
    overrides.end ??
    zonedWallTimeToInstant(
      overrides.shiftType === "night"
        ? new Date(new Date(`${overrides.date}T00:00:00Z`).getTime() + 86_400_000)
            .toISOString()
            .slice(0, 10)
        : overrides.date,
      endTime,
      NY,
    );
  return {
    id: id("shift"),
    programId: "program-1",
    serviceId: "service-micu",
    serviceName: "MICU",
    rotationId: null,
    rotationName: null,
    shiftType: "day",
    location: "ICU Tower 4",
    requiredPgyMin: 1,
    requiredPgyMax: 4,
    tradeable: true,
    approvalRequired: false,
    tradeDeadline: null,
    status: "scheduled",
    ...overrides,
    start,
    end,
  };
}

export function makeResident(overrides: Partial<ResidentInfo> = {}): ResidentInfo {
  return {
    id: id("resident"),
    userId: id("user"),
    name: "Dr. Test",
    email: "test@hospital.org",
    pgyLevel: 2,
    credentials: ["BLS", "ACLS"],
    active: true,
    ...overrides,
  };
}

export function makeRule(overrides: Partial<RuleRow> & { rule_type: string }): RuleRow {
  return {
    id: id("rule"),
    program_id: "program-1",
    name: overrides.rule_type,
    description: "",
    params: {},
    severity: "error",
    scope: "program",
    scope_id: null,
    overridable: true,
    active: true,
    ...overrides,
  } as RuleRow;
}

export function makeContext(input: {
  residentA?: ResidentInfo;
  residentB?: ResidentInfo;
  shiftA: ShiftInfo;
  shiftB: ShiftInfo;
  scheduleA?: ShiftInfo[];
  scheduleB?: ShiftInfo[];
  rules?: RuleRow[];
  now?: Date;
  tradesA?: number;
  tradesB?: number;
  offersA?: number;
  offersB?: number;
  defaultTradeApprovalRequired?: boolean;
}): TradeContext {
  const residentA = input.residentA ?? makeResident({ name: "Dr. A" });
  const residentB = input.residentB ?? makeResident({ name: "Dr. B" });
  const legA: TradeLegContext = buildProposedSchedule({
    resident: residentA,
    gives: input.shiftA,
    receives: input.shiftB,
    currentSchedule: input.scheduleA ?? [input.shiftA],
    completedTradesThisMonth: input.tradesA ?? 0,
    openOffers: input.offersA ?? 0,
  });
  const legB: TradeLegContext = buildProposedSchedule({
    resident: residentB,
    gives: input.shiftB,
    receives: input.shiftA,
    currentSchedule: input.scheduleB ?? [input.shiftB],
    completedTradesThisMonth: input.tradesB ?? 0,
    openOffers: input.offersB ?? 0,
  });
  return {
    program: {
      id: "program-1",
      name: "Internal Medicine Residency",
      timezone: NY,
      defaultTradeApprovalRequired: input.defaultTradeApprovalRequired ?? false,
    },
    now: input.now ?? zonedWallTimeToInstant("2026-07-01", "08:00", NY),
    legs: [legA, legB],
    rules: input.rules ?? [],
  };
}
