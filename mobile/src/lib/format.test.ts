import { describe, expect, it } from "vitest";
import {
  formatShiftWindow,
  formatTime,
  isOvernight,
  relativeTime,
  statusLabel,
} from "./format";

/**
 * Times are the one thing this app cannot get wrong. A resident who reads
 * "7:00 AM" and arrives at 8 because their phone was on a different timezone
 * has been failed by the software.
 */
describe("formatting in the program timezone", () => {
  const NY = "America/New_York";

  it("formats in the program timezone, not the device's", () => {
    // 12:00 UTC is 07:00 in New York (EST) on this date.
    expect(formatTime("2026-01-15T12:00:00.000Z", NY)).toBe("7:00 AM");
    // The same instant, read in the program's zone, wherever the phone is.
    expect(formatTime("2026-01-15T12:00:00.000Z", "Asia/Tokyo")).toBe("9:00 PM");
  });

  it("handles the spring-forward transition", () => {
    // 2026-03-08 is the US spring-forward date; 06:59 UTC is 01:59 EST and
    // 07:00 UTC is 03:00 EDT — the 2am hour does not exist.
    expect(formatTime("2026-03-08T06:59:00.000Z", NY)).toBe("1:59 AM");
    expect(formatTime("2026-03-08T07:00:00.000Z", NY)).toBe("3:00 AM");
  });

  it("handles the autumn fall-back, where 1am happens twice", () => {
    expect(formatTime("2026-11-01T05:00:00.000Z", NY)).toBe("1:00 AM");
    expect(formatTime("2026-11-01T06:00:00.000Z", NY)).toBe("1:00 AM");
  });

  it("shows both dates for an overnight shift", () => {
    const start = "2026-01-15T24:00:00.000Z"; // 19:00 EST on the 15th
    const overnight = formatShiftWindow(
      "2026-01-16T00:00:00.000Z",
      "2026-01-16T12:00:00.000Z",
      NY,
    );
    expect(overnight).toContain("Thu, Jan 15");
    expect(overnight).toContain("Fri, Jan 16");
    expect(isOvernight("2026-01-16T00:00:00.000Z", "2026-01-16T12:00:00.000Z", NY)).toBe(
      true,
    );
    expect(start).toBeTruthy();
  });

  it("keeps a same-day shift on one date", () => {
    const window = formatShiftWindow(
      "2026-01-15T12:00:00.000Z",
      "2026-01-16T00:00:00.000Z",
      NY,
    );
    expect(window).toBe("Thu, Jan 15 · 7:00 AM – 7:00 PM");
    expect(isOvernight("2026-01-15T12:00:00.000Z", "2026-01-16T00:00:00.000Z", NY)).toBe(
      false,
    );
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-01-15T12:00:00.000Z");

  it("describes the near future and the near past", () => {
    expect(relativeTime("2026-01-15T12:30:00.000Z", now)).toBe("in 30 minutes");
    expect(relativeTime("2026-01-15T11:30:00.000Z", now)).toBe("30 minutes ago");
    expect(relativeTime("2026-01-18T12:00:00.000Z", now)).toBe("in 3 days");
    expect(relativeTime("2026-01-14T12:00:00.000Z", now)).toBe("yesterday");
  });

  it("returns nothing for an unparseable value rather than 'Invalid Date'", () => {
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("statusLabel", () => {
  it("gives every workflow status a human label", () => {
    expect(statusLabel("pending_approval")).toBe("Awaiting approval");
    expect(statusLabel("offer_pending")).toBe("Offers received");
    expect(statusLabel("invalidated")).toBe("No longer valid");
  });

  it("degrades readably for an unknown status", () => {
    expect(statusLabel("some_new_state")).toBe("some new state");
  });
});
