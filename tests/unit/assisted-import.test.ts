import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contentFor,
  extractSchedule,
  mediaKindOf,
  parseExtraction,
  pdfPageCount,
  UnreadableFileError,
} from "@/server/domain/assisted-import/extract";
import { assistedImportLimits, costMicros } from "@/server/domain/assisted-import/limits";
import { needsReview } from "@/server/domain/assisted-import/store";
import { modelTransport } from "@/server/domain/assisted-import/transport";
import {
  FailingTransport,
  MERGED_WEEK,
  MONTH_CALENDAR,
  PROSE_NOT_JSON,
  ReplayTransport,
  ROTATION_GRID,
  SCREENSHOT,
  UNREADABLE,
} from "../fixtures/assisted-import/responses";

/**
 * The half of assisted import that runs without a database.
 *
 * Nothing here reaches the network: every test substitutes a transport that
 * replays a fixture. That is what keeps `npm run verify` offline and
 * deterministic, and it is the reason the transport is a seam rather than a
 * function call to a client library.
 *
 * The four fixture files are the shapes programmes actually send — see
 * `scripts/make-import-fixtures.ts` for what each one *is*.
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "assisted-import");
const read = (name: string) => readFileSync(path.join(FIXTURES, name));

describe("which files can be read at all", () => {
  it("recognises the four shapes", () => {
    expect(mediaKindOf("block-3.xlsx")).toBe("spreadsheet");
    expect(mediaKindOf("schedule.csv")).toBe("csv");
    expect(mediaKindOf("august.pdf")).toBe("pdf");
    expect(mediaKindOf("IMG_4021.PNG")).toBe("image");
  });

  it("refuses anything else by name, before reading a byte", () => {
    expect(() => mediaKindOf("schedule.docx")).toThrowError(/cannot read a "docx" file/);
    expect(() => mediaKindOf("schedule")).toThrowError(/has no file extension/);
  });
});

describe("what gets sent, per shape", () => {
  it("flattens a spreadsheet to text carrying cell references", async () => {
    const { blocks, kind } = await contentFor("merged-week.xlsx", read("merged-week.xlsx"));
    expect(kind).toBe("spreadsheet");
    const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(text).toContain("### Sheet: Block 3");
    expect(text).toContain("A2: Alice Nguyen");
    /* The reference is what a reviewer checks the row against. Without it the
       origin is "somewhere in the spreadsheet", which is not checkable. */
    expect(text).toMatch(/D2[^:]*: MICU 7-7/);
  });

  it("tells the model which cells are merged, rather than leaving it to infer", async () => {
    const { blocks } = await contentFor("merged-week.xlsx", read("merged-week.xlsx"));
    const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(text).toContain("merged, master D2");
  });

  it("sends a PDF as a document, not as text it guessed at", async () => {
    const { blocks, kind } = await contentFor("month-calendar.pdf", read("month-calendar.pdf"));
    expect(kind).toBe("pdf");
    const document = blocks.find((block) => block.type === "document");
    expect(document).toBeDefined();
    expect(document).toMatchObject({ source: { media_type: "application/pdf" } });
  });

  it("sends an image as an image, with the right media type", async () => {
    const { blocks, kind, pageCount } = await contentFor(
      "screenshot.png",
      read("screenshot.png"),
    );
    expect(kind).toBe("image");
    expect(pageCount).toBe(1);
    expect(blocks.find((block) => block.type === "image")).toMatchObject({
      source: { media_type: "image/png" },
    });
  });

  it("counts PDF pages well enough to bound them", () => {
    expect(pdfPageCount(read("month-calendar.pdf"))).toBe(1);
    expect(pdfPageCount(Buffer.from("not a pdf"))).toBeNull();
  });
});

describe("reading the model's answer", () => {
  it("expands a merged week into one row per day", () => {
    const parsed = parseExtraction(MERGED_WEEK.text);
    const alice = parsed.rows.filter((row) => row.residentName === "Alice Nguyen");
    expect(alice).toHaveLength(5);
    expect(alice.map((row) => row.date)).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
  });

  it("keeps the origin of every row", () => {
    const parsed = parseExtraction(MERGED_WEEK.text);
    expect(parsed.rows[0].origin).toMatchObject({ sheet: "Block 3", cell: "D2" });
    const calendar = parseExtraction(MONTH_CALENDAR.text);
    expect(calendar.rows[0].origin).toMatchObject({ page: 1, region: expect.any(String) });
  });

  it("carries the notes about the file as a whole", () => {
    const parsed = parseExtraction(ROTATION_GRID.text);
    expect(parsed.notes.join(" ")).toContain("legend");
  });

  it("survives a model that answered in prose", () => {
    expect(() => parseExtraction(PROSE_NOT_JSON.text)).toThrowError(
      /could not be read[\s\S]*Nothing was imported/,
    );
  });

  it("clamps a confidence outside 0 to 1 instead of trusting it", () => {
    const parsed = parseExtraction(
      JSON.stringify({
        readable: true,
        notes: [],
        rows: [
          { residentName: "A", date: "2026-08-10", confidence: 4, origin: {} },
          { residentName: "B", date: "2026-08-11", confidence: -2, origin: {} },
          { residentName: "C", date: "2026-08-12", confidence: "high", origin: {} },
        ],
      }),
    );
    expect(parsed.rows.map((row) => row.confidence)).toEqual([1, 0, 0]);
  });

  it("drops a row naming nobody and no day rather than showing an empty line", () => {
    const parsed = parseExtraction(
      JSON.stringify({
        readable: true,
        notes: [],
        rows: [
          { residentName: "", residentEmail: "", date: "", confidence: 0.9, origin: {} },
          { residentName: "Alice", date: "2026-08-10", confidence: 0.9, origin: {} },
        ],
      }),
    );
    expect(parsed.rows).toHaveLength(1);
  });

  it("finds the object even when the model wrapped it in a fence", () => {
    const parsed = parseExtraction(
      "```json\n" +
        JSON.stringify({
          readable: true,
          notes: [],
          rows: [{ residentName: "Alice", date: "2026-08-10", confidence: 0.9, origin: {} }],
        }) +
        "\n```",
    );
    expect(parsed.rows).toHaveLength(1);
  });
});

describe("which rows a person has to look at", () => {
  const floor = 0.85;
  const complete = {
    residentName: "Alice Nguyen",
    residentEmail: "",
    date: "2026-08-10",
    startTime: "07:00",
    endTime: "19:00",
    service: "MICU",
    rotation: "",
    shiftType: "",
    location: "",
    status: "",
    origin: {},
    confidence: 0.97,
    uncertainty: "",
  };

  it("passes a complete, confident row", () => {
    expect(needsReview(complete, floor)).toBe(false);
  });

  it("flags anything below the floor", () => {
    expect(needsReview({ ...complete, confidence: 0.84 }, floor)).toBe(true);
  });

  /* The case that matters most, and the one a confidence threshold alone
     misses: the model correctly read a cell that did not contain a date. It is
     right, and the row is still unusable. */
  it("flags a confident row that is missing something a shift needs", () => {
    expect(needsReview({ ...complete, date: "" }, floor)).toBe(true);
    expect(needsReview({ ...complete, startTime: "" }, floor)).toBe(true);
    expect(needsReview({ ...complete, service: "" }, floor)).toBe(true);
    expect(needsReview({ ...complete, residentName: "" }, floor)).toBe(true);
  });

  it("accepts an email where there is no name", () => {
    expect(
      needsReview({ ...complete, residentName: "", residentEmail: "a@x.invalid" }, floor),
    ).toBe(false);
  });

  it("flags every row of a calendar with no year on it", () => {
    const parsed = parseExtraction(MONTH_CALENDAR.text);
    expect(parsed.rows.every((row) => needsReview(row, floor))).toBe(true);
  });

  it("flags the cut-off row of a screenshot and not the legible one", () => {
    const parsed = parseExtraction(SCREENSHOT.text);
    expect(parsed.rows.map((row) => needsReview(row, floor))).toEqual([false, true]);
  });
});

describe("the bounds", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("refuses a file over the size limit before opening it", async () => {
    process.env.ASSISTED_IMPORT_MAX_BYTES = "1000";
    await expect(
      extractSchedule("big.csv", Buffer.alloc(2000, "a"), {
        transport: new ReplayTransport(MERGED_WEEK),
      }),
    ).rejects.toThrowError(/limit is 0 MB|is 0\.0 MB/);
  });

  it("refuses a PDF with more pages than configured", async () => {
    process.env.ASSISTED_IMPORT_MAX_PAGES = "0";
    /* Zero is not a usable limit, so the default stands — the guard against a
       nonsense value is itself worth asserting. */
    expect(assistedImportLimits().maxPages).toBe(20);
  });

  it("refuses before calling when the estimate exceeds the ceiling", async () => {
    process.env.ASSISTED_IMPORT_MAX_COST_MICROS = "1";
    const transport = new ReplayTransport(MERGED_WEEK);
    await expect(
      extractSchedule("block.csv", Buffer.from("Resident,Date\nAlice,2026-08-10\n"), {
        transport,
      }),
    ).rejects.toThrowError(/cost more than this program allows/);
    /* The point of "before": nothing was sent. */
    expect(transport.requests).toHaveLength(0);
  });

  it("prices a run from the tokens the API reported", () => {
    expect(costMicros("claude-sonnet-4-5", 1_000_000, 0)).toBe(3_000_000);
    expect(costMicros("claude-sonnet-4-5", 0, 1_000_000)).toBe(15_000_000);
  });

  it("prices an unknown model at the dearest rate rather than the cheapest", () => {
    expect(costMicros("something-new", 1_000_000, 0)).toBeGreaterThanOrEqual(
      costMicros("claude-opus-4-5", 1_000_000, 0),
    );
  });
});

describe("failing honestly", () => {
  it("reports what it could not read, and imports nothing", async () => {
    await expect(
      extractSchedule("whiteboard.png", read("screenshot.png"), {
        transport: new ReplayTransport(UNREADABLE),
      }),
    ).rejects.toThrowError(UnreadableFileError);

    await expect(
      extractSchedule("whiteboard.png", read("screenshot.png"), {
        transport: new ReplayTransport(UNREADABLE),
      }),
    ).rejects.toThrowError(/not legible/);
  });

  it("lets a transport failure through rather than inventing rows", async () => {
    await expect(
      extractSchedule("block.csv", Buffer.from("a,b\n1,2\n"), {
        transport: new FailingTransport("socket hang up"),
      }),
    ).rejects.toThrowError(/socket hang up/);
  });

  it("records what it cost, from what the call reported", async () => {
    const extraction = await extractSchedule("merged-week.xlsx", read("merged-week.xlsx"), {
      transport: new ReplayTransport(MERGED_WEEK),
    });
    expect(extraction.inputTokens).toBe(MERGED_WEEK.inputTokens);
    expect(extraction.costMicros).toBe(
      costMicros(MERGED_WEEK.model, MERGED_WEEK.inputTokens, MERGED_WEEK.outputTokens),
    );
  });
});

describe("with no API key", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  it("says so plainly instead of failing at the point of use", () => {
    const transport = modelTransport();
    expect(transport.configured).toBe(false);
    expect(transport.unavailableReason).toMatch(/Anthropic API key/);
    /* And it names the path that still works, because the sentence is shown to
       somebody who came here to import a schedule. */
    expect(transport.unavailableReason).toMatch(/CSV and Excel template/);
  });

  it("refuses an upload with that same sentence", async () => {
    await expect(
      extractSchedule("block.csv", Buffer.from("a,b\n1,2\n")),
    ).rejects.toThrowError(/Anthropic API key/);
  });
});
