import type { ScheduleAbsence, ScheduleResident } from "./types";

/**
 * The shape of `residents.constraints` and `residents.preferences`.
 *
 * Both are jsonb, deliberately: they hold facts about one person that no two
 * programmes would enumerate the same way, and a column per fact would mean a
 * migration every time somebody's circumstances changed. What they are *not* is
 * arbitrary — a value nothing reads is a value that silently does nothing, so
 * the keys the validator honours are named here and nowhere else.
 *
 * `constraints` are HARD. Migration `0008` describes them as "facts about one
 * person" — no VA rotations because there is no parking pass, no Fridays for
 * religious observance, leave already agreed. A schedule that ignores one is
 * wrong, not merely disappointing.
 *
 * `preferences` are SOFT. They are scored and never enforced, which is the
 * whole reason they are a separate column: a resident's wish must not be able
 * to make a schedule invalid, and a resident's accommodation must not be
 * silently traded away as a preference.
 *
 * Every accessor tolerates rubbish. These columns can be written by an import
 * or by a future screen, and a constraint that throws on an unexpected value
 * would take the entire validation down with it — reporting nothing at all
 * about a schedule, which is far worse than ignoring one malformed key.
 */

export interface HardPersonConstraints {
  /** 0–6, Sunday first — "cannot work Fridays". */
  unavailableWeekdays: number[];
  /** ISO dates. Leave, absence, a conference already agreed. */
  unavailableDates: string[];
  /** Services this person may not be assigned to. */
  excludedServiceIds: string[];
  /** Sites this person may not work. Site eligibility is the general case. */
  excludedSiteIds: string[];
}

export interface SoftPersonPreferences {
  preferredServiceIds: string[];
  avoidServiceIds: string[];
  /** ISO dates the resident asked to have off, without it being leave. */
  requestedDaysOff: string[];
  /** "prefers nights" / "prefers days". Anything else is ignored. */
  preferredShiftType: "day" | "night" | null;
}

/**
 * The dates an absence covers, inclusive of both ends.
 *
 * Pure string arithmetic on ISO dates rather than anything involving a Date,
 * because these are **labels in the programme's calendar**, not instants. Going
 * through UTC to add a day is how "the 1st to the 31st" becomes "the 31st of
 * August to the 30th of September" for a programme west of Greenwich.
 *
 * Bounded at a year: a range longer than that is somebody having typed 2026
 * where they meant 2016, and expanding it produces nothing useful at
 * considerable cost.
 */
const MAX_ABSENCE_DAYS = 400;

export function expandAbsence(absence: ScheduleAbsence): string[] {
  const dates: string[] = [];
  let cursor = absence.startDate;
  while (cursor <= absence.endDate && dates.length < MAX_ABSENCE_DAYS) {
    dates.push(cursor);
    cursor = nextIsoDate(cursor);
  }
  return dates;
}

function nextIsoDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * The absence covering a date, if there is one — so a message can say *why*
 * somebody is unavailable rather than merely that they are.
 *
 * "Priya Raman is on vacation on Mon, Aug 10 and is scheduled for MICU" is a
 * sentence a chief can act on. "…is recorded as unavailable" makes them go and
 * look it up.
 */
export function absenceOn(
  resident: ScheduleResident,
  iso: string,
  kind: "hard" | "soft",
): ScheduleAbsence | null {
  for (const absence of resident.absences ?? []) {
    if (absence.hard !== (kind === "hard")) continue;
    if (absence.startDate <= iso && iso <= absence.endDate) return absence;
  }
  return null;
}

function stringList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function weekdayList(source: Record<string, unknown>, key: string): number[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is number => Number.isInteger(entry) && entry >= 0 && entry <= 6,
  );
}

/**
 * Merged, and the merge is the point.
 *
 * `resident_absences` is the structured way to record that somebody is away —
 * a range, with a kind, entered once. The jsonb keys are the unstructured way,
 * and an import or an older programme may still be the only thing writing them.
 * Both mean the same thing to a schedule, so both arrive as one list and every
 * constraint, every generator check and every test that already read
 * `unavailableDates` picked up structured availability without changing a line.
 *
 * That is deliberate: a second constraint for absences would mean a schedule
 * putting somebody on a service during their leave was wrong in a *different*
 * way depending on which screen recorded it, and a chief would have to learn
 * two names for one problem.
 */
export function hardConstraintsOf(resident: ScheduleResident): HardPersonConstraints {
  const source = resident.constraints ?? {};
  const fromAbsences = (resident.absences ?? [])
    .filter((absence) => absence.hard)
    .flatMap(expandAbsence);
  return {
    unavailableWeekdays: weekdayList(source, "unavailableWeekdays"),
    unavailableDates: [
      ...new Set([...stringList(source, "unavailableDates"), ...fromAbsences]),
    ],
    excludedServiceIds: stringList(source, "excludedServiceIds"),
    excludedSiteIds: stringList(source, "excludedSiteIds"),
  };
}

export function preferencesOf(resident: ScheduleResident): SoftPersonPreferences {
  const source = resident.preferences ?? {};
  const shiftType = source.preferredShiftType;
  const fromAbsences = (resident.absences ?? [])
    .filter((absence) => !absence.hard)
    .flatMap(expandAbsence);
  return {
    preferredServiceIds: stringList(source, "preferredServiceIds"),
    avoidServiceIds: stringList(source, "avoidServiceIds"),
    requestedDaysOff: [
      ...new Set([...stringList(source, "requestedDaysOff"), ...fromAbsences]),
    ],
    preferredShiftType:
      shiftType === "day" || shiftType === "night" ? shiftType : null,
  };
}
