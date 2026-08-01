import { describe, expect, it } from "vitest";
import {
  addDays,
  applyExceptions,
  daysBetween,
  q3CallCycle,
  stateOn,
  statesOver,
  weekdayCycle,
  type PatternException,
  type RotationState,
} from "@/server/domain/rotation-cycles";

/**
 * The cycle, checked against the weeks the programmes actually published.
 *
 * Each case here is a line from a real schedule rather than an invented one,
 * because the reason this replaced a weekday/weekend table is that the real
 * schedules do not fit a weekday/weekend table.
 */

const pattern = (states: RotationState[], anchor = "2026-07-01") => ({
  states,
  anchor_date: new Date(`${anchor}T00:00:00Z`),
});

describe("q3 twenty-four-hour call, which is what VA MICU is annotated", () => {
  const q3 = pattern(q3CallCycle());

  it("repeats every third day from its anchor", () => {
    expect(stateOn(q3, "2026-07-01")).toBe("on");
    expect(stateOn(q3, "2026-07-02")).toBe("post");
    expect(stateOn(q3, "2026-07-03")).toBe("pre");
    expect(stateOn(q3, "2026-07-04")).toBe("on");
    expect(stateOn(q3, "2026-07-31")).toBe("on");
  });

  it("puts two people on the same service on different days, via the offset", () => {
    /* The whole content of an offset: two residents on one q3 service are two
       days apart, and neither needs a pattern of their own. */
    expect(stateOn(q3, "2026-07-01", 0)).toBe("on");
    expect(stateOn(q3, "2026-07-01", 1)).toBe("post");
    expect(stateOn(q3, "2026-07-01", 2)).toBe("pre");
    // And on the day the first is on call, the third is pre-call, ready.
    expect(stateOn(q3, "2026-07-04", 2)).toBe("pre");
  });

  it("says which kind of day it is, not whether somebody is working", () => {
    /* A q3 resident works every day. `pre` and `post` are worked days with
       different hours, which is exactly why they cannot be folded into `on` —
       and why a cycle of "on, off, off" would be a different service. */
    const week = statesOver(q3, "2026-07-01", "2026-07-07");
    expect(week.every((day) => day.state !== "off")).toBe(true);
    expect(new Set(week.map((day) => day.state))).toEqual(
      new Set(["on", "post", "pre"]),
    );
  });

  it("walks through the week rather than lining up with it", () => {
    /* The property a weekday table cannot express: the same cycle position
       lands on a different weekday each week, and only realigns every three. */
    const first = statesOver(q3, "2026-07-01", "2026-07-07").map((d) => d.state);
    const second = statesOver(q3, "2026-07-08", "2026-07-14").map((d) => d.state);
    expect(first).not.toEqual(second);
    const fourth = statesOver(q3, "2026-07-22", "2026-07-28").map((d) => d.state);
    expect(first).toEqual(fourth);
  });
});

describe("a date before the cycle's anchor", () => {
  it("does not go backwards through a negative index", () => {
    /* The bug every naive modulo has. Its symptom is a resident told they are
       off on a day they are on call, which is the worst thing this file could
       get wrong. */
    const q3 = pattern(q3CallCycle(), "2026-07-01");
    expect(stateOn(q3, "2026-06-30")).toBe("pre");
    expect(stateOn(q3, "2026-06-29")).toBe("post");
    expect(stateOn(q3, "2026-06-28")).toBe("on");
    for (const date of ["2026-01-01", "2025-12-31", "2020-02-29"]) {
      expect(["on", "post", "pre"]).toContain(stateOn(q3, date));
    }
  });
});

describe("the weekly case, which is still a case", () => {
  it("expresses Monday-to-Friday as a seven-day cycle", () => {
    /* 2026-07-06 is a Monday. A service that genuinely runs weekdays is not a
       different kind of thing; it is a cycle whose last two states are off. */
    const weekly = pattern(weekdayCycle(), "2026-07-06");
    const week = statesOver(weekly, "2026-07-06", "2026-07-12").map((d) => d.state);
    expect(week).toEqual(["on", "on", "on", "on", "on", "off", "off"]);
    // And it repeats, aligned to the week, because its length is seven.
    expect(statesOver(weekly, "2026-07-13", "2026-07-19").map((d) => d.state)).toEqual(
      week,
    );
  });

  it("expresses a rotating day off, which a weekday table cannot", () => {
    /* VA general medicine: off Wednesday one week, Saturday the next. That is a
       fourteen-day cycle, and there is no weekly table that holds it. */
    const states: RotationState[] = [
      "on", "on", "off", "on", "on", "on", "on",
      "on", "on", "on", "on", "on", "off", "on",
    ];
    const fortnight = pattern(states, "2026-07-06");
    const days = statesOver(fortnight, "2026-07-06", "2026-07-19");
    expect(days.find((d) => d.date === "2026-07-08")!.state).toBe("off");
    expect(days.find((d) => d.date === "2026-07-18")!.state).toBe("off");
    expect(days.filter((d) => d.state === "off")).toHaveLength(2);
  });
});

describe("counting days across a clock change", () => {
  it("advances by exactly one over the spring forward", () => {
    /* A cycle counts civil days, not 24-hour periods. In America/New_York the
       clocks go forward on 2026-03-08; the day after it is still one day later,
       which is what somebody means by "tomorrow I'm post-call". */
    expect(daysBetween("2026-03-07", "2026-03-08")).toBe(1);
    expect(daysBetween("2026-03-08", "2026-03-09")).toBe(1);
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");

    const q3 = pattern(q3CallCycle(), "2026-03-07");
    expect(stateOn(q3, "2026-03-07")).toBe("on");
    expect(stateOn(q3, "2026-03-08")).toBe("post");
    expect(stateOn(q3, "2026-03-09")).toBe("pre");
  });

  it("advances by exactly one over the autumn back, where a day has 25 hours", () => {
    expect(daysBetween("2026-11-01", "2026-11-02")).toBe(1);
    const q3 = pattern(q3CallCycle(), "2026-10-31");
    expect(stateOn(q3, "2026-11-01")).toBe("post");
    expect(stateOn(q3, "2026-11-02")).toBe("pre");
  });

  it("counts a leap day", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });
});

describe("an exception over the pattern", () => {
  const q3 = pattern(q3CallCycle(), "2026-12-01");
  const days = statesOver(q3, "2026-12-20", "2027-01-03");

  it("replaces the pattern for its range and says why", () => {
    const holiday: PatternException = {
      id: "x",
      starts_on: new Date("2026-12-24T00:00:00Z"),
      ends_on: new Date("2027-01-01T00:00:00Z"),
      replacement_states: ["off", "off", "on"],
      reason: "Winter holiday block",
    };
    const applied = applyExceptions(days, [holiday]);

    const christmasEve = applied.find((d) => d.date === "2026-12-24")!;
    expect(christmasEve.state).toBe("off");
    expect(christmasEve.exception).toBe("Winter holiday block");

    // Outside the range the normal pattern is untouched.
    const before = applied.find((d) => d.date === "2026-12-23")!;
    expect(before.exception).toBeUndefined();
    expect(before.state).toBe(stateOn(q3, "2026-12-23"));
  });

  it("means 'nobody has said' rather than 'off' when it replaces with nothing", () => {
    /* The holiday roster is entered by hand. A day inside it is not a day off —
       it is a day nothing should be generated over, and the two must not be
       confused by anything that schedules against this. */
    const blank: PatternException = {
      id: "x",
      starts_on: new Date("2026-12-24T00:00:00Z"),
      ends_on: new Date("2027-01-01T00:00:00Z"),
      replacement_states: null,
      reason: "Holiday roster is entered by hand",
    };
    const applied = applyExceptions(days, [blank]);
    const inside = applied.find((d) => d.date === "2026-12-28")!;
    expect(inside.state).toBeNull();
    expect(inside.exception).toMatch(/by hand/);
    expect(applied.filter((d) => d.state === null)).toHaveLength(9);
  });
});
