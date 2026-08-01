import { DateTime } from "luxon";

/**
 * Presentation helpers shared by server and client components. Every function
 * takes the program timezone explicitly — nothing is ever rendered in the
 * device's local timezone.
 */

function toDateTime(value: Date | string, zone: string): DateTime {
  return typeof value === "string"
    ? DateTime.fromISO(value, { zone })
    : DateTime.fromJSDate(value, { zone });
}

export function fmtDate(value: Date | string, zone: string): string {
  return toDateTime(value, zone).toFormat("EEE, LLL d");
}

export function fmtDateLong(value: Date | string, zone: string): string {
  return toDateTime(value, zone).toFormat("EEEE, LLLL d, yyyy");
}

export function fmtTime(value: Date | string, zone: string): string {
  return toDateTime(value, zone).toFormat("h:mm a").replace(":00", "");
}

export function fmtRange(
  start: Date | string,
  end: Date | string,
  zone: string,
): string {
  const from = toDateTime(start, zone);
  const to = toDateTime(end, zone);
  const overnight = from.toISODate() !== to.toISODate();
  return `${fmtTime(start, zone)} – ${fmtTime(end, zone)}${overnight ? " (+1)" : ""}`;
}

export function fmtDuration(start: Date | string, end: Date | string): string {
  const hours =
    (new Date(end as string).getTime() - new Date(start as string).getTime()) /
    3_600_000;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded}h`;
}

export function fmtTimestamp(value: Date | string, zone: string): string {
  return toDateTime(value, zone).toFormat("LLL d, yyyy 'at' h:mm a");
}

export function fmtRelative(value: Date | string, zone = "utc"): string {
  return toDateTime(value, zone).toRelative() ?? "";
}

/** The calendar date in the program's timezone — a stable key for grouping. */
export function isoDate(value: Date | string, zone: string): string {
  return toDateTime(value, zone).toISODate() ?? "";
}

export function dayLabel(value: Date | string, zone: string): string {
  const target = toDateTime(value, zone).startOf("day");
  const today = DateTime.now().setZone(zone).startOf("day");
  const diff = Math.round(target.diff(today, "days").days);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return target.toFormat("EEE, LLL d");
}

export function countdown(value: Date | string, zone: string): string {
  const target = toDateTime(value, zone);
  const now = DateTime.now().setZone(zone);
  const minutes = target.diff(now, "minutes").minutes;
  if (minutes < 0) return "started";
  if (minutes < 60) return `in ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `in ${Math.round(hours)} h`;
  return `in ${Math.round(hours / 24)} d`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function titleCase(value: string): string {
  return value
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
