import type { RuleRow } from "@/server/db/types";
import type { CoverageRequirement } from "@/server/domain/coverage";
import type {
  ScheduleAssignment,
  ScheduleResident,
  ScheduleService,
  ScheduleSnapshot,
} from "@/server/domain/constraints/types";

/**
 * A small, deliberately *valid* schedule to violate one thing at a time.
 *
 * The whole test strategy rests on this being quiet: every constraint returns
 * nothing for the base snapshot, so a case that breaks one thing and then
 * asserts the exact set of constraint ids reported is asserting something
 * meaningful. A base that already tripped two fairness objectives would turn
 * every assertion into "the two I expected, plus the usual noise", which is how
 * a suite stops catching regressions.
 *
 * The week is Mon 3 – Sun 9 August 2026, in `America/New_York`. Real dates
 * rather than relative ones, because a fixture built from `Date.now()` fails on
 * the Sunday of a clock change and passes every other day of the year.
 *
 * Five residents: two PGY-1, two PGY-2, and one PGY-3 who works nothing.
 * `dana` is alone at her level on purpose — the fairness constraints compare
 * within a training level and skip a level with only one person in it, so she
 * is where a case puts an extra shift, an overnight or an overlap without
 * disturbing anybody's balance.
 */

export const TZ = "America/New_York";
export const WEEK = { start: "2026-08-03", end: "2026-08-09" };

export const IDS = {
  program: "11111111-1111-4111-8111-111111111111",
  wards: "22222222-2222-4222-8222-222222222222",
  clinic: "33333333-3333-4333-8333-333333333333",
  site: "44444444-4444-4444-8444-444444444444",
  alice: "aaaaaaaa-0001-4000-8000-000000000001",
  ben: "aaaaaaaa-0002-4000-8000-000000000002",
  carmen: "aaaaaaaa-0003-4000-8000-000000000003",
  dev: "aaaaaaaa-0004-4000-8000-000000000004",
  dana: "aaaaaaaa-0005-4000-8000-000000000005",
  cohortA: "cccccccc-0001-4000-8000-000000000001",
  cohortB: "cccccccc-0002-4000-8000-000000000002",
  block1: "bbbbbbbb-0001-4000-8000-000000000001",
} as const;

/** An instant from a local wall time in the fixture's timezone. */
export function at(date: string, time: string): Date {
  /* August is EDT, UTC-4, every year — the fixture week is nowhere near a
     clock change, so the offset is a constant rather than a calculation. */
  return new Date(`${date}T${time}:00-04:00`);
}

export function resident(
  id: string,
  name: string,
  pgyLevel: number,
  overrides: Partial<ScheduleResident> = {},
): ScheduleResident {
  return {
    id,
    name,
    email: `${name.split(" ")[0].toLowerCase()}@test.invalid`,
    pgyLevel,
    credentials: [],
    active: true,
    schedulable: true,
    schedulingNotes: "",
    cohortId: null,
    cohortLabel: null,
    siteEligibility: {},
    constraints: {},
    preferences: {},
    ...overrides,
  };
}

export function service(
  id: string,
  name: string,
  overrides: Partial<ScheduleService> = {},
): ScheduleService {
  return {
    id,
    name,
    siteId: IDS.site,
    pgyMin: null,
    pgyMax: null,
    coverageMandatory: false,
    active: true,
    typicalShiftHours: 12,
    ...overrides,
  };
}

let shiftCounter = 0;

/** A day shift, 07:00–19:00, on the given date. */
export function shift(
  date: string,
  serviceId: string,
  residentId: string | null,
  overrides: Partial<ScheduleAssignment> = {},
): ScheduleAssignment {
  shiftCounter += 1;
  const serviceName = serviceId === IDS.wards ? "Wards" : "Clinic";
  return {
    shiftId: `shift-${String(shiftCounter).padStart(4, "0")}`,
    residentId,
    serviceId,
    serviceName,
    siteId: IDS.site,
    siteName: "Riverside",
    rotationId: null,
    rotationName: null,
    shiftType: "day",
    start: at(date, "07:00"),
    end: at(date, "19:00"),
    location: "Riverside",
    requiredPgyMin: 1,
    requiredPgyMax: 10,
    status: "scheduled",
    ...overrides,
  };
}

/** A night shift, 19:00 through 07:00 the next morning. */
export function night(
  date: string,
  serviceId: string,
  residentId: string | null,
): ScheduleAssignment {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return shift(date, serviceId, residentId, {
    shiftType: "night",
    start: at(date, "19:00"),
    end: at(next.toISOString().slice(0, 10), "07:00"),
  });
}

export function coverage(
  overrides: Partial<CoverageRequirement> = {},
): CoverageRequirement {
  return {
    id: "coverage-1",
    program_id: IDS.program,
    service_id: IDS.wards,
    scope: "weekday",
    label: "",
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    specific_date: null,
    period_start: null,
    period_end: null,
    start_time: null,
    end_time: null,
    min_staff: 1,
    max_staff: null,
    pgy_mix: [],
    notes: "",
    active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function rule(
  ruleType: string,
  params: Record<string, unknown>,
  overrides: Partial<RuleRow> = {},
): RuleRow {
  return {
    id: `rule-${ruleType}`,
    program_id: IDS.program,
    rule_type: ruleType,
    name: ruleType,
    description: "",
    params,
    severity: "error",
    scope: "program",
    scope_id: null,
    overridable: false,
    active: true,
    ...overrides,
  };
}

/**
 * The base: one Wards shift a day, spread so that no two people at the same
 * level differ by more than one shift.
 *
 *   Mon Alice · Tue Ben · Wed Alice · Thu Ben · Fri Carmen · Sat Dev · Sun Carmen
 *
 * Alice and Ben (PGY-1) have two each; Carmen has two and Dev one, a gap of one,
 * which is below the fairness tolerance. Dev has the only weekend shift at his
 * level and Carmen has the other, so weekends are level too.
 */
export function baseSnapshot(): ScheduleSnapshot {
  shiftCounter = 0;
  return {
    program: { id: IDS.program, name: "Test Residency", timezone: TZ },
    now: new Date("2026-08-01T12:00:00Z"),
    period: { ...WEEK },
    residents: [
      resident(IDS.alice, "Alice Adeyemi", 1),
      resident(IDS.ben, "Ben Brennan", 1),
      resident(IDS.carmen, "Carmen Costa", 2),
      resident(IDS.dev, "Dev Dhillon", 2),
      resident(IDS.dana, "Dana Whitfield", 3),
    ],
    services: [
      service(IDS.wards, "Wards", { coverageMandatory: true }),
      service(IDS.clinic, "Clinic"),
    ],
    assignments: [
      shift("2026-08-03", IDS.wards, IDS.alice),
      shift("2026-08-04", IDS.wards, IDS.ben),
      shift("2026-08-05", IDS.wards, IDS.alice),
      shift("2026-08-06", IDS.wards, IDS.ben),
      shift("2026-08-07", IDS.wards, IDS.carmen),
      shift("2026-08-08", IDS.wards, IDS.dev),
      shift("2026-08-09", IDS.wards, IDS.carmen),
    ],
    coverage: [coverage()],
    blocks: [],
    blockAssignments: [],
    overrides: [],
    rules: [],
  };
}

/** The one-block year some cases need, covering the whole fixture week. */
export function withBlock(snapshot: ScheduleSnapshot): ScheduleSnapshot {
  snapshot.blocks = [
    {
      id: IDS.block1,
      sequence: 1,
      label: "Block 1",
      kind: "Inpatient",
      startDate: "2026-08-01",
      endDate: "2026-08-28",
    },
  ];
  return snapshot;
}
