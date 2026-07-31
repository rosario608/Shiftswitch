import { describe, expect, it } from "vitest";
import { scoreMatch } from "@/server/domain/matching";
import { makeShift, NY } from "./factories";

const program = { timezone: NY };

describe("scoreMatch", () => {
  it("scores an ideal same-service, same-type, nearby swap highly", () => {
    const result = scoreMatch({
      request: { preferences: { preferredDates: ["2026-07-18"] } },
      sourceShift: makeShift({ date: "2026-07-15" }),
      candidateShift: makeShift({ date: "2026-07-18" }),
      viewerPgy: 2,
      program,
    });
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.reasons).toContain("Same service");
    expect(result.reasons).toContain("Preferred date");
    expect(result.reasons).toContain("Eligible PGY");
  });

  it("scores a mismatched swap lower and explains why", () => {
    const result = scoreMatch({
      request: { preferences: { preferredDates: ["2026-07-18"] } },
      sourceShift: makeShift({ date: "2026-07-15" }),
      candidateShift: makeShift({
        date: "2026-09-02",
        serviceId: "service-cards",
        serviceName: "Cardiology",
        shiftType: "night",
      }),
      viewerPgy: 2,
      program,
    });
    expect(result.score).toBeLessThan(85);
    expect(result.caveats.join(" ")).toContain("Different service");
    expect(result.caveats.join(" ")).toContain("Outside their preferred dates");
  });

  it("does not award the eligibility bonus when the PGY is out of range", () => {
    const eligible = scoreMatch({
      request: { preferences: {} },
      sourceShift: makeShift({ date: "2026-07-15", requiredPgyMin: 2, requiredPgyMax: 4 }),
      candidateShift: makeShift({ date: "2026-07-18" }),
      viewerPgy: 3,
      program,
    });
    const ineligible = scoreMatch({
      request: { preferences: {} },
      sourceShift: makeShift({ date: "2026-07-15", requiredPgyMin: 2, requiredPgyMax: 4 }),
      candidateShift: makeShift({ date: "2026-07-18" }),
      viewerPgy: 1,
      program,
    });
    expect(eligible.score).toBeGreaterThan(ineligible.score);
    expect(ineligible.reasons).not.toContain("Eligible PGY");
  });

  it("rewards the exact shift the poster asked for", () => {
    const candidate = makeShift({ date: "2026-07-18" });
    const targeted = scoreMatch({
      request: { preferences: { desiredShiftId: candidate.id } },
      sourceShift: makeShift({ date: "2026-07-15" }),
      candidateShift: candidate,
      viewerPgy: 2,
      program,
    });
    const untargeted = scoreMatch({
      request: { preferences: {} },
      sourceShift: makeShift({ date: "2026-07-15" }),
      candidateShift: candidate,
      viewerPgy: 2,
      program,
    });
    expect(targeted.score).toBeGreaterThan(untargeted.score);
    expect(targeted.reasons).toContain("Exactly the shift they asked for");
  });

  it("flags picking up a night shift as a caveat", () => {
    const result = scoreMatch({
      request: { preferences: {} },
      sourceShift: makeShift({ date: "2026-07-15", shiftType: "night" }),
      candidateShift: makeShift({ date: "2026-07-18" }),
      viewerPgy: 2,
      program,
    });
    expect(result.caveats).toContain("You would pick up a night shift");
  });

  it("never produces a score outside 0-100", () => {
    const candidate = makeShift({ date: "2026-07-18" });
    const result = scoreMatch({
      request: {
        preferences: {
          desiredShiftId: candidate.id,
          preferredDates: ["2026-07-18"],
          preferredServiceIds: [candidate.serviceId],
          preferredShiftTypes: [candidate.shiftType],
        },
      },
      sourceShift: makeShift({ date: "2026-07-15" }),
      candidateShift: candidate,
      viewerPgy: 2,
      program,
    });
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
