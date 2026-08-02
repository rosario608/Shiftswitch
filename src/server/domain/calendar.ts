import { DateTime } from "luxon";
import type { ShiftDetail } from "@/server/db/types";

/**
 * iCalendar feed for a resident's schedule (RFC 5545).
 *
 * Emitted with UTC timestamps so the phone's calendar renders each shift at the
 * right wall-clock time wherever the device is, and with a stable UID per shift
 * so a completed switch updates the existing event rather than duplicating it.
 *
 * ## Removal is published, not implied
 *
 * A feed is synchronised rather than read: the client holds a copy and
 * reconciles. Dropping a `VEVENT` is not a reliable instruction to delete it —
 * some clients prune, Google Calendar frequently does not — so a shift that
 * stopped being the resident's is emitted with `STATUS:CANCELLED`, which every
 * client honours. `SEQUENCE` is bumped on those events for the same reason:
 * a client that has already cached the confirmed version needs to be told this
 * one is newer, and clients are entitled to ignore an update that isn't.
 *
 * This is the difference between a resident who knows they gave a shift away
 * and a resident whose phone says they are still on it.
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
  /**
   * Shifts that were the resident's and are not now — given away, switched
   * away, or cancelled by a scheduler. Published as cancelled events so a
   * subscribed calendar removes them. See `listReleasedShifts`.
   */
  released?: ShiftDetail[];
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

  /* Live first, so that if a shift somehow reached both lists the version
     saying the resident works it wins. The two queries are mutually exclusive
     on whether an active assignment exists, so this should never fire — but a
     duplicate UID makes a calendar show the shift twice, which is exactly the
     confusion the feed exists to prevent, and one `Set` is cheaper than
     trusting that invariant forever. */
  const live = new Set(shifts.map((shift) => shift.id));
  const entries: Array<{ shift: ShiftDetail; cancelled: boolean }> = [
    ...shifts.map((shift) => ({ shift, cancelled: shift.status === "cancelled" })),
    ...(options.released ?? [])
      .filter((shift) => !live.has(shift.id))
      .map((shift) => ({ shift, cancelled: true })),
  ];

  for (const { shift, cancelled } of entries) {
    const summary = `${shift.service_name}${
      shift.shift_type ? ` (${shift.shift_type})` : ""
    }`;
    /* A released shift's description is written for the one person who will
       read it: somebody who opened a calendar event that has just been struck
       through and wants to know whether they still work it. It says no, and
       where to check. It deliberately does not name who has it now — the feed
       is one resident's schedule and the token is not an authenticated
       session, so nobody else's name belongs in it. */
    const description = (
      cancelled
        ? [
            "This shift is no longer yours.",
            `Service: ${shift.service_name}`,
            shift.location ? `Location: ${shift.location}` : null,
            `Check ShiftSwitch: ${options.appUrl}/schedule`,
          ]
        : [
            `Service: ${shift.service_name}`,
            shift.rotation_name ? `Rotation: ${shift.rotation_name}` : null,
            shift.location ? `Location: ${shift.location}` : null,
            `Status: ${shift.status.replace(/_/g, " ")}`,
            `Open in ShiftSwitch: ${options.appUrl}/schedule/${shift.id}`,
          ]
    )
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
      cancelled ? "STATUS:CANCELLED" : "STATUS:CONFIRMED",
      /* Non-zero only once the event has something to supersede. A client that
         cached the confirmed version is allowed to ignore an update at the
         same sequence, and the cancellation is the one update that must not be
         ignored. */
      cancelled ? "SEQUENCE:1" : "SEQUENCE:0",
      `LAST-MODIFIED:${utcStamp(shift.updated_at)}`,
      /* Released shifts stop consuming the resident's time: the whole point is
         that they are free then, and a cancelled-but-opaque event still blocks
         them in every "find a time" view. */
      cancelled ? "TRANSP:TRANSPARENT" : "TRANSP:OPAQUE",
    ];
    lines.push(...event.filter((line): line is string => Boolean(line)));

    if (options.reminderMinutes && !cancelled) {
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
