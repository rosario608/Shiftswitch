import ExcelJS from "exceljs";
import { validationFailed } from "@/server/http/errors";
import { assistedImportLimits, costMicros } from "./limits";
import { EXTRACTION_SYSTEM_PROMPT, extractionInstruction } from "./prompt";
import {
  modelTransport,
  type ModelContentBlock,
  type ModelTransport,
} from "./transport";

/**
 * Turning an uploaded file into rows a person can review.
 *
 * ## The model never writes
 *
 * This module produces `ProposedRow[]`. Nothing here touches `shifts`,
 * `services`, or any other schedule table — the rows go to `./store.ts` to be
 * written down as a *proposal*, and reach the schedule only through
 * `commitImport`, the same one function a hand-typed CSV goes through. Every
 * existing import property therefore still holds: the same validation, the same
 * resident matching, the same all-or-nothing transaction, the same idempotent
 * re-import.
 *
 * ## What is sent, per shape
 *
 * A spreadsheet is flattened here rather than uploaded whole, because what the
 * model needs is the grid *with its cell references* — a row that says it came
 * from `Block 3!D14` can be checked; a row that says it came from "the
 * spreadsheet" cannot. PDFs and images go up as themselves, since their layout
 * is the information.
 *
 * ## Bounds before the network
 *
 * Size, pages and estimated cost are all checked before a request is made.
 * Refusing after paying for the call would be a strange kind of care.
 */

export interface RowOrigin {
  sheet?: string | null;
  cell?: string | null;
  page?: number | null;
  region?: string | null;
}

/** A row as the model proposed it, in the canonical import columns. */
export interface ProposedRow {
  residentName: string;
  residentEmail: string;
  date: string;
  startTime: string;
  endTime: string;
  /**
   * Whether the shift runs past midnight. Undefined when the extraction did
   * not say, which leaves the importer to infer it from the hours — the same
   * rule every other source gets.
   */
  endsNextDay?: boolean;
  service: string;
  rotation: string;
  shiftType: string;
  location: string;
  status: string;
  origin: RowOrigin;
  confidence: number;
  /** Why the model was unsure, when it was. Shown beside the row. */
  uncertainty: string;
}

export interface Extraction {
  rows: ProposedRow[];
  notes: string[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  pageCount: number | null;
  mediaKind: MediaKind;
}

export type MediaKind = "spreadsheet" | "csv" | "pdf" | "image";

const IMAGE_MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function mediaKindOf(filename: string): MediaKind {
  /* `split(".").pop()` on a name with no dot returns the whole name, which
     produced 'cannot read a "schedule" file' for a file called `schedule` —
     a sentence that sends somebody looking for a file type that does not
     exist. A missing extension is its own case and says so. */
  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";

  if (extension === "xlsx" || extension === "xls" || extension === "xlsm") {
    return "spreadsheet";
  }
  if (extension === "csv" || extension === "tsv" || extension === "txt") return "csv";
  if (extension === "pdf") return "pdf";
  if (extension in IMAGE_MEDIA) return "image";

  throw validationFailed(
    extension
      ? `ShiftSwitch cannot read a "${extension}" file. Upload a spreadsheet (.xlsx), a CSV, a PDF, or a screenshot (.png or .jpg).`
      : `"${filename}" has no file extension, so there is no way to tell what it is. Upload a spreadsheet (.xlsx), a CSV, a PDF, or a screenshot (.png or .jpg).`,
  );
}

/**
 * How many pages a PDF claims, or null when it will not say.
 *
 * A scan of the bytes rather than a parse, deliberately: this number is used
 * only to refuse something far too large before spending money on it, and a
 * whole PDF parsing dependency to compute a bound would cost more than the
 * bound is worth. Null means "unknown", which the byte limit still covers.
 */
export function pdfPageCount(contents: Buffer): number | null {
  const text = contents.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}

/** A spreadsheet as text, with the cell references the reviewer will check. */
async function spreadsheetAsText(contents: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(contents as unknown as ArrayBuffer);

  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    const lines: string[] = [`### Sheet: ${sheet.name}`];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const value = cell.text?.trim();
        if (!value) return;
        const reference = `${columnLetter(columnNumber)}${rowNumber}`;
        /* Merged cells are the single commonest thing a real programme
           schedule does and the single commonest thing an extraction gets
           wrong, so the span is stated rather than left to be inferred from
           repeated values. */
        const merged =
          cell.isMerged && cell.master && cell.master.address !== cell.address
            ? ` (merged, master ${cell.master.address})`
            : "";
        cells.push(`${reference}${merged}: ${value}`);
      });
      if (cells.length > 0) lines.push(cells.join(" | "));
    });
    parts.push(lines.join("\n"));
  });

  if (parts.length === 0) {
    throw validationFailed("That spreadsheet has no readable sheets in it.");
  }
  return parts.join("\n\n");
}

function columnLetter(index: number): string {
  let value = "";
  let remaining = index;
  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    value = String.fromCharCode(65 + modulo) + value;
    remaining = Math.floor((remaining - modulo) / 26);
  }
  return value;
}

/** The content blocks for one file, and how many pages it turned out to be. */
export async function contentFor(
  filename: string,
  contents: Buffer,
  hint?: string,
): Promise<{ blocks: ModelContentBlock[]; kind: MediaKind; pageCount: number | null }> {
  const kind = mediaKindOf(filename);
  const limits = assistedImportLimits();
  const instruction = { type: "text" as const, text: extractionInstruction(filename, hint) };

  if (kind === "spreadsheet") {
    const grid = await spreadsheetAsText(contents);
    return {
      kind,
      pageCount: null,
      blocks: [instruction, { type: "text", text: grid }],
    };
  }

  if (kind === "csv") {
    const text = contents.toString("utf8");
    if (!text.trim()) throw validationFailed("That file is empty.");
    return { kind, pageCount: null, blocks: [instruction, { type: "text", text }] };
  }

  if (kind === "pdf") {
    const pages = pdfPageCount(contents);
    if (pages !== null && pages > limits.maxPages) {
      throw validationFailed(
        `That PDF has ${pages} pages and this program reads up to ${limits.maxPages} at a time. Split it — a block at a time is also far easier to check.`,
      );
    }
    return {
      kind,
      pageCount: pages,
      blocks: [
        instruction,
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: contents.toString("base64"),
          },
        },
      ],
    };
  }

  const extension = filename.split(".").pop()!.toLowerCase();
  return {
    kind,
    pageCount: 1,
    blocks: [
      instruction,
      {
        type: "image",
        source: {
          type: "base64",
          media_type: IMAGE_MEDIA[extension],
          data: contents.toString("base64"),
        },
      },
    ],
  };
}

/** Raised when the model says, in its own words, that it could not read the file. */
export class UnreadableFileError extends Error {}

const MAX_OUTPUT_TOKENS = 16_000;

export async function extractSchedule(
  filename: string,
  contents: Buffer,
  options: { hint?: string; transport?: ModelTransport } = {},
): Promise<Extraction> {
  const limits = assistedImportLimits();
  const transport = options.transport ?? modelTransport();

  if (!transport.configured) {
    throw validationFailed(
      transport.unavailableReason ?? "Assisted import is not configured on this deployment.",
    );
  }
  if (contents.byteLength > limits.maxBytes) {
    throw validationFailed(
      `That file is ${(contents.byteLength / 1024 / 1024).toFixed(1)} MB and the limit is ${(limits.maxBytes / 1024 / 1024).toFixed(0)} MB.`,
    );
  }

  const { blocks, kind, pageCount } = await contentFor(filename, contents, options.hint);

  /* The estimate that has to clear the ceiling before anything is sent. Input
     tokens are approximated from the payload — four bytes to a token for text,
     and the documented ~1 500 per PDF page or image — and the output is
     assumed to be the maximum, because a ceiling that assumes the cheap case
     is not a ceiling. */
  const textBytes = blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .reduce((total, block) => total + block.text.length, 0);
  const mediaTokens = kind === "pdf" || kind === "image" ? (pageCount ?? 1) * 1_500 : 0;
  const estimatedInput = Math.ceil(textBytes / 4) + mediaTokens;
  const estimate = costMicros("", estimatedInput, MAX_OUTPUT_TOKENS);
  if (estimate > limits.maxCostMicros) {
    throw validationFailed(
      "That file is large enough that reading it would cost more than this program allows for one upload. Split it into blocks and upload them one at a time.",
    );
  }

  const response = await transport.send({
    system: EXTRACTION_SYSTEM_PROMPT,
    content: blocks,
    maxTokens: MAX_OUTPUT_TOKENS,
  });

  const parsed = parseExtraction(response.text);
  if (!parsed.readable) {
    throw new UnreadableFileError(
      parsed.reason ||
        "The file could not be read, and no reason was given. Try a clearer export, or use the CSV template.",
    );
  }

  return {
    rows: parsed.rows,
    notes: parsed.notes,
    model: response.model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costMicros: costMicros(response.model, response.inputTokens, response.outputTokens),
    pageCount,
    mediaKind: kind,
  };
}

interface ParsedExtraction {
  readable: boolean;
  reason?: string;
  rows: ProposedRow[];
  notes: string[];
}

/**
 * Reading the model's answer, assuming nothing about it.
 *
 * The contract says "JSON and nothing else", and a model that has just read a
 * hard file is exactly where that instruction is most likely to slip, so the
 * object is located rather than assumed to be the whole string. Everything
 * after that is coerced field by field: a missing key becomes an empty string,
 * a confidence outside 0–1 is clamped, and a row that carries nothing usable is
 * dropped rather than turned into a row of empty strings for somebody to
 * puzzle over.
 */
export function parseExtraction(text: string): ParsedExtraction {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw validationFailed(
      "The file could not be read: the extraction did not come back in a usable form. Nothing was imported. Try again, or use the CSV template.",
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw validationFailed(
      "The file could not be read: the extraction came back malformed. Nothing was imported. Try again, or use the CSV template.",
    );
  }

  if (body.readable === false) {
    return {
      readable: false,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      rows: [],
      notes: [],
    };
  }

  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  const rows = rawRows
    .map((row) => coerceRow(row as Record<string, unknown>))
    .filter((row): row is ProposedRow => row !== null);

  const notes = Array.isArray(body.notes)
    ? body.notes.filter((note): note is string => typeof note === "string").slice(0, 20)
    : [];

  return { readable: true, rows, notes };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function coerceRow(row: Record<string, unknown>): ProposedRow | null {
  const origin = (row.origin ?? {}) as Record<string, unknown>;
  const page = Number(origin.page);
  const confidence = Number(row.confidence);

  const coerced: ProposedRow = {
    residentName: str(row.residentName),
    residentEmail: str(row.residentEmail),
    date: str(row.date),
    startTime: str(row.startTime),
    endTime: str(row.endTime),
    ...(typeof row.endsNextDay === "boolean" ? { endsNextDay: row.endsNextDay } : {}),
    service: str(row.service),
    rotation: str(row.rotation),
    shiftType: str(row.shiftType),
    location: str(row.location),
    status: str(row.status),
    origin: {
      sheet: str(origin.sheet) || null,
      cell: str(origin.cell) || null,
      page: Number.isFinite(page) ? page : null,
      region: str(origin.region) || null,
    },
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    uncertainty: str(row.uncertainty),
  };

  /* A row naming nobody and no day is not a row a reviewer can do anything
     with. Dropping it is better than showing an empty line and asking them to
     work out what it was meant to be — and `notes` is where the model says it
     saw something it could not place. */
  if (!coerced.residentName && !coerced.residentEmail && !coerced.date) return null;
  return coerced;
}
