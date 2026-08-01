import { describe, expect, it } from "vitest";
import { assertBlocksCoherent, generateBlocks } from "@/server/domain/blocks";
import {
  effectiveMinimum,
  requirementsFor,
  validateCoverage,
  validatePgyMix,
  type CoverageRequirement,
} from "@/server/domain/coverage";
import { formatPhone, normalisePhone } from "@/server/domain/roster";
import { SERVICE_TEMPLATES, findTemplate } from "@/server/domain/service-templates";

/**
 * The pure parts of the scheduling foundation.
 *
 * The single most important property asserted here is that **block length and
 * pairing are configuration**. Several of these tests exist only to demonstrate
 * that a programme unlike Duke's is expressible, because "4+4 is not hardcoded"
 * is a claim that rots the moment somebody adds a convenience constant.
 */

describe("building a block year", () => {
  it("produces the 4+4 pattern from arguments, not from a special case", () => {
    const blocks = generateBlocks({
      startDate: "2026-07-01",
      weeks: 4,
      count: 13,
      kinds: ["Inpatient", "Ambulatory"],
    });
    expect(blocks).toHaveLength(13);
    expect(blocks[0].kind).toBe("Inpatient");
    expect(blocks[1].kind).toBe("Ambulatory");
    expect(blocks[2].kind).toBe("Inpatient");
    // Inclusive end dates: a four-week block is 28 days, ending on day 28.
    expect(blocks[0].startDate).toBe("2026-07-01");
    expect(blocks[0].endDate).toBe("2026-07-28");
    expect(blocks[1].startDate).toBe("2026-07-29");
  });

  it("expresses a two-week programme with the same call", () => {
    const blocks = generateBlocks({ startDate: "2026-07-01", weeks: 2, count: 26 });
    expect(blocks).toHaveLength(26);
    expect(blocks[0].endDate).toBe("2026-07-14");
    expect(blocks[1].startDate).toBe("2026-07-15");
  });

  it("expresses a thirteen-block year with no pairing at all", () => {
    const blocks = generateBlocks({ startDate: "2026-07-01", weeks: 4, count: 13 });
    expect(blocks).toHaveLength(13);
    expect(new Set(blocks.map((block) => block.kind))).toEqual(new Set([""]));
  });

  it("rotates through three kinds, not just two", () => {
    // The "+" in "4+4" is a list of two. Nothing assumes two.
    const blocks = generateBlocks({
      startDate: "2026-07-01",
      weeks: 4,
      count: 6,
      kinds: ["Wards", "Clinic", "Elective"],
    });
    expect(blocks.map((block) => block.kind)).toEqual([
      "Wards",
      "Clinic",
      "Elective",
      "Wards",
      "Clinic",
      "Elective",
    ]);
  });

  it("never generates blocks that overlap", () => {
    for (const weeks of [1, 2, 3, 4, 6, 13]) {
      const blocks = generateBlocks({ startDate: "2026-07-01", weeks, count: 8 });
      expect(() => assertBlocksCoherent(blocks), `weeks=${weeks}`).not.toThrow();
    }
  });

  it("refuses a block length outside a plausible range", () => {
    expect(() => generateBlocks({ startDate: "2026-07-01", weeks: 0, count: 4 })).toThrow(
      /between 1 and 52/,
    );
  });
});

describe("block coherence", () => {
  const base = { kind: "", notes: "" };

  it("catches overlapping blocks, naming both", () => {
    expect(() =>
      assertBlocksCoherent([
        { ...base, sequence: 1, label: "Block 1", startDate: "2026-07-01", endDate: "2026-07-28" },
        { ...base, sequence: 2, label: "Block 2", startDate: "2026-07-20", endDate: "2026-08-16" },
      ]),
    ).toThrow(/Block 1[\s\S]*overlaps[\s\S]*Block 2/);
  });

  it("allows a gap between blocks, because orientation is real", () => {
    expect(() =>
      assertBlocksCoherent([
        { ...base, sequence: 1, label: "Block 1", startDate: "2026-07-08", endDate: "2026-08-04" },
        { ...base, sequence: 2, label: "Block 2", startDate: "2026-08-12", endDate: "2026-09-08" },
      ]),
    ).not.toThrow();
  });

  it("refuses a gap in the numbering", () => {
    expect(() =>
      assertBlocksCoherent([
        { ...base, sequence: 1, label: "Block 1", startDate: "2026-07-01", endDate: "2026-07-28" },
        { ...base, sequence: 3, label: "Block 3", startDate: "2026-07-29", endDate: "2026-08-25" },
      ]),
    ).toThrow(/numbered 1 to 2/);
  });

  it("refuses an empty structure", () => {
    expect(() => assertBlocksCoherent([])).toThrow(/at least one block/);
  });
});

describe("coverage requirements", () => {
  it("accepts an ordinary weekday rule", () => {
    expect(() =>
      validateCoverage({
        serviceId: "s",
        scope: "weekday",
        daysOfWeek: [1, 2, 3, 4, 5],
        minStaff: 2,
      }),
    ).not.toThrow();
  });

  it("refuses a weekday rule with no days", () => {
    expect(() =>
      validateCoverage({ serviceId: "s", scope: "weekday", daysOfWeek: [], minStaff: 1 }),
    ).toThrow(/at least one day/);
  });

  it("refuses a maximum below the minimum, in plain terms", () => {
    expect(() =>
      validateCoverage({
        serviceId: "s",
        scope: "weekday",
        daysOfWeek: [1],
        minStaff: 3,
        maxStaff: 1,
      }),
    ).toThrow(/maximum \(1\) is below the minimum \(3\)/);
  });

  it("refuses a period with no end", () => {
    expect(() =>
      validateCoverage({
        serviceId: "s",
        scope: "period",
        periodStart: "2026-12-24",
        minStaff: 1,
      }),
    ).toThrow(/both a start and an end/);
  });

  it("refuses a PGY mix that no schedule could satisfy", () => {
    // Two PGY-1s and two PGY-2s on a service capped at three.
    expect(() =>
      validatePgyMix(
        [
          { pgy: 1, min: 2, max: null },
          { pgy: 2, min: 2, max: null },
        ],
        1,
        3,
      ),
    ).toThrow(/requires 4 people but the service is capped at 3/);
  });

  it("refuses the same PGY level twice", () => {
    expect(() =>
      validatePgyMix(
        [
          { pgy: 2, min: 1, max: null },
          { pgy: 2, min: 2, max: null },
        ],
        1,
        null,
      ),
    ).toThrow(/PGY-2 is listed twice/);
  });

  it("treats the mix as raising the floor", () => {
    // min_staff says 1, but the mix demands three people.
    expect(
      effectiveMinimum({
        min_staff: 1,
        pgy_mix: [
          { pgy: 1, min: 2, max: null },
          { pgy: 2, min: 1, max: null },
        ],
      }),
    ).toBe(3);
  });
});

describe("which requirement applies on a given day", () => {
  const NY = "America/New_York";
  const make = (
    scope: "weekday" | "period" | "date",
    fields: Partial<CoverageRequirement>,
  ): CoverageRequirement =>
    ({
      id: `${scope}-${fields.label}`,
      program_id: "p",
      service_id: "s",
      scope,
      label: "",
      days_of_week: [],
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
      created_at: new Date(),
      ...fields,
    }) as CoverageRequirement;

  const weekday = make("weekday", {
    label: "ordinary",
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    min_staff: 4,
  });
  const period = make("period", {
    label: "holidays",
    period_start: new Date("2026-12-24T00:00:00Z"),
    period_end: new Date("2027-01-01T00:00:00Z"),
    min_staff: 2,
  });
  const christmas = make("date", {
    label: "christmas",
    specific_date: new Date("2026-12-25T00:00:00Z"),
    min_staff: 1,
  });

  const all = [christmas, period, weekday];

  it("uses the weekday rule on an ordinary day", () => {
    const applied = requirementsFor(all, new Date("2026-09-15T12:00:00Z"), NY);
    expect(applied.map((r) => r.label)).toEqual(["ordinary"]);
  });

  it("uses the period rule inside the holiday block", () => {
    const applied = requirementsFor(all, new Date("2026-12-28T12:00:00Z"), NY);
    expect(applied.map((r) => r.label)).toEqual(["holidays"]);
  });

  it("uses the named date on that date, replacing rather than adding", () => {
    // The point: Christmas needs one person, not one plus the usual four.
    const applied = requirementsFor(all, new Date("2026-12-25T12:00:00Z"), NY);
    expect(applied.map((r) => r.label)).toEqual(["christmas"]);
    expect(applied[0].min_staff).toBe(1);
  });

  it("selects the weekday by the programme's timezone, not UTC", () => {
    // 03:00 UTC on Monday is still Sunday evening in New York.
    const sundayOnly = [make("weekday", { label: "sunday", days_of_week: [0], min_staff: 1 })];
    const applied = requirementsFor(sundayOnly, new Date("2026-09-14T03:00:00Z"), NY);
    expect(applied.map((r) => r.label)).toEqual(["sunday"]);
  });
});

describe("phone numbers", () => {
  it("normalises the shapes a scheduler actually pastes", () => {
    for (const input of ["9195550142", "(919) 555-0142", "919-555-0142", "919.555.0142"]) {
      expect(normalisePhone(input), input).toBe("+19195550142");
    }
    expect(normalisePhone("19195550142")).toBe("+19195550142");
  });

  it("keeps an international number as given rather than mangling it", () => {
    expect(normalisePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("treats empty as empty rather than an error", () => {
    expect(normalisePhone("")).toBe("");
    expect(normalisePhone("   ")).toBe("");
  });

  it("explains what is wrong, with the count", () => {
    expect(() => normalisePhone("555")).toThrow(/has 3 digits/);
    expect(() => normalisePhone("919-555-CALL")).toThrow(/not part of a phone number/);
  });

  it("formats for display and round-trips", () => {
    expect(formatPhone(normalisePhone("9195550142"))).toBe("(919) 555-0142");
    // An international number has no US shape to impose, so it is shown as-is.
    expect(formatPhone("+442079460958")).toBe("+442079460958");
  });
});

describe("the service template", () => {
  it("offers Duke Internal Medicine with the services a programme recognises", () => {
    const template = findTemplate("duke-internal-medicine");
    expect(template).not.toBeNull();
    const names = template!.services.map((service) => service.name);
    for (const expected of [
      "General Medicine Wards",
      "Medical Intensive Care Unit",
      "Cardiac Intensive Care Unit",
      "Cardiology",
      "Malignant Hematology",
      "Neurology",
      "Emergency Department",
      "Night Medicine",
      "Day Float",
      "Ambulatory Clinic",
      "Consults",
      "Elective",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("includes the VA and a community site, not just the main hospital", () => {
    const template = findTemplate("duke-internal-medicine")!;
    expect(template.sites.map((site) => site.abbreviation)).toContain("VA");
    const vaServices = template.services.filter((service) => service.site.includes("VA"));
    expect(vaServices.length).toBeGreaterThan(0);
  });

  it("presents itself as a starting point rather than as correct", () => {
    // The wording is the feature: a template accepted as authoritative at 11pm
    // is how a programme ends up with the wrong MICU staffing all year.
    const template = findTemplate("duke-internal-medicine")!;
    expect(template.description).toMatch(/starting point/i);
  });

  it("marks continuity clinic non-tradeable and electives unmandated", () => {
    const template = findTemplate("duke-internal-medicine")!;
    const clinic = template.services.find((s) => s.name === "Ambulatory Clinic")!;
    expect(clinic.tradeable).toBe(false);
    const elective = template.services.find((s) => s.name === "Elective")!;
    expect(elective.coverageMandatory).toBe(false);
    expect(elective.coverage).toHaveLength(0);
  });

  it("never overnights an intern alone", () => {
    const template = findTemplate("duke-internal-medicine")!;
    const nights = template.services.find((s) => s.name === "Night Medicine")!;
    const overnight = nights.coverage[0];
    const senior = overnight.pgyMix?.find((entry) => entry.pgy >= 2);
    expect(senior?.min).toBeGreaterThanOrEqual(1);
  });

  it("has coverage every template service can satisfy", () => {
    for (const template of SERVICE_TEMPLATES) {
      for (const service of template.services) {
        for (const coverage of service.coverage) {
          expect(() =>
            validatePgyMix(
              coverage.pgyMix ?? [],
              coverage.minStaff,
              coverage.maxStaff ?? null,
            ),
            `${service.name} / ${coverage.label}`,
          ).not.toThrow();
        }
      }
    }
  });
});
