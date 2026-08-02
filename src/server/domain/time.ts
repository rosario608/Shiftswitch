import { DateTime, Interval } from "luxon";

/**
 * Time handling rules for ShiftSwitch
 * ------------------------------------
 * 1. Every instant is stored in Postgres as `timestamptz` (an absolute point in
 *    time). No wall-clock strings are stored for shift boundaries.
 * 2. Every rendering and every "which calendar day is this?" question is
 *    answered in the owning program's IANA timezone.
 * 3. Durations, rest windows and overlaps are computed on absolute instants,
 *    which makes them correct across DST transitions by construction.
 */

export const MS_PER_HOUR = 3_600_000;

export class InvalidZonedTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidZonedTimeError";
  }
}

export function isValidTimeZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/**
 * Converts a wall-clock date + time in a program's timezone into an absolute
 * instant. Used by CSV import and any admin-entered schedule data.
 *
 * DST edge cases:
 *  - Spring-forward gap (e.g. 2025-03-09 02:30 America/New_York does not exist)
 *    throws, because silently shifting a shift by an hour is worse than failing.
 *  - Fall-back overlap (e.g. 2025-11-02 01:30 occurs twice) resolves to the
 *    first (pre-transition, DST) occurrence, which is what schedulers mean.
 */
export function zonedWallTimeToInstant(
  date: string,
  time: string,
  zone: string,
): Date {
  if (!isValidTimeZone(zone)) {
    throw new InvalidZonedTimeError(`Unknown timezone: ${zone}`);
  }
  const normalisedTime = time.length === 5 ? `${time}:00` : time;
  const dt = DateTime.fromISO(`${date}T${normalisedTime}`, { zone });
  if (!dt.isValid) {
    throw new InvalidZonedTimeError(
      `${date} ${time} is not a valid time in ${zone} (${dt.invalidReason ?? "invalid"})`,
    );
  }
  // Luxon silently shifts a wall time that falls inside a spring-forward gap.
  // Round-tripping the value detects that case so the caller has to fix the
  // input rather than silently moving a shift by an hour.
  if (dt.toFormat("yyyy-MM-dd'T'HH:mm") !== `${date}T${normalisedTime.slice(0, 5)}`) {
    throw new InvalidZonedTimeError(
      `${date} ${normalisedTime.slice(0, 5)} does not exist in ${zone} — the clocks change that night.`,
    );
  }
  return dt.toJSDate();
}

/** The calendar date (YYYY-MM-DD) on which an instant falls in `zone`. */
export function localDateString(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate() as string;
}

/** Number of whole+fractional hours a shift covers, DST-aware by construction. */
export function durationHours(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / MS_PER_HOUR;
}

/**
 * Rest between the end of one shift and the start of the next.
 * Negative when the shifts overlap.
 */
export function restHoursBetween(previousEnd: Date, nextStart: Date): number {
  return (nextStart.getTime() - previousEnd.getTime()) / MS_PER_HOUR;
}

export function overlaps(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * True when the shift's local start date differs from its local end date, i.e.
 * the shift crosses midnight in the program timezone. A 19:00 -> 07:00 shift is
 * one shift, never two.
 */
export function isOvernight(start: Date, end: Date, zone: string): boolean {
  return localDateString(start, zone) !== localDateString(end, zone);
}

/** Every local calendar date the shift touches, inclusive of both ends. */
export function coveredLocalDates(
  start: Date,
  end: Date,
  zone: string,
): string[] {
  const first = DateTime.fromJSDate(start, { zone }).startOf("day");
  // An end exactly at midnight belongs to the previous day.
  const rawEnd = DateTime.fromJSDate(end, { zone });
  const last = (
    rawEnd.equals(rawEnd.startOf("day")) ? rawEnd.minus({ minutes: 1 }) : rawEnd
  ).startOf("day");
  const dates: string[] = [];
  let cursor = first;
  while (cursor <= last) {
    dates.push(cursor.toISODate() as string);
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

export function isWeekendLocal(instant: Date, zone: string): boolean {
  const weekday = DateTime.fromJSDate(instant, { zone }).weekday; // 1=Mon..7=Sun
  return weekday === 6 || weekday === 7;
}

/**
 * A shift counts as a "night" shift when it either crosses local midnight or
 * starts at/after 19:00 local time.
 */
export function isNightShift(start: Date, end: Date, zone: string): boolean {
  if (isOvernight(start, end, zone)) return true;
  return DateTime.fromJSDate(start, { zone }).hour >= 19;
}

/** Calendar-day difference between two local dates (b - a), in days. */
export function localDayDiff(a: string, b: string): number {
  const from = DateTime.fromISO(a, { zone: "utc" });
  const to = DateTime.fromISO(b, { zone: "utc" });
  return Math.round(to.diff(from, "days").days);
}

export function addLocalDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "utc" })
    .plus({ days })
    .toISODate() as string;
}

/**
 * Longest run of consecutive local calendar days present in `dates`.
 * Used for max-consecutive-shifts style rules.
 */
export function longestConsecutiveRun(dates: string[]): number {
  const unique = Array.from(new Set(dates)).sort();
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const date of unique) {
    run = previous !== null && localDayDiff(previous, date) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    previous = date;
  }
  return best;
}

/** Maximum number of intervals overlapping any window of `windowDays`. */
export function maxCountInRollingWindow(
  instants: Date[],
  windowDays: number,
): number {
  if (instants.length === 0) return 0;
  const sorted = [...instants].map((d) => d.getTime()).sort((a, b) => a - b);
  const windowMs = windowDays * 24 * MS_PER_HOUR;
  let best = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right += 1) {
    while (sorted[right] - sorted[left] >= windowMs) left += 1;
    best = Math.max(best, right - left + 1);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Formatting helpers (server + client safe: they only need Intl data)
// ---------------------------------------------------------------------------

export function formatShiftDate(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat("EEE, LLL d");
}

export function formatShiftDateLong(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat("EEEE, LLLL d, yyyy");
}

export function formatShiftTime(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone })
    .toFormat("h:mm a")
    .replace(":00", "");
}

/** e.g. "7 PM – 7 AM (+1)" for an overnight shift. */
export function formatShiftRange(
  start: Date,
  end: Date,
  zone: string,
): string {
  const startText = formatShiftTime(start, zone);
  const endText = formatShiftTime(end, zone);
  return isOvernight(start, end, zone)
    ? `${startText} – ${endText} (+1)`
    : `${startText} – ${endText}`;
}

export function formatTimestamp(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat(
    "LLL d, yyyy 'at' h:mm a ZZZZ",
  );
}

export function formatRelative(instant: Date, now: Date = new Date()): string {
  const dt = DateTime.fromJSDate(instant);
  return dt.toRelative({ base: DateTime.fromJSDate(now) }) ?? "";
}

export function toInterval(start: Date, end: Date): Interval {
  return Interval.fromDateTimes(
    DateTime.fromJSDate(start),
    DateTime.fromJSDate(end),
  );
}

/**
 * The wall-clock hour and minute at an instant, in a given zone.
 *
 * Quiet hours are the caller: "is it 03:00 where this resident is" cannot be
 * answered from a formatted string without parsing it back, and cannot be
 * answered from the UTC instant at all.
 */
export function instantToZonedParts(
  instant: Date,
  zone: string,
): { hour: number; minute: number } {
  const local = DateTime.fromJSDate(instant, { zone });
  return { hour: local.hour, minute: local.minute };
}
