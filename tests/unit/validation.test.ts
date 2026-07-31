import { describe, expect, it } from "vitest";
import { validateTrade } from "@/server/domain/validation";
import { zonedWallTimeToInstant } from "@/server/domain/time";
import { makeContext, makeResident, makeRule, makeShift, NY } from "./factories";

describe("validateTrade — structural checks", () => {
  it("accepts a straightforward swap with no rules configured", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.requiresApproval).toBe(false);
    expect(result.checks.some((check) => check.status === "pass")).toBe(true);
  });

  it("rejects a non-tradeable shift with a readable message", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15", tradeable: false, serviceName: "Clinic" }),
        shiftB: makeShift({ date: "2026-07-22" }),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("non-tradeable");
  });

  it("rejects a cancelled shift", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15", status: "cancelled" }),
        shiftB: makeShift({ date: "2026-07-22" }),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.message.includes("no longer available"))).toBe(
      true,
    );
  });

  it("rejects a shift whose trade deadline has passed", () => {
    const now = zonedWallTimeToInstant("2026-07-10", "08:00", NY);
    const result = validateTrade(
      makeContext({
        now,
        shiftA: makeShift({
          date: "2026-07-15",
          tradeDeadline: zonedWallTimeToInstant("2026-07-09", "08:00", NY),
        }),
        shiftB: makeShift({ date: "2026-07-22" }),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("deadline");
  });

  it("rejects a trade where the same resident is on both sides", () => {
    const resident = makeResident({ name: "Dr. Solo" });
    const result = validateTrade(
      makeContext({
        residentA: resident,
        residentB: resident,
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("cannot be traded with yourself");
  });

  it("rejects a shift that has already started", () => {
    const result = validateTrade(
      makeContext({
        now: zonedWallTimeToInstant("2026-07-20", "08:00", NY),
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.message.includes("already started"))).toBe(true);
  });

  it("rejects an inactive resident", () => {
    const result = validateTrade(
      makeContext({
        residentB: makeResident({ name: "Dr. Gone", active: false }),
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("no longer an active resident");
  });
});

describe("validateTrade — safety rules", () => {
  it("rejects a trade that leaves insufficient rest, with the numbers", () => {
    const nightBefore = makeShift({
      date: "2026-07-21",
      shiftType: "night",
      serviceName: "Night Float",
    });
    const dayShift = makeShift({ date: "2026-07-22" });
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: dayShift,
        // Resident A also works the night before the shift they'd receive.
        scheduleA: [makeShift({ date: "2026-07-15" }), nightBefore],
        rules: [makeRule({ rule_type: "min_rest_hours", params: { hours: 10 } })],
      }),
    );
    expect(result.valid).toBe(false);
    const failure = result.failures.find((f) => f.ruleType === "min_rest_hours");
    // The numbers are in the sentence, because the resident's own screen does
    // not render `detail` — only the chief's approvals queue does.
    expect(failure?.message).toContain("0 hours");
    expect(failure?.message).toContain("10 hours");
    expect(failure?.detail).toEqual({ required: "10 hours", available: "0 hours" });
  });

  it("passes when rest is sufficient", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
        rules: [makeRule({ rule_type: "min_rest_hours", params: { hours: 10 } })],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a trade creating too many consecutive days", () => {
    const scheduleA = [
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
      "2026-07-20",
      "2026-07-21",
      "2026-07-23",
    ].map((date) => makeShift({ date }));
    const given = scheduleA[scheduleA.length - 1];
    const result = validateTrade(
      makeContext({
        shiftA: given,
        shiftB: makeShift({ date: "2026-07-22" }),
        scheduleA,
        rules: [makeRule({ rule_type: "max_consecutive_shifts", params: { days: 5 } })],
      }),
    );
    expect(result.valid).toBe(false);
    const failure = result.failures.find(
      (check) => check.ruleType === "max_consecutive_shifts",
    );
    expect(failure?.detail).toEqual({
      required: "5 days maximum",
      available: "6 days in a row",
    });
  });

  it("rejects a trade creating too many consecutive nights", () => {
    const nights = ["2026-07-18", "2026-07-19", "2026-07-20"].map((date) =>
      makeShift({ date, shiftType: "night" }),
    );
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-10" }),
        shiftB: makeShift({ date: "2026-07-21", shiftType: "night" }),
        scheduleA: [makeShift({ date: "2026-07-10" }), ...nights],
        rules: [makeRule({ rule_type: "max_consecutive_nights", params: { nights: 3 } })],
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.failures.some((check) => check.ruleType === "max_consecutive_nights"),
    ).toBe(true);
  });

  it("rejects an overlapping assignment", () => {
    const existing = makeShift({ date: "2026-07-22" });
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22", serviceName: "Cardiology" }),
        scheduleA: [makeShift({ date: "2026-07-15" }), existing],
        rules: [makeRule({ rule_type: "no_overlapping_shifts" })],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("overlaps");
    // Names the shift it clashes with, so the resident knows what to move.
    expect(result.failures[0].message).toContain("MICU");
  });

  it("rejects exceeding the rolling shift cap", () => {
    const schedule = Array.from({ length: 6 }, (_, index) =>
      makeShift({ date: `2026-07-${String(10 + index).padStart(2, "0")}` }),
    );
    const result = validateTrade(
      makeContext({
        shiftA: schedule[0],
        shiftB: makeShift({ date: "2026-07-25" }),
        scheduleA: schedule,
        rules: [
          makeRule({
            rule_type: "max_shifts_in_period",
            params: { maxShifts: 5, windowDays: 28 },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].detail?.required).toBe("5 shifts");
  });
});

describe("validateTrade — program and service rules", () => {
  it("rejects a trade with less than the required notice", () => {
    const result = validateTrade(
      makeContext({
        now: zonedWallTimeToInstant("2026-07-15", "01:00", NY),
        shiftA: makeShift({ date: "2026-07-16" }),
        shiftB: makeShift({ date: "2026-07-15" }),
        rules: [makeRule({ rule_type: "min_notice_hours", params: { hours: 24 } })],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("6 hours");
    expect(result.failures[0].message).toContain("24 hours");
  });

  it("rejects a blackout date", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-09-18" }),
        shiftB: makeShift({ date: "2026-09-25" }),
        rules: [
          makeRule({ rule_type: "blackout_dates", params: { dates: ["2026-09-18"] } }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("blackout date");
  });

  it("requires approval for a holiday shift instead of blocking it", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-12-25" }),
        shiftB: makeShift({ date: "2026-12-28" }),
        rules: [
          makeRule({
            rule_type: "holiday_restriction",
            params: { dates: ["2026-12-25"], mode: "approval" },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReasons.join(" ")).toContain("holiday");
  });

  it("blocks a holiday shift when the rule says block", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-12-25" }),
        shiftB: makeShift({ date: "2026-12-28" }),
        rules: [
          makeRule({
            rule_type: "holiday_restriction",
            params: { dates: ["2026-12-25"], mode: "block" },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a non-tradeable service", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({
          date: "2026-07-15",
          serviceId: "service-clinic",
          serviceName: "Continuity Clinic",
        }),
        shiftB: makeShift({ date: "2026-07-22" }),
        rules: [
          makeRule({
            rule_type: "non_tradeable_service",
            params: { serviceIds: ["service-clinic"] },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("cannot be traded");
  });

  it("rejects a resident without the credentials a service requires", () => {
    const result = validateTrade(
      makeContext({
        residentB: makeResident({ name: "Dr. Intern", credentials: ["BLS"] }),
        shiftA: makeShift({ date: "2026-07-15", serviceId: "service-micu" }),
        shiftB: makeShift({ date: "2026-07-22", serviceId: "service-floor" }),
        rules: [
          makeRule({
            rule_type: "credential_requirement",
            scope: "service",
            scope_id: "service-micu",
            params: { credentials: ["Critical Care"] },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    // Names the credential, not just the fact that one is missing.
    expect(result.failures[0].message).toContain("Critical Care");
  });

  it("rejects a resident whose PGY is outside the shift's range", () => {
    const result = validateTrade(
      makeContext({
        residentB: makeResident({ name: "Dr. Intern", pgyLevel: 1 }),
        shiftA: makeShift({ date: "2026-07-15", requiredPgyMin: 2, requiredPgyMax: 4 }),
        shiftB: makeShift({ date: "2026-07-22" }),
        rules: [makeRule({ rule_type: "pgy_requirement" })],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].detail).toEqual({
      required: "PGY-2 to PGY-4",
      available: "PGY-1",
    });
  });

  it("rejects a PGY gap larger than the program allows", () => {
    const result = validateTrade(
      makeContext({
        residentA: makeResident({ name: "Dr. Senior", pgyLevel: 4 }),
        residentB: makeResident({ name: "Dr. Intern", pgyLevel: 1 }),
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
        rules: [
          makeRule({ rule_type: "pgy_requirement", params: { maxPgyDifference: 2 } }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("PGY difference");
  });

  it("rejects a resident at their monthly trade limit", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
        tradesA: 6,
        rules: [
          makeRule({ rule_type: "max_trades_per_month", params: { maxTrades: 6 } }),
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].message).toContain("6 switches");
  });

  it("treats a warning-severity rule as a warning, not a failure", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
        tradesA: 6,
        rules: [
          makeRule({
            rule_type: "max_trades_per_month",
            severity: "warning",
            params: { maxTrades: 6 },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.ruleType === "max_trades_per_month")).toBe(true);
  });

  it("ignores inactive rules", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-09-18" }),
        shiftB: makeShift({ date: "2026-09-25" }),
        rules: [
          makeRule({
            rule_type: "blackout_dates",
            active: false,
            params: { dates: ["2026-09-18"] },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateTrade — approval and precedence", () => {
  it("requires approval when the program demands it for every trade", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
        defaultTradeApprovalRequired: true,
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("requires approval when a shift is flagged", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15", approvalRequired: true }),
        shiftB: makeShift({ date: "2026-07-22" }),
      }),
    );
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalReasons[0]).toContain("requires chief approval");
  });

  it("requires approval inside the configured notice window", () => {
    const result = validateTrade(
      makeContext({
        now: zonedWallTimeToInstant("2026-07-14", "08:00", NY),
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
        rules: [
          makeRule({
            rule_type: "approval_required",
            params: { whenWithinHours: 48 },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("orders failures by precedence tier: safety before shift-level", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15", tradeable: false }),
        shiftB: makeShift({ date: "2026-07-22" }),
        scheduleA: [
          makeShift({ date: "2026-07-15", tradeable: false }),
          makeShift({ date: "2026-07-22", serviceName: "Cardiology" }),
        ],
        rules: [makeRule({ rule_type: "no_overlapping_shifts" })],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failures[0].category).toBe(1);
    expect(result.failures[result.failures.length - 1].category).toBe(4);
  });

  it("reports every rule id it evaluated", () => {
    const rule = makeRule({ rule_type: "min_rest_hours", params: { hours: 8 } });
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
        rules: [rule],
      }),
    );
    expect(result.ruleIds).toContain(rule.id);
  });

  it("never returns a bare boolean — checks carry human-readable messages", () => {
    const result = validateTrade(
      makeContext({
        shiftA: makeShift({ date: "2026-07-15" }),
        shiftB: makeShift({ date: "2026-07-22" }),
        rules: [makeRule({ rule_type: "min_rest_hours", params: { hours: 8 } })],
      }),
    );
    for (const check of result.checks) {
      expect(check.message.length).toBeGreaterThan(5);
      expect(check.label.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Properties every message must hold, asserted across all of them at once.
 *
 * These are the two mistakes that kept recurring one handler at a time. Pinning
 * exact prose per rule does not catch them — a new rule added next year starts
 * clean and then someone interpolates `shift.date` again. Asserting the shape
 * of every message the engine can produce does.
 */
describe("what a rule failure reads like", () => {
  /** Every rule, each configured so it fails, against one deliberately awful trade. */
  function everyFailure() {
    const resident = makeResident({
      name: "Jordan Rivera",
      pgyLevel: 2,
      credentials: ["BLS"],
    });
    const partner = makeResident({ name: "Sam Okafor", pgyLevel: 5 });
    const crowded = Array.from({ length: 10 }, (_, index) =>
      makeShift({
        date: `2026-07-${String(10 + index).padStart(2, "0")}`,
        shiftType: "night",
      }),
    );
    // A day shift on the same day as the one being received, so the overlap
    // rule has something to catch. The nights above run 19:00–07:00 and do not
    // collide with a 07:00–19:00 day.
    crowded.push(makeShift({ date: "2026-07-15", serviceName: "MICU" }));
    const configured = [
      makeRule({ rule_type: "min_rest_hours", params: { hours: 48 } }),
      makeRule({ rule_type: "max_consecutive_shifts", params: { days: 1 } }),
      makeRule({ rule_type: "max_consecutive_nights", params: { nights: 1 } }),
      makeRule({
        rule_type: "max_shifts_in_period",
        params: { maxShifts: 1, windowDays: 28 },
      }),
      makeRule({ rule_type: "no_overlapping_shifts" }),
      makeRule({ rule_type: "min_notice_hours", params: { hours: 500 } }),
      makeRule({ rule_type: "blackout_dates", params: { dates: ["2026-07-15"] } }),
      makeRule({
        rule_type: "holiday_restriction",
        params: { dates: ["2026-07-15"], mode: "block" },
      }),
      makeRule({
        rule_type: "weekend_limit",
        params: { maxWeekendShifts: 0, windowDays: 28 },
      }),
      makeRule({ rule_type: "max_trades_per_month", params: { maxTrades: 0 } }),
      makeRule({ rule_type: "max_open_pickups", params: { maxOpenOffers: 0 } }),
      makeRule({
        rule_type: "credential_requirement",
        params: { credentials: ["ACLS", "Critical Care"] },
      }),
      makeRule({ rule_type: "pgy_requirement", params: { maxPgyDifference: 0 } }),
    ];
    const result = validateTrade(
      makeContext({
        residentA: resident,
        residentB: partner,
        shiftA: makeShift({ date: "2026-07-15", requiredPgyMin: 4, requiredPgyMax: 5 }),
        shiftB: makeShift({ date: "2026-07-15", requiredPgyMin: 4, requiredPgyMax: 5 }),
        scheduleA: crowded,
        scheduleB: crowded,
        tradesA: 9,
        offersA: 9,
        rules: configured,
      }),
    );
    return result.checks.filter((check) => check.status !== "pass");
  }

  it("actually exercises most of the engine", () => {
    const covered = new Set(everyFailure().map((check) => check.ruleType));
    // Named explicitly: a fixture that quietly stopped tripping most rules
    // would leave the properties below asserting almost nothing.
    for (const type of [
      "min_rest_hours",
      "max_consecutive_shifts",
      "max_consecutive_nights",
      "max_shifts_in_period",
      "no_overlapping_shifts",
      "min_notice_hours",
      "blackout_dates",
      "holiday_restriction",
      "weekend_limit",
      "max_trades_per_month",
      "max_open_pickups",
      "credential_requirement",
      "pgy_requirement",
    ]) {
      expect(covered, `${type} did not fire`).toContain(type);
    }
  });

  it("never shows a resident an ISO date", () => {
    for (const check of everyFailure()) {
      expect(
        check.message,
        `${check.ruleType}: "${check.message}"`,
      ).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it("never opens with the resident's name, which both screens print already", () => {
    for (const check of everyFailure()) {
      expect(
        check.message.startsWith("Jordan Rivera"),
        `${check.ruleType} stutters: "Jordan Rivera: ${check.message}"`,
      ).toBe(false);
      expect(check.message.startsWith("Sam Okafor"), check.ruleType).toBe(false);
    }
  });

  it("writes whole sentences, not fragments or identifiers", () => {
    for (const check of everyFailure()) {
      const message = check.message;
      expect(message, check.ruleType).toMatch(/[.!]$/);
      expect(message[0], `${check.ruleType}: "${message}"`).toBe(
        message[0].toUpperCase(),
      );
      // No raw identifiers leaking through: uuids, snake_case rule types.
      expect(message, check.ruleType).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      expect(message, check.ruleType).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });
});
