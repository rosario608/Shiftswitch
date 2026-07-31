import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { query, queryOne, withTransaction } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { InvalidZonedTimeError, zonedWallTimeToInstant } from "./time";

/**
 * Schedule import.
 *
 * The file is parsed and validated in full before anything is written. If a
 * single row fails, the whole import is refused and the production schedule is
 * untouched. A successful import runs inside one transaction.
 */

export interface ImportRow {
  residentEmail: string;
  residentName?: string;
  pgy?: number;
  date: string;
  startTime: string;
  endTime: string;
  endsNextDay?: boolean;
  service: string;
  rotation?: string;
  shiftType?: string;
  location?: string;
}

export interface ImportIssue {
  row: number;
  column: string;
  message: string;
}

export interface ImportPreview {
  rows: ImportRow[];
  issues: ImportIssue[];
  summary: {
    totalRows: number;
    validRows: number;
    newResidents: string[];
    newServices: string[];
    newRotations: string[];
    dateRange: { from: string; to: string } | null;
  };
}

const HEADER_ALIASES: Record<string, keyof ImportRow> = {
  resident: "residentName",
  "resident name": "residentName",
  name: "residentName",
  email: "residentEmail",
  "resident email": "residentEmail",
  pgy: "pgy",
  "pgy level": "pgy",
  date: "date",
  "start time": "startTime",
  start: "startTime",
  "end time": "endTime",
  end: "endTime",
  "ends next day": "endsNextDay",
  overnight: "endsNextDay",
  service: "service",
  rotation: "rotation",
  "shift type": "shiftType",
  type: "shiftType",
  location: "location",
};

function normaliseHeader(header: string): keyof ImportRow | null {
  return HEADER_ALIASES[header.trim().toLowerCase()] ?? null;
}

function normaliseTime(value: string): string | null {
  const trimmed = value.trim();
  const match24 = /^(\d{1,2}):(\d{2})(:\d{2})?$/.exec(trimmed);
  if (match24) {
    const hour = Number(match24[1]);
    const minute = Number(match24[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, "0")}:${match24[2]}`;
  }
  const match12 = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(trimmed);
  if (match12) {
    let hour = Number(match12[1]) % 12;
    if (match12[3].toLowerCase() === "p") hour += 12;
    return `${String(hour).padStart(2, "0")}:${match12[2] ?? "00"}`;
  }
  return null;
}

function normaliseDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash) {
    const [, month, day, year] = slash;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return null;
}

function truthy(value: unknown): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "yes" || text === "y" || text === "1";
}

/** Parses a CSV or XLSX buffer into raw records keyed by our canonical fields. */
export async function parseScheduleFile(
  filename: string,
  buffer: Buffer,
): Promise<Array<Record<string, string>>> {
  if (/\.xlsx?$/i.test(filename)) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw validationFailed("The workbook has no sheets.");
    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((cell, index) => {
      headers[index] = String(cell.value ?? "").trim();
    });
    const records: Array<Record<string, string>> = [];
    sheet.eachRow((row, rowIndex) => {
      if (rowIndex === 1) return;
      const record: Record<string, string> = {};
      row.eachCell((cell, index) => {
        const header = headers[index];
        if (!header) return;
        const value = cell.value;
        if (value instanceof Date) {
          record[header] = value.toISOString().slice(0, 10);
        } else if (value && typeof value === "object" && "text" in value) {
          record[header] = String((value as { text: string }).text);
        } else {
          record[header] = String(value ?? "");
        }
      });
      if (Object.values(record).some((v) => v.trim() !== "")) records.push(record);
    });
    return records;
  }

  const text = buffer.toString("utf8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>;
}

export async function validateImport(
  context: AuthedContext,
  records: Array<Record<string, string>>,
): Promise<ImportPreview> {
  const issues: ImportIssue[] = [];
  const rows: ImportRow[] = [];

  if (records.length === 0) {
    issues.push({ row: 0, column: "file", message: "The file has no data rows." });
  }

  const services = new Map(
    (
      await query<{ id: string; name: string }>(
        "SELECT id, name FROM services WHERE program_id = $1",
        [context.program.id],
      )
    ).map((row) => [row.name.toLowerCase(), row.id]),
  );
  const rotations = new Map(
    (
      await query<{ id: string; name: string }>(
        "SELECT id, name FROM rotations WHERE program_id = $1",
        [context.program.id],
      )
    ).map((row) => [row.name.toLowerCase(), row.id]),
  );
  const residents = new Map(
    (
      await query<{ id: string; email: string }>(
        `SELECT r.id, lower(u.email) AS email
           FROM residents r JOIN users u ON u.id = r.user_id
          WHERE r.program_id = $1`,
        [context.program.id],
      )
    ).map((row) => [row.email, row.id]),
  );

  const newResidents = new Set<string>();
  const newServices = new Set<string>();
  const newRotations = new Set<string>();
  let minDate: string | null = null;
  let maxDate: string | null = null;

  records.forEach((record, index) => {
    const rowNumber = index + 2; // 1-based, accounting for the header row
    const mapped: Partial<ImportRow> = {};
    for (const [rawKey, rawValue] of Object.entries(record)) {
      const key = normaliseHeader(rawKey);
      if (!key) continue;
      if (key === "pgy") {
        const numeric = Number(String(rawValue).trim());
        if (String(rawValue).trim() !== "" && Number.isFinite(numeric)) {
          mapped.pgy = numeric;
        }
      } else if (key === "endsNextDay") {
        mapped.endsNextDay = truthy(rawValue);
      } else {
        (mapped as Record<string, unknown>)[key] = String(rawValue ?? "").trim();
      }
    }

    const email = (mapped.residentEmail ?? "").toLowerCase();
    if (!email) {
      issues.push({ row: rowNumber, column: "Email", message: "Resident email is required." });
    } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      issues.push({ row: rowNumber, column: "Email", message: `"${email}" is not a valid email address.` });
    } else if (!residents.has(email)) {
      newResidents.add(email);
    }

    const date = normaliseDate(mapped.date ?? "");
    if (!date) {
      issues.push({
        row: rowNumber,
        column: "Date",
        message: `"${mapped.date ?? ""}" is not a valid date (use YYYY-MM-DD).`,
      });
    }

    const startTime = normaliseTime(mapped.startTime ?? "");
    if (!startTime) {
      issues.push({
        row: rowNumber,
        column: "Start time",
        message: `"${mapped.startTime ?? ""}" is not a valid time (use HH:MM).`,
      });
    }
    const endTime = normaliseTime(mapped.endTime ?? "");
    if (!endTime) {
      issues.push({
        row: rowNumber,
        column: "End time",
        message: `"${mapped.endTime ?? ""}" is not a valid time (use HH:MM).`,
      });
    }

    if (!mapped.service) {
      issues.push({ row: rowNumber, column: "Service", message: "Service is required." });
    } else if (!services.has(mapped.service.toLowerCase())) {
      newServices.add(mapped.service);
    }
    if (mapped.rotation && !rotations.has(mapped.rotation.toLowerCase())) {
      newRotations.add(mapped.rotation);
    }

    if (date && startTime && endTime) {
      const endsNextDay =
        mapped.endsNextDay ?? endTime <= startTime; // 19:00 -> 07:00 is overnight
      try {
        const start = zonedWallTimeToInstant(date, startTime, context.program.timezone);
        const endDate = endsNextDay
          ? new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000)
              .toISOString()
              .slice(0, 10)
          : date;
        const end = zonedWallTimeToInstant(endDate, endTime, context.program.timezone);
        if (end <= start) {
          issues.push({
            row: rowNumber,
            column: "End time",
            message: "The shift ends before it starts. Mark it as ending the next day.",
          });
        }
      } catch (error) {
        issues.push({
          row: rowNumber,
          column: "Start time",
          message:
            error instanceof InvalidZonedTimeError
              ? error.message
              : "This time could not be interpreted in the program timezone.",
        });
      }

      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;

      rows.push({
        residentEmail: email,
        residentName: mapped.residentName,
        pgy: mapped.pgy,
        date,
        startTime,
        endTime,
        endsNextDay,
        service: mapped.service ?? "",
        rotation: mapped.rotation,
        shiftType: mapped.shiftType || (endsNextDay ? "night" : "day"),
        location: mapped.location ?? "",
      });
    }
  });

  // Duplicate detection inside the file itself.
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const key = `${row.residentEmail}|${row.date}|${row.startTime}|${row.service}`;
    if (seen.has(key)) {
      issues.push({
        row: index + 2,
        column: "Date",
        message: "Duplicate row: this resident already has this shift in the file.",
      });
    }
    seen.add(key);
  });

  return {
    rows,
    issues,
    summary: {
      totalRows: records.length,
      validRows: issues.length === 0 ? rows.length : 0,
      newResidents: [...newResidents],
      newServices: [...newServices],
      newRotations: [...newRotations],
      dateRange: minDate && maxDate ? { from: minDate, to: maxDate } : null,
    },
  };
}

export interface ImportResult {
  createdShifts: number;
  createdServices: number;
  createdRotations: number;
  skippedExisting: number;
}

export async function commitImport(
  context: AuthedContext,
  rows: ImportRow[],
): Promise<ImportResult> {
  const preview = await validateImport(
    context,
    rows.map((row) => ({
      Email: row.residentEmail,
      Date: row.date,
      "Start time": row.startTime,
      "End time": row.endTime,
      "Ends next day": row.endsNextDay ? "yes" : "no",
      Service: row.service,
      Rotation: row.rotation ?? "",
      "Shift type": row.shiftType ?? "",
      Location: row.location ?? "",
      PGY: row.pgy ? String(row.pgy) : "",
    })),
  );
  if (preview.issues.length > 0) {
    throw validationFailed(
      `${preview.issues.length} error${preview.issues.length === 1 ? "" : "s"} found. No changes have been made.`,
      { issues: preview.issues },
    );
  }
  if (preview.summary.newResidents.length > 0) {
    throw validationFailed(
      `These residents are not in your program yet: ${preview.summary.newResidents.join(", ")}. Invite them under Users first, then import again. No changes have been made.`,
      { unknownResidents: preview.summary.newResidents },
    );
  }

  return withTransaction(async (client) => {
    let createdServices = 0;
    let createdRotations = 0;
    let createdShifts = 0;
    let skippedExisting = 0;

    const serviceCache = new Map<string, string>();
    const rotationCache = new Map<string, string>();
    const residentCache = new Map<string, string>();

    for (const row of preview.rows) {
      const serviceKey = row.service.toLowerCase();
      let serviceId = serviceCache.get(serviceKey);
      if (!serviceId) {
        const existing = await queryOne<{ id: string }>(
          "SELECT id FROM services WHERE program_id = $1 AND lower(name) = $2",
          [context.program.id, serviceKey],
          client,
        );
        if (existing) {
          serviceId = existing.id;
        } else {
          const created = await queryOne<{ id: string }>(
            "INSERT INTO services (program_id, name) VALUES ($1, $2) RETURNING id",
            [context.program.id, row.service],
            client,
          );
          serviceId = created!.id;
          createdServices += 1;
        }
        serviceCache.set(serviceKey, serviceId);
      }

      let rotationId: string | null = null;
      if (row.rotation) {
        const rotationKey = row.rotation.toLowerCase();
        rotationId = rotationCache.get(rotationKey) ?? null;
        if (!rotationId) {
          const existing = await queryOne<{ id: string }>(
            "SELECT id FROM rotations WHERE program_id = $1 AND lower(name) = $2",
            [context.program.id, rotationKey],
            client,
          );
          if (existing) {
            rotationId = existing.id;
          } else {
            const created = await queryOne<{ id: string }>(
              "INSERT INTO rotations (program_id, name) VALUES ($1, $2) RETURNING id",
              [context.program.id, row.rotation],
              client,
            );
            rotationId = created!.id;
            createdRotations += 1;
          }
          rotationCache.set(rotationKey, rotationId);
        }
      }

      let residentId = residentCache.get(row.residentEmail);
      if (!residentId) {
        const resident = await queryOne<{ id: string }>(
          `SELECT r.id FROM residents r
             JOIN users u ON u.id = r.user_id
            WHERE r.program_id = $1 AND lower(u.email) = $2`,
          [context.program.id, row.residentEmail],
          client,
        );
        if (!resident) {
          throw validationFailed(
            `${row.residentEmail} is not a resident in this program. No changes have been made.`,
          );
        }
        residentId = resident.id;
        residentCache.set(row.residentEmail, residentId);
      }

      const start = zonedWallTimeToInstant(
        row.date,
        row.startTime,
        context.program.timezone,
      );
      const endDate = row.endsNextDay
        ? new Date(new Date(`${row.date}T00:00:00Z`).getTime() + 86_400_000)
            .toISOString()
            .slice(0, 10)
        : row.date;
      const end = zonedWallTimeToInstant(endDate, row.endTime, context.program.timezone);

      const duplicate = await queryOne<{ id: string }>(
        `SELECT s.id FROM shifts s
           JOIN shift_assignments sa ON sa.shift_id = s.id AND sa.assignment_status = 'active'
          WHERE s.program_id = $1 AND s.service_id = $2 AND s.start_datetime = $3
            AND sa.resident_id = $4`,
        [context.program.id, serviceId, start, residentId],
        client,
      );
      if (duplicate) {
        skippedExisting += 1;
        continue;
      }

      const shift = await queryOne<{ id: string }>(
        `INSERT INTO shifts
           (program_id, service_id, rotation_id, date, start_datetime, end_datetime,
            location, shift_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          context.program.id,
          serviceId,
          rotationId,
          row.date,
          start,
          end,
          row.location ?? "",
          row.shiftType ?? "day",
        ],
        client,
      );
      await query(
        "INSERT INTO shift_assignments (shift_id, resident_id) VALUES ($1, $2)",
        [shift!.id, residentId],
        client,
      );
      createdShifts += 1;
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "schedule.imported",
        entityType: "schedule",
        newState: {
          createdShifts,
          createdServices,
          createdRotations,
          skippedExisting,
          dateRange: preview.summary.dateRange,
        },
      },
      client,
    );

    return { createdShifts, createdServices, createdRotations, skippedExisting };
  });
}
