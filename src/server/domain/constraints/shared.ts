import { formatShiftDate, localDateString } from "@/server/domain/time";
import type {
  ScheduleAssignment,
  ScheduleBlock,
  ScheduleSnapshot,
  Violation,
} from "./types";

/**
 * Wording, and the small amount of arithmetic every constraint needs.
 *
 * ## The voice
 *
 * Three properties are asserted across every message the validator can produce
 * (`tests/unit/constraint-messages.test.ts`), for the same reasons they are
 * asserted across every rule message:
 *
 *   - **a real date, never an ISO string.** "Mon, Aug 10", because that is how
 *     the rest of the product names a day and because "2026-08-10 is short" is
 *     not a sentence anybody says out loud.
 *   - **the numbers in the sentence.** A chief reading "MICU is short" learns
 *     nothing actionable; "MICU has 1 of the 2 people it needs" tells them what
 *     to fix. Structured fields are for screens, and a screen that does not
 *     render them must not be able to swallow the point.
 *   - **no name prefix.** Every surface prints the people involved itself, so a
 *     message opening with a name produces "Jordan Rivera: Jordan Rivera is
 *     not available to schedule."
 *
 * A violation names the people in `residentIds` and the sentence refers to them
 * where it reads naturally mid-sentence — "Jordan Rivera has 6 hours between…"
 * is fine and is not a prefix in the sense above, which is about the
 * "Name: Name …" duplication. The test asserts the message does not *begin*
 * with a resident's name followed by a separator.
 */

/** "Mon, Aug 10" — how the whole product names a day. */
export function day(instant: Date, timezone: string): string {
  return formatShiftDate(instant, timezone);
}

/**
 * "Mon, Aug 10" from an ISO date, without inventing a time of day.
 *
 * Parsed and formatted in UTC deliberately, and it takes no timezone: an ISO
 * date here is a *label* the constraint already resolved in the programme's
 * timezone, not an instant. Running it back through that timezone would shift
 * the label by a day for any programme east of Greenwich.
 */
export function dayFromIso(iso: string): string {
  return formatShiftDate(new Date(`${iso}T12:00:00Z`), "UTC");
}

/** "Mon, Aug 10 MICU" — how a shift is referred to in conversation. */
export function shiftLabel(
  assignment: ScheduleAssignment,
  timezone: string,
): string {
  return `${day(assignment.start, timezone)} ${assignment.serviceName}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function hours(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

/** Weekday of an ISO date label, 0 = Sunday, matching PostgreSQL's DOW. */
export function weekdayOfIso(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** Every ISO date in the window, inclusive of both ends. */
export function datesInPeriod(period: { start: string; end: string }): string[] {
  const dates: string[] = [];
  let cursor = period.start;
  /* Bounded so a malformed period cannot spin: a schedule window longer than
     five years is a mistake, not a request. */
  for (let guard = 0; cursor <= period.end && guard < 1900; guard += 1) {
    dates.push(cursor);
    const next = new Date(`${cursor}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return dates;
}

/** The local date a shift is counted on: the day it starts. */
export function assignmentDate(
  assignment: ScheduleAssignment,
  timezone: string,
): string {
  return localDateString(assignment.start, timezone);
}

/** The block a date falls in, if the programme has a block year at all. */
export function blockContaining(
  blocks: ScheduleBlock[],
  iso: string,
): ScheduleBlock | null {
  return blocks.find((b) => b.startDate <= iso && iso <= b.endDate) ?? null;
}

export function residentName(snapshot: ScheduleSnapshot, id: string): string {
  return snapshot.residents.find((r) => r.id === id)?.name ?? "Somebody";
}

/** Assignments that actually staff something: a person, and not cancelled. */
export function staffedAssignments(
  snapshot: ScheduleSnapshot,
): ScheduleAssignment[] {
  return snapshot.assignments.filter(
    (a) => a.residentId !== null && a.status !== "cancelled",
  );
}

/**
 * A violation with every list defaulted, so a constraint only names what it
 * actually knows about.
 */
export function violation(
  partial: Omit<Violation, "residentIds" | "serviceIds" | "shiftIds" | "dates"> &
    Partial<Pick<Violation, "residentIds" | "serviceIds" | "shiftIds" | "dates">>,
): Violation {
  return {
    residentIds: [],
    serviceIds: [],
    shiftIds: [],
    dates: [],
    ...partial,
  };
}
