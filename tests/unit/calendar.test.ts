import { describe, expect, it } from "vitest";
import { buildCalendar } from "@/server/domain/calendar";
import type { ShiftDetail } from "@/server/db/types";

/**
 * The iCalendar document, checked without a database.
 *
 * `tests/integration/mobile-backend.test.ts` already proves the feed serves the
 * right resident's shifts and dies with the token. What it cannot cheaply do is
 * drive the *format* into its corners: a line over 75 octets, a location
 * containing the two characters the specification reserves, and a shift that
 * stopped being the resident's. Those are pure-function questions and they are
 * where the format goes wrong.
 *
 * The one that matters clinically is the last. A resident who gives a shift
 * away and whose phone keeps showing it is the failure the feed can cause that
 * no other screen in the product can, because a screen is re-read and a
 * subscription is reconciled.
 */

let counter = 0;

function makeShiftDetail(overrides: Partial<ShiftDetail> = {}): ShiftDetail {
  counter += 1;
  const start = new Date("2026-08-10T11:00:00Z");
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    program_id: "program-1",
    service_id: "service-micu",
    rotation_id: null,
    date: "2026-08-10",
    start_datetime: start,
    end_datetime: new Date("2026-08-10T23:00:00Z"),
    location: "ICU Tower 4",
    shift_type: "day",
    required_pgy_min: 1,
    required_pgy_max: 4,
    tradeable: true,
    approval_required: false,
    trade_deadline: null,
    status: "scheduled",
    provenance: "self_reported",
    position_id: null,
    team_id: null,
    confirmed_by: null,
    confirmed_at: null,
    created_at: start,
    updated_at: start,
    service_name: "MICU",
    rotation_name: null,
    resident_id: "resident-1",
    resident_name: "Alice Adeyemi",
    resident_pgy: 2,
    program_timezone: "America/New_York",
    ...overrides,
  };
}

const OPTIONS = {
  programName: "Demo Residency",
  residentName: "Alice Adeyemi",
  timezone: "America/New_York",
  appUrl: "https://shiftswitch.example",
};

/** Every content line, with the specification's folding undone. */
function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter(Boolean);
}

function eventFor(ics: string, shiftId: string): string[] {
  const lines = unfold(ics);
  const start = lines.findIndex((line) => line === `UID:shift-${shiftId}@shiftswitch`);
  expect(start, `no event for ${shiftId}`).toBeGreaterThan(-1);
  const end = lines.indexOf("END:VEVENT", start);
  return lines.slice(start, end);
}

describe("the iCalendar document", () => {
  it("wraps the events in a calendar that tells clients how often to poll", () => {
    const ics = buildCalendar([makeShiftDetail()], OPTIONS);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(ics).toContain("X-PUBLISHED-TTL:PT1H");
  });

  it("ends every line with CRLF and folds at 75 octets", () => {
    const ics = buildCalendar(
      [makeShiftDetail({ location: "Cardiothoracic Intensive Care Unit, Tower 4, Level 3, Bay B" })],
      OPTIONS,
    );
    /* A bare LF anywhere means a line was emitted without the separator the
       specification requires, and clients differ wildly in whether they
       tolerate it. */
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
    for (const line of ics.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    // Folding is presentation only: the value survives being put back together.
    expect(unfold(ics).some((line) => line.includes("Level 3, Bay B") || line.includes("Level 3\\, Bay B"))).toBe(true);
  });

  it("escapes the characters that would otherwise end a property early", () => {
    const ics = buildCalendar(
      [makeShiftDetail({ location: "Ward 6; East, Room 12" })],
      OPTIONS,
    );
    const unfolded = unfold(ics).join("\n");
    expect(unfolded).toContain("Ward 6\\; East\\, Room 12");
  });

  it("keeps a stable UID so a changed shift updates rather than duplicating", () => {
    const shift = makeShiftDetail();
    const first = buildCalendar([shift], OPTIONS);
    const moved = buildCalendar(
      [{ ...shift, start_datetime: new Date("2026-08-10T13:00:00Z") }],
      OPTIONS,
    );
    expect(first).toContain(`UID:shift-${shift.id}@shiftswitch`);
    expect(moved).toContain(`UID:shift-${shift.id}@shiftswitch`);
    expect(first.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(moved.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("publishes shift times as UTC instants", () => {
    const ics = buildCalendar([makeShiftDetail()], OPTIONS);
    expect(ics).toContain("DTSTART:20260810T110000Z");
    expect(ics).toContain("DTEND:20260810T230000Z");
  });

  it("alarms before a shift the resident works, when asked to", () => {
    const withAlarm = buildCalendar([makeShiftDetail()], {
      ...OPTIONS,
      reminderMinutes: 60,
    });
    expect(withAlarm).toContain("TRIGGER:-PT60M");
    expect(buildCalendar([makeShiftDetail()], OPTIONS)).not.toContain("BEGIN:VALARM");
  });
});

describe("a shift that stopped being the resident's", () => {
  it("is published as cancelled rather than dropped", () => {
    const gone = makeShiftDetail();
    const ics = buildCalendar([], { ...OPTIONS, released: [gone] });
    const event = eventFor(ics, gone.id);

    expect(event).toContain("STATUS:CANCELLED");
    /* Bumped, because a client that already cached the confirmed event is
       entitled to ignore an update at the same sequence — and this is the one
       update it must not ignore. */
    expect(event).toContain("SEQUENCE:1");
    // It no longer blocks the resident's time: they are free then, that is the point.
    expect(event).toContain("TRANSP:TRANSPARENT");
  });

  it("never alarms, so a phone does not buzz for a shift somebody else works", () => {
    const gone = makeShiftDetail();
    const ics = buildCalendar([], {
      ...OPTIONS,
      reminderMinutes: 60,
      released: [gone],
    });
    expect(ics).not.toContain("BEGIN:VALARM");
  });

  it("says so in words, for whoever opens the struck-through event", () => {
    const gone = makeShiftDetail();
    const ics = buildCalendar([], { ...OPTIONS, released: [gone] });
    expect(eventFor(ics, gone.id).join("\n")).toContain("This shift is no longer yours.");
  });

  it("names nobody else — the token is not a session", () => {
    const gone = makeShiftDetail({ resident_name: "Bhavna Rao", resident_id: "resident-2" });
    const ics = buildCalendar([], { ...OPTIONS, released: [gone] });
    expect(ics).not.toContain("Bhavna");
  });

  it("keeps the shift live when the resident took it back", () => {
    /* Both lists can name the same shift if a resident gave one away and
       later picked it up again. Working it wins: a cancellation published for
       a shift somebody is on is the same defect pointed the other way. */
    const shift = makeShiftDetail();
    const ics = buildCalendar([shift], { ...OPTIONS, released: [shift] });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(eventFor(ics, shift.id)).toContain("STATUS:CONFIRMED");
  });

  it("carries a cancelled shift the resident still holds", () => {
    /* The other way a calendar goes stale: nobody switched anything, a
       scheduler cancelled the shift outright. */
    const cancelled = makeShiftDetail({ status: "cancelled" });
    const ics = buildCalendar([cancelled], { ...OPTIONS, reminderMinutes: 60 });
    expect(eventFor(ics, cancelled.id)).toContain("STATUS:CANCELLED");
    expect(ics).not.toContain("BEGIN:VALARM");
  });
});
