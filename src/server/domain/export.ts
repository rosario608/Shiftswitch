import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { ShiftDetail } from "@/server/db/types";
import { formatShiftDateLong, formatShiftRange, formatTimestamp } from "./time";

/**
 * Schedule export. The caller is responsible for having applied the viewer's
 * permissions to `shifts` before calling — a resident export only ever contains
 * that resident's own shifts.
 */

export type ExportFormat = "csv" | "xlsx" | "pdf";

const COLUMNS = [
  "Resident",
  "PGY",
  "Date",
  "Start",
  "End",
  "Service",
  "Rotation",
  "Shift type",
  "Location",
  "Status",
] as const;

function rowValues(shift: ShiftDetail, timezone: string): string[] {
  return [
    shift.resident_name ?? "Unassigned",
    shift.resident_pgy ? `PGY-${shift.resident_pgy}` : "",
    formatShiftDateLong(shift.start_datetime, timezone),
    formatShiftRange(shift.start_datetime, shift.end_datetime, timezone).split("–")[0].trim(),
    formatShiftRange(shift.start_datetime, shift.end_datetime, timezone).split("–")[1]?.trim() ?? "",
    shift.service_name,
    shift.rotation_name ?? "",
    shift.shift_type,
    shift.location,
    shift.status,
  ];
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(shifts: ShiftDetail[], timezone: string): string {
  const lines = [COLUMNS.join(",")];
  for (const shift of shifts) {
    lines.push(rowValues(shift, timezone).map(escapeCsv).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export async function toXlsx(
  shifts: ShiftDetail[],
  timezone: string,
  title: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ShiftSwitch";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Schedule");
  sheet.addRow([...COLUMNS]);
  sheet.getRow(1).font = { bold: true };
  for (const shift of shifts) sheet.addRow(rowValues(shift, timezone));
  sheet.columns.forEach((column) => {
    column.width = 18;
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const meta = workbook.addWorksheet("About");
  meta.addRow(["Export", title]);
  meta.addRow(["Generated", formatTimestamp(new Date(), timezone)]);
  meta.addRow(["Timezone", timezone]);
  meta.addRow(["Shifts", shifts.length]);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function toPdf(
  shifts: ShiftDetail[],
  timezone: string,
  title: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 40, layout: "landscape" });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(16).text(title, { align: "left" });
      doc
        .fontSize(9)
        .fillColor("#555555")
        .text(
          `Generated ${formatTimestamp(new Date(), timezone)} · ${shifts.length} shift${
            shifts.length === 1 ? "" : "s"
          } · times shown in ${timezone}`,
        );
      doc.moveDown(0.8);

      const widths = [110, 40, 120, 90, 90, 80, 80, 60];
      const headers = ["Resident", "PGY", "Date", "Time", "Service", "Rotation", "Location", "Status"];
      const drawRow = (values: string[], bold: boolean) => {
        const y = doc.y;
        let x = doc.page.margins.left;
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#111111");
        values.forEach((value, index) => {
          doc.text(value, x, y, { width: widths[index] - 6, ellipsis: true });
          x += widths[index];
        });
        doc.y = y + 16;
      };

      drawRow(headers, true);
      doc
        .moveTo(doc.page.margins.left, doc.y - 4)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y - 4)
        .strokeColor("#cccccc")
        .stroke();

      for (const shift of shifts) {
        if (doc.y > doc.page.height - 60) {
          doc.addPage();
          drawRow(headers, true);
        }
        drawRow(
          [
            shift.resident_name ?? "Unassigned",
            shift.resident_pgy ? String(shift.resident_pgy) : "",
            formatShiftDateLong(shift.start_datetime, timezone),
            formatShiftRange(shift.start_datetime, shift.end_datetime, timezone),
            shift.service_name,
            shift.rotation_name ?? "",
            shift.location,
            shift.status,
          ],
          false,
        );
      }
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};
