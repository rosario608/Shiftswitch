import { describe, expect, it } from "vitest";
import { buildMailtoUrl, buildSwitchEmail } from "@/server/domain/email";
import type {
  ProgramContactRow,
  ProgramRow,
  ShiftDetail,
} from "@/server/db/types";
import type { CompletedTradeDetail } from "@/server/domain/trades";
import { zonedWallTimeToInstant } from "@/server/domain/time";

const NY = "America/New_York";

const program = {
  id: "program-1",
  name: "Internal Medicine Residency",
  institution: "Riverside University Hospital",
  timezone: NY,
  approved_email_domains: [],
  default_trade_approval_required: false,
  created_at: new Date(),
  updated_at: new Date(),
} satisfies ProgramRow;

function shift(overrides: Partial<ShiftDetail> & { date: string }): ShiftDetail {
  const start = zonedWallTimeToInstant(overrides.date, "19:00", NY);
  const end = zonedWallTimeToInstant("2026-07-16", "07:00", NY);
  return {
    id: "shift-1",
    program_id: "program-1",
    service_id: "service-1",
    rotation_id: null,
    location: "ICU Tower 4",
    shift_type: "night",
    required_pgy_min: 1,
    required_pgy_max: 4,
    tradeable: true,
    approval_required: false,
    trade_deadline: null,
    status: "scheduled",
    created_at: new Date(),
    updated_at: new Date(),
    service_name: "MICU",
    rotation_name: null,
    resident_id: null,
    resident_name: null,
    resident_pgy: null,
    program_timezone: NY,
    start_datetime: start,
    end_datetime: end,
    ...overrides,
  } as ShiftDetail;
}

const trade = {
  id: "trade-1",
  program_id: "program-1",
  source_shift_id: "shift-1",
  destination_shift_id: "shift-2",
  resident_a: "resident-a",
  resident_b: "resident-b",
  previous_assignments: {},
  resulting_assignments: {},
  approval_required: false,
  approved_by: null,
  approved_at: null,
  approval_notes: null,
  override_applied: false,
  validation_snapshot: {},
  trade_request_id: null,
  trade_offer_id: null,
  completed_at: zonedWallTimeToInstant("2026-07-10", "14:30", NY),
  completed_by: null,
  resident_a_name: "Amara Okafor",
  resident_b_name: "Devin Reyes",
  resident_a_email: "resident01@hospital.org",
  resident_b_email: "resident02@hospital.org",
  resident_a_user_id: "user-a",
  resident_b_user_id: "user-b",
  email_status: null,
  email_record_id: null,
  source_shift: shift({ date: "2026-07-15" }),
  destination_shift: shift({
    id: "shift-2",
    date: "2026-07-18",
    service_name: "Floor",
    location: "Ward 6 East",
    start_datetime: zonedWallTimeToInstant("2026-07-18", "07:00", NY),
    end_datetime: zonedWallTimeToInstant("2026-07-18", "19:00", NY),
    shift_type: "day",
  }),
} as unknown as CompletedTradeDetail;

const contacts: ProgramContactRow[] = [
  {
    id: "c1",
    program_id: "program-1",
    name: "Rachel Whitmore",
    email: "coordinator@hospital.org",
    contact_type: "program_coordinator",
    notify_role: "to",
    active: true,
  },
  {
    id: "c2",
    program_id: "program-1",
    name: "Jordan Blake",
    email: "chief@hospital.org",
    contact_type: "chief_resident",
    notify_role: "cc",
    active: true,
  },
  {
    id: "c3",
    program_id: "program-1",
    name: "Dr. Miriam Foss",
    email: "pd@hospital.org",
    contact_type: "program_director",
    notify_role: "none",
    active: true,
  },
  {
    id: "c4",
    program_id: "program-1",
    name: "Retired Coordinator",
    email: "old@hospital.org",
    contact_type: "program_coordinator",
    notify_role: "to",
    active: false,
  },
];

describe("buildSwitchEmail", () => {
  const email = buildSwitchEmail(trade, program, contacts, {
    senderName: "Amara Okafor",
  });

  it("addresses active coordinators and CCs chiefs", () => {
    expect(email.to).toEqual(["coordinator@hospital.org"]);
    expect(email.cc).toEqual(["chief@hospital.org"]);
  });

  it("excludes contacts marked as not notified and inactive contacts", () => {
    expect([...email.to, ...email.cc]).not.toContain("pd@hospital.org");
    expect([...email.to, ...email.cc]).not.toContain("old@hospital.org");
  });

  it("uses the required subject format", () => {
    expect(email.subject).toBe(
      "Shift Switch – Wednesday, July 15, 2026 – MICU",
    );
  });

  it("names both residents and both assignments", () => {
    expect(email.body).toContain("Amara Okafor and Devin Reyes have completed a shift switch.");
    expect(email.body).toContain("Original assignment:");
    expect(email.body).toContain("New assignment:");
    expect(email.body).toContain("Service: MICU");
    expect(email.body).toContain("Service: Floor");
  });

  it("renders the overnight shift as one shift with a next-day marker", () => {
    expect(email.body).toContain("Shift: 7 PM – 7 AM (+1)");
  });

  it("states the application name and completion timestamp", () => {
    expect(email.body).toContain("was completed through");
    expect(email.body).toContain("Jul 10, 2026 at 2:30 PM EDT");
  });

  it("signs off with the sender", () => {
    expect(email.body.trimEnd().endsWith("Amara Okafor")).toBe(true);
  });

  it("mentions the approval when the switch was approved", () => {
    const approved = buildSwitchEmail(
      {
        ...trade,
        approval_required: true,
        approved_at: zonedWallTimeToInstant("2026-07-10", "15:00", NY),
      } as CompletedTradeDetail,
      program,
      contacts,
    );
    expect(approved.body).toContain("Approved by a chief resident");
  });
});

describe("buildMailtoUrl", () => {
  it("encodes recipients, subject and body", () => {
    const url = buildMailtoUrl({
      to: ["coordinator@hospital.org", "second@hospital.org"],
      cc: ["chief@hospital.org"],
      subject: "Shift Switch – July 15 – MICU & Floor",
      body: "Line one\nLine two & three",
    });
    expect(url.startsWith("mailto:coordinator%40hospital.org,second%40hospital.org?")).toBe(
      true,
    );
    expect(url).toContain("cc=chief%40hospital.org");
    expect(url).toContain("subject=Shift%20Switch%20%E2%80%93%20July%2015%20%E2%80%93%20MICU%20%26%20Floor");
    expect(url).toContain("body=Line%20one%0ALine%20two%20%26%20three");
  });

  it("omits the cc parameter when there are no CC recipients", () => {
    const url = buildMailtoUrl({
      to: ["coordinator@hospital.org"],
      cc: [],
      subject: "Subject",
      body: "Body",
    });
    expect(url).not.toContain("cc=");
  });

  it("round-trips through URL parsing", () => {
    const body = "Hello,\n\nA & B swapped: 100% done.\n";
    const url = buildMailtoUrl({
      to: ["a@b.org"],
      cc: [],
      subject: "S",
      body,
    });
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("mailto:");
    expect(new URLSearchParams(parsed.search).get("body")).toBe(body);
  });
});
