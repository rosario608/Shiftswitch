#!/usr/bin/env tsx
/**
 * Builds the four input files the assisted-import tests read.
 *
 *     npx tsx scripts/make-import-fixtures.ts
 *
 * They are generated rather than committed as binaries so that what each one
 * *is* — a merged cell spanning Monday to Friday, a month to a page, a grid
 * whose columns are days — is readable in this file rather than only visible
 * by opening a spreadsheet. A reviewer of the tests can see the shape being
 * tested without downloading anything.
 *
 * Each is a deliberately awkward layout taken from what programmes actually
 * send, not a clean export:
 *
 *   1. `merged-week.xlsx`  — a week per row, the rotation in a third column,
 *                            and the days merged across a single cell.
 *   2. `month-calendar.pdf`— a calendar month to a page, code and hours in one
 *                            cell, no year anywhere on the page.
 *   3. `rotation-grid.xlsx`— one sheet per rotation, rows are people and
 *                            columns are days of the month.
 *   4. `screenshot.png`    — a photograph of a printed schedule, which is what
 *                            a chief actually sends at 11pm.
 *
 * Regenerate after changing any of them and commit the result.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

const OUT = path.join(process.cwd(), "tests", "fixtures", "assisted-import");

/** Shape 1: a week per row, merged day cells, rotation in its own column. */
async function mergedWeek(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Block 3");

  sheet.addRow(["Resident", "Rotation", "Week of", "Mon", "Tue", "Wed", "Thu", "Fri"]);
  sheet.addRow(["Alice Nguyen", "Inpatient", "10 Aug 2026", "MICU 7-7", "", "", "", ""]);
  /* The merge is the point: one cell holding "MICU 7-7" that means five
     shifts. An extraction that returns one row here is the failure this
     fixture exists to catch. */
  sheet.mergeCells("D2:H2");
  sheet.addRow(["Ben Okafor", "Nights", "10 Aug 2026", "", "", "NF 7p-7a", "", ""]);
  sheet.mergeCells("F3:H3");

  await workbook.xlsx.writeFile(path.join(OUT, "merged-week.xlsx"));
}

/** Shape 2: a month to a page, code and hours in one cell, and no year. */
function monthCalendar(): void {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  doc.on("end", () => {
    writeFileSync(path.join(OUT, "month-calendar.pdf"), Buffer.concat(chunks));
  });

  doc.fontSize(16).text("August — Internal Medicine call calendar", { align: "center" });
  doc.moveDown();
  doc.fontSize(9);

  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let y = 110;
  doc.fontSize(10);
  days.forEach((day, index) => doc.text(day, 40 + index * 74, y));

  y += 18;
  const cells = [
    ["10 A.Nguyen MICU 7-7", "11 A.Nguyen MICU 7-7", "12 B.Okafor NF 7p-7a"],
    ["13 B.Okafor NF 7p-7a", "14 C.Diaz WARDS 7-5", "15 —"],
  ];
  doc.fontSize(8);
  cells.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      doc.text(cell, 40 + columnIndex * 74, y + rowIndex * 46, { width: 70 });
    });
  });

  doc.end();
}

/** Shape 3: rows are people, columns are days of the month. */
async function rotationGrid(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("MICU");

  sheet.addRow(["", ...Array.from({ length: 7 }, (_, index) => String(10 + index))]);
  sheet.addRow(["Alice Nguyen", "D", "D", "", "", "N", "N", ""]);
  sheet.addRow(["Ben Okafor", "", "", "D", "D", "", "", "N"]);
  sheet.addRow(["Legend", "D = 07:00-19:00", "N = 19:00-07:00"]);

  await workbook.xlsx.writeFile(path.join(OUT, "rotation-grid.xlsx"));
}

/**
 * Shape 4: an image.
 *
 * A minimal valid PNG written by hand rather than a real photograph, because
 * what the test exercises is *our* handling — the media type, the base64
 * framing, the page bound, the recorded response — and a committed photograph
 * of a schedule would be a committed schedule. The bytes below are a 2×2
 * greyscale image and a correct PNG in every respect a decoder cares about.
 */
function screenshot(): void {
  const width = 2;
  const height = 2;
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width + 1)] = 0; // filter: none
    raw[row * (width + 1) + 1] = 0x20;
    raw[row * (width + 1) + 2] = 0xe0;
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: greyscale

  writeFileSync(
    path.join(OUT, "screenshot.png"),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await mergedWeek();
  monthCalendar();
  await rotationGrid();
  screenshot();
  console.log(`[fixtures] wrote four assisted-import inputs to ${OUT}`);
}

main().catch((error) => {
  console.error("[fixtures] failed:", error);
  process.exit(1);
});
