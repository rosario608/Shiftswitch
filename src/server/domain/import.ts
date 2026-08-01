import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { query, withTransaction, type Queryable } from "@/server/db/pool";
import type { AuthedContext } from "@/server/auth/guards";
import { can } from "@/server/auth/roles";
import { validationFailed } from "@/server/http/errors";
import { recordAudit } from "./audit";
import { holdRow, matchKey } from "./held-rows";
import {
  placeShift,
  resolveRotationId,
  resolveServiceId,
  type ShiftProvenance,
} from "./shift-write";
import { InvalidZonedTimeError, zonedWallTimeToInstant } from "./time";

/**
 * Schedule import.
 *
 * The file is parsed and validated in full before anything is written. If a
 * single row is *malformed*, the whole import is refused and the production
 * schedule is untouched. A successful import runs inside one transaction.
 *
 * ## The interchange format
 *
 *   Resident, PGY, Date, Start, End, Service, Rotation, Shift type, Location, Status
 *
 * Every column a programme's published schedule actually carries, and nothing
 * it does not. `parseScheduleFile` still accepts the aliases other systems
 * export (`Resident Email`, `Start time`, `Overnight`, `Type`), because a
 * coordinator should not have to rename columns before their own file will
 * load.
 *
 * ## A row naming somebody who has not joined is not an error
 *
 * It used to be: the import refused the file and told the administrator to
 * invite everybody first. That is the wrong order for a programme that has the
 * block file today and whose residents arrive over the next fortnight. Those
 * rows are now *held* — see `./held-rows.ts` — listed as unmatched, and turned
 * into shifts the moment that person enrolls.
 *
 * Malformed rows still stop everything. "This date is not a date" and "this
 * person has not signed in yet" are different kinds of fact, and only the first
 * means the file is wrong.
 *
 * ## A position's hours are a hint, never an inheritance
 *
 * A row whose Start or End is blank is filled in from the position's suggested
 * default, and only when somebody has *confirmed* that default. An assumed one
 * generates nothing: the row is reported, with the hours the product would have
 * guessed, so the administrator can confirm the position or correct the file.
 * The shift that results still stores its own start and end — the default is
 * copied at import, never referenced afterwards, because one emergency-medicine
 * code in a single real week runs 10a–6p, 3p–11p, 7p–7a and 7a–7p.
 */

export interface ImportRow {
  /** Either an email or a name identifies the person. Files carry one or both. */
  residentEmail?: string;
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
  /** The tenth column: what the programme says about this row's standing. */
  status?: string;
  /** Which position within the service, when the file distinguishes them. */
  position?: string;
}

export interface ImportIssue {
  row: number;
  column: string;
  message: string;
}

/** Somebody the file names who has not joined the program. */
export interface UnmatchedPreview {
  name: string;
  email: string;
  rows: number;
}

export interface ImportPreview {
  rows: ImportRow[];
  issues: ImportIssue[];
  summary: {
    totalRows: number;
    validRows: number;
    /** People the file names who have not joined. Their rows are held, not lost. */
    unmatched: UnmatchedPreview[];
    heldRows: number;
    /** Rows whose hours came from a confirmed position rather than from the file. */
    hoursFilledIn: number;
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
  status: "status",
  "shift status": "status",
  position: "position",
  role: "position",
};

/**
 * What a Status cell means, and what it may do.
 *
 * `confirmed` is the only value that claims the programme has vouched for a
 * row, so it is the only one gated: a file cannot confer an authority its
 * uploader does not hold. Anything unrecognised imports as an ordinary imported
 * shift rather than failing the file — a coordinator's own vocabulary in a
 * column the product invented is not a defect in their schedule.
 */
const STATUS_WORDS: Record<string, "confirmed" | "provisional" | "cancelled"> = {
  confirmed: "confirmed",
  final: "confirmed",
  published: "confirmed",
  approved: "confirmed",
  draft: "provisional",
  tentative: "provisional",
  provisional: "provisional",
  proposed: "provisional",
  planned: "provisional",
  cancelled: "cancelled",
  canceled: "cancelled",
  removed: "cancelled",
  deleted: "cancelled",
};

function readStatus(value: string | undefined): "confirmed" | "provisional" | "cancelled" | null {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return null;
  return STATUS_WORDS[text] ?? null;
}

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

/**
 * Everybody in the program, indexed both ways a file can name them.
 *
 * Loaded once rather than queried per row: a block file is four weeks of a
 * whole class, and the same twenty names repeat three hundred times.
 */
export interface ResidentIndex {
  byEmail: Map<string, { id: string; name: string }>;
  byName: Map<string, { id: string; name: string }>;
}

export async function loadResidentIndex(
  programId: string,
  executor?: Queryable,
): Promise<ResidentIndex> {
  const people = await query<{ id: string; email: string; full_name: string }>(
    `SELECT r.id, lower(u.email) AS email, u.full_name
       FROM residents r JOIN users u ON u.id = r.user_id
      WHERE r.program_id = $1 AND r.active`,
    [programId],
    executor,
  );
  const byEmail = new Map<string, { id: string; name: string }>();
  const byName = new Map<string, { id: string; name: string }>();
  const ambiguous = new Set<string>();
  for (const person of people) {
    byEmail.set(person.email, { id: person.id, name: person.full_name });
    const key = matchKey(person.full_name);
    if (!key) continue;
    /* Two residents whose names normalise to the same key are not matchable by
       name at all. Holding both their rows and showing the administrator the
       name the file used is right; picking one of them is not. */
    if (byName.has(key)) ambiguous.add(key);
    byName.set(key, { id: person.id, name: person.full_name });
  }
  for (const key of ambiguous) byName.delete(key);
  return { byEmail, byName };
}

/** The resident a row names, or null when nobody in the program matches. */
export function matchResident(
  index: ResidentIndex,
  row: { residentEmail?: string; residentName?: string },
): { id: string; name: string } | null {
  const email = (row.residentEmail ?? "").trim().toLowerCase();
  if (email) {
    const byEmail = index.byEmail.get(email);
    if (byEmail) return byEmail;
    /* An address the program does not have is not a name to fall back on: the
       file is asserting a specific person, and guessing past that is how one
       resident's call lands on another. */
    return null;
  }
  const key = matchKey(row.residentName ?? "");
  return key ? (index.byName.get(key) ?? null) : null;
}

interface PositionDefault {
  id: string;
  name: string;
  serviceName: string;
  defaultStart: string | null;
  defaultMinutes: number | null;
  defaultShiftType: string;
  provenance: "stated" | "assumed" | "confirmed";
}

/**
 * The suggested hours a position carries, indexed by every name a file might
 * use for it: the position's own name, its short name, and the service's name
 * when that service has exactly one position (which is the common case, and the
 * reason a file can get away with a Service column alone).
 */
async function loadPositionDefaults(
  programId: string,
  executor?: Queryable,
): Promise<Map<string, PositionDefault>> {
  const positions = await query<{
    id: string;
    name: string;
    short_name: string;
    service_name: string;
    default_start: string | null;
    default_minutes: number | null;
    default_shift_type: string;
    provenance: "stated" | "assumed" | "confirmed";
  }>(
    `SELECT p.id, p.name, p.short_name, s.name AS service_name,
            to_char(p.default_start, 'HH24:MI') AS default_start,
            p.default_minutes, p.default_shift_type, p.provenance
       FROM positions p JOIN services s ON s.id = p.service_id
      WHERE p.program_id = $1 AND p.active`,
    [programId],
    executor,
  );

  const index = new Map<string, PositionDefault>();
  const perService = new Map<string, number>();
  for (const position of positions) {
    const key = position.service_name.toLowerCase();
    perService.set(key, (perService.get(key) ?? 0) + 1);
  }
  for (const position of positions) {
    const entry: PositionDefault = {
      id: position.id,
      name: position.name,
      serviceName: position.service_name,
      defaultStart: position.default_start,
      defaultMinutes: position.default_minutes,
      defaultShiftType: position.default_shift_type,
      provenance: position.provenance,
    };
    index.set(position.name.toLowerCase(), entry);
    if (position.short_name) index.set(position.short_name.toLowerCase(), entry);
    if (perService.get(position.service_name.toLowerCase()) === 1) {
      index.set(position.service_name.toLowerCase(), entry);
    }
  }
  return index;
}

/** `HH:MM` plus a number of minutes, wrapped into the following day if it runs over. */
function addMinutes(time: string, minutes: number): { time: string; nextDay: boolean } {
  const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return {
    time: `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`,
    nextDay: total >= 1440,
  };
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
  const residentIndex = await loadResidentIndex(context.program.id);
  const positions = await loadPositionDefaults(context.program.id);

  const unmatched = new Map<string, UnmatchedPreview>();
  const newServices = new Set<string>();
  const newRotations = new Set<string>();
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let hoursFilledIn = 0;

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
    const residentName = (mapped.residentName ?? "").trim();
    if (!email && !residentName) {
      issues.push({
        row: rowNumber,
        column: "Resident",
        message: "Every row needs the resident's name, their email address, or both.",
      });
    } else if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      issues.push({
        row: rowNumber,
        column: "Resident",
        message: `"${email}" is not a valid email address.`,
      });
    }

    const status = readStatus(mapped.status);
    if (mapped.status && !status) {
      /* Not an error. The programme's own word for a row's standing is not a
         defect in their schedule, and the row still describes a real shift. */
      issues.push({
        row: rowNumber,
        column: "Status",
        message: `"${mapped.status}" is not a status this recognises, so this row will be imported as an ordinary shift. Recognised: confirmed, draft, cancelled.`,
      });
    }

    const date = normaliseDate(mapped.date ?? "");
    if (!date) {
      issues.push({
        row: rowNumber,
        column: "Date",
        message: `"${mapped.date ?? ""}" is not a valid date (use YYYY-MM-DD).`,
      });
    }

    /* Blank hours are filled from the position's suggested default — but only a
       confirmed one. An assumed default has not been checked by anybody, and
       generating three hundred shifts from a guess is exactly what item 8 of
       this work forbids. */
    const positionKey = (mapped.position || mapped.service || "").toLowerCase();
    const suggestion = positions.get(positionKey);
    if (!mapped.startTime && suggestion?.defaultStart) {
      if (suggestion.provenance === "assumed") {
        issues.push({
          row: rowNumber,
          column: "Start",
          message: `This row has no hours, and the suggested hours for ${suggestion.name} (${suggestion.defaultStart}) have not been confirmed by anybody. Confirm them under Services, or put the times in the file.`,
        });
      } else {
        mapped.startTime = suggestion.defaultStart;
        hoursFilledIn += 1;
        if (!mapped.endTime && suggestion.defaultMinutes) {
          const finish = addMinutes(suggestion.defaultStart, suggestion.defaultMinutes);
          mapped.endTime = finish.time;
          mapped.endsNextDay = mapped.endsNextDay ?? finish.nextDay;
        }
        if (!mapped.shiftType) mapped.shiftType = suggestion.defaultShiftType;
      }
    }

    const startTime = normaliseTime(mapped.startTime ?? "");
    if (!startTime) {
      issues.push({
        row: rowNumber,
        column: "Start",
        message: mapped.startTime
          ? `"${mapped.startTime}" is not a valid time (use HH:MM).`
          : "This row has no start time, and no confirmed position supplies one.",
      });
    }
    const endTime = normaliseTime(mapped.endTime ?? "");
    if (!endTime) {
      issues.push({
        row: rowNumber,
        column: "End",
        message: mapped.endTime
          ? `"${mapped.endTime}" is not a valid time (use HH:MM).`
          : "This row has no end time, and no confirmed position supplies one.",
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

      /* Who this row is for. Nobody is not an error — it is a held row, and
         `unmatched` is what the administrator is shown so they can see whose
         schedule is waiting rather than wondering what the import dropped. */
      if (email || residentName) {
        const person = matchResident(residentIndex, {
          residentEmail: email,
          residentName,
        });
        if (!person) {
          const key = email || matchKey(residentName);
          const already = unmatched.get(key);
          if (already) {
            already.rows += 1;
            if (!already.email && email) already.email = email;
          } else {
            unmatched.set(key, {
              name: residentName || email,
              email,
              rows: 1,
            });
          }
        }
      }

      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;

      rows.push({
        residentEmail: email || undefined,
        residentName: residentName || undefined,
        pgy: mapped.pgy,
        date,
        startTime,
        endTime,
        endsNextDay,
        service: mapped.service ?? "",
        rotation: mapped.rotation,
        shiftType: mapped.shiftType || (endsNextDay ? "night" : "day"),
        location: mapped.location ?? "",
        status: mapped.status,
        position: mapped.position,
      });
    }
  });

  // Duplicate detection inside the file itself.
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const who = row.residentEmail || matchKey(row.residentName ?? "");
    const key = `${who}|${row.date}|${row.startTime}|${row.service}`;
    if (seen.has(key)) {
      issues.push({
        row: index + 2,
        column: "Date",
        message: "Duplicate row: this resident already has this shift in the file.",
      });
    }
    seen.add(key);
  });

  const heldRows = [...unmatched.values()].reduce((total, person) => total + person.rows, 0);

  return {
    rows,
    issues,
    summary: {
      totalRows: records.length,
      validRows: issues.length === 0 ? rows.length : 0,
      unmatched: [...unmatched.values()].sort((a, b) => a.name.localeCompare(b.name)),
      heldRows,
      hoursFilledIn,
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
  /** Rows for people who have not joined. Waiting, not lost. */
  heldRows: number;
  heldPeople: number;
  /** Rows the file marked cancelled, which create nothing. */
  cancelledRows: number;
  /** The batch every row of this import shares, for tracing one file's effect. */
  importBatch: string;
}

export async function commitImport(
  context: AuthedContext,
  rows: ImportRow[],
): Promise<ImportResult> {
  const preview = await validateImport(
    context,
    rows.map((row) => ({
      Resident: row.residentName ?? "",
      Email: row.residentEmail ?? "",
      Date: row.date,
      "Start time": row.startTime,
      "End time": row.endTime,
      /* Three states, not two. `undefined` means the caller did not say, and
         must stay unsaid so `validateImport` can infer it from the hours —
         19:00 to 07:00 is a night shift. Writing "no" here asserted that it is
         not, which turned every overnight row into a shift ending twelve hours
         before it started. It went unseen because the only caller was the API,
         which passes rows a preview had already filled in. */
      "Ends next day":
        row.endsNextDay === undefined ? "" : row.endsNextDay ? "yes" : "no",
      Service: row.service,
      Rotation: row.rotation ?? "",
      "Shift type": row.shiftType ?? "",
      Location: row.location ?? "",
      PGY: row.pgy ? String(row.pgy) : "",
      Status: row.status ?? "",
      Position: row.position ?? "",
    })),
  );
  /* Only the *blocking* issues stop the import. An unrecognised Status word is
     reported so the administrator can see it, and the row still imports as an
     ordinary shift, because their vocabulary in a column we invented is not a
     defect in their schedule. */
  const blocking = preview.issues.filter((issue) => issue.column !== "Status");
  if (blocking.length > 0) {
    throw validationFailed(
      `${blocking.length} error${blocking.length === 1 ? "" : "s"} found. No changes have been made.`,
      { issues: preview.issues },
    );
  }

  /* Whether this file may say a shift is confirmed. A Status of "confirmed"
     from somebody who cannot confirm a shift imports as an ordinary imported
     one — the file does not confer an authority its uploader lacks. */
  const mayConfirm = can(context.user.role, "shifts.confirm");
  const importBatch = randomUUID();

  return withTransaction(async (client) => {
    let createdServices = 0;
    let createdRotations = 0;
    let createdShifts = 0;
    let skippedExisting = 0;
    let heldRows = 0;
    let cancelledRows = 0;

    const serviceCache = new Map<string, string>();
    const rotationCache = new Map<string, string>();
    const index = await loadResidentIndex(context.program.id, client);
    const heldPeople = new Set<string>();

    for (const row of preview.rows) {
      const status = readStatus(row.status);
      if (status === "cancelled") {
        /* The file says this shift is not happening. Inventing it and then
           relying on somebody to delete it is worse than not inventing it. */
        cancelledRows += 1;
        continue;
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

      const person = matchResident(index, row);
      if (!person) {
        /* Nobody in this program answers to that name or address yet. The row
           waits for them rather than failing the file — and it waits with the
           hours already resolved into instants, so enrolling in November cannot
           reinterpret an August shift through a different clock change. */
        const name = row.residentName || row.residentEmail || "";
        await holdRow(
          {
            programId: context.program.id,
            residentName: name,
            email: row.residentEmail,
            pgy: row.pgy ?? null,
            date: row.date,
            start,
            end,
            serviceName: row.service,
            rotationName: row.rotation ?? "",
            shiftType: row.shiftType ?? "day",
            location: row.location ?? "",
            statusHint: status ?? "",
            importBatch,
          },
          client,
        );
        heldRows += 1;
        heldPeople.add(matchKey(name) || (row.residentEmail ?? "").toLowerCase());
        continue;
      }

      const service = await resolveServiceId(
        context.program.id,
        row.service,
        client,
        serviceCache,
      );
      if (service.created) createdServices += 1;

      let rotationId: string | null = null;
      if (row.rotation) {
        const rotation = await resolveRotationId(
          context.program.id,
          row.rotation,
          client,
          rotationCache,
        );
        if (rotation.created) createdRotations += 1;
        rotationId = rotation.id;
      }

      const provenance: ShiftProvenance =
        status === "provisional"
          ? "provisional"
          : status === "confirmed" && mayConfirm
            ? "confirmed"
            : "imported";

      const outcome = await placeShift(
        {
          programId: context.program.id,
          serviceId: service.id,
          rotationId,
          residentId: person.id,
          date: row.date,
          start,
          end,
          location: row.location ?? "",
          shiftType: row.shiftType ?? "day",
          provenance,
          confirmedBy: provenance === "confirmed" ? context.user.id : null,
        },
        client,
      );
      if (outcome.outcome === "duplicate") skippedExisting += 1;
      else createdShifts += 1;
    }

    await recordAudit(
      {
        programId: context.program.id,
        actorUserId: context.user.id,
        actorLabel: context.user.email,
        action: "schedule.imported",
        entityType: "schedule",
        entityId: importBatch,
        newState: {
          createdShifts,
          createdServices,
          createdRotations,
          skippedExisting,
          heldRows,
          heldPeople: heldPeople.size,
          cancelledRows,
          dateRange: preview.summary.dateRange,
        },
      },
      client,
    );

    return {
      createdShifts,
      createdServices,
      createdRotations,
      skippedExisting,
      heldRows,
      heldPeople: heldPeople.size,
      cancelledRows,
      importBatch,
    };
  });
}
