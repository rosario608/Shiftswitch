import ExcelJS from "exceljs";
import type { ShiftDetail } from "@/server/db/types";
import { formatShiftDateLong, formatShiftRange, formatTimestamp } from "./time";

/**
 * Schedule export. The caller is responsible for having applied the viewer's
 * permissions to `shifts` before calling — a resident export only ever contains
 * that resident's own shifts.
 *
 * ## Why there is no PDF here any more
 *
 * There was a `toPdf` built on `pdfkit`, and it worked. It was removed because
 * of where this runs: Cloudflare's free plan refuses to upload a Worker script
 * over 3 MiB gzipped, this bundle was 185 KiB over, and `pdfkit` was 256 KiB of
 * it. Carrying it meant the app could not be deployed at all. The trade was
 * made deliberately — see the Decisions entry in `docs/AI_PROJECT_STATE.md`,
 * which also records the $5/month that would buy it back.
 *
 * Nothing a resident needs was lost. A phone reads the schedule best through
 * the calendar subscription, which puts the shifts in the calendar app they
 * already open; XLSX is what a chief opens to work on. A PDF was the worst of
 * both: not live, and not editable.
 *
 * If it comes back, it must not come back as `pdfkit` in this bundle.
 * `scripts/check-worker-size.ts` is the check that would catch it.
 */

export type ExportFormat = "csv" | "xlsx";

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

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
