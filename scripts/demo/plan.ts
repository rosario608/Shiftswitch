import { DateTime } from "luxon";

/**
 * The demo program, described as data.
 *
 * This module touches no database. It turns a single anchor date into the exact
 * set of people, services, shifts, trades and invitations the demo contains, so
 * the same anchor always produces the same program — which is what makes the
 * scenarios below testable rather than merely illustrative.
 *
 * Everything in here is invented. Every address is under `.invalid`, a domain
 * RFC 2606 reserves so that it can never resolve and can never belong to a real
 * person; no message sent to one can leave the machine. No real resident, real
 * schedule, real email address or real institution appears anywhere.
 */

export const DEMO_PROGRAM_NAME = "ShiftSwitch Demo Residency";
export const DEMO_INSTITUTION = "Fictional Teaching Hospital";
export const DEMO_TIMEZONE = "America/New_York";
export const DEMO_EMAIL_DOMAIN = "demo.invalid";

/** How many days of schedule the demo covers. */
export const DEMO_WEEKS = 4;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type DemoRole = "resident" | "chief" | "admin";

export interface DemoPerson {
  /** Stable handle used by the shift plan and by the tests. */
  key: string;
  email: string;
  fullName: string;
  role: DemoRole;
  /** Null for staff who do not work shifts. */
  pgy: number | null;
  note?: string;
}

function person(
  key: string,
  fullName: string,
  role: DemoRole,
  pgy: number | null,
  note?: string,
): DemoPerson {
  return { key, email: `demo.${key}@${DEMO_EMAIL_DOMAIN}`, fullName, role, pgy, note };
}

/**
 * Eighteen residents across three training years, two chief residents who also
 * work shifts, and one program administrator who does not.
 *
 * The seven residents carrying a `note` are the ones the scenarios below use.
 * Their schedules are shaped deliberately; the other thirteen are ordinary.
 */
export const DEMO_PEOPLE: DemoPerson[] = [
  person("admin", "Priya Raghunathan", "admin", null, "Program administrator — no shifts"),

  person("whitfield", "Dana Whitfield", "chief", 3),
  person("aliyev", "Emin Aliyev", "chief", 3),

  // PGY-1
  person("abiodun", "Blessing Abiodun", "resident", 1, "Scenario: invalid swap"),
  person("varga", "Zsofia Varga", "resident", 1, "Scenario: no available match"),
  person("lindqvist", "Nils Lindqvist", "resident", 1),
  person("mbeki", "Thandiwe Mbeki", "resident", 1),
  person("castellanos", "Mateo Castellanos", "resident", 1),
  person("duong", "Linh Duong", "resident", 1),

  // PGY-2
  person("rivera", "Camila Rivera", "resident", 2, "Scenario: valid swap (posts)"),
  person("okonkwo", "Chidi Okonkwo", "resident", 2, "Scenario: valid swap (offers)"),
  person("sorensen", "Freya Sorensen", "resident", 2, "Scenario: overlapping schedule"),
  person("haddad", "Yusuf Haddad", "resident", 2, "Scenario: overlapping schedule (posts)"),
  person("petrova", "Irina Petrova", "resident", 2),
  person("kimura", "Hana Kimura", "resident", 2),

  // PGY-3
  person("nakamura", "Kenji Nakamura", "resident", 3, "Scenario: invalid swap (posts)"),
  person("tanaka", "Aiko Tanaka", "resident", 3, "Scenario: no available match (posts)"),
  person("oyelaran", "Femi Oyelaran", "resident", 3),
  person("brennan", "Siobhan Brennan", "resident", 3),
  person("novak", "Tomas Novak", "resident", 3),
  person("ferreira", "Beatriz Ferreira", "resident", 3),
];

export const DEMO_RESIDENT_KEYS = DEMO_PEOPLE.filter((p) => p.pgy !== null).map(
  (p) => p.key,
);

/** Residents whose week-4 schedule is reserved for the scenarios. */
const SCENARIO_KEYS = new Set([
  "rivera",
  "okonkwo",
  "nakamura",
  "abiodun",
  "tanaka",
  "sorensen",
  "haddad",
]);

/**
 * Zsofia Varga works nothing but clinic, all month.
 *
 * That is a real thing that happens to a first-year, and it is what makes the
 * "no available match" scenario honest: clinic is not tradeable, so she has
 * nothing she is allowed to offer. The alternative — contriving rule failures
 * for seventeen other people — would test the contrivance rather than the
 * empty state a resident actually meets.
 */
const CLINIC_ONLY_KEYS = new Set(["varga"]);

// ---------------------------------------------------------------------------
// Services and rotations
// ---------------------------------------------------------------------------

export interface DemoService {
  name: string;
  tradeable: boolean;
}

export const DEMO_SERVICES: DemoService[] = [
  { name: "Demo MICU", tradeable: true },
  { name: "Demo Wards", tradeable: true },
  { name: "Demo Night Float", tradeable: true },
  // Continuity clinic is the classic example of a session a program will not
  // let residents swap, and the model already supports saying so.
  { name: "Demo Clinic", tradeable: false },
  { name: "Demo Emergency", tradeable: true },
  { name: "Demo Scenario Ward", tradeable: true },
];

export const DEMO_ROTATIONS = [
  "Critical Care",
  "Inpatient Medicine",
  "Ambulatory",
  "Emergency Medicine",
];

const ROTATION_FOR_SERVICE: Record<string, string> = {
  "Demo MICU": "Critical Care",
  "Demo Wards": "Inpatient Medicine",
  "Demo Night Float": "Inpatient Medicine",
  "Demo Clinic": "Ambulatory",
  "Demo Emergency": "Emergency Medicine",
  "Demo Scenario Ward": "Inpatient Medicine",
};

export const DEMO_RULES: Array<{ type: string; params: Record<string, unknown> }> = [
  { type: "min_rest_hours", params: { hours: 10 } },
  { type: "max_consecutive_shifts", params: { days: 6 } },
  { type: "no_overlapping_shifts", params: {} },
  { type: "pgy_requirement", params: { maxPgyDifference: 2 } },
  { type: "max_shifts_in_period", params: { maxShifts: 24, windowDays: 28 } },
  { type: "approval_required", params: { whenPgyDiffers: true } },
];

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export interface PlannedShift {
  /** Unique within a plan, so the seeder and the tests can refer to one shift. */
  ref: string;
  residentKey: string;
  service: string;
  rotation: string;
  /** Calendar date of the shift start, in the program timezone. */
  date: string;
  startTime: string;
  endTime: string;
  endsNextDay: boolean;
  shiftType: string;
  location: string;
  requiredPgyMin: number;
  requiredPgyMax: number;
  tradeable: boolean;
  approvalRequired: boolean;
  /** Set on the purpose-built shifts the scenarios rely on. */
  scenario?: string;
}

export interface DemoPlan {
  /** The Monday every offset is measured from, in the program timezone. */
  anchor: string;
  shifts: PlannedShift[];
  /** Posted-for-switching shifts, by shift ref, with the note to attach. */
  posts: Array<{ ref: string; notes: string; scenario: string }>;
  invitations: DemoInvitation[];
}

export interface DemoInvitation {
  email: string;
  role: DemoRole;
  pgy: number | null;
  /** Days from now; negative means it has already expired. */
  expiresInDays: number;
  revoked: boolean;
  scenario: string;
}

/**
 * The Monday of the week containing `now`, in the program timezone.
 *
 * Anchoring to a Monday rather than to "today" is what keeps weekday and
 * weekend shifts landing on weekdays and weekends no matter which day the demo
 * is seeded — a schedule where the Saturday call shift falls on a Tuesday is
 * not realistic data, it is noise.
 */
export function anchorMonday(now: Date = new Date(), timezone = DEMO_TIMEZONE): string {
  return DateTime.fromJSDate(now)
    .setZone(timezone)
    .startOf("day")
    .startOf("week")
    .toISODate() as string;
}

function dayOf(anchor: string, offset: number): string {
  return DateTime.fromISO(anchor).plus({ days: offset }).toISODate() as string;
}

interface Pattern {
  /** Weekday indexes worked, 0 = Monday. */
  days: number[];
  startTime: string;
  endTime: string;
  endsNextDay: boolean;
  shiftType: string;
  location: string;
  approvalRequired: boolean;
}

/**
 * Every pattern works Monday to Saturday at the latest and never Sunday, so no
 * run of consecutive days can exceed six — the limit this program's own
 * `max_consecutive_shifts` rule sets.
 *
 * That constraint is not cosmetic. A seeded schedule that already breaks the
 * program's rules makes every candidate in the demo ineligible for a reason
 * that has nothing to do with the trade being demonstrated, which is exactly
 * what the first version of this file did. Sunday is covered by the weekend
 * call shift instead.
 */
const PATTERNS: Record<string, Pattern> = {
  // Six days in a row — exactly the limit, so adding a seventh by trading is
  // caught, and the baseline schedule itself is compliant.
  "Demo MICU": {
    days: [0, 1, 2, 3, 4, 5],
    startTime: "07:00",
    endTime: "19:00",
    endsNextDay: false,
    shiftType: "day",
    location: "ICU Tower 4",
    approvalRequired: false,
  },
  "Demo Wards": {
    days: [0, 1, 2, 3, 4, 5],
    startTime: "07:00",
    endTime: "19:00",
    endsNextDay: false,
    shiftType: "day",
    location: "Ward 6 East",
    approvalRequired: false,
  },
  // 19:00 to 07:00 the following morning: one shift crossing midnight, not two.
  "Demo Night Float": {
    days: [0, 1, 2, 3, 4],
    startTime: "19:00",
    endTime: "07:00",
    endsNextDay: true,
    shiftType: "night",
    location: "Ward 6 East",
    approvalRequired: true,
  },
  "Demo Clinic": {
    days: [1, 2, 3],
    startTime: "08:00",
    endTime: "17:00",
    endsNextDay: false,
    shiftType: "day",
    location: "Ambulatory Center",
    approvalRequired: false,
  },
};

const BLOCK_SERVICES = ["Demo MICU", "Demo Wards", "Demo Night Float", "Demo Clinic"];

/**
 * Builds the whole demo program from one anchor date.
 *
 * The rotation is deliberately arithmetic rather than random: resident *i* in
 * week *w* is on `BLOCK_SERVICES[(i + w) % 4]`. Anyone reading the seeded data
 * can work out why a given person is where they are, and re-running produces
 * byte-identical assignments.
 */
export function buildDemoPlan(anchor: string): DemoPlan {
  const shifts: PlannedShift[] = [];
  const residents = DEMO_PEOPLE.filter((p) => p.pgy !== null);

  residents.forEach((resident, index) => {
    for (let week = 0; week < DEMO_WEEKS; week += 1) {
      // Week four belongs to the scenarios for the people they involve.
      if (week === DEMO_WEEKS - 1 && SCENARIO_KEYS.has(resident.key)) continue;

      const service = CLINIC_ONLY_KEYS.has(resident.key)
        ? "Demo Clinic"
        : BLOCK_SERVICES[(index + week) % BLOCK_SERVICES.length];
      const pattern = PATTERNS[service];

      for (const weekday of pattern.days) {
        const offset = week * 7 + weekday;
        shifts.push({
          ref: `block-${resident.key}-${offset}`,
          residentKey: resident.key,
          service,
          rotation: ROTATION_FOR_SERVICE[service],
          date: dayOf(anchor, offset),
          startTime: pattern.startTime,
          endTime: pattern.endTime,
          endsNextDay: pattern.endsNextDay,
          shiftType: pattern.shiftType,
          location: pattern.location,
          requiredPgyMin: 1,
          requiredPgyMax: 10,
          tradeable: service !== "Demo Clinic",
          approvalRequired: pattern.approvalRequired,
        });
      }
    }
  });

  // One 24-hour weekend call shift per week, covering Saturday into Sunday.
  //
  // It goes to whoever is on clinic that week — three weekday sessions and
  // nothing else — because giving it to somebody already working a six-day
  // block would push them to seven consecutive days and make the seeded
  // schedule violate the program's own rule.
  for (let week = 0; week < DEMO_WEEKS; week += 1) {
    const resident = residents.find(
      (candidate, index) =>
        (candidate.pgy ?? 0) >= 2 &&
        !SCENARIO_KEYS.has(candidate.key) &&
        !CLINIC_ONLY_KEYS.has(candidate.key) &&
        BLOCK_SERVICES[(index + week) % BLOCK_SERVICES.length] === "Demo Clinic",
    );
    if (!resident) continue;
    const offset = week * 7 + 5; // Saturday
    shifts.push({
      ref: `call-${week}`,
      residentKey: resident.key,
      service: "Demo Emergency",
      rotation: ROTATION_FOR_SERVICE["Demo Emergency"],
      date: dayOf(anchor, offset),
      startTime: "07:00",
      endTime: "07:00",
      endsNextDay: true,
      shiftType: "call",
      location: "Emergency Department",
      requiredPgyMin: 2,
      requiredPgyMax: 10,
      tradeable: true,
      approvalRequired: false,
    });
  }

  shifts.push(...scenarioShifts(anchor));

  // Stable order, so two runs write rows in the same sequence.
  shifts.sort((a, b) =>
    a.date === b.date
      ? a.ref.localeCompare(b.ref)
      : a.date.localeCompare(b.date),
  );

  return {
    anchor,
    shifts,
    posts: [
      {
        ref: "sc-valid-source",
        scenario: "valid-swap",
        notes: "Family event that weekend — happy to take any weekday in return.",
      },
      {
        ref: "sc-invalid-source",
        scenario: "invalid-swap",
        notes: "Senior cover needed; PGY-3 only.",
      },
      {
        ref: "sc-nomatch-source",
        scenario: "no-available-match",
        notes: "Away at a conference. Anything in the same week works.",
      },
      {
        ref: "sc-overlap-source",
        scenario: "overlapping-schedule",
        notes: "Wedding that morning. Any other ward day would help.",
      },
    ],
    invitations: DEMO_INVITATIONS,
  };
}

/**
 * The purpose-built week-four shifts. Each exists so that one scenario has a
 * deterministic, inspectable outcome rather than depending on what the rotation
 * happened to produce.
 */
function scenarioShifts(anchor: string): PlannedShift[] {
  const ward = "Demo Scenario Ward";
  const rotation = ROTATION_FOR_SERVICE[ward];
  const base = {
    service: ward,
    rotation,
    startTime: "07:00",
    endTime: "19:00",
    endsNextDay: false,
    shiftType: "day",
    location: "Ward 3 West",
    requiredPgyMin: 1,
    requiredPgyMax: 10,
    tradeable: true,
    approvalRequired: false,
  };

  return [
    // --- Valid two-person swap: two PGY-2s, same service, no rule touched.
    {
      ...base,
      ref: "sc-valid-source",
      residentKey: "rivera",
      date: dayOf(anchor, 22),
      scenario: "valid-swap",
    },
    {
      ...base,
      ref: "sc-valid-offer",
      residentKey: "okonkwo",
      date: dayOf(anchor, 25),
      scenario: "valid-swap",
    },

    // --- Invalid swap: the PGY ranges exclude each resident from the other's
    //     shift, so the rules engine fails it in both directions.
    {
      ...base,
      ref: "sc-invalid-source",
      residentKey: "nakamura",
      date: dayOf(anchor, 23),
      requiredPgyMin: 3,
      scenario: "invalid-swap",
    },
    {
      ...base,
      ref: "sc-invalid-offer",
      residentKey: "abiodun",
      date: dayOf(anchor, 26),
      requiredPgyMax: 1,
      scenario: "invalid-swap",
    },

    // --- No available match: Tanaka posts, and Varga — whose month is clinic
    //     only — has nothing she is permitted to offer.
    {
      ...base,
      ref: "sc-nomatch-source",
      residentKey: "tanaka",
      date: dayOf(anchor, 24),
      scenario: "no-available-match",
    },

    // --- Overlapping schedule: Sorensen already works the afternoon of day 22,
    //     so taking Haddad's day-22 morning shift would double-book her.
    {
      ...base,
      ref: "sc-overlap-source",
      residentKey: "haddad",
      date: dayOf(anchor, 22),
      scenario: "overlapping-schedule",
    },
    {
      ...base,
      ref: "sc-overlap-existing",
      residentKey: "sorensen",
      date: dayOf(anchor, 22),
      startTime: "12:00",
      endTime: "20:00",
      scenario: "overlapping-schedule",
    },
    {
      ...base,
      ref: "sc-overlap-offer",
      residentKey: "sorensen",
      date: dayOf(anchor, 29),
      scenario: "overlapping-schedule",
    },
  ];
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const DEMO_INVITATIONS: DemoInvitation[] = [
  {
    email: `demo.newcomer@${DEMO_EMAIL_DOMAIN}`,
    role: "resident",
    pgy: 1,
    expiresInDays: 14,
    revoked: false,
    scenario: "invitation-pending",
  },
  {
    email: `demo.lapsed@${DEMO_EMAIL_DOMAIN}`,
    role: "resident",
    pgy: 2,
    expiresInDays: -3,
    revoked: false,
    scenario: "invitation-expired",
  },
  {
    email: `demo.withdrawn@${DEMO_EMAIL_DOMAIN}`,
    role: "resident",
    pgy: 2,
    expiresInDays: 14,
    revoked: true,
    scenario: "invitation-revoked",
  },
];

/** The address a duplicate-invitation attempt should be refused for. */
export const DEMO_EXISTING_MEMBER_EMAIL = `demo.rivera@${DEMO_EMAIL_DOMAIN}`;
