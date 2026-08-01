import type {
  ModelRequest,
  ModelResponse,
  ModelTransport,
} from "@/server/domain/assisted-import/transport";

/**
 * The model's side of the exchange, held still so the suite is deterministic.
 *
 * ## What these are, exactly
 *
 * They are **authored**, not captured. No Anthropic API key exists in the
 * environment this repository is developed in, so nothing here is the literal
 * bytes of a live call — each one is the response a correct extraction of the
 * corresponding fixture file *would* produce, written by hand against the
 * contract in `prompt.ts`.
 *
 * That distinction matters and is worth stating rather than glossing: these
 * fixtures prove that **our** handling is right — the flagging, the sorting,
 * the review gate, the commit path, the honest failure — and they do not prove
 * that a model reads a merged cell correctly. Nothing offline can prove the
 * second thing. When a key exists, `send` can be swapped for a recorder and
 * these constants replaced with real captures without a line changing anywhere
 * else; that is what the transport seam is for.
 *
 * ## Why the confidences are not all high
 *
 * Because the interesting paths are the low ones. Each fixture below carries at
 * least one row the model was unsure about, for the reason a real extraction
 * would be unsure — a shift code that had to be read as hours, a calendar with
 * no year on the page, a person recorded as initials. Those are the rows the
 * review gate exists for, and a fixture set where everything came back at 0.99
 * would exercise none of it.
 */

export interface FixtureResponse {
  /** The JSON the model returns, as text — parsed by the code under test. */
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Shape 1 — `merged-week.xlsx`. A week per row with the days merged into one
 * cell, which has to become five rows. The Wednesday-to-Friday night block is
 * the same trap in miniature.
 */
export const MERGED_WEEK: FixtureResponse = {
  model: "claude-sonnet-4-5",
  inputTokens: 1_240,
  outputTokens: 890,
  text: JSON.stringify({
    readable: true,
    notes: [
      "D2:H2 is a merged cell spanning Mon-Fri; expanded to one row per weekday.",
      "Times written as '7-7' read as 07:00-19:00 for day shifts and 19:00-07:00 for those marked NF.",
    ],
    rows: [
      row("Alice Nguyen", "2026-08-10", "07:00", "19:00", "MICU", 0.94, "Block 3", "D2"),
      row("Alice Nguyen", "2026-08-11", "07:00", "19:00", "MICU", 0.94, "Block 3", "D2"),
      row("Alice Nguyen", "2026-08-12", "07:00", "19:00", "MICU", 0.94, "Block 3", "D2"),
      row("Alice Nguyen", "2026-08-13", "07:00", "19:00", "MICU", 0.94, "Block 3", "D2"),
      row("Alice Nguyen", "2026-08-14", "07:00", "19:00", "MICU", 0.94, "Block 3", "D2"),
      {
        ...row("Ben Okafor", "2026-08-12", "19:00", "07:00", "NF", 0.52, "Block 3", "F3"),
        shiftType: "night",
        endsNextDay: true,
        uncertainty:
          "'NF 7p-7a' is a shift code rather than stated hours; read as 19:00-07:00 overnight.",
      },
      {
        ...row("Ben Okafor", "2026-08-13", "19:00", "07:00", "NF", 0.52, "Block 3", "F3"),
        shiftType: "night",
        endsNextDay: true,
        uncertainty:
          "'NF 7p-7a' is a shift code rather than stated hours; read as 19:00-07:00 overnight.",
      },
      {
        ...row("Ben Okafor", "2026-08-14", "19:00", "07:00", "NF", 0.52, "Block 3", "F3"),
        shiftType: "night",
        endsNextDay: true,
        uncertainty:
          "'NF 7p-7a' is a shift code rather than stated hours; read as 19:00-07:00 overnight.",
      },
    ],
  }),
};

/**
 * Shape 2 — `month-calendar.pdf`. A month to a page with no year printed
 * anywhere on it, which is why every row comes back below the floor.
 */
export const MONTH_CALENDAR: FixtureResponse = {
  model: "claude-sonnet-4-5",
  inputTokens: 2_100,
  outputTokens: 640,
  text: JSON.stringify({
    readable: true,
    notes: [
      "The page is headed 'August' with no year anywhere on it. Dates left empty rather than guessed.",
    ],
    rows: [
      {
        ...row("A.Nguyen", "", "07:00", "19:00", "MICU", 0.42, null, null),
        origin: { sheet: null, cell: null, page: 1, region: "week 2, Monday cell" },
        uncertainty: "The calendar names no year, so the date cannot be resolved from the file.",
      },
      {
        ...row("A.Nguyen", "", "07:00", "19:00", "MICU", 0.42, null, null),
        origin: { sheet: null, cell: null, page: 1, region: "week 2, Tuesday cell" },
        uncertainty: "The calendar names no year, so the date cannot be resolved from the file.",
      },
      {
        ...row("B.Okafor", "", "19:00", "07:00", "NF", 0.38, null, null),
        origin: { sheet: null, cell: null, page: 1, region: "week 2, Wednesday cell" },
        shiftType: "night",
        endsNextDay: true,
        uncertainty:
          "No year on the page, and 'NF 7p-7a' is a code read as overnight hours.",
      },
    ],
  }),
};

/**
 * Shape 3 — `rotation-grid.xlsx`. Columns are days, rows are people, and the
 * hours only exist in a legend at the bottom of the sheet.
 */
export const ROTATION_GRID: FixtureResponse = {
  model: "claude-sonnet-4-5",
  inputTokens: 980,
  outputTokens: 520,
  text: JSON.stringify({
    readable: true,
    notes: [
      "Row 4 is a legend: D = 07:00-19:00, N = 19:00-07:00. Applied to every D and N cell.",
      "Column headers are days of the month; the month and year are not stated on the sheet.",
    ],
    rows: [
      {
        ...row("Alice Nguyen", "", "07:00", "19:00", "MICU", 0.55, "MICU", "B2"),
        uncertainty: "The sheet gives day numbers only, with no month or year.",
      },
      {
        ...row("Alice Nguyen", "", "19:00", "07:00", "MICU", 0.55, "MICU", "F2"),
        shiftType: "night",
        endsNextDay: true,
        uncertainty: "The sheet gives day numbers only, with no month or year.",
      },
      {
        ...row("Ben Okafor", "", "07:00", "19:00", "MICU", 0.55, "MICU", "D3"),
        uncertainty: "The sheet gives day numbers only, with no month or year.",
      },
    ],
  }),
};

/** Shape 4 — `screenshot.png`. A photograph of a printed schedule. */
export const SCREENSHOT: FixtureResponse = {
  model: "claude-sonnet-4-5",
  inputTokens: 1_600,
  outputTokens: 310,
  text: JSON.stringify({
    readable: true,
    notes: ["Photograph of a printed sheet; the left edge is cut off."],
    rows: [
      {
        ...row("Alice Nguyen", "2026-08-10", "07:00", "19:00", "MICU", 0.88, null, null),
        origin: { sheet: null, cell: null, page: 1, region: "first row of the table" },
      },
      {
        ...row("C. Diaz", "2026-08-11", "", "", "WARDS", 0.35, null, null),
        origin: { sheet: null, cell: null, page: 1, region: "third row, partly cut off" },
        uncertainty: "The hours column is cut off at the edge of the photograph.",
      },
    ],
  }),
};

/** A file the model says it cannot read at all. */
export const UNREADABLE: FixtureResponse = {
  model: "claude-sonnet-4-5",
  inputTokens: 1_500,
  outputTokens: 40,
  text: JSON.stringify({
    readable: false,
    reason:
      "This is a photograph of a whiteboard taken at an angle, and the names in the left column are not legible.",
    rows: [],
    notes: [],
  }),
};

/** Not JSON at all — the failure mode the parser has to survive. */
export const PROSE_NOT_JSON: FixtureResponse = {
  model: "claude-sonnet-4-5",
  inputTokens: 900,
  outputTokens: 30,
  text: "I had a look at this file but I am not sure what you want me to do with it.",
};

function row(
  residentName: string,
  date: string,
  startTime: string,
  endTime: string,
  service: string,
  confidence: number,
  sheet: string | null,
  cell: string | null,
) {
  return {
    residentName,
    residentEmail: "",
    date,
    startTime,
    endTime,
    service,
    rotation: "",
    shiftType: "",
    location: "",
    status: "",
    origin: { sheet, cell, page: null, region: null },
    confidence,
    uncertainty: "",
  };
}

/**
 * A transport that replays one of the above.
 *
 * It also records what it was asked, because several tests are about the
 * *request*: that a spreadsheet arrives as text carrying cell references, that
 * a PDF arrives as a document block, that an image arrives as an image block.
 * Those are our side of the contract and are worth asserting.
 */
export class ReplayTransport implements ModelTransport {
  readonly name = "replay";
  readonly configured = true;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly response: FixtureResponse) {}

  async send(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      text: this.response.text,
      inputTokens: this.response.inputTokens,
      outputTokens: this.response.outputTokens,
      model: this.response.model,
    };
  }
}

/** A transport that fails the way a network does, for the honest-failure path. */
export class FailingTransport implements ModelTransport {
  readonly name = "failing";
  readonly configured = true;

  constructor(private readonly message: string) {}

  async send(): Promise<ModelResponse> {
    throw new Error(this.message);
  }
}
