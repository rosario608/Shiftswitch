import { DateTime } from "luxon";
import type { ShiftDetail } from "@/server/db/types";

/**
 * iCalendar feed for a resident's schedule (RFC 5545).
 *
 * Emitted with UTC timestamps so the phone's calendar renders each shift at the
 * right wall-clock time wherever the device is, and with a stable UID per shift
 * so a completed switch updates the existing event rather than duplicating it.
 */

const CRLF = "\r\n";

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds long lines at 75 octets, as the specification requires. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let remaining = line;
  parts.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 74) {
    parts.push(` ${remaining.slice(0, 74)}`);
    remaining = remaining.slice(74);
  }
  if (remaining.length > 0) parts.push(` ${remaining}`);
  return parts.join(CRLF);
}

function utcStamp(value: Date): string {
  return DateTime.fromJSDate(value, { zone: "utc" }).toFormat("yyyyLLdd'T'HHmmss'Z'");
}

export interface CalendarOptions {
  programName: string;
  residentName: string;
  timezone: string;
  appUrl: string;
  /** Minutes before the shift to alarm; omit for no alarm. */
  reminderMinutes?: number;
}

export function buildCalendar(
  shifts: ShiftDetail[],
  options: CalendarOptions,
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ShiftSwitch//Residency Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(`${options.residentName} — ${options.programName}`)}`,
    `X-WR-TIMEZONE:${escapeText(options.timezone)}`,
    // Tell subscribers how often to poll; most clients honour this.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  const now = utcStamp(new Date());

  for (const shift of shifts) {
    const summary = `${shift.service_name}${
      shift.shift_type ? ` (${shift.shift_type})` : ""
    }`;
    const description = [
      `Service: ${shift.service_name}`,
      shift.rotation_name ? `Rotation: ${shift.rotation_name}` : null,
      shift.location ? `Location: ${shift.location}` : null,
      `Status: ${shift.status.replace(/_/g, " ")}`,
      `Open in ShiftSwitch: ${options.appUrl}/schedule/${shift.id}`,
    ]
      .filter(Boolean)
      .join("\n");

    const event: Array<string | null> = [
      "BEGIN:VEVENT",
      `UID:shift-${shift.id}@shiftswitch`,
      `DTSTAMP:${now}`,
      `DTSTART:${utcStamp(shift.start_datetime)}`,
      `DTEND:${utcStamp(shift.end_datetime)}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(description)}`,
      shift.location ? `LOCATION:${escapeText(shift.location)}` : null,
      `URL:${options.appUrl}/schedule/${shift.id}`,
      // A cancelled shift is published as cancelled so subscribers remove it.
      shift.status === "cancelled" ? "STATUS:CANCELLED" : "STATUS:CONFIRMED",
      `LAST-MODIFIED:${utcStamp(shift.updated_at)}`,
      "TRANSP:OPAQUE",
    ];
    lines.push(...event.filter((line): line is string => Boolean(line)));

    if (options.reminderMinutes && shift.status !== "cancelled") {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeText(`${summary} starts soon`)}`,
        `TRIGGER:-PT${options.reminderMinutes}M`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.filter((line): line is string => Boolean(line)).map(fold).join(CRLF) + CRLF;
}
