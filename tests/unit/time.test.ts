import { describe, expect, it } from "vitest";
import {
  InvalidZonedTimeError,
  addLocalDays,
  coveredLocalDates,
  durationHours,
  formatShiftRange,
  isNightShift,
  isOvernight,
  isWeekendLocal,
  localDateString,
  localDayDiff,
  longestConsecutiveRun,
  maxCountInRollingWindow,
  overlaps,
  restHoursBetween,
  zonedWallTimeToInstant,
} from "@/server/domain/time";

const NY = "America/New_York";

describe("zonedWallTimeToInstant", () => {
  it("converts a wall time in the program timezone to the right instant", () => {
    // 2026-07-15 07:00 EDT = 11:00 UTC
    const instant = zonedWallTimeToInstant("2026-07-15", "07:00", NY);
    expect(instant.toISOString()).toBe("2026-07-15T11:00:00.000Z");
  });

  it("uses standard time outside daylight saving", () => {
    // 2026-01-15 07:00 EST = 12:00 UTC
    expect(zonedWallTimeToInstant("2026-01-15", "07:00", NY).toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    );
  });

  it("rejects a wall time that does not exist in the spring-forward gap", () => {
    // 2027-03-14 02:30 does not exist in America/New_York.
    expect(() => zonedWallTimeToInstant("2027-03-14", "02:30", NY)).toThrow(
      InvalidZonedTimeError,
    );
  });

  it("resolves an ambiguous fall-back time to the first (DST) occurrence", () => {
    // 2026-11-01 01:30 happens twice; the first is 05:30 UTC (EDT).
    expect(zonedWallTimeToInstant("2026-11-01", "01:30", NY).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("rejects an unknown timezone", () => {
    expect(() => zonedWallTimeToInstant("2026-07-15", "07:00", "Mars/Olympus")).toThrow(
      InvalidZonedTimeError,
    );
  });
});

describe("overnight shifts", () => {
  const start = zonedWallTimeToInstant("2026-07-15", "19:00", NY);
  const end = zonedWallTimeToInstant("2026-07-16", "07:00", NY);

  it("is a single 12-hour shift spanning midnight", () => {
    expect(durationHours(start, end)).toBe(12);
    expect(isOvernight(start, end, NY)).toBe(true);
    expect(isNightShift(start, end, NY)).toBe(true);
  });

  it("keeps its start date as the shift's calendar date", () => {
    expect(localDateString(start, NY)).toBe("2026-07-15");
    expect(localDateString(end, NY)).toBe("2026-07-16");
  });

  it("covers both calendar dates", () => {
    expect(coveredLocalDates(start, end, NY)).toEqual(["2026-07-15", "2026-07-16"]);
  });

  it("renders with a next-day marker", () => {
    expect(formatShiftRange(start, end, NY)).toBe("7 PM – 7 AM (+1)");
  });

  it("does not count a shift ending exactly at midnight as the next day", () => {
    const evening = zonedWallTimeToInstant("2026-07-15", "12:00", NY);
    const midnight = zonedWallTimeToInstant("2026-07-16", "00:00", NY);
    expect(coveredLocalDates(evening, midnight, NY)).toEqual(["2026-07-15"]);
  });
});

describe("daylight saving transitions", () => {
  it("a 19:00–07:00 shift across fall-back is 13 hours of real time", () => {
    // Clocks go back one hour at 02:00 on 2026-11-01 in America/New_York.
    const start = zonedWallTimeToInstant("2026-10-31", "19:00", NY);
    const end = zonedWallTimeToInstant("2026-11-01", "07:00", NY);
    expect(durationHours(start, end)).toBe(13);
    expect(isOvernight(start, end, NY)).toBe(true);
  });

  it("a 19:00–07:00 shift across spring-forward is 11 hours of real time", () => {
    // Clocks jump forward one hour at 02:00 on 2027-03-14.
    const start = zonedWallTimeToInstant("2027-03-13", "19:00", NY);
    const end = zonedWallTimeToInstant("2027-03-14", "07:00", NY);
    expect(durationHours(start, end)).toBe(11);
  });

  it("computes rest across a DST boundary in real hours, not calendar hours", () => {
    const previousEnd = zonedWallTimeToInstant("2026-11-01", "07:00", NY);
    const nextStart = zonedWallTimeToInstant("2026-11-01", "19:00", NY);
    expect(restHoursBetween(previousEnd, nextStart)).toBe(12);
  });

  it("keeps the same wall-clock start hour on either side of a transition", () => {
    const before = zonedWallTimeToInstant("2026-10-30", "07:00", NY);
    const after = zonedWallTimeToInstant("2026-11-02", "07:00", NY);
    expect(before.toISOString()).toBe("2026-10-30T11:00:00.000Z");
    expect(after.toISOString()).toBe("2026-11-02T12:00:00.000Z");
  });
});

describe("rest and overlap", () => {
  it("computes positive rest between shifts", () => {
    const end = zonedWallTimeToInstant("2026-07-15", "19:00", NY);
    const nextStart = zonedWallTimeToInstant("2026-07-16", "07:00", NY);
    expect(restHoursBetween(end, nextStart)).toBe(12);
  });

  it("computes negative rest when shifts overlap", () => {
    const end = zonedWallTimeToInstant("2026-07-15", "19:00", NY);
    const nextStart = zonedWallTimeToInstant("2026-07-15", "12:00", NY);
    expect(restHoursBetween(end, nextStart)).toBe(-7);
  });

  it("detects overlapping intervals", () => {
    const aStart = zonedWallTimeToInstant("2026-07-15", "07:00", NY);
    const aEnd = zonedWallTimeToInstant("2026-07-15", "19:00", NY);
    const bStart = zonedWallTimeToInstant("2026-07-15", "18:00", NY);
    const bEnd = zonedWallTimeToInstant("2026-07-16", "06:00", NY);
    expect(overlaps(aStart, aEnd, bStart, bEnd)).toBe(true);
    expect(overlaps(aStart, aEnd, aEnd, bEnd)).toBe(false);
  });
});

describe("calendar helpers", () => {
  it("counts the longest consecutive run of days", () => {
    expect(
      longestConsecutiveRun([
        "2026-07-01",
        "2026-07-02",
        "2026-07-03",
        "2026-07-05",
        "2026-07-06",
      ]),
    ).toBe(3);
  });

  it("treats duplicate dates as one day", () => {
    expect(longestConsecutiveRun(["2026-07-01", "2026-07-01", "2026-07-02"])).toBe(2);
  });

  it("returns zero for no dates", () => {
    expect(longestConsecutiveRun([])).toBe(0);
  });

  it("counts the busiest rolling window", () => {
    const days = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-20"].map((date) =>
      zonedWallTimeToInstant(date, "07:00", NY),
    );
    expect(maxCountInRollingWindow(days, 7)).toBe(3);
    expect(maxCountInRollingWindow(days, 30)).toBe(4);
  });

  it("adds and diffs local dates", () => {
    expect(addLocalDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(localDayDiff("2026-07-01", "2026-07-08")).toBe(7);
  });

  it("identifies weekends in the program timezone", () => {
    // 2026-07-18 is a Saturday.
    expect(isWeekendLocal(zonedWallTimeToInstant("2026-07-18", "07:00", NY), NY)).toBe(
      true,
    );
    expect(isWeekendLocal(zonedWallTimeToInstant("2026-07-20", "07:00", NY), NY)).toBe(
      false,
    );
    // A Sunday 23:00 shift in New York is already Monday in UTC — the program
    // timezone must decide.
    expect(isWeekendLocal(zonedWallTimeToInstant("2026-07-19", "23:00", NY), NY)).toBe(
      true,
    );
  });

  it("classifies day versus night shifts", () => {
    const dayStart = zonedWallTimeToInstant("2026-07-15", "07:00", NY);
    const dayEnd = zonedWallTimeToInstant("2026-07-15", "19:00", NY);
    expect(isNightShift(dayStart, dayEnd, NY)).toBe(false);
  });
});
